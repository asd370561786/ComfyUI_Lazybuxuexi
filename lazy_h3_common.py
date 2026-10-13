"""
Lazy H3 公共工具（与 Wan 套件隔离，仅复用路径解析）。
MiniMax H3：帧长 17k+5 @ 24fps；模式 t2v / i2v / flf / continue / ref。
"""
from __future__ import annotations

import logging
from typing import Any, Optional

import torch

log = logging.getLogger(__name__)

H3_FPS_DEFAULT = 24.0
H3_MAX_SECONDS = 15.0


def h3_snap_length(frames_or_seconds: float, fps: float = H3_FPS_DEFAULT, as_seconds: bool = False) -> int:
    """
    对齐 H3 帧长网格：17k+5（官方 Comfy 公式）。
    as_seconds=True 时入参为秒；否则为帧数。
    """
    fps = max(1.0, float(fps or H3_FPS_DEFAULT))
    if as_seconds:
        n = max(5, int(round(float(frames_or_seconds) * fps)))
    else:
        n = max(5, int(round(float(frames_or_seconds))))
    # max(5, n) + (5 - n % 17) % 17  → 落在 …, 5, 22, 39, 56, 73, …
    return n + (5 - (n % 17)) % 17


def h3_frames_to_seconds(length: int, fps: float = H3_FPS_DEFAULT) -> float:
    fps = max(1.0, float(fps or H3_FPS_DEFAULT))
    return float(length) / fps


def h3_snap_report(frames: int, fps: float = H3_FPS_DEFAULT) -> tuple:
    """返回 (对齐后帧数, 设计秒, 对齐后秒)。"""
    fps = max(1.0, float(fps or H3_FPS_DEFAULT))
    raw = max(5, int(round(float(frames))))
    snapped = h3_snap_length(raw, fps, False)
    return snapped, raw / fps, snapped / fps


def h3_clamp_seconds(sec: float) -> float:
    return max(0.2, min(H3_MAX_SECONDS, float(sec)))


def resolve_h3_node(class_name: str):
    """从 Comfy 全局注册表取原生 H3 节点类实例。"""
    try:
        import nodes  # ComfyUI global
        mapping = getattr(nodes, "NODE_CLASS_MAPPINGS", {}) or {}
        cls = mapping.get(class_name)
        if cls is None:
            return None
        return cls()
    except Exception as e:
        log.warning("[LazyH3] 无法加载节点 %s: %s", class_name, e)
        return None


def call_node_function(node_obj, **kwargs):
    """调用节点 FUNCTION，严格按真实 execute 签名过滤参数（避开 v3 包装的 **kwargs）。"""
    import inspect
    cls = node_obj.__class__
    # 优先真实 execute，避免 Comfy v3 EXECUTE_NORMALIZED 的 **kwargs 把非法参数透传进去
    real_fn = None
    for name in ("execute", getattr(cls, "FUNCTION", None), "FUNCTION"):
        if not name:
            continue
        cand = getattr(cls, name, None)
        if callable(cand) and name != "EXECUTE_NORMALIZED":
            real_fn = cand
            break
    fn_name = getattr(cls, "FUNCTION", "execute")
    fn = getattr(node_obj, fn_name, None) or getattr(node_obj, "execute", None)
    if fn is None:
        raise RuntimeError(f"节点 {cls.__name__} 无可用 FUNCTION")

    def _schema_input_names():
        names = set()
        if not hasattr(cls, "define_schema"):
            return names
        try:
            schema = cls.define_schema()
            for inp in getattr(schema, "inputs", []) or []:
                n = getattr(inp, "id", None) or getattr(inp, "name", None)
                if n:
                    names.add(str(n))
                    # 嵌套 multi：ref_images.ref_image_0 → 也认父键 ref_images
                    if "." in str(n):
                        names.add(str(n).split(".", 1)[0])
        except Exception:
            pass
        return names

    try:
        # 用真实 execute 的参数名过滤
        target = real_fn or fn
        sig = inspect.signature(target)
        has_var_kw = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values())
        schema_names = _schema_input_names()
        if has_var_kw:
            # 有 **kwargs：尽量全传；若 schema 有名单则只传名单+必要项
            if schema_names:
                keep = set(schema_names) | {
                    "clip", "vae", "audio_vae", "prompt", "width", "height", "length",
                    "ref_image_size", "ref_images", "ref_videos", "ref_video_audios", "ref_audios",
                    "first_frame", "last_frame", "model", "shift_video", "shift_audio",
                    "samples",
                }
                accepted = {k: v for k, v in kwargs.items() if k in keep}
            else:
                accepted = dict(kwargs)
        else:
            allowed = set(sig.parameters.keys()) - {"self", "cls"}
            if schema_names:
                allowed |= schema_names
            accepted = {k: v for k, v in kwargs.items() if k in allowed}
            if not accepted:
                accepted = {k: v for k, v in kwargs.items() if k in (set(sig.parameters.keys()) - {"self", "cls"})}
    except Exception:
        accepted = kwargs

    # 关键：多参图/视频/音频不能被过滤掉
    for must in ("ref_images", "ref_videos", "ref_audios", "ref_video_audios"):
        if must in kwargs and must not in accepted and kwargs.get(must) is not None:
            accepted[must] = kwargs[must]
            log.warning("[LazyH3] %s 参数被签名过滤，已强制回填: %s", cls.__name__, must)

    # 诊断：ref 是否真正进入官方节点
    if "ref_images" in accepted and isinstance(accepted.get("ref_images"), dict):
        log.info(
            "[LazyH3] →%s ref_images=%d keys=%s",
            cls.__name__,
            len(accepted["ref_images"]),
            list(accepted["ref_images"].keys()),
        )
    elif "ref_images" in kwargs and kwargs.get("ref_images") is not None:
        log.warning(
            "[LazyH3] →%s 传入了 ref_images 但 accepted 里没有！accepted=%s",
            cls.__name__,
            list(accepted.keys()),
        )
    if "ref_audios" in accepted and isinstance(accepted.get("ref_audios"), dict):
        log.info(
            "[LazyH3] →%s ref_audios=%d keys=%s",
            cls.__name__,
            len(accepted["ref_audios"]),
            list(accepted["ref_audios"].keys()),
        )
    elif "ref_audios" in kwargs and kwargs.get("ref_audios") is not None:
        log.warning(
            "[LazyH3] →%s 传入了 ref_audios 但 accepted 里没有！accepted=%s",
            cls.__name__,
            list(accepted.keys()),
        )

    # 通过实例入口调用（兼容 v3 包装），但只带合法参数
    try:
        return fn(**accepted)
    except TypeError as e:
        # 再兜底：直接调真实类方法
        if real_fn is not None and real_fn is not fn:
            log.warning("[LazyH3] %s 包装调用失败(%s)，改直接 execute", cls.__name__, e)
            return real_fn(**accepted)
        # 某些 v3 节点是 classmethod execute
        if real_fn is not None:
            try:
                return real_fn(**accepted)
            except TypeError:
                pass
        raise


def last_n_frames(images: torch.Tensor, n: int) -> torch.Tensor:
    """IMAGE [N,H,W,C] 取末 n 帧。"""
    if images is None or not isinstance(images, torch.Tensor) or images.numel() == 0:
        raise ValueError("视频帧为空")
    t = images
    if t.ndim == 5:
        t = t.reshape(-1, t.shape[-3], t.shape[-2], t.shape[-1])
    n = max(1, min(int(n), int(t.shape[0])))
    return t[-n:].contiguous()


def last_frame(images: torch.Tensor) -> torch.Tensor:
    return last_n_frames(images, 1)


def tensor_has_image(img) -> bool:
    if img is None:
        return False
    if isinstance(img, torch.Tensor):
        return img.numel() > 0
    return True


def infer_segment_mode(
    has_start_image: bool,
    has_end_image: bool,
    has_ref: bool,
    link: str,
    prev_was_cut: bool,
    continue_from_prev: bool,
) -> str:
    """
    段模式：
      t2v | i2v | flf | continue | ref

    文字段规则：
      - 可续写上一段 → continue（可再加尾帧）
      - 不可续写 + 后接 ⇄ 图 → flf（尾帧生视频）
      - 仅当前后都硬切（不可续写且 link=cut / 无尾帧图）→ t2v
    图段：有尾帧且 ⇄ → flf，否则 i2v。
    """
    link = link if link in ("flf", "cut") else "flf"
    if has_ref:
        return "ref"

    # —— 文字 / 无首图 ——
    if not has_start_image:
        if continue_from_prev and not prev_was_cut:
            return "continue"
        # 文字 + ⇄ 图 → 尾帧生视频（非文生）
        if has_end_image and link == "flf":
            return "flf"
        # 仅前后都硬切（或后无可接图）→ 纯文生
        return "t2v"

    # —— 有首图 ——
    if has_end_image and link == "flf":
        return "flf"
    return "i2v"


# 工作台模式
H3_MODE_STORYBOARD = "分镜"
H3_MODE_REF = "多参"


def normalize_workspace_mode(mode) -> str:
    m = (mode or H3_MODE_STORYBOARD).strip()
    if m in ("多参", "ref", "reference", "multi", "多参考"):
        return H3_MODE_REF
    return H3_MODE_STORYBOARD


def empty_audio(seconds: float, sample_rate: int = 32000) -> dict:
    """静音 AUDIO 字典。H3 默认 32kHz。"""
    import math
    n = max(1, int(math.ceil(float(seconds) * sample_rate)))
    wave = torch.zeros(1, 2, n, dtype=torch.float32)
    return {"waveform": wave, "sample_rate": int(sample_rate)}


def _as_bc_t_waveform(w) -> "torch.Tensor":
    """规范为 [B, C, T] 立体声。兼容误标成 [B, T, C] 的旧数据。"""
    if not isinstance(w, torch.Tensor):
        raise TypeError(f"waveform 非 Tensor: {type(w)}")
    w = w.detach().float().cpu()
    if w.ndim == 1:
        w = w.view(1, 1, -1)
    elif w.ndim == 2:
        if w.shape[0] in (1, 2) and w.shape[1] > 8:
            w = w.unsqueeze(0)
        elif w.shape[1] in (1, 2) and w.shape[0] > 8:
            w = w.unsqueeze(0).movedim(-1, 1)
        else:
            w = w.unsqueeze(0)
    elif w.ndim == 3:
        b, a, c = w.shape
        # [B, T, C] → [B, C, T]
        if c in (1, 2) and a > 8 and a > c:
            w = w.movedim(-1, 1)
    else:
        raise TypeError(f"waveform 维度异常: {tuple(w.shape)}")
    if w.shape[0] > 1:
        w = w[:1]
    if w.shape[1] == 1:
        w = w.repeat(1, 2, 1)
    elif w.shape[1] > 2:
        # 仅当中间维像「声道数过多」时截断；避免 [B,T,C] 误伤
        if w.shape[-1] <= 2 and w.shape[1] > w.shape[-1]:
            w = w.movedim(-1, 1)
        if w.shape[1] > 2:
            w = w[:, :2, :]
    return w.contiguous()


def cat_audio(parts: list, sample_rate: int = 32000) -> dict:
    """拼接 AUDIO 列表。输出 [B,2,T]。"""
    if not parts:
        return empty_audio(0.1, sample_rate)
    fixed = []
    base_sr = None
    for p in parts:
        if not p or "waveform" not in p:
            continue
        w = _as_bc_t_waveform(p["waveform"])
        psr = int(p.get("sample_rate", sample_rate) or sample_rate)
        if base_sr is None:
            base_sr = psr
        elif psr != base_sr and w.shape[-1] > 1:
            target_n = max(1, int(round(w.shape[-1] * float(base_sr) / float(psr))))
            w = torch.nn.functional.interpolate(
                w, size=target_n, mode="linear", align_corners=False
            )
        fixed.append(w)
    if not fixed:
        return empty_audio(0.1, sample_rate)
    return {"waveform": torch.cat(fixed, dim=-1), "sample_rate": int(base_sr or sample_rate)}
