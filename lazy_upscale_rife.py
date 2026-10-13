# -*- coding: utf-8 -*-
"""
Lazy 超分+补帧：封装 FlashVSR + RIFE。
流程：可选超分（整段）→ 可选补帧（按秒切段防 OOM，段间重叠 1 帧）→ 拼接输出。
可单独处理图像，也可只输出配置包供 H3 逐段生成接入。
"""
from __future__ import annotations

import gc
import logging

import torch

log = logging.getLogger("LazyUpscaleRife")

LAZY_UPSCALE_CFG = "LAZY_UPSCALE_CFG"

_RIFE_CKPTS = [
    "rife47.pth",
    "rife49.pth",
    "rife417.pth",
    "rife426.pth",
    "sudo_rife4_269.662_testV1_scale1.pth",
]
_RIFE_SCALE = [0.25, 0.5, 1.0, 2.0, 4.0]
_RIFE_DTYPE = ["float32", "float16", "bfloat16"]

_CFG_KEYS = (
    "启用超分",
    "启用补帧",
    "超分模型",
    "超分模式",
    "超分倍率",
    "超分分块VAE",
    "超分分块DiT",
    "超分解码前卸载DiT",
    "超分种子",
    "补帧模型",
    "补帧倍率",
    "补帧分段秒数",
    "补帧清缓存间隔",
    "补帧快速模式",
    "补帧集成",
    "补帧缩放因子",
    "补帧精度",
    "补帧编译加速",
    "补帧批大小",
)


def _soft_cache():
    gc.collect()
    try:
        import comfy.model_management as mm

        mm.soft_empty_cache()
    except Exception:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()


def _get_node_cls(class_type: str):
    """从已注册 NODE_CLASS_MAPPINGS 取类（执行时其它插件已加载）。"""
    try:
        import nodes as comfy_nodes

        m = getattr(comfy_nodes, "NODE_CLASS_MAPPINGS", None) or {}
        cls = m.get(class_type)
        if cls is not None:
            return cls
    except Exception:
        pass
    # 回退直接 import
    if class_type == "FlashVSRNode":
        try:
            from flashvsr_ultra_fast.nodes import FlashVSRNode

            return FlashVSRNode
        except Exception as e:
            raise RuntimeError(
                "未找到 FlashVSRNode。请安装 custom_nodes/flashvsr_ultra_fast。"
            ) from e
    if class_type == "RIFE VFI":
        try:
            from vfi_models.rife import RIFE_VFI

            return RIFE_VFI
        except Exception:
            try:
                import importlib
                import sys
                from pathlib import Path

                root = Path(__file__).resolve().parents[1] / "comfyui-frame-interpolation"
                if root.is_dir() and str(root) not in sys.path:
                    sys.path.insert(0, str(root))
                mod = importlib.import_module("vfi_models.rife")
                return mod.RIFE_VFI
            except Exception as e:
                raise RuntimeError(
                    "未找到 RIFE VFI。请安装 custom_nodes/comfyui-frame-interpolation。"
                ) from e
    raise RuntimeError(f"未找到节点类型：{class_type}")


def _run_flashvsr(frames, model, mode, scale, tiled_vae, tiled_dit, unload_dit, seed):
    cls = _get_node_cls("FlashVSRNode")
    node = cls()
    out = node.main(
        model=model,
        frames=frames,
        mode=mode,
        scale=int(scale),
        tiled_vae=bool(tiled_vae),
        tiled_dit=bool(tiled_dit),
        unload_dit=bool(unload_dit),
        seed=int(seed),
    )
    return out[0] if isinstance(out, (tuple, list)) else out


def _run_rife(
    frames,
    ckpt_name,
    clear_cache_after_n_frames,
    multiplier,
    fast_mode,
    ensemble,
    scale_factor,
    dtype,
    torch_compile,
    batch_size,
):
    cls = _get_node_cls("RIFE VFI")
    node = cls()
    out = node.vfi(
        ckpt_name=ckpt_name,
        frames=frames,
        clear_cache_after_n_frames=int(clear_cache_after_n_frames),
        multiplier=int(multiplier),
        fast_mode=bool(fast_mode),
        ensemble=bool(ensemble),
        scale_factor=float(scale_factor),
        dtype=str(dtype),
        torch_compile=bool(torch_compile),
        batch_size=int(batch_size),
    )
    return out[0] if isinstance(out, (tuple, list)) else out


def _chunk_rife(
    frames: torch.Tensor,
    fps: float,
    chunk_sec: float,
    **rife_kw,
) -> torch.Tensor:
    """按秒切段补帧；段间重叠 1 原帧，避免接缝丢中间帧。"""
    if frames is None or not isinstance(frames, torch.Tensor) or frames.ndim != 4:
        raise ValueError(f"补帧需要 IMAGE 批次 [N,H,W,C]，收到 {type(frames)}")
    n = int(frames.shape[0])
    if n < 2:
        return frames

    fps = max(1.0, float(fps or 24.0))
    chunk_sec = max(1.0, float(chunk_sec or 5.0))
    chunk_frames = max(2, int(round(fps * chunk_sec)))

    parts = []
    start = 0
    chunk_i = 0
    while start < n:
        end = min(n, start + chunk_frames)
        # 最后一段太短且不是首段：并入前段逻辑——直接处理剩余
        if end < n and (n - end) < 2:
            end = n
        chunk = frames[start:end].contiguous()
        chunk_i += 1
        log.info(
            "[Lazy超分+补帧] 补帧段 %d：原帧 %d–%d（共 %d 帧）",
            chunk_i,
            start,
            end - 1,
            int(chunk.shape[0]),
        )
        out = _run_rife(chunk, **rife_kw)
        if not isinstance(out, torch.Tensor):
            out = torch.as_tensor(out)
        if start > 0 and out.shape[0] > 0:
            # 丢掉与上一段末帧重复的第一帧
            out = out[1:]
        parts.append(out.contiguous())
        _soft_cache()
        if end >= n:
            break
        # 下一段从上一原段最后一帧开始（重叠 1）
        start = end - 1

    if not parts:
        return frames
    return torch.cat(parts, dim=0).contiguous()


def build_upscale_rife_cfg(kwargs) -> dict:
    """从节点参数打包配置（供 H3 逐段接入）。"""
    cfg = {"__type__": LAZY_UPSCALE_CFG}
    for k in _CFG_KEYS:
        if k in kwargs:
            cfg[k] = kwargs[k]
    # 兼容英文别名写入
    aliases = {
        "enable_upscale": "启用超分",
        "enable_rife": "启用补帧",
        "multiplier": "补帧倍率",
    }
    for src, dst in aliases.items():
        if src in kwargs and dst not in cfg:
            cfg[dst] = kwargs[src]
    return cfg


def _frames_to_cpu(frames):
    """超分大图转到 CPU，避免和后续 H3 修脸抢显存。"""
    if isinstance(frames, torch.Tensor) and frames.device.type != "cpu":
        frames = frames.detach().cpu().contiguous()
        _soft_cache()
    return frames


def process_upscale_rife(frames, fps_in, cfg_or_kwargs, stage="all"):
    """
    执行超分+补帧。
    stage: all=超分再补帧；upscale=只超分；rife=只补帧。
    返回 (frames_out, fps_out)。
    """
    if frames is None or not isinstance(frames, torch.Tensor):
        raise ValueError("请连接图像（视频帧）。")
    kw = dict(cfg_or_kwargs or {})
    try:
        fps_in = float(fps_in if fps_in is not None else kw.get("输入帧率", kw.get("fps", 24.0)))
    except Exception:
        fps_in = 24.0
    if fps_in != fps_in or fps_in <= 0:
        fps_in = 24.0
    fps_in = max(1.0, fps_in)

    do_up = bool(kw.get("启用超分", kw.get("enable_upscale", True))) and stage in ("all", "upscale")
    do_rife = bool(kw.get("启用补帧", kw.get("enable_rife", True))) and stage in ("all", "rife")

    out = frames
    fps_out = fps_in

    if do_up:
        log.info("[Lazy超分+补帧] 开始超分 scale=%s mode=%s", kw.get("超分倍率"), kw.get("超分模式"))
        out = _run_flashvsr(
            out,
            model=kw.get("超分模型", "FlashVSR-v1.1"),
            mode=kw.get("超分模式", "tiny"),
            scale=kw.get("超分倍率", 2),
            tiled_vae=kw.get("超分分块VAE", True),
            tiled_dit=kw.get("超分分块DiT", True),
            unload_dit=kw.get("超分解码前卸载DiT", False),
            seed=kw.get("超分种子", 0),
        )
        out = _frames_to_cpu(out)
        log.info("[Lazy超分+补帧] 超分完成 → %s（已转 CPU）", tuple(out.shape) if hasattr(out, "shape") else type(out))

    if do_rife:
        mult = int(kw.get("补帧倍率", kw.get("multiplier", 2)) or 2)
        chunk_sec = float(kw.get("补帧分段秒数", 5.0) or 5.0)
        log.info(
            "[Lazy超分+补帧] 开始补帧 multiplier=%d 分段=%.1fs 输入帧=%d",
            mult,
            chunk_sec,
            int(out.shape[0]),
        )
        out = _chunk_rife(
            out,
            fps=fps_in,
            chunk_sec=chunk_sec,
            ckpt_name=kw.get("补帧模型", "rife49.pth"),
            clear_cache_after_n_frames=kw.get("补帧清缓存间隔", 10),
            multiplier=mult,
            fast_mode=kw.get("补帧快速模式", True),
            ensemble=kw.get("补帧集成", True),
            scale_factor=kw.get("补帧缩放因子", 1.0),
            dtype=kw.get("补帧精度", "float32"),
            torch_compile=kw.get("补帧编译加速", False),
            batch_size=kw.get("补帧批大小", 1),
        )
        fps_out = fps_in * float(mult)
        out = _frames_to_cpu(out)
        log.info(
            "[Lazy超分+补帧] 补帧完成 → %s 输出帧率=%.3f",
            tuple(out.shape) if hasattr(out, "shape") else type(out),
            fps_out,
        )

    if not do_up and not do_rife:
        log.info("[Lazy超分+补帧] 本阶段关闭，原样输出 stage=%s", stage)

    return out, float(fps_out)


def apply_upscale_rife_cfg(frames, fps_in, cfg, stage="all"):
    """H3 逐段调用入口：配置包无效则原样返回。stage=all/upscale/rife。"""
    if not cfg or not isinstance(cfg, dict):
        return frames, float(fps_in)
    do_up = bool(cfg.get("启用超分", cfg.get("enable_upscale", True)))
    do_rife = bool(cfg.get("启用补帧", cfg.get("enable_rife", True)))
    if stage == "upscale":
        if not do_up:
            return frames, float(fps_in)
    elif stage == "rife":
        if not do_rife:
            return frames, float(fps_in)
    elif not do_up and not do_rife:
        return frames, float(fps_in)
    return process_upscale_rife(frames, fps_in, cfg, stage=stage)


class LazyUpscaleRife:
    """先超分（整段）再分段补帧；也可只输出配置包给 H3 逐段接入。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "输入帧率": ("FLOAT", {
                    "default": 24.0, "min": 1.0, "max": 120.0, "step": 0.01,
                    "tooltip": "输入视频帧率。补帧后输出帧率=输入×倍率。",
                }),
                "启用超分": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "开：先跑 FlashVSR 超分。",
                }),
                "启用补帧": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "开：超分后再 RIFE 补帧。",
                }),
                # —— FlashVSR ——
                "超分模型": (["FlashVSR", "FlashVSR-v1.1"], {
                    "default": "FlashVSR-v1.1",
                    "tooltip": "FlashVSR 模型版本。",
                }),
                "超分模式": (["tiny", "tiny-long", "full"], {
                    "default": "tiny",
                    "tooltip": "tiny 更快；tiny-long 更省显存；full 质量更高。",
                }),
                "超分倍率": ("INT", {
                    "default": 2, "min": 2, "max": 4, "step": 1,
                    "tooltip": "FlashVSR 超分倍率（整数 2–4）。",
                }),
                "超分分块VAE": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "FlashVSR tiled VAE，省显存。",
                }),
                "超分分块DiT": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "FlashVSR tiled DiT，省显存。",
                }),
                "超分解码前卸载DiT": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "解码前卸载 DiT，降峰值显存。",
                }),
                "超分种子": ("INT", {
                    "default": 0, "min": 0, "max": 0xFFFFFFFFFFFFF,
                    "tooltip": "FlashVSR 随机种子。",
                }),
                # —— RIFE ——
                "补帧模型": (_RIFE_CKPTS, {
                    "default": "rife49.pth",
                    "tooltip": "RIFE 权重。推荐 rife47 / rife49。",
                }),
                "补帧倍率": ("INT", {
                    "default": 2, "min": 1, "max": 16, "step": 1,
                    "tooltip": "帧率倍率。2=帧数约翻倍，输出帧率=输入×2。",
                }),
                "补帧分段秒数": ("FLOAT", {
                    "default": 5.0, "min": 1.0, "max": 60.0, "step": 0.5,
                    "tooltip": "补帧前按此时长切段，段间重叠 1 帧，防 OOM。",
                }),
                "补帧清缓存间隔": ("INT", {
                    "default": 10, "min": 1, "max": 1000, "step": 1,
                    "tooltip": "RIFE 每处理多少帧清一次缓存。",
                }),
                "补帧快速模式": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "RIFE fast_mode。",
                }),
                "补帧集成": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "RIFE ensemble。",
                }),
                "补帧缩放因子": (_RIFE_SCALE, {
                    "default": 1.0,
                    "tooltip": "RIFE scale_factor。",
                }),
                "补帧精度": (_RIFE_DTYPE, {
                    "default": "float32",
                    "tooltip": "RIFE 推理精度。",
                }),
                "补帧编译加速": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "RIFE torch.compile，首次较慢。",
                }),
                "补帧批大小": ("INT", {
                    "default": 1, "min": 1, "max": 64, "step": 1,
                    "tooltip": "RIFE 每步插值批大小，越大越快越吃显存。",
                }),
            },
            "optional": {
                "图像": ("IMAGE", {
                    "tooltip": "视频帧序列。仅接配置包到 H3 时可留空。",
                }),
            },
        }

    RETURN_TYPES = ("IMAGE", "FLOAT", LAZY_UPSCALE_CFG)
    RETURN_NAMES = ("图像", "输出帧率", "配置包")
    FUNCTION = "run"
    CATEGORY = "Lazy/视频"
    DESCRIPTION = "Lazy 超分+补帧 · 先 FlashVSR 再分段 RIFE · 可输出配置包"

    def run(self, **kwargs):
        cfg = build_upscale_rife_cfg(kwargs)
        frames = kwargs.get("图像")
        if frames is None:
            frames = kwargs.get("frames")
        try:
            fps_in = float(kwargs.get("输入帧率", kwargs.get("fps", 24.0)))
        except Exception:
            fps_in = 24.0
        if fps_in != fps_in or fps_in <= 0:
            fps_in = 24.0
        fps_in = max(1.0, fps_in)

        # 未接图像：只出配置包（占位图供类型兼容）
        if frames is None or not isinstance(frames, torch.Tensor):
            dummy = torch.zeros((1, 64, 64, 3), dtype=torch.float32)
            # 预估输出帧率（无实际处理）
            do_rife = bool(kwargs.get("启用补帧", True))
            mult = int(kwargs.get("补帧倍率", 2) or 2) if do_rife else 1
            fps_out = fps_in * float(max(1, mult))
            log.info("[Lazy超分+补帧] 未接图像，仅输出配置包")
            return (dummy, float(fps_out), cfg)

        out, fps_out = process_upscale_rife(frames, fps_in, kwargs)
        return (out, float(fps_out), cfg)


NODE_CLASS_MAPPINGS = {
    "LazyUpscaleRife": LazyUpscaleRife,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LazyUpscaleRife": "Lazy 超分+补帧",
}
