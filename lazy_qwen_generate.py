"""
Lazy Qwen2.1 生成：按工作台模式自动 文生 / 单图 / 多图 / 局部 / 四视图 / 扩图。
不修改原有节点；采样器不挂 LoRA。
"""
from __future__ import annotations

import logging
import math
import random

import torch
import comfy.sample
import comfy.samplers
import comfy.utils
import latent_preview
import node_helpers

from .lazy_h3_common import resolve_h3_node, call_node_function

log = logging.getLogger(__name__)

MAX_IMAGES = 10
RGBA_WRAP = (
    "This is an RGBA format image with transparency. {prompt} "
    "The image has an alpha channel and a transparent background."
)


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


def _prep_mask(mask: torch.Tensor, h: int, w: int) -> torch.Tensor:
    m = mask
    if m.ndim == 2:
        m = m.unsqueeze(0)
    if m.ndim == 4:
        m = m[:, 0]
    if m.shape[-2:] != (h, w):
        m = torch.nn.functional.interpolate(
            m.unsqueeze(1).float(), size=(h, w), mode="bilinear", align_corners=False
        ).squeeze(1)
    return (m[:1] > 0.5).float()


def _overlay_mask_red(image: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    """局部编辑标注：遮罩区叠半透明红，让 Qwen2.1 看见要改的区域。"""
    img = image if image.ndim == 4 else image.unsqueeze(0)
    rgb = img[:1, ..., :3].float().clone()
    if img.shape[-1] > 3:
        a = img[:1, ..., 3:4].clamp(0, 1)
        rgb = rgb * a + (1.0 - a)
    m = _prep_mask(mask, int(rgb.shape[1]), int(rgb.shape[2])).to(
        device=rgb.device, dtype=rgb.dtype
    ).unsqueeze(-1)
    tint = rgb * 0.4
    tint[..., 0] = (tint[..., 0] + 0.6).clamp(0, 1)
    tint[..., 1] = tint[..., 1] * 0.4
    tint[..., 2] = tint[..., 2] * 0.4
    return (rgb * (1.0 - m) + tint * m).clamp(0, 1)


def _feather_mask(mask: torch.Tensor, h: int, w: int) -> torch.Tensor:
    """二值遮罩做窄羽化。边缘用 replicate，避免贴边遮罩被零填充吃掉。"""
    m = _prep_mask(mask, h, w)
    short = max(1, min(h, w))
    k = int(max(3, min(15, (short // 48) * 2 + 1)))
    if k % 2 == 0:
        k += 1
    m4 = m.unsqueeze(1)
    pad = k // 2
    m4 = torch.nn.functional.pad(m4, (pad, pad, pad, pad), mode="replicate")
    m4 = torch.nn.functional.avg_pool2d(m4, kernel_size=k, stride=1)
    return m4[:, 0].clamp(0, 1)


def _composite_by_mask(generated: torch.Tensor, original: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    """遮罩内用生成 RGB，外侧贴原图。遮罩内 alpha 置不透明，避免生成 alpha 出灰块。"""
    gen = generated if generated.ndim == 4 else generated.unsqueeze(0)
    ori = original if original.ndim == 4 else original.unsqueeze(0)
    if ori.shape[0] != gen.shape[0]:
        ori = ori[:1].expand(gen.shape[0], -1, -1, -1)
    if ori.shape[1:3] != gen.shape[1:3]:
        t = ori.movedim(-1, 1)
        t = comfy.utils.common_upscale(t, gen.shape[2], gen.shape[1], "bilinear", "disabled")
        ori = t.movedim(1, -1)
    ori = ori.to(device=gen.device, dtype=gen.dtype)
    m = _feather_mask(mask, int(gen.shape[1]), int(gen.shape[2])).to(
        device=gen.device, dtype=gen.dtype
    ).unsqueeze(-1)
    out = gen[..., :3] * m + ori[..., :3] * (1.0 - m)
    if ori.shape[-1] == 4 or gen.shape[-1] == 4:
        if ori.shape[-1] == 4:
            ori_a = ori[..., 3:4]
        else:
            ori_a = torch.ones(*ori.shape[:3], 1, dtype=ori.dtype, device=ori.device)
        # 遮罩内强制不透明，外侧保留原 alpha
        alpha = ori_a * (1.0 - m) + m
        out = torch.cat([out, alpha], dim=-1)
    return out


def _mask_bbox(mask: torch.Tensor, h: int, w: int):
    """遮罩外接框加上下文，尽量包住要改的区域。"""
    m = mask[:1, :h, :w]
    ys, xs = torch.where(m[0] > 0.5)
    if ys.numel() == 0:
        return 0, h, 0, w
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    x0, x1 = int(xs.min()), int(xs.max()) + 1
    bh, bw = max(1, y1 - y0), max(1, x1 - x0)
    py = max(96, int(round(bh * 0.75)))
    px = max(96, int(round(bw * 0.75)))
    y0, x0 = max(0, y0 - py), max(0, x0 - px)
    y1, x1 = min(h, y1 + py), min(w, x1 + px)

    def _grow(a0, a1, full, min_side):
        span = a1 - a0
        need = min(full, max(span, min_side))
        extra = need - span
        a0 = max(0, a0 - extra // 2)
        a1 = min(full, a0 + need)
        a0 = max(0, a1 - need)
        return a0, a1

    y0, y1 = _grow(y0, y1, h, 384)
    x0, x1 = _grow(x0, x1, w, 384)
    if y1 <= y0 or x1 <= x0:
        return 0, h, 0, w
    return y0, y1, x0, x1


def _resize_hw(image: torch.Tensor, h: int, w: int) -> torch.Tensor:
    img = image if image.ndim == 4 else image.unsqueeze(0)
    img = img[:1]
    if int(img.shape[1]) == int(h) and int(img.shape[2]) == int(w):
        return img
    t = comfy.utils.common_upscale(img.movedim(-1, 1), int(w), int(h), "lanczos", "disabled")
    return t.movedim(1, -1)


def _apply_local_paste(frame: torch.Tensor, paste: dict) -> torch.Tensor:
    """把裁切编辑结果贴回原图。遮罩外像素保持原图。"""
    y0, y1, x0, x1 = paste["box"]
    base = paste["base"]
    if base.ndim == 3:
        base = base.unsqueeze(0)
    base = base[:1].float().clamp(0, 1)
    ch, cw = y1 - y0, x1 - x0
    gen = _resize_hw(frame, ch, cw).to(device=base.device, dtype=base.dtype)
    clean = base[:, y0:y1, x0:x1, :]
    blended = _composite_by_mask(gen, clean, paste["mask"])
    out = base.clone()
    if blended.shape[-1] != out.shape[-1]:
        if blended.shape[-1] == 3 and out.shape[-1] == 4:
            a = out[:, y0:y1, x0:x1, 3:4]
            blended = torch.cat([blended[..., :3], a], dim=-1)
        elif blended.shape[-1] == 4 and out.shape[-1] == 3:
            blended = blended[..., :3]
        else:
            blended = blended[..., : out.shape[-1]]
    out[:, y0:y1, x0:x1, :] = blended.to(dtype=out.dtype)
    return out.contiguous()


def _pad_outpaint_blue(image: torch.Tensor, tw: int, th: int) -> torch.Tensor:
    img = image
    if img.ndim == 3:
        img = img.unsqueeze(0)
    ch = int(img.shape[-1])
    img = img[:1].float().clamp(0, 1)
    _, ih, iw, _ = img.shape
    tw = max(32, int(tw) // 32 * 32)
    th = max(32, int(th) // 32 * 32)
    scale = min(float(tw) / float(iw), float(th) / float(ih))
    nw = max(1, int(round(iw * scale)))
    nh = max(1, int(round(ih * scale)))
    t = comfy.utils.common_upscale(img.movedim(-1, 1), nw, nh, "lanczos", "disabled")
    scaled = t.movedim(1, -1)
    canvas = torch.zeros(1, th, tw, ch, dtype=scaled.dtype, device=scaled.device)
    canvas[..., 2] = 1.0
    if ch > 3:
        canvas[..., 3] = 1.0
    y0 = max(0, (th - nh) // 2)
    x0 = max(0, (tw - nw) // 2)
    y1 = min(th, y0 + int(scaled.shape[1]))
    x1 = min(tw, x0 + int(scaled.shape[2]))
    canvas[:, y0:y1, x0:x1, :] = scaled[:, : y1 - y0, : x1 - x0, :]
    log.info("[LazyQwen] 扩图 pad %dx%d → 画布 %dx%d（蓝边）", iw, ih, tw, th)
    return canvas.contiguous()


def _empty_qwen_latent(w, h, batch=1):
    w = max(32, int(w) // 32 * 32)
    h = max(32, int(h) // 32 * 32)
    batch = max(1, int(batch))
    try:
        import comfy.model_management as mm
        device = mm.intermediate_device()
    except Exception:
        device = torch.device("cpu")
    lat = {
        "samples": torch.zeros([batch, 64, h // 16, w // 16], device=device),
    }
    log.info("[LazyQwen] empty latent %s (%dx%d)", tuple(lat["samples"].shape), w, h)
    return lat


def _vae_decode(vae, latent):
    if not isinstance(latent, dict) or "samples" not in latent:
        raise RuntimeError("VAE解码：latent 无效")
    samples = latent["samples"]
    node = resolve_h3_node("VAEDecode")
    frame = None
    if node is not None:
        try:
            out = call_node_function(node, samples=latent, vae=vae)
            args = _as_list(out)
            if args:
                frame = args[0]
        except Exception as e:
            log.warning("[LazyQwen] VAEDecode 节点失败，回退 vae.decode: %s", e)
    if frame is None:
        frame = vae.decode(samples)

    if not isinstance(frame, torch.Tensor):
        raise RuntimeError(f"解码结果异常: {type(frame)}")

    if frame.ndim == 5:
        if frame.shape[1] in (1, 3, 4) and frame.shape[-1] not in (1, 3, 4):
            frame = frame[:, :, 0].movedim(1, -1)
        else:
            frame = frame[:, 0]
    if frame.ndim == 4 and frame.shape[1] in (1, 3, 4) and frame.shape[-1] not in (1, 3, 4):
        frame = frame.movedim(1, -1)
    if frame.ndim == 3:
        frame = frame.unsqueeze(0)
    if frame.shape[-1] > 4:
        frame = frame[..., :4]
    if frame.shape[0] > 1:
        log.warning("[LazyQwen] 解码 batch=%d，只保留第 1 张", frame.shape[0])
        frame = frame[:1]
    return frame


def _run_ksampler(model, positive, negative, latent, seed, steps, cfg, sampler, scheduler, denoise=1.0):
    samples0 = latent["samples"]
    try:
        fixed = comfy.sample.fix_empty_latent_channels(
            model,
            samples0,
            latent.get("downscale_ratio_spacial"),
            latent.get("downscale_ratio_temporal"),
        )
        if isinstance(fixed, torch.Tensor):
            samples0 = fixed
            latent["samples"] = samples0
    except Exception as e:
        log.warning("[LazyQwen] fix_empty_latent_channels 跳过: %s", e)

    log.info("[LazyQwen] sample latent shape=%s", tuple(samples0.shape))
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
        force_full_denoise=float(denoise) >= 1.0 - 1e-6,
        noise_mask=latent.get("noise_mask"),
        callback=callback,
        disable_pbar=not comfy.utils.PROGRESS_BAR_ENABLED,
        seed=seed,
    )
    out = dict(latent)
    out["samples"] = samples
    return out


def _apply_qwen_cache(model, device: str, dtype: str):
    device = device if device in ("auto", "gpu", "cpu", "off") else "auto"
    dtype = dtype if dtype in ("default", "int8", "int4") else "default"
    node = resolve_h3_node("QwenImage21Cache")
    if node is not None:
        try:
            out = call_node_function(node, model=model, device=device, dtype=dtype)
            args = _as_list(out)
            if args:
                return args[0]
        except Exception as e:
            log.warning("[LazyQwen] QwenImage21Cache 失败，回退内置: %s", e)
    try:
        m = model.clone()
        opts = m.model_options
        if not isinstance(opts, dict):
            return model
        to = opts.get("transformer_options")
        if not isinstance(to, dict):
            to = {}
            opts["transformer_options"] = to
        to["qwen_image21_cache"] = {"device": device, "dtype": dtype}
        return m
    except Exception as e:
        log.warning("[LazyQwen] 缓存设置失败，跳过: %s", e)
        return model


def _fit_hw(h: int, w: int, cap: int):
    """不放大。不超过 cap 用原图（对齐 32），超过则长边收到 cap。"""
    h = max(1, int(h))
    w = max(1, int(w))
    cap = int(cap or 0)

    def snap(n):
        return max(32, int(round(float(n) / 32.0)) * 32)

    if cap <= 0 or max(h, w) <= cap:
        return snap(h), snap(w)
    scale = cap / float(max(h, w))
    nh, nw = snap(h * scale), snap(w * scale)
    if max(nh, nw) > cap:
        scale = cap / float(max(nh, nw))
        nh = max(32, int(nh * scale) // 32 * 32)
        nw = max(32, int(nw * scale) // 32 * 32)
    return nh, nw


def _resize_fit(image: torch.Tensor, cap: int) -> torch.Tensor:
    img = image if image.ndim == 4 else image.unsqueeze(0)
    img = img[:1]
    height, width = _fit_hw(int(img.shape[1]), int(img.shape[2]), cap)
    if (height, width) == (int(img.shape[1]), int(img.shape[2])):
        return img
    samples = img.movedim(-1, 1)
    scaled = comfy.utils.common_upscale(samples, width, height, "lanczos", "disabled")
    return scaled.movedim(1, -1)


def _resize_ref(image: torch.Tensor, resolution: int) -> torch.Tensor:
    img = image if image.ndim == 4 else image.unsqueeze(0)
    img = img[:1]
    samples = img.movedim(-1, 1)
    if resolution > 0:
        ratio = samples.shape[3] / max(1, samples.shape[2])
        width = round(math.sqrt(resolution * resolution * ratio) / 32) * 32
        height = round(math.sqrt(resolution * resolution / ratio) / 32) * 32
    else:
        width = round(samples.shape[3] / 32) * 32
        height = round(samples.shape[2] / 32) * 32
    width, height = max(32, width), max(32, height)
    if (width, height) == (samples.shape[3], samples.shape[2]):
        return img
    s = comfy.utils.common_upscale(samples, width, height, "lanczos", "disabled")
    return s.movedim(1, -1)


def _encode_qwen21(clip, prompt, negative_prompt, vae=None, resolution=2048, images=None, fit_cap=False):
    """
    调用官方 TextEncodeQwenImage21；失败则按官方逻辑内联。
    返回 (positive, negative, latent)
    """
    images = images or {}
    # 无参考图时可走官方节点；有图时内联编码，避免 Autogrow 参数被过滤
    if not images:
        node = resolve_h3_node("TextEncodeQwenImage21")
        if node is not None:
            try:
                out = call_node_function(
                    node,
                    clip=clip,
                    prompt=prompt or "",
                    negative_prompt=negative_prompt or "",
                    vae=vae,
                    resolution=int(resolution or 0),
                    images={},
                )
                args = _as_list(out)
                if len(args) >= 3:
                    return args[0], args[1], args[2]
                if len(args) == 2:
                    return args[0], args[1], None
            except Exception as e:
                log.warning("[LazyQwen] TextEncodeQwenImage21 节点失败，回退内置: %s", e)

    ref_latents = []
    images_vl = []
    latent_w = latent_h = resolution or 1024
    ordered = sorted(images.keys(), key=lambda n: int(str(n).rsplit("_", 1)[-1]))
    for name in ordered:
        image = images.get(name)
        if image is None:
            continue
        samples = image[:1].movedim(-1, 1)
        if fit_cap:
            height, width = _fit_hw(int(samples.shape[2]), int(samples.shape[3]), resolution)
        elif resolution > 0:
            ratio = samples.shape[3] / max(1, samples.shape[2])
            width = round(math.sqrt(resolution * resolution * ratio) / 32) * 32
            height = round(math.sqrt(resolution * resolution / ratio) / 32) * 32
        else:
            width = round(samples.shape[3] / 32) * 32
            height = round(samples.shape[2] / 32) * 32
        width, height = max(32, width), max(32, height)
        if (width, height) == (samples.shape[3], samples.shape[2]):
            s = image[:1]
        else:
            s = comfy.utils.common_upscale(samples, width, height, "lanczos", "disabled").movedim(1, -1)
        if not images_vl:
            latent_w, latent_h = width, height
        rgb = s[:, :, :, :3]
        if s.shape[-1] > 3:
            rgb = rgb * s[:, :, :, 3:] + (1.0 - s[:, :, :, 3:])
        images_vl.append(rgb)
        if vae is not None:
            # 视觉塔看压白后的 RGB；VAE 保留原图通道（含 alpha）
            ref_latents.append(vae.encode(s))

    keep_vision = len(ref_latents) == 0
    try:
        positive = clip.encode_from_tokens_scheduled(
            clip.tokenize(prompt or "", images=images_vl, keep_vision=keep_vision, prevent_empty_text=True)
        )
        negative = clip.encode_from_tokens_scheduled(
            clip.tokenize(negative_prompt or "", images=images_vl, keep_vision=keep_vision, prevent_empty_text=True)
        )
    except TypeError:
        positive = clip.encode_from_tokens_scheduled(clip.tokenize(prompt or "", images=images_vl))
        negative = clip.encode_from_tokens_scheduled(clip.tokenize(negative_prompt or "", images=images_vl))
    if len(ref_latents) > 0:
        positive = node_helpers.conditioning_set_values(positive, {"reference_latents": ref_latents}, append=True)
        negative = node_helpers.conditioning_set_values(negative, {"reference_latents": ref_latents}, append=True)
    try:
        import comfy.model_management as mm
        device = mm.intermediate_device()
    except Exception:
        device = torch.device("cpu")
    latent = {
        "samples": torch.zeros([1, 64, latent_h // 16, latent_w // 16], device=device)
    }
    return positive, negative, latent


def _has_image_tag(prompt: str, n: int) -> bool:
    p = (prompt or "").lower()
    return f"<image{n}>" in p or f"<image {n}>" in p


def _ensure_image_tags(prompt: str, n_img: int) -> str:
    prompt = prompt or ""
    if n_img <= 0:
        return prompt
    missing = [i for i in range(1, n_img + 1) if not _has_image_tag(prompt, i)]
    if not missing:
        return prompt
    if n_img == 1:
        prefix = "根据 <image1> 进行编辑。"
    else:
        tags = " ".join(f"<image{i}>" for i in range(1, n_img + 1))
        prefix = f"图1 <image1> 为编辑目标，其余 {tags} 为参考。"
    if prompt.strip():
        return f"{prefix}{prompt.strip()}"
    return prefix


def _wrap_rgba(prompt: str) -> str:
    p = (prompt or "").strip()
    low = p.lower()
    if "rgba" in low and "transparent" in low:
        return p
    return RGBA_WRAP.format(prompt=p or "the subject")


class LazyQwenGenerate:
    """根据 Qwen包 自动文生/单图/多图/局部生成。采样器不挂 LoRA。"""

    @classmethod
    def INPUT_TYPES(cls):
        samplers = list(comfy.samplers.KSampler.SAMPLERS)
        schedulers = list(comfy.samplers.KSampler.SCHEDULERS)
        return {
            "required": {
                "模型": ("MODEL", {"tooltip": "模型。"}),
                "文本编码": ("CLIP", {"tooltip": "文本编码器。"}),
                "VAE": ("VAE", {"tooltip": "VAE。"}),
                "Qwen包": ("QWEN21_PACK", {"tooltip": "工作台输出。"}),
                "种子": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF, "tooltip": "随机种子。"}),
                "步数": ("INT", {"default": 25, "min": 1, "max": 150, "tooltip": "采样步数。"}),
                "CFG": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 20.0, "step": 0.1, "tooltip": "CFG。"}),
                "采样器": (samplers, {"default": "euler" if "euler" in samplers else samplers[0], "tooltip": "采样器。"}),
                "调度器": (schedulers, {"default": "simple" if "simple" in schedulers else schedulers[0], "tooltip": "调度器。"}),
                "宽度": ("INT", {"default": 1024, "min": 64, "max": 4096, "step": 32, "tooltip": "输出宽度。"}),
                "高度": ("INT", {"default": 1024, "min": 64, "max": 4096, "step": 32, "tooltip": "输出高度。"}),
            },
            "optional": {
                "参考分辨率": ("INT", {
                    "default": 2048, "min": 0, "max": 4096, "step": 32,
                    "tooltip": "参考分辨率上限。",
                }),
                "自定义画布": ("BOOLEAN", {"default": False, "tooltip": "编辑时使用上方宽高。"}),
                "缓存设备": (["auto", "gpu", "cpu", "off"], {"default": "auto", "tooltip": "缓存设备。"}),
                "缓存精度": (["default", "int8", "int4"], {"default": "default", "tooltip": "缓存精度。"}),
                "透明底": ("BOOLEAN", {"default": False, "tooltip": "透明背景。"}),
                "随机种子": ("BOOLEAN", {"default": True, "tooltip": "每次生成后随机换种子。"}),
            },
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("图像", "运行信息")
    FUNCTION = "generate"
    CATEGORY = "Lazy/Qwen"
    DESCRIPTION = "Lazy Qwen2.1 生成"

    def generate(self, **kwargs):
        g = kwargs.get
        model = g("模型", g("model"))
        clip = g("文本编码", g("clip"))
        vae = g("VAE", g("vae"))
        pack = g("Qwen包", g("qwen_pack"))
        if model is None or clip is None or vae is None:
            raise ValueError("请连接 模型 / 文本编码 / VAE。")
        if not isinstance(pack, dict):
            raise ValueError("请连接 Lazy Qwen2.1 工作台。")

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
        steps = _i(g("步数", 25), 25, 1, 150)
        cfg = _f(g("CFG", 1.0), 1.0, 0.0, 20.0)
        sampler = g("采样器", "euler")
        scheduler = g("调度器", "simple")
        width = _i(g("宽度", 1024), 1024, 64, 4096)
        height = _i(g("高度", 1024), 1024, 64, 4096)
        resolution = _i(g("参考分辨率", 2048), 2048, 0, 4096)
        custom_size = bool(g("自定义画布", False))
        cache_device = str(g("缓存设备", "auto") or "auto")
        cache_dtype = str(g("缓存精度", "default") or "default")
        transparent = bool(g("透明底", False))
        random_seed = bool(g("随机种子", True))

        mode = pack.get("mode") or "文生图"
        prompts = list(pack.get("prompts") or [""])
        if len(prompts) > 1000:
            log.warning("[LazyQwen] 提示段过多(%d)，只取前 1000 段", len(prompts))
            prompts = prompts[:1000]
        images = list(pack.get("images") or [])
        masks = list(pack.get("masks") or [])
        has_mask = bool(pack.get("has_mask"))
        n_img = int(pack.get("n_images") or len(images))
        ch = str(pack.get("style_channel") or "")
        quad_view = bool(pack.get("quad_view")) or ch == "quad_view"
        outpaint = bool(pack.get("outpaint")) or ch == "outpaint"
        negative = str(pack.get("negative") or "")

        if (pack.get("n_images") or 0) > 0 and n_img <= 0:
            raise RuntimeError(
                "工作台有参考图记录，但未能读入图像文件。"
                "请确认图片在 input/output 目录，或重新拖入后再跑。"
            )

        if n_img > MAX_IMAGES:
            log.warning("[LazyQwen] 参考图过多(%d)，只取前 %d 张", n_img, MAX_IMAGES)
            images = images[:MAX_IMAGES]
            masks = masks[:MAX_IMAGES]
            n_img = MAX_IMAGES

        is_edit = n_img > 0 or quad_view or outpaint
        if is_edit and n_img < 1:
            raise RuntimeError("编辑 / 四视图 / 扩图需要至少 1 张参考图。")

        use_model = _apply_qwen_cache(model, cache_device, cache_dtype)

        outs = []
        lines = []
        for pi, prompt in enumerate(prompts):
            label = mode or "文生图"
            paste = None
            try:
                use_prompt = prompt or ""
                if transparent:
                    use_prompt = _wrap_rgba(use_prompt)

                if not is_edit:
                    label = "文生图"
                    pos, neg, _lat = _encode_qwen21(
                        clip, use_prompt, negative, vae=None, resolution=resolution, images={}
                    )
                    w = max(32, int(width) // 32 * 32)
                    h = max(32, int(height) // 32 * 32)
                    latent = _empty_qwen_latent(w, h, 1)
                    log.info("[LazyQwen] 文生 %dx%d steps=%d cfg=%s seed=%s", w, h, steps, cfg, seed)
                else:
                    work_images = list(images)
                    paste = None
                    fit_native = not custom_size and not quad_view and not outpaint
                    if fit_native and work_images:
                        src = work_images[0] if work_images[0].ndim == 4 else work_images[0].unsqueeze(0)
                        oh, ow = int(src.shape[1]), int(src.shape[2])
                        nh, nw = _fit_hw(oh, ow, resolution)
                        log.info(
                            "[LazyQwen] 按原图编辑：原图 %dx%d，上限 %d，实际 %dx%d",
                            ow, oh, resolution, nw, nh,
                        )
                    if quad_view:
                        label = "四视图"
                        work_images = work_images[:1]
                    elif outpaint:
                        label = "扩图"
                        tw = max(32, int(width) // 32 * 32)
                        th = max(32, int(height) // 32 * 32)
                        work_images = [_pad_outpaint_blue(work_images[0], tw, th)]
                    elif has_mask and masks and work_images:
                        base = work_images[0] if work_images[0].ndim == 4 else work_images[0].unsqueeze(0)
                        base = base[:1]
                        mh, mw = int(base.shape[1]), int(base.shape[2])
                        hard = _prep_mask(masks[0], mh, mw)
                        m_ratio = float(hard.mean().item())
                        if m_ratio >= 0.85:
                            label = "多图编辑" if n_img >= 2 else "单图编辑"
                            log.info("[LazyQwen] 遮罩覆盖 %.0f%%，按整图编辑", m_ratio * 100.0)
                        elif m_ratio <= 0.001:
                            label = "多图编辑" if n_img >= 2 else "单图编辑"
                        else:
                            label = "局部编辑"
                            y0, y1, x0, x1 = _mask_bbox(hard, mh, mw)
                            crop = base[:, y0:y1, x0:x1, :]
                            crop_m = hard[:, y0:y1, x0:x1]
                            crop_model = _resize_fit(crop, resolution) if fit_native else _resize_ref(crop, resolution)
                            red = _overlay_mask_red(crop_model, crop_m)
                            work_images = list(work_images)
                            work_images[0] = red
                            paste = {"base": base, "box": (y0, y1, x0, x1), "mask": crop_m}
                            tip = "只修改红色半透明区域，不要保留红色，区域外必须与原图完全一致。"
                            if use_prompt.strip():
                                use_prompt = f"{use_prompt.strip()}。{tip}"
                            else:
                                use_prompt = tip
                            log.info(
                                "[LazyQwen] 局部编辑：遮罩 %.0f%%，裁切 %dx%d → %dx%d",
                                m_ratio * 100.0, x1 - x0, y1 - y0,
                                int(red.shape[2]), int(red.shape[1]),
                            )
                    elif n_img >= 2:
                        label = "多图编辑"
                    else:
                        label = "单图编辑"

                    use_prompt = _ensure_image_tags(use_prompt, len(work_images))
                    img_dict = {}
                    for i, im in enumerate(work_images[:MAX_IMAGES]):
                        t = im if im.ndim == 4 else im.unsqueeze(0)
                        img_dict[f"image_{i + 1}"] = t[:1]

                    enc_res = 0 if outpaint else resolution
                    pos, neg, enc_latent = _encode_qwen21(
                        clip, use_prompt, negative, vae=vae,
                        resolution=enc_res, images=img_dict, fit_cap=fit_native,
                    )

                    use_custom = (custom_size or quad_view or outpaint) and paste is None
                    if paste is not None and custom_size:
                        log.info("[LazyQwen] 局部编辑忽略自定义画布，按原图尺寸贴回")
                    if use_custom:
                        w = max(32, int(width) // 32 * 32)
                        h = max(32, int(height) // 32 * 32)
                        latent = _empty_qwen_latent(w, h, 1)
                        log.info("[LazyQwen] %s 自定义画布 %dx%d", label, w, h)
                    elif isinstance(enc_latent, dict) and "samples" in enc_latent:
                        latent = enc_latent
                    else:
                        t0 = _resize_fit(work_images[0], resolution) if fit_native else _resize_ref(work_images[0], resolution)
                        latent = _empty_qwen_latent(int(t0.shape[2]), int(t0.shape[1]), 1)

                latent = _run_ksampler(
                    use_model, pos, neg, latent, seed, steps, cfg, sampler, scheduler, 1.0
                )
                frame = _vae_decode(vae, latent)
                if paste is not None:
                    frame = _apply_local_paste(frame, paste)
                if not transparent and frame.shape[-1] > 3:
                    frame = frame[..., :3].contiguous()
                outs.append(frame.cpu().float().contiguous())
                lines.append(
                    f"#{pi+1} {label} seed={seed} steps={steps} shape={tuple(frame.shape)}"
                )
            except Exception as e:
                raise RuntimeError(
                    f"Lazy Qwen2.1 第{pi+1}段失败（模式={label}，图数={n_img}）: {e}"
                ) from e

        if not outs:
            raise RuntimeError("未生成任何图像。")
        th, tw = int(outs[0].shape[1]), int(outs[0].shape[2])
        tc = int(outs[0].shape[-1])
        fixed = []
        for t in outs:
            if t.shape[-1] != tc:
                if t.shape[-1] == 3 and tc == 4:
                    a = torch.ones(*t.shape[:3], 1, dtype=t.dtype, device=t.device)
                    t = torch.cat([t, a], dim=-1)
                else:
                    t = t[..., :tc]
            if t.shape[1] != th or t.shape[2] != tw:
                x = t.movedim(-1, 1)
                x = comfy.utils.common_upscale(x, tw, th, "bilinear", "disabled")
                t = x.movedim(1, -1)
            fixed.append(t)
        result = torch.cat(fixed, dim=0)
        info = f"Lazy Qwen2.1 完成：{len(fixed)} 张 | seed={seed} | " + " | ".join(lines)
        log.info("[LazyQwen] %s", info)

        ui = {}
        if random_seed:
            next_seed = int(random.randint(0, 0xFFFFFFFF))
            ui["next_seed"] = [next_seed]
            info = f"{info} | 下一种子={next_seed}"
        if ui:
            return {"ui": ui, "result": (result, info)}
        return (result, info)
