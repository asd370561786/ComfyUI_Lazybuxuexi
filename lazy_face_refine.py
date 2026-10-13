# -*- coding: utf-8 -*-
"""
Lazy 二采修脸：H3 FaceRefine 配置包 + 逐段调用入口。
流程：DWPose 抓脸 → 长窗平滑裁切（防尺寸呼吸） → 注入 AV latent → 锁音
→ 按脸大小降噪 → 快动少改 → H3 半程精修 → 贴回对齐。
默认锁中间真人（避开大屏）；「选脸」可改跟左/中间/右；开「参考脸」且有参考图时走参考二采。
"""
from __future__ import annotations

import logging
from typing import Any

import torch

log = logging.getLogger("LazyFaceRefine")

LAZY_FACE_REFINE_CFG = "LAZY_FACE_REFINE_CFG"

_CFG_KEYS = (
    "启用",
    "参考脸",
    "身份阈值",
    "检测器",
    "置信度",
    "裁切倍率",
    "画布宽",
    "画布高",
    "画布模式",
    "步数",
    "重绘幅度",
    "采样器",
    "调度器",
    "小脸降噪倍率",
    "大脸降噪倍率",
    "贴回羽化",
    "贴回膨胀",
    "贴回混合",
    "选脸",
    "位置平滑",
    "尺寸平滑",
    "平滑方式",
    "尺寸模式",
    "脸大小模式",
    "小脸像素",
    "大脸像素",
    "小脸偏向",
    "降噪平滑",
    "满修脸高",
    "强化保底",
    "快动起步",
    "快动满速",
    "快动保底",
    "贴回范围",
    "贴回校色",
    "漏检处理",
)

_FACE_SIDES = ("自动", "左", "中间", "右")
_H3_SELECT_BY_SIDE = {
    "自动": "largest_face",
    "左": "left_most",
    "中间": "centre_most",
    "右": "right_most",
}
_SMOOTH_METHODS = ("高斯", "保形", "均值")
_SMOOTH_METHOD_H3 = {
    "高斯": "gaussian",
    "保形": "savgol",
    "均值": "moving_average",
    "gaussian": "gaussian",
    "savgol": "savgol",
    "moving_average": "moving_average",
}
_SIZE_MODES = ("逐帧", "整段固定")
_SIZE_MODE_H3 = {
    "逐帧": "per_frame",
    "整段固定": "max_of_clip",
    "per_frame": "per_frame",
    "max_of_clip": "max_of_clip",
}
_FACE_SCALE_MODES = ("相对本段", "绝对像素")
_FACE_SCALE_H3 = {
    "相对本段": "relative_to_clip",
    "绝对像素": "absolute_px",
    "relative_to_clip": "relative_to_clip",
    "absolute_px": "absolute_px",
}
_PASTE_REGIONS = ("仅脸", "椭圆脸", "整块裁切")
_PASTE_REGION_H3 = {
    "仅脸": "face_only",
    "椭圆脸": "face_ellipse",
    "整块裁切": "full_crop",
    "face_only": "face_only",
    "face_ellipse": "face_ellipse",
    "full_crop": "full_crop",
}
_UNDETECTED_MODES = ("淡出", "跳过", "仍贴回")
_UNDETECTED_H3 = {
    "淡出": "fade_out",
    "跳过": "skip",
    "仍贴回": "composite_anyway",
    "fade_out": "fade_out",
    "skip": "skip",
    "composite_anyway": "composite_anyway",
}


def _odd_win(v, lo=1, hi=201) -> int:
    """平滑窗长强制奇数。"""
    try:
        i = int(round(float(v)))
    except Exception:
        i = lo
    i = max(int(lo), min(int(hi), i))
    if i > 1 and i % 2 == 0:
        i = min(int(hi), i + 1)
    return i


def _face_in_side(box, W, side: str) -> bool:
    """选脸区域：自动=全画布；左/中间/右=画面水平三等分。"""
    if side not in ("左", "中间", "右"):
        return True
    ww = max(float(W), 1.0)
    cx = (float(box[0]) + float(box[2])) * 0.5 / ww
    if side == "左":
        return cx < 1.0 / 3.0
    if side == "右":
        return cx > 2.0 / 3.0
    return 1.0 / 3.0 <= cx <= 2.0 / 3.0


def _filter_det_by_side(det: dict, side: str) -> dict:
    """按选脸区域过滤 DWPose 脸框；自动原样返回。不改传入 det。"""
    if not det or side == "自动":
        return det
    W = det["W"]
    all_boxes, all_confs, all_standing = [], [], []
    n_hit = 0
    src_boxes = det["all_boxes"]
    src_confs = det["all_confs"]
    src_standing = det["all_standing"]
    B = int(det["B"])
    for i in range(B):
        boxes = src_boxes[i] or []
        confs = src_confs[i] if i < len(src_confs) else []
        standing = src_standing[i] if i < len(src_standing) else []
        fb, fc, fs = [], [], []
        for j, b in enumerate(boxes):
            if not _face_in_side(b, W, side):
                continue
            fb.append(b)
            fc.append(confs[j] if j < len(confs) else 1.0)
            fs.append(bool(standing[j]) if j < len(standing) else False)
        if fb:
            n_hit += 1
        all_boxes.append(fb)
        all_confs.append(fc)
        all_standing.append(fs)
    out = dict(det)
    out["all_boxes"] = all_boxes
    out["all_confs"] = all_confs
    out["all_standing"] = all_standing
    out["n_hit"] = n_hit
    return out


def _first_ref_image(ref_images) -> torch.Tensor | None:
    """从多参/参考图里取第一张有效 IMAGE，供身份锁定。"""
    if ref_images is None:
        return None
    if isinstance(ref_images, torch.Tensor):
        if ref_images.numel() == 0:
            return None
        t = ref_images
        if t.ndim == 3:
            t = t.unsqueeze(0)
        return t[0:1].float().contiguous()
    if isinstance(ref_images, dict):
        def _kord(k):
            s = str(k).rsplit("_", 1)[-1]
            return int(s) if s.isdigit() else 0
        for _k, v in sorted(ref_images.items(), key=lambda kv: _kord(kv[0])):
            if isinstance(v, torch.Tensor) and v.numel() > 0:
                t = v
                if t.ndim == 3:
                    t = t.unsqueeze(0)
                return t[0:1].float().contiguous()
    if isinstance(ref_images, (list, tuple)):
        for v in ref_images:
            if isinstance(v, torch.Tensor) and v.numel() > 0:
                t = v
                if t.ndim == 3:
                    t = t.unsqueeze(0)
                return t[0:1].float().contiguous()
    return None


def _detector_choices():
    out = ["DWPose"]
    try:
        import folder_paths
        names = folder_paths.get_filename_list("ultralytics_bbox") or []
        if not names:
            names = folder_paths.get_filename_list("ultralytics") or []
        for n in names:
            out.append(n)
            if not str(n).startswith("bbox") and "face" in str(n).lower():
                out.append(f"bbox\\{n}" if "\\" not in n and "/" not in n else n)
    except Exception:
        out.extend(["bbox\\face_yolov8m.pt", "face_yolov8m.pt"])
    seen = set()
    uniq = []
    for x in out:
        if x not in seen:
            seen.add(x)
            uniq.append(x)
    return uniq or ["DWPose"]


def _face_refine_defaults() -> dict:
    dets = _detector_choices()
    default_det = "DWPose"
    if default_det not in dets and dets:
        default_det = dets[0]
    return {
        "启用": True,
        "参考脸": False,
        "身份阈值": 0.35,
        "检测器": default_det,
        "置信度": 0.35,
        "裁切倍率": 2.5,
        "画布宽": 768,
        "画布高": 768,
        "画布模式": "manual",
        "步数": 8,
        "重绘幅度": 0.55,
        "采样器": "er_sde",
        "调度器": "simple",
        "小脸降噪倍率": 1.0,
        "大脸降噪倍率": 0.30,
        "贴回羽化": 6,
        "贴回膨胀": 16,
        "贴回混合": 1.0,
        "选脸": "自动",
        "位置平滑": 21,
        "尺寸平滑": 51,
        "平滑方式": "高斯",
        "尺寸模式": "逐帧",
        "脸大小模式": "相对本段",
        "小脸像素": 70.0,
        "大脸像素": 160.0,
        "小脸偏向": 0.8,
        "降噪平滑": 21,
        "满修脸高": 80.0,
        "强化保底": 0.45,
        "快动起步": 0.05,
        "快动满速": 0.20,
        "快动保底": 0.30,
        "贴回范围": "仅脸",
        "贴回校色": 1.0,
        "漏检处理": "淡出",
    }


def sanitize_face_refine_params(raw: dict | None) -> dict:
    """按类型纠错控件错位脏值；合理值原样保留，不强制改用户设定。"""
    d = _face_refine_defaults()
    if not isinstance(raw, dict):
        return dict(d)
    out = dict(d)

    def _bool(v, default):
        if isinstance(v, bool):
            return v
        if isinstance(v, (int, float)) and v in (0, 1):
            return bool(v)
        if isinstance(v, str) and v.strip().lower() in ("true", "false", "1", "0"):
            return v.strip().lower() in ("true", "1")
        return default

    def _float(v, default, lo, hi):
        try:
            f = float(v)
        except Exception:
            return default
        if f != f or f < lo or f > hi:
            return default
        return f

    def _int(v, default, lo, hi):
        try:
            # 拒绝 "auto_capped_768" 这类串
            if isinstance(v, str) and not v.strip().lstrip("-").isdigit():
                return default
            i = int(round(float(v)))
        except Exception:
            return default
        if i < lo or i > hi:
            return default
        return i

    def _choice(v, choices, default):
        s = str(v) if v is not None else ""
        if s in choices:
            return s
        return default

    out["启用"] = _bool(raw.get("启用", d["启用"]), d["启用"])
    out["参考脸"] = _bool(
        raw.get("参考脸", raw.get("只用参考脸", d["参考脸"])),
        d["参考脸"],
    )
    out["身份阈值"] = _float(raw.get("身份阈值", d["身份阈值"]), d["身份阈值"], 0.0, 1.0)
    # 身份阈值=1 多为错位（原布尔），回默认
    if out["身份阈值"] >= 0.99 and raw.get("检测器") in (True, False, "启用", "true", "false"):
        out["身份阈值"] = d["身份阈值"]

    det = raw.get("检测器", d["检测器"])
    det_s = str(det) if det is not None else ""
    if (det_s.lower() == "dwpose" or ".pt" in det_s or "face" in det_s.lower()
            or "yolo" in det_s.lower() or "bbox" in det_s.lower()):
        out["检测器"] = det_s
    else:
        out["检测器"] = d["检测器"]

    out["置信度"] = _float(raw.get("置信度", d["置信度"]), d["置信度"], 0.05, 0.95)
    out["裁切倍率"] = _float(raw.get("裁切倍率", d["裁切倍率"]), d["裁切倍率"], 1.2, 8.0)
    out["画布宽"] = _int(raw.get("画布宽", d["画布宽"]), d["画布宽"], 128, 1344)
    out["画布高"] = _int(raw.get("画布高", d["画布高"]), d["画布高"], 128, 1344)
    # 画布被错成 2.5 之类
    if out["画布宽"] < 128:
        out["画布宽"] = d["画布宽"]
    if out["画布高"] < 128:
        out["画布高"] = d["画布高"]

    out["画布模式"] = _choice(
        raw.get("画布模式", d["画布模式"]),
        ["manual", "auto_no_downscale", "auto_capped_768"],
        d["画布模式"],
    )
    out["步数"] = _int(raw.get("步数", d["步数"]), d["步数"], 1, 40)
    out["重绘幅度"] = _float(raw.get("重绘幅度", d["重绘幅度"]), d["重绘幅度"], 0.05, 1.0)
    # 重绘幅度=8 是错位
    if out["重绘幅度"] > 1.0:
        out["重绘幅度"] = d["重绘幅度"]

    out["采样器"] = _choice(
        raw.get("采样器", d["采样器"]),
        ["er_sde", "res_multistep", "euler", "dpmpp_2m"],
        d["采样器"],
    )
    out["调度器"] = _choice(
        raw.get("调度器", d["调度器"]),
        ["simple", "normal", "karras", "sgm_uniform"],
        d["调度器"],
    )
    out["小脸降噪倍率"] = _float(raw.get("小脸降噪倍率", d["小脸降噪倍率"]), d["小脸降噪倍率"], 0.0, 1.0)
    out["大脸降噪倍率"] = _float(raw.get("大脸降噪倍率", d["大脸降噪倍率"]), d["大脸降噪倍率"], 0.0, 1.0)
    out["贴回羽化"] = _int(raw.get("贴回羽化", d["贴回羽化"]), d["贴回羽化"], 0, 256)
    out["贴回膨胀"] = _int(raw.get("贴回膨胀", d["贴回膨胀"]), d["贴回膨胀"], 0, 256)
    out["贴回混合"] = _float(raw.get("贴回混合", d["贴回混合"]), d["贴回混合"], 0.0, 1.0)
    # 贴回羽化=0.3 错位
    if isinstance(raw.get("贴回羽化"), float) and float(raw.get("贴回羽化")) < 1:
        out["贴回羽化"] = d["贴回羽化"]
    out["选脸"] = _choice(raw.get("选脸", d["选脸"]), list(_FACE_SIDES), d["选脸"])
    out["位置平滑"] = _odd_win(raw.get("位置平滑", d["位置平滑"]), 1, 201)
    out["尺寸平滑"] = _odd_win(raw.get("尺寸平滑", d["尺寸平滑"]), 1, 201)
    out["平滑方式"] = _choice(raw.get("平滑方式", d["平滑方式"]), list(_SMOOTH_METHODS), d["平滑方式"])
    out["尺寸模式"] = _choice(raw.get("尺寸模式", d["尺寸模式"]), list(_SIZE_MODES), d["尺寸模式"])
    out["脸大小模式"] = _choice(
        raw.get("脸大小模式", d["脸大小模式"]), list(_FACE_SCALE_MODES), d["脸大小模式"],
    )
    out["小脸像素"] = _float(raw.get("小脸像素", d["小脸像素"]), d["小脸像素"], 4.0, 400.0)
    out["大脸像素"] = _float(raw.get("大脸像素", d["大脸像素"]), d["大脸像素"], 8.0, 800.0)
    if out["大脸像素"] <= out["小脸像素"]:
        out["大脸像素"] = min(800.0, out["小脸像素"] + 8.0)
    out["小脸偏向"] = _float(raw.get("小脸偏向", d["小脸偏向"]), d["小脸偏向"], 0.2, 4.0)
    out["降噪平滑"] = _odd_win(raw.get("降噪平滑", d["降噪平滑"]), 1, 61)
    out["满修脸高"] = _float(raw.get("满修脸高", d["满修脸高"]), d["满修脸高"], 8.0, 400.0)
    out["强化保底"] = _float(raw.get("强化保底", d["强化保底"]), d["强化保底"], 0.0, 1.0)
    out["快动起步"] = _float(raw.get("快动起步", d["快动起步"]), d["快动起步"], 0.0, 1.0)
    out["快动满速"] = _float(raw.get("快动满速", d["快动满速"]), d["快动满速"], 0.01, 2.0)
    if out["快动满速"] <= out["快动起步"]:
        out["快动满速"] = min(2.0, out["快动起步"] + 0.01)
    out["快动保底"] = _float(raw.get("快动保底", d["快动保底"]), d["快动保底"], 0.0, 1.0)
    out["贴回范围"] = _choice(raw.get("贴回范围", d["贴回范围"]), list(_PASTE_REGIONS), d["贴回范围"])
    out["贴回校色"] = _float(raw.get("贴回校色", d["贴回校色"]), d["贴回校色"], 0.0, 1.0)
    out["漏检处理"] = _choice(raw.get("漏检处理", d["漏检处理"]), list(_UNDETECTED_MODES), d["漏检处理"])
    return out


def build_face_refine_cfg(kwargs) -> dict:
    raw = kwargs if isinstance(kwargs, dict) else {}
    cfg = sanitize_face_refine_params(raw)
    cfg["__type__"] = LAZY_FACE_REFINE_CFG
    uid = raw.get("unique_id") or raw.get("_node_id")
    if uid is not None and str(uid).strip():
        cfg["_node_id"] = str(uid)
    return cfg


def _get_fr_cls(name: str):
    try:
        import nodes as comfy_nodes
        m = getattr(comfy_nodes, "NODE_CLASS_MAPPINGS", None) or {}
        cls = m.get(name)
        if cls is not None:
            return cls
    except Exception:
        pass
    try:
        from ComfyUI_H3_FaceRefine import nodes as fr_nodes  # type: ignore
    except Exception:
        try:
            import importlib
            import sys
            from pathlib import Path
            root = Path(__file__).resolve().parents[1] / "ComfyUI-H3-FaceRefine"
            if root.is_dir() and str(root) not in sys.path:
                sys.path.insert(0, str(root.parent))
            fr_nodes = importlib.import_module("ComfyUI-H3-FaceRefine.nodes")
        except Exception as e:
            raise RuntimeError(
                "未找到 ComfyUI-H3-FaceRefine。请确认已安装到 custom_nodes。"
            ) from e
    mapping = getattr(fr_nodes, "NODE_CLASS_MAPPINGS", {}) or {}
    # 类名映射
    alias = {
        "H3FaceTrackCrop": "H3FaceTrackCrop",
        "H3InjectVideoLatent": "H3InjectVideoLatent",
        "H3PerFrameDenoise": "H3PerFrameDenoise",
        "H3FaceStitch": "H3FaceStitch",
    }
    for k, v in list(mapping.items()):
        if name in (k, getattr(v, "__name__", "")):
            return v
    # 直接 getattr
    cls = getattr(fr_nodes, name, None)
    if cls is not None:
        return cls
    raise RuntimeError(f"FaceRefine 缺少节点：{name}")


def _native_audio_lock(model, av_latent, audio_vae, audio):
    """优先官方 NativeAudioLock；否则 Lazy _h3_audio_lock。"""
    try:
        import nodes as comfy_nodes
        m = getattr(comfy_nodes, "NODE_CLASS_MAPPINGS", None) or {}
        cls = m.get("MiniMaxH3NativeAudioLock")
        if cls is not None:
            node = cls()
            return node.lock_audio(model, av_latent, audio_vae, audio)
    except Exception as e:
        log.warning("[Lazy二采修脸] NativeAudioLock 失败，回退: %s", e)
    from .lazy_h3_sequential import _h3_audio_lock
    locked = _h3_audio_lock(av_latent, audio, audio_vae)
    return (model, locked, audio)


_DWPOSE = None


def _to_rgb_u8(img: torch.Tensor):
    import numpy as np
    a = (img[..., :3].clamp(0, 1).detach().cpu().numpy() * 255.0).astype("uint8")
    return np.ascontiguousarray(a)


def _get_dwpose():
    global _DWPOSE
    if _DWPOSE is not None:
        return _DWPOSE
    import sys
    from pathlib import Path
    src = Path(__file__).resolve().parents[1] / "comfyui_controlnet_aux" / "src"
    if src.is_dir() and str(src) not in sys.path:
        sys.path.insert(0, str(src))
    import comfy.model_management as mm
    from custom_controlnet_aux.dwpose import DwposeDetector
    _DWPOSE = DwposeDetector.from_pretrained(
        "hr16/DWPose-TorchScript-BatchSize5",
        "hr16/yolox-onnx",
        det_filename="yolox_l.torchscript.pt",
        pose_filename="dw-ll_ucoco_384_bs5.torchscript.pt",
        torchscript_device=mm.get_torch_device(),
    )
    return _DWPOSE


def _kp_xy(kp):
    if kp is None:
        return None
    try:
        return float(kp.x), float(kp.y)
    except Exception:
        return None


def _box_from_pts(pts, W, H, pad_x=0.12, pad_top=0.28, pad_bot=0.10):
    if len(pts) < 3:
        return None
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    x0, x1 = min(xs), max(xs)
    y0, y1 = min(ys), max(ys)
    w = max(1.0, x1 - x0)
    h = max(1.0, y1 - y0)
    x0 = max(0.0, x0 - pad_x * w)
    x1 = min(float(W), x1 + pad_x * w)
    y0 = max(0.0, y0 - pad_top * h)
    y1 = min(float(H), y1 + pad_bot * h)
    if (x1 - x0) < 8.0 or (y1 - y0) < 8.0:
        return None
    return [x0, y0, x1, y1]


def _face_box_from_pose(pose, W, H):
    pts = []
    face = getattr(pose, "face", None)
    if face:
        for kp in face:
            xy = _kp_xy(kp)
            if xy is not None:
                pts.append(xy)
    box = _box_from_pts(pts, W, H)
    if box is not None:
        return box
    body = getattr(getattr(pose, "body", None), "keypoints", None)
    if not body:
        return None
    head = []
    for idx in (0, 14, 15, 16, 17):
        if idx < len(body):
            xy = _kp_xy(body[idx])
            if xy is not None:
                head.append(xy)
    if len(head) < 2:
        return None
    xs = [p[0] for p in head]
    ys = [p[1] for p in head]
    cx = sum(xs) / len(xs)
    cy = sum(ys) / len(ys)
    neck = _kp_xy(body[1]) if len(body) > 1 else None
    if neck is not None:
        fh = max(abs(cy - neck[1]) * 1.55, max(ys) - min(ys), 8.0)
    else:
        span = max(max(xs) - min(xs), max(ys) - min(ys), 8.0)
        fh = span * 2.0
    fw = fh * 0.85
    x0 = max(0.0, cx - fw * 0.5)
    y0 = max(0.0, cy - fh * 0.55)
    x1 = min(float(W), x0 + fw)
    y1 = min(float(H), y0 + fh)
    if (x1 - x0) < 8.0 or (y1 - y0) < 8.0:
        return None
    return [x0, y0, x1, y1]


def _has_standing_body(pose, face_box) -> bool:
    """肩 + 脸下方的髋/膝/踝，且身体纵向够长。大屏特写通常没有站立身体。"""
    body = getattr(getattr(pose, "body", None), "keypoints", None)
    if not body:
        return False

    def xy(idx):
        if idx < len(body):
            return _kp_xy(body[idx])
        return None

    shoulders = [p for p in (xy(2), xy(5)) if p]
    lower = [p for p in (xy(8), xy(9), xy(12), xy(10), xy(13), xy(11), xy(14)) if p]
    if len(shoulders) < 1 or not lower:
        return False
    face_bottom = float(face_box[3])
    below = [p for p in lower if p[1] > face_bottom + 12.0]
    if not below:
        return False
    y_span = max(p[1] for p in below) - min(p[1] for p in shoulders)
    face_h = max(1.0, float(face_box[3] - face_box[1]))
    return y_span >= face_h * 1.2


def _pick_one_face_track(all_boxes, all_confs, all_standing=None, W=1.0, H=1.0, side="自动"):
    """每帧只留 1 张被跟踪的脸。自动：锁中心真人避开大屏；左/中间/右：按位置偏置，该侧不当大屏丢掉。"""
    B = len(all_boxes)
    if all_standing is None:
        all_standing = [[False] * len(all_boxes[i] or []) for i in range(B)]
    picked_boxes = [[] for _ in range(B)]
    picked_confs = [[] for _ in range(B)]
    n_relock = 0
    Ww = max(float(W), 1.0)
    Hh = max(float(H), 1.0)
    if side not in _FACE_SIDES:
        side = "自动"

    def _st(i, j):
        row = all_standing[i] if i < len(all_standing) else []
        return bool(row[j]) if j < len(row) else False

    def _is_screen(b, standing):
        cx = (b[0] + b[2]) * 0.5 / Ww
        fh = (b[3] - b[1]) / Hh
        left_edge = cx < 0.18
        right_edge = cx > 0.82
        if side == "左":
            edge = right_edge
        elif side == "右":
            edge = left_edge
        else:
            edge = left_edge or right_edge
        huge = fh >= 0.22
        if edge and huge:
            return True
        if side == "自动" and huge and not standing:
            return True
        return False

    def _score(b, standing):
        cx = (b[0] + b[2]) * 0.5 / Ww
        cy = (b[1] + b[3]) * 0.5 / Hh
        fh = (b[3] - b[1]) / Hh
        s = 0.0
        if side == "左":
            s -= cx * 10.0
            if standing:
                s += 1.0
        elif side == "右":
            s += cx * 10.0
            if standing:
                s += 1.0
        elif side == "中间":
            s -= abs(cx - 0.5) * 10.0
            if standing:
                s += 1.0
        else:
            if standing:
                s += 4.0
            s -= abs(cx - 0.5) * 5.0
        s -= abs(cy - 0.42) * 1.5
        s += min(fh, 0.12) * 3.0
        if _is_screen(b, standing):
            s -= 8.0
        return s

    def _conf(i, j):
        confs = all_confs[i] if i < len(all_confs) else []
        return float(confs[j]) if j < len(confs) else 1.0

    def _choose_continue(i, last):
        boxes = all_boxes[i] or []
        if not boxes:
            return None, False
        cx0, cy0, h0 = last
        reach = 3.0 * max(float(h0), 1.0)
        near = []
        for j, b in enumerate(boxes):
            cx = (b[0] + b[2]) * 0.5
            cy = (b[1] + b[3]) * 0.5
            d = ((cx - cx0) ** 2 + (cy - cy0) ** 2) ** 0.5
            if d <= reach:
                near.append((j, d, _is_screen(b, _st(i, j))))
        if near:
            real = [t for t in near if not t[2]]
            pool = real if real else near
            return min(pool, key=lambda t: t[1])[0], False
        scored = []
        for j, b in enumerate(boxes):
            st = _st(i, j)
            if _is_screen(b, st):
                continue
            scored.append((j, _score(b, st)))
        if not scored:
            return None, False
        return max(scored, key=lambda t: t[1])[0], True

    seed = None
    for i in range(B):
        boxes = all_boxes[i] or []
        for j, b in enumerate(boxes):
            s = _score(b, _st(i, j))
            if seed is None or s > seed[2]:
                seed = (i, j, s)
    if seed is None:
        return picked_boxes, picked_confs, -1, 0

    seed_i, seed_j, _ = seed
    b = all_boxes[seed_i][seed_j]
    picked_boxes[seed_i] = [b]
    picked_confs[seed_i] = [_conf(seed_i, seed_j)]
    last = ((b[0] + b[2]) * 0.5, (b[1] + b[3]) * 0.5, b[3] - b[1])

    last_f = last
    for i in range(seed_i + 1, B):
        j, relock = _choose_continue(i, last_f)
        if j is None:
            continue
        if relock:
            n_relock += 1
        b = all_boxes[i][j]
        picked_boxes[i] = [b]
        picked_confs[i] = [_conf(i, j)]
        last_f = ((b[0] + b[2]) * 0.5, (b[1] + b[3]) * 0.5, b[3] - b[1])

    last_b = last
    for i in range(seed_i - 1, -1, -1):
        j, relock = _choose_continue(i, last_b)
        if j is None:
            continue
        if relock:
            n_relock += 1
        b = all_boxes[i][j]
        picked_boxes[i] = [b]
        picked_confs[i] = [_conf(i, j)]
        last_b = ((b[0] + b[2]) * 0.5, (b[1] + b[3]) * 0.5, b[3] - b[1])

    return picked_boxes, picked_confs, seed_i, n_relock


def _dwpose_detect_faces(images: torch.Tensor, confidence: float = 0.35) -> dict | None:
    """DWPose 逐帧出全部脸框，供后续锁中间真人或参考图身份锁定。"""
    import contextlib
    import io
    import comfy.model_management as mm
    model = _get_dwpose()
    B, H, W, _ = images.shape
    all_boxes = []
    all_confs = []
    all_standing = []
    n_hit = 0
    dummy = io.StringIO()
    try:
        import comfy.utils
        pbar = comfy.utils.ProgressBar(B)
    except Exception:
        pbar = None
    for i in range(B):
        mm.throw_exception_if_processing_interrupted()
        rgb = _to_rgb_u8(images[i])
        with contextlib.redirect_stdout(dummy):
            poses = model.detect_poses(rgb)
        boxes, confs, standing = [], [], []
        for pose in poses or []:
            box = _face_box_from_pose(pose, W, H)
            if box is None:
                continue
            boxes.append(box)
            confs.append(1.0)
            standing.append(_has_standing_body(pose, box))
        if boxes:
            n_hit += 1
        all_boxes.append(boxes)
        all_confs.append(confs)
        all_standing.append(standing)
        if pbar is not None:
            pbar.update(1)
    if n_hit == 0:
        log.warning("[Lazy二采修脸] DWPose 全段未抓到脸，跳过")
        return None
    return {
        "all_boxes": all_boxes,
        "all_confs": all_confs,
        "all_standing": all_standing,
        "n_hit": n_hit,
        "B": int(B),
        "W": int(W),
        "H": int(H),
        "confidence": float(confidence),
    }


def _pack_dwpose_face_pick(boxes, confs, B, W, H, confidence, picks, select="largest_face") -> dict:
    return {
        "version": 1,
        "boxes": boxes,
        "confs": confs,
        "segments": [(0, int(B))],
        "picks": picks,
        "frames": int(B),
        "src_size": (int(W), int(H)),
        "detector": "DWPose",
        "confidence": float(confidence),
        "select": select,
        "select_index": 0,
        "rank_by": select,
        "identity_model": None,
        "identity_threshold": None,
        "identity_scores": [],
    }


def _dwpose_face_pick_from_det(det: dict, *, keep_all: bool = False, side: str = "自动") -> dict | None:
    """
    keep_all=False：每帧只交 1 张（自动锁中间真人；左/中间/右只在该区域）。
    keep_all=True：保留区域内全部脸且 picks 留空，交给 H3 参考图身份锁定（自动=全画布）。
    """
    det = _filter_det_by_side(det, side)
    all_boxes = det["all_boxes"]
    all_confs = det["all_confs"]
    B, W, H = det["B"], det["W"], det["H"]
    confidence = det["confidence"]
    h3_sel = _H3_SELECT_BY_SIDE.get(side, "largest_face")
    region = "全画布" if side == "自动" else f"区域={side}"
    if keep_all:
        first = next((i for i in range(B) if all_boxes[i]), -1)
        if first < 0:
            log.warning("[Lazy二采修脸] DWPose 跟踪后无可用脸（%s），跳过", region)
            return None
        log.info(
            "[Lazy二采修脸] DWPose 抓脸：%d/%d 帧有脸，%s 保留全部脸供参考图锁定",
            det["n_hit"], B, region,
        )
        return _pack_dwpose_face_pick(
            all_boxes, all_confs, B, W, H, confidence, picks=[], select=h3_sel,
        )
    picked_boxes, picked_confs, first, n_relock = _pick_one_face_track(
        all_boxes, all_confs, det["all_standing"], W, H, side=side,
    )
    if first < 0:
        log.warning("[Lazy二采修脸] DWPose 跟踪后无可用脸，跳过")
        return None
    log.info(
        "[Lazy二采修脸] DWPose 抓脸：%d/%d 帧有脸，选脸=%s frame=%d，重锁=%d（每帧 1 张）",
        det["n_hit"], B, side, first, n_relock,
    )
    picks = [{
        "segment": [0, int(B)],
        "frame": int(first),
        "box": 0,
        "index": 0,
        "absent": False,
    }]
    return _pack_dwpose_face_pick(
        picked_boxes, picked_confs, B, W, H, confidence, picks, select=h3_sel,
    )


def _build_dwpose_face_pick(
    images: torch.Tensor, confidence: float = 0.35, *, keep_all: bool = False, side: str = "自动",
) -> dict | None:
    """DWPose 逐帧抓脸 → H3 face_pick。"""
    det = _dwpose_detect_faces(images, confidence)
    if not det:
        return None
    return _dwpose_face_pick_from_det(det, keep_all=keep_all, side=side)


def _gauss_smooth_1d(vals, window: int = 15):
    """一维高斯平滑，边缘用邻值填充。窗长不足 3 时原样返回。"""
    import numpy as np

    a = np.asarray(vals, dtype=np.float64)
    n = int(a.shape[0])
    if n <= 0:
        return a
    window = min(int(window) | 1, n)
    if window < 3:
        return a
    pad = window // 2
    x = np.arange(window, dtype=np.float64) - pad
    k = np.exp(-(x ** 2) / (2.0 * max(window / 6.0, 0.5) ** 2))
    k /= k.sum()
    return np.convolve(np.pad(a, pad, mode="edge"), k, mode="valid")[:n]


def _boost_small_face_noise_mask(
    av_latent: dict, transform: dict, *, face_px_clear: float = 80.0, large_floor: float = 0.45,
) -> dict:
    """
    当前 ComfyUI H3 模型常无 _denoise_mask_conds，PerFrameDenoise 的模型补丁会失效。
    这里直接加强 latent.noise_mask：源脸高 < face_px_clear 的帧强制高重绘权重。
    """
    import numpy as np
    import torch.nn.functional as F

    if not isinstance(av_latent, dict) or transform is None:
        return av_latent
    samples = av_latent.get("samples")
    if samples is None:
        return av_latent
    try:
        members = list(samples.unbind())
    except Exception:
        return av_latent
    if not members:
        return av_latent
    video = members[0]
    boxes = transform.get("boxes") or []
    cf = float(transform.get("crop_factor", 2.5) or 2.5)
    if not boxes:
        return av_latent

    face_h = np.array([float(b[3]) / cf for b in boxes], dtype=np.float64)
    # 小脸 → 1.0；超过 clear 阈值后线性降到 large_floor
    thr = max(8.0, float(face_px_clear))
    floor = max(0.0, min(1.0, float(large_floor)))
    strength = np.ones_like(face_h)
    drop = 1.0 - floor
    for i, h in enumerate(face_h):
        if h <= thr:
            strength[i] = 1.0
        else:
            t = min(1.0, (h - thr) / max(1.0, thr))
            strength[i] = 1.0 - drop * t
    # absent / 丢跟：保持 0（不乱造）
    absent = transform.get("absent")
    if absent is not None and len(absent) == len(strength):
        strength[np.array(absent, dtype=bool)] = 0.0
    weights = transform.get("weights")
    if weights is not None and len(weights) == len(strength):
        strength = strength * np.asarray(weights, dtype=np.float64)

    # 降噪强度时序平滑，避免脸部纹理一明一暗
    if len(strength) >= 5:
        strength = _gauss_smooth_1d(strength, min(15, len(strength) | 1))
        if absent is not None and len(absent) == len(strength):
            strength[np.array(absent, dtype=bool)] = 0.0

    latent_t = int(video.shape[-3])
    s = torch.from_numpy(strength.astype(np.float32)).view(1, 1, -1)
    s = F.interpolate(s, size=latent_t, mode="linear", align_corners=True)
    s = s.view(1, 1, latent_t, 1, 1).to(device=video.device, dtype=torch.float32)
    vmask = s.expand(video.shape[0], video.shape[1], latent_t, video.shape[-2], video.shape[-1]).contiguous()

    prev = av_latent.get("noise_mask")
    try:
        import comfy.nested_tensor as nt
        if prev is not None and (isinstance(prev, nt.NestedTensor) or getattr(prev, "is_nested", False)):
            pm = list(prev.unbind())
            # 与已有 mask 取 max，确保小脸不被降下去
            old_v = pm[0].float()
            # 时间维对齐
            if old_v.shape[-3] == vmask.shape[-3]:
                pm[0] = torch.maximum(old_v, vmask.to(old_v.dtype))
            else:
                pm[0] = vmask.to(old_v.dtype)
            new_mask = nt.NestedTensor(tuple(pm))
        else:
            audio_zero = torch.zeros_like(members[1]) if len(members) > 1 else None
            parts = (vmask.to(video.dtype),)
            if audio_zero is not None:
                parts = (vmask.to(video.dtype), audio_zero)
            new_mask = nt.NestedTensor(parts)
    except Exception as e:
        log.warning("[Lazy二采修脸] 强化 noise_mask 失败: %s", e)
        return av_latent

    out = dict(av_latent)
    out["noise_mask"] = new_mask
    log.info(
        "[Lazy二采修脸] 小脸强化 mask：脸高 %.0f–%.0fpx，阈值<%.0fpx 强制满修，strength=%.2f–%.2f",
        float(face_h.min()), float(face_h.max()), thr,
        float(strength.min()), float(strength.max()),
    )
    return out


def _head_motion_scale(transform, *, lo=0.05, hi=0.20, floor=0.30):
    """按裁切中心速度得到每帧重绘倍率：停住=1.0，甩头压到 floor。"""
    import numpy as np

    boxes = transform.get("boxes") or []
    n = len(boxes)
    if n <= 0:
        return None
    cf = float(transform.get("crop_factor", 2.5) or 2.5)
    speed = np.zeros(n, dtype=np.float64)
    prev = None
    for i, b in enumerate(boxes):
        try:
            x, y, w, h = (float(v) for v in b[:4])
        except Exception:
            continue
        cx, cy = x + w * 0.5, y + h * 0.5
        face_h = max(h / max(cf, 1e-6), 8.0)
        if prev is not None:
            d = ((cx - prev[0]) ** 2 + (cy - prev[1]) ** 2) ** 0.5
            speed[i] = d / face_h
        prev = (cx, cy)
    if n > 1 and speed[0] == 0.0:
        speed[0] = speed[1]
    t = np.clip((speed - float(lo)) / max(float(hi) - float(lo), 1e-6), 0.0, 1.0)
    scale = 1.0 * (1.0 - t) + float(floor) * t
    if n >= 3:
        k = np.array([0.25, 0.5, 0.25], dtype=np.float64)
        padded = np.pad(scale, 1, mode="edge")
        scale = np.convolve(padded, k, mode="valid")
    return np.clip(scale, float(floor), 1.0)


def _cap_video_noise_mask(av_latent: dict, vmask: torch.Tensor) -> dict:
    """快动上限：已有 mask 取 min；没有则直接用上限。vmask 需已对齐 video latent。"""
    samples = av_latent.get("samples")
    if samples is None:
        return av_latent
    try:
        members = list(samples.unbind())
    except Exception:
        return av_latent
    if not members:
        return av_latent
    video = members[0]
    cap = vmask.to(device=video.device, dtype=torch.float32)
    prev = av_latent.get("noise_mask")
    try:
        import comfy.nested_tensor as nt
        if prev is not None and (isinstance(prev, nt.NestedTensor) or getattr(prev, "is_nested", False)):
            pm = list(prev.unbind())
            old_v = pm[0].float()
            if old_v.shape == cap.shape:
                pm[0] = torch.minimum(old_v, cap.to(dtype=old_v.dtype))
            else:
                pm[0] = cap.to(dtype=old_v.dtype)
            new_mask = nt.NestedTensor(tuple(pm))
        else:
            audio_zero = torch.zeros_like(members[1]) if len(members) > 1 else None
            parts = (cap.to(video.dtype),)
            if audio_zero is not None:
                parts = (cap.to(video.dtype), audio_zero)
            new_mask = nt.NestedTensor(parts)
    except Exception as e:
        log.warning("[Lazy二采修脸] 写入 noise_mask 失败: %s", e)
        return av_latent
    out = dict(av_latent)
    out["noise_mask"] = new_mask
    return out


def _apply_motion_denoise_scale(
    av_latent: dict, transform: dict, *, lo=0.05, hi=0.20, floor=0.30,
) -> dict:
    """快转头的帧压低 noise_mask，保住原片转角；停住仍满修。"""
    import numpy as np
    import torch.nn.functional as F

    if not isinstance(av_latent, dict) or transform is None:
        return av_latent
    samples = av_latent.get("samples")
    if samples is None:
        return av_latent
    try:
        video = list(samples.unbind())[0]
    except Exception:
        return av_latent
    scale = _head_motion_scale(transform, lo=lo, hi=hi, floor=floor)
    if scale is None or len(scale) == 0:
        return av_latent
    if float(scale.min()) >= 0.999:
        return av_latent
    latent_t = int(video.shape[-3])
    s = torch.from_numpy(scale.astype(np.float32)).view(1, 1, -1)
    s = F.interpolate(s, size=latent_t, mode="linear", align_corners=True)
    s = s.view(1, 1, latent_t, 1, 1).to(device=video.device, dtype=torch.float32)
    vmask = s.expand(video.shape[0], video.shape[1], latent_t, video.shape[-2], video.shape[-1]).contiguous()
    out = _cap_video_noise_mask(av_latent, vmask)
    log.info(
        "[Lazy二采修脸] 快动少改：scale=%.2f–%.2f，快转帧压重绘",
        float(scale.min()), float(scale.max()),
    )
    return out


def _largest_face_on_image(img: torch.Tensor, W: int, H: int, model) -> tuple | None:
    """画布上最大脸 (cx, cy, w, h)；没有则 None。"""
    import contextlib
    import io

    dummy = io.StringIO()
    t = img[0] if getattr(img, "ndim", 0) == 4 else img
    H = int(t.shape[0]) if t is not None and getattr(t, "ndim", 0) >= 2 else int(H)
    W = int(t.shape[1]) if t is not None and getattr(t, "ndim", 0) >= 2 else int(W)
    rgb = _to_rgb_u8(t)
    with contextlib.redirect_stdout(dummy):
        poses = model.detect_poses(rgb)
    best = None
    best_h = -1.0
    for pose in poses or []:
        box = _face_box_from_pose(pose, W, H)
        if box is None:
            continue
        ww = float(box[2] - box[0])
        hh = float(box[3] - box[1])
        if hh > best_h:
            best_h = hh
            best = (
                (float(box[0]) + float(box[2])) * 0.5,
                (float(box[1]) + float(box[3])) * 0.5,
                max(ww, 1.0),
                max(hh, 1.0),
            )
    return best


def _rect_from_face_rect(fr) -> tuple | None:
    try:
        ox, oy, ow, oh = (float(v) for v in fr[:4])
    except Exception:
        return None
    if ow < 4.0 or oh < 4.0:
        return None
    return (ox + ow * 0.5, oy + oh * 0.5, ow, oh)


def _stitch_mask_dilation(transform: dict, feather: int, dilation: int) -> int:
    """
    H3 羽化按源像素换算到画布，膨胀却是画布像素。
    膨胀必须 ≥ 画布羽化，否则高斯糊边会吃进脸心，贴不紧。
    """
    dil = int(max(0, dilation))
    feat = int(max(0, feather))
    if feat <= 0:
        return dil
    boxes = transform.get("boxes") or []
    canvas = transform.get("canvas") or (0, 0)
    try:
        ch = int(canvas[1] if canvas else 0)
    except Exception:
        ch = 0
    if ch <= 0 or not boxes:
        return max(dil, feat)
    hs = []
    for b in boxes:
        try:
            hs.append(float(b[3]))
        except Exception:
            pass
    if not hs:
        return max(dil, feat)
    hs.sort()
    bh_mid = hs[len(hs) // 2]
    mag = float(ch) / max(bh_mid, 1.0)
    f_can = int(round(feat * mag))
    f_can = max(1, min(f_can, max(1, ch // 3)))
    return max(dil, f_can)


def _align_refined_crops(
    refined: torch.Tensor, transform: dict, src_crops: torch.Tensor | None = None,
) -> torch.Tensor:
    """精修后再抓脸，按原裁切脸框做平移+小幅缩放，贴回才贴得住。"""
    import torch.nn.functional as F
    import comfy.model_management as mm

    if not isinstance(refined, torch.Tensor) or refined.ndim != 4 or refined.numel() == 0:
        return refined
    face_rects = transform.get("face_rect") or []
    ch, cw = int(refined.shape[1]), int(refined.shape[2])
    n = int(refined.shape[0])
    use_src = None
    if src_crops is not None and isinstance(src_crops, torch.Tensor) and src_crops.ndim == 4:
        if int(src_crops.shape[1]) == ch and int(src_crops.shape[2]) == cw:
            use_src = src_crops
            n = min(n, int(src_crops.shape[0]))
    if face_rects:
        n = min(n, len(face_rects))
    if n <= 0:
        return refined
    model = _get_dwpose()
    ocx = [0.0] * n
    ocy = [0.0] * n
    dcx = [0.0] * n
    dcy = [0.0] * n
    scales = [1.0] * n
    ok_mask = [False] * n
    n_ok = 0
    max_shift = 0.0
    max_scale = 1.0
    min_scale = 1.0
    try:
        import comfy.utils
        pbar = comfy.utils.ProgressBar(n)
    except Exception:
        pbar = None
    for i in range(n):
        mm.throw_exception_if_processing_interrupted()
        tgt = None
        if use_src is not None and i < int(use_src.shape[0]):
            tgt = _largest_face_on_image(use_src[i], cw, ch, model)
        if tgt is None and i < len(face_rects):
            tgt = _rect_from_face_rect(face_rects[i])
        cur = _largest_face_on_image(refined[i], cw, ch, model)
        if tgt is not None and cur is not None:
            tcx, tcy, _tw, th = tgt
            ccx, ccy, _cw0, ch0 = cur
            lim = 0.35 * max(float(th), 8.0)
            dx = max(-lim, min(lim, float(tcx) - float(ccx)))
            dy = max(-lim, min(lim, float(tcy) - float(ccy)))
            sc = float(th) / max(float(ch0), 1.0)
            sc = max(0.96, min(1.06, sc))
            ocx[i] = float(ccx) + dx
            ocy[i] = float(ccy) + dy
            dcx[i] = float(ccx)
            dcy[i] = float(ccy)
            scales[i] = sc
            ok_mask[i] = True
            n_ok += 1
            max_shift = max(max_shift, abs(dx), abs(dy))
            max_scale = max(max_scale, sc)
            min_scale = min(min_scale, sc)
        elif tgt is not None:
            ocx[i], ocy[i] = float(tgt[0]), float(tgt[1])
            dcx[i], dcy[i] = float(tgt[0]), float(tgt[1])
            ok_mask[i] = True
        if pbar is not None:
            pbar.update(1)
    if n >= 3 and n_ok > 0:
        import numpy as np

        def _fill_then_smooth(vals, window=15):
            a = np.asarray(vals, dtype=np.float64)
            mask = np.asarray(ok_mask, dtype=bool)
            if mask.any() and not mask.all():
                idx = np.arange(len(a))
                good = idx[mask]
                a = np.interp(idx, good, a[good])
            return _gauss_smooth_1d(a, window)

        ocx = _fill_then_smooth(ocx).tolist()
        ocy = _fill_then_smooth(ocy).tolist()
        dcx = _fill_then_smooth(dcx).tolist()
        dcy = _fill_then_smooth(dcy).tolist()
        scs = np.clip(_fill_then_smooth(scales), 0.96, 1.06)
        if float(scs.max()) / max(float(scs.min()), 1e-6) < 1.04:
            scs[:] = float(np.median(scs))
        scales = scs.tolist()
        max_scale = float(scs.max())
        min_scale = float(scs.min())
        max_shift = 0.0
        for i in range(n):
            max_shift = max(max_shift, abs(ocx[i] - dcx[i]), abs(ocy[i] - dcy[i]))
    need_warp = n_ok > 0 and (max_shift >= 1.5 or max_scale > 1.02 or min_scale < 0.98)
    if not need_warp:
        log.info(
            "[Lazy二采修脸] 贴回对齐：无需变换（有效=%d 最大偏移=%.1fpx 缩放=%.3f–%.3f）",
            n_ok, max_shift, min_scale, max_scale,
        )
        return refined
    work = refined[:n, ..., :3].detach().float().cpu()
    ys = torch.linspace(-1, 1, ch, dtype=torch.float32)
    xs = torch.linspace(-1, 1, cw, dtype=torch.float32)
    try:
        grid_y, grid_x = torch.meshgrid(ys, xs, indexing="ij")
    except TypeError:
        grid_y, grid_x = torch.meshgrid(ys, xs)
    grid = torch.stack([grid_x, grid_y], dim=-1).unsqueeze(0).repeat(n, 1, 1, 1)
    x_out = (grid[..., 0] + 1.0) * 0.5 * float(max(cw - 1, 1))
    y_out = (grid[..., 1] + 1.0) * 0.5 * float(max(ch - 1, 1))
    s = torch.tensor(scales, dtype=torch.float32).view(n, 1, 1).clamp(min=1e-3)
    tcx = torch.tensor(ocx, dtype=torch.float32).view(n, 1, 1)
    tcy = torch.tensor(ocy, dtype=torch.float32).view(n, 1, 1)
    ccx = torch.tensor(dcx, dtype=torch.float32).view(n, 1, 1)
    ccy = torch.tensor(dcy, dtype=torch.float32).view(n, 1, 1)
    x_in = (x_out - tcx) / s + ccx
    y_in = (y_out - tcy) / s + ccy
    grid[..., 0] = x_in * (2.0 / max(cw - 1, 1)) - 1.0
    grid[..., 1] = y_in * (2.0 / max(ch - 1, 1)) - 1.0
    t = work.permute(0, 3, 1, 2).contiguous()
    aligned = F.grid_sample(t, grid, mode="bilinear", padding_mode="border", align_corners=True)
    aligned = aligned.permute(0, 2, 3, 1)
    out = refined.clone()
    out[:n, ..., :3] = aligned.to(device=refined.device, dtype=refined.dtype)
    log.info(
        "[Lazy二采修脸] 贴回对齐：%d/%d 帧，最大平移 %.1fpx 缩放=%.3f–%.3f",
        n_ok, n, max_shift, min_scale, max_scale,
    )
    return out.contiguous()


def _push_face_preview(crops, node_id, fps: float = 12.0) -> None:
    """把跟踪到的脸裁切推到修脸节点底部预览。跟踪完成后立刻发，不必等精修结束。"""
    try:
        import os
        import time
        import numpy as np
        import torch.nn.functional as F
        from PIL import Image
        import folder_paths

        if not isinstance(crops, torch.Tensor) or crops.ndim != 4 or crops.numel() == 0:
            return
        n, h, w, _ = crops.shape
        max_side = 320
        max_frames = 64
        step = max(1, (int(n) + max_frames - 1) // max_frames)
        idx = list(range(0, int(n), step))[:max_frames]
        t = crops[idx, ..., :3].detach().float().clamp(0, 1).cpu()
        if max(int(h), int(w)) > max_side:
            t = t.permute(0, 3, 1, 2).contiguous()
            if int(h) >= int(w):
                nh, nw = max_side, max(1, int(round(int(w) * max_side / max(int(h), 1))))
            else:
                nw, nh = max_side, max(1, int(round(int(h) * max_side / max(int(w), 1))))
            t = F.interpolate(t, size=(nh, nw), mode="bilinear", align_corners=False)
            t = t.permute(0, 2, 3, 1).contiguous()
        arr = (t.numpy() * 255.0).clip(0, 255).astype(np.uint8)
        frames = [Image.fromarray(arr[i], mode="RGB") for i in range(arr.shape[0])]
        if not frames:
            return
        temp = folder_paths.get_temp_directory()
        os.makedirs(temp, exist_ok=True)
        stamp = int(time.time() * 1000) % 100000000
        nid = "".join(ch for ch in str(node_id or "x") if ch.isalnum() or ch in "-_")[:24] or "x"
        filename = f"lazy_face_{nid}_{stamp}.webp"
        path = os.path.join(temp, filename)
        duration = max(50, int(round(1000.0 / max(8.0, float(fps) / float(step)))))
        try:
            frames[0].save(
                path,
                format="WEBP",
                save_all=True,
                append_images=frames[1:],
                duration=duration,
                loop=0,
                lossless=False,
                quality=70,
                method=0,
            )
        except Exception:
            filename = f"lazy_face_{nid}_{stamp}.gif"
            path = os.path.join(temp, filename)
            frames[0].save(
                path,
                format="GIF",
                save_all=True,
                append_images=frames[1:],
                duration=duration,
                loop=0,
                optimize=True,
            )
        payload = {
            "node_id": str(node_id or ""),
            "filename": filename,
            "subfolder": "",
            "type": "temp",
            "frames": int(n),
            "shown": int(len(frames)),
        }
        try:
            from server import PromptServer
            inst = getattr(PromptServer, "instance", None)
            if inst is not None:
                inst.send_sync("lazy_face_preview", payload)
        except Exception:
            pass
        log.info("[Lazy二采修脸] 预览已推送 跟踪帧=%d 预览帧=%d", int(n), len(frames))
    except Exception as e:
        log.warning("[Lazy二采修脸] 预览推送失败: %s", e)


def _sample_denoise(model, positive, latent, seed, steps, sampler_name, scheduler, denoise):
    """FaceRefine 半程精修：denoise<1 的 Guider 采样。"""
    import comfy.model_management
    import comfy.sample
    import comfy.samplers
    import comfy.utils
    import latent_preview

    from .lazy_h3_sequential import (
        _as_latent_dict,
        _assert_nested_av,
        _calc_sigmas,
        _has_native_av_schedule,
        _is_comfy_nested,
        _make_basic_guider,
    )

    if sampler_name not in comfy.samplers.KSampler.SAMPLERS:
        sampler_name = "er_sde" if "er_sde" in comfy.samplers.KSampler.SAMPLERS else "euler"
    if scheduler not in comfy.samplers.KSampler.SCHEDULERS:
        scheduler = "simple"

    latent = _as_latent_dict(latent)
    latent = dict(latent)
    latent_image = latent["samples"]
    _assert_nested_av(latent_image, "脸修采样前")

    guider = _make_basic_guider(model, positive)
    patcher = getattr(guider, "model_patcher", None) or model
    try:
        latent_image = comfy.sample.fix_empty_latent_channels(
            patcher,
            latent_image,
            latent.get("downscale_ratio_spacial", None),
            latent.get("downscale_ratio_temporal", None),
        )
        latent["samples"] = latent_image
    except Exception:
        pass

    sigmas = _calc_sigmas(model, scheduler, int(steps), denoise=float(denoise))
    if sigmas is None or (torch.is_tensor(sigmas) and sigmas.numel() < 2):
        raise RuntimeError("脸修 sigmas 异常")

    sampler = comfy.samplers.sampler_object(sampler_name)
    noise = comfy.sample.prepare_noise(latent_image, int(seed), latent.get("batch_index", None))
    noise_mask = latent.get("noise_mask", None)
    try:
        n_cb = max(1, int(sigmas.shape[-1]) - 1)
    except Exception:
        n_cb = max(1, int(steps))
    callback = latent_preview.prepare_callback(patcher, n_cb)
    disable_pbar = not comfy.utils.PROGRESS_BAR_ENABLED

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
    try:
        samples = samples.to(
            device=comfy.model_management.intermediate_device(),
            dtype=comfy.model_management.intermediate_dtype(),
        )
    except Exception:
        pass
    _assert_nested_av(samples, "脸修采样后")
    out = dict(latent)
    out.pop("downscale_ratio_spacial", None)
    out.pop("downscale_ratio_temporal", None)
    out["samples"] = samples
    return out


def _strip_continue_prompt(prompt: str) -> str:
    """去掉一采续接指令，避免二采跟着钉上一段。"""
    lines = []
    for ln in str(prompt or "").splitlines():
        s = ln.strip()
        if not s:
            continue
        low = s.lower()
        if "continue seamlessly" in low or "frames continuity" in low:
            continue
        if "previous motion" in low:
            continue
        lines.append(ln)
    return "\n".join(lines).strip()


def apply_face_refine_cfg(
    frames: torch.Tensor,
    *,
    cfg: dict | None,
    model,
    clip,
    video_vae,
    audio_vae=None,
    audio: dict | None = None,
    prompt: str = "",
    ref_images=None,
    seed: int = 0,
    fps: float = 24.0,
) -> torch.Tensor:
    """
    对一段 IMAGE 做 H3 二采修脸。cfg 无效/关闭则原样返回。
    """
    if not cfg or not isinstance(cfg, dict):
        return frames
    node_id = cfg.get("_node_id")
    cfg = sanitize_face_refine_params(cfg)
    if node_id:
        cfg["_node_id"] = str(node_id)
    if not bool(cfg.get("启用", True)):
        return frames
    if frames is None or not isinstance(frames, torch.Tensor) or frames.ndim != 4:
        return frames
    if model is None or clip is None or video_vae is None:
        log.warning("[Lazy二采修脸] 缺模型/CLIP/VAE，跳过")
        return frames

    from .lazy_h3_common import h3_snap_length
    from .lazy_h3_sequential import (
        _decode_video,
        _force_video_len,
        _h3_image_to_video_cond,
        _h3_ref_to_video_cond,
    )

    # 全部按用户配置（已纠错），不强制覆盖
    detector = str(cfg["检测器"])
    confidence = float(cfg["置信度"])
    crop_factor = float(cfg["裁切倍率"])
    canvas_w = int(cfg["画布宽"])
    canvas_h = int(cfg["画布高"])
    canvas_mode = str(cfg["画布模式"])
    steps = int(cfg["步数"])
    denoise = float(cfg["重绘幅度"])
    sampler_name = str(cfg["采样器"])
    scheduler = str(cfg["调度器"])
    mul_small = float(cfg["小脸降噪倍率"])
    mul_large = float(cfg["大脸降噪倍率"])
    feather = int(cfg["贴回羽化"])
    dilation = int(cfg["贴回膨胀"])
    blend = float(cfg["贴回混合"])
    want_ref_face = bool(cfg.get("参考脸", False))
    id_thr = float(cfg["身份阈值"])
    face_side = str(cfg.get("选脸") or "自动")
    if face_side not in _FACE_SIDES:
        face_side = "自动"
    h3_select = _H3_SELECT_BY_SIDE[face_side]
    smooth_window = _odd_win(cfg.get("位置平滑", 21), 1, 201)
    size_smooth_window = _odd_win(cfg.get("尺寸平滑", 51), 1, 201)
    smooth_method = _SMOOTH_METHOD_H3.get(str(cfg.get("平滑方式") or "高斯"), "gaussian")
    size_mode = _SIZE_MODE_H3.get(str(cfg.get("尺寸模式") or "逐帧"), "per_frame")
    scale_mode = _FACE_SCALE_H3.get(str(cfg.get("脸大小模式") or "相对本段"), "relative_to_clip")
    face_px_small = float(cfg.get("小脸像素", 70.0))
    face_px_large = float(cfg.get("大脸像素", 160.0))
    gamma = float(cfg.get("小脸偏向", 0.8))
    denoise_smooth = _odd_win(cfg.get("降噪平滑", 21), 1, 61)
    face_px_clear = float(cfg.get("满修脸高", 80.0))
    large_floor = float(cfg.get("强化保底", 0.45))
    motion_lo = float(cfg.get("快动起步", 0.05))
    motion_hi = float(cfg.get("快动满速", 0.20))
    motion_floor = float(cfg.get("快动保底", 0.30))
    paste_region = _PASTE_REGION_H3.get(str(cfg.get("贴回范围") or "仅脸"), "face_only")
    colour_match = float(cfg.get("贴回校色", 1.0))
    undetected = _UNDETECTED_H3.get(str(cfg.get("漏检处理") or "淡出"), "fade_out")

    try:
        Track = _get_fr_cls("H3FaceTrackCrop")
        Inject = _get_fr_cls("H3InjectVideoLatent")
        Denoise = _get_fr_cls("H3PerFrameDenoise")
        Stitch = _get_fr_cls("H3FaceStitch")
    except Exception as e:
        log.warning("[Lazy二采修脸] 加载 FaceRefine 失败，跳过: %s", e)
        return frames

    use_dwpose = detector.strip().lower() == "dwpose"
    id_ref = _first_ref_image(ref_images) if want_ref_face else None
    use_identity = id_ref is not None
    if want_ref_face and id_ref is None:
        log.warning("[Lazy二采修脸] 已开「参考脸」但无参考图，参考脸无效，只做二采修复")

    n_in = int(frames.shape[0])
    # 二采只修本段画面，不用一采的运动续接（不加长、不钉上一段 latent）
    prompt = _strip_continue_prompt(prompt)
    log.info(
        "[Lazy二采修脸] 开始 帧=%d detector=%s 选脸=%s canvas=%s denoise=%.2f steps=%d 参考二采=%s 阈值=%.2f（忽略续接）",
        n_in, detector, face_side, canvas_mode, denoise, steps,
        "是" if use_identity else "否", id_thr,
    )

    # 1) 检脸裁切：DWPose 出框后交给 H3 平滑裁切；有参考图则身份锁定
    track = Track()
    track_kw = dict(
        images=frames,
        detector=detector,
        confidence=confidence,
        crop_factor=crop_factor,
        canvas_width=canvas_w,
        canvas_height=canvas_h,
        canvas_mode=canvas_mode,
        smooth_window=smooth_window,
        size_smooth_window=size_smooth_window,
        smooth_method=smooth_method,
        size_mode=size_mode,
        identity_track=True if use_identity else (not use_dwpose),
        identity_threshold=id_thr,
        identity_model="insightface",
        select=h3_select,
        absent_shots="by_identity" if use_identity else "off",
    )
    dwpose_det = None
    # 选脸非自动时必须先出框再按区域过滤；YOLO 路径无法按区域裁检测结果
    use_dwpose_pick = use_dwpose or face_side != "自动"
    if use_dwpose_pick:
        try:
            dwpose_det = _dwpose_detect_faces(frames, confidence)
        except Exception as e:
            if use_dwpose:
                log.warning("[Lazy二采修脸] DWPose 抓脸失败，跳过: %s", e)
                return frames
            log.warning("[Lazy二采修脸] 选脸区域抓脸失败，改全画布: %s", e)
            dwpose_det = None
        if use_dwpose and not dwpose_det:
            return frames
        if dwpose_det:
            face_pick = _dwpose_face_pick_from_det(
                dwpose_det, keep_all=use_identity, side=face_side,
            )
            if not face_pick:
                return frames
            track_kw["face_pick"] = face_pick
            if use_identity:
                log.info(
                    "[Lazy二采修脸] DWPose：参考二采，%s找脸后身份锁定",
                    "全画布" if face_side == "自动" else f"区域={face_side}",
                )
            else:
                log.info("[Lazy二采修脸] DWPose：二采修复，每帧 1 张（选脸=%s）", face_side)
    if use_identity:
        track_kw["identity_reference"] = id_ref
    try:
        out = track.run(**track_kw)
    except Exception as e:
        msg = str(e)
        ident_dead = (
            use_identity
            and ("not containing the subject" in msg or "Every shot is marked" in msg)
        )
        if ident_dead:
            fallback = f"选脸={face_side}"
            log.warning("[Lazy二采修脸] 参考脸全灭，回退%s: %s", fallback, e)
            track_kw.pop("identity_reference", None)
            track_kw["identity_track"] = False
            track_kw["absent_shots"] = "off"
            if dwpose_det is not None:
                face_pick = _dwpose_face_pick_from_det(
                    dwpose_det, keep_all=False, side=face_side,
                )
                if not face_pick:
                    return frames
                track_kw["face_pick"] = face_pick
            try:
                out = track.run(**track_kw)
            except Exception as e2:
                log.warning("[Lazy二采修脸] 检脸裁切失败，跳过: %s", e2)
                return frames
        else:
            log.warning("[Lazy二采修脸] 检脸裁切失败，跳过: %s", e)
            return frames
    crops, xform = out[0], out[1]
    cw, ch, n = int(out[4]), int(out[5]), int(out[6])
    _push_face_preview(crops, cfg.get("_node_id"), fps=fps)

    cw, ch, n = int(cw), int(ch), int(n)
    # 对齐 H3 帧网格
    n_snap = h3_snap_length(n, fps, False)
    if n_snap != n and isinstance(crops, torch.Tensor) and crops.shape[0] > 0:
        if crops.shape[0] < n_snap:
            pad = crops[-1:].repeat(n_snap - crops.shape[0], 1, 1, 1)
            crops = torch.cat([crops, pad], dim=0)
        else:
            crops = crops[:n_snap]
        n = n_snap

    prompt = (prompt or "").strip() or "high quality face, sharp eyes, natural skin, detailed features"

    # 2) 条件 + 空 AV latent（画布尺寸）
    # 参考二采：参考脸开且有参考图。否则二采修复（裁切首帧 i2v）。
    try:
        if use_identity:
            positive, av = _h3_ref_to_video_cond(
                clip, video_vae, prompt, width=cw, height=ch, length=n,
                ref_images=ref_images, audio_vae=audio_vae,
                ref_image_size="match",
                ref_audios={"ref_audio_0": audio} if isinstance(audio, dict) else None,
            )
        else:
            first = crops[:1] if isinstance(crops, torch.Tensor) else None
            positive, av = _h3_image_to_video_cond(
                clip, video_vae, first, None, prompt, cw, ch, n,
            )
    except Exception as e:
        log.warning("[Lazy二采修脸] 建条件失败，跳过: %s", e)
        return frames

    # 3) 注入真实人脸 crop
    try:
        av, _inj = Inject().run(av_latent=av, images=crops, vae=video_vae)
    except Exception as e:
        log.warning("[Lazy二采修脸] 注入 latent 失败: %s", e)
        return frames

    # 4) 锁音
    use_model = model
    if audio_vae is not None and isinstance(audio, dict) and audio.get("waveform") is not None:
        try:
            use_model, av, _ = _native_audio_lock(use_model, av, audio_vae, audio)
        except Exception as e:
            log.warning("[Lazy二采修脸] 锁音失败，继续: %s", e)

    # 5) 按脸大小降噪（官方节点）+ 小脸强制强化 noise_mask（兼容无 _denoise_mask_conds 的 H3）
    try:
        av, drep, use_model = Denoise().run(
            model=use_model,
            av_latent=av,
            transform=xform,
            denoise_multiplier_small_face=mul_small,
            denoise_multiplier_large_face=mul_large,
            scale_mode=scale_mode,
            face_px_small=face_px_small,
            face_px_large=face_px_large,
            gamma=gamma,
            smooth_frames=denoise_smooth,
        )
        if isinstance(drep, str) and "no denoise mask" in drep:
            log.warning(
                "[Lazy二采修脸] 模型无 denoise_mask API，改用 latent.noise_mask 强化小脸"
            )
    except Exception as e:
        log.warning("[Lazy二采修脸] PerFrameDenoise 失败，继续强化 mask: %s", e)

    # 无论官方补丁是否生效，都再推一把小脸 mask
    av = _boost_small_face_noise_mask(
        av, xform, face_px_clear=face_px_clear, large_floor=large_floor,
    )
    av = _apply_motion_denoise_scale(
        av, xform, lo=motion_lo, hi=motion_hi, floor=motion_floor,
    )

    # 6) 半程采样（提高基础重绘，小脸才能修清楚）
    try:
        out_latent = _sample_denoise(
            use_model, positive, av, seed, steps, sampler_name, scheduler, denoise,
        )
        refined_crops = _decode_video(video_vae, out_latent)
    except Exception as e:
        log.warning("[Lazy二采修脸] 采样/解码失败，跳过: %s", e)
        return frames

    try:
        n_boxes = len(xform.get("boxes") or [])
        src_for_align = crops
        if n_boxes > 0:
            if isinstance(refined_crops, torch.Tensor) and int(refined_crops.shape[0]) > n_boxes:
                refined_crops = refined_crops[:n_boxes].contiguous()
            if isinstance(crops, torch.Tensor) and int(crops.shape[0]) > n_boxes:
                src_for_align = crops[:n_boxes]
        refined_crops = _align_refined_crops(refined_crops, xform, src_crops=src_for_align)
    except Exception as e:
        log.warning("[Lazy二采修脸] 贴回对齐失败，用未对齐结果: %s", e)

    # 7) 贴回
    try:
        dil_used = _stitch_mask_dilation(xform, feather, dilation)
        if dil_used != dilation:
            log.info(
                "[Lazy二采修脸] 贴回膨胀 %d→%d（避免羽化吃进脸心）",
                dilation, dil_used,
            )
        stitched = Stitch().run(
            base_images=frames,
            refined_crops=refined_crops,
            transform=xform,
            paste_region=paste_region,
            mask_dilation=dil_used,
            feather=feather,
            colour_match=colour_match,
            blend=blend,
            undetected_frames=undetected,
        )
        out = stitched[0] if isinstance(stitched, (tuple, list)) else stitched
        if not isinstance(out, torch.Tensor):
            return frames
        out = _force_video_len(out, n_in)
        log.info("[Lazy二采修脸] 完成 → %s", tuple(out.shape))
        return out.float().clamp(0, 1).contiguous()
    except Exception as e:
        log.warning("[Lazy二采修脸] 贴回失败: %s", e)
        return frames


class LazyFaceRefine:
    """二采修脸配置包：接 Lazy H3 逐段生成「脸修」口。"""

    @classmethod
    def INPUT_TYPES(cls):
        dets = _detector_choices()
        default_det = "DWPose"
        if default_det not in dets and dets:
            default_det = dets[0]
        return {
            "required": {
                "启用": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "开：逐段生成后做人脸二采精修。",
                }),
                "参考脸": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "开：有参考图时按参考脸做二采。无参考图时无效，只做二采修复。",
                }),
                "身份阈值": ("FLOAT", {
                    "default": 0.35, "min": 0.0, "max": 1.0, "step": 0.01,
                    "tooltip": "参考脸匹配门槛。调高：更严、不易认错但易跟丢。调低：更容易跟上，也可能认错脸。",
                }),
                "检测器": (dets, {
                    "default": default_det,
                    "tooltip": "抓脸方式。DWPose 用姿态脸关键点；也可选手动 YOLO 人脸模型。",
                }),
                "置信度": ("FLOAT", {
                    "default": 0.35, "min": 0.05, "max": 0.95, "step": 0.05,
                    "tooltip": "检测置信度门槛。调高：只认更确定的脸，漏检变多。调低：更容易抓到脸，误检也变多。",
                }),
                "裁切倍率": ("FLOAT", {
                    "default": 2.5, "min": 1.2, "max": 8.0, "step": 0.1,
                    "tooltip": "脸高倍数，决定裁切视野。调高：裁更大、带更多周围。调低：更贴脸、修得更集中。",
                }),
                "画布宽": ("INT", {
                    "default": 768, "min": 128, "max": 1344, "step": 32,
                    "tooltip": "修脸画布宽。调高：更清晰、更吃显存。调低：更快但细节变差。小脸建议 768。",
                }),
                "画布高": ("INT", {
                    "default": 768, "min": 128, "max": 1344, "step": 32,
                    "tooltip": "修脸画布高。调高：更清晰、更吃显存。调低：更快但细节变差。小脸建议 768。",
                }),
                "画布模式": (["manual", "auto_no_downscale", "auto_capped_768"], {
                    "default": "manual",
                    "tooltip": "画布策略。小脸修清楚请用 manual + 768。",
                }),
                "步数": ("INT", {
                    "default": 8, "min": 1, "max": 40, "step": 1,
                    "tooltip": "二采采样步数。调高：修得更充分、更慢。调低：更快、修得更浅。加速 LoRA 常用 8。",
                }),
                "重绘幅度": ("FLOAT", {
                    "default": 0.55, "min": 0.05, "max": 1.0, "step": 0.05,
                    "tooltip": "基础重绘强度。调高：改得更多、更清楚，也更容易走样。调低：更保原片、修得更浅。小脸建议 0.5～0.65。",
                }),
                "采样器": (["er_sde", "res_multistep", "euler", "dpmpp_2m"], {
                    "default": "er_sde",
                    "tooltip": "二采采样器。",
                }),
                "调度器": (["simple", "normal", "karras", "sgm_uniform"], {
                    "default": "simple",
                    "tooltip": "二采调度器。",
                }),
                "小脸降噪倍率": ("FLOAT", {
                    "default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05,
                    "tooltip": "小脸精修倍率。调高：小脸修得更狠。调低：小脸少改。一般保持 1.0。",
                }),
                "大脸降噪倍率": ("FLOAT", {
                    "default": 0.30, "min": 0.0, "max": 1.0, "step": 0.05,
                    "tooltip": "大脸精修倍率。调高：特写也多修。调低：特写更少改、更保原片。",
                }),
                "贴回羽化": ("INT", {
                    "default": 6, "min": 0, "max": 256, "step": 2,
                    "tooltip": "贴回边缘羽化。调高：边缘更柔、更不易露边。调低：边缘更硬、更容易有接缝。",
                }),
                "贴回膨胀": ("INT", {
                    "default": 16, "min": 0, "max": 256, "step": 2,
                    "tooltip": "脸部蒙版膨胀。调高：贴回范围更大。调低：更贴脸、周围少改。",
                }),
                "贴回混合": ("FLOAT", {
                    "default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05,
                    "tooltip": "贴回不透明度。调高：精修盖得更实。调低：更多保留原片。",
                }),
                "选脸": (_FACE_SIDES, {
                    "default": "自动",
                    "tooltip": "自动：全画布找脸。左/中间/右：只在该区域找脸。",
                }),
                "位置平滑": ("INT", {
                    "default": 21, "min": 1, "max": 201, "step": 2,
                    "tooltip": "裁切中心平滑帧数。调高：更稳、少抖，跟动变钝。调低：跟得更紧，更容易抖。",
                }),
                "尺寸平滑": ("INT", {
                    "default": 51, "min": 1, "max": 201, "step": 2,
                    "tooltip": "裁切尺寸平滑帧数。调高：大小更稳、少呼吸。调低：大小跟得更紧，更容易一缩一放。",
                }),
                "平滑方式": (_SMOOTH_METHODS, {
                    "default": "高斯",
                    "tooltip": "裁切轨迹平滑算法。",
                }),
                "尺寸模式": (_SIZE_MODES, {
                    "default": "逐帧",
                    "tooltip": "裁切尺寸计算方式。",
                }),
                "脸大小模式": (_FACE_SCALE_MODES, {
                    "default": "相对本段",
                    "tooltip": "按脸大小分配降噪的方式。",
                }),
                "小脸像素": ("FLOAT", {
                    "default": 70.0, "min": 4.0, "max": 400.0, "step": 1.0,
                    "tooltip": "小脸高度阈值。调高：更多脸按小脸多修。调低：只有更小的脸才加强修。",
                }),
                "大脸像素": ("FLOAT", {
                    "default": 160.0, "min": 8.0, "max": 800.0, "step": 1.0,
                    "tooltip": "大脸高度阈值。调高：要更大才当大脸少改。调低：更容易被当大脸、少改。",
                }),
                "小脸偏向": ("FLOAT", {
                    "default": 0.8, "min": 0.2, "max": 4.0, "step": 0.1,
                    "tooltip": "脸大小到降噪的曲线。调高：中等脸也保持多修。调低：脸稍大就开始少改。",
                }),
                "降噪平滑": ("INT", {
                    "default": 21, "min": 1, "max": 61, "step": 2,
                    "tooltip": "降噪强度时序平滑帧数。调高：帧间修脸强度更稳。调低：跟脸大小变化更紧，更容易闪。",
                }),
                "满修脸高": ("FLOAT", {
                    "default": 80.0, "min": 8.0, "max": 400.0, "step": 1.0,
                    "tooltip": "低于此脸高强制满修。调高：更多中等脸也满修。调低：只有更小的脸才强制满修。",
                }),
                "强化保底": ("FLOAT", {
                    "default": 0.45, "min": 0.0, "max": 1.0, "step": 0.05,
                    "tooltip": "大脸强化遮罩最低权重。调高：大脸也会被多修。调低：大脸更少改、更保原片。",
                }),
                "快动起步": ("FLOAT", {
                    "default": 0.05, "min": 0.0, "max": 1.0, "step": 0.01,
                    "tooltip": "开始压低重绘的运动速度。调高：要动得更快才开始少改。调低：轻微晃动就开始少改。",
                }),
                "快动满速": ("FLOAT", {
                    "default": 0.20, "min": 0.01, "max": 2.0, "step": 0.01,
                    "tooltip": "压到保底的运动速度。调高：要甩得更猛才压到最低。调低：中等速度就压到最低。",
                }),
                "快动保底": ("FLOAT", {
                    "default": 0.30, "min": 0.0, "max": 1.0, "step": 0.05,
                    "tooltip": "快转时最低重绘比例。调高：快转时仍多修，更容易糊。调低：快转时更少改、更保原片。",
                }),
                "贴回范围": (_PASTE_REGIONS, {
                    "default": "仅脸",
                    "tooltip": "精修结果贴回范围。",
                }),
                "贴回校色": ("FLOAT", {
                    "default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05,
                    "tooltip": "贴回时颜色匹配强度。调高：更贴原片颜色。调低：更保留精修后的颜色。",
                }),
                "漏检处理": (_UNDETECTED_MODES, {
                    "default": "淡出",
                    "tooltip": "没抓到脸的帧如何贴回。",
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = (LAZY_FACE_REFINE_CFG,)
    RETURN_NAMES = ("配置包",)
    FUNCTION = "run"
    CATEGORY = "Lazy/H3"
    DESCRIPTION = "Lazy 二采修脸 · 配置包接 H3 逐段"

    def run(self, **kwargs):
        return (build_face_refine_cfg(kwargs),)


NODE_CLASS_MAPPINGS = {
    "LazyFaceRefine": LazyFaceRefine,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LazyFaceRefine": "Lazy 二采修脸",
}
