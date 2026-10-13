"""
Lazy H3 逐段生成：按 H3_GUIDE_DATA 分模式调用原生 MiniMaxH3ImageToVideo（fl2va）。
参考生 ref 需 ref2va 模型，本节点在 mode=ref 时尝试 MiniMaxH3ReferenceToVideo。
"""
from __future__ import annotations

import gc
import logging
import math
import os
import re
import shutil
import subprocess
import tempfile
import wave

import torch
import comfy.model_management
import comfy.sample
import comfy.samplers
import comfy.sd
import comfy.utils
import latent_preview

from .lazy_h3_common import (
    H3_FPS_DEFAULT,
    H3_MODE_REF,
    H3_MODE_STORYBOARD,
    call_node_function,
    cat_audio,
    empty_audio,
    h3_frames_to_seconds,
    h3_snap_length,
    h3_snap_report,
    infer_segment_mode,
    last_frame,
    last_n_frames,
    normalize_workspace_mode,
    resolve_h3_node,
    tensor_has_image,
)
from .lazy_upscale_rife import LAZY_UPSCALE_CFG, apply_upscale_rife_cfg
from .lazy_face_refine import LAZY_FACE_REFINE_CFG, apply_face_refine_cfg
from .lazy_h3_spatial import (
    LAZY_H3_SPATIAL_CFG,
    apply_sparse_attention,
    ensure_upscaler_file,
    first_pass_size,
    normalize_spatial_cfg,
    second_pass_spatial,
)
from .wan_director import _resize_image, _normalize_resize_method

import folder_paths

log = logging.getLogger(__name__)


def _lora_combo_list():
    try:
        names = list(folder_paths.get_filename_list("loras") or [])
    except Exception:
        names = []
    pref = [
        x
        for x in names
        if any(k in x.lower() for k in ("turbo", "4step", "lightx2v", "lightx", "h3"))
    ]
    rest = [x for x in names if x not in pref]
    return ["none"] + pref + rest


def _apply_model_lora(model, lora_name: str, strength: float):
    """仅模型 LoRA（对齐 LoraLoaderModelOnly）。"""
    if model is None:
        return None
    if not lora_name or str(lora_name) in ("none", "None", ""):
        return model
    strength = float(strength)
    if abs(strength) < 1e-8:
        return model
    path = folder_paths.get_full_path("loras", str(lora_name))
    if not path:
        raise FileNotFoundError(f"找不到加速 LoRA: {lora_name}")
    lora = comfy.utils.load_torch_file(path, safe_load=True)
    model_lora, _ = comfy.sd.load_lora_for_models(model, None, lora, strength, 0.0)
    log.info("[LazyH3] 已挂加速 LoRA: %s @ %.3f", lora_name, strength)
    return model_lora


def _lora_kind(name: str) -> str:
    """turbo LoRA 家族：lightx2v / larry / generic。"""
    n = (name or "").lower().replace("\\", "/")
    if any(k in n for k in ("lightx2v", "lightx", "lx2v")):
        return "lightx2v"
    if any(k in n for k in ("larry", "ckpt500", "ckpt850", "step600", "v4_step", "turbo_4step")):
        return "larry"
    if any(k in n for k in ("turbo", "4step")):
        return "generic"
    return "unknown"


def _accel_pick_sampler(preferred: str, kind: str) -> str:
    """加速采样器：lightx2v 社区更认 er_sde；其它用 res_multistep。"""
    names = list(comfy.samplers.KSampler.SAMPLERS)
    # 已选高级采样器则尊重（非默认类）
    advanced = {"er_sde", "dpmpp_2m", "dpmpp_sde", "dpmpp_2m_sde", "uni_pc", "heun"}
    if preferred in names and preferred in advanced:
        return preferred
    if kind == "lightx2v" and "er_sde" in names:
        return "er_sde"
    if "res_multistep" in names:
        return "res_multistep"
    if preferred in names:
        return preferred
    return names[0] if names else "euler"


def _encode_clip_text(clip, text: str):
    """CLIP 文本 → conditioning。"""
    if clip is None:
        return None
    text = (text or "").strip()
    if not text:
        return None
    try:
        tokens = clip.tokenize(text)
        return clip.encode_from_tokens_scheduled(tokens)
    except Exception:
        try:
            return clip.encode(text)
        except Exception as e:
            log.warning("[LazyH3] CLIP 编码失败: %s", e)
            return None


def _apply_sigma_shift(model, shift_video: float = 12.0, shift_audio: float = 3.0):
    """官方 MiniMaxH3SigmaShift。"""
    if model is None:
        return model
    node = resolve_h3_node("MiniMaxH3SigmaShift")
    if node is None:
        log.warning("[LazyH3] 无 MiniMaxH3SigmaShift，跳过调度偏移")
        return model
    try:
        out = call_node_function(
            node, model=model, shift_video=float(shift_video), shift_audio=float(shift_audio)
        )
        args = _as_output_list(out)
        if args:
            return args[0]
    except Exception as e:
        log.warning("[LazyH3] SigmaShift 失败: %s", e)
    return model


def _is_comfy_nested(x) -> bool:
    """comfy.nested_tensor.NestedTensor（音画打包 latent）。"""
    if x is None or isinstance(x, torch.Tensor):
        return False
    return type(x).__name__ == "NestedTensor" or (
        getattr(x, "is_nested", False) and hasattr(x, "tensors")
    )


def _nested_parts(x):
    """NestedTensor → [tensor, ...]；普通 Tensor → [tensor]。"""
    if x is None:
        return []
    if _is_comfy_nested(x):
        try:
            return list(x.tensors)
        except Exception:
            try:
                return list(x.unbind())
            except Exception:
                return []
    if isinstance(x, torch.Tensor):
        return [x]
    if getattr(x, "is_nested", False):
        try:
            return list(x.unbind())
        except Exception:
            pass
    return []


def _pick_video_latent(samples):
    """从 NestedTensor / Tensor 中取视频 latent（优先 5D）。"""
    parts = _nested_parts(samples)
    if not parts:
        raise TypeError(f"无法从 samples 取出视频 latent: {type(samples)}")
    for p in parts:
        if isinstance(p, torch.Tensor) and p.ndim == 5:
            return p
    for p in parts:
        if isinstance(p, torch.Tensor) and p.ndim >= 4:
            return p
    p0 = parts[0]
    if not isinstance(p0, torch.Tensor):
        raise TypeError(f"视频 latent 非 Tensor: {type(p0)}")
    return p0


def _pick_audio_latent(samples):
    """从 NestedTensor 取音频分量（通常为第 2 个）；无则 None。"""
    parts = _nested_parts(samples)
    if len(parts) >= 2 and isinstance(parts[1], torch.Tensor):
        return parts[1]
    return None


def _find_end_image(segs: list, j: int, link: str, current_has_start: bool):
    """
    查找本段尾帧图 → (image_or_None, segment_index_or_-1)。
    - 图段：不跨文字，仅下一段直接是图
    - 文字段：沿 ⇄ 链找下一张图
    """
    if link != "flf":
        return None, -1
    n = len(segs)
    if j + 1 >= n:
        return None, -1

    if current_has_start:
        nxt = segs[j + 1]
        if tensor_has_image(nxt.get("image")):
            return nxt["image"], j + 1
        return None, -1

    k = j + 1
    while k < n:
        if tensor_has_image(segs[k].get("image")):
            return segs[k]["image"], k
        k_link = segs[k].get("link", "flf")
        if k_link not in ("flf", "cut"):
            k_link = "flf"
        if k_link == "cut":
            break
        k += 1
    return None, -1


def _as_latent_dict(latent):
    """统一成 dict，保留 NestedTensor（采样需要）；解码时再拆分量。"""
    if latent is None:
        raise ValueError("latent 为空")
    if isinstance(latent, dict):
        if "samples" not in latent:
            raise ValueError("latent 缺少 samples")
        return dict(latent)
    if _is_comfy_nested(latent) or isinstance(latent, torch.Tensor):
        return {"samples": latent}
    try:
        args = _as_output_list(latent)
        if args and isinstance(args[0], dict):
            return _as_latent_dict(args[0])
        if args:
            return {"samples": args[0]}
    except Exception:
        pass
    raise TypeError(f"无法识别的 latent 类型: {type(latent)}")


def _unwrap_node_out(out):
    """解开 Comfy v3 NodeOutput / tuple，拿到真实对象。"""
    if out is None:
        return None
    # io.NodeOutput / 类似包装
    for attr in ("args", "result", "outputs", "data"):
        if hasattr(out, attr):
            try:
                val = getattr(out, attr)
                if val is None:
                    continue
                if isinstance(val, dict):
                    # 取第一个值
                    for v in val.values():
                        return _unwrap_node_out(v)
                if isinstance(val, (tuple, list)) and len(val) > 0:
                    return _unwrap_node_out(val[0])
                if val is not out:
                    return _unwrap_node_out(val)
            except Exception:
                pass
    if isinstance(out, (tuple, list)):
        return _unwrap_node_out(out[0]) if out else None
    return out


def _make_basic_guider(model, positive):
    """
    与官方 comfy_extras.nodes_custom_sampler.Guider_Basic 完全一致：
    只 set_conds(positive)，不覆盖 predict_noise（否则会破坏 H3 Nested 音画 pack）。
    """
    import importlib

    for mod_name in (
        "comfy_extras.nodes_custom_sampler",
        "comfy_api.latest._util.nodes_custom_sampler",
    ):
        try:
            mod = importlib.import_module(mod_name)
            cls = getattr(mod, "Guider_Basic", None)
            if cls is not None:
                guider = cls(model)
                guider.set_conds(positive)
                return guider
        except Exception:
            continue

    # 官方 Guider_Basic 源码等价（禁止改 predict_noise）
    class Guider_Basic(comfy.samplers.CFGGuider):
        def set_conds(self, positive_cond):
            self.inner_set_conds({"positive": positive_cond})

    guider = Guider_Basic(model)
    guider.set_conds(positive)
    return guider


def _has_native_av_schedule(model) -> bool:
    """True：已挂 ModelSamplingAV（音画双 schedule）。缺则 4 步 turbo 易声崩。"""
    if model is None:
        return False
    try:
        ms = model.get_model_object("model_sampling")
    except Exception:
        ms = None
    if ms is not None:
        if getattr(ms, "audio_shift", None) is not None:
            return True
        try:
            import comfy.model_sampling as msp

            av = getattr(msp, "ModelSamplingAV", None)
            if av is not None and isinstance(ms, av):
                return True
        except Exception:
            pass
    try:
        to = (getattr(model, "model_options", None) or {}).get("transformer_options") or {}
        if "minimax_h3_sigma_shift_video" in to or "minimax_h3_sigma_shift_audio" in to:
            return True
    except Exception:
        pass
    return False


def _calc_sigmas(model_for_schedule, scheduler: str, steps: int, denoise: float = 1.0):
    """1:1 等价官方 BasicScheduler.get_sigmas（加速与去噪用同源模型）。"""
    steps = max(1, int(steps))
    denoise = float(denoise)
    try:
        total_steps = steps
        if denoise < 1.0:
            if denoise <= 0.0:
                return torch.FloatTensor([])
            total_steps = int(steps / denoise)
        ms = model_for_schedule.get_model_object("model_sampling")
        sigmas = comfy.samplers.calculate_sigmas(ms, scheduler, total_steps).cpu()
        return sigmas[-(steps + 1) :]
    except Exception as e:
        raise RuntimeError(f"无法计算 sigmas: {e}") from e


def _assert_nested_av(samples, stage: str):
    """采样后必须仍是音画 Nested（≥2 分量），否则声音必坏。"""
    nested = _is_comfy_nested(samples) or getattr(samples, "is_nested", False)
    parts = _nested_parts(samples)
    if nested and len(parts) >= 2:
        shapes = [tuple(p.shape) if isinstance(p, torch.Tensor) else type(p) for p in parts]
        log.info("[LazyH3] %s NestedAV ok parts=%s shapes=%s", stage, len(parts), shapes)
        return
    if nested and len(parts) < 2:
        raise RuntimeError(
            f"{stage}: Nested 仅 {len(parts)} 分量，音画包损坏，停止以免声崩。"
        )
    # 非 Nested：H3 条件节点应始终产出 Nested；若被拆平则音频丢失
    log.warning(
        "[LazyH3] %s samples 非 Nested type=%s shape=%s — 可能无音频",
        stage,
        type(samples).__name__,
        getattr(samples, "shape", None),
    )


def _run_sampler_guider(
    model,
    positive,
    latent,
    seed: int,
    steps: int,
    sampler_name: str,
    scheduler: str,
    model_for_sigmas=None,
    denoise: float = 1.0,
):
    """
    1:1 对齐官方 SamplerCustomAdvanced + BasicGuider：

      fix_empty_latent_channels(guider.model_patcher, samples, downscale_*)
      noise = prepare_noise(...)   # Nested 分别造噪
      guider.sample(noise, latent_image, sampler, sigmas, ...)

    model_for_sigmas: 与去噪同源（官方 turbo：LoRA+SigmaShift 后同一模型）；None 则用 model。
    关键：须已挂 ModelSamplingAV，且 turbo 音频偏移=6（不是标准 3）。
    """
    if sampler_name not in comfy.samplers.KSampler.SAMPLERS:
        sampler_name = "res_multistep" if "res_multistep" in comfy.samplers.KSampler.SAMPLERS else "euler"
    if scheduler not in comfy.samplers.KSampler.SCHEDULERS:
        scheduler = "simple"

    latent = _as_latent_dict(latent)
    latent = dict(latent)
    latent_image = latent["samples"]
    _assert_nested_av(latent_image, "采样前")

    guider = _make_basic_guider(model, positive)
    if not hasattr(guider, "sample") or type(guider).__name__ == "NodeOutput":
        raise RuntimeError(f"引导器无效: {type(guider)}")

    patcher = getattr(guider, "model_patcher", None) or model
    # 缺 ModelSamplingAV → 声崩高发（官方靠 MiniMaxH3SigmaShift / ModelSamplingMiniMaxH3）
    if not _has_native_av_schedule(patcher):
        log.warning(
            "[LazyH3] 去噪模型未检测到 ModelSamplingAV/audio_shift。"
            "请保持「启用调度偏移」=开（视频12/音频3），否则加速 4 步极易声音崩坏。"
        )
    sigma_src = model_for_sigmas if model_for_sigmas is not None else model
    if not _has_native_av_schedule(sigma_src):
        log.warning(
            "[LazyH3] 调度 base 未检测到 ModelSamplingAV — sigmas 可能与官方 H3 不一致。"
        )

    try:
        latent_image = comfy.sample.fix_empty_latent_channels(
            patcher,
            latent_image,
            latent.get("downscale_ratio_spacial", None),
            latent.get("downscale_ratio_temporal", None),
        )
        latent["samples"] = latent_image
    except TypeError:
        try:
            if isinstance(latent_image, torch.Tensor) and not getattr(latent_image, "is_nested", False):
                latent_image = comfy.sample.fix_empty_latent_channels(patcher, latent_image)
                latent["samples"] = latent_image
        except Exception as e:
            log.warning("[LazyH3] fix_empty_latent_channels 跳过: %s", e)
    except Exception as e:
        if not (_is_comfy_nested(latent_image) or getattr(latent_image, "is_nested", False)):
            log.warning("[LazyH3] fix_empty_latent_channels: %s", e)

    sigmas = _calc_sigmas(sigma_src, scheduler, int(steps), denoise=float(denoise))
    if sigmas is None or (torch.is_tensor(sigmas) and sigmas.numel() < 2):
        raise RuntimeError(f"sigmas 异常: {type(sigmas)} {getattr(sigmas, 'shape', None)}")

    try:
        sampler = comfy.samplers.sampler_object(sampler_name)
    except Exception as e:
        raise RuntimeError(f"sampler_object({sampler_name}) 失败: {e}") from e

    # 与 Noise_RandomNoise.generate_noise(latent) 一致
    batch_inds = latent.get("batch_index", None)
    try:
        noise = comfy.sample.prepare_noise(latent_image, int(seed), batch_inds)
    except Exception as e:
        raise RuntimeError(
            f"prepare_noise 失败 type={type(latent_image)} nested="
            f"{_is_comfy_nested(latent_image) or getattr(latent_image, 'is_nested', False)}: {e}"
        ) from e

    noise_mask = latent.get("noise_mask", None)
    try:
        n_cb = max(1, int(sigmas.shape[-1]) - 1)
    except Exception:
        n_cb = max(1, int(steps))
    callback = latent_preview.prepare_callback(patcher, n_cb)
    disable_pbar = not comfy.utils.PROGRESS_BAR_ENABLED

    try:
        samples = guider.sample(
            noise,
            latent_image,
            sampler,
            sigmas,
            denoise_mask=noise_mask,
            callback=callback,
            disable_pbar=disable_pbar,
            seed=int(seed),
        )
    except Exception as e:
        raise RuntimeError(f"guider.sample 失败（H3 音画 Nested）: {e}") from e

    if samples is None:
        raise RuntimeError("guider.sample 返回 None")

    try:
        # 与官方 sample_custom 一致：中间设备 + 中间 dtype（Nested 亦支持 .to）
        samples = samples.to(
            device=comfy.model_management.intermediate_device(),
            dtype=comfy.model_management.intermediate_dtype(),
        )
    except TypeError:
        try:
            samples = samples.to(comfy.model_management.intermediate_device())
        except Exception:
            pass
    except Exception:
        pass

    _assert_nested_av(samples, "采样后")

    out = dict(latent)
    out.pop("downscale_ratio_spacial", None)
    out.pop("downscale_ratio_temporal", None)
    out["samples"] = samples

    nested = _is_comfy_nested(samples) or getattr(samples, "is_nested", False)
    log.info(
        "[LazyH3] 加速采样成功 steps=%s sampler=%s sched=%s seed=%s nested=%s av=%s guider=%s",
        steps,
        sampler_name,
        scheduler,
        seed,
        nested,
        _has_native_av_schedule(patcher),
        type(guider).__name__,
    )
    return out


def _run_sampler(
    model,
    positive,
    latent,
    seed: int,
    steps: int,
    sampler_name: str,
    scheduler: str,
    cfg: float = 1.0,
    negative=None,
    accel: bool = False,
    model_for_sigmas=None,
    denoise: float = 1.0,
):
    """H3 采样：标准 sample，或加速模式（官方 SCA 内核）。denoise<1 只用于空间二采。"""
    try:
        denoise = float(denoise)
    except Exception:
        denoise = 1.0
    if denoise <= 0.0 or denoise > 1.0:
        denoise = 1.0
    if accel:
        return _run_sampler_guider(
            model,
            positive,
            latent,
            seed,
            steps,
            sampler_name,
            scheduler,
            model_for_sigmas=model_for_sigmas,
            denoise=denoise,
        )

    if sampler_name not in comfy.samplers.KSampler.SAMPLERS:
        sampler_name = "res_multistep" if "res_multistep" in comfy.samplers.KSampler.SAMPLERS else "euler"
    if scheduler not in comfy.samplers.KSampler.SCHEDULERS:
        scheduler = "simple"
    latent = _as_latent_dict(latent)
    latent_image = latent["samples"]
    noise = comfy.sample.prepare_noise(latent_image, seed, None)
    noise_mask = latent.get("noise_mask", None)
    callback = latent_preview.prepare_callback(model, steps)
    disable_pbar = not comfy.utils.PROGRESS_BAR_ENABLED
    neg = negative if negative is not None else positive
    try:
        if isinstance(latent_image, torch.Tensor) and not getattr(latent_image, "is_nested", False):
            latent_image = comfy.sample.fix_empty_latent_channels(model, latent_image)
    except Exception as e:
        log.warning("[LazyH3] fix_empty_latent_channels 跳过: %s", e)
    samples = comfy.sample.sample(
        model,
        noise,
        steps,
        cfg,
        sampler_name,
        scheduler,
        positive,
        neg,
        latent_image,
        denoise=denoise,
        disable_noise=False,
        start_step=None,
        last_step=None,
        force_full_denoise=True,
        noise_mask=noise_mask,
        callback=callback,
        disable_pbar=disable_pbar,
        seed=seed,
    )
    out = dict(latent)
    out["samples"] = samples
    return out


def _frames_from_vae_out(frames) -> torch.Tensor:
    if _is_comfy_nested(frames):
        # 取第一个可成像分量
        frames = _pick_video_latent(frames)
    if not isinstance(frames, torch.Tensor):
        raise TypeError(f"VAE 解码结果非 Tensor: {type(frames)}")
    frames = frames.detach().float()
    # H3 像素常为 [-1,1]
    if float(frames.min()) < -0.01:
        frames = (frames + 1.0) * 0.5
    if frames.ndim == 5:
        if frames.shape[1] in (1, 3, 4) and frames.shape[-1] not in (1, 3, 4):
            frames = frames.permute(0, 2, 3, 4, 1).contiguous()
        b, t, h, w, c = frames.shape[0], frames.shape[1], frames.shape[2], frames.shape[3], frames.shape[4]
        frames = frames.reshape(b * t, h, w, c)
    elif frames.ndim == 4 and frames.shape[1] in (1, 3, 4) and frames.shape[-1] not in (1, 3, 4):
        frames = frames.permute(0, 2, 3, 1).contiguous()
    if frames.shape[-1] > 3:
        frames = frames[..., :3]
    return frames.cpu().clamp(0, 1).contiguous()


def _decode_video(vae, latent) -> torch.Tensor:
    latent = _as_latent_dict(latent)
    samples = latent["samples"]
    video_z = _pick_video_latent(samples)

    frames = None
    # 用「仅视频」的 latent dict 调 VAEDecode
    vid_latent = dict(latent)
    vid_latent["samples"] = video_z

    node = resolve_h3_node("VAEDecode")
    if node is not None:
        try:
            out = call_node_function(node, samples=vid_latent, vae=vae)
            args = _as_output_list(out)
            if args:
                frames = args[0]
        except Exception as e:
            log.warning("[LazyH3] VAEDecode 节点失败，回退 vae.decode: %s", e)

    if frames is None:
        frames = vae.decode(video_z)

    return _frames_from_vae_out(frames)


def _audio_vae_sr(audio_vae, default: int = 32000) -> int:
    """H3 音频 VAE 采样率（官方 32000）。"""
    if audio_vae is None:
        return default
    return int(
        getattr(audio_vae, "audio_sample_rate_output", None)
        or getattr(audio_vae, "audio_sample_rate", None)
        or default
    )


def _normalize_waveform(w: torch.Tensor) -> torch.Tensor:
    """统一成 Comfy AUDIO：[B, C, T]，立体声优先。"""
    if not isinstance(w, torch.Tensor):
        raise TypeError(f"waveform 非 Tensor: {type(w)}")
    w = w.detach().float().cpu()
    if w.ndim == 1:
        w = w.view(1, 1, -1)
    elif w.ndim == 2:
        # [C,T] 或 [T,C]
        if w.shape[0] in (1, 2) and w.shape[1] > 8:
            w = w.unsqueeze(0)
        elif w.shape[1] in (1, 2) and w.shape[0] > 8:
            w = w.unsqueeze(0).movedim(-1, 1)
        else:
            w = w.unsqueeze(0)
    elif w.ndim == 3:
        # 官方 VAE 包装输出常为 [B, T, C]，需 movedim → [B, C, T]
        b, a, c = w.shape
        if c in (1, 2) and a > 8 and a > c:
            w = w.movedim(-1, 1)
        elif a in (1, 2):
            pass  # 已是 [B, C, T]
        elif c > 2 and a > 2:
            # 启发式：时间维通常更长
            if a > c:
                w = w.movedim(-1, 1)
    else:
        raise TypeError(f"waveform 维度异常: {tuple(w.shape)}")

    if w.shape[0] > 1:
        w = w[:1]
    if w.shape[1] == 1:
        w = w.repeat(1, 2, 1)
    elif w.shape[1] > 2:
        w = w[:, :2, :]
    return w.contiguous()


def _repair_turbo_waveform(w: torch.Tensor) -> torch.Tensor:
    """
    加速/turbo 音频后处理（不改变语义，只减轻常见崩坏表现）：
    - 去直流
    - 左右声道 RMS 轻平衡（turbo 常见左右跳动）
    - 软峰值限制，避免数字削波毛刺
    """
    if not isinstance(w, torch.Tensor) or w.numel() == 0:
        return w
    w = w.float()
    w = torch.nan_to_num(w, nan=0.0, posinf=0.0, neginf=0.0)
    # 去直流
    try:
        w = w - w.mean(dim=-1, keepdim=True)
    except Exception:
        pass
    # 立体声平衡
    try:
        if w.ndim == 3 and w.shape[1] == 2:
            l = w[:, 0:1, :]
            r = w[:, 1:2, :]
            rl = float(l.pow(2).mean().sqrt().clamp(min=1e-8))
            rr = float(r.pow(2).mean().sqrt().clamp(min=1e-8))
            # 仅当严重失衡时拉平（避免抹掉正常声像）
            ratio = max(rl, rr) / max(min(rl, rr), 1e-8)
            if ratio > 1.8:
                target = (rl + rr) * 0.5
                w = torch.cat([l * (target / rl), r * (target / rr)], dim=1)
    except Exception:
        pass
    # 软限幅
    try:
        peak = float(w.abs().max())
        if peak > 0.98:
            w = w * (0.95 / peak)
        # tanh 软膝，压高频毛刺感
        w = torch.tanh(w * 1.05) / math.tanh(1.05)
    except Exception:
        pass
    return w.contiguous()


def _finalize_audio_dict(audio: dict, audio_vae=None, apply_gain: bool = False, turbo_repair: bool = False) -> dict:
    """校验并规范 AUDIO 字典；近静音打日志。"""
    if not isinstance(audio, dict) or "waveform" not in audio:
        raise TypeError(f"无效 AUDIO: {type(audio)}")
    w = _normalize_waveform(audio["waveform"])
    sr = int(audio.get("sample_rate") or _audio_vae_sr(audio_vae) or 32000)
    # 与官方 VAEDecodeAudio 一致的音量归一（官方节点已做时勿重复）
    if apply_gain:
        try:
            std = torch.std(w, dim=[1, 2], keepdim=True) * 5.0
            std = torch.clamp(std, min=1.0)
            w = w / std
        except Exception:
            pass
    if turbo_repair:
        w = _repair_turbo_waveform(w)
    peak = float(w.abs().max()) if w.numel() else 0.0
    if peak < 1e-5:
        log.warning("[LazyH3] 音频近静音 peak=%.2e sr=%d shape=%s", peak, sr, tuple(w.shape))
    else:
        log.info("[LazyH3] 音频解码 ok peak=%.4f sr=%d samples=%d", peak, sr, int(w.shape[-1]))
    return {"waveform": w, "sample_rate": sr}


def _decode_audio(audio_vae, latent, turbo_repair: bool = False) -> dict:
    """对齐官方 VAEDecodeAudio：Nested 取末段音频 latent → decode → movedim → 归一。"""
    sr_fb = _audio_vae_sr(audio_vae, 32000)
    if audio_vae is None:
        log.warning("[LazyH3] 未接音频VAE，输出静音")
        return empty_audio(1.0, sr_fb)

    latent = _as_latent_dict(latent)
    samples = latent["samples"]

    # 1) 优先官方节点（内部 unbind()[-1] + movedim + 归一 + 正确采样率）
    node = resolve_h3_node("VAEDecodeAudio")
    if node is not None:
        try:
            out = call_node_function(node, samples=latent, vae=audio_vae)
            args = _as_output_list(out)
            out0 = args[0] if args else out
            if isinstance(out0, dict) and "waveform" in out0:
                return _finalize_audio_dict(out0, audio_vae, turbo_repair=turbo_repair)
        except Exception as e:
            log.warning("[LazyH3] VAEDecodeAudio 失败，回退手动解码: %s", e)

    # 2) 手动：与 comfy_extras.nodes_audio.vae_decode_audio 一致
    audio_z = _pick_audio_latent(samples)
    if audio_z is None:
        # Nested 官方取 unbind()[-1]
        parts = _nested_parts(samples)
        if parts and isinstance(parts[-1], torch.Tensor) and parts[-1].ndim != 5:
            audio_z = parts[-1]
    if audio_z is None:
        log.warning("[LazyH3] Nested 中无音频分量，输出静音")
        return empty_audio(1.0, sr_fb)

    try:
        if not hasattr(audio_vae, "decode"):
            raise RuntimeError("音频 VAE 无 decode")
        # VAE 包装层输出 [B, T, C]，必须 movedim(-1,1) → [B, C, T]
        decoded = audio_vae.decode(audio_z)
        if isinstance(decoded, dict) and "waveform" in decoded:
            return _finalize_audio_dict(
                decoded, audio_vae, apply_gain=True, turbo_repair=turbo_repair
            )
        if not isinstance(decoded, torch.Tensor):
            raise TypeError(f"音频 decode 返回异常: {type(decoded)}")
        # 与官方一致：先按通道在最后处理
        audio = decoded.movedim(-1, 1) if decoded.ndim == 3 else decoded
        return _finalize_audio_dict(
            {"waveform": audio, "sample_rate": sr_fb},
            audio_vae,
            apply_gain=True,
            turbo_repair=turbo_repair,
        )
    except Exception as e:
        log.warning("[LazyH3] 音频 decode 失败: %s", e)
        return empty_audio(1.0, sr_fb)


def _as_output_list(out):
    """把 Comfy NodeOutput / tuple / list 统一成 list，便于取 positive、latent。"""
    if out is None:
        raise RuntimeError("节点返回 None")
    if isinstance(out, (tuple, list)):
        return list(out)
    for attr in ("args", "result", "outputs", "data", "value"):
        if hasattr(out, attr):
            val = getattr(out, attr)
            if val is None:
                continue
            try:
                return list(val)
            except Exception:
                if not isinstance(val, (str, bytes)) and hasattr(val, "__iter__"):
                    try:
                        return [x for x in val]
                    except Exception:
                        pass
    try:
        return [out[0], out[1]]
    except Exception:
        pass
    try:
        return list(out)
    except Exception as e:
        raise RuntimeError(f"无法解析节点返回: {type(out)} {e}") from e


# 运动续接可用的上下文长度（须整除 latent 步，与 H3 Motion Context 一致）
_MC_CONTEXT_CHOICES = ("22", "5", "39", "56")


def _apply_h3_motion_context(
    positive,
    video_vae,
    latent,
    context_latent,
    context_length: int,
    audio_context_length: int = 0,
    context_frames=None,
):
    """
    条件后、采样前：用上一段成片尾部钉住运动。
    传成片帧，不传未裁完的整段 latent，避免接下被丢掉的尾巴。
    返回 (conditioning, trim_frames)。依赖 ComfyUI-H3-Motion-Context。
    """
    node = resolve_h3_node("MiniMaxH3MotionContext")
    if node is None:
        raise RuntimeError(
            "未找到 H3 Motion Context（MiniMaxH3MotionContext）。"
            "请安装 custom_nodes/ComfyUI-H3-Motion-Context 后重试。"
        )
    cl = str(int(context_length))
    if cl not in _MC_CONTEXT_CHOICES:
        cl = "22"
    a_len = int(audio_context_length) if int(audio_context_length or 0) > 0 else 0
    kwargs = dict(
        conditioning=positive,
        vae=video_vae,
        latent=latent,
        context_length=cl,
        audio_context_length=a_len,
    )
    if context_frames is not None:
        kwargs["context_frames"] = context_frames
    elif context_latent is not None:
        kwargs["context_latent"] = context_latent
    out = call_node_function(node, **kwargs)
    args = _as_output_list(out)
    if len(args) < 2:
        raise RuntimeError(f"Motion Context 返回项不足: {type(out)} len={len(args)}")
    cond_out, trim = args[0], int(args[1] or 0)
    return cond_out, max(0, trim)


def _trim_motion_head(frames, audio, trim_frames: int, fps: float):
    """
    去掉运动续接钉住的片头（画+音同步）。
    对齐 MiniMaxH3MotionContextTrim：match_tail 截音频尾部多余。
    """
    n = max(0, int(trim_frames or 0))
    if n <= 0 or frames is None:
        return frames, audio
    total = int(frames.shape[0])
    if n >= total:
        raise ValueError(f"运动续接裁切 {n} 帧 ≥ 出片 {total} 帧")
    out_frames = frames[n:].contiguous()

    out_audio = audio
    if isinstance(audio, dict) and "waveform" in audio:
        try:
            waveform = audio["waveform"]
            sr = int(audio.get("sample_rate") or 32000)
            cut = int(round((n / float(fps)) * sr))
            length = int(waveform.shape[-1])
            if cut > 0 and cut < length:
                waveform = waveform[..., cut:]
            # 尾部对齐 frames/fps，避免段间音频漂移累积
            frames_left = total - n
            want = int(round(frames_left / float(fps) * sr))
            have = int(waveform.shape[-1])
            if have > want > 0:
                waveform = waveform[..., :want]
            out_audio = {"waveform": waveform.contiguous(), "sample_rate": sr}
        except Exception as e:
            log.warning("[LazyH3] 运动续接音频裁切跳过: %s", e)
    return out_frames, out_audio


def _lock_first_to_prev(frames, prev_last):
    """
    成片第一帧改成上一段尾帧（像素对齐）。
    上一段画面保持不动，下一段开头不重绘、不跳帧。
    """
    if frames is None or prev_last is None:
        return frames
    if not isinstance(frames, torch.Tensor) or frames.ndim != 4 or int(frames.shape[0]) < 1:
        return frames
    src = prev_last
    if not isinstance(src, torch.Tensor):
        return frames
    if src.ndim == 3:
        src = src.unsqueeze(0)
    if src.ndim != 4 or int(src.shape[0]) < 1:
        return frames
    src = src[-1:, ..., : int(frames.shape[-1])].detach()
    th, tw = int(frames.shape[1]), int(frames.shape[2])
    if int(src.shape[1]) != th or int(src.shape[2]) != tw:
        src = torch.nn.functional.interpolate(
            src.movedim(-1, 1).float(),
            size=(th, tw),
            mode="bilinear",
            align_corners=False,
        ).movedim(1, -1)
    src = src.to(device=frames.device, dtype=frames.dtype)
    out = frames.clone()
    ch = min(int(out.shape[-1]), int(src.shape[-1]))
    out[0:1, ..., :ch] = src[..., :ch]
    return out.contiguous()


def _av_pixel_frames(latent) -> int:
    """视频 latent 对应的像素帧数。第 0 步 1 帧，其后每步 4 帧。"""
    parts = _nested_parts(latent.get("samples") if isinstance(latent, dict) else None)
    if not parts or not isinstance(parts[0], torch.Tensor) or parts[0].ndim != 5:
        return 0
    n = 0
    for k in range(int(parts[0].shape[2])):
        n += 1 if (k % 5) == 0 else 4
    return n


def _snapshot_keyframes(positive):
    """运续替换条件前，留下官方已经按画布编码好的关键帧。"""
    found = []
    if not isinstance(positive, (list, tuple)):
        return found
    for item in positive:
        if not (isinstance(item, (list, tuple)) and len(item) >= 2 and isinstance(item[1], dict)):
            continue
        for kf in item[1].get("minimax_keyframes") or []:
            if isinstance(kf, dict) and kf.get("latent") is not None:
                found.append(dict(kf))
        if found:
            break
    return found


def _tail_keyframes(saved, head_end: int, frame_count: int):
    """
    只把落在运续片头之后的锚点放回去（通常是下一段那张尾帧）。
    用原来的 latent，不再重编码。重编码尺寸和音画包对不上时，加速采样会炸。
    片头里的首帧不补：运续已经钉过，再钉一颗中间帧会让打包槽位和 token 错位。
    """
    keep = []
    seen = set()
    head_end = max(0, int(head_end or 0))
    frame_count = int(frame_count or 0)
    for kf in saved or []:
        if not isinstance(kf, dict) or kf.get("latent") is None:
            continue
        pos = int(kf.get("resolved_frame_index") or 0)
        if pos < head_end:
            continue
        if pos in seen:
            continue
        seen.add(pos)
        item = {
            "resolved_frame_index": pos,
            "motion_context_index": pos,
            "latent": kf["latent"],
        }
        if kf.get("audio_latent") is not None:
            item["audio_latent"] = kf["audio_latent"]
        # 中间帧：旧版布局只认首尾。真实下标放 motion_context_index。
        if frame_count > 1 and 0 < pos < frame_count - 1:
            item["resolved_frame_index"] = 0
        keep.append(item)
    return keep


def _append_keyframes(positive, keyframes):
    if not keyframes or not isinstance(positive, (list, tuple)):
        return positive
    out = []
    wrote = False
    for item in positive:
        if isinstance(item, (list, tuple)) and len(item) >= 2 and isinstance(item[1], dict):
            d = dict(item[1])
            kfs = list(d.get("minimax_keyframes") or [])
            kfs.extend(keyframes)
            d["minimax_keyframes"] = kfs
            out.append([item[0], d])
            wrote = True
        else:
            out.append(item)
    return out if wrote else positive


def _restore_tail_keyframes(positive, saved, head_end: int, latent=None):
    """运续清掉首尾锚点后，把片头之后的原关键帧按原 latent 接回去。"""
    keep = _tail_keyframes(saved, head_end, _av_pixel_frames(latent))
    if not keep:
        return positive
    return _append_keyframes(positive, keep)


def _h3_latent_index_for_frame(pixel_index: int) -> int:
    """像素帧 → 视频 latent 时间下标。第 0 个 token 是 1 帧，其后每 token 4 帧。"""
    pixel_index = max(0, int(pixel_index))
    acc = 0
    k = 0
    while True:
        span = 1 if (k % 5) == 0 else 4
        if pixel_index < acc + span:
            return k
        acc += span
        k += 1


def _pin_h3_ref_first(positive, latent, image, vae, frame_index: int = 0):
    """
    参考生没有首帧口。把一张图钉进视频 latent，并把这一格的降噪遮罩清掉。
    不写入关键帧列表：参考和关键帧叠在一起时，音画打包槽位会对不齐。
    """
    if image is None or vae is None or not isinstance(latent, dict):
        return positive, latent, False
    if not isinstance(image, torch.Tensor):
        return positive, latent, False
    img = image
    if img.ndim == 3:
        img = img.unsqueeze(0)
    if img.ndim != 4 or int(img.shape[0]) < 1:
        return positive, latent, False
    img = img[:1, ..., :3].contiguous()

    samples = latent.get("samples")
    parts = _nested_parts(samples)
    if not parts or not isinstance(parts[0], torch.Tensor) or parts[0].ndim != 5:
        log.warning("[LazyH3] 多参首帧：没有视频 latent，跳过")
        return positive, latent, False
    video = parts[0]
    if int(video.shape[2]) < 1:
        return positive, latent, False
    k = _h3_latent_index_for_frame(frame_index)
    if k >= int(video.shape[2]):
        log.warning(
            "[LazyH3] 多参首帧：像素帧 %d 对应 latent[%d]，超出长度 %d，跳过",
            int(frame_index), k, int(video.shape[2]),
        )
        return positive, latent, False

    ph = int(video.shape[3]) * 16
    pw = int(video.shape[4]) * 16
    try:
        stretched = comfy.utils.common_upscale(
            img.movedim(-1, 1).float(), pw, ph, "lanczos", "disabled",
        ).movedim(1, -1).contiguous()
        enc = vae.encode(stretched)
    except Exception as e:
        log.warning("[LazyH3] 多参首帧编码失败: %s", e)
        return positive, latent, False
    if not isinstance(enc, torch.Tensor) or enc.ndim != 5 or int(enc.shape[2]) < 1:
        log.warning("[LazyH3] 多参首帧编码形状异常: %s", getattr(enc, "shape", None))
        return positive, latent, False
    enc = enc[:, :, :1].detach()
    if int(enc.shape[1]) != int(video.shape[1]) or tuple(enc.shape[-2:]) != tuple(video.shape[-2:]):
        log.warning(
            "[LazyH3] 多参首帧尺寸对不上 编码=%s 视频=%s",
            tuple(enc.shape), tuple(video.shape),
        )
        return positive, latent, False

    video = video.clone()
    video[:, :, k:k + 1] = enc.to(device=video.device, dtype=video.dtype)
    new_parts = [video, *parts[1:]]

    import comfy.nested_tensor as nt

    out = dict(latent)
    if len(new_parts) >= 2:
        out["samples"] = nt.NestedTensor(tuple(new_parts))
    else:
        out["samples"] = video

    old_masks = _nested_parts(latent.get("noise_mask"))
    if (
        old_masks
        and isinstance(old_masks[0], torch.Tensor)
        and tuple(old_masks[0].shape) == tuple(video.shape)
    ):
        vmask = old_masks[0].clone().to(device=video.device, dtype=video.dtype)
    else:
        vmask = torch.ones(video.shape, device=video.device, dtype=video.dtype)
    vmask[:, :, k:k + 1] = 0
    if len(new_parts) >= 2:
        audio = new_parts[1]
        if (
            len(old_masks) >= 2
            and isinstance(old_masks[1], torch.Tensor)
            and tuple(old_masks[1].shape) == tuple(audio.shape)
        ):
            amask = old_masks[1].to(device=audio.device, dtype=audio.dtype)
        else:
            amask = torch.ones(audio.shape, device=audio.device, dtype=audio.dtype)
        out["noise_mask"] = nt.NestedTensor((vmask, amask))
    else:
        out["noise_mask"] = vmask

    return positive, out, True


def _fit_audio_len(audio: dict, n_frames: int, fps: float) -> dict:
    """把 AUDIO 精确裁/垫到 n_frames 对应采样数。"""
    if not isinstance(audio, dict) or audio.get("waveform") is None:
        return audio
    wf = audio["waveform"]
    if not isinstance(wf, torch.Tensor):
        wf = torch.as_tensor(wf)
    if wf.ndim == 2:
        wf = wf.unsqueeze(0)
    sr = int(audio.get("sample_rate") or 32000)
    need = max(1, int(round(float(n_frames) / max(float(fps), 1e-6) * sr)))
    cur = int(wf.shape[-1])
    if cur < need:
        wf = torch.nn.functional.pad(wf, (0, need - cur))
    elif cur > need:
        wf = wf[..., :need]
    return {"waveform": wf.contiguous().float(), "sample_rate": sr}


def _force_video_len(frames: torch.Tensor, n_frames: int) -> torch.Tensor:
    """视频精确到 n_frames（多裁少垫末帧）。"""
    n = max(1, int(n_frames))
    if frames is None or not isinstance(frames, torch.Tensor):
        return frames
    have = int(frames.shape[0])
    if have == n:
        return frames.contiguous()
    if have > n:
        return frames[:n].contiguous()
    pad = frames[-1:].repeat(n - have, 1, 1, 1)
    return torch.cat([frames, pad], dim=0).contiguous()


def _h3_audio_lock(av_latent: dict, source_audio: dict, audio_vae) -> dict:
    """
    Audio Lock：把源音频编码进 AV latent，音频 denoise_mask=0，只生成画面。
    对齐 VRGDG_MiniMaxH3AudioDrive / 官方 Audio Lock 思路。
    """
    if not isinstance(av_latent, dict) or "samples" not in av_latent:
        raise ValueError("Audio Lock 需要 AV LATENT")
    if not isinstance(source_audio, dict) or source_audio.get("waveform") is None:
        raise ValueError("Audio Lock 需要源 AUDIO")
    samples = av_latent["samples"]
    if not getattr(samples, "is_nested", False):
        raise ValueError("Audio Lock 需要 Nested AV latent")
    parts = list(samples.unbind())
    if len(parts) < 2:
        raise ValueError("Audio Lock 找不到音频半边 latent")
    video_latent, template_audio = parts[0], parts[1]

    wf = source_audio["waveform"]
    if not isinstance(wf, torch.Tensor):
        wf = torch.as_tensor(wf)
    if wf.ndim == 2:
        wf = wf.unsqueeze(0)
    sr = int(source_audio.get("sample_rate") or 32000)
    vae_sr = int(getattr(audio_vae, "audio_sample_rate", 32000) or 32000)
    if sr != vae_sr:
        try:
            import torchaudio
            wf = torchaudio.functional.resample(wf, sr, vae_sr)
            sr = vae_sr
        except Exception as e:
            log.warning("[LazyH3] Audio Lock 重采样失败: %s", e)

    encoded = audio_vae.encode(wf[:1].movedim(1, -1))
    # 对齐 template 时间维
    if isinstance(encoded, torch.Tensor) and isinstance(template_audio, torch.Tensor):
        if encoded.ndim == 4 and template_audio.ndim == 4:
            tb = int(template_audio.shape[0])
            if encoded.shape[0] == 1 and tb > 1:
                encoded = encoded.repeat(tb, 1, 1, 1)
            tt = int(template_audio.shape[-1])
            ct = int(encoded.shape[-1])
            if ct > tt:
                encoded = encoded[..., :tt]
            elif ct < tt:
                encoded = torch.nn.functional.pad(encoded, (0, tt - ct))
            encoded = encoded.to(device=template_audio.device, dtype=template_audio.dtype)

    import comfy.nested_tensor as nt

    out = dict(av_latent)
    out["samples"] = nt.NestedTensor((video_latent, encoded))
    out["noise_mask"] = nt.NestedTensor((
        torch.ones_like(video_latent),
        torch.zeros_like(encoded),
    ))
    return out


def _slice_drive_by_pieces(pieces, tl0: int, tl1: int, fps: float):
    """
    按驱动块映射时间线窗 → 文件真实区间后切片拼接。
    文件秒 = (trimStart + (时间线帧 - 块start)) / fps
    """
    from .lazy_h3_director import (
        _decode_audio_file,
        _resolve_input_media_path,
        _slice_audio,
    )

    fps = max(1.0, float(fps or 24))
    tl0 = int(tl0)
    tl1 = int(tl1)
    if tl1 <= tl0:
        return None

    file_cache = {}
    chunks = []
    for p in pieces or []:
        if not isinstance(p, dict):
            continue
        try:
            p_start = max(0, int(round(float(p.get("start") or 0))))
            p_len = max(1, int(round(float(p.get("length") or 0))))
            trim_start = max(0, int(round(float(p.get("trimStart") or 0))))
        except Exception:
            continue
        p_end = p_start + p_len
        # 与主轨窗相交
        a = max(tl0, p_start)
        b = min(tl1, p_end)
        if b <= a:
            continue
        fn = p.get("fileName") or p.get("audioFile") or p.get("name") or ""
        if not fn:
            continue
        if fn not in file_cache:
            path = _resolve_input_media_path(fn, "input")
            if not path:
                log.warning("[LazyH3] 驱动切片路径无效: %s", fn)
                continue
            decoded = _decode_audio_file(path)
            if decoded is None:
                continue
            file_cache[fn] = decoded
        src = file_cache[fn]
        # 时间线 a..b → 文件 (trimStart + a - p_start) ..
        f0 = (trim_start + (a - p_start)) / fps
        f1 = (trim_start + (b - p_start)) / fps
        part = _slice_audio(src, f0, f1)
        if part is None:
            continue
        chunks.append(part)
        log.info(
            "[LazyH3] 驱动映射 时间线%d–%d帧 → 文件%.2f–%.2fs (trimStart=%d 块start=%d)",
            a, b, f0, f1, trim_start, p_start,
        )

    if not chunks:
        return None
    if len(chunks) == 1:
        return chunks[0]

    # 拼接多块
    w0 = chunks[0]["waveform"]
    if not isinstance(w0, torch.Tensor):
        w0 = torch.as_tensor(w0)
    if w0.ndim == 2:
        w0 = w0.unsqueeze(0)
    sr = int(chunks[0].get("sample_rate") or 32000)
    ch = int(w0.shape[1])
    parts = [w0.float()]
    for c in chunks[1:]:
        w = c["waveform"]
        if not isinstance(w, torch.Tensor):
            w = torch.as_tensor(w)
        if w.ndim == 2:
            w = w.unsqueeze(0)
        if w.shape[1] != ch:
            if w.shape[1] == 1 and ch == 2:
                w = w.repeat(1, 2, 1)
            else:
                w = w[:, :ch, :]
        parts.append(w.float())
    return {
        "waveform": torch.cat(parts, dim=-1).contiguous(),
        "sample_rate": sr,
    }


def _prepare_segment_drive_audio(drive_original, seg, fps: float, pieces=None):
    """
    按主轨时间窗切片驱动音 → 仅对本段分离人声。
    优先用 pieces+trimStart 映射文件真实区间；否则按已对齐的 drive_original 切片。
    返回 (ref_audios_dict_or_None, original_slice_for_mux, content_len_frames)
    """
    from .lazy_h3_director import _slice_audio, _separate_vocals

    fps = max(1.0, float(fps or 24))
    content_len = int(seg.get("content_len") or seg.get("length_raw") or seg.get("length") or 0)
    content_len = max(5, content_len)
    designed_len = content_len
    tl0 = int(seg.get("timeline_start") or 0)
    tl1 = int(seg.get("timeline_end") or (tl0 + content_len))
    if tl1 < tl0 + content_len:
        tl1 = tl0 + content_len
    start_sec = tl0 / fps
    end_sec = tl1 / fps

    original_slice = None
    # ① 有裁切块：按 trimStart 直接取文件对应段（分镜/多参通用）
    if isinstance(pieces, list) and pieces:
        try:
            original_slice = _slice_drive_by_pieces(pieces, tl0, tl1, fps)
        except Exception as e:
            log.warning("[LazyH3] pieces 驱动映射失败，回退对齐轨: %s", e)
            original_slice = None

    # ② 回退：已时间线对齐的 drive_original
    if original_slice is None:
        if not isinstance(drive_original, dict) or drive_original.get("waveform") is None:
            return None, None, None
        original_slice = _slice_audio(drive_original, start_sec, end_sec)

    if original_slice is None:
        log.warning("[LazyH3] 段驱动音切片为空 start=%.2f end=%.2f", start_sec, end_sec)
        return None, None, designed_len
    # 成片按分镜 content_len（秒×fps），音频定长跟上，不按采样数把成片裁短
    vocals = _separate_vocals(original_slice)
    vocals = _fit_audio_len(vocals, designed_len, fps)
    original_slice = _fit_audio_len(original_slice, designed_len, fps)
    log.info(
        "[LazyH3] 段音频切片 时间线%.2f→%.2fs ≈%d帧 pieces=%s（仅本段分离）",
        start_sec, end_sec, designed_len,
        "有" if (isinstance(pieces, list) and pieces) else "无",
    )
    return {"ref_audio_0": vocals}, original_slice, designed_len


def _build_lock_audio_with_head(
    drive_original,
    content_vocals: dict,
    head_frames: int,
    fps: float,
    timeline_start: int,
) -> dict:
    """
    续接专用：Lock 音与画面同结构 = [片头音 | 本段音]。
    片头优先取驱动原音在 timeline_start 之前的真实片段，不够则静音补齐。
    head_frames<=0 时原样返回本段音（不开续接逻辑不变）。
    """
    if head_frames <= 0 or content_vocals is None:
        return content_vocals
    from .lazy_h3_director import _slice_audio

    fps = max(1.0, float(fps or 24))
    head_frames = max(0, int(head_frames))

    vw = content_vocals["waveform"]
    if not isinstance(vw, torch.Tensor):
        vw = torch.as_tensor(vw)
    if vw.ndim == 2:
        vw = vw.unsqueeze(0)
    sr = int(content_vocals.get("sample_rate") or 32000)
    ch = int(vw.shape[1]) if vw.ndim >= 2 else 2

    head = None
    if isinstance(drive_original, dict) and drive_original.get("waveform") is not None:
        end0 = float(timeline_start) / fps
        start0 = max(0.0, end0 - head_frames / fps)
        if end0 > start0 + 1e-6:
            head = _slice_audio(drive_original, start0, end0)
    if head is None:
        need = max(1, int(round(head_frames / fps * sr)))
        head = {
            "waveform": torch.zeros(1, ch, need, dtype=torch.float32),
            "sample_rate": sr,
        }
    head = _fit_audio_len(head, head_frames, fps)
    hw = head["waveform"]
    if not isinstance(hw, torch.Tensor):
        hw = torch.as_tensor(hw)
    if hw.ndim == 2:
        hw = hw.unsqueeze(0)
    if hw.shape[1] != vw.shape[1]:
        if hw.shape[1] == 1 and vw.shape[1] == 2:
            hw = hw.repeat(1, 2, 1)
        elif hw.shape[1] == 2 and vw.shape[1] == 1:
            vw = vw.repeat(1, 2, 1)
        else:
            m = min(int(hw.shape[1]), int(vw.shape[1]))
            hw = hw[:, :m, :]
            vw = vw[:, :m, :]
    locked = {
        "waveform": torch.cat([hw.float(), vw.float()], dim=-1).contiguous(),
        "sample_rate": sr,
    }
    log.info(
        "[LazyH3] 续接 Lock 音: 片头%d帧+本段（对齐画面[续接|内容]）",
        head_frames,
    )
    return locked


def _safe_save_name(name: str) -> str:
    """清洗为 output 子文件夹名。"""
    s = (name or "lazy_h3").strip()
    s = re.sub(r'[\\/:*?"<>|\r\n\t]+', "_", s)
    s = s.strip(" .") or "lazy_h3"
    return s[:120]


def _ensure_segment_save_dir(save_name: str) -> str:
    """output/{保存名称}/，不存在则创建。"""
    base = folder_paths.get_output_directory()
    folder = os.path.join(base, _safe_save_name(save_name))
    os.makedirs(folder, exist_ok=True)
    return folder


def _latent_stream_parts(latent):
    """取出 H3 AV latent 的 video/audio 张量列表。"""
    latent = _as_latent_dict(latent)
    samples = latent.get("samples")
    if samples is None:
        return []
    if hasattr(samples, "unbind"):
        try:
            return list(samples.unbind())
        except Exception:
            pass
    parts = _nested_parts(samples)
    if parts:
        return list(parts)
    if isinstance(samples, (list, tuple)):
        return list(samples)
    if isinstance(samples, torch.Tensor):
        return [samples]
    return []


def _audio_has_sound(audio) -> bool:
    if not isinstance(audio, dict) or audio.get("waveform") is None:
        return False
    wf = audio.get("waveform")
    if not isinstance(wf, torch.Tensor) or wf.numel() <= 0:
        return False
    try:
        return float(wf.abs().max()) >= 1e-5
    except Exception:
        return False


def _clone_audio(audio):
    if not isinstance(audio, dict) or audio.get("waveform") is None:
        return audio
    wf = audio.get("waveform")
    if not isinstance(wf, torch.Tensor):
        return audio
    return {
        "waveform": wf.detach().cpu().contiguous().float().clone(),
        "sample_rate": int(audio.get("sample_rate") or 32000),
    }


def _source_video_ok(src) -> bool:
    if not isinstance(src, torch.Tensor) or src.numel() <= 0:
        return False
    if src.ndim < 4:
        return False
    return int(src.shape[0]) >= 2


def _reload_main_source_video(seg, fps, timeline_data=None, index=0) -> bool:
    """
    导演台缓存可能被就地清空 source_video。
    有有效张量则直接用；否则按 source_meta / 时间线重新读文件。
    """
    if not isinstance(seg, dict):
        return False
    src = seg.get("source_video")
    if _source_video_ok(src):
        return True

    raw = seg.get("source_meta") if isinstance(seg.get("source_meta"), dict) else None
    if not isinstance(raw, dict) or not (
        raw.get("imageFile") or raw.get("videoFile") or raw.get("fileName")
    ):
        raw = None
        try:
            from .lazy_h3_director import _timeline_main_segments, _is_main_track_video_seg

            raw_segs = _timeline_main_segments(timeline_data or "")
            cand = raw_segs[index] if index < len(raw_segs) else None
            if _is_main_track_video_seg(cand):
                raw = cand
        except Exception as e:
            log.warning("[LazyH3] 段#%d 时间线主轨视频定位失败: %s", index + 1, e)
            raw = None
    if not isinstance(raw, dict):
        return False
    try:
        from .wan_director import _load_video_tensor
        from .lazy_h3_director import _load_video_audio

        source_video = _load_video_tensor(raw, float(fps), required=False)
    except Exception as e:
        log.warning("[LazyH3] 段#%d 主轨视频重载失败: %s", index + 1, e)
        return False
    if not _source_video_ok(source_video):
        return False
    seg["source_video"] = source_video
    seg["skip_first"] = True
    try:
        seg["source_audio"] = _load_video_audio(raw, float(fps), int(source_video.shape[0]))
    except Exception as e:
        log.warning("[LazyH3] 段#%d 主轨视频原声重载失败: %s", index + 1, e)
    log.info(
        "[LazyH3] 段#%d 已从文件重载主轨视频：%d帧（缓存张量已失效）",
        index + 1,
        int(source_video.shape[0]),
    )
    return True


def _frames_from_main_source_video(seg, fps, seg_drive_slice):
    """
    多参主轨视频：跳过一采，用原片当输入。
    声音优先用主轨视频原声，超分/二采/补帧后仍混进成片。
    返回 (frames, audio, content_len) 或 None。
    """
    src = seg.get("source_video") if isinstance(seg, dict) else None
    if not isinstance(src, torch.Tensor) or src.numel() <= 0:
        return None
    if src.ndim == 3:
        src = src.unsqueeze(0)
    if int(src.shape[0]) < 2:
        return None
    # clone：避免后处理就地改帧污染导演台缓存
    frames = src.detach().cpu().contiguous().float().clone()
    n = max(5, int(frames.shape[0]))
    fps = max(1.0, float(fps or H3_FPS_DEFAULT))
    audio = None
    src_audio = seg.get("source_audio") if isinstance(seg, dict) else None
    if _audio_has_sound(src_audio):
        try:
            audio = _clone_audio(_fit_audio_len(src_audio, n, fps))
        except Exception:
            audio = _clone_audio(src_audio)
    if audio is None and _audio_has_sound(seg_drive_slice):
        try:
            audio = _clone_audio(_fit_audio_len(seg_drive_slice, n, fps))
        except Exception:
            audio = _clone_audio(seg_drive_slice)
    if audio is None:
        audio = empty_audio(float(n) / fps, 32000)
    return frames, audio, n


def _seg_name_raw(seg_idx: int) -> str:
    """原生成视频：1.mp4"""
    return f"{int(seg_idx)}.mp4"


def _seg_name_upscale(seg_idx: int) -> str:
    """超分视频：1_超分.mp4"""
    return f"{int(seg_idx)}_超分.mp4"


def _seg_name_face(seg_idx: int) -> str:
    """二采修脸视频：1_脸修.mp4"""
    return f"{int(seg_idx)}_脸修.mp4"


def _seg_name_rife(seg_idx: int) -> str:
    """补帧视频：1_补帧.mp4"""
    return f"{int(seg_idx)}_补帧.mp4"


def _seg_name_post(seg_idx: int) -> str:
    """旧版合并文件名，拼合时兼容。"""
    return f"{int(seg_idx)}_超分补帧.mp4"


def _seg_file_ok(path: str | None) -> bool:
    return bool(path) and os.path.isfile(path) and os.path.getsize(path) > 64


def _best_seg_video(save_dir: str, seg_idx: int) -> str | None:
    """成片优先：补帧 > 脸修 > 超分 > 旧超分补帧 > 原片。"""
    for fn in (_seg_name_rife, _seg_name_face, _seg_name_upscale, _seg_name_post, _seg_name_raw):
        p = os.path.join(save_dir, fn(seg_idx))
        if _seg_file_ok(p):
            return p
    return None


def _seg_name_latent(seg_idx: int) -> str:
    return f"{int(seg_idx)}.safetensors"


def _release_mem(*objs):
    """尽量释放张量/缓存。"""
    for o in objs:
        try:
            del o
        except Exception:
            pass
    gc.collect()
    try:
        comfy.model_management.soft_empty_cache()
    except Exception:
        pass
    try:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def _save_segment_latent(folder: str, seg_idx: int, latent) -> str | None:
    """
    保存 sampler 输出 AV latent（与 H3 Motion Context Save 同格式）。
    文件：1.safetensors
    """
    try:
        from safetensors.torch import save_file as st_save
    except ImportError:
        log.warning("[LazyH3] 无 safetensors，跳过 latent 保存")
        return None
    parts = _latent_stream_parts(latent)
    if not parts:
        log.warning("[LazyH3] 段#%d latent 无流，跳过", seg_idx)
        return None
    video = parts[0]
    if not isinstance(video, torch.Tensor):
        log.warning("[LazyH3] 段#%d video latent 非 Tensor，跳过", seg_idx)
        return None
    video = video.detach().cpu().contiguous()
    data = {"video": video}
    if len(parts) >= 2 and isinstance(parts[1], torch.Tensor):
        data["audio"] = parts[1].detach().cpu().contiguous()
    else:
        log.warning("[LazyH3] 段#%d latent 无音频流，仅存视频 latent", seg_idx)
    path = os.path.join(folder, _seg_name_latent(seg_idx))
    st_save(data, path, metadata={"format": "h3_motion_context_av_v1"})
    log.info("[LazyH3] 已存 latent: %s", path)
    return path


def _find_ffmpeg() -> str | None:
    """定位 ffmpeg：imageio-ffmpeg 或系统 PATH。"""
    try:
        from imageio_ffmpeg import get_ffmpeg_exe
        p = get_ffmpeg_exe()
        if p and os.path.isfile(p):
            return p
    except Exception:
        pass
    for name in ("ffmpeg", "ffmpeg.exe"):
        p = shutil.which(name)
        if p:
            return p
    return None


def _write_temp_wav(audio: dict, path: str) -> bool:
    """把 AUDIO dict 写成临时 wav，供 ffmpeg 混流。"""
    if not isinstance(audio, dict) or "waveform" not in audio:
        return False
    try:
        w = audio["waveform"]
        if not isinstance(w, torch.Tensor):
            return False
        w = w.detach().float().cpu()
        if w.ndim == 3:
            w = w[0]
        elif w.ndim == 1:
            w = w.unsqueeze(0)
        sr = int(audio.get("sample_rate") or 32000)
        w = w.clamp(-1.0, 1.0)
        ch = int(w.shape[0])
        pcm = (w * 32767.0).round().to(torch.int16)
        if ch == 1:
            raw = pcm.reshape(-1).contiguous().numpy().tobytes()
        else:
            raw = pcm.transpose(0, 1).contiguous().reshape(-1).numpy().tobytes()
        with wave.open(path, "wb") as wf:
            wf.setnchannels(ch)
            wf.setsampwidth(2)
            wf.setframerate(sr)
            wf.writeframes(raw)
        return True
    except Exception as e:
        log.warning("[LazyH3] 临时 wav 失败: %s", e)
        return False


def _save_segment_video(
    folder: str,
    seg_idx: int,
    frames: torch.Tensor,
    audio: dict | None,
    fps: float,
    filename: str | None = None,
) -> str | None:
    """
    最终段 → 完整 mp4（画面+音频）。
    默认文件名：1.mp4；可传 filename=1_超分.mp4 / 1_脸修.mp4 / 1_补帧.mp4
    """
    if frames is None or not isinstance(frames, torch.Tensor) or frames.numel() == 0:
        return None
    ffmpeg = _find_ffmpeg()
    if not ffmpeg:
        log.warning(
            "[LazyH3] 未找到 ffmpeg，无法保存完整视频。"
            "请 pip install imageio-ffmpeg 或安装系统 ffmpeg。"
        )
        return None
    try:
        import numpy as np
    except ImportError:
        log.warning("[LazyH3] 无 numpy，跳过视频保存")
        return None

    t = frames.detach().float().cpu().contiguous()
    if t.ndim != 4:
        log.warning("[LazyH3] 段#%d 画面维度异常 %s", seg_idx, tuple(t.shape))
        return None
    n, h, w, c = int(t.shape[0]), int(t.shape[1]), int(t.shape[2]), int(t.shape[3])
    if c > 3:
        t = t[..., :3]
        c = 3
    elif c < 3:
        t = t.repeat(1, 1, 1, 3)[..., :3]
        c = 3
    pad_h = h % 2
    pad_w = w % 2
    if pad_h or pad_w:
        t = torch.nn.functional.pad(t.permute(0, 3, 1, 2), (0, pad_w, 0, pad_h)).permute(0, 2, 3, 1)
        h, w = int(t.shape[1]), int(t.shape[2])
    arr = (t.clamp(0, 1).numpy() * 255.0).astype("uint8")
    del t
    fps = max(1.0, float(fps or 24.0))
    fname = (filename or "").strip() or _seg_name_raw(seg_idx)
    path = os.path.join(folder, fname)

    tmp_wav = None
    try:
        has_audio = False
        if isinstance(audio, dict) and "waveform" in audio:
            fd, tmp_wav = tempfile.mkstemp(suffix=".wav")
            os.close(fd)
            has_audio = _write_temp_wav(audio, tmp_wav)
            if not has_audio and tmp_wav:
                try:
                    os.remove(tmp_wav)
                except Exception:
                    pass
                tmp_wav = None

        cmd = [
            ffmpeg, "-y", "-v", "error",
            "-f", "rawvideo", "-pix_fmt", "rgb24",
            "-s", f"{w}x{h}",
            "-r", f"{fps:g}",
            "-i", "pipe:0",
        ]
        if has_audio and tmp_wav:
            cmd += ["-i", tmp_wav]
        cmd += [
            "-map", "0:v:0",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "fast",
            "-frames:v", str(n),
        ]
        if has_audio and tmp_wav:
            # -shortest：容器时长跟画面，避免 AAC 填充把时长撑长、拼片时被补帧
            cmd += [
                "-map", "1:a:0",
                "-c:a", "aac", "-b:a", "192k",
                "-shortest",
            ]
        cmd.append(path)

        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        try:
            # 分块写入管道，降低峰值
            chunk = 32
            assert proc.stdin is not None
            for i0 in range(0, n, chunk):
                proc.stdin.write(arr[i0 : i0 + chunk].tobytes())
            proc.stdin.close()
            err = proc.stderr.read() if proc.stderr else b""
            proc.wait(timeout=max(120, n * 2))
        except subprocess.TimeoutExpired:
            proc.kill()
            log.warning("[LazyH3] 段#%d ffmpeg 超时", seg_idx)
            return None
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
            raise
        if proc.returncode != 0:
            msg = (err or b"").decode("utf-8", errors="replace")[:500]
            log.warning("[LazyH3] 段#%d ffmpeg 失败: %s", seg_idx, msg)
            return None
        if not os.path.isfile(path) or os.path.getsize(path) < 64:
            log.warning("[LazyH3] 段#%d mp4 未生成或过小", seg_idx)
            return None
        log.info(
            "[LazyH3] 已存视频: %s (%d帧 %dx%d @%.3ffps%s)",
            path, n, w, h, fps, " +音" if has_audio else "",
        )
        return path
    except Exception as e:
        log.warning("[LazyH3] 段#%d 视频保存失败: %s", seg_idx, e)
        return None
    finally:
        try:
            del arr
        except Exception:
            pass
        if tmp_wav:
            try:
                os.remove(tmp_wav)
            except Exception:
                pass


def _resolve_final_audio(drive, audios, n_frames: int, fps: float):
    """
    成片声音：有驱动音 → 驱动原音；否则主轨视频原声 / 模型音。
    返回 (audio_or_None, 来源说明)
    """
    n = max(1, int(n_frames or 1))
    fps = max(1.0, float(fps or H3_FPS_DEFAULT))
    if _audio_has_sound(drive):
        try:
            return _fit_audio_len(_clone_audio(drive), n, fps), "驱动原音"
        except Exception as e:
            log.warning("[LazyH3] 驱动原音定长失败: %s", e)
    cat = None
    try:
        if audios:
            cat = cat_audio(list(audios))
    except Exception as e:
        log.warning("[LazyH3] 段音频拼接失败: %s", e)
        cat = None
    if _audio_has_sound(cat):
        try:
            return _fit_audio_len(cat, n, fps), "主轨/模型音"
        except Exception as e:
            log.warning("[LazyH3] 段音频定长失败: %s", e)
    return None, ""


def _load_mp4_frames(path: str) -> torch.Tensor | None:
    """读回各段小视频，交给保存视频节点编码。不另写成本地成片。"""
    if not path or not os.path.isfile(path):
        return None
    try:
        import av
        import numpy as np
    except Exception as e:
        log.warning("[LazyH3] 读片段需要 av/numpy: %s", e)
        return None
    frames = []
    try:
        with av.open(path) as container:
            stream = next((s for s in container.streams if s.type == "video"), None)
            if stream is None:
                return None
            for frame in container.decode(stream):
                frames.append(frame.to_ndarray(format="rgb24"))
    except Exception as e:
        log.warning("[LazyH3] 读取片段失败 %s: %s", os.path.basename(path), e)
        return None
    if not frames:
        return None
    arr = np.stack(frames, axis=0)
    return torch.from_numpy(arr).float().div_(255.0)


def _save_segment_bundle(
    folder: str,
    seg_idx: int,
    latent,
    frames,
    audio,
    fps: float = 24.0,
    meta_line: str = "",
    filename: str | None = None,
) -> list:
    """保存一段：mp4 + latent + 简讯。"""
    paths = []
    p = _save_segment_video(folder, seg_idx, frames, audio, fps, filename=filename)
    if p:
        paths.append(p)
    p = _save_segment_latent(folder, seg_idx, latent)
    if p:
        paths.append(p)
    if meta_line:
        try:
            txt = os.path.join(folder, f"{int(seg_idx)}.txt")
            with open(txt, "w", encoding="utf-8") as f:
                f.write(meta_line.rstrip() + "\n")
            paths.append(txt)
        except Exception:
            pass
    return paths


def _h3_image_to_video_cond(clip, vae, first, last, prompt, width, height, length):
    """调用原生 MiniMaxH3ImageToVideo → (positive, latent)。"""
    node = resolve_h3_node("MiniMaxH3ImageToVideo")
    if node is None:
        raise RuntimeError(
            "未找到原生节点 MiniMaxH3ImageToVideo。请升级 ComfyUI≥0.30 并安装 MiniMax H3 支持。"
        )
    kwargs = {
        "clip": clip,
        "vae": vae,
        "prompt": prompt or "",
        "width": int(width),
        "height": int(height),
        "length": int(length),
        "first_frame": first,
        "last_frame": last,
    }
    out = call_node_function(node, **kwargs)
    args = _as_output_list(out)
    if len(args) < 2:
        raise RuntimeError(f"MiniMaxH3ImageToVideo 返回项不足: {type(out)} len={len(args)}")
    return args[0], _as_latent_dict(args[1])


def _count_multi_refs(obj) -> int:
    if obj is None:
        return 0
    if isinstance(obj, dict):
        return sum(1 for v in obj.values() if v is not None)
    if isinstance(obj, torch.Tensor) and tensor_has_image(obj):
        return int(obj.shape[0]) if obj.ndim == 4 else 1
    return 0


def _merge_h3_ref_audios(slot_audios, drive_vocals):
    """参考音频在前，驱动人声只补空槽，最多 3 条。"""
    out = {}

    def _push(src):
        if not isinstance(src, dict):
            return
        for v in src.values():
            if len(out) >= 3:
                return
            if not isinstance(v, dict) or v.get("waveform") is None:
                continue
            out[f"ref_audio_{len(out)}"] = v

    _push(slot_audios)
    _push(drive_vocals)
    return out or None


def _ensure_h3_ref_prompt_tags(prompt: str, n_img: int, n_vid: int, n_aud: int) -> str:
    """
    官方要求提示词用 <Picture i>/<Video k>/<Audio j> 引用参考。

    关键：
    - 1 张图：绑定「唯一主角」身份
    - 多张图：默认「每张图 = 不同角色」，禁止再写成「所有图是同一人」
      （否则多人物会互相抵消，看起来只像其中一个或都不像）
    """
    p = (prompt or "").strip()
    has_pic = "<Picture" in p or "<picture" in p
    has_vid = "<Video" in p or "<video" in p
    has_aud = "<Audio" in p or "<audio" in p

    # 用户是否已自己写了按图分角色
    user_assigned = bool(
        re.search(r"<Picture\s*\d+\s*>", p, flags=re.I)
        and (
            "character" in p.lower()
            or "subject" in p.lower()
            or "角色" in p
            or "人物" in p
            or "同一人" in p
            or "same person" in p.lower()
            or "identity" in p.lower()
        )
    )

    tag_bits = []
    if n_img > 0 and not has_pic:
        tag_bits.append(" ".join(f"<Picture {i + 1}>" for i in range(n_img)))
    if n_vid > 0 and not has_vid:
        tag_bits.append(" ".join(f"<Video {i + 1}>" for i in range(n_vid)))
    if n_aud > 0 and not has_aud:
        tag_bits.append(" ".join(f"<Audio {i + 1}>" for i in range(n_aud)))

    identity_lines = []
    if n_img == 1 and not user_assigned:
        identity_lines.append(
            "The only main character MUST keep the exact same identity, face, hairstyle, "
            "skin, age and clothing style as <Picture 1>. Do NOT invent a different person."
        )
        identity_lines.append(
            "唯一主角必须与 <Picture 1> 为同一人：脸型、五官、发型、肤色、年龄、服装风格完全一致，禁止换成其他人。"
        )
    elif n_img > 1 and not user_assigned:
        # 多图 = 多角色（默认）。同一人多角度请在提示词里写「同一人」
        defs_en = []
        defs_zh = []
        for i in range(n_img):
            tag = f"<Picture {i + 1}>"
            letter = chr(ord("A") + i) if i < 26 else str(i + 1)
            defs_en.append(
                f"Character {letter} = the exact person in {tag} "
                f"(face, hair, skin, age, body, clothing style of that picture only)."
            )
            defs_zh.append(
                f"角色{letter} = 仅与 {tag} 同一人（脸型/五官/发型/肤色/年龄/体型/服装只跟这张图）。"
            )
        identity_lines.append("Subject definitions (do not merge faces across pictures):")
        identity_lines.extend(defs_en)
        identity_lines.append(
            "All listed characters should appear in the shot when the scene needs them. "
            "Never blend two pictures into one face. Never replace any character with a random stranger."
        )
        identity_lines.append("角色定义（禁止把多张参考图融成同一张脸）：")
        identity_lines.extend(defs_zh)
        identity_lines.append(
            "场景需要谁就用对应角色；禁止把不同参考图融成一个人，禁止换成路人脸。"
        )
        # 若用户只写了场景没点名，补一句按顺序入画
        if not re.search(r"Picture\s*\d+", p, flags=re.I):
            order = "、".join(f"角色{chr(ord('A') + i)}" for i in range(min(n_img, 26)))
            identity_lines.append(
                f"若未特别指定站位：镜头中按 {order} 对应 <Picture 1>… 依次出场/同框。"
            )

    if n_vid > 0:
        vids = " ".join(f"<Video {i + 1}>" for i in range(n_vid))
        if "motion" not in p.lower() and "动作" not in p:
            identity_lines.append(
                f"Use {vids} as motion / camera / action reference only; character identity still follows the pictures."
            )
    if n_aud > 0:
        auds = " ".join(f"<Audio {i + 1}>" for i in range(n_aud))
        if "voice" not in p.lower() and "音色" not in p and "声音" not in p:
            identity_lines.append(f"Use {auds} as voice / speech / audio reference.")

    parts = []
    if tag_bits:
        parts.append(" ".join(tag_bits))
    parts.extend(identity_lines)
    if p:
        parts.append(p)
    elif not identity_lines:
        parts.append("Cinematic video, high quality, natural motion.")
    return "\n".join([x for x in parts if x]).strip()


def _h3_ref_to_video_cond(
    clip, vae, prompt, width, height, length,
    ref_images=None, ref_video=None, audio_vae=None,
    ref_image_size="max",
    ref_videos=None,
    ref_audios=None,
):
    """
    官方 MiniMaxH3ReferenceToVideo：
    ref_images / ref_videos / ref_audios 均为 dict（ref_image_0… / ref_video_0… / ref_audio_0…）
    ref_image_size 默认 max：更强身份保真（官方文档推荐）。
    """
    node = resolve_h3_node("MiniMaxH3ReferenceToVideo")
    if node is None:
        log.warning("[LazyH3] 无 MiniMaxH3ReferenceToVideo，回退 ImageToVideo")
        first = None
        if isinstance(ref_images, dict):
            for v in ref_images.values():
                if tensor_has_image(v):
                    first = v[0:1] if getattr(v, "ndim", 0) == 4 else v
                    break
        elif ref_images is not None and tensor_has_image(ref_images):
            first = ref_images[0:1] if getattr(ref_images, "ndim", 0) == 4 else ref_images
        elif ref_video is not None and tensor_has_image(ref_video):
            first = ref_video[0:1]
        return _h3_image_to_video_cond(clip, vae, first, None, prompt, width, height, length)

    if audio_vae is None:
        raise RuntimeError(
            "多参参考生需要连接「音频VAE」。请把 MiniMax H3 Audio VAE 接到逐段生成的音频VAE 输入。"
        )

    # 图 → 有序 dict（保留原分辨率，不在此预压生成尺寸）
    ref_map = {}
    if ref_images is not None:
        if isinstance(ref_images, dict):
            # 按数字后缀排序，保证 Picture 顺序稳定
            def _kord(k):
                try:
                    return int(str(k).rsplit("_", 1)[-1])
                except Exception:
                    return 0
            for i, (k, v) in enumerate(sorted(ref_images.items(), key=lambda kv: _kord(kv[0]))):
                if v is not None and tensor_has_image(v):
                    one = v if getattr(v, "ndim", 0) == 4 else v.unsqueeze(0)
                    ref_map[f"ref_image_{i}"] = one[0:1].contiguous()
        elif isinstance(ref_images, torch.Tensor) and tensor_has_image(ref_images):
            t = ref_images
            if t.ndim == 3:
                t = t.unsqueeze(0)
            n = min(9, int(t.shape[0]))
            for i in range(n):
                ref_map[f"ref_image_{i}"] = t[i : i + 1].contiguous()
        elif isinstance(ref_images, (list, tuple)):
            for i, v in enumerate(ref_images[:9]):
                if v is not None and tensor_has_image(v):
                    one = v if getattr(v, "ndim", 0) == 4 else v.unsqueeze(0)
                    ref_map[f"ref_image_{i}"] = one[0:1].contiguous()

    # 视频
    vid_map = {}
    if isinstance(ref_videos, dict):
        def _kord(k):
            try:
                return int(str(k).rsplit("_", 1)[-1])
            except Exception:
                return 0
        for i, (k, v) in enumerate(sorted(ref_videos.items(), key=lambda kv: _kord(kv[0]))):
            if v is not None and tensor_has_image(v):
                vid_map[f"ref_video_{i}"] = v
    elif ref_video is not None and tensor_has_image(ref_video):
        vid_map["ref_video_0"] = ref_video

    # 音频
    aud_map = {}
    if isinstance(ref_audios, dict):
        def _kord(k):
            try:
                return int(str(k).rsplit("_", 1)[-1])
            except Exception:
                return 0
        for i, (k, v) in enumerate(sorted(ref_audios.items(), key=lambda kv: _kord(kv[0]))):
            if v is not None and isinstance(v, dict) and v.get("waveform") is not None:
                aud_map[f"ref_audio_{i}"] = v

    n_img, n_vid, n_aud = len(ref_map), len(vid_map), len(aud_map)
    if n_img + n_vid + n_aud <= 0:
        raise RuntimeError(
            "多参参考生：参考为空。请在「多参图 / 参考视频 / 参考音频」添加内容。"
        )

    # 自动补官方标签 + 身份绑定
    final_prompt = _ensure_h3_ref_prompt_tags(prompt, n_img, n_vid, n_aud)
    size_mode = (ref_image_size or "max").strip().lower()
    if size_mode not in ("max", "match"):
        size_mode = "max"
    log.info(
        "[LazyH3] 参考生条件: 图=%d 视频=%d 音频=%d size=%s shapes=%s | prompt前120=%s",
        n_img,
        n_vid,
        n_aud,
        size_mode,
        [tuple(v.shape) for v in ref_map.values()],
        (final_prompt or "")[:120].replace("\n", " / "),
    )

    if n_img < 1 and n_vid + n_aud > 0:
        log.warning("[LazyH3] 当前无参考图，仅有视频/音频参考，人物外貌会弱很多。")
    if n_img >= 2:
        log.info(
            "[LazyH3] 多图参考=%d：默认按「每图一个角色」绑定；若同一人多角度请在提示词写「同一人/same person」。",
            n_img,
        )

    kwargs = {
        "clip": clip,
        "vae": vae,
        "audio_vae": audio_vae,
        "prompt": final_prompt,
        "width": int(width),
        "height": int(height),
        "length": int(length),
        "ref_image_size": size_mode,
        "ref_images": ref_map if ref_map else None,
        "ref_videos": vid_map if vid_map else None,
        "ref_video_audios": None,
        "ref_audios": aud_map if aud_map else None,
    }
    # 再保险：部分签名只吃展开键
    for k, v in list(ref_map.items()):
        kwargs.setdefault(k, v)
    for k, v in list(vid_map.items()):
        kwargs.setdefault(k, v)
    for k, v in list(aud_map.items()):
        kwargs.setdefault(k, v)

    out = call_node_function(node, **kwargs)
    args = _as_output_list(out)
    if len(args) < 2:
        raise RuntimeError(f"MiniMaxH3ReferenceToVideo 返回项不足: {type(out)} len={len(args)}")
    return args[0], _as_latent_dict(args[1])


class LazyH3SequentialGenerate:
    """
    按 H3 分镜逐段生成。分镜模型(fl2va)+多参模型(ref2va)。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "文本编码": ("CLIP", {
                    "tooltip": "H3 文本编码。CLIPLoader 选 type=minimax。",
                }),
                "视频VAE": ("VAE", {"tooltip": "H3 视频 VAE。"}),
                "种子": ("INT", {
                    "default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF,
                    "tooltip": "随机种子。",
                }),
                "步数": ("INT", {
                    "default": 20, "min": 1, "max": 100, "step": 1,
                    "tooltip": "采样步数。",
                }),
            },
            "optional": {
                "分镜模型": ("MODEL", {
                    "tooltip": "H3 分镜模型（fl2va）。与「模型」二选一。",
                }),
                "模型": ("MODEL", {
                    "tooltip": "兼容旧连线：等同分镜模型。",
                }),
                "多参模型": ("MODEL", {
                    "tooltip": "H3 多参/参考生模型（ref2va）。多参工作台使用。",
                }),
                "参考生模型": ("MODEL", {
                    "tooltip": "兼容旧名：等同多参模型。",
                }),
                "H3分镜数据": ("H3_GUIDE_DATA", {
                    "tooltip": "接 Lazy MinimaxH3 导演台。",
                }),
                "关键帧数据": ("GUIDE_DATA", {
                    "tooltip": "直连关键帧数据时自动转 H3 分镜。",
                }),
                "音频VAE": ("VAE", {"tooltip": "H3 音频 VAE。"}),
                # —— 以下 optional 顺序固定，名称与默认值一一对应 ——
                # 采样：res_multistep / simple / CFG1
                "采样器": (comfy.samplers.KSampler.SAMPLERS, {
                    "default": "res_multistep" if "res_multistep" in comfy.samplers.KSampler.SAMPLERS else "euler",
                    "tooltip": "采样器。标准/加速常用 res_multistep；lightx2v 也可用 er_sde。",
                }),
                "调度器": (comfy.samplers.KSampler.SCHEDULERS, {
                    "default": "simple",
                    "tooltip": "调度器。常用 simple。",
                }),
                "CFG": ("FLOAT", {
                    "default": 1.0, "min": 0.0, "max": 20.0, "step": 0.1,
                    "tooltip": "CFG。H3 常用 1。",
                }),
                "每段递增种子": ("BOOLEAN", {
                    "default": True, "tooltip": "每段种子 +1。",
                }),
                # 裁切（单位：帧）
                "前裁帧": ("INT", {
                    "default": 0, "min": 0, "max": 64, "step": 1,
                    "tooltip": "未开运动续接时，去掉片头里重复的帧。其余帧不裁。",
                }),
                "尾裁帧": ("INT", {
                    "default": 0, "min": 0, "max": 64, "step": 1,
                    "tooltip": "有尾帧时多生成一点，成片仍按时长截回。0=关。",
                }),
                # 段间运动续接（H3 Motion Context latent 钉住）
                "运动续接": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "下一段用上一段最后一帧当首帧。总时长不变。硬切会断开。",
                }),
                "续接长度": ("INT", {
                    "default": 22, "min": 5, "max": 56, "step": 1,
                    "tooltip": "续接用的帧数。有效 5、22、39、56。",
                }),
                # 每段自动落盘：output/{保存名称}/
                "自动保存": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "每段落盘并释内存。开超分/脸修/补帧时分别另存。",
                }),
                "保存名称": ("STRING", {
                    "default": "lazy_h3",
                    "tooltip": "output 下文件夹名。同名重跑会覆盖同序号段。",
                }),
                # SigmaShift：标准默认 开 / 视频12 / 音频3
                "启用调度偏移": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "挂 ModelSamplingAV（音画双 schedule）。建议开。",
                }),
                "视频偏移": ("FLOAT", {
                    "default": 12.0, "min": 0.01, "max": 100.0, "step": 0.01,
                    "tooltip": "视频 flow shift。默认 12。",
                }),
                "音频偏移": ("FLOAT", {
                    "default": 3.0, "min": 0.01, "max": 100.0, "step": 0.01,
                    "tooltip": "音频 flow shift。默认 3。",
                }),
                "参考图精度": (["max", "match"], {
                    "default": "max",
                    "tooltip": "max=人物更像；match=更快。",
                }),
                # 加速：默认关；开时前端把步数→8（不锁死）；音频偏移不自动改
                "加速模式": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "开：挂加速 LoRA。会把步数设为推荐值，仍可手改。",
                }),
                "加速LoRA": (_lora_combo_list(), {
                    "default": "none",
                    "tooltip": "加速用仅模型 LoRA（turbo/lightx2v）。none=自动匹配。",
                }),
                "加速LoRA强度": ("FLOAT", {
                    "default": 0.75,
                    "min": -99.0,
                    "max": 99.0,
                    "step": 0.01,
                    "tooltip": "加速 LoRA 强度。lightx2v 常用 0.75。",
                }),
                # 后处理接入：接 Lazy 超分+补帧 的配置包，逐段生成后处理
                "后处理": (LAZY_UPSCALE_CFG, {
                    "tooltip": "可选。接 Lazy 超分+补帧 的配置包，每段生成后自动超分/补帧。",
                }),
                "脸修": (LAZY_FACE_REFINE_CFG, {
                    "tooltip": "可选。接 Lazy 二采修脸 配置包。顺序：生成→超分→脸修→补帧。",
                }),
                "空间": (LAZY_H3_SPATIAL_CFG, {
                    "tooltip": "可选。接 Lazy 空间二采。",
                }),
            },
        }

    RETURN_TYPES = ("H3_VIDEO_CLIPS", "STRING")
    RETURN_NAMES = ("H3视频片段包", "运行信息")
    FUNCTION = "run"
    CATEGORY = "Lazy/H3"
    DESCRIPTION = "Lazy H3 逐段生成 · 分镜/多参 · 音画"

    def run(
        self,
        文本编码=None,
        视频VAE=None,
        种子=0,
        步数=20,
        分镜模型=None,
        模型=None,
        多参模型=None,
        参考生模型=None,
        H3分镜数据=None,
        关键帧数据=None,
        音频VAE=None,
        采样器="res_multistep",
        调度器="simple",
        CFG=1.0,
        每段递增种子=True,
        前裁帧=0,
        尾裁帧=0,
        运动续接=True,
        续接长度=22,
        自动保存=True,
        保存名称="lazy_h3",
        启用调度偏移=True,
        视频偏移=12.0,
        音频偏移=3.0,
        参考图精度="max",
        加速模式=False,
        加速LoRA="none",
        加速LoRA强度=0.75,
        后处理=None,
        脸修=None,
        空间=None,
        **kwargs,
    ):
        # 显式参数写入 kwargs，缺键/热重载也不会 KeyError
        _explicit = {
            "文本编码": 文本编码,
            "视频VAE": 视频VAE,
            "种子": 种子,
            "步数": 步数,
            "分镜模型": 分镜模型,
            "模型": 模型,
            "多参模型": 多参模型,
            "参考生模型": 参考生模型,
            "H3分镜数据": H3分镜数据,
            "关键帧数据": 关键帧数据,
            "音频VAE": 音频VAE,
            "采样器": 采样器,
            "调度器": 调度器,
            "CFG": CFG,
            "每段递增种子": 每段递增种子,
            "前裁帧": 前裁帧,
            "尾裁帧": 尾裁帧,
            "运动续接": 运动续接,
            "续接长度": 续接长度,
            "自动保存": 自动保存,
            "保存名称": 保存名称,
            "启用调度偏移": 启用调度偏移,
            "视频偏移": 视频偏移,
            "音频偏移": 音频偏移,
            "参考图精度": 参考图精度,
            "加速模式": 加速模式,
            "加速LoRA": 加速LoRA,
            "加速LoRA强度": 加速LoRA强度,
            "后处理": 后处理,
            "脸修": 脸修,
            "空间": 空间,
        }
        for _k, _v in _explicit.items():
            if _k not in kwargs or kwargs.get(_k) is None:
                kwargs[_k] = _v

        def g(*names, default=None):
            for name in names:
                if name in kwargs:
                    val = kwargs[name]
                    if val is not None:
                        return val
            return default

        log.info("[LazyH3] 逐段开始 前裁=%s 尾裁=%s 运续=%s/%s",
                 g("前裁帧", default=0), g("尾裁帧", default=0),
                 g("运动续接", default=True), g("续接长度", default=22))

        model = g("分镜模型", "模型", "model")
        clip = g("文本编码", "clip")
        video_vae = g("视频VAE", "vae", "video_vae")
        audio_vae = g("音频VAE", "audio_vae")
        model_ref = g("多参模型", "参考生模型", "参考模型", "model_ref") or model
        guide = g("H3分镜数据", "h3_guide", default=None)
        wan_guide = g("关键帧数据", "guide_data", default=None)
        try:
            seed = int(g("种子", "seed", default=0) or 0)
        except Exception:
            seed = 0
        try:
            steps = int(g("步数", "steps", default=20) or 20)
        except Exception:
            steps = 20
        sampler_name = g("采样器", "sampler_name", default="res_multistep")
        scheduler = g("调度器", "scheduler", default="simple")
        try:
            cfg = float(g("CFG", "cfg", default=1.0) if g("CFG", "cfg", default=None) is not None else 1.0)
        except Exception:
            cfg = 1.0
        seed_per = bool(g("每段递增种子", "seed_per_segment", default=True))
        # 正负提示词一律用导演台
        g_override = ""
        n_override = ""
        accel = bool(g("加速模式", "accel_mode", "use_accel", default=False))
        accel_lora = g("加速LoRA", "accel_lora", default="none")
        if accel_lora is None:
            accel_lora = "none"
        accel_lora = str(accel_lora).strip() or "none"
        try:
            _als = g("加速LoRA强度", "accel_lora_strength", default=None)
            accel_lora_s = float(_als) if _als is not None else 0.75
        except Exception:
            accel_lora_s = 0.75

        # —— 旧工作流控件错位纠错（名称/类型对不上时的脏值）——
        # 加速LoRA 误成数字（如 10=音频偏移）
        if accel_lora not in ("none", "None", ""):
            try:
                float(accel_lora)
                log.warning(
                    "[LazyH3] 加速LoRA 值异常「%s」（像是偏移数值），已忽略并改 none。请重选 LoRA。",
                    accel_lora,
                )
                accel_lora = "none"
            except Exception:
                pass
        # 超出强度范围视为控件错位
        if abs(accel_lora_s) > 99.0:
            log.warning(
                "[LazyH3] 加速LoRA强度=%.3f 异常（有效约 -99～99），已改 0.75。",
                accel_lora_s,
            )
            accel_lora_s = 0.75

        if accel and str(accel_lora) in ("none", "None", ""):
            candidates = [x for x in _lora_combo_list() if x not in ("none", "None", "")]
            auto = next(
                (
                    x
                    for x in candidates
                    if any(k in x.lower() for k in ("turbo", "4step", "lightx2v", "lightx"))
                ),
                None,
            )
            if auto:
                accel_lora = auto
                log.info("[LazyH3] 加速LoRA=none，自动选用: %s", accel_lora)
            else:
                log.warning(
                    "[LazyH3] 加速已开但未找到 turbo/lightx2v LoRA。"
                    "请放到 models/loras 并在「加速LoRA」选择。"
                )

        lora_kind = _lora_kind(str(accel_lora)) if accel else "unknown"
        if accel:
            if steps < 4:
                log.warning("[LazyH3] 加速步数=%s 过低，音质可能差（建议 6～12）。", steps)
            log.info(
                "[LazyH3] 加速：steps=%s sampler=%s sched=%s lora=%s@%.2f kind=%s",
                steps, sampler_name, scheduler, accel_lora, accel_lora_s, lora_kind,
            )

        if model is None:
            raise ValueError("请连接分镜模型。")

        # 直连 GUIDE 时自动适配（宽高帧率用 GUIDE 自身）
        if (not guide or not guide.get("segments")) and isinstance(wan_guide, dict):
            from .lazy_h3_director import wan_guide_to_h3
            try:
                head_crop = int(g("前裁帧", "overlap_frames", "prefix_crop_frames", default=0) or 0)
            except Exception:
                head_crop = 0
            guide = wan_guide_to_h3(
                wan_guide,
                width=0,
                height=0,
                fps=0,
                overlap=max(0, head_crop),
                global_prompt=(wan_guide.get("global_prompt") or "") if isinstance(wan_guide, dict) else "",
                negative_prompt=(wan_guide.get("negative_prompt") or "") if isinstance(wan_guide, dict) else "",
            )
            log.info("[LazyH3] 已从关键帧数据自动转换分镜")

        if not guide or not guide.get("segments"):
            raise ValueError("分镜为空：请连接 Lazy MinimaxH3 导演台或关键帧数据。")

        # 分辨率/帧率一律导演台
        width = int(guide.get("width", 1344))
        height = int(guide.get("height", 768))
        fps = float(guide.get("frame_rate", H3_FPS_DEFAULT) or H3_FPS_DEFAULT)

        # 驱动音：优先用时间线最新裁切块重新对齐（避免导演台缓存仍是整文件开头）
        guide = dict(guide)
        drive_pieces = guide.get("drive_audio_pieces")
        tl_raw = guide.get("timeline_data") or ""
        try:
            from .lazy_h3_director import load_h3_drive_audio, _build_timeline_drive_audio

            if tl_raw:
                _v, aligned, pieces2 = load_h3_drive_audio(tl_raw, fps=fps)
                if aligned is not None:
                    guide["drive_audio_original"] = aligned
                if pieces2:
                    drive_pieces = pieces2
                    guide["drive_audio_pieces"] = pieces2
            elif isinstance(drive_pieces, list) and drive_pieces:
                aligned = _build_timeline_drive_audio(drive_pieces, fps=fps)
                if aligned is not None:
                    guide["drive_audio_original"] = aligned
            if isinstance(drive_pieces, list) and drive_pieces:
                log.info(
                    "[LazyH3] 驱动裁切块 %d 个: %s",
                    len(drive_pieces),
                    [
                        f"start={p.get('start')} len={p.get('length')} trim={p.get('trimStart')}"
                        for p in drive_pieces[:4]
                    ],
                )
        except Exception as e:
            log.warning("[LazyH3] 驱动音重新对齐跳过: %s", e)
            drive_pieces = guide.get("drive_audio_pieces")
        try:
            # 前裁帧 = 续写片头去重（旧名 重叠帧数）
            head_crop = int(g("前裁帧", "overlap_frames", "prefix_crop_frames", default=0) or 0)
        except Exception:
            head_crop = 0
        head_crop = max(0, min(64, head_crop))
        try:
            # 尾裁帧（单位：帧；旧秒数接口不再用）
            tail_crop = int(g("尾裁帧", "trim_end_frames", "suffix_trim_frames", default=0) or 0)
        except Exception:
            tail_crop = 0
        tail_crop = max(0, min(64, tail_crop))
        # 兼容旧字段名：overlap 变量 = 前裁帧
        overlap = head_crop

        # 运动续接（H3 Motion Context）
        motion_continue = bool(g("运动续接", "motion_continue", "motion_context", default=True))
        mc_len_raw = g("续接长度", "context_length", "motion_context_length", default=22)
        try:
            mc_context_len = int(str(mc_len_raw).strip() or "22")
        except Exception:
            mc_context_len = 22
        # Motion Context 仅允许固定档；其它就近纠正
        _allowed_mc = [int(x) for x in _MC_CONTEXT_CHOICES]
        if mc_context_len not in _allowed_mc:
            prev = mc_context_len
            mc_context_len = min(_allowed_mc, key=lambda x: abs(x - prev))
            log.warning("[LazyH3] 续接长度=%s 无效 → %d", mc_len_raw, mc_context_len)
        if motion_continue:
            mc_node = resolve_h3_node("MiniMaxH3MotionContext")
            if mc_node is None:
                log.warning(
                    "[LazyH3] 运动续接已开，但未安装 ComfyUI-H3-Motion-Context，本轮按关闭处理。"
                )
                motion_continue = False
            else:
                log.info("[LazyH3] 运动续接：开，长度=%d 帧（硬切断开）", mc_context_len)

        # 落盘：有后处理时强制开（长视频释内存）；否则跟「自动保存」
        auto_save = bool(g("自动保存", "auto_save", "save_segments", default=True))
        save_name = g("保存名称", "save_name", "save_folder", default="lazy_h3")
        save_name = _safe_save_name(str(save_name if save_name is not None else "lazy_h3"))
        save_dir = None
        post_cfg_early = g("后处理", "post_process", "upscale_rife_cfg", default=None)
        disk_mode = bool(auto_save or (isinstance(post_cfg_early, dict) and post_cfg_early))
        if disk_mode:
            try:
                save_dir = _ensure_segment_save_dir(save_name)
                auto_save = True
                log.info("[LazyH3] 落盘模式：开 → %s（原片=N.mp4，开超分/脸修/补帧则分别另存）", save_dir)
            except Exception as e:
                log.warning("[LazyH3] 创建保存目录失败，落盘关闭: %s", e)
                auto_save = False
                disk_mode = False
                save_dir = None

        # 调度偏移 / 音视频 shift（按名称读；脏值纠错）
        apply_shift = bool(g("启用调度偏移", "apply_sigma_shift", default=True))
        try:
            shift_v = float(g("视频偏移", "shift_video", default=12.0))
        except Exception:
            shift_v = 12.0
        try:
            shift_a = float(g("音频偏移", "shift_audio", default=3.0))
        except Exception:
            shift_a = 3.0
        # 0 / 负数 ≈ 控件错位，恢复标准默认
        if shift_v < 0.5:
            log.warning("[LazyH3] 视频偏移=%.3f 无效 → 12", shift_v)
            shift_v = 12.0
        if shift_a < 0.5:
            log.warning("[LazyH3] 音频偏移=%.3f 无效 → 3", shift_a)
            shift_a = 3.0
        if accel and not apply_shift:
            log.warning("[LazyH3] 加速建议开启「启用调度偏移」，已强制打开。")
            apply_shift = True

        g_prompt = (guide.get("global_prompt") or "").strip()
        n_prompt = (guide.get("negative_prompt") or "").strip()
        resize_method = _normalize_resize_method(guide.get("resize_method") or "maintain aspect ratio")
        # 浅拷贝每段 dict，禁止就地改导演台缓存（第二次生成会丢主轨视频）
        segs = [dict(s) if isinstance(s, dict) else s for s in (guide.get("segments") or [])]
        guide["segments"] = segs
        ws = normalize_workspace_mode(guide.get("workspace_mode"))
        workspace_ref = ws == H3_MODE_REF
        if not workspace_ref and isinstance(guide, dict):
            guide = dict(guide)
            guide["multi_ref_images"] = None
            guide["multi_ref_count"] = 0
            guide["multi_ref_videos"] = None
            guide["multi_ref_audios"] = None
            guide["engine"] = "h3"
            guide["workspace_mode"] = H3_MODE_STORYBOARD
        elif workspace_ref:
            # 导演台缓存可能还是旧 JSON；逐段再读一次时间线参考音频
            try:
                from .lazy_h3_director import load_h3_multi_ref_audios
                loaded_aud = load_h3_multi_ref_audios(guide.get("timeline_data") or "")
                if loaded_aud:
                    guide["multi_ref_audios"] = loaded_aud
            except Exception as e:
                log.warning("[LazyH3] 逐段重读参考音频跳过: %s", e)

        ref_image_size = g("参考图精度", "ref_image_size", default="max") or "max"
        ref_image_size = str(ref_image_size).lower().strip()
        if ref_image_size not in ("max", "match"):
            log.warning("[LazyH3] 参考图精度「%s」无效 → max", ref_image_size)
            ref_image_size = "max"

        # 官方 turbo：UNet → LoRA → SigmaShift → Guider/Scheduler 同源
        model_fl = model
        model_rf = model_ref if model_ref is not None else model
        if accel and str(accel_lora) not in ("none", "None", ""):
            try:
                model_fl = _apply_model_lora(model, str(accel_lora), accel_lora_s)
                if model_ref is not None and model_ref is not model:
                    model_rf = _apply_model_lora(model_ref, str(accel_lora), accel_lora_s)
                else:
                    model_rf = model_fl
            except Exception as e:
                raise RuntimeError(f"加速 LoRA 加载失败: {e}") from e

        if apply_shift:
            model_fl = _apply_sigma_shift(model_fl, shift_v, shift_a)
            if model_ref is not None and model_ref is not model and model_rf is not model_fl:
                model_rf = _apply_sigma_shift(model_rf, shift_v, shift_a)
            else:
                model_rf = model_fl
        else:
            log.warning(
                "[LazyH3] 未启用调度偏移：无 ModelSamplingAV 时音画易不同步/声崩。"
            )

        # 加速：sigmas 与去噪同一模型（官方 BasicScheduler/BasicGuider 同源）
        model_fl_base = model_fl
        model_rf_base = model_rf

        if accel:
            if not _has_native_av_schedule(model_fl):
                raise RuntimeError(
                    "加速模式需要 MiniMaxH3SigmaShift（ModelSamplingAV）。"
                    "请升级 ComfyUI≥0.30，并保持调度偏移开启。"
                )
            log.info(
                "[LazyH3] 加速链就绪：LoRA→SigmaShift(v=%.2f,a=%.2f) av=%s",
                shift_v, shift_a, _has_native_av_schedule(model_fl),
            )

        # 多参必须用 ref2va；若误用 fl2va 占位，人物身份几乎锁不住
        if workspace_ref and model_rf is model_fl:
            log.warning(
                "[LazyH3] 多参模式当前多参模型与分镜模型相同！请加载 minimax_h3_ref2va_* 并接到「多参模型」。"
            )

        # 空间二采：不接则一采尺寸、模型和采样都与原来一致
        spatial_cfg = normalize_spatial_cfg(g("空间", "spatial", "spatial_cfg", default=None))
        sample_w, sample_h = int(width), int(height)
        if spatial_cfg:
            sample_w, sample_h = first_pass_size(width, height, spatial_cfg.get("放大倍数", 2.0))
            ensure_upscaler_file(spatial_cfg)
            if spatial_cfg.get("稀疏注意力", True):
                same_model = model_rf is model_fl
                model_fl = apply_sparse_attention(model_fl, spatial_cfg)
                model_rf = model_fl if same_model else apply_sparse_attention(model_rf, spatial_cfg)
            log.info(
                "[LazyH3] 已接空间二采：一采 %sx%s 成片 %sx%s 二采=%s步 重绘=%.2f 稀疏=%s",
                sample_w, sample_h, int(width), int(height),
                spatial_cfg.get("二采步数", 4),
                float(spatial_cfg.get("重绘幅度", 0.4)),
                "开" if spatial_cfg.get("稀疏注意力", True) else "关",
            )

        # 负向条件（CFG）
        negative_cond = _encode_clip_text(clip, n_prompt) if n_prompt else None

        clips_img = []
        clips_aud = []
        clip_files = []       # 成片用：补帧 > 脸修 > 超分 > 原片
        clip_files_raw = []   # 原片：N.mp4
        modes_out = []
        info_lines = []
        prev_frames = None
        prev_latent = None  # 上一段 sampler 输出，供运动续接
        prev_join_frame = None  # 上一段成片尾帧，接缝像素对齐
        prev_link = None
        prev_end_idx = -1
        seg_links = []

        # 后处理配置包（Lazy 超分+补帧）
        post_cfg = g("后处理", "post_process", "upscale_rife_cfg", default=None)
        if post_cfg is None:
            post_cfg = post_cfg_early
        if post_cfg is not None and not isinstance(post_cfg, dict):
            log.warning("[LazyH3] 后处理输入无效，已忽略")
            post_cfg = None
        if post_cfg:
            log.info(
                "[LazyH3] 已接后处理：超分=%s 补帧=%s",
                post_cfg.get("启用超分", True),
                post_cfg.get("启用补帧", True),
            )
        # 二采修脸配置包
        face_cfg = g("脸修", "face_refine", "face_refine_cfg", default=None)
        if face_cfg is not None and not isinstance(face_cfg, dict):
            log.warning("[LazyH3] 脸修输入无效，已忽略")
            face_cfg = None
        if face_cfg and bool(face_cfg.get("启用", True)):
            log.info("[LazyH3] 已接二采修脸：步数=%s 重绘=%.2f", face_cfg.get("步数", 8), float(face_cfg.get("重绘幅度", 0.4)))
            # 有脸修也强制落盘
            if not disk_mode:
                try:
                    save_dir = _ensure_segment_save_dir(save_name)
                    disk_mode = True
                    auto_save = True
                    log.info("[LazyH3] 脸修开启，已强制落盘 → %s", save_dir)
                except Exception as e:
                    log.warning("[LazyH3] 脸修强制落盘失败: %s", e)
        post_fps = None  # 后处理后的成片帧率

        for j, seg in enumerate(segs):
            motion_latent = None
            join_lock = False
            base_len = h3_snap_length(int(seg.get("length") or 73), fps, False)
            link = seg.get("link", "flf")
            if link not in ("flf", "cut"):
                link = "flf"
            from_cut = prev_link == "cut"
            prompt_local = (seg.get("prompt") or "").strip()
            parts = [p for p in (g_prompt, prompt_local) if p]
            prompt = " ".join(parts) or "cinematic video, high quality, natural motion"
            face_prompt = prompt  # 二采只用本段提示，不含续接指令
            img = seg.get("image")
            ref_vid = seg.get("ref_video")
            mode_req = (seg.get("mode") or "auto").lower()
            has_start = tensor_has_image(img)
            want_skip = bool(
                workspace_ref
                and (
                    seg.get("skip_first")
                    or str(seg.get("type") or "").lower() == "video"
                    or (
                        isinstance(seg.get("source_meta"), dict)
                        and (
                            seg["source_meta"].get("imageFile")
                            or seg["source_meta"].get("videoFile")
                            or seg["source_meta"].get("fileName")
                        )
                    )
                )
            )
            if want_skip:
                _reload_main_source_video(
                    seg, fps, guide.get("timeline_data") or "", j
                )
            skip_first = bool(want_skip and _source_video_ok(seg.get("source_video")))
            if want_skip and not skip_first:
                log.warning("[LazyH3] 段#%d 主轨视频无法恢复，回退一采", j + 1)

            end_img, end_idx = _find_end_image(segs, j, link, has_start)
            has_end = tensor_has_image(end_img)
            # 有尾帧时忽略多帧重叠
            eff_overlap = 0 if has_end else overlap
            has_ref = tensor_has_image(ref_vid) or (mode_req == "ref") or workspace_ref
            continue_ok = prev_frames is not None and not from_cut
            # 硬切后不注入运动上下文；仅当有上一段 latent
            will_mc = (
                motion_continue
                and prev_frames is not None
                and not from_cut
                and mc_context_len > 0
            )
            if skip_first:
                will_mc = False
            # 上一段已落到本段图 → 不要静态 I2V 重砸
            landed_here = has_start and continue_ok and (prev_end_idx == j)

            # 多参工作台：整片按参考生一次逻辑——每段仍生成，但统一走 ref 模型
            if workspace_ref:
                mode = "ref"
            elif mode_req == "auto":
                mode = infer_segment_mode(
                    has_start, has_end, has_ref and tensor_has_image(ref_vid),
                    link, from_cut, continue_ok,
                )
            else:
                mode = mode_req

            if not has_start and mode_req != "ref" and not workspace_ref:
                if continue_ok:
                    mode = "continue"
                elif has_end and link == "flf":
                    mode = "flf"
                else:
                    mode = "t2v"

            if has_start:
                if mode == "continue" and not continue_ok:
                    mode = "i2v"
                if mode == "t2v":
                    mode = "flf" if (has_end and link == "flf") else "i2v"
                if landed_here and mode in ("i2v", "flf", "auto"):
                    mode = "continue"
            else:
                if mode == "continue" and not continue_ok:
                    mode = "flf" if (has_end and link == "flf") else "t2v"

            # 成片时长 = 时间线帧数，不能拉长，否则音频驱动对不上。
            content_len = int(seg.get("content_len") or seg.get("length_raw") or base_len)
            content_len = max(5, content_len)
            gen_len = h3_snap_length(content_len, fps, False)
            prefix_crop = 0
            suffix_trim = 0
            first = None
            last = None
            pin_first = None
            pin_from = ""
            pin_at = 0
            mode_label = mode
            use_model = model_rf if (mode == "ref" or workspace_ref) else model_fl
            seg_drive_slice = None  # 本段原音切片（成片拼接用）

            if has_end and tail_crop > 0:
                extra = max(1, int(tail_crop))
                gen_len = h3_snap_length(content_len + extra, fps, False)
                suffix_trim = max(0, gen_len - content_len)

            if mode == "ref":
                mode_label = "参考R2V"
                use_model = model_rf
                first = None
                multi_refs = guide.get("multi_ref_images") if workspace_ref else None
                multi_vids = guide.get("multi_ref_videos") if workspace_ref else None
                multi_auds = guide.get("multi_ref_audios") if workspace_ref else None
                n_img = _count_multi_refs(multi_refs)
                n_vid = _count_multi_refs(multi_vids)
                n_aud = _count_multi_refs(multi_auds)
                # ① 多参图轨
                if n_img > 0:
                    first = multi_refs
                    mode_label = f"参考R2V×图{n_img}"
                # ② 主轨引导图
                if n_img <= 0 and workspace_ref:
                    ref_batch = []
                    for s2 in segs:
                        im2 = s2.get("image")
                        if tensor_has_image(im2):
                            t = im2[0:1] if getattr(im2, "ndim", 0) == 4 and im2.shape[0] > 1 else im2
                            ref_batch.append(t)
                    if ref_batch:
                        try:
                            first = torch.cat(
                                [x if x.ndim == 4 else x.unsqueeze(0) for x in ref_batch[:9]],
                                dim=0,
                            )
                            n_img = len(ref_batch)
                            mode_label = f"参考R2V×图{n_img}(主轨)"
                        except Exception:
                            first = None
                # ③ 本段首图
                if n_img <= 0 and has_start:
                    first = img
                    n_img = 1
                    mode_label = "参考R2V(单图)"
                if n_vid > 0:
                    mode_label += f"+视{n_vid}"
                if n_aud > 0:
                    mode_label += f"+音{n_aud}"
                if workspace_ref and n_img + n_vid + n_aud <= 0:
                    log.warning(
                        "[LazyH3] 段#%d 多参无任何参考，接近纯文生。请添加多参图/视频/音频。",
                        j + 1,
                    )
                    mode_label = "参考R2V(无参考≈文生)"
                # 首帧不进参考图。主轨有图用主轨；否则非硬切且有上一段，用上一段尾帧。
                if has_start:
                    pin_first = img
                    pin_from = "主轨"
                elif (not from_cut) and prev_frames is not None:
                    try:
                        pin_first = last_frame(prev_frames)
                        pin_from = "上一段尾帧"
                    except Exception as e:
                        log.warning("[LazyH3] 段#%d 上一段尾帧不可用: %s", j + 1, e)
                        pin_first = None
            elif mode == "continue" and continue_ok:
                # 上一段成片最后一帧 = 本段首帧，模型从这张图往下画。
                first = last_frame(prev_frames)
                if will_mc:
                    mode_label = "尾帧续"
                elif eff_overlap > 1:
                    n = min(eff_overlap, int(prev_frames.shape[0]))
                    prompt = prompt + f"\n[Continue seamlessly from previous motion, last {n} frames continuity.]"
                    gen_len = h3_snap_length(content_len + n + (suffix_trim if has_end else 0), fps, False)
                    prefix_crop = n
                    mode_label = f"续写去重{n}"
                else:
                    mode_label = "续写末帧" + ("(同图轻续)" if landed_here else "")
                if has_end and link == "flf":
                    last = end_img
                    mode_label += "+尾帧⇄"
            elif mode == "flf":
                first = img if has_start else None
                last = end_img
                if has_start and has_end:
                    mode_label = "首尾帧FLF"
                elif has_end and not has_start:
                    mode_label = "尾帧生⇄"
                else:
                    mode_label = "首尾帧FLF"
            elif mode == "i2v":
                first = img
                if has_end and link == "flf":
                    last = end_img
                    mode_label = "图生+尾帧⇄"
                else:
                    mode_label = "图生I2V"
            else:
                mode_label = "文生T2V"
                last = None

            # 运动续接只多生成一段上一段尾部，解码后去掉。成片仍是时间线帧数。
            mc_extra = 0
            if will_mc and not skip_first:
                mc_extra = int(mc_context_len)
                gen_len = h3_snap_length(content_len + mc_extra + (suffix_trim if has_end else 0), fps, False)
                if gen_len <= mc_extra + 8:
                    gen_len = h3_snap_length(mc_extra + content_len + 17, fps, False)
                mode_label += f"+运续{mc_extra}"
                log.info(
                    "[LazyH3] 段#%d 尾帧续接：上一段尾帧作首帧，生成=%d 成片=%d",
                    j + 1, gen_len, content_len,
                )

            # 参考生：禁止把多参图预压到生成分辨率（会毁掉人脸细节）
            # 分镜 i2v/flf：仍按生成尺寸缩放首尾帧
            first_src, last_src = first, last
            if first is not None and mode != "ref" and not isinstance(first, dict):
                try:
                    first = _resize_image(first, sample_w, sample_h, resize_method, 32)
                except Exception as e:
                    log.warning("[LazyH3] 首帧缩放失败: %s", e)
            if last is not None:
                last = _resize_image(last, sample_w, sample_h, resize_method, 32)

            # 驱动音频：一采切片做 Lock。成片混音在拼合时用整轨驱动原音。
            drive_full = guide.get("drive_audio_original")
            seg_auds = None
            if (
                (not skip_first)
                and (
                    (isinstance(drive_full, dict) and drive_full.get("waveform") is not None)
                    or (isinstance(drive_pieces, list) and drive_pieces)
                )
            ):
                try:
                    seg_auds, seg_drive_slice, _ = _prepare_segment_drive_audio(
                        drive_full, seg, fps, pieces=drive_pieces
                    )
                except Exception as e:
                    log.warning("[LazyH3] 段#%d 驱动音切片失败: %s", j + 1, e)
                    seg_auds, seg_drive_slice = None, None

            seg_seed = int(seed) + (j if seed_per else 0)
            skip_pack = None
            if skip_first:
                skip_pack = _frames_from_main_source_video(seg, fps, seg_drive_slice)
                if skip_pack is None:
                    log.warning("[LazyH3] 段#%d 主轨视频无效，回退一采", j + 1)

            if skip_pack is not None:
                frames, audio, content_len = skip_pack
                try:
                    seg["source_video"] = None
                    seg["source_audio"] = None
                except Exception:
                    pass
                mode = "skip"
                mode_label = "主轨视频跳过一采"
                use_model = model_rf
                positive = None
                latent = None
                prefix_crop = 0
                mc_trim = 0
                will_mc = False
                join_lock = False
                log.info(
                    "[LazyH3] (%d/%d) 模式=%s 帧=%d %sx%s seed=%s 跳过一采，原声=%s，后处理按开关执行",
                    j + 1,
                    len(segs),
                    mode_label,
                    content_len,
                    int(frames.shape[2]),
                    int(frames.shape[1]),
                    seg_seed,
                    "有" if _audio_has_sound(audio) else "无",
                )
            else:
                log.info(
                    "[LazyH3] (%d/%d) 模式=%s 生成=%d 成片=%d 运续=%s 首帧=%s seed=%s 模型=%s",
                    j + 1, len(segs), mode_label, gen_len, content_len,
                    (f"{mc_extra}" if will_mc else "关"),
                    (f"钉{pin_from}" if (mode == "ref" and pin_first is not None)
                     else ("上一段尾帧" if (will_mc or (prefix_crop > 0) or mode_label.startswith("续写")) else "无")),
                    seg_seed,
                    "多参" if use_model is model_rf and model_rf is not model_fl else "分镜",
                )

            join_lock = bool(will_mc)

            if skip_pack is None:
                try:
                    if mode == "ref":
                        # 多参多镜：每段只用「全局设定 + 本镜提示」，禁止拼接全部镜头
                        # （旧逻辑把所有段 prompt 拼进每一镜 → 每镜都重演全片，感觉一直重复）
                        if workspace_ref:
                            g_use = (g_prompt or "").strip()
                            # 全局里若已是多镜剧本/过长，拼进每一镜会再次导致“每镜演全片”
                            if len(segs) > 1 and g_use:
                                looks_multi = bool(
                                    re.search(
                                        r"(CUT\s*2|Shot\s*0*2|SH\s*0*2|镜\s*#?\s*2|镜头\s*2|第\s*2\s*镜)",
                                        g_use,
                                        flags=re.I,
                                    )
                                )
                                if looks_multi or len(g_use) > 800:
                                    log.warning(
                                        "[LazyH3] 全局提示词过长或含多镜头，分段时只保留前几行风格/身份，"
                                        "分镜请写在主轨各段，避免每镜重复全片。"
                                    )
                                    head = [ln.strip() for ln in g_use.splitlines() if ln.strip()][:4]
                                    g_use = "\n".join(head)
                            parts_p = []
                            if g_use:
                                parts_p.append(g_use)
                            if prompt_local:
                                parts_p.append(prompt_local)
                            elif not g_use:
                                parts_p.append(prompt)
                            ref_prompt = "\n".join([p for p in parts_p if p]).strip() or prompt
                            if len(segs) > 1:
                                ref_prompt = (
                                    f"[SHOT {j + 1}/{len(segs)} ONLY — generate only this shot. "
                                    f"Do NOT re-act previous or later shots. Do NOT summarize the whole film.]\n"
                                    f"{ref_prompt}"
                                )
                            log.info(
                                "[LazyH3] 段#%d 多参提示词: 全局用=%d字 本镜=%d字 合计=%d字（未拼其他镜头）",
                                j + 1,
                                len(g_use or ""),
                                len(prompt_local or ""),
                                len(ref_prompt or ""),
                            )
                        else:
                            ref_prompt = prompt
                        ref_imgs = first if first is not None else guide.get("multi_ref_images")
                        multi_vids = guide.get("multi_ref_videos") if workspace_ref else None
                        slot_auds = guide.get("multi_ref_audios") if workspace_ref else None
                        n_slot_aud = _count_multi_refs(slot_auds)
                        # 参考音频整段进模型；驱动人声只补空槽，不再覆盖参考音频
                        multi_auds = _merge_h3_ref_audios(slot_auds, seg_auds)
                        if seg_auds and n_slot_aud <= 0 and "<Audio" not in (ref_prompt or ""):
                            ref_prompt = (
                                f"{ref_prompt}\n"
                                f"<Audio 1> drives lip sync and speaking rhythm for this shot only. "
                                f"Match mouth movement to the audio."
                            ).strip()
                        log.info(
                            "[LazyH3] 段#%d 参考音频=%d 驱动人声=%s 送入=%d",
                            j + 1,
                            n_slot_aud,
                            "有" if seg_auds else "无",
                            _count_multi_refs(multi_auds),
                        )
                        if workspace_ref and (
                            _count_multi_refs(ref_imgs)
                            + _count_multi_refs(multi_vids)
                            + _count_multi_refs(multi_auds)
                            <= 0
                        ):
                            raise RuntimeError(
                                "多参模式需要参考：请在「多参图 / 参考视频 / 参考音频」添加内容后重跑。"
                            )
                        positive, latent = _h3_ref_to_video_cond(
                            clip, video_vae, ref_prompt, sample_w, sample_h, gen_len,
                            ref_images=ref_imgs,
                            ref_video=ref_vid,
                            audio_vae=audio_vae,
                            ref_image_size=ref_image_size,
                            ref_videos=multi_vids,
                            ref_audios=multi_auds,
                        )
                    else:
                        # 分镜：有驱动音时提示词补口型说明
                        i2v_prompt = prompt
                        if seg_drive_slice is not None and "lip" not in (prompt or "").lower():
                            i2v_prompt = (
                                f"{prompt}\n"
                                f"Match mouth movement and speaking rhythm to the driving audio."
                            ).strip()
                        positive, latent = _h3_image_to_video_cond(
                            clip, video_vae, first, last, i2v_prompt, sample_w, sample_h, gen_len,
                        )

                    # Audio Lock：分镜/多参共用，只用驱动音频本段切片
                    if seg_drive_slice is not None and audio_vae is not None:
                        try:
                            lock_src = seg_drive_slice
                            # 运续加长：Lock 音 = 片头重叠 + 本段
                            head_for_lock = int(mc_extra or 0) + int(prefix_crop or 0)
                            if head_for_lock > 0:
                                lock_src = _build_lock_audio_with_head(
                                    drive_full,
                                    lock_src,
                                    head_for_lock,
                                    fps,
                                    int(seg.get("timeline_start") or 0),
                                )
                            lock_src = _fit_audio_len(lock_src, int(gen_len), fps)
                            latent = _h3_audio_lock(latent, lock_src, audio_vae)
                            log.info(
                                "[LazyH3] 段#%d Audio Lock 已应用%s",
                                j + 1,
                                f"（续接片头{head_for_lock}帧）" if head_for_lock > 0 else "",
                            )
                        except Exception as e:
                            log.warning("[LazyH3] 段#%d Audio Lock 失败，继续无锁: %s", j + 1, e)
                except Exception as e:
                    raise RuntimeError(f"H3 段#{j+1} 条件构建失败（{mode_label}）: {e}") from e

                # 条件后 → 运动续接注入 → 采样
                mc_trim = 0
                if will_mc:
                    try:
                        saved_kfs = _snapshot_keyframes(positive) if mode != "ref" else []
                        positive, mc_trim = _apply_h3_motion_context(
                            positive,
                            video_vae,
                            latent,
                            None,
                            mc_context_len,
                            audio_context_length=0,
                            context_frames=prev_frames,
                        )
                        log.info(
                            "[LazyH3] 段#%d 运动续接已注入 成片尾部=%d trim=%d",
                            j + 1, int(prev_frames.shape[0]), mc_trim,
                        )
                        # 运续会清掉首尾锚点。只把片头之后的原关键帧接回去，不再重编码。
                        if mode != "ref":
                            positive = _restore_tail_keyframes(
                                positive, saved_kfs, int(mc_trim), latent,
                            )
                    except Exception as e:
                        log.warning("[LazyH3] 段#%d 运动续接失败，本段跳过: %s", j + 1, e)
                        mc_trim = 0

                # 多参：参考条件之后、采样之前钉首帧。运续片头会被裁掉，钉在留下的第一帧。
                if mode == "ref" and pin_first is not None:
                    pin_at = int(mc_trim) if int(mc_trim) > 0 else 0
                    try:
                        positive, latent, pinned = _pin_h3_ref_first(
                            positive, latent, pin_first, video_vae, pin_at,
                        )
                        if pinned:
                            log.info(
                                "[LazyH3] 段#%d 多参首帧已钉 像素帧=%d 来源=%s",
                                j + 1, pin_at, pin_from,
                            )
                        else:
                            log.warning("[LazyH3] 段#%d 多参首帧未写入", j + 1)
                    except Exception as e:
                        log.warning("[LazyH3] 段#%d 多参首帧失败: %s", j + 1, e)

                try:
                    # 加速：官方同源 — sigmas 与去噪用同一（LoRA+SigmaShift）模型
                    sigma_model = use_model if accel else None
                    latent = _run_sampler(
                        use_model, positive, latent, seg_seed, steps, sampler_name, scheduler, cfg,
                        negative=None if accel else negative_cond,
                        accel=accel,
                        model_for_sigmas=sigma_model,
                    )
                    # 续接下一段只用一采 latent；二采不回写运动
                    motion_latent = latent
                    if spatial_cfg:
                        def _build_hi(w, h, _mode=mode, _ref_prompt=ref_prompt if mode == "ref" else None,
                                      _imgs=ref_imgs if mode == "ref" else None,
                                      _vids=multi_vids if mode == "ref" else None,
                                      _auds=multi_auds if mode == "ref" else None,
                                      _i2v=i2v_prompt if mode != "ref" else None,
                                      _pin=pin_first if mode == "ref" else None,
                                      _pin_at=pin_at if mode == "ref" else 0):
                            if _mode == "ref":
                                pos, lat = _h3_ref_to_video_cond(
                                    clip, video_vae, _ref_prompt, w, h, gen_len,
                                    ref_images=_imgs,
                                    ref_video=ref_vid,
                                    audio_vae=audio_vae,
                                    ref_image_size=ref_image_size,
                                    ref_videos=_vids,
                                    ref_audios=_auds,
                                )
                                if _pin is not None:
                                    pos, lat, _ = _pin_h3_ref_first(pos, lat, _pin, video_vae, _pin_at)
                                return pos, lat
                            hi_first, hi_last = first_src, last_src
                            if hi_first is not None and not isinstance(hi_first, dict):
                                hi_first = _resize_image(hi_first, w, h, resize_method, 32)
                            if hi_last is not None:
                                hi_last = _resize_image(hi_last, w, h, resize_method, 32)
                            return _h3_image_to_video_cond(
                                clip, video_vae, hi_first, hi_last, _i2v, w, h, gen_len,
                            )

                        def _run_hi(m, pos, lat, hi_steps, hi_denoise):
                            return _run_sampler(
                                m, pos, lat, seg_seed, int(hi_steps), sampler_name, scheduler, cfg,
                                negative=None if accel else negative_cond,
                                accel=accel,
                                model_for_sigmas=(m if accel else None),
                                denoise=hi_denoise,
                            )

                        latent = second_pass_spatial(
                            motion_latent, spatial_cfg, use_model, _build_hi, _run_hi,
                        )
                    frames = _decode_video(video_vae, latent)
                    audio = _decode_audio(audio_vae, latent, turbo_repair=bool(accel))
                except Exception as e:
                    raise RuntimeError(
                        f"H3 段#{j+1} 采样/解码失败（加速={'开' if accel else '关'}）: {e}"
                    ) from e

                # 去掉上一段复制进来的片头，再把成片定回时间线帧数，音频时长不变。
                head_drop = mc_trim if (will_mc and mc_trim > 0) else 0
                if will_mc and mc_trim <= 0 and mc_extra > 0:
                    log.warning(
                        "[LazyH3] 段#%d 运续未注入，成片仍按时间线 %d 帧",
                        j + 1, content_len,
                    )
                if head_drop > 0:
                    try:
                        frames, audio = _trim_motion_head(frames, audio, head_drop, fps)
                    except Exception as e:
                        log.warning("[LazyH3] 段#%d 运续片头去掉失败，回退切片: %s", j + 1, e)
                        if isinstance(frames, torch.Tensor) and frames.shape[0] > head_drop:
                            frames = frames[head_drop:].contiguous()
                elif prefix_crop > 0 and isinstance(frames, torch.Tensor) and frames.shape[0] > prefix_crop:
                    try:
                        frames, audio = _trim_motion_head(frames, audio, prefix_crop, fps)
                    except Exception:
                        frames = frames[prefix_crop:].contiguous()
                if suffix_trim > 0 and isinstance(frames, torch.Tensor) and frames.shape[0] > content_len:
                    frames = frames[:content_len].contiguous()
                frames = _force_video_len(frames, content_len)
                if join_lock and prev_join_frame is not None:
                    frames = _lock_first_to_prev(frames, prev_join_frame)
                    log.info("[LazyH3] 段#%d 一采接缝已锁上一段尾帧", j + 1)

                # 有驱动切片：成片段音频用原切片（Lock 后模型音不可靠）；保证与画面同长
                if seg_drive_slice is not None:
                    audio = _fit_audio_len(seg_drive_slice, content_len, fps)
                else:
                    try:
                        audio = _fit_audio_len(audio, content_len, fps)
                    except Exception as e:
                        log.warning("[LazyH3] 音频定长跳过: %s", e)

            aud_peak = 0.0
            aud_n = 0
            try:
                aw = audio.get("waveform")
                if isinstance(aw, torch.Tensor) and aw.numel():
                    aud_peak = float(aw.abs().max())
                    aud_n = int(aw.shape[-1])
            except Exception:
                pass

            # 留下成片尾部，下一段用最后一帧当首帧。不留整段 latent，避免接下被裁掉的尾巴。
            try:
                n_ctx = max(1, int(mc_context_len) if motion_continue else 1)
                prev_frames = frames[-n_ctx:].detach().cpu().contiguous().clone()
            except Exception:
                prev_frames = frames
            prev_link = link
            prev_end_idx = end_idx if has_end else -1
            prev_latent = None

            out_frames = frames
            out_fps = float(fps)
            post_tag = ""
            face_tag = ""
            raw_path = None
            up_path = None
            face_path = None
            rife_path = None
            n_out = int(frames.shape[0]) if isinstance(frames, torch.Tensor) else 0

            # —— 落盘顺序：原片 → 超分 → 脸修 → 补帧（哪个开关开着存哪个）——
            if disk_mode and save_dir:
                try:
                    raw_path = _save_segment_video(
                        save_dir, j + 1, frames, audio, fps,
                        filename=_seg_name_raw(j + 1),
                    )
                    if raw_path:
                        clip_files_raw.append(raw_path)
                    if skip_pack is None:
                        _save_segment_latent(save_dir, j + 1, latent)
                except Exception as e:
                    log.warning("[LazyH3] 段#%d 原片落盘失败: %s", j + 1, e)

            work_frames = frames
            work_fps = float(fps)
            did_upscale = False
            did_rife = False
            do_up = bool(post_cfg) and bool(post_cfg.get("启用超分", post_cfg.get("enable_upscale", True)))
            do_rife = bool(post_cfg) and bool(post_cfg.get("启用补帧", post_cfg.get("enable_rife", True)))
            do_face = bool(face_cfg) and bool(face_cfg.get("启用", True))

            # ① 先超分（大图转 CPU，再修脸才看得见）
            if do_up:
                try:
                    log.info("[LazyH3] 段#%d 超分开始", j + 1)
                    up_frames, up_fps = apply_upscale_rife_cfg(
                        work_frames, work_fps, post_cfg, stage="upscale",
                    )
                    if isinstance(up_frames, torch.Tensor):
                        did_upscale = True
                        old = work_frames
                        work_frames = up_frames
                        work_fps = float(up_fps)
                        if disk_mode and old is frames:
                            frames = work_frames
                        if old is not work_frames:
                            _release_mem(old)
                        log.info(
                            "[LazyH3] 段#%d 超分完成 → %s",
                            j + 1,
                            tuple(work_frames.shape) if hasattr(work_frames, "shape") else type(work_frames),
                        )
                        if disk_mode and save_dir:
                            try:
                                up_path = _save_segment_video(
                                    save_dir, j + 1, work_frames, audio, work_fps,
                                    filename=_seg_name_upscale(j + 1),
                                )
                            except Exception as e:
                                log.warning("[LazyH3] 段#%d 超分落盘失败: %s", j + 1, e)
                except Exception as e:
                    log.warning("[LazyH3] 段#%d 超分失败，用当前片修脸: %s", j + 1, e)

            # ② 二采修脸（贴回超分后的画面；不走运动续接）
            if do_face:
                try:
                    log.info("[LazyH3] 段#%d 二采修脸开始（忽略续接）", j + 1)
                    refs = guide.get("multi_ref_images")
                    want_n = int(work_frames.shape[0]) if isinstance(work_frames, torch.Tensor) else 0
                    refined = apply_face_refine_cfg(
                        work_frames,
                        cfg=face_cfg,
                        model=use_model,
                        clip=clip,
                        video_vae=video_vae,
                        audio_vae=audio_vae,
                        audio=audio if isinstance(audio, dict) else seg_drive_slice,
                        prompt=face_prompt,
                        ref_images=refs,
                        seed=int(seg_seed),
                        fps=fps,
                    )
                    if isinstance(refined, torch.Tensor) and want_n > 0:
                        refined = _force_video_len(refined, want_n)
                    if refined is not work_frames:
                        face_tag = ", 脸修=是"
                        if disk_mode and save_dir and isinstance(refined, torch.Tensor):
                            try:
                                face_path = _save_segment_video(
                                    save_dir, j + 1, refined, audio, work_fps,
                                    filename=_seg_name_face(j + 1),
                                )
                            except Exception as e:
                                log.warning("[LazyH3] 段#%d 脸修落盘失败: %s", j + 1, e)
                        if disk_mode:
                            _release_mem(work_frames)
                            if frames is work_frames:
                                frames = refined
                        work_frames = refined
                    else:
                        face_tag = ", 脸修=跳过"
                    if isinstance(work_frames, torch.Tensor) and work_frames.device.type != "cpu":
                        work_frames = work_frames.detach().cpu().contiguous()
                        _release_mem()
                except Exception as e:
                    log.warning("[LazyH3] 段#%d 二采修脸失败，用当前片: %s", j + 1, e)
                    face_tag = ", 脸修失败"

            # ③ 补帧（修脸之后，避免插值糊脸再修）
            if do_rife:
                try:
                    log.info("[LazyH3] 段#%d 补帧开始", j + 1)
                    out_frames, out_fps = apply_upscale_rife_cfg(
                        work_frames, work_fps, post_cfg, stage="rife",
                    )
                    did_rife = isinstance(out_frames, torch.Tensor)
                    post_fps = float(out_fps)
                    n_out = int(out_frames.shape[0]) if isinstance(out_frames, torch.Tensor) else 0
                    post_tag = f", 后处理={n_out}帧@{out_fps:.3f}fps"
                    log.info(
                        "[LazyH3] 段#%d 补帧完成 → %s @%.3ffps",
                        j + 1,
                        tuple(out_frames.shape) if hasattr(out_frames, "shape") else type(out_frames),
                        out_fps,
                    )
                    if disk_mode and save_dir and did_rife:
                        try:
                            rife_path = _save_segment_video(
                                save_dir, j + 1, out_frames, audio, out_fps,
                                filename=_seg_name_rife(j + 1),
                            )
                        except Exception as e:
                            log.warning("[LazyH3] 段#%d 补帧落盘失败: %s", j + 1, e)
                except Exception as e:
                    log.warning("[LazyH3] 段#%d 补帧失败，用当前片: %s", j + 1, e)
                    out_frames = work_frames
                    out_fps = float(work_fps)
                    n_out = int(work_frames.shape[0]) if isinstance(work_frames, torch.Tensor) else 0
                    post_tag = ", 补帧失败"
            else:
                out_frames = work_frames
                out_fps = float(work_fps)
                n_out = int(work_frames.shape[0]) if isinstance(work_frames, torch.Tensor) else 0
                if did_upscale:
                    post_fps = float(work_fps)
                    post_tag = f", 后处理={n_out}帧@{work_fps:.3f}fps"

            # 成片接缝：第一帧锁成上一段成片尾帧（后处理之后再锁一次）
            if join_lock and prev_join_frame is not None and isinstance(out_frames, torch.Tensor):
                out_frames = _lock_first_to_prev(out_frames, prev_join_frame)
                n_out = int(out_frames.shape[0])
                if disk_mode and save_dir:
                    fn = os.path.basename(
                        rife_path or face_path or up_path or raw_path or _seg_name_raw(j + 1)
                    )
                    locked_path = _save_segment_video(
                        save_dir, j + 1, out_frames, audio, out_fps, filename=fn,
                    )
                    if locked_path:
                        if rife_path:
                            rife_path = locked_path
                        elif face_path:
                            face_path = locked_path
                        elif up_path:
                            up_path = locked_path
                        else:
                            raw_path = locked_path
                log.info("[LazyH3] 段#%d 成片接缝已锁上一段尾帧", j + 1)

            # 成片路径优先：补帧 > 脸修 > 超分 > 原片
            final_file = rife_path or face_path or up_path or raw_path
            if final_file:
                clip_files.append(final_file)

            # 内存模式才保留大图；落盘模式不往 clips 堆张量
            if disk_mode and save_dir:
                clips_img.append(None)
            else:
                clips_img.append(out_frames)
            clips_aud.append(audio)
            modes_out.append(mode)
            sec = float(n_out) / max(1e-6, float(out_fps))
            seg_info = (
                f"段{j+1}: {mode_label}, 出{n_out}帧/{sec:.2f}s, seed={seg_seed}, "
                f"音峰={aud_peak:.3f}/{aud_n}@{int(audio.get('sample_rate', 0) or 0)}Hz"
                + (f", 运续裁={mc_trim}" if mc_trim else "")
                + face_tag
                + post_tag
            )
            if raw_path:
                seg_info += f", 原片={os.path.basename(raw_path)}"
            if up_path:
                seg_info += f", 超分={os.path.basename(up_path)}"
            if face_path:
                seg_info += f", 脸修={os.path.basename(face_path)}"
            if rife_path:
                seg_info += f", 补帧={os.path.basename(rife_path)}"
            if disk_mode and save_dir:
                try:
                    with open(os.path.join(save_dir, f"{j+1}.txt"), "w", encoding="utf-8") as f:
                        f.write(seg_info.rstrip() + "\n")
                except Exception:
                    pass

            info_lines.append(seg_info)
            seg_links.append(link)

            # 下一段接缝用本段成片尾帧
            try:
                if isinstance(out_frames, torch.Tensor) and out_frames.ndim == 4 and int(out_frames.shape[0]) > 0:
                    prev_join_frame = out_frames[-1:].detach().cpu().contiguous().clone()
                elif isinstance(frames, torch.Tensor) and frames.ndim == 4 and int(frames.shape[0]) > 0:
                    prev_join_frame = frames[-1:].detach().cpu().contiguous().clone()
            except Exception:
                prev_join_frame = None

            # 及时释放本段大图（续接只留 prev_frames 末帧 / prev_latent）
            if disk_mode:
                if out_frames is not frames:
                    _release_mem(out_frames)
                _release_mem(frames)
                out_frames = None
                frames = None
            del positive
            if prev_latent is not latent:
                try:
                    del latent
                except Exception:
                    pass
            _release_mem()

        # 成片帧率/分辨率
        pack_fps = float(post_fps) if post_fps is not None else float(fps)
        pack_w, pack_h = width, height
        if clips_img and isinstance(clips_img[0], torch.Tensor) and clips_img[0].ndim == 4:
            pack_h = int(clips_img[0].shape[1])
            pack_w = int(clips_img[0].shape[2])

        pack = {
            "clips": clips_img,
            "clip_files": clip_files,
            "clip_files_raw": clip_files_raw,
            "audios": clips_aud,
            "fps": pack_fps,
            "width": pack_w,
            "height": pack_h,
            "modes": modes_out,
            "drive_audio_original": guide.get("drive_audio_original"),
            "overlap_frames": head_crop,
            "prefix_crop_frames": head_crop,
            "trim_end_frames": tail_crop,
            "motion_continue": motion_continue,
            "motion_context_length": mc_context_len if motion_continue else 0,
            "join_lock": bool(motion_continue),
            "links": seg_links,
            "auto_save": auto_save,
            "disk_mode": bool(disk_mode and save_dir),
            "save_dir": save_dir or "",
            "engine": "h3_ref" if workspace_ref else "h3",
            "workspace_mode": ws,
            "post_process": bool(post_cfg),
        }
        if disk_mode and clip_files:
            total = len(clip_files)
            total_frames_est = 0
        else:
            total = sum(int(c.shape[0]) for c in clips_img if isinstance(c, torch.Tensor))
            total_frames_est = total
        design_s = float(guide.get("total_seconds_raw") or 0)
        info = (
            f"Lazy H3 逐段完成：{len(clip_files) if clip_files else len(clips_img)} 段，工作台={ws}，"
            f"加速={'开(Guider/'+str(steps)+'步/LoRA='+str(accel_lora)+'@'+f'{accel_lora_s:.2f}'+')' if accel else '关'}，"
            + (
                f"落盘={save_dir}（原片=N.mp4 / 超分=N_超分.mp4 / 脸修=N_脸修.mp4 / 补帧=N_补帧.mp4）"
                if disk_mode and save_dir
                else f"合计约 {total_frames_est} 帧 / {total_frames_est/max(1e-6, pack_fps):.2f}s"
            )
            + (f"（设计约 {design_s:.2f}s）" if design_s > 0 else "")
            + f" ({pack_w}x{pack_h} @{pack_fps:g}fps)。成片按时长 尾帧当首帧 "
            f"运续={'开'+str(mc_context_len) if motion_continue else '关'} "
            f"后处理={'开' if post_cfg else '关'} "
            f"负向={'有' if n_prompt else '无'} shift={'开' if apply_shift else '关'}"
            f"(v{shift_v:g}/a{shift_a:g})。\n"
            + "\n".join(info_lines)
        )
        # 汇总说明写进保存目录
        if auto_save and save_dir:
            try:
                with open(os.path.join(save_dir, "run_info.txt"), "w", encoding="utf-8") as f:
                    f.write(info.rstrip() + "\n")
            except Exception as e:
                log.warning("[LazyH3] 写 run_info.txt 失败: %s", e)
        log.info("[LazyH3] %s", info.replace("\n", " | "))
        return (pack, info)


def _wrap_video_tensor(images: torch.Tensor, audio, fps: float):
    """各段接成一条，交给保存视频节点写出文件。"""
    from fractions import Fraction
    from comfy_api.latest import InputImpl, Types
    rate = Fraction(float(fps)).limit_denominator(10000)
    if rate <= 0:
        rate = Fraction(24, 1)
    aud = audio if _audio_has_sound(audio) else None
    return InputImpl.VideoFromComponents(
        Types.VideoComponents(
            images=images.clamp(0, 1).contiguous(),
            audio=aud,
            frame_rate=rate,
        )
    )


class LazyH3MergeClips:
    """将 H3 多段视频接成一条，交给保存视频节点写出。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "H3视频片段包": ("H3_VIDEO_CLIPS",),
            },
            "optional": {
                "重叠淡化帧": ("INT", {
                    "default": 0, "min": 0, "max": 32, "step": 1,
                    "tooltip": "段与段交接处交叉淡化的帧数。0 表示硬切。",
                }),
            },
        }

    RETURN_TYPES = ("VIDEO", "AUDIO", "INT", "FLOAT")
    RETURN_NAMES = ("合并视频", "合并音频", "总帧数", "帧率")
    FUNCTION = "merge"
    CATEGORY = "Lazy/H3"
    DESCRIPTION = "把各段按顺序接成一条。合并视频接到保存视频节点写出文件。"

    def merge(self, **kwargs):
        pack = kwargs.get("H3视频片段包") or kwargs.get("clips_pack")
        try:
            fade = int(kwargs["重叠淡化帧"] if "重叠淡化帧" in kwargs else kwargs.get("fade_frames", 0) or 0)
        except Exception:
            fade = 0
        if not pack:
            raise ValueError("H3 视频片段包为空")

        clips = list(pack.get("clips") or [])
        audios = list(pack.get("audios") or [])
        fps = float(pack.get("fps", H3_FPS_DEFAULT) or H3_FPS_DEFAULT)
        drive = pack.get("drive_audio_original")
        save_dir = pack.get("save_dir") or ""
        clip_files = list(pack.get("clip_files") or [])

        # 校正文件：补帧 > 脸修 > 超分 > 旧超分补帧 > 原片（绝不混用错名）
        if not clip_files and save_dir and os.path.isdir(save_dir):
            idx = 1
            while True:
                hit = _best_seg_video(save_dir, idx)
                if not hit:
                    break
                clip_files.append(hit)
                idx += 1
                if idx > 999:
                    break

        fixed_files = []
        for p in clip_files:
            if p and os.path.isfile(p) and os.path.getsize(p) > 64:
                ap = os.path.abspath(p)
                if ap not in fixed_files:
                    fixed_files.append(ap)
            elif p:
                log.warning("[LazyH3] 跳过缺失片段文件: %s", p)

        mem_clips = [c for c in clips if isinstance(c, torch.Tensor) and c.ndim == 4]
        if not mem_clips and fixed_files:
            log.info(
                "[LazyH3] 读回 %d 段小视频再交给保存视频节点\n  %s",
                len(fixed_files),
                "\n  ".join(os.path.basename(x) for x in fixed_files),
            )
            for fp in fixed_files:
                t = _load_mp4_frames(fp)
                if t is None or t.ndim != 4 or t.shape[0] < 1:
                    raise RuntimeError(f"无法读取片段: {fp}")
                mem_clips.append(t)
        if not mem_clips:
            raise ValueError("H3 视频片段包为空（无画面也无落盘片段）")

        ref_h = ref_w = None
        fixed = []
        for c in mem_clips:
            t = c
            if ref_h is None:
                ref_h, ref_w = int(t.shape[1]), int(t.shape[2])
            if t.shape[1] != ref_h or t.shape[2] != ref_w:
                t = torch.nn.functional.interpolate(
                    t.movedim(-1, 1), size=(ref_h, ref_w), mode="bilinear", align_corners=False
                ).movedim(1, -1)
            fixed.append(t.float().cpu())
        join_lock = bool(pack.get("join_lock", pack.get("motion_continue", True)))
        links = list(pack.get("links") or [])
        if join_lock and len(fixed) > 1:
            locked = [fixed[0]]
            for i in range(1, len(fixed)):
                prev_lk = links[i - 1] if i - 1 < len(links) else "flf"
                b = fixed[i]
                if prev_lk != "cut":
                    b = _lock_first_to_prev(b, locked[-1][-1:])
                locked.append(b)
            fixed = locked

        if fade <= 0 or len(fixed) == 1:
            mem_video = torch.cat(fixed, dim=0)
        else:
            out = [fixed[0]]
            for i in range(1, len(fixed)):
                a = out[-1]
                b = fixed[i]
                n = min(fade, a.shape[0] // 2, b.shape[0] // 2)
                if n <= 0:
                    out.append(b)
                    continue
                head = a[:-n]
                tail_a = a[-n:]
                head_b = b[:n]
                rest_b = b[n:]
                w = torch.linspace(0, 1, n, device=tail_a.device, dtype=tail_a.dtype).view(n, 1, 1, 1)
                blend = tail_a * (1 - w) + head_b * w
                out[-1] = head
                out.append(blend)
                out.append(rest_b)
            mem_video = torch.cat(out, dim=0)
        del fixed
        _release_mem()
        n_frames = int(mem_video.shape[0])

        n_seg = max(len(fixed_files), len(mem_clips), 1)
        while len(audios) < n_seg:
            audios.append(empty_audio(h3_frames_to_seconds(max(1, n_frames // max(1, n_seg)), fps)))
        try:
            audio, src_tag = _resolve_final_audio(drive, audios, n_frames, fps)
            if not _audio_has_sound(audio):
                audio = _fit_audio_len(cat_audio(audios), n_frames, fps)
                src_tag = src_tag or "段音频"
            log.info(
                "[LazyH3] 拼合音频=%s，定长 %d 帧 @%.0ffps",
                src_tag or "无", n_frames, fps,
            )
        except Exception as e:
            log.warning("[LazyH3] 拼合音频失败: %s", e)
            if _audio_has_sound(drive):
                try:
                    audio = _fit_audio_len(drive, n_frames, fps)
                    log.info("[LazyH3] 回退整轨驱动音定长")
                except Exception as e2:
                    log.warning("[LazyH3] 驱动原音也失败: %s", e2)
                    audio = empty_audio(h3_frames_to_seconds(n_frames, fps))
            else:
                audio = empty_audio(h3_frames_to_seconds(n_frames, fps))

        video_out = _wrap_video_tensor(mem_video, audio, fps)
        log.info("[LazyH3] 已接成一条视频（%d 帧），请接到保存视频节点", n_frames)
        return (
            video_out,
            audio,
            int(n_frames),
            float(fps),
        )
