"""
Lazy 空间二采：挂到 H3 逐段生成。
不接时逐段逻辑不变。接上后只做两件事：一采后 3D latent 放大再短二采，以及稀疏注意力。
"""
from __future__ import annotations

import logging
import os

import torch

log = logging.getLogger(__name__)

LAZY_H3_SPATIAL_CFG = "LAZY_H3_SPATIAL_CFG"
_UPSCALE_FOLDER = "latent_upscale_models"
_DEFAULT_MODEL = "minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors"


def _upscale_names():
    try:
        import folder_paths

        if _UPSCALE_FOLDER not in folder_paths.folder_names_and_paths:
            folder_paths.add_model_folder_path(
                _UPSCALE_FOLDER,
                os.path.join(folder_paths.models_dir, _UPSCALE_FOLDER),
            )
        names = list(folder_paths.get_filename_list(_UPSCALE_FOLDER) or [])
    except Exception:
        names = []
    picked = [
        n
        for n in names
        if "minimax_h3" in n.lower() and "3d" in n.lower() and n.lower().endswith((".safetensors", ".pth", ".pt"))
    ]
    if not picked:
        picked = [_DEFAULT_MODEL]
    return picked


def _as_bool(val, default=False):
    if isinstance(val, str):
        return val.strip().lower() in ("1", "true", "yes", "on", "是")
    if val is None:
        return default
    return bool(val)


def build_spatial_cfg(raw) -> dict:
    """控件 → 配置包。非法值收回推荐值。"""
    raw = raw or {}
    models = _upscale_names()
    model = str(raw.get("放大模型") or models[0])
    if model not in models:
        model = models[0]
    try:
        scale = float(raw.get("放大倍数", 2.0))
    except Exception:
        scale = 2.0
    scale = min(2.5, max(1.0, scale))
    try:
        steps = int(raw.get("二采步数", 4))
    except Exception:
        steps = 4
    steps = min(20, max(1, steps))
    try:
        denoise = float(raw.get("重绘幅度", 0.40))
    except Exception:
        denoise = 0.40
    # 1.0 会从全噪声重画，放大结果被清掉
    denoise = min(0.95, max(0.05, denoise))
    try:
        tau = float(raw.get("稀疏阈值", 1.3))
    except Exception:
        tau = 1.3
    tau = min(4.0, max(0.0, tau))
    try:
        start = float(raw.get("稀疏开始", 0.2))
    except Exception:
        start = 0.2
    try:
        end = float(raw.get("稀疏结束", 0.9))
    except Exception:
        end = 0.9
    start = min(0.99, max(0.0, start))
    end = min(1.0, max(0.0, end))
    if end <= start:
        end = min(1.0, start + 0.05)
    return {
        "__type__": LAZY_H3_SPATIAL_CFG,
        "启用": _as_bool(raw.get("启用", True), True),
        "放大倍数": scale,
        "二采步数": steps,
        "重绘幅度": denoise,
        "放大模型": model,
        "稀疏注意力": _as_bool(raw.get("稀疏注意力", True), True),
        "稀疏开始": start,
        "稀疏结束": end,
        "稀疏阈值": tau,
    }


def normalize_spatial_cfg(raw):
    if raw is None:
        return None
    if not isinstance(raw, dict):
        log.warning("[Lazy空间] 配置无效，已忽略")
        return None
    if raw.get("__type__") not in (None, LAZY_H3_SPATIAL_CFG):
        log.warning("[Lazy空间] 配置类型不符，已忽略")
        return None
    cfg = build_spatial_cfg(raw)
    if not cfg.get("启用", True):
        return None
    return cfg


def first_pass_size(width: int, height: int, scale: float):
    """一采像素尺寸。放大倍数≤1 时与成片相同。"""
    width = max(32, int(width))
    height = max(32, int(height))
    scale = float(scale or 1.0)
    if scale <= 1.001:
        return width, height

    def snap(px):
        return max(32, int(round(float(px) / scale / 32.0) * 32))

    return snap(width), snap(height)


def apply_sparse_attention(model, cfg: dict):
    """官方 BlockSparseAttention / sol-attn。开头和结尾保持稠密。"""
    if model is None or not cfg or not cfg.get("稀疏注意力", True):
        return model
    from comfy_extras.nodes_sparse_attention import apply_block_sparse_attention

    patched = apply_block_sparse_attention(
        model,
        tau=float(cfg.get("稀疏阈值", 1.3)),
        topk_ratio=0.0,
        vsa=False,
        start_percent=float(cfg.get("稀疏开始", 0.2)),
        end_percent=float(cfg.get("稀疏结束", 0.9)),
        min_tokens=12288,
        dense_blocks=set(),
        sink_conditioning="exact_kv_and_rows",
        extra_tokens=256,
        verbose=False,
    )
    log.info(
        "[Lazy空间] 稀疏注意力 sol-attn 阈值=%.2f 区间=%.2f–%.2f",
        float(cfg.get("稀疏阈值", 1.3)),
        float(cfg.get("稀疏开始", 0.2)),
        float(cfg.get("稀疏结束", 0.9)),
    )
    return patched


def _unwrap(out):
    if out is None:
        return None
    if hasattr(out, "result"):
        try:
            out = out.result
        except Exception:
            pass
    if isinstance(out, (tuple, list)):
        return out[0] if out else None
    return out


def _nested_parts(samples):
    if samples is None:
        return []
    if type(samples).__name__ == "NestedTensor" or (
        getattr(samples, "is_nested", False) and hasattr(samples, "unbind")
    ):
        try:
            return list(samples.unbind())
        except Exception:
            try:
                return list(samples.tensors)
            except Exception:
                return []
    if isinstance(samples, torch.Tensor):
        return [samples]
    return []


def _video_hw(samples):
    parts = _nested_parts(samples)
    if not parts:
        raise RuntimeError("空间二采：latent 里没有视频")
    video = parts[0]
    if not isinstance(video, torch.Tensor) or video.ndim < 4:
        raise RuntimeError(f"空间二采：视频 latent 形状异常 {getattr(video, 'shape', None)}")
    return int(video.shape[-2]), int(video.shape[-1]), video


def ensure_upscaler_file(cfg: dict):
    import folder_paths

    name = str(cfg.get("放大模型") or _DEFAULT_MODEL)
    if _UPSCALE_FOLDER not in folder_paths.folder_names_and_paths:
        folder_paths.add_model_folder_path(
            _UPSCALE_FOLDER,
            os.path.join(folder_paths.models_dir, _UPSCALE_FOLDER),
        )
    path = folder_paths.get_full_path(_UPSCALE_FOLDER, name)
    if not path or not os.path.isfile(path):
        raise RuntimeError(
            f"缺少 H3 3D latent 放大模型：{name}。"
            f"请放到 models/{_UPSCALE_FOLDER}/"
        )
    return name


def _upscale_av(latent: dict, model_name: str, scale: float) -> dict:
    import nodes

    cls = (getattr(nodes, "NODE_CLASS_MAPPINGS", {}) or {}).get("latent_minimaxH3_scale")
    if cls is None:
        raise RuntimeError("未找到 latent_minimaxH3_scale。请确认已安装 ComfyUI-Apt_Preset。")
    out = _unwrap(cls().execute(latent, model_name, float(scale)))
    if not isinstance(out, dict) or "samples" not in out:
        raise RuntimeError(f"latent 放大返回异常: {type(out)}")
    return out


def _fit_audio(audio: torch.Tensor, reference: torch.Tensor) -> torch.Tensor:
    if audio.shape == reference.shape:
        return audio.to(device=reference.device, dtype=reference.dtype)
    if audio.ndim != reference.ndim:
        raise RuntimeError(
            f"空间二采：音频 latent 维度对不上 {tuple(audio.shape)} / {tuple(reference.shape)}"
        )
    dims = [i for i in range(reference.ndim) if reference.shape[i] != audio.shape[i]]
    if len(dims) != 1 or dims[0] < 2:
        raise RuntimeError(
            f"空间二采：音频 latent 无法对齐 {tuple(audio.shape)} → {tuple(reference.shape)}"
        )
    dim = dims[0]
    cur = int(audio.shape[dim])
    need = int(reference.shape[dim])
    if cur > need:
        audio = audio.narrow(dim, 0, need)
    elif cur < need:
        pad = [0, 0] * audio.ndim
        # F.pad 从最后一维往前写
        pad_at = (audio.ndim - 1 - dim) * 2
        pad[pad_at + 1] = need - cur
        audio = torch.nn.functional.pad(audio, pad)
    return audio.to(device=reference.device, dtype=reference.dtype).contiguous()


def _pack_locked(video: torch.Tensor, audio: torch.Tensor, base: dict) -> dict:
    import comfy.nested_tensor as nt

    out = dict(base)
    out.pop("downscale_ratio_spacial", None)
    out.pop("downscale_ratio_temporal", None)
    out["samples"] = nt.NestedTensor((video, audio))
    out["noise_mask"] = nt.NestedTensor((
        torch.ones_like(video),
        torch.zeros_like(audio),
    ))
    return out


def second_pass_spatial(pass1_latent, cfg: dict, model, build_cond, run_sample):
    """
    放大视频 latent，按放大后的尺寸重做条件，短二采。
    音频沿用一采并锁住。不在这里做运动续接。
    build_cond(w, h) -> (positive, latent)
    run_sample(model, positive, latent, steps, denoise) -> latent
    """
    if not isinstance(pass1_latent, dict) or "samples" not in pass1_latent:
        raise RuntimeError("空间二采：一采 latent 无效")
    name = ensure_upscaler_file(cfg)
    scale = float(cfg.get("放大倍数", 2.0))
    up = _upscale_av(pass1_latent, name, scale)
    _, _, video = _video_hw(up["samples"])
    pixel_h = int(video.shape[-2]) * 16
    pixel_w = int(video.shape[-1]) * 16
    positive, fresh = build_cond(pixel_w, pixel_h)
    if not isinstance(fresh, dict) or "samples" not in fresh:
        raise RuntimeError("空间二采：高分条件没有 latent")
    _, _, fresh_video = _video_hw(fresh["samples"])
    if tuple(fresh_video.shape[-2:]) != tuple(video.shape[-2:]):
        raise RuntimeError(
            f"空间二采：放大后空间 {tuple(video.shape)} 与条件 {tuple(fresh_video.shape)} 不一致"
        )
    up_parts = _nested_parts(up["samples"])
    fresh_parts = _nested_parts(fresh["samples"])
    if len(up_parts) < 2 or len(fresh_parts) < 2:
        raise RuntimeError("空间二采：音画 latent 不完整，已停止以免声崩")
    audio = _fit_audio(up_parts[1], fresh_parts[1])
    audio = audio.to(device=video.device, dtype=video.dtype)
    merged = _pack_locked(video.contiguous(), audio.contiguous(), fresh)
    steps = int(cfg.get("二采步数", 4))
    denoise = float(cfg.get("重绘幅度", 0.40))
    log.info(
        "[Lazy空间] 二采 %sx%s 步数=%d 重绘=%.2f 模型=%s",
        pixel_w,
        pixel_h,
        steps,
        denoise,
        os.path.basename(name),
    )
    refined = run_sample(model, positive, merged, steps, denoise)
    try:
        import comfy.model_management

        comfy.model_management.soft_empty_cache()
    except Exception:
        pass
    return refined


class LazyH3Spatial:
    """配置包。接到 Lazy H3 逐段生成的「空间」。"""

    @classmethod
    def INPUT_TYPES(cls):
        models = _upscale_names()
        return {
            "required": {
                "启用": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "是否启用。",
                }),
                "放大倍数": ("FLOAT", {
                    "default": 2.0, "min": 1.0, "max": 2.5, "step": 0.1,
                    "tooltip": "放大倍数。",
                }),
                "二采步数": ("INT", {
                    "default": 4, "min": 1, "max": 20, "step": 1,
                    "tooltip": "采样步数。",
                }),
                "重绘幅度": ("FLOAT", {
                    "default": 0.40, "min": 0.05, "max": 0.95, "step": 0.05,
                    "tooltip": "重绘幅度。",
                }),
                "放大模型": (models, {
                    "default": models[0],
                    "tooltip": "放大模型。",
                }),
                "稀疏注意力": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "是否使用稀疏注意力。",
                }),
                "稀疏开始": ("FLOAT", {
                    "default": 0.20, "min": 0.0, "max": 1.0, "step": 0.01,
                    "tooltip": "开始位置。",
                }),
                "稀疏结束": ("FLOAT", {
                    "default": 0.90, "min": 0.0, "max": 1.0, "step": 0.01,
                    "tooltip": "结束位置。",
                }),
                "稀疏阈值": ("FLOAT", {
                    "default": 1.3, "min": 0.0, "max": 4.0, "step": 0.05,
                    "tooltip": "稀疏强度。",
                }),
            },
        }

    RETURN_TYPES = (LAZY_H3_SPATIAL_CFG,)
    RETURN_NAMES = ("配置包",)
    FUNCTION = "run"
    CATEGORY = "Lazy/H3"
    DESCRIPTION = "Lazy 空间二采"

    def run(self, **kwargs):
        return (build_spatial_cfg(kwargs),)


NODE_CLASS_MAPPINGS = {
    "LazyH3Spatial": LazyH3Spatial,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LazyH3Spatial": "Lazy 空间二采",
}
