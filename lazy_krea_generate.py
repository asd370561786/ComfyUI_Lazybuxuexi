"""
Lazy Krea2 生成：按工作台模式自动 文生 / 单图 / 双图 / 局部。
不修改原有 Krea2 节点，运行时调用已注册类。
"""
from __future__ import annotations

import logging
import random

import torch
import comfy.sample
import comfy.samplers
import comfy.utils
import latent_preview
import node_helpers

from .lazy_h3_common import resolve_h3_node, call_node_function
from .lazy_krea_lora_stack import apply_lora_stack

log = logging.getLogger(__name__)


def _as_list(out):
    if out is None:
        return []
    if isinstance(out, (tuple, list)):
        return list(out)
    for attr in ("args", "result", "outputs"):
        if hasattr(out, attr):
            try:
                return list(getattr(out, attr))
            except Exception:
                pass
    return [out]


def _zero_out(cond):
    node = resolve_h3_node("ConditioningZeroOut")
    if node is None:
        c = []
        for t in cond:
            d = t[1].copy()
            c.append([torch.zeros_like(t[0]), d])
        return c
    out = call_node_function(node, conditioning=cond)
    args = _as_list(out)
    return args[0] if args else cond


def _clip_encode_text(clip, text: str):
    tokens = clip.tokenize(text or "")
    return clip.encode_from_tokens_scheduled(tokens)


def _vae_latent_dim(vae) -> int:
    """qwen_image_vae 在 Comfy 内复用 WanVAE 类，latent_dim=3（含时间维）。"""
    try:
        return int(getattr(vae, "latent_dim", 2) or 2)
    except Exception:
        return 2


def _prep_mask(mask: torch.Tensor, h: int, w: int) -> torch.Tensor:
    """MASK → [1,H,W] float 0/1。"""
    m = mask
    if m.ndim == 2:
        m = m.unsqueeze(0)
    if m.ndim == 4:
        m = m[:, 0]
    if m.shape[-2:] != (h, w):
        m = torch.nn.functional.interpolate(
            m.unsqueeze(1).float(), size=(h, w), mode="bilinear"
        ).squeeze(1)
    return (m[:1] > 0.5).float()


def _composite_by_mask(generated: torch.Tensor, original: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    """局部编辑：遮罩内用生成结果，遮罩外保留原图。"""
    gen = generated if generated.ndim == 4 else generated.unsqueeze(0)
    ori = original if original.ndim == 4 else original.unsqueeze(0)
    if ori.shape[0] != gen.shape[0]:
        ori = ori[:1].expand(gen.shape[0], -1, -1, -1)
    if ori.shape[1:3] != gen.shape[1:3]:
        t = ori.movedim(-1, 1)
        t = comfy.utils.common_upscale(t, gen.shape[2], gen.shape[1], "bilinear", "disabled")
        ori = t.movedim(1, -1)
    m = _prep_mask(mask, int(gen.shape[1]), int(gen.shape[2])).unsqueeze(-1)
    m4 = m.movedim(-1, 1)
    m4 = torch.nn.functional.avg_pool2d(m4, kernel_size=7, stride=1, padding=3)
    m = m4.movedim(1, -1).clamp(0, 1)
    return gen * m + ori * (1.0 - m)


def _scale_image(image, megapixels: float = 1.0):
    node = resolve_h3_node("ImageScaleToTotalPixels")
    if node is not None:
        try:
            out = call_node_function(
                node,
                image=image,
                upscale_method="lanczos",
                megapixels=float(megapixels),
                resolution_steps=8,
            )
            args = _as_list(out)
            if args:
                return args[0]
        except Exception as e:
            log.warning("[LazyKrea] ImageScaleToTotalPixels 失败: %s", e)
    b, h, w, c = image.shape
    target = max(1.0, float(megapixels)) * 1_000_000
    cur = float(h * w)
    if cur <= 0:
        return image
    s = (target / cur) ** 0.5
    nh, nw = max(64, int(round(h * s / 8) * 8)), max(64, int(round(w * s / 8) * 8))
    t = image.movedim(-1, 1)
    t = comfy.utils.common_upscale(t, nw, nh, "lanczos", "disabled")
    return t.movedim(1, -1)


def _pad_outpaint_blue(image: torch.Tensor, tw: int, th: int) -> torch.Tensor:
    """
    扩图：原图等比塞进目标画布居中，四周填纯蓝（供 Edit 识别并填补）。
    image [B,H,W,C] → [1,th,tw,3]
    """
    img = image
    if img.ndim == 3:
        img = img.unsqueeze(0)
    img = img[:1, ..., :3].float().clamp(0, 1)
    _, ih, iw, _ = img.shape
    tw = max(64, int(tw) // 16 * 16)
    th = max(64, int(th) // 16 * 16)
    scale = min(float(tw) / float(iw), float(th) / float(ih))
    nw = max(1, int(round(iw * scale)))
    nh = max(1, int(round(ih * scale)))
    t = comfy.utils.common_upscale(img.movedim(-1, 1), nw, nh, "lanczos", "disabled")
    scaled = t.movedim(1, -1)
    # 纯蓝垫底（对齐整合流涂蓝）
    canvas = torch.zeros(1, th, tw, 3, dtype=scaled.dtype, device=scaled.device)
    canvas[..., 2] = 1.0
    y0 = max(0, (th - nh) // 2)
    x0 = max(0, (tw - nw) // 2)
    y1 = min(th, y0 + int(scaled.shape[1]))
    x1 = min(tw, x0 + int(scaled.shape[2]))
    canvas[:, y0:y1, x0:x1, :] = scaled[:, : y1 - y0, : x1 - x0, :]
    log.info(
        "[LazyKrea] 扩图 pad %dx%d → 画布 %dx%d（蓝边）",
        iw, ih, tw, th,
    )
    return canvas.contiguous()


def _empty_krea_latent(w, h, batch=1):
    """
    Krea2 文生/编辑统一用 16 通道空 latent（与 EmptySD3LatentImage 一致）。
    勿用 EmptyLatentImage（4 通道），否则会 mat1/mat2 维度爆炸。
    """
    w = max(64, int(w) // 16 * 16)
    h = max(64, int(h) // 16 * 16)
    batch = max(1, int(batch))
    # 优先官方 EmptySD3LatentImage（与原生工作流一致）
    node = resolve_h3_node("EmptySD3LatentImage")
    if node is not None:
        try:
            out = call_node_function(
                node, width=w, height=h, batch_size=batch
            )
            args = _as_list(out)
            if args and isinstance(args[0], dict) and "samples" in args[0]:
                lat = args[0]
                s = lat["samples"]
                log.info(
                    "[LazyKrea] empty latent %s (EmptySD3 %dx%d batch=%d)",
                    tuple(s.shape), w, h, batch,
                )
                return lat
        except Exception as e:
            log.warning("[LazyKrea] EmptySD3LatentImage 失败，回退手造: %s", e)
    try:
        import comfy.model_management as mm
        device = mm.intermediate_device()
        dtype = mm.intermediate_dtype()
    except Exception:
        device = torch.device("cpu")
        dtype = torch.float32
    lat = {
        "samples": torch.zeros(
            [batch, 16, h // 8, w // 8], device=device, dtype=dtype
        ),
        "downscale_ratio_spacial": 8,
    }
    log.info(
        "[LazyKrea] empty latent %s (手造 %dx%d batch=%d)",
        tuple(lat["samples"].shape), w, h, batch,
    )
    return lat


def _clip_encode_via_node(clip, text: str):
    """优先官方 CLIPTextEncode，与原生文生一致。"""
    node = resolve_h3_node("CLIPTextEncode")
    if node is not None:
        try:
            out = call_node_function(node, clip=clip, text=text or "")
            args = _as_list(out)
            if args:
                return args[0]
        except Exception as e:
            log.warning("[LazyKrea] CLIPTextEncode 失败，回退: %s", e)
    return _clip_encode_text(clip, text)


def _empty_sd3_latent(w, h, batch=1):
    return _empty_krea_latent(w, h, batch)


def _normalize_latent(latent, tag: str, keep_temporal: bool = True):
    """
    规范化 latent。
    qwen_image_vae 内部是 WanVAE 架构（latent_dim=3），采样/解码需要 [B,C,T,H,W] 且 T=1。
    若强行压成 4D 再解码，会把 H 误当成 T，解出几十帧竖条。
    """
    if not isinstance(latent, dict) or "samples" not in latent:
        raise RuntimeError(f"{tag}：latent 无效")
    s = latent["samples"]
    if not isinstance(s, torch.Tensor):
        raise RuntimeError(f"{tag}：samples 类型异常 {type(s)}")
    if s.ndim == 5:
        if s.shape[2] > 1:
            log.warning("[LazyKrea] %s latent T=%d → 只取 T=0", tag, s.shape[2])
            s = s[:, :, :1]
        if not keep_temporal:
            s = s[:, :, 0]
    elif s.ndim == 4:
        if keep_temporal:
            # 升成 T=1，匹配 qwen/Wan 式 VAE
            s = s.unsqueeze(2)
    else:
        raise RuntimeError(f"{tag}：期望 4D/5D latent，得到 {tuple(s.shape)}")
    if s.shape[0] != 1:
        log.warning("[LazyKrea] %s latent batch=%d → 强制 1", tag, s.shape[0])
        s = s[:1].contiguous()
    ch = s.shape[1]
    if ch not in (16, 4):
        log.warning("[LazyKrea] %s latent 通道=%d（Krea2 通常为 16）", tag, ch)
    out = dict(latent)
    out["samples"] = s
    log.info("[LazyKrea] %s latent=%s", tag, tuple(s.shape))
    return out


def _vae_encode(vae, image):
    if image is None:
        raise ValueError("VAE 编码：图像为空")
    img = image
    if img.ndim == 3:
        img = img.unsqueeze(0)
    img = img[:, :, :, :3]
    if img.shape[0] != 1:
        img = img[:1]
    keep_t = _vae_latent_dim(vae) >= 3
    node = resolve_h3_node("VAEEncode")
    if node is not None:
        try:
            out = call_node_function(node, pixels=img, vae=vae)
            args = _as_list(out)
            if args and isinstance(args[0], dict) and "samples" in args[0]:
                return _normalize_latent(args[0], "VAE编码", keep_temporal=keep_t)
        except Exception as e:
            log.warning("[LazyKrea] VAEEncode 节点失败，回退 vae.encode: %s", e)
    enc = vae.encode(img)
    if isinstance(enc, dict):
        return _normalize_latent(enc, "VAE编码", keep_temporal=keep_t)
    return _normalize_latent({"samples": enc}, "VAE编码", keep_temporal=keep_t)


def _vae_decode(vae, latent):
    keep_t = _vae_latent_dim(vae) >= 3
    latent = _normalize_latent(latent, "VAE解码前", keep_temporal=keep_t)
    samples = latent["samples"]
    # 4D 空 latent + latent_dim=3：必须带 T=1 再解，否则会把高度当成帧数
    if keep_t and samples.ndim == 4:
        samples = samples.unsqueeze(2)
        latent = dict(latent)
        latent["samples"] = samples
    node = resolve_h3_node("VAEDecode")
    frame = None
    if node is not None:
        try:
            out = call_node_function(node, samples=latent, vae=vae)
            args = _as_list(out)
            if args:
                frame = args[0]
        except Exception as e:
            log.warning("[LazyKrea] VAEDecode 节点失败，回退 vae.decode: %s", e)
    if frame is None:
        frame = vae.decode(samples)

    if not isinstance(frame, torch.Tensor):
        raise RuntimeError(f"解码结果异常: {type(frame)}")

    # 统一成 [B,H,W,C]
    if frame.ndim == 5:
        # [B,C,T,H,W] 或 [B,T,H,W,C]
        if frame.shape[1] in (1, 3, 4) and frame.shape[-1] not in (1, 3, 4):
            if frame.shape[2] > 1:
                log.warning("[LazyKrea] 解码 T=%d，只取第 1 帧", frame.shape[2])
            frame = frame[:, :, 0].movedim(1, -1)
        else:
            if frame.shape[1] > 1:
                log.warning("[LazyKrea] 解码帧维=%d，只取第 1 帧", frame.shape[1])
            frame = frame[:, 0]
    if frame.ndim == 4 and frame.shape[1] in (1, 3, 4) and frame.shape[-1] not in (1, 3, 4):
        frame = frame.movedim(1, -1)
    if frame.ndim == 3:
        frame = frame.unsqueeze(0)
    if frame.shape[-1] > 3:
        frame = frame[..., :3]
    if frame.shape[0] > 1:
        log.warning("[LazyKrea] 解码 batch=%d，只保留第 1 张", frame.shape[0])
        frame = frame[:1]
    return frame


def _run_ksampler(model, positive, negative, latent, seed, steps, cfg, sampler, scheduler, denoise=1.0):
    # 采样阶段允许 5D(T=1)；不要压掉时间维
    latent = _normalize_latent(dict(latent), "采样前", keep_temporal=True)
    samples0 = latent["samples"]
    try:
        # fix_empty 需要 4D 入参时先挤掉 T=1
        flat = samples0[:, :, 0] if samples0.ndim == 5 else samples0
        fixed = comfy.sample.fix_empty_latent_channels(
            model,
            flat,
            latent.get("downscale_ratio_spacial"),
            latent.get("downscale_ratio_temporal"),
        )
        if isinstance(fixed, torch.Tensor):
            if fixed.ndim == 5 and fixed.shape[2] > 1:
                raise RuntimeError(
                    f"空 latent 被扩成时间维 T={fixed.shape[2]}，请检查模型配置。"
                )
            samples0 = fixed
            latent["samples"] = samples0
    except RuntimeError:
        raise
    except Exception as e:
        log.warning("[LazyKrea] fix_empty_latent_channels 跳过: %s", e)

    # 保证最终给采样器的是一致形状
    if samples0.ndim == 4:
        # 若模型要 5D，fix_empty 通常已升维；未升则保持 4D 也可
        pass
    log.info("[LazyKrea] sample latent shape=%s", tuple(samples0.shape))
    noise = comfy.sample.prepare_noise(samples0, seed, None)
    callback = latent_preview.prepare_callback(model, steps)
    samples = comfy.sample.sample(
        model,
        noise,
        steps,
        cfg,
        sampler,
        scheduler,
        positive,
        negative,
        latent["samples"],
        denoise=denoise,
        disable_noise=False,
        start_step=None,
        last_step=None,
        force_full_denoise=True,
        noise_mask=latent.get("noise_mask"),
        callback=callback,
        disable_pbar=not comfy.utils.PROGRESS_BAR_ENABLED,
        seed=seed,
    )
    out = dict(latent)
    out["samples"] = samples
    # 保留 T=1，交给解码；不要压成 4D
    return _normalize_latent(out, "采样后", keep_temporal=True)


def _cond_feat_dim(cond) -> int:
    try:
        return int(cond[0][0].shape[-1])
    except Exception:
        return -1


def _get_grounded_encode_node():
    node = resolve_h3_node("Krea2EditGroundedEncode")
    if node is not None:
        return node
    try:
        from .lazy_krea_edit_backend import Krea2EditGroundedEncode

        return Krea2EditGroundedEncode()
    except Exception as e:
        raise RuntimeError(
            "未找到 Krea2EditGroundedEncode。本包内置后端加载失败，请检查 lazy_krea_edit_backend。"
            f" 详情: {e}"
        ) from e


def _get_edit_patch_node():
    node = resolve_h3_node("Krea2EditModelPatch")
    if node is not None:
        return node
    try:
        from .lazy_krea_edit_backend import Krea2EditModelPatch

        return Krea2EditModelPatch()
    except Exception as e:
        raise RuntimeError(
            "未找到 Krea2EditModelPatch。本包内置后端加载失败，请检查 lazy_krea_edit_backend。"
            f" 详情: {e}"
        ) from e


def _grounded_encode(clip, prompt, image=None, image_b=None, grounding_px=768):
    """
    必须走 Krea2EditGroundedEncode，产出 12×2560=30720 维条件。
    禁止静默回退到普通 CLIPTextEncode（会变成 4096 导致采样炸掉）。
    """
    node = _get_grounded_encode_node()
    if image is None:
        raise RuntimeError("编辑编码需要参考图像，但 image 为空。")

    try:
        out = node.encode(
            clip=clip,
            prompt=prompt or "",
            image=image,
            image_b=image_b,
            grounding_px=int(grounding_px or 0),
            system_prompt="",
        )
    except TypeError:
        out = node.encode(
            clip, prompt or "", image, image_b, int(grounding_px or 0), ""
        )

    args = _as_list(out)
    if not args:
        raise RuntimeError("Krea2EditGroundedEncode 返回空。")
    cond = args[0]
    dim = _cond_feat_dim(cond)
    if dim != 30720:
        raise RuntimeError(
            f"Krea2 条件维度错误：得到 {dim}，需要 30720（12×2560）。\n"
            f"请检查：CLIPLoader 的 type 必须是 krea2，clip 文件为 qwen3vl_*。\n"
            f"当前接地编码可能未生效（图={'有' if image is not None else '无'}，"
            f"图B={'有' if image_b is not None else '无'}）。"
        )
    log.info(
        "[LazyKrea] grounded encode ok dim=%s imgs=%s",
        dim,
        1 + (1 if image_b is not None else 0),
    )
    return cond


def _edit_patch(model, source_latent, source_latent_b=None, vae=None,
                source_image=None, source_image_b=None,
                ref_boost=4.0, ref_boost_a=1.0, fit_mode="fit"):
    node = _get_edit_patch_node()
    kw = {
        "model": model,
        "source_latent": source_latent,
        "ref_boost": float(ref_boost),
        "ref_boost_a": float(ref_boost_a),
        "fit_mode": fit_mode if fit_mode in ("fit", "crop (legacy)") else "fit",
    }
    if source_latent_b is not None:
        kw["source_latent_b"] = source_latent_b
    if vae is not None:
        kw["vae"] = vae
    if source_image is not None:
        kw["source_image"] = source_image
    if source_image_b is not None:
        kw["source_image_b"] = source_image_b
    out = call_node_function(node, **kw)
    args = _as_list(out)
    return args[0] if args else model


def _apply_edit_lora(model, lora_name: str, strength: float):
    """编辑/四视图 LoRA；不兼容键跳过，不中断整图。"""
    if not lora_name or lora_name in ("none", "None"):
        return model
    # 复用多LoRA 的安全加载（含 reject_unloaded 处理）
    from .lazy_krea_lora_stack import _apply_model_lora

    return _apply_model_lora(model, lora_name, float(strength))


def _default_edit_lora(loras: list) -> str:
    for n in loras:
        low = str(n).lower().replace("\\", "/")
        if "identity_edit" in low or "identity-edit" in low:
            return n
    return "none"


def _default_quad_lora(loras: list) -> str:
    keys = ("四视图", "quadview", "quad_view", "quad-view", "quad view")
    for n in loras:
        low = str(n).lower().replace("\\", "/")
        if any(k in low for k in keys):
            return n
    return "none"


class LazyKreaGenerate:
    """根据 Krea包 自动文生/单图/双图/局部生成。"""

    @classmethod
    def INPUT_TYPES(cls):
        try:
            import folder_paths
            loras = ["none"] + list(folder_paths.get_filename_list("loras") or [])
        except Exception:
            loras = ["none"]
        samplers = list(comfy.samplers.KSampler.SAMPLERS)
        schedulers = list(comfy.samplers.KSampler.SCHEDULERS)
        edit_default = _default_edit_lora(loras)
        quad_default = _default_quad_lora(loras)
        return {
            "required": {
                "模型": ("MODEL", {"tooltip": "文生用（可先经多LoRA）。选风格且接了LoRA配置时会按类型重挂。"}),
                "文本编码": ("CLIP", {"tooltip": "CLIPLoader type=krea2。"}),
                "VAE": ("VAE", {"tooltip": "选 qwen_image_vae.safetensors。"}),
                "Krea包": ("KREA_PACK", {"tooltip": "接 Lazy Krea2 工作台。"}),
                "种子": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF, "tooltip": "随机种子。"}),
                "步数": ("INT", {"default": 8, "min": 1, "max": 50, "tooltip": "采样步数。文生常用 8，编辑常用 10。"}),
                "CFG": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 20.0, "step": 0.1, "tooltip": "CFG。Krea2 常用 1。"}),
                "采样器": (samplers, {"default": "euler" if "euler" in samplers else samplers[0], "tooltip": "采样器。"}),
                "调度器": (schedulers, {"default": "simple" if "simple" in schedulers else schedulers[0], "tooltip": "调度器。"}),
                "宽度": ("INT", {"default": 1024, "min": 64, "max": 4096, "step": 8, "tooltip": "输出宽度。文生/四视图/扩图生效；普通编辑跟原图。"}),
                "高度": ("INT", {"default": 1024, "min": 64, "max": 4096, "step": 8, "tooltip": "输出高度。文生/四视图/扩图生效；普通编辑跟原图。"}),
            },
            "optional": {
                "底模": ("MODEL", {
                    "tooltip": "接多LoRA的「底模」。编辑必接；选风格时也用于重挂非风格LoRA。",
                }),
                "LoRA配置": ("KREA_LORA_STACK", {
                    "tooltip": "接多LoRA的「LoRA配置」。选工作台风格时自动屏蔽类型=风格的槽。",
                }),
                "编辑LoRA": (loras, {
                    "default": edit_default,
                    "tooltip": "identity_edit。普通单图/双图/遮罩编辑时生效。",
                }),
                "编辑LoRA强度": ("FLOAT", {
                    "default": 1.0, "min": -99.0, "max": 99.0, "step": 0.01,
                    "tooltip": "编辑 LoRA 强度。",
                }),
                "百万像素": ("FLOAT", {
                    "default": 1.0, "min": 0.1, "max": 4.0, "step": 0.05,
                    "tooltip": "编辑前缩放总像素（百万）。",
                }),
                "接地像素": ("INT", {
                    "default": 768, "min": 0, "max": 4096, "step": 64,
                    "tooltip": "Qwen3-VL 接地最长边。",
                }),
                "参考强度": ("FLOAT", {
                    "default": 4.0, "min": 0.0, "max": 100.0, "step": 0.1,
                    "tooltip": "ref_boost（主体）。",
                }),
                "场景强度": ("FLOAT", {
                    "default": 1.0, "min": 0.0, "max": 100.0, "step": 0.1,
                    "tooltip": "ref_boost_a（双图场景）。",
                }),
                "随机种子": ("BOOLEAN", {"default": True, "tooltip": "开启后每次生成结束随机换种子。"}),
                "双图顺序": (["图1场景+图2人物", "图1人物+图2场景"], {
                    "default": "图1场景+图2人物",
                    "tooltip": "双图编辑时两张参考图的角色。",
                }),
                # 必须放 optional 末尾，避免旧工作流控件错位
                "四视图LoRA": (loras, {
                    "default": quad_default,
                    "tooltip": "四视图专用 LoRA。仅当工作台选「四视图」风格时生效。",
                }),
                "四视图LoRA强度": ("FLOAT", {
                    "default": 1.0, "min": -99.0, "max": 99.0, "step": 0.01,
                    "tooltip": "四视图 LoRA 强度。",
                }),
            },
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("图像", "运行信息")
    FUNCTION = "generate"
    CATEGORY = "Lazy/Krea"
    DESCRIPTION = "Lazy Krea2 生成"

    def generate(self, **kwargs):
        g = kwargs.get
        model = g("模型", g("model"))
        clip = g("文本编码", g("clip"))
        vae = g("VAE", g("vae"))
        pack = g("Krea包", g("krea_pack"))
        if model is None or clip is None or vae is None:
            raise ValueError("请连接 模型 / 文本编码 / VAE。")
        if not isinstance(pack, dict):
            raise ValueError("请连接 Lazy Krea2 工作台。")

        log.info(
            "[LazyKrea] VAE latent_dim=%s channels=%s type=%s",
            getattr(vae, "latent_dim", "?"),
            getattr(vae, "latent_channels", "?"),
            type(getattr(vae, "first_stage_model", None)).__name__,
        )

        def _i(v, default, lo=None, hi=None):
            try:
                n = int(v)
            except Exception:
                return default
            if lo is not None and n < lo:
                return default
            if hi is not None and n > hi:
                return default
            return n

        def _f(v, default, lo=None, hi=None):
            try:
                n = float(v)
            except Exception:
                return default
            if isinstance(v, bool):
                return default
            if lo is not None and n < lo:
                return default
            if hi is not None and n > hi:
                return default
            return n

        seed = _i(g("种子", 0), 0, 0, None)
        steps = _i(g("步数", 8), 8, 1, 50)
        cfg = _f(g("CFG", 1.0), 1.0, 0.0, 20.0)
        sampler = g("采样器", "euler")
        scheduler = g("调度器", "simple")
        width = _i(g("宽度", 1024), 1024, 64, 4096)
        height = _i(g("高度", 1024), 1024, 64, 4096)
        model_base = g("底模", g("model_base"))
        lora_stack = g("LoRA配置", g("lora_stack"))
        edit_lora = str(g("编辑LoRA", "none") or "none")
        # 控件错位：双图顺序串进 LoRA
        if "图1" in edit_lora or "场景" in edit_lora or "人物" in edit_lora:
            log.warning("[LazyKrea] 编辑LoRA 值异常「%s」，已回退 none", edit_lora)
            edit_lora = "none"
        edit_lora_s = _f(g("编辑LoRA强度", 1.0), 1.0, -99.0, 99.0)
        quad_lora = str(g("四视图LoRA", "none") or "none")
        if "图1" in quad_lora or "场景" in quad_lora or "人物" in quad_lora:
            log.warning("[LazyKrea] 四视图LoRA 值异常「%s」，已回退 none", quad_lora)
            quad_lora = "none"
        quad_lora_s = _f(g("四视图LoRA强度", 1.0), 1.0, -99.0, 99.0)
        megapixels = _f(g("百万像素", 1.0), 1.0, 0.1, 4.0)
        grounding_px = _i(g("接地像素", 768), 768, 0, 4096)
        ref_boost = _f(g("参考强度", 4.0), 4.0, 0.0, 100.0)
        ref_boost_a = _f(g("场景强度", 1.0), 1.0, 0.0, 100.0)
        # 兼容旧控件名「每段递增种子」
        random_seed = bool(g("随机种子", g("每段递增种子", True)))
        dual_order = str(g("双图顺序", "图1场景+图2人物") or "图1场景+图2人物")
        if dual_order not in ("图1场景+图2人物", "图1人物+图2场景"):
            dual_order = "图1场景+图2人物"

        mode = pack.get("mode") or "文生图"
        prompts = list(pack.get("prompts") or [""])
        if len(prompts) > 1000:
            log.warning("[LazyKrea] 提示段过多(%d)，只取前 1000 段", len(prompts))
            prompts = prompts[:1000]
        images = list(pack.get("images") or [])
        masks = list(pack.get("masks") or [])
        has_mask = bool(pack.get("has_mask"))
        n_img = int(pack.get("n_images") or len(images))
        ch = str(pack.get("style_channel") or "")
        quad_view = bool(pack.get("quad_view")) or ch == "quad_view"
        outpaint = bool(pack.get("outpaint")) or ch == "outpaint"

        if (pack.get("n_images") or 0) > 0 and n_img <= 0:
            raise RuntimeError(
                "工作台有参考图记录，但未能读入图像文件。"
                "请确认图片在 input/output 目录，或重新拖入后再跑。"
            )

        is_edit = n_img > 0 or quad_view or outpaint
        # 自定义风格选 K2：参考图张数、遮罩都不拦，也不强制底模/编辑LoRA
        custom_krea = ch == "krea" and not quad_view and not outpaint
        if is_edit:
            # 确保内置/外置 edit 后端可用
            _get_edit_patch_node()
            # 编辑强制只用底模，屏蔽多LoRA 出线。自定义 K2 除外。
            if model_base is None:
                if custom_krea and model is not None:
                    model_base = model
                else:
                    raise RuntimeError(
                        "编辑模式（单图/双图/遮罩/四视图/扩图）必须连接「底模」。\n"
                        "接线：UNET → 多LoRA；多LoRA.底模 → 生成.底模；多LoRA.模型 → 生成.模型（仅文生用）。\n"
                        "编辑只用底模 + 编辑/四视图LoRA，风格 LoRA 自动不生效。"
                    )
            if quad_view:
                if n_img < 1:
                    raise RuntimeError("四视图需要 1 张参考图。")
                if quad_lora in ("none", "None", ""):
                    raise RuntimeError(
                        "四视图通道必须选择「四视图LoRA」。\n"
                        "请在生成节点选择 Krea2-四视图QuadView 之类文件。"
                    )
                images = images[:1]
                masks = []
                has_mask = False
                n_img = 1
            elif outpaint:
                if n_img < 1:
                    raise RuntimeError("扩图需要 1 张参考图。")
                if edit_lora in ("none", "None", ""):
                    raise RuntimeError(
                        "扩图需要「编辑LoRA」（identity_edit）。\n"
                        "请在生成节点选择编辑 LoRA。"
                    )
                images = images[:1]
                masks = []
                has_mask = False
                n_img = 1
            elif edit_lora in ("none", "None", "") and not custom_krea:
                raise RuntimeError(
                    "编辑模式必须选择「编辑LoRA」（identity_edit）。\n"
                    "请在生成节点里选 Krea2-编辑identity_edit 之类文件。"
                )

        outs = []
        lines = []
        for pi, prompt in enumerate(prompts):
            seg_seed = seed  # 各段共用同一种子，不再递增
            label = "文生图"
            local_mask = None
            img_clean = None
            try:
                if not is_edit:
                    # 文生：合并台要求保留全部 LoRA。
                    # 旧逻辑在选了工作台风格时从底模重挂并跳过类型=风格，导致文生图没挂上。
                    style_name = str(pack.get("style_name") or "none")
                    has_wb_style = style_name not in ("none", "None", "")
                    keep_lora = bool(g("文生保留LoRA", False))
                    if keep_lora:
                        if isinstance(lora_stack, list) and model_base is not None:
                            use_model = apply_lora_stack(model_base, lora_stack)
                            log.info("[LazyKrea] 文生：按 LoRA配置 挂载，不跳过")
                        else:
                            use_model = model
                            log.info("[LazyKrea] 文生：使用已挂 LoRA 的模型")
                    elif has_wb_style and isinstance(lora_stack, list) and model_base is not None:
                        use_model = apply_lora_stack(
                            model_base, lora_stack, skip_types={"风格"}
                        )
                        log.info(
                            "[LazyKrea] 文生+风格「%s」：已屏蔽多LoRA中类型=风格的槽",
                            style_name,
                        )
                    elif has_wb_style and model_base is not None and lora_stack is None:
                        # 选了风格但没接 LoRA配置：用底模，避免风格LoRA冲突
                        use_model = model_base
                        log.warning(
                            "[LazyKrea] 已选风格但未接「LoRA配置」，文生改用底模。"
                            "请把多LoRA的 LoRA配置 → 生成的 LoRA配置。"
                        )
                    else:
                        if not has_wb_style:
                            log.info("[LazyKrea] 文生未选工作台风格")
                        use_model = model
                    pos = _clip_encode_via_node(clip, prompt)
                    dim = _cond_feat_dim(pos)
                    if dim not in (-1, 30720):
                        raise RuntimeError(
                            f"文生条件维度={dim}，Krea2 需要 30720。"
                            f"请把 CLIPLoader 的 type 设为 krea2（qwen3vl）。"
                        )
                    neg_text = str(pack.get("negative") or "").strip()
                    if neg_text:
                        neg = _clip_encode_via_node(clip, neg_text)
                    else:
                        neg = _zero_out(pos)
                    latent = _empty_krea_latent(width, height, 1)
                    steps_use = steps
                    label = "文生图"
                    log.info(
                        "[LazyKrea] 文生 %dx%d steps=%d cfg=%s seed=%s dim=%s",
                        width, height, steps_use, cfg, seg_seed, dim,
                    )
                else:
                    # 编辑：强制底模 + 编辑/四视图LoRA（屏蔽风格多LoRA）
                    if quad_view:
                        log.info(
                            "[LazyKrea] 四视图：底模+四视图LoRA，已屏蔽多LoRA风格槽"
                        )
                        use_model = _apply_edit_lora(model_base, quad_lora, quad_lora_s)
                    elif custom_krea:
                        log.info("[LazyKrea] 自定义风格：Krea2 使用参考图，不强制编辑LoRA")
                        use_model = model if model is not None else model_base
                    else:
                        log.info(
                            "[LazyKrea] 编辑/扩图：底模+编辑LoRA，已屏蔽多LoRA风格槽"
                        )
                        use_model = _apply_edit_lora(model_base, edit_lora, edit_lora_s)
                    if (not quad_view) and (not outpaint) and n_img >= 2:
                        if "人物" in dual_order and dual_order.index("人物") < dual_order.index("场景"):
                            img_scene, img_subj = images[1], images[0]
                        else:
                            img_scene, img_subj = images[0], images[1]
                        img_a = _scale_image(img_scene, megapixels)
                        img_b = _scale_image(img_subj, megapixels)
                        label = "双图编辑"
                        if has_mask:
                            log.warning(
                                "[LazyKrea] 双图编辑已忽略遮罩。"
                                "请点「清罩」；局部重绘请只用 1 张图。"
                            )
                        local_mask = None
                        img_clean = None
                    else:
                        img_a = _scale_image(images[0], megapixels)
                        img_b = None
                        mask_a = masks[0] if masks else None
                        if quad_view:
                            local_mask = None
                            img_clean = None
                            label = "四视图"
                        elif outpaint:
                            local_mask = None
                            img_clean = None
                            label = "扩图"
                            # 按采样器宽高 pad+涂蓝
                            tw = max(64, (int(width) // 16) * 16)
                            th = max(64, (int(height) // 16) * 16)
                            img_a = _pad_outpaint_blue(img_a, tw, th)
                        elif has_mask and mask_a is not None:
                            mh, mw = int(img_a.shape[1]), int(img_a.shape[2])
                            m_ratio = float(_prep_mask(mask_a, mh, mw).mean().item())
                            if m_ratio >= 0.85:
                                local_mask = None
                                img_clean = None
                                label = "单图编辑"
                                log.info(
                                    "[LazyKrea] 遮罩覆盖 %.0f%%，按整图编辑（不合成）",
                                    m_ratio * 100.0,
                                )
                            else:
                                local_mask = mask_a
                                img_clean = img_a
                                label = "局部编辑"
                                tip = "按提示修改遮罩区域，其余保持原样。"
                                if (prompt or "").strip():
                                    prompt = f"{prompt.strip()}。{tip}"
                                else:
                                    prompt = tip
                                log.info(
                                    "[LazyKrea] 局部编辑：遮罩合成 %.0f%%", m_ratio * 100.0
                                )
                        else:
                            label = "单图编辑"

                    # Identity Edit / 四视图 / 扩图
                    # 四视图、扩图：画布跟节点宽高；普通编辑跟参考图像素
                    if quad_view or outpaint:
                        w = max(64, (int(width) // 16) * 16)
                        h = max(64, (int(height) // 16) * 16)
                        log.info(
                            "[LazyKrea] %s画布 %dx%d",
                            "扩图" if outpaint else "四视图",
                            w, h,
                        )
                    else:
                        h, w = int(img_a.shape[1]), int(img_a.shape[2])
                        w = max(64, (w // 16) * 16)
                        h = max(64, (h // 16) * 16)
                    latent = _empty_sd3_latent(w, h, 1)
                    src_lat = _vae_encode(vae, img_a[:1])
                    src_lat_b = _vae_encode(vae, img_b[:1]) if img_b is not None else None

                    use_model = _edit_patch(
                        use_model,
                        src_lat,
                        src_lat_b,
                        vae=vae,
                        source_image=img_a[:1],
                        source_image_b=(img_b[:1] if img_b is not None else None),
                        ref_boost=ref_boost,
                        ref_boost_a=ref_boost_a,
                        fit_mode="fit",
                    )
                    pos = _grounded_encode(
                        clip, prompt, image=img_a[:1],
                        image_b=(img_b[:1] if img_b is not None else None),
                        grounding_px=grounding_px,
                    )
                    neg = _grounded_encode(
                        clip, "", image=img_a[:1],
                        image_b=(img_b[:1] if img_b is not None else None),
                        grounding_px=grounding_px,
                    )
                    steps_use = max(steps, 10) if steps < 10 else steps

                latent = _run_ksampler(
                    use_model, pos, neg, latent, seg_seed, steps_use, cfg, sampler, scheduler, 1.0
                )
                frame = _vae_decode(vae, latent)
                # 有遮罩：遮罩内=生成，外侧=原图
                if local_mask is not None and img_clean is not None:
                    frame = _composite_by_mask(frame, img_clean, local_mask)
                outs.append(frame.cpu().float().contiguous())
                lines.append(
                    f"#{pi+1} {label} seed={seg_seed} steps={steps_use} shape={tuple(frame.shape)}"
                )
            except Exception as e:
                raise RuntimeError(
                    f"Lazy Krea2 第{pi+1}段失败（模式={label}，图数={n_img}）: {e}"
                ) from e

        if not outs:
            raise RuntimeError("未生成任何图像。")
        th, tw = int(outs[0].shape[1]), int(outs[0].shape[2])
        fixed = []
        for t in outs:
            if t.shape[1] != th or t.shape[2] != tw:
                x = t.movedim(-1, 1)
                x = comfy.utils.common_upscale(x, tw, th, "bilinear", "disabled")
                t = x.movedim(1, -1)
            fixed.append(t)
        result = torch.cat(fixed, dim=0)
        info = f"Lazy Krea2 完成：{len(fixed)} 张 | seed={seed} | " + " | ".join(lines)
        log.info("[LazyKrea] %s", info)

        # 开启随机种子：本次用当前种子，生成后换新种子给前端写回控件
        ui = {}
        if random_seed:
            next_seed = int(random.randint(0, 0xFFFFFFFF))
            ui["next_seed"] = [next_seed]
            info = f"{info} | 下一种子={next_seed}"
        if ui:
            return {"ui": ui, "result": (result, info)}
        return (result, info)
