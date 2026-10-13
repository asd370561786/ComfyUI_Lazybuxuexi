"""
Lazy H3 导演台：完整时间线 UI 与 Wan 导演台同源。
双模型入口（分镜 fl2va / 多参 ref2va）+ 工作台模式；不修改 Wan 节点。
"""
from __future__ import annotations

import json
import logging

import torch
from comfy_api.latest import io

from .wan_director import (
    GuideData,
    WanRemixDirector,
    ensure_director_routes,
    _load_image_tensor,
    _load_video_tensor,
    _resolve_input_media_path,
    _resize_image,
    _normalize_resize_method,
)
from .lazy_h3_common import (
    H3_FPS_DEFAULT,
    H3_MAX_SECONDS,
    H3_MODE_REF,
    H3_MODE_STORYBOARD,
    h3_frames_to_seconds,
    h3_snap_length,
    h3_snap_report,
    normalize_workspace_mode,
    tensor_has_image,
)

log = logging.getLogger(__name__)

# 多参参考图短边上限（与官方 ref_image_size=max 一致）
H3_REF_MAX_SHORT = 2048


def _snap32(v: int) -> int:
    return max(32, int(v) // 32 * 32)


def prepare_h3_ref_image_tensor(
    tensor: torch.Tensor,
    *,
    target_w: int = 0,
    target_h: int = 0,
    max_short: int = H3_REF_MAX_SHORT,
) -> torch.Tensor:
    """
    多参参考图预处理（禁止 stretch）：
    1) 短边 > max_short → 等比缩小到短边 = max_short
    2) 若给定生成宽高：画布按生成比例；一边铺满、另一边居中黑边 pad
    画布短边取 min(max_short, max(图短边, 生成短边))，避免无谓压小脸
    """
    if not tensor_has_image(tensor):
        return tensor
    t = tensor
    if t.ndim == 3:
        t = t.unsqueeze(0)
    t = t[0:1].contiguous()

    h0, w0 = int(t.shape[1]), int(t.shape[2])
    src = (h0, w0)
    max_short = max(256, int(max_short or H3_REF_MAX_SHORT))

    # ① 短边限幅
    short = min(h0, w0)
    if short > max_short:
        scale = max_short / float(short)
        nh = max(32, int(round(h0 * scale)))
        nw = max(32, int(round(w0 * scale)))
        # maintain：按目标框等比缩（目标框取缩放后尺寸）
        t = _resize_image(t, _snap32(nw), _snap32(nh), "maintain aspect ratio", 32)
        h0, w0 = int(t.shape[1]), int(t.shape[2])

    # ② 比例 pad（有生成尺寸时）
    tw = int(target_w or 0)
    th = int(target_h or 0)
    if tw >= 64 and th >= 64:
        ar = float(tw) / float(th)
        img_short = min(h0, w0)
        gen_short = min(tw, th)
        # 画布短边：不小于生成短边、不小于当前图短边、不超过 max_short
        canvas_short = min(max_short, max(img_short, gen_short, 256))
        canvas_short = _snap32(int(round(canvas_short)))
        if ar >= 1.0:
            # 横图比例：高为短边
            ch = canvas_short
            cw = _snap32(int(round(ch * ar)))
        else:
            cw = canvas_short
            ch = _snap32(int(round(cw / ar)))
        # 一边铺满 + 黑边（_resize_image pad）
        before = (int(t.shape[1]), int(t.shape[2]))
        t = _resize_image(t, cw, ch, "pad", 32)
        log.info(
            "[LazyH3] 参考图预处理: 原=%sx%s → 限幅后≈%sx%s → pad画布=%sx%s (目标比例 %dx%d)",
            src[1],
            src[0],
            before[1],
            before[0],
            int(t.shape[2]),
            int(t.shape[1]),
            tw,
            th,
        )
    else:
        # 无目标尺寸：仅 32 对齐，不改比例
        nh, nw = _snap32(h0), _snap32(w0)
        if nh != h0 or nw != w0:
            t = _resize_image(t, nw, nh, "maintain aspect ratio", 32)
        log.info(
            "[LazyH3] 参考图预处理: 原=%sx%s → %sx%s (仅短边限幅/对齐，无目标比例)",
            src[1],
            src[0],
            int(t.shape[2]),
            int(t.shape[1]),
        )

    return t[0:1].contiguous()


def load_h3_multi_ref_images(
    timeline_data,
    *,
    width: int = 0,
    height: int = 0,
    resize_method: str = "maintain aspect ratio",
):
    """
    从 timeline_data.h3MultiRef.images 加载多参图（最多 9 张）。
    返回 dict {'ref_image_0': [1,H,W,3], ...}。

    处理：短边≤2048 等比限幅；若有生成宽高则按比例黑边 pad（绝不 stretch）。
    """
    _ = resize_method
    tdata = timeline_data
    if isinstance(tdata, str):
        try:
            tdata = json.loads(tdata) if tdata.strip() else {}
        except Exception as e:
            log.warning("[LazyH3] timeline_data 解析失败，无法读多参图: %s", e)
            return None
    if not isinstance(tdata, dict):
        return None

    multi = tdata.get("h3MultiRef") or {}
    raw_list = multi.get("images") if isinstance(multi, dict) else None
    if not isinstance(raw_list, list) or not raw_list:
        return None

    tw = max(0, int(width or 0))
    th = max(0, int(height or 0))
    if tw > 0:
        tw = _snap32(tw)
    if th > 0:
        th = _snap32(th)

    # 压实空槽：槽位可能是 [图, null, 图]，按出现顺序对应 Picture 1、2…
    compact = [x for x in raw_list[:9] if x and isinstance(x, dict)]
    if not compact:
        return None
    log.info(
        "[LazyH3] 多参图槽位原始=%d 有效=%d 目标比例=%sx%s",
        len(raw_list),
        len(compact),
        tw or "?",
        th or "?",
    )

    tensors = []
    for i, item in enumerate(compact):
        file_name = (
            item.get("fileName")
            or item.get("imageFile")
            or item.get("name")
            or ""
        )
        if not file_name:
            log.warning("[LazyH3] 多参图#%d 无 fileName，跳过: %s", i + 1, item.get("id"))
            continue
        seg = {
            "imageFile": file_name,
            "fileName": file_name,
            "imageMediaType": item.get("imageMediaType") or item.get("type") or "input",
            "id": item.get("id") or f"multi_ref_{i}",
        }
        try:
            t = _load_image_tensor(seg, required=False)
        except Exception as e:
            log.warning("[LazyH3] 多参图#%d 加载失败 (%s): %s", i + 1, file_name, e)
            continue
        if not tensor_has_image(t):
            log.warning("[LazyH3] 多参图#%d 无效: %s", i + 1, file_name)
            continue
        try:
            t = prepare_h3_ref_image_tensor(
                t, target_w=tw, target_h=th, max_short=H3_REF_MAX_SHORT
            )
        except Exception as e:
            log.warning("[LazyH3] 多参图#%d 预处理失败，跳过: %s", i + 1, e)
            continue
        tensors.append(t)
        log.info(
            "[LazyH3] 多参图#%d ok shape=%s file=%s",
            i + 1,
            tuple(t.shape),
            file_name,
        )

    if not tensors:
        return None

    # 始终 dict：官方节点按 ref_image_0… 独立吃，禁止合成 batch 再 stretch
    ref_dict = {f"ref_image_{i}": tensors[i] for i in range(len(tensors))}
    log.info(
        "[LazyH3] 已加载多参图 %d 张(dict) keys=%s shapes=%s",
        len(ref_dict),
        list(ref_dict.keys()),
        [tuple(v.shape) for v in ref_dict.values()],
    )
    return ref_dict


def _parse_timeline(timeline_data):
    tdata = timeline_data
    if isinstance(tdata, str):
        try:
            tdata = json.loads(tdata) if tdata.strip() else {}
        except Exception:
            return {}
    return tdata if isinstance(tdata, dict) else {}


def load_h3_multi_ref_videos(timeline_data, *, fps: float = 24.0) -> dict | None:
    """加载多参参考视频 → {'ref_video_0': [T,H,W,3], ...} 最多 3 条。
    官方要求：至少 5 帧，帧数对齐 17k+5，约 2–15 秒 @24fps。
    """
    tdata = _parse_timeline(timeline_data)
    multi = tdata.get("h3MultiRef") or {}
    raw_list = multi.get("videos") if isinstance(multi, dict) else None
    if not isinstance(raw_list, list) or not raw_list:
        log.info("[LazyH3] 时间线无多参参考视频")
        return None
    out = {}
    fps = max(1.0, float(fps or 24.0))
    # 最多抽 15s，保证动作参考够用
    max_frames = int(round(15.0 * fps))
    for i, item in enumerate(raw_list[:3]):
        if not item or not isinstance(item, dict):
            continue
        fn = item.get("fileName") or item.get("videoFile") or item.get("name") or ""
        if not fn:
            continue
        dur = float(item.get("duration") or 0)
        want = max_frames if dur <= 0 else min(max_frames, max(5, int(round(dur * fps))))
        # 对齐 17k+5
        want = want + (5 - (want % 17)) % 17
        want = max(5, want)
        seg = {
            "imageFile": fn,
            "videoFile": fn,
            "trimStart": 0,
            "length": want,
            "id": item.get("id") or f"multi_vid_{i}",
        }
        try:
            t = _load_video_tensor(seg, fps, required=False)
        except Exception as e:
            log.warning("[LazyH3] 多参视频#%d 加载失败 (%s): %s", i + 1, fn, e)
            continue
        if t is None or not isinstance(t, torch.Tensor) or t.numel() == 0:
            log.warning("[LazyH3] 多参视频#%d 无帧: %s", i + 1, fn)
            continue
        if t.ndim == 3:
            t = t.unsqueeze(0)
        n = int(t.shape[0])
        if n < 5:
            log.warning("[LazyH3] 多参视频#%d 仅 %d 帧(<5)，官方无法参考动作: %s", i + 1, n, fn)
            continue
        # 对齐到 17k+5
        while n > 5 and n % 17 != 5:
            n -= 1
        t = t[:n].contiguous()
        out[f"ref_video_{i}"] = t
        log.info(
            "[LazyH3] 多参视频#%d ok frames=%d shape=%s file=%s",
            i + 1,
            int(t.shape[0]),
            tuple(t.shape),
            fn,
        )
    if out:
        log.info("[LazyH3] 已加载多参参考视频 %d 条", len(out))
    else:
        log.warning("[LazyH3] 多参参考视频列表有数据但全部加载失败")
    return out or None


def _decode_audio_file(path: str) -> dict | None:
    """解码音频文件 → {waveform[1,C,T], sample_rate}。"""
    try:
        import av
        import numpy as np

        with av.open(path) as container:
            stream = next((s for s in container.streams if s.type == "audio"), None)
            if stream is None:
                return None
            frames = []
            sr = int(stream.rate or 32000)
            for frame in container.decode(stream):
                arr = frame.to_ndarray()
                if arr.ndim == 1:
                    arr = arr.reshape(1, -1)
                frames.append(arr)
            if not frames:
                return None
            wave = np.concatenate(frames, axis=-1).astype(np.float32)
            if wave.max() > 1.5:
                wave = wave / 32768.0
            if wave.shape[0] == 1:
                wave = np.concatenate([wave, wave], axis=0)
            elif wave.shape[0] > 2:
                wave = wave[:2]
            tw = torch.from_numpy(wave).unsqueeze(0)
            return {"waveform": tw, "sample_rate": sr}
    except Exception as e:
        log.warning("[LazyH3] 音频解码失败 %s: %s", path, e)
        return None


def _separate_vocals(audio: dict) -> dict:
    """人声分离（仅对传入切片）；成功返回人声，失败回退原切片。分离后尽量释放显存。"""
    if not isinstance(audio, dict) or "waveform" not in audio:
        return audio
    try:
        import importlib
        import os
        import sys

        import comfy.model_management as mm

        sep_root = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "audio-separation-nodes-comfyui",
        )
        if os.path.isdir(sep_root) and sep_root not in sys.path:
            sys.path.insert(0, sep_root)
        mod = importlib.import_module("src.separation")
        node = mod.AudioSeparation()
        _b, _d, _o, vocals = node.main(audio)
        # 尽快卸分离模型，避免与 H3 叠峰
        try:
            del node, _b, _d, _o
        except Exception:
            pass
        try:
            mm.soft_empty_cache()
        except Exception:
            pass
        if isinstance(vocals, dict) and "waveform" in vocals:
            log.info("[LazyH3] 本段人声已分离（仅切片）")
            return vocals
    except Exception as e:
        log.warning("[LazyH3] 本段人声分离失败，用原切片 | %s", e)
    return audio


def _load_video_audio(seg: dict, fps: float, n_frames: int | None = None) -> dict | None:
    """按主轨视频同一 trim / 帧数抽出原声，供超分/二采/补帧落盘混流。"""
    if not isinstance(seg, dict):
        return None
    fn = seg.get("imageFile") or seg.get("videoFile") or seg.get("fileName") or ""
    if not fn:
        return None
    path = _resolve_input_media_path(fn, "input")
    if not path:
        return None
    decoded = _decode_audio_file(path)
    if decoded is None or decoded.get("waveform") is None:
        return None
    fps = max(1.0, float(fps or H3_FPS_DEFAULT))
    try:
        trim_start = float(seg.get("trimStart") or 0)
    except Exception:
        trim_start = 0.0
    try:
        length = float(n_frames if n_frames is not None else (seg.get("length") or 0) or 0)
    except Exception:
        length = 0.0
    start_sec = max(0.0, trim_start / fps)
    if length > 0:
        end_sec = start_sec + length / fps
    else:
        wf = decoded["waveform"]
        sr = int(decoded.get("sample_rate") or 32000)
        end_sec = start_sec + (int(wf.shape[-1]) / float(max(sr, 1)))
    sliced = _slice_audio(decoded, start_sec, end_sec)
    if sliced is None or sliced.get("waveform") is None:
        return None
    try:
        peak = float(sliced["waveform"].abs().max())
    except Exception:
        peak = 0.0
    if peak < 1e-5:
        return None
    return sliced


def _slice_audio(audio: dict, start_sec: float, end_sec: float) -> dict | None:
    """按秒裁切 AUDIO，保证时间线不乱。"""
    if not isinstance(audio, dict) or audio.get("waveform") is None:
        return None
    wf = audio["waveform"]
    if not isinstance(wf, torch.Tensor):
        wf = torch.as_tensor(wf)
    if wf.ndim == 2:
        wf = wf.unsqueeze(0)
    sr = int(audio.get("sample_rate") or 32000)
    total = int(wf.shape[-1])
    a = max(0, int(round(float(start_sec) * sr)))
    b = max(a + 1, int(round(float(end_sec) * sr)))
    b = min(b, total)
    if a >= total:
        return None
    return {"waveform": wf[..., a:b].contiguous().float(), "sample_rate": sr}


def _collect_drive_pieces(tdata: dict) -> tuple[dict | None, list]:
    """收集驱动音频块：优先 h3MultiRef.driveAudio.pieces，否则 audioSegments.isH3Drive。"""
    multi = tdata.get("h3MultiRef") if isinstance(tdata, dict) else None
    if not isinstance(multi, dict):
        multi = {}
    item = multi.get("driveAudio")
    if not item or not isinstance(item, dict):
        raw_list = multi.get("audios")
        if isinstance(raw_list, list):
            item = next(
                (
                    x
                    for x in raw_list
                    if isinstance(x, dict)
                    and (x.get("role") == "drive" or x.get("pieces"))
                ),
                None,
            )
    pieces: list = []
    if isinstance(item, dict) and isinstance(item.get("pieces"), list):
        pieces = [p for p in item["pieces"] if isinstance(p, dict)]
    if not pieces:
        for s in tdata.get("audioSegments") or []:
            if isinstance(s, dict) and s.get("isH3Drive"):
                pieces.append(s)
    return item if isinstance(item, dict) else None, pieces


def _build_timeline_drive_audio(
    pieces: list,
    *,
    fps: float,
    fallback_file: str = "",
) -> dict | None:
    """
    按时间线拼驱动音：文件位置 = trimStart + (时间线 - 块起点)。
    未覆盖区域静音。这样逐段按主轨时间窗切片即等于「你保留哪段就用哪段」。
    """
    fps = max(1.0, float(fps or H3_FPS_DEFAULT))
    if not pieces:
        return None

    # 预解码各文件
    file_cache: dict[str, dict] = {}
    parsed = []
    max_end = 0
    for p in pieces:
        try:
            start = max(0, int(round(float(p.get("start") or 0))))
            length = max(1, int(round(float(p.get("length") or 0))))
            trim_start = max(0, int(round(float(p.get("trimStart") or 0))))
        except Exception:
            continue
        fn = (
            p.get("fileName")
            or p.get("audioFile")
            or p.get("name")
            or fallback_file
            or ""
        )
        if not fn:
            continue
        if fn not in file_cache:
            path = _resolve_input_media_path(fn, "input")
            if not path:
                log.warning("[LazyH3] 驱动音频块路径无效: %s", fn)
                continue
            decoded = _decode_audio_file(path)
            if decoded is None:
                log.warning("[LazyH3] 驱动音频块解码失败: %s", fn)
                continue
            file_cache[fn] = decoded
        parsed.append((start, length, trim_start, fn))
        max_end = max(max_end, start + length)

    if not parsed or max_end <= 0:
        return None

    # 统一采样率/声道（以第一块为准）
    first_fn = parsed[0][3]
    base = file_cache[first_fn]
    sr = int(base.get("sample_rate") or 32000)
    bw = base["waveform"]
    if not isinstance(bw, torch.Tensor):
        bw = torch.as_tensor(bw)
    if bw.ndim == 2:
        bw = bw.unsqueeze(0)
    ch = int(bw.shape[1]) if bw.ndim >= 2 else 2

    total_samples = max(1, int(round(max_end / fps * sr)))
    out = torch.zeros(1, ch, total_samples, dtype=torch.float32)

    for start, length, trim_start, fn in parsed:
        src = file_cache.get(fn)
        if not src:
            continue
        sw = src["waveform"]
        if not isinstance(sw, torch.Tensor):
            sw = torch.as_tensor(sw)
        if sw.ndim == 2:
            sw = sw.unsqueeze(0)
        # 声道对齐
        if sw.shape[1] != ch:
            if sw.shape[1] == 1 and ch == 2:
                sw = sw.repeat(1, 2, 1)
            elif sw.shape[1] == 2 and ch == 1:
                sw = sw[:, :1, :]
            else:
                m = min(int(sw.shape[1]), ch)
                sw = sw[:, :m, :]
                if m < ch:
                    pad_ch = torch.zeros(1, ch - m, sw.shape[-1], dtype=sw.dtype)
                    sw = torch.cat([sw, pad_ch], dim=1)
        src_sr = int(src.get("sample_rate") or sr)
        # 帧 → 采样（按各自 sr；再必要时简单对齐到目标 sr 用帧换算）
        # 用「帧/fps」换秒，再×各自采样率，避免不同文件 sr 偏差
        src_a = max(0, int(round(trim_start / fps * src_sr)))
        src_b = max(src_a + 1, int(round((trim_start + length) / fps * src_sr)))
        src_b = min(src_b, int(sw.shape[-1]))
        if src_a >= int(sw.shape[-1]):
            continue
        chunk = sw[..., src_a:src_b].float().contiguous()
        # 若源 sr ≠ 目标 sr，按长度重采样到本块应占的目标采样数
        dst_a = max(0, int(round(start / fps * sr)))
        need = max(1, int(round(length / fps * sr)))
        if chunk.shape[-1] != need:
            # 线性插值对齐长度
            x = chunk.reshape(1, -1, chunk.shape[-1]).float()
            x = torch.nn.functional.interpolate(x, size=need, mode="linear", align_corners=False)
            chunk = x.reshape(1, ch, need)
        dst_b = min(total_samples, dst_a + int(chunk.shape[-1]))
        n = dst_b - dst_a
        if n <= 0 or dst_a >= total_samples:
            continue
        out[..., dst_a:dst_b] = chunk[..., :n]

    log.info(
        "[LazyH3] 驱动音已按时间线裁切对齐: %d块 总帧=%d ≈%.2fs trim示例=%s sr=%d",
        len(parsed),
        max_end,
        max_end / fps,
        [(t, s, L) for s, L, t, _ in parsed[:3]],
        sr,
    )
    return {"waveform": out.contiguous(), "sample_rate": sr}


def load_h3_drive_audio(
    timeline_data, *, fps: float | None = None
) -> tuple[dict | None, dict | None, list]:
    """
    加载驱动原音并按时间线 pieces/trimStart 对齐（分镜/多参共用）。
    不做整轨人声分离（分离在逐段切片后）。
    返回 (None, timeline_aligned_audio, pieces)。
    """
    tdata = _parse_timeline(timeline_data)
    item, pieces = _collect_drive_pieces(tdata)
    if not item and not pieces:
        return None, None, []

    # fps：入参优先，否则时间线字段，再默认
    fr = fps
    if fr is None or float(fr or 0) <= 0:
        for k in ("frame_rate", "frameRate", "fps"):
            if k in tdata:
                try:
                    fr = float(tdata[k])
                    break
                except Exception:
                    pass
    fr = max(1.0, float(fr or H3_FPS_DEFAULT))

    fallback_fn = ""
    if isinstance(item, dict):
        fallback_fn = item.get("fileName") or item.get("name") or ""

    # 规范化 pieces，便于写入 guide / 逐段侧重对齐
    norm_pieces = []
    for p in pieces:
        if not isinstance(p, dict):
            continue
        fn = (
            p.get("fileName")
            or p.get("audioFile")
            or p.get("name")
            or fallback_fn
            or ""
        )
        try:
            norm_pieces.append({
                "start": max(0, int(round(float(p.get("start") or 0)))),
                "length": max(1, int(round(float(p.get("length") or 0)))),
                "trimStart": max(0, int(round(float(p.get("trimStart") or 0)))),
                "fileName": fn,
                "audioFile": fn,
            })
        except Exception:
            continue

    if norm_pieces:
        aligned = _build_timeline_drive_audio(
            norm_pieces, fps=fr, fallback_file=fallback_fn
        )
        if aligned is not None:
            return None, aligned, norm_pieces
        log.warning("[LazyH3] 驱动音 pieces 对齐失败，回退整文件")

    # 无有效 pieces：整文件（兼容旧数据）
    fn = fallback_fn
    if not fn and norm_pieces:
        fn = norm_pieces[0].get("fileName") or ""
    if not fn:
        return None, None, norm_pieces
    path = _resolve_input_media_path(fn, "input")
    if not path:
        log.warning("[LazyH3] 驱动音频路径无效: %s", fn)
        return None, None, norm_pieces
    original = _decode_audio_file(path)
    if original is None:
        return None, None, norm_pieces
    log.info(
        "[LazyH3] 驱动原音已加载（无裁切块，整文件）duration≈%.2fs sr=%s pieces=%d",
        float(item.get("duration") or 0) if isinstance(item, dict) else 0,
        original.get("sample_rate"),
        len(norm_pieces),
    )
    return None, original, norm_pieces


def load_h3_multi_ref_audios(timeline_data) -> dict | None:
    """多参「参考音频」槽（最多 3，整段进模型）。与驱动音频独立，有驱动时仍加载。"""
    tdata = _parse_timeline(timeline_data)
    multi = tdata.get("h3MultiRef") or {}
    if not isinstance(multi, dict):
        log.info("[LazyH3] 时间线无多参参考音频")
        return None
    raw_list = []
    seen = set()
    for key in ("refAudios", "audios"):
        chunk = multi.get(key)
        if not isinstance(chunk, list):
            continue
        for item in chunk:
            if not isinstance(item, dict):
                continue
            fn = item.get("fileName") or item.get("audioFile") or item.get("name") or ""
            if not fn or fn in seen:
                continue
            seen.add(fn)
            raw_list.append(item)
    if not raw_list:
        log.info("[LazyH3] 时间线无多参参考音频")
        return None
    out = {}
    slot = 0
    n_raw = 0
    n_skip_drive = 0
    for item in raw_list[:3]:
        fn = item.get("fileName") or item.get("audioFile") or item.get("name") or ""
        if not fn:
            continue
        n_raw += 1
        # 跳过驱动项（留给 driveAudio / 逐段 Lock）
        if item.get("role") == "drive" or (
            isinstance(item.get("pieces"), list) and item.get("pieces")
        ):
            n_skip_drive += 1
            continue
        path = _resolve_input_media_path(fn, "input")
        if not path:
            log.warning("[LazyH3] 多参参考音频#%d 路径无效: %s", slot + 1, fn)
            continue
        audio = _decode_audio_file(path)
        if audio is None:
            log.warning("[LazyH3] 多参参考音频#%d 解码失败: %s", slot + 1, fn)
            continue
        out[f"ref_audio_{slot}"] = audio
        slot += 1
    if out:
        log.info("[LazyH3] 已加载多参参考音频 %d 条", len(out))
    elif n_raw:
        log.warning(
            "[LazyH3] 参考音频槽有 %d 条但未读入（其中驱动项 %d）。请确认加在「参考音频」轨，不是驱动音频。",
            n_raw,
            n_skip_drive,
        )
    return out or None


def _timeline_main_segments(timeline_data) -> list:
    """主轨非 ghost 段，按 start 排序。"""
    tdata = _parse_timeline(timeline_data)
    raw = tdata.get("segments") if isinstance(tdata, dict) else None
    out = []
    if isinstance(raw, list):
        for s in raw:
            if not isinstance(s, dict) or s.get("type") == "ghost":
                continue
            out.append(s)
        out.sort(key=lambda s: int(s.get("start") or 0))
    return out


def _is_main_track_video_seg(seg: dict) -> bool:
    if not isinstance(seg, dict):
        return False
    if str(seg.get("type") or "").lower() != "video":
        return False
    return bool(seg.get("imageFile") or seg.get("videoFile") or seg.get("fileName"))


def _main_track_timeline_windows(timeline_data, n_segs: int, lengths: list, fps: float) -> list[dict]:
    """主轨各段在时间线上的起止（帧）。优先 timeline.segments，否则按 length 累加。"""
    fps = max(1.0, float(fps or 24))
    tdata = _parse_timeline(timeline_data)
    raw = tdata.get("segments") if isinstance(tdata, dict) else None
    windows = []
    if isinstance(raw, list) and raw:
        for s in raw:
            if not isinstance(s, dict) or s.get("type") == "ghost":
                continue
            try:
                st = int(s.get("start") or 0)
                ln = int(s.get("length") or 0)
            except Exception:
                continue
            if ln <= 0:
                continue
            windows.append({"start": st, "length": ln, "end": st + ln})
    out = []
    cursor = 0
    for i in range(max(1, n_segs)):
        if i < len(windows):
            w = windows[i]
            out.append({"start": int(w["start"]), "length": int(w["length"]), "end": int(w["end"])})
            cursor = int(w["end"])
        else:
            ln = int(lengths[i]) if i < len(lengths) and lengths[i] else int(round(5.0 * fps))
            ln = max(5, ln)
            out.append({"start": cursor, "length": ln, "end": cursor + ln})
            cursor += ln
    return out


def wan_guide_to_h3(
    gd: dict,
    *,
    width: int = 0,
    height: int = 0,
    fps: float = 0,
    overlap: int = 0,
    global_prompt: str = "",
    negative_prompt: str = "",
    resize_method: str = "保持宽高比",
    workspace_mode: str = H3_MODE_STORYBOARD,
    trim_end_seconds: float = 0.35,
    shift_video: float = 12.0,
    shift_audio: float = 3.0,
    apply_sigma_shift: bool = True,
    multi_ref_images=None,
    multi_ref_videos=None,
    multi_ref_audios=None,
) -> dict:
    """GUIDE_DATA → H3_GUIDE_DATA（供逐段生成使用）。"""
    if not isinstance(gd, dict):
        raise ValueError("关键帧数据无效。")

    images = list(gd.get("images") or [])
    prompts = list(gd.get("segment_prompts") or [])
    lengths = list(gd.get("segment_lengths") or [])
    transitions = list(gd.get("segment_transitions") or [])
    modes_w = list(gd.get("segment_modes") or [])
    n = max(len(images), len(prompts), len(lengths), 1)

    g_prompt = (global_prompt or gd.get("global_prompt") or "").strip()
    n_prompt = (negative_prompt or gd.get("negative_prompt") or "").strip()
    ws = normalize_workspace_mode(workspace_mode or gd.get("workspace_mode"))

    w = int(width) if width and int(width) > 0 else int(gd.get("width") or 1344)
    h = int(height) if height and int(height) > 0 else int(gd.get("height") or 768)
    w = max(256, (w // 32) * 32)
    h = max(256, (h // 32) * 32)

    # 多参图/参考音/参考视频：仅「多参」；驱动音：分镜+多参都可
    multi_refs = None
    multi_vids = None
    multi_auds = None

    fr = float(fps) if fps and float(fps) > 0 else float(gd.get("frame_rate") or H3_FPS_DEFAULT)
    fr = max(8.0, min(30.0, fr))

    drive_original = gd.get("drive_audio_original")
    drive_pieces = gd.get("drive_audio_pieces")
    if drive_original is None or not isinstance(drive_pieces, list):
        _v, drive_original, drive_pieces = load_h3_drive_audio(
            gd.get("timeline_data") or "", fps=fr
        )
    gd["_drive_audio_original"] = drive_original
    gd["_drive_audio_pieces"] = drive_pieces if isinstance(drive_pieces, list) else []

    if ws == H3_MODE_REF:
        multi_refs = multi_ref_images
        if multi_refs is None or (
            not isinstance(multi_refs, dict) and not tensor_has_image(multi_refs)
        ):
            multi_refs = gd.get("multi_ref_images")
        if multi_refs is None or (
            not isinstance(multi_refs, dict) and not tensor_has_image(multi_refs)
        ):
            multi_refs = load_h3_multi_ref_images(
                gd.get("timeline_data") or "",
                width=w,
                height=h,
                resize_method="stretch to fit",
            )
        multi_vids = multi_ref_videos or gd.get("multi_ref_videos")
        multi_auds = multi_ref_audios or gd.get("multi_ref_audios")
        if not multi_vids:
            multi_vids = load_h3_multi_ref_videos(gd.get("timeline_data") or "", fps=float(fr))
        # 参考音与驱动音独立
        if not multi_auds:
            multi_auds = load_h3_multi_ref_audios(gd.get("timeline_data") or "")
    # 重叠默认 0；允许 0
    try:
        ov = int(overlap) if overlap is not None else int(gd.get("overlap_frames") or 0)
    except Exception:
        ov = 0
    ov = max(0, min(64, ov))
    rm = _normalize_resize_method(resize_method or gd.get("resize_method") or "maintain aspect ratio")
    max_frames = h3_snap_length(H3_MAX_SECONDS, fr, as_seconds=True)

    # 主轨时间窗（与驱动音频切片对齐）
    tl_windows = _main_track_timeline_windows(
        gd.get("timeline_data") or "", n, lengths, fr
    )
    tl_raw_segs = _timeline_main_segments(gd.get("timeline_data") or "")

    segments = []
    total_raw = 0
    total_snap = 0
    for i in range(n):
        img = images[i] if i < len(images) else None
        is_vid_batch = (
            isinstance(img, torch.Tensor)
            and img.ndim == 4
            and int(img.shape[0]) > 1
        )
        # 多参主轨视频：整段另作 source_video，不把多帧当引导图缩放
        if is_vid_batch and ws == H3_MODE_REF:
            img = None
        elif isinstance(img, torch.Tensor) and img.numel() > 0:
            try:
                img = _resize_image(img, w, h, rm, 32)
            except Exception as e:
                log.warning("[LazyH3] 段#%d 缩放失败: %s", i + 1, e)
        else:
            img = None

        win = tl_windows[i] if i < len(tl_windows) else None
        if win is not None:
            raw_len = max(5, int(win["length"]))
            tl_start = int(win["start"])
        elif i < len(lengths) and lengths[i]:
            raw_len = int(lengths[i])
            tl_start = int(total_raw)
        else:
            raw_len = int(round(5.0 * fr))
            tl_start = int(total_raw)

        source_video = None
        source_audio = None
        skip_first = False
        source_meta = None
        raw_seg = tl_raw_segs[i] if i < len(tl_raw_segs) else None
        if ws == H3_MODE_REF and _is_main_track_video_seg(raw_seg):
            try:
                source_video = _load_video_tensor(raw_seg, float(fr), required=False)
            except Exception as e:
                log.warning("[LazyH3] 段#%d 主轨视频加载失败: %s", i + 1, e)
                source_video = None
            if (
                isinstance(source_video, torch.Tensor)
                and source_video.ndim >= 3
                and int(source_video.shape[0]) >= 2
            ):
                skip_first = True
                n_vid = int(source_video.shape[0])
                raw_len = max(5, n_vid)
                try:
                    img = source_video[0:1].contiguous()
                except Exception:
                    pass
                try:
                    source_audio = _load_video_audio(raw_seg, float(fr), n_vid)
                except Exception as e:
                    log.warning("[LazyH3] 段#%d 主轨视频原声提取失败: %s", i + 1, e)
                    source_audio = None
                log.info(
                    "[LazyH3] 段#%d 主轨视频：%d帧 %sx%s，跳过一采，原声=%s",
                    i + 1,
                    n_vid,
                    int(source_video.shape[2]),
                    int(source_video.shape[1]),
                    "有" if source_audio is not None else "无",
                )
                source_meta = {
                    "imageFile": raw_seg.get("imageFile") or "",
                    "videoFile": raw_seg.get("videoFile") or "",
                    "fileName": raw_seg.get("fileName") or "",
                    "trimStart": raw_seg.get("trimStart") or 0,
                    "length": raw_seg.get("length") or n_vid,
                    "type": "video",
                }
            else:
                source_video = None
                source_audio = None

        total_raw += max(5, raw_len)
        # 成片帧 = 时间线帧。总时长不变，音频驱动按这个长度对齐。
        content_len = max(5, int(raw_len))
        if skip_first:
            slen = content_len  # 跳过一采：不走 17k+5 网格
        else:
            slen = h3_snap_length(content_len, fr, False)
            slen = min(slen, max_frames)
        total_snap += content_len  # 成片按精确内容帧累计
        raw_sec = content_len / fr
        snap_sec = slen / fr

        link = transitions[i] if i < len(transitions) else "flf"
        if link not in ("flf", "cut"):
            link = "flf"

        mw = modes_w[i] if i < len(modes_w) else ("i2v" if img is not None else "auto")
        if skip_first:
            mode = "skip"
        elif ws == H3_MODE_REF:
            # 多参工作台：强制参考生（多参图在 multi_ref_images，不依赖主轨有图）
            mode = "ref"
        elif img is not None:
            mode = "i2v" if mw in ("i2v", "auto", "flf") else (mw if mw in ("ref", "flf", "i2v") else "i2v")
        else:
            mode = "auto" if mw in ("t2v", "auto", "") else mw

        if skip_first:
            seg_type = "video"
        elif img is not None:
            seg_type = "image"
        else:
            seg_type = "text"

        segments.append({
            "index": i,
            "mode": mode,
            "prompt": prompts[i] if i < len(prompts) else "",
            "length": slen,  # 生成网格长度
            "length_raw": content_len,  # 成片精确内容帧
            "content_len": content_len,
            "timeline_start": tl_start,
            "timeline_end": tl_start + content_len,
            "seconds_raw": raw_sec,
            "seconds_snap": snap_sec,
            "link": link,
            "image": img,
            "ref_video": None,
            "source_video": source_video,
            "source_audio": source_audio,
            "source_meta": source_meta,
            "skip_first": bool(skip_first),
            "type": seg_type,
        })

    if not segments:
        cl = max(5, int(round(5.0 * fr)))
        segments.append({
            "index": 0,
            "mode": "t2v" if ws != H3_MODE_REF else "ref",
            "prompt": "",
            "length": h3_snap_length(cl, fr, False),
            "length_raw": cl,
            "content_len": cl,
            "timeline_start": 0,
            "timeline_end": cl,
            "seconds_raw": 5.0,
            "seconds_snap": h3_frames_to_seconds(h3_snap_length(cl, fr, False), fr),
            "link": "cut",
            "image": None,
            "ref_video": None,
            "source_video": None,
            "source_audio": None,
            "source_meta": None,
            "skip_first": False,
            "type": "text",
        })
        total_snap = segments[0]["content_len"]
        total_raw = segments[0]["length_raw"]

    # 多参图：dict + 限幅/黑边 pad（禁止 stretch）
    multi_out = None
    multi_count = 0
    if ws == H3_MODE_REF and multi_refs is not None:
        try:
            cleaned = {}
            if isinstance(multi_refs, dict):
                items = sorted(
                    multi_refs.items(),
                    key=lambda kv: (
                        int(str(kv[0]).rsplit("_", 1)[-1])
                        if str(kv[0]).rsplit("_", 1)[-1].isdigit()
                        else 0
                    ),
                )
                for i, (_k, v) in enumerate(items):
                    if not tensor_has_image(v):
                        continue
                    one = prepare_h3_ref_image_tensor(
                        v, target_w=w, target_h=h, max_short=H3_REF_MAX_SHORT
                    )
                    cleaned[f"ref_image_{len(cleaned)}"] = one
            elif tensor_has_image(multi_refs):
                mr = multi_refs
                if mr.ndim == 3:
                    mr = mr.unsqueeze(0)
                for i in range(min(9, int(mr.shape[0]))):
                    one = prepare_h3_ref_image_tensor(
                        mr[i : i + 1], target_w=w, target_h=h, max_short=H3_REF_MAX_SHORT
                    )
                    cleaned[f"ref_image_{len(cleaned)}"] = one
            multi_out = cleaned if cleaned else None
            multi_count = len(cleaned)
        except Exception as e:
            log.warning("[LazyH3] 多参图整理失败: %s", e)
            multi_out = multi_refs
            if isinstance(multi_refs, dict):
                multi_count = len(multi_refs)
            elif tensor_has_image(multi_refs):
                multi_count = int(multi_refs.shape[0]) if multi_refs.ndim == 4 else 1

    if ws == H3_MODE_REF and multi_count <= 0 and not multi_vids and not multi_auds:
        log.warning(
            "[LazyH3] 多参模式未读到参考（图/视频/音频）。请在多参轨添加内容。"
        )
    elif ws == H3_MODE_REF:
        log.info(
            "[LazyH3] 多参参考汇总: 图=%d 视频=%d 音频=%d",
            multi_count,
            len(multi_vids) if isinstance(multi_vids, dict) else 0,
            len(multi_auds) if isinstance(multi_auds, dict) else 0,
        )

    return {
        "segments": segments,
        "global_prompt": g_prompt,
        "negative_prompt": n_prompt,
        "width": w,
        "height": h,
        "frame_rate": fr,
        "overlap_frames": ov,
        "resize_method": rm,
        "engine": "h3_ref" if ws == H3_MODE_REF else "h3",
        "workspace_mode": ws,
        # 分镜：multi_ref 恒为 None，下游不得当参考生
        "multi_ref_images": multi_out if ws == H3_MODE_REF else None,
        "multi_ref_count": multi_count if ws == H3_MODE_REF else 0,
        "multi_ref_videos": multi_vids if ws == H3_MODE_REF else None,
        "multi_ref_audios": multi_auds if ws == H3_MODE_REF else None,
        # 成片用原驱动音频（分镜/多参均可；口型用人声，合成用原音）
        "drive_audio_original": gd.get("_drive_audio_original"),
        # 驱动裁切块（逐段可按 trimStart 重新对齐，避免导演台缓存整文件）
        "drive_audio_pieces": gd.get("_drive_audio_pieces") or [],
        "timeline_data": gd.get("timeline_data") or "",
        "trim_end_seconds": float(trim_end_seconds or 0),
        "shift_video": float(shift_video),
        "shift_audio": float(shift_audio),
        "apply_sigma_shift": bool(apply_sigma_shift),
        "total_frames_raw": int(total_raw),
        "total_frames_snap": int(total_snap),
        "total_seconds_raw": float(total_raw) / fr,
        "total_seconds_snap": float(total_snap) / fr,
    }


class LazyH3Director(io.ComfyNode):
    """
    Lazy H3 导演台：时间线 UI + 分镜/多参模式切换。
    """

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        """时间线（含驱动音 trim/pieces）一变就重跑，避免缓存整文件开头。"""
        import hashlib

        tl = kwargs.get("timeline_data") or ""
        if not isinstance(tl, str):
            try:
                tl = json.dumps(tl, ensure_ascii=False, sort_keys=True, default=str)
            except Exception:
                tl = str(tl)
        ws = str(kwargs.get("workspace_mode") or "")
        raw = (tl + "|" + ws).encode("utf-8", errors="ignore")
        return hashlib.md5(raw).hexdigest()

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LazyH3Director",
            display_name="Lazy MinimaxH3 导演台",
            category="Lazy/H3",
            description="Lazy MinimaxH3 导演台（分镜/多参）。",
            search_aliases=["Lazy", "H3", "MiniMax", "导演台"],
            inputs=[
                # 接口名固定 model_fl / model_ref（与 model_ref 同格式；勿用 model）
                io.Model.Input(
                    "model_fl",
                    display_name="model_fl",
                    tooltip="分镜模型 fl2va。",
                ),
                io.Model.Input(
                    "model_ref",
                    display_name="model_ref",
                    tooltip="多参模型 ref2va。未接则回退 model_fl。",
                ),
                io.Clip.Input(
                    "clip",
                    display_name="clip",
                    tooltip="H3 文本编码，类型 minimax。",
                ),
                io.Latent.Input(
                    "optional_latent",
                    display_name="optional_latent",
                    optional=True,
                    tooltip="可选潜空间。",
                ),
                io.Combo.Input(
                    "workspace_mode",
                    options=[H3_MODE_STORYBOARD, H3_MODE_REF],
                    default=H3_MODE_STORYBOARD,
                    display_name="工作台",
                    optional=True,
                    tooltip="分镜=时间线；多参=参考生。",
                ),
                io.Int.Input(
                    "custom_width",
                    display_name="宽度",
                    default=1344, min=0, max=8192, step=32, optional=True,
                    tooltip="生成宽度。0=按关键帧推断。",
                ),
                io.Int.Input(
                    "custom_height",
                    display_name="高度",
                    default=768, min=0, max=8192, step=32, optional=True,
                    tooltip="生成高度。0=按关键帧推断。",
                ),
                io.Int.Input(
                    "start_frame",
                    display_name="起始帧",
                    default=0, min=0, max=10000, step=1,
                    tooltip="生成起始帧。",
                ),
                io.Int.Input(
                    "end_frame",
                    display_name="结束帧",
                    default=120, min=0, max=10000, step=1,
                    tooltip="生成结束帧。",
                ),
                io.Int.Input(
                    "duration_frames",
                    display_name="总帧数",
                    default=120, min=1, max=10000, step=1,
                    tooltip="总帧数。成片时长跟这里对齐。",
                ),
                io.Float.Input(
                    "start_second",
                    display_name="起始秒",
                    default=0.0, min=0.0, max=1000.0, step=0.01,
                    tooltip="起始时间（秒）。",
                ),
                io.Float.Input(
                    "end_second",
                    display_name="结束秒",
                    default=5.0, min=0.0, max=1000.0, step=0.01,
                    tooltip="结束时间（秒）。",
                ),
                io.Float.Input(
                    "duration_seconds",
                    display_name="总时长(秒)",
                    default=5.0, min=0.0, max=1000.0, step=0.01,
                    tooltip="总时长（秒）。",
                ),
                io.Float.Input(
                    "frame_rate",
                    display_name="帧率",
                    default=H3_FPS_DEFAULT, min=0, max=240, step=1, optional=True,
                    tooltip="帧率。H3 常用 24。",
                ),
                io.String.Input(
                    "global_prompt",
                    display_name="全局提示词",
                    multiline=True, default="", force_input=True, optional=True,
                    tooltip="全局提示词。",
                ),
                io.String.Input(
                    "negative_prompt",
                    display_name="负向提示词",
                    multiline=True, default="",
                    optional=True,
                    tooltip="负向提示词（逐段采样会使用）。",
                ),
                io.Combo.Input(
                    "resize_method",
                    options=["maintain aspect ratio", "stretch to fit", "pad", "pad green", "crop"],
                    default="maintain aspect ratio",
                    display_name="缩放方式",
                    optional=True,
                    tooltip="关键帧缩放方式。",
                ),
                io.Int.Input(
                    "divisible_by",
                    display_name="对齐倍数",
                    default=32, min=0, max=1024, step=1, optional=True,
                    tooltip="宽高对齐倍数。",
                ),
                io.Int.Input(
                    "img_compression",
                    display_name="关键帧压缩",
                    default=0, min=0, max=100, step=1, optional=True,
                    tooltip="关键帧压缩，0=关闭。",
                ),
                io.Combo.Input(
                    "display_mode",
                    options=["frames", "seconds"],
                    default="seconds",
                    display_name="时间显示",
                    optional=True,
                    tooltip="时间轴标尺单位。",
                ),
                io.Float.Input(
                    "epsilon",
                    display_name="过渡参数",
                    default=0.001, min=0.0, max=0.99, step=0.0001,
                    tooltip="保留参数。",
                ),
                io.String.Input(
                    "timeline_data",
                    display_name="时间线数据",
                    default="",
                    tooltip="时间线 JSON（界面自动维护）。",
                ),
                io.String.Input(
                    "local_prompts",
                    display_name="分段提示词",
                    multiline=True, default="",
                    tooltip="分段提示词（自动）。",
                ),
                io.String.Input(
                    "segment_lengths",
                    display_name="分段长度",
                    default="",
                    tooltip="分段长度（自动）。",
                ),
                io.String.Input(
                    "guide_strength",
                    display_name="关键帧强度",
                    default="",
                    tooltip="关键帧强度（自动）。",
                ),
                io.String.Input(
                    "transition_smoothness",
                    display_name="转场平滑",
                    default="", optional=True,
                    tooltip="转场参数（自动）。",
                ),
            ],
            outputs=[
                io.Model.Output("model_fl", display_name="model_fl"),
                io.Model.Output("model_ref", display_name="model_ref"),
                io.Conditioning.Output(display_name="正向条件"),
                io.Conditioning.Output(display_name="负向条件"),
                io.Latent.Output(display_name="视频潜空间"),
                GuideData.Output(display_name="关键帧数据"),
                io.Custom("H3_GUIDE_DATA").Output(display_name="H3分镜数据"),
                io.Float.Output(display_name="帧率"),
                io.Int.Output(display_name="帧数"),
                io.Int.Output(display_name="宽度"),
                io.Int.Output(display_name="高度"),
                io.String.Output(display_name="时长信息"),
            ],
        )

    @classmethod
    def execute(cls, **kwargs) -> io.NodeOutput:
        ensure_director_routes()
        # 只认 model_fl / model_ref
        model = kwargs.get("model_fl")
        if model is None:
            model = kwargs.get("model")
        if model is None:
            raise ValueError("请连接 model_fl（分镜 fl2va）。")
        model_ref = kwargs.get("model_ref")
        if model_ref is None:
            model_ref = model
            log.warning("[LazyH3] 未接 model_ref，已回退 model_fl。")
        # 工作台：优先控件值；无则从 timeline_data 旁路字段
        ws_raw = kwargs.get("workspace_mode")
        if not ws_raw:
            try:
                _td = kwargs.get("timeline_data") or ""
                _tdj = json.loads(_td) if isinstance(_td, str) and _td.strip() else (_td or {})
                if isinstance(_tdj, dict):
                    ws_raw = _tdj.get("workspace_mode") or _tdj.get("h3WorkspaceMode")
            except Exception:
                pass
        ws = normalize_workspace_mode(ws_raw)

        # 复用 Wan 导演台（高低噪填同一分镜模型，仅构建时间线/条件）
        wan_kwargs = dict(kwargs)
        wan_kwargs["model_high_noise"] = model
        wan_kwargs["model_low_noise"] = model
        try:
            dw = int(wan_kwargs.get("divisible_by") or 32)
            if dw < 1:
                wan_kwargs["divisible_by"] = 32
        except Exception:
            wan_kwargs["divisible_by"] = 32

        out = WanRemixDirector.execute(**wan_kwargs)
        args = None
        for attr in ("args", "result", "outputs", "data"):
            if hasattr(out, attr):
                val = getattr(out, attr)
                if val is not None:
                    try:
                        args = list(val)
                        break
                    except Exception:
                        pass
        if args is None:
            try:
                args = list(out)
            except Exception as e:
                raise RuntimeError(f"无法解析导演台返回值: {type(out)} {e}") from e

        if len(args) < 10:
            raise RuntimeError(f"导演台返回项不足: got {len(args)}")
        _high, _low, positive, negative, latent, guide_data, fps, frames, w, h = args[:10]

        # 重叠 / sigma shift 由「Lazy H3 逐段生成」控制，导演台不再暴露
        ov = 0

        # 驱动音：分镜/多参都加载；多参图/参考音/参考视频：仅多参
        multi_refs = None
        multi_vids = None
        multi_auds = None
        tl = kwargs.get("timeline_data") or ""
        _v, drive_original, drive_pieces = load_h3_drive_audio(
            tl, fps=float(fps) or H3_FPS_DEFAULT
        )
        if isinstance(guide_data, dict):
            guide_data = dict(guide_data)
            guide_data["timeline_data"] = tl
            if drive_original is not None:
                guide_data["drive_audio_original"] = drive_original
            if drive_pieces:
                guide_data["drive_audio_pieces"] = drive_pieces
        if ws == H3_MODE_REF:
            multi_refs = load_h3_multi_ref_images(
                tl,
                width=int(w),
                height=int(h),
                resize_method="stretch to fit",
            )
            multi_vids = load_h3_multi_ref_videos(tl, fps=float(fps) or 24.0)
            # 参考音与驱动音并行：参考音整段进模型；驱动音仍逐段切片+分离+Lock
            multi_auds = load_h3_multi_ref_audios(tl)
            if isinstance(guide_data, dict):
                if multi_refs is not None:
                    guide_data["multi_ref_images"] = multi_refs
                if multi_vids:
                    guide_data["multi_ref_videos"] = multi_vids
                guide_data["multi_ref_audios"] = multi_auds
            log.info(
                "[LazyH3] 导演台多参装载: 图=%s 视频=%s 参考音=%s 驱动原音=%s",
                multi_refs.shape[0] if isinstance(multi_refs, torch.Tensor) and multi_refs.ndim == 4
                else (len(multi_refs) if isinstance(multi_refs, dict) else 0),
                len(multi_vids) if multi_vids else 0,
                len(multi_auds) if multi_auds else 0,
                "有" if drive_original is not None else "无",
            )
        elif drive_original is not None:
            log.info("[LazyH3] 导演台分镜装载: 驱动原音=有")

        h3_guide = wan_guide_to_h3(
            guide_data,
            width=int(w),
            height=int(h),
            fps=float(fps),
            overlap=ov,
            global_prompt=kwargs.get("global_prompt") or "",
            negative_prompt=kwargs.get("negative_prompt") or "",
            resize_method=kwargs.get("resize_method") or "maintain aspect ratio",
            workspace_mode=ws,
            # 前裁/尾裁由「Lazy H3 逐段生成」控制
            trim_end_seconds=0.0,
            # shift 仅占位；真正采样以逐段生成节点控件为准
            shift_video=12.0,
            shift_audio=3.0,
            apply_sigma_shift=True,
            multi_ref_images=multi_refs if ws == H3_MODE_REF else None,
            multi_ref_videos=multi_vids if ws == H3_MODE_REF else None,
            multi_ref_audios=multi_auds if ws == H3_MODE_REF else None,
        )

        # 当前工作台选用的主模型（下游可直接接「分镜模型」口；逐段会再按模式选）
        active = model_ref if ws == H3_MODE_REF else model
        h3_guide["active_model_role"] = "ref" if ws == H3_MODE_REF else "storyboard"

        n_ref = int(h3_guide.get("multi_ref_count") or 0)
        dur_info = (
            f"工作台={ws} | 多参图={n_ref}张 | 设计 {h3_guide.get('total_seconds_raw', 0):.2f}s "
            f"→ 对齐后约 {h3_guide.get('total_seconds_snap', 0):.2f}s "
            f"({h3_guide.get('total_frames_snap', 0)}帧 @{float(fps):.0f}fps)"
        )
        log.info("[LazyH3] 导演台 %s", dur_info)

        return io.NodeOutput(
            model,           # 分镜模型输出（始终 fl2va）
            model_ref,       # 多参模型输出
            positive,
            negative,
            latent,
            guide_data,
            h3_guide,
            float(fps),
            int(h3_guide.get("total_frames_snap") or frames),
            int(w),
            int(h),
            dur_info,
        )
