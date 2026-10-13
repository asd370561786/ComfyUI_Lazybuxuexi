"""把逐段生成落盘的分段视频拼成一条。文件名支持 文件夹/名称。"""
from __future__ import annotations

import logging
import os
import re
import subprocess
import tempfile

import folder_paths

from .lazy_h3_sequential import _best_seg_video, _find_ffmpeg, _seg_file_ok

log = logging.getLogger("Lazy")

_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _clean_prefix(raw: str) -> str:
    """z视频/z → 子目录 z视频，文件名前缀 z。"""
    s = (raw or "lazy").strip().strip('"')
    if not s:
        s = "lazy"
    s = s.replace("\\", "/")
    parts = [p for p in s.split("/") if p and p not in (".", "..")]
    cleaned = []
    for p in parts:
        p = re.sub(r'[:*?"<>|\r\n\t]+', "_", p).strip(" .")
        if p:
            cleaned.append(p[:80])
    return "/".join(cleaned) if cleaned else "lazy"


def _collect_segments(pack) -> list[str]:
    """本次 clip_files 优先；否则按段号取成片（补帧 > 脸修 > 超分 > 原片）。"""
    if not isinstance(pack, dict):
        raise ValueError("片段包无效，请接逐段生成。")
    files = []
    missing = []
    for p in list(pack.get("clip_files") or []):
        if _seg_file_ok(p):
            ap = os.path.abspath(p)
            if ap not in files:
                files.append(ap)
        elif p:
            missing.append(str(p))
    if missing:
        names = ", ".join(os.path.basename(x) for x in missing)
        raise RuntimeError(f"有分段文件缺失: {names}")
    if files:
        return files

    save_dir = pack.get("save_dir") or ""
    if save_dir and os.path.isdir(save_dir):
        i = 1
        while i <= 999:
            hit = _best_seg_video(save_dir, i)
            if not hit:
                break
            files.append(os.path.abspath(hit))
            i += 1
    if not files:
        raise RuntimeError("没有可拼合的本地分段。请在逐段生成打开自动保存。")
    return files


def _run_ffmpeg(cmd, timeout: int, cwd: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd,
        cwd=cwd,
        capture_output=True,
        timeout=timeout,
        creationflags=_CREATE_NO_WINDOW if os.name == "nt" else 0,
    )


def _timeout_for(files: list[str], copy: bool) -> int:
    total = 0
    for p in files:
        try:
            total += os.path.getsize(p)
        except OSError:
            pass
    mb = max(1.0, total / (1024 * 1024))
    rate = 40.0 if copy else 1.5
    return int(min(4 * 3600, max(180, mb / rate + 60)))


def _probe(ffmpeg: str, path: str) -> dict:
    try:
        proc = _run_ffmpeg([ffmpeg, "-hide_banner", "-i", path], timeout=60)
        text = (proc.stderr or b"").decode("utf-8", errors="replace")
        text += (proc.stdout or b"").decode("utf-8", errors="replace")
    except Exception as e:
        log.warning("[Lazy] 读取视频信息失败 %s: %s", os.path.basename(path), e)
        return {"w": 0, "h": 0, "fps": 0.0, "audio": False, "duration": 0.0}
    vm = re.search(r"(\d{2,5})x(\d{2,5})", text)
    fpsm = re.search(r"(\d+(?:\.\d+)?)\s*fps", text)
    durm = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", text)
    dur = 0.0
    if durm:
        dur = int(durm.group(1)) * 3600 + int(durm.group(2)) * 60 + float(durm.group(3))
    return {
        "w": int(vm.group(1)) if vm else 0,
        "h": int(vm.group(2)) if vm else 0,
        "fps": float(fpsm.group(1)) if fpsm else 0.0,
        "audio": "Audio:" in text,
        "duration": dur,
    }


def _streams_match(probes: list[dict], fps: float | None = None) -> bool:
    if not probes or not probes[0]["w"] or not probes[0]["h"]:
        return False
    a0 = probes[0]
    if fps is not None and abs((a0["fps"] or 0) - float(fps)) > 0.05:
        return False
    for p in probes[1:]:
        if p["w"] != a0["w"] or p["h"] != a0["h"]:
            return False
        if abs((p["fps"] or 0) - (a0["fps"] or 0)) > 0.05:
            return False
        if bool(p["audio"]) != bool(a0["audio"]):
            return False
    return True


def _ff_path(path: str) -> str:
    return os.path.abspath(path).replace("\\", "/").replace("'", r"'\''")


def _concat_list(files: list[str]) -> str:
    lines = [f"file '{_ff_path(p)}'" for p in files]
    fd, list_path = tempfile.mkstemp(suffix=".txt", prefix="lazy_concat_")
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    return list_path


def _remove(path: str | None):
    if not path:
        return
    try:
        if os.path.isfile(path):
            os.remove(path)
    except OSError:
        pass


def _ok_file(path: str) -> bool:
    return os.path.isfile(path) and os.path.getsize(path) > 64


def _concat_copy(ffmpeg: str, files: list[str], out_path: str) -> tuple[bool, str]:
    list_path = _concat_list(files)
    try:
        cmd = [
            ffmpeg, "-y", "-v", "error",
            "-f", "concat", "-safe", "0",
            "-i", list_path,
            "-c", "copy",
            out_path,
        ]
        proc = _run_ffmpeg(cmd, _timeout_for(files, copy=True))
        err = (proc.stderr or b"").decode("utf-8", errors="replace").strip()
        if proc.returncode == 0 and _ok_file(out_path):
            return True, err
        _remove(out_path)
        return False, err or f"ffmpeg 退出码 {proc.returncode}"
    except subprocess.TimeoutExpired:
        _remove(out_path)
        return False, "复制拼合超时"
    finally:
        _remove(list_path)


def _even(n: int) -> int:
    n = max(2, int(n))
    return n if n % 2 == 0 else n + 1


def _concat_reencode(ffmpeg: str, files: list[str], probes: list[dict], out_path: str, fps: float) -> str:
    base = probes[0] if probes else {}
    w = _even(int(base.get("w") or 0) or 64)
    h = _even(int(base.get("h") or 0) or 64)
    fps = max(1.0, float(fps or 0) or float(base.get("fps") or 0) or 24.0)
    fps_s = f"{fps:.3f}".rstrip("0").rstrip(".")
    any_audio = any(bool(p.get("audio")) for p in probes)
    cmd = [ffmpeg, "-y", "-v", "error"]
    for p in files:
        cmd += ["-i", p]
    parts = []
    labels = []
    for i, pr in enumerate(probes):
        parts.append(
            f"[{i}:v]scale={w}:{h}:force_original_aspect_ratio=decrease,"
            f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,fps={fps_s},setsar=1,format=yuv420p[v{i}]"
        )
        if not any_audio:
            labels.append(f"[v{i}]")
            continue
        dur = float(pr.get("duration") or 0)
        if dur <= 0.05:
            dur = 0.1
        if pr.get("audio"):
            parts.append(
                f"[{i}:a]aformat=sample_rates=48000:channel_layouts=stereo,"
                f"atrim=0:{dur:.3f},asetpts=PTS-STARTPTS[a{i}]"
            )
        else:
            parts.append(
                f"anullsrc=channel_layout=stereo:sample_rate=48000,"
                f"atrim=0:{dur:.3f},asetpts=PTS-STARTPTS[a{i}]"
            )
        labels.append(f"[v{i}][a{i}]")
    n = len(files)
    if any_audio:
        parts.append("".join(labels) + f"concat=n={n}:v=1:a=1[v0][a]")
        parts.append(f"[v0]fps={fps_s}[v]")
        maps = ["-map", "[v]", "-map", "[a]", "-c:a", "aac", "-b:a", "192k"]
    else:
        parts.append("".join(labels) + f"concat=n={n}:v=1:a=0[v0]")
        parts.append(f"[v0]fps={fps_s}[v]")
        maps = ["-map", "[v]"]
    cmd += [
        "-filter_complex", ";".join(parts),
        *maps,
        "-r", fps_s,
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "fast",
        "-movflags", "+faststart",
        out_path,
    ]
    try:
        proc = _run_ffmpeg(cmd, _timeout_for(files, copy=False))
    except subprocess.TimeoutExpired:
        _remove(out_path)
        raise RuntimeError("重编码拼合超时")
    if proc.returncode != 0 or not _ok_file(out_path):
        err = (proc.stderr or b"").decode("utf-8", errors="replace").strip()
        _remove(out_path)
        raise RuntimeError(err[:800] or "拼合失败")
    return "重编码"


def _next_output_path(prefix: str) -> tuple[str, str]:
    """返回 (成片绝对路径, 相对 output 的子目录)。"""
    prefix = _clean_prefix(prefix)
    out_root = folder_paths.get_output_directory()
    folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(prefix, out_root)
    os.makedirs(folder, exist_ok=True)
    while counter < 99999:
        path = os.path.join(folder, f"{filename}_{counter:05}.mp4")
        if not os.path.exists(path):
            return path, (subfolder or "").replace("\\", "/")
        counter += 1
    raise RuntimeError("成片序号已超过 99999")


class LazyVideoSave:
    """读取本地分段，拼合后按序号保存成片。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "H3视频片段包": ("H3_VIDEO_CLIPS", {
                    "tooltip": "接逐段生成的片段包。",
                }),
                "帧率": ("FLOAT", {
                    "default": 24.0, "min": 1.0, "max": 120.0, "step": 1.0,
                    "tooltip": "成片帧率。",
                }),
                "文件名": ("STRING", {
                    "default": "lazy",
                    "tooltip": "文件名前缀。可用 文件夹/名称。",
                }),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("成片路径", "信息")
    FUNCTION = "save"
    CATEGORY = "Lazy/H3"
    OUTPUT_NODE = True
    DESCRIPTION = "把本地分段按序号拼成一条。文件名自动递增。"

    def save(self, H3视频片段包=None, 帧率=24.0, 文件名="lazy", **kwargs):
        pack = H3视频片段包 if H3视频片段包 is not None else kwargs.get("clips_pack")
        files = _collect_segments(pack)
        try:
            fps = float(帧率 if 帧率 is not None else kwargs.get("frame_rate", 24.0) or 24.0)
        except Exception:
            fps = 24.0
        fps = max(1.0, min(120.0, fps))
        prefix = 文件名 if 文件名 not in (None, "") else kwargs.get("filename_prefix", "lazy")
        out_path, subfolder = _next_output_path(str(prefix or "lazy"))
        ffmpeg = _find_ffmpeg()
        if not ffmpeg:
            raise RuntimeError("未找到 ffmpeg。请安装 imageio-ffmpeg 或系统 ffmpeg。")

        probes = [_probe(ffmpeg, p) for p in files]
        mode = "复制"
        if _streams_match(probes, fps):
            ok, err = _concat_copy(ffmpeg, files, out_path)
            if not ok:
                log.warning("[Lazy] 复制拼合失败，改为重编码: %s", (err or "")[:300])
                mode = _concat_reencode(ffmpeg, files, probes, out_path, fps)
        else:
            log.info("[Lazy] 分段参数不一致或帧率不同，重编码拼合 @%.3ffps", fps)
            mode = _concat_reencode(ffmpeg, files, probes, out_path, fps)

        names = "、".join(os.path.basename(p) for p in files)
        info = f"已拼合 {len(files)} 段（{mode}）→ {out_path}\n{names}"
        log.info("[Lazy] %s", info.replace("\n", " | "))
        preview = {
            "filename": os.path.basename(out_path),
            "subfolder": subfolder,
            "type": "output",
            "format": "video/mp4",
            "frame_rate": fps,
        }
        return {"ui": {"gifs": [preview]}, "result": (out_path, info)}
