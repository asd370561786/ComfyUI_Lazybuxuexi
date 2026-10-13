import logging
import asyncio
import json
import base64
import io as _io
import math

import numpy as np
import torch
import torch.nn.functional as F
import av
from PIL import Image

import os
import platform
import folder_paths
import comfy.model_management
import node_helpers
from server import PromptServer
from aiohttp import web

from comfy_api.latest import io

log = logging.getLogger(__name__)

_registered_routes = set()
_pending_routes = []


def _try_register_route(method, path, fn):
    key = (method, path)
    if key in _registered_routes:
        return True
    try:
        server = getattr(PromptServer, "instance", None)
        if server is not None and hasattr(server, "routes"):
            getattr(server.routes, method)(path)(fn)
            _registered_routes.add(key)
            log.info("[WanRemixDirector] Registered route %s %s", method.upper(), path)
            return True
    except Exception as e:
        log.warning("[WanRemixDirector] Could not register route %s %s: %s", method, path, e)
    return False


def ensure_director_routes():
    """Retry routes that failed because PromptServer was not ready at import time."""
    still = []
    for method, path, fn in _pending_routes:
        if not _try_register_route(method, path, fn):
            still.append((method, path, fn))
    _pending_routes[:] = still
    # Also retry video UI routes if available
    try:
        from .load_video_ui import ensure_video_ui_routes
        ensure_video_ui_routes()
    except Exception:
        pass


def _safe_route(method, path):
    """Register aiohttp route immediately, or queue until ensure_director_routes()."""
    def deco(fn):
        if not _try_register_route(method, path, fn):
            _pending_routes.append((method, path, fn))
        return fn
    return deco


# Default Remix model filenames (relative to diffusion_models / unet)
DEFAULT_HIGH_MODEL = "Animate/Wan2.2_Remix_NSFW_i2v_14b_high_lighting_fp8_e4m3fn_v3.0.safetensors"
DEFAULT_LOW_MODEL = "Animate/Wan2.2_Remix_NSFW_i2v_14b_low_lighting_fp8_e4m3fn_v3.0.safetensors"

# Setup global event loop exception handler to silence ConnectionResetError (WinError 10054/10053) on Windows
try:
    loop = None
    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        try:
            loop = asyncio.get_event_loop_policy().get_event_loop()
        except Exception:
            pass

    if loop is not None:
        old_handler = loop.get_exception_handler()
        
        def silence_connection_reset_handler(loop, context):
            exception = context.get('exception')
            if (isinstance(exception, (ConnectionResetError, ConnectionAbortedError)) or 
                (isinstance(exception, OSError) and getattr(exception, 'winerror', None) in (10054, 10053))):
                # Suppress WinError 10054 and WinError 10053 tracebacks in logging
                return
            if old_handler:
                old_handler(loop, context)
            else:
                loop.default_exception_handler(context)
                
        loop.set_exception_handler(silence_connection_reset_handler)
except Exception:
    pass

# Custom socket type shared with WanRemixSequencer
GuideData = io.Custom("GUIDE_DATA")
MotionGuideData = io.Custom("MOTION_GUIDE_DATA")

# --- File Check Endpoint for Deduplication ---
@_safe_route("get", "/wan_remix_director_check_file")
async def wan_remix_director_check_file(request):
    filename = request.query.get("filename", "")
    file_size = request.query.get("size", "")
    if not filename:
        return web.json_response({"exists": False})

    upload_dir = folder_paths.get_input_directory()
    temp_dir = os.path.join(upload_dir, "whatdreamscost")
    
    # 1. Check if the exact filename exists in whatdreamscost or root input dir
    possible_paths = [
        os.path.join(temp_dir, filename),
        os.path.join(upload_dir, filename)
    ]
    
    found_path = None
    for p in possible_paths:
        if os.path.exists(p) and os.path.isfile(p):
            if file_size:
                try:
                    if os.path.getsize(p) == int(file_size):
                        found_path = p
                        break
                except ValueError:
                    found_path = p
                    break
            else:
                found_path = p
                break
                
    if found_path:
        rel_name = os.path.relpath(found_path, upload_dir).replace('\\', '/')
        return web.json_response({"exists": True, "name": rel_name})

    # 2. Suffix search if exact match not found
    base_name = os.path.basename(filename)
    suffix = f"_{base_name}"
    try:
        for search_dir in [temp_dir, upload_dir]:
            if os.path.exists(search_dir):
                for f_name in os.listdir(search_dir):
                    if f_name.endswith(suffix) or f_name == base_name:
                        pot_path = os.path.join(search_dir, f_name)
                        if os.path.isfile(pot_path):
                            if file_size:
                                try:
                                    if os.path.getsize(pot_path) == int(file_size):
                                        rel_name = os.path.relpath(pot_path, upload_dir).replace('\\', '/')
                                        return web.json_response({"exists": True, "name": rel_name})
                                except ValueError:
                                    pass
                            else:
                                rel_name = os.path.relpath(pot_path, upload_dir).replace('\\', '/')
                                return web.json_response({"exists": True, "name": rel_name})
    except Exception as e:
        log.warning(f"[WanRemixDirector] Error listing input directory: {e}")

    return web.json_response({"exists": False})


def read_wav_peaks(wav_path):
    import wave
    peaks = []
    with wave.open(wav_path, "rb") as w:
        n_frames = w.getnframes()
        n_channels = max(1, w.getnchannels())
        sampwidth = w.getsampwidth()
        if n_frames <= 0:
            return [0.0] * 200
        frames_bytes = w.readframes(n_frames)
        if sampwidth == 2:
            samples = np.frombuffer(frames_bytes, dtype=np.int16).astype(np.float32)
            denom = 32767.0
        elif sampwidth == 1:
            samples = np.frombuffer(frames_bytes, dtype=np.uint8).astype(np.float32) - 128.0
            denom = 128.0
        elif sampwidth == 4:
            samples = np.frombuffer(frames_bytes, dtype=np.int32).astype(np.float32)
            denom = float(2**31 - 1)
        else:
            # Fallback: treat as int16 if size matches
            samples = np.frombuffer(frames_bytes, dtype=np.int16).astype(np.float32)
            denom = 32767.0
        if n_channels > 1:
            usable = (len(samples) // n_channels) * n_channels
            samples = samples[:usable].reshape(-1, n_channels).mean(axis=1)
        num_peaks = 200
        step = max(1, len(samples) // num_peaks)
        for i in range(num_peaks):
            chunk = samples[i * step : (i + 1) * step]
            if len(chunk) > 0:
                peaks.append(float(np.max(np.abs(chunk)) / denom))
            else:
                peaks.append(0.0)
    return peaks


def extract_audio_from_video(video_path):
    import wave
    try:
        base, _ = os.path.splitext(video_path)
        output_wav = base + "_extracted_audio.wav"
        
        # Check if already exists, is not empty, and has the correct 44100Hz sample rate
        if os.path.exists(output_wav) and os.path.getsize(output_wav) > 44:
            try:
                with wave.open(output_wav, 'rb') as w_check:
                    if w_check.getframerate() == 44100:
                        peaks = read_wav_peaks(output_wav)
                        input_dir = folder_paths.get_input_directory()
                        rel_output = os.path.relpath(output_wav, input_dir).replace('\\', '/')
                        return rel_output, peaks
            except Exception:
                pass

        # Decode the video using PyAV
        with av.open(video_path) as container:
            if not container.streams.audio:
                return None, None
            stream = container.streams.audio[0]
            
            # Setup resampler to 44100Hz, Mono, signed 16-bit integer (s16)
            resampler = av.AudioResampler(
                format='s16',
                layout='mono',
                rate=44100,
            )
            
            audio_bytes = bytearray()
            
            for frame in container.decode(stream):
                for resampled_frame in resampler.resample(frame):
                    arr = resampled_frame.to_ndarray()
                    audio_bytes.extend(arr.tobytes())
                    
            # Flush resampler
            for resampled_frame in resampler.resample(None):
                arr = resampled_frame.to_ndarray()
                audio_bytes.extend(arr.tobytes())
                
            if not audio_bytes:
                return None, None
                
            # Write WAV file
            with wave.open(output_wav, 'wb') as w:
                w.setnchannels(1)
                w.setsampwidth(2) # 16-bit
                w.setframerate(44100)
                w.writeframes(audio_bytes)
                
        # Calculate peaks
        peaks = []
        samples = np.frombuffer(audio_bytes, dtype=np.int16)
        num_peaks = 200
        step = max(1, len(samples) // num_peaks)
        for i in range(num_peaks):
            chunk = samples[i * step : (i + 1) * step]
            if len(chunk) > 0:
                max_val = np.max(np.abs(chunk)) / 32767.0
                peaks.append(float(max_val))
            else:
                peaks.append(0.0)
                
        input_dir = folder_paths.get_input_directory()
        rel_output = os.path.relpath(output_wav, input_dir).replace('\\', '/')
        return rel_output, peaks
    except Exception as e:
        print(f"[WanRemixDirector] Server audio extraction failed: {e}")
        return None, None


def get_audio_peaks(audio_path):
    import wave
    # If it is already a WAV file, read peaks directly
    _, ext = os.path.splitext(audio_path)
    if ext.lower() == ".wav":
        try:
            return read_wav_peaks(audio_path)
        except Exception:
            pass # fallback to PyAV
            
    # Use PyAV to decode and resample the audio file
    try:
        with av.open(audio_path) as container:
            if not container.streams.audio:
                return None
            stream = container.streams.audio[0]
            resampler = av.AudioResampler(
                format='s16',
                layout='mono',
                rate=8000,
            )
            audio_bytes = bytearray()
            for frame in container.decode(stream):
                for resampled_frame in resampler.resample(frame):
                    arr = resampled_frame.to_ndarray()
                    audio_bytes.extend(arr.tobytes())
            for resampled_frame in resampler.resample(None):
                arr = resampled_frame.to_ndarray()
                audio_bytes.extend(arr.tobytes())
                
            if not audio_bytes:
                return None
                
            peaks = []
            samples = np.frombuffer(audio_bytes, dtype=np.int16)
            num_peaks = 200
            step = max(1, len(samples) // num_peaks)
            for i in range(num_peaks):
                chunk = samples[i * step : (i + 1) * step]
                if len(chunk) > 0:
                    max_val = np.max(np.abs(chunk)) / 32767.0
                    peaks.append(float(max_val))
                else:
                    peaks.append(0.0)
            return peaks
    except Exception as e:
        print(f"[WanRemixDirector] Failed to get audio peaks via PyAV: {e}")
        return None


@_safe_route("get", "/wan_remix_director_get_audio")
async def wan_remix_director_get_audio(request):
    filename = request.query.get("filename")
    if not filename:
        return web.json_response({"error": "Missing filename"}, status=400)

    upload_dir = folder_paths.get_input_directory()
    
    clean_filename = filename.replace('\\', '/')
    file_path = os.path.join(upload_dir, clean_filename)
    if not os.path.exists(file_path):
        basename = os.path.basename(clean_filename)
        temp_path = os.path.join(upload_dir, "whatdreamscost", basename)
        if os.path.exists(temp_path):
            file_path = temp_path
        else:
            file_path = os.path.join(upload_dir, basename)
        
    if not os.path.exists(file_path) or not os.path.isfile(file_path):
        return web.json_response({"error": "File not found"}, status=404)

    _, ext = os.path.splitext(file_path)
    is_audio = ext.lower() in [".wav", ".mp3", ".ogg", ".flac", ".m4a"]
    
    if is_audio:
        peaks = None
        try:
            peaks = get_audio_peaks(file_path)
        except Exception as e:
            print(f"[WanRemixDirector] Failed to get audio peaks for audio file: {e}")
            
        rel_path = os.path.relpath(file_path, upload_dir).replace('\\', '/')
        return web.json_response({
            "audio_file": rel_path,
            "peaks": peaks
        })

    audio_file, peaks = None, None
    try:
        loop = asyncio.get_event_loop()
        audio_file, peaks = await loop.run_in_executor(None, extract_audio_from_video, file_path)
    except Exception as e:
        print(f"[WanRemixDirector] Error extracting audio: {e}")

    return web.json_response({
        "audio_file": audio_file,
        "peaks": peaks
    })


@_safe_route("get", "/wan_remix_director_open_folder")
async def wan_remix_director_open_folder(request):
    upload_dir = os.path.join(folder_paths.get_input_directory(), "whatdreamscost")
    os.makedirs(upload_dir, exist_ok=True)
    try:
        if hasattr(os, "startfile"):
            os.startfile(upload_dir)
        else:
            import webbrowser
            webbrowser.open(os.path.abspath(upload_dir))
        return web.json_response({"success": True})
    except Exception as e:
        print(f"[WanRemixDirector] Failed to open workspace folder: {e}")
        return web.json_response({"success": False, "error": str(e)}, status=500)


def _read_and_write_file_chunk(file, file_path, mode):
    chunk_bytes = file.file.read()
    with open(file_path, mode) as f:
        f.write(chunk_bytes)


# --- LTX Director Chunked Video Upload Endpoint ---
# Bypasses the 413 Payload Too Large error for large video files.
# This endpoint is self-contained and independent of any other node.
@_safe_route("post", "/wan_remix_director_upload_chunk")
async def wan_remix_director_upload_chunk(request):
    post = await request.post()
    file = post.get("file")
    filename = post.get("filename")
    chunk_index = int(post.get("chunk_index"))
    total_chunks = int(post.get("total_chunks"))

    upload_dir = os.path.join(folder_paths.get_input_directory(), "whatdreamscost")
    os.makedirs(upload_dir, exist_ok=True)

    # Sanitize filename to prevent path traversal attacks (e.g. ../../etc/passwd)
    filename = os.path.basename(filename)
    file_path = os.path.join(upload_dir, filename)

    # Belt-and-suspenders: confirm the resolved path is still inside the upload directory
    if not os.path.realpath(file_path).startswith(os.path.realpath(upload_dir)):
        return web.json_response({"error": "Invalid filename"}, status=400)

    # Append chunk to file (write fresh on first chunk, append on subsequent)
    mode = "ab" if chunk_index > 0 else "wb"
    
    # Offload the blocking read/write disk I/O to a thread executor
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _read_and_write_file_chunk, file, file_path, mode)

    if chunk_index == total_chunks - 1:
        audio_file, peaks = None, None
        try:
            audio_file, peaks = await loop.run_in_executor(None, extract_audio_from_video, file_path)
        except Exception as e:
            print(f"[WanRemixDirector] Error in final chunk audio extraction: {e}")
            
        return web.json_response({
            "name": f"whatdreamscost/{filename}",
            "audio_file": audio_file,
            "peaks": peaks
        })
    return web.json_response({"status": "ok"})



def _media_root_for_type(media_type: str):
    """Comfy 媒体根目录：input / output / temp。"""
    t = (media_type or "input").lower().strip()
    try:
        if t == "output":
            return folder_paths.get_output_directory()
        if t == "temp":
            return folder_paths.get_temp_directory()
    except Exception:
        pass
    return folder_paths.get_input_directory()


def _resolve_input_media_path(rel_or_name: str, media_type: str = "input"):
    """
    解析时间线媒体路径。
    media_type: input | output | temp（资产拖入可能来自 output）。
    禁止仅按文件名到别的目录乱匹配，避免拖入 A 却加载到同名 B。
    """
    if not rel_or_name:
        return None
    clean = str(rel_or_name).replace("\\", "/").strip()
    if clean.endswith("]"):
        clean = clean.rsplit("[", 1)[0].strip()
    clean = clean.lstrip("/")
    parts = [p for p in clean.split("/") if p and p != "."]
    if not parts or any(p == ".." for p in parts):
        return None

    type_order = []
    mt = (media_type or "input").lower().strip()
    if mt in ("input", "output", "temp"):
        type_order.append(mt)
    for t in ("input", "output", "temp"):
        if t not in type_order:
            type_order.append(t)

    for t in type_order:
        root = _media_root_for_type(t)
        if not root:
            continue
        candidate = os.path.normpath(os.path.join(root, *parts))
        try:
            real_root = os.path.realpath(root)
            real_cand = os.path.realpath(candidate)
            if os.path.isfile(real_cand) and (
                real_cand == real_root or real_cand.startswith(real_root + os.sep)
            ):
                return real_cand
        except Exception:
            pass
        if len(parts) == 1 and t == "input":
            p2 = os.path.join(root, "whatdreamscost", parts[0])
            try:
                real_p2 = os.path.realpath(p2)
                real_root = os.path.realpath(root)
                if os.path.isfile(real_p2) and real_p2.startswith(real_root + os.sep):
                    return real_p2
            except Exception:
                pass
    return None


def _parse_view_url_to_path(url_or_path: str):
    """从 /view?filename=&subfolder=&type= 解析出本地文件路径。"""
    if not url_or_path or not isinstance(url_or_path, str):
        return None
    s = url_or_path.strip()
    if "filename=" not in s and "/view" not in s:
        return None
    try:
        from urllib.parse import urlparse, parse_qs
        if s.startswith("/"):
            s = "http://local" + s
        elif not s.startswith("http"):
            if "filename=" in s:
                s = "http://local/view?" + s.lstrip("?")
        u = urlparse(s)
        qs = parse_qs(u.query)
        filename = (qs.get("filename") or [None])[0]
        if not filename:
            return None
        subfolder = (qs.get("subfolder") or [""])[0] or ""
        mtype = (qs.get("type") or ["input"])[0] or "input"
        rel = f"{subfolder}/{filename}".replace("\\", "/").strip("/") if subfolder else filename
        return _resolve_input_media_path(rel, mtype)
    except Exception:
        return None


def _load_image_tensor(seg: dict, required: bool = True):
    """Decode image to [1,H,W,3] float32. Returns None if missing and required=False."""
    media_type = seg.get("imageMediaType") or seg.get("mediaType") or "input"

    if seg.get("imageFile"):
        file_path = _resolve_input_media_path(seg["imageFile"], media_type)
        if file_path:
            img = Image.open(file_path).convert("RGB")
            arr = np.array(img, dtype=np.float32) / 255.0
            return torch.from_numpy(arr).unsqueeze(0)

    b64_str = seg.get("imageB64", "") or ""
    # 预览 URL：/view 或 /api/view → 按 query 读本地正确目录下的文件
    if isinstance(b64_str, str) and ("/view" in b64_str or "filename=" in b64_str):
        file_path = _parse_view_url_to_path(b64_str)
        if file_path:
            img = Image.open(file_path).convert("RGB")
            arr = np.array(img, dtype=np.float32) / 255.0
            return torch.from_numpy(arr).unsqueeze(0)
        if required:
            raise FileNotFoundError(
                f"Image not found (view url): file={seg.get('imageFile')} type={media_type} url={str(b64_str)[:160]}"
            )
        return None

    if not b64_str:
        if required:
            raise FileNotFoundError(
                f"Image not found: file={seg.get('imageFile')} type={media_type} id={seg.get('id')}"
            )
        return None

    if "," in b64_str:
        b64_str = b64_str.split(",", 1)[1]

    try:
        img_bytes = base64.b64decode(b64_str)
        img = Image.open(_io.BytesIO(img_bytes)).convert("RGB")
        arr = np.array(img, dtype=np.float32) / 255.0
        return torch.from_numpy(arr).unsqueeze(0)
    except Exception as e:
        if required:
            raise ValueError(f"Failed to decode imageB64 for segment {seg.get('id')}: {e}") from e
        return None


def _load_video_tensor(seg: dict, frame_rate: float, required: bool = True):
    """Extracts frames from a video file based on trim parameters → [N,H,W,3] float32."""
    file_path = _resolve_input_media_path(seg.get("imageFile", "") or seg.get("videoFile", ""))
    if not file_path:
        if required:
            raise FileNotFoundError(f"Video not found in input: {seg.get('imageFile') or seg.get('videoFile')}")
        return None

    trim_start_frames = float(seg.get("trimStart", 0))
    length_frames = float(seg.get("length", 1))
    start_sec = trim_start_frames / frame_rate
    
    frames = []
    try:
        with av.open(file_path) as container:
            stream = container.streams.video[0]
            stream.thread_type = "AUTO"

            if stream.time_base:
                seek_pts = int((max(0, start_sec - 0.5)) / float(stream.time_base))
            else:
                seek_pts = int((max(0, start_sec - 0.5)) * av.time_base)

            container.seek(seek_pts, stream=stream, backward=True)

            for frame in container.decode(stream):
                frame_time = frame.time
                if frame_time is None and frame.pts is not None and stream.time_base:
                    frame_time = float(frame.pts * stream.time_base)
                if frame_time is None:
                    frame_time = 0.0
                if frame_time < start_sec - 0.01:
                    continue
                frames.append(frame.to_ndarray(format="rgb24"))
                if len(frames) >= int(length_frames):
                    break
    except Exception as e:
        if required:
            raise RuntimeError(f"Video extract failed for {file_path}: {e}") from e
        log.warning("[WanRemixDirector] Video extract error: %s", e)
        return None

    if not frames:
        if required:
            raise ValueError(f"No frames decoded from video: {file_path}")
        return None

    frames_np = np.array(frames, dtype=np.float32) / 255.0
    return torch.from_numpy(frames_np)

def _resize_image(tensor: torch.Tensor, target_w: int, target_h: int, method: str, divisible_by: int) -> torch.Tensor:
    """Resize an [N, H, W, 3] float32 tensor to target dimensions using the given method,
    then snap the final dimensions to be divisible by `divisible_by`."""
    
    def snap(val, div):
        return max(div, (val // div) * div)

    tw = snap(target_w, divisible_by)
    th = snap(target_h, divisible_by)

    N, H, W, C = tensor.shape
    if H == th and W == tw:
        return tensor

    t_nchw = tensor.permute(0, 3, 1, 2)
    
    if method == "stretch to fit":
        resized = F.interpolate(t_nchw, size=(th, tw), mode="bilinear", align_corners=False)
        
    elif method == "maintain aspect ratio":
        ratio = min(tw / W, th / H)
        new_w = snap(int(W * ratio), divisible_by)
        new_h = snap(int(H * ratio), divisible_by)
        resized = F.interpolate(t_nchw, size=(new_h, new_w), mode="bilinear", align_corners=False)
        
    elif method == "pad" or method == "pad green":
        ratio = min(tw / W, th / H)
        new_w = snap(int(W * ratio), divisible_by)
        new_h = snap(int(H * ratio), divisible_by)
        inner = F.interpolate(t_nchw, size=(new_h, new_w), mode="bilinear", align_corners=False)
        
        pad_l = (tw - new_w) // 2
        pad_t = (th - new_h) // 2
        
        if method == "pad green":
            resized = torch.zeros((N, C, th, tw), dtype=t_nchw.dtype, device=t_nchw.device)
            # #66FF00 is roughly R: 102/255, G: 255/255, B: 0
            resized[:, 0, :, :] = 102 / 255.0
            resized[:, 1, :, :] = 1.0
            resized[:, 2, :, :] = 0.0
            resized[:, :, pad_t:pad_t+new_h, pad_l:pad_l+new_w] = inner
        else:
            resized = F.pad(inner, (pad_l, tw - new_w - pad_l, pad_t, th - new_h - pad_t), mode="constant", value=0)
        
    elif method == "crop":
        ratio = max(tw / W, th / H)
        new_w = int(W * ratio)
        new_h = int(H * ratio)
        inner = F.interpolate(t_nchw, size=(new_h, new_w), mode="bilinear", align_corners=False)
        
        left = (new_w - tw) // 2
        top = (new_h - th) // 2
        resized = inner[:, :, top:top+th, left:left+tw]
        
    else:
        resized = F.interpolate(t_nchw, size=(th, tw), mode="bilinear", align_corners=False)

    return resized.permute(0, 2, 3, 1)


def _compress_image(tensor: torch.Tensor, crf: int) -> torch.Tensor:
    """Apply H.264 compression artefacts to an [N, H, W, 3] float32 tensor (ComfyUI image format).
    crf=0 means no compression. Uses PyAV to encode/decode frames in-memory."""
    if crf == 0:
        return tensor
        
    N, H, W, C = tensor.shape
    
    # Dimensions must be even for H.264
    h = (H // 2) * 2
    w = (W // 2) * 2
    
    # uint8 [N, H, W, 3]
    tensor_bytes = (tensor[:, :h, :w, :] * 255.0).byte().cpu().numpy()
    
    try:
        buf = _io.BytesIO()
        container = av.open(buf, mode="w", format="mp4")
        stream = container.add_stream("libx264", rate=24)
        stream.width = w
        stream.height = h
        stream.pix_fmt = "yuv420p"
        stream.options = {"crf": str(crf), "preset": "ultrafast"}
        
        for i in range(N):
            frame = av.VideoFrame.from_ndarray(tensor_bytes[i], format="rgb24")
            for pkt in stream.encode(frame):
                container.mux(pkt)
                
        for pkt in stream.encode(None):
            container.mux(pkt)
            
        container.close()
        
        buf.seek(0)
        container_r = av.open(buf, mode="r")
        decoded = [frame_r.to_ndarray(format="rgb24") for frame_r in container_r.decode(video=0)]
        container_r.close()
        
        if not decoded:
            return tensor
            
        decoded_np = np.stack(decoded).astype(np.float32) / 255.0
        
        # Re-embed into original tensor shape (may have been cropped by even-rounding)
        out = tensor.clone()
        dec_N = min(N, len(decoded))
        out[:dec_N, :h, :w] = torch.from_numpy(decoded_np[:dec_N]).to(tensor.device, tensor.dtype)
        
        return out
        
    except Exception as e:
        log.warning("[PromptRelay] img_compression encode/decode failed: %s", e)
        return tensor


def _build_combined_audio(timeline_data_str: str, start_frame: int, duration_frames: int, frame_rate: float, override_audio: bool = False) -> dict:
    """Parses timeline JSON, loads/trims audio directly from memory using PyAV, 
    and aligns to a global timeline yielding ComfyUI's format.
    Output length explicitly mimics the timeline's duration_frames length."""
    target_sr = 44100
    total_samples = max(1, int(math.ceil(duration_frames / frame_rate * target_sr)))
    empty_audio = {"waveform": torch.zeros((1, 2, total_samples), dtype=torch.float32), "sample_rate": target_sr}

    if not timeline_data_str:
        return empty_audio

    try:
        data = json.loads(timeline_data_str)
        is_retake = data.get("retakeMode", False)
        if is_retake and data.get("retakeVideo"):
            retake_vid = data.get("retakeVideo")
            audio_segs = [{
                "videoFile": retake_vid.get("imageFile") or retake_vid.get("fileName"),
                "audioFile": retake_vid.get("imageFile") or retake_vid.get("fileName"),
                "start": 0,
                "length": retake_vid.get("videoDurationFrames", duration_frames),
                "trimStart": 0
            }]
            override_audio = True
        elif override_audio:
            audio_segs = data.get("motionSegments", [])
        else:
            audio_segs = data.get("audioSegments", [])
    except Exception:
        return empty_audio

    if not audio_segs:
        return empty_audio

    out_waveform = torch.zeros((2, total_samples), dtype=torch.float32)

    for seg in audio_segs:
        buffer = None
        file_key = "videoFile" if override_audio else "audioFile"
        if seg.get(file_key):
            file_path = os.path.join(folder_paths.get_input_directory(), seg[file_key])
            if not os.path.exists(file_path):
                # Try fallback under whatdreamscost subfolder
                basename = os.path.basename(seg[file_key])
                fallback_path = os.path.join(folder_paths.get_input_directory(), "whatdreamscost", basename)
                if os.path.exists(fallback_path):
                    file_path = fallback_path

            if os.path.exists(file_path):
                with open(file_path, "rb") as f:
                    buffer = _io.BytesIO(f.read())
        
        if not override_audio and not buffer and seg.get("audioB64"):
            b64 = seg.get("audioB64")
            if "," in b64:
                b64 = b64.split(",", 1)[1]
            try:
                audio_bytes = base64.b64decode(b64)
                buffer = _io.BytesIO(audio_bytes)
            except:
                pass
                
        if not buffer:
            continue

        try:
            clip_frames = []
            
            # Use PyAV to decode directly from memory buffer
            with av.open(buffer) as container:
                if not container.streams.audio:
                    continue
                stream = container.streams.audio[0]
                
                # Setup resampler to ensure output is 44.1kHz, Stereo, Float32 Planar
                resampler = av.AudioResampler(
                    format='fltp',
                    layout='stereo',
                    rate=target_sr,
                )
                
                for frame in container.decode(stream):
                    for resampled_frame in resampler.resample(frame):
                        # to_ndarray() on fltp gives shape (channels, samples)
                        arr = resampled_frame.to_ndarray()
                        clip_frames.append(torch.from_numpy(arr))
                
                # Flush the resampler to get any remaining samples
                for resampled_frame in resampler.resample(None):
                    arr = resampled_frame.to_ndarray()
                    clip_frames.append(torch.from_numpy(arr))

            if not clip_frames:
                continue

            # Concatenate all frame blocks along the samples dimension (dim 1)
            waveform = torch.cat(clip_frames, dim=1) # Shape: [2, total_clip_samples]

            # Calculate interactive trim boundaries
            trim_start_frames = float(seg.get("trimStart", 0))
            length_frames = float(seg.get("length", 1))
            start_frames = float(seg.get("start", 0))
            
            if start_frames + length_frames <= start_frame:
                continue
                
            offset = max(0, start_frame - start_frames)
            trim_start_frames += offset
            length_frames = max(1, length_frames - offset)
            start_frames = max(0, start_frames - start_frame)

            start_sample_src = int(trim_start_frames / frame_rate * target_sr)
            length_samples = int(length_frames / frame_rate * target_sr)
            end_sample_src = start_sample_src + length_samples

            if start_sample_src < 0: start_sample_src = 0
            if end_sample_src > waveform.shape[1]:
                end_sample_src = waveform.shape[1]

            actual_length = end_sample_src - start_sample_src
            if actual_length <= 0: continue

            # Extract the correct segment of the audio
            clip_waveform = waveform[:, start_sample_src:end_sample_src]

            # Position onto the timeline
            start_sample_dst = int(start_frames / frame_rate * target_sr)
            
            if start_sample_dst >= out_waveform.shape[1]:
                continue
                
            end_sample_dst = start_sample_dst + actual_length

            # Clip any trailing overflow so we don't index past the timeline bounds
            if end_sample_dst > out_waveform.shape[1]:
                actual_length = out_waveform.shape[1] - start_sample_dst
                clip_waveform = clip_waveform[:, :actual_length]
                end_sample_dst = start_sample_dst + actual_length
                
            if actual_length <= 0:
                continue

            # Additive composite (allows clips overlapping to sum together naturally)
            out_waveform[:, start_sample_dst:end_sample_dst] += clip_waveform

        except Exception as e:
            log.warning("[PromptRelay] Audio process error for segment %s: %s", seg.get("fileName"), e)
            continue

    peak = out_waveform.abs().max()
    if peak.item() > 1.0:
        out_waveform = out_waveform / peak

    return {"waveform": out_waveform.unsqueeze(0), "sample_rate": target_sr}


def _wan_pixel_frames(duration_frames: int) -> int:
    """Wan I2V expects length = 4n+1 pixel frames."""
    n = max(1, int(duration_frames))
    return max(5, ((n - 1) // 4) * 4 + 1)


# UI 中文选项 ↔ 内部处理用英文（_resize_image 等）
_RESIZE_METHOD_MAP = {
    "保持宽高比": "maintain aspect ratio",
    "拉伸填充": "stretch to fit",
    "填充黑边": "pad",
    "填充绿边": "pad green",
    "裁剪": "crop",
    # 兼容旧英文值
    "maintain aspect ratio": "maintain aspect ratio",
    "stretch to fit": "stretch to fit",
    "pad": "pad",
    "pad green": "pad green",
    "crop": "crop",
}

_DISPLAY_MODE_MAP = {
    "帧": "frames",
    "秒": "seconds",
    "frames": "frames",
    "seconds": "seconds",
}


def _normalize_resize_method(value) -> str:
    if not value:
        return "maintain aspect ratio"
    return _RESIZE_METHOD_MAP.get(str(value), "maintain aspect ratio")


def _normalize_display_mode(value) -> str:
    if not value:
        return "seconds"
    return _DISPLAY_MODE_MAP.get(str(value), "seconds")


def _wan_latent_frames(pixel_frames: int) -> int:
    return max(1, ((max(1, int(pixel_frames)) - 1) // 4) + 1)


def _dummy_guide_source_dimensions(custom_width=0, custom_height=0):
    return custom_width if custom_width > 0 else 768, custom_height if custom_height > 0 else 512

def _resolve_output_base_dimensions(custom_width=0, custom_height=0, use_ic_video_size=False, is_retake=False, ic_video_dimensions=None):
    if use_ic_video_size and not is_retake and ic_video_dimensions:
        return ic_video_dimensions
    return _dummy_guide_source_dimensions(custom_width, custom_height)

def _first_motion_video_dimensions(tdata: dict):
    for mseg in tdata.get("motionSegments", []):
        v_file = mseg.get("videoFile")
        if not v_file:
            continue
        v_path = os.path.join(folder_paths.get_input_directory(), v_file)
        if not os.path.exists(v_path):
            basename = os.path.basename(v_file)
            fallback_path = os.path.join(folder_paths.get_input_directory(), "whatdreamscost", basename)
            if os.path.exists(fallback_path):
                v_path = fallback_path
        if os.path.exists(v_path):
            try:
                with av.open(v_path) as container:
                    stream = container.streams.video[0]
                    return stream.width or stream.codec_context.width, stream.height or stream.codec_context.height
            except Exception:
                pass
    return None


def _build_timeline_prompt(global_prompt, local_prompts, segment_lengths="", frame_rate=24.0):
    """Join director global + local segment prompts into a single Wan text prompt.

    Wan models do not use LTX-style token-time attention masks, so we produce one
    chronological prompt string that still preserves timeline order and intent.
    """
    global_prompt = (global_prompt or "").strip()
    local_prompts = local_prompts or ""
    locals_list = [p.strip() for p in local_prompts.split("|")]

    # Drop trailing empty splits produced by the editor when no local segments exist.
    if len(locals_list) == 1 and not locals_list[0]:
        locals_list = []

    lengths = []
    if segment_lengths and str(segment_lengths).strip():
        try:
            lengths = [int(float(x.strip())) for x in str(segment_lengths).split(",") if x.strip()]
        except Exception:
            lengths = []

    parts = []
    if global_prompt:
        parts.append(global_prompt)

    cursor = 0.0
    for i, prompt in enumerate(locals_list):
        if not prompt:
            continue
        seg_len = lengths[i] if i < len(lengths) else 0
        if seg_len > 0 and frame_rate > 0:
            t0 = cursor / float(frame_rate)
            t1 = (cursor + seg_len) / float(frame_rate)
            parts.append(f"[t={t0:.2f}-{t1:.2f}s] {prompt}")
            cursor += seg_len
        else:
            parts.append(prompt)

    full = " ".join(parts).strip()
    if not full:
        full = "cinematic video, high quality"
    return full


def _encode_wan_prompts(clip, positive_text, negative_text):
    positive_text = positive_text or ""
    negative_text = negative_text or ""
    positive = clip.encode_from_tokens_scheduled(clip.tokenize(positive_text))
    negative = clip.encode_from_tokens_scheduled(clip.tokenize(negative_text))
    return positive, negative


class WanRemixDirector(io.ComfyNode):
    """WYSIWYG director timeline for Wan2.2 Remix high/low MoE I2V models."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="WanRemixDirector",
            display_name="Lazy Wan2.2 Remix 导演台",
            category="WanRemix/Director",
            description=(
                "Lazy · Wan2.2 Remix 双专家（high/low lighting）导演台时间线。"
                "宽度/高度为生成分辨率（任意比例），总帧数建议 4n+1（如 49/65/81）。"
            ),
            search_aliases=["Lazy", "导演台", "Wan Remix", "Director", "宽", "高", "帧数"],
            inputs=[
                # --- 模型 ---
                io.Model.Input(
                    "model_high_noise",
                    display_name="高噪声模型",
                    tooltip="Remix high_lighting 专家模型",
                ),
                io.Model.Input(
                    "model_low_noise",
                    display_name="低噪声模型",
                    tooltip="Remix low_lighting 专家模型",
                ),
                io.Clip.Input(
                    "clip",
                    display_name="文本编码器",
                    tooltip="Wan 文本编码器（type=wan，如 UMT5-XXL）",
                ),
                io.Latent.Input(
                    "optional_latent",
                    display_name="可选潜空间",
                    optional=True,
                    tooltip="可选。接入后覆盖自动生成的空 latent",
                ),
                # --- 生成尺寸 / 帧数（用户最关心的参数，放在前面）---
                io.Int.Input(
                    "custom_width",
                    display_name="宽度",
                    default=832, min=0, max=8192, step=16, optional=True,
                    tooltip="生成视频宽度（像素）。0=使用首张关键帧/时间线推断的宽度。可按任意比例设置。",
                ),
                io.Int.Input(
                    "custom_height",
                    display_name="高度",
                    default=480, min=0, max=8192, step=16, optional=True,
                    tooltip="生成视频高度（像素）。0=使用首张关键帧/时间线推断的高度。可按任意比例设置。",
                ),
                # 帧模式 / 秒模式成对：起始 → 结束 → 总长（切换显示时顺序一致）
                io.Int.Input(
                    "start_frame",
                    display_name="起始帧",
                    default=0, min=0, max=10000, step=1,
                    tooltip="生成起始帧。",
                ),
                io.Int.Input(
                    "end_frame",
                    display_name="结束帧",
                    default=81, min=0, max=10000, step=1,
                    tooltip="生成结束帧。",
                ),
                io.Int.Input(
                    "duration_frames",
                    display_name="总帧数",
                    default=81, min=1, max=10000, step=1,
                    tooltip="生成总帧数。可手动输入；手动修改后不再被轨道自动覆盖。Wan 推荐 4n+1（如 49/65/81）。",
                ),
                io.Float.Input(
                    "start_second",
                    display_name="起始秒",
                    default=0.0, min=0.0, max=1000.0, step=0.01,
                    tooltip="生成起始时间（秒），与起始帧联动。",
                ),
                io.Float.Input(
                    "end_second",
                    display_name="结束秒",
                    default=5.0, min=0.0, max=1000.0, step=0.01,
                    tooltip="生成结束时间（秒），与结束帧联动。",
                ),
                io.Float.Input(
                    "duration_seconds",
                    display_name="总时长(秒)",
                    default=5.0, min=0.0, max=1000.0, step=0.01,
                    tooltip="总时长（秒）= 总帧数 / 帧率。可手动输入；手动修改后不再被轨道自动覆盖。",
                ),
                io.Float.Input(
                    "frame_rate",
                    display_name="帧率",
                    default=16, min=0, max=240, step=1, optional=True,
                    tooltip="帧率 FPS。",
                ),
                # --- 提示词 ---
                io.String.Input(
                    "global_prompt",
                    display_name="全局提示词",
                    multiline=True, default="", force_input=True, optional=True,
                    tooltip="全局提示词。也可在时间线面板中编辑。",
                ),
                io.String.Input(
                    "negative_prompt",
                    display_name="负向提示词",
                    multiline=True, default=(
                        "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，"
                        "整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，"
                        "画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，"
                        "静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走"
                    ),
                    optional=True,
                    tooltip="负向提示词。",
                ),
                # --- 缩放 / 画质 ---
                # COMBO 选项用英文值（前端校验稳定）；display_name 中文显示字段名
                io.Combo.Input(
                    "resize_method",
                    options=["maintain aspect ratio", "stretch to fit", "pad", "pad green", "crop"],
                    default="maintain aspect ratio",
                    display_name="缩放方式",
                    optional=True,
                    tooltip="关键帧缩放：maintain aspect ratio=保持宽高比, stretch to fit=拉伸, pad=黑边, pad green=绿边, crop=裁剪",
                ),
                io.Int.Input(
                    "divisible_by",
                    display_name="对齐倍数",
                    default=16, min=0, max=1024, step=1, optional=True,
                    tooltip="宽高对齐倍数。Wan 推荐 16。0 会在执行时当作 16。",
                ),
                io.Int.Input(
                    "img_compression",
                    display_name="关键帧压缩",
                    default=0, min=0, max=100, step=1, optional=True,
                    tooltip="关键帧 H.264 CRF 压缩，0=关闭。",
                ),
                io.Combo.Input(
                    "display_mode",
                    options=["frames", "seconds"],
                    default="seconds",
                    display_name="时间显示",
                    optional=True,
                    tooltip="时间轴标尺：frames=帧, seconds=秒",
                ),
                io.Float.Input(
                    "epsilon",
                    display_name="过渡参数",
                    default=0.001, min=0.0, max=0.99, step=0.0001,
                    tooltip="兼容 LTX 导演台 UI 的保留参数（Wan 侧基本不用）。",
                ),
                # --- 时间线内部状态（由 UI 自动写入，一般隐藏）---
                io.String.Input(
                    "timeline_data",
                    display_name="时间线数据",
                    default="",
                    tooltip="导演台时间线 JSON（自动维护，勿手改）。",
                ),
                io.String.Input(
                    "local_prompts",
                    display_name="分段提示词",
                    multiline=True, default="",
                    tooltip="由时间线自动填充的分段提示词。",
                ),
                io.String.Input(
                    "segment_lengths",
                    display_name="分段长度",
                    default="",
                    tooltip="由时间线自动填充的分段帧数列表。",
                ),
                io.String.Input(
                    "guide_strength",
                    display_name="关键帧强度",
                    default="",
                    tooltip="由时间线自动填充的关键帧强度。",
                ),
                io.String.Input(
                    "transition_smoothness",
                    display_name="转场平滑",
                    default="", optional=True,
                    tooltip="由时间线自动填充。",
                ),
                io.Int.Input(
                    "overlap_frames",
                    display_name="重叠帧数",
                    default=1, min=1, max=64, step=1, optional=True,
                    tooltip="段间运动重叠帧数。1=仅用上一段最后一帧续接；更大则多帧重叠生成，拼合时裁掉重叠部分。数值越大越连贯，也更耗时/显存。",
                ),
            ],
            outputs=[
                io.Model.Output(display_name="高噪声模型"),
                io.Model.Output(display_name="低噪声模型"),
                io.Conditioning.Output(display_name="正向条件"),
                io.Conditioning.Output(display_name="负向条件"),
                io.Latent.Output(display_name="视频潜空间", tooltip="Wan 空 latent（4n+1 帧）。"),
                GuideData.Output(display_name="关键帧数据"),
                io.Float.Output(display_name="帧率"),
                io.Int.Output(display_name="帧数", tooltip="实际使用的像素帧数（4n+1）。"),
                io.Int.Output(display_name="宽度"),
                io.Int.Output(display_name="高度"),
            ],
        )

    @classmethod
    def execute(cls, **kwargs) -> io.NodeOutput:
        ensure_director_routes()
        # 严格按参数名取值，避免位置参数/显示名导致宽高、帧数错绑
        model_high_noise = kwargs["model_high_noise"]
        model_low_noise = kwargs["model_low_noise"]
        clip = kwargs["clip"]
        optional_latent = kwargs.get("optional_latent")
        global_prompt = kwargs.get("global_prompt") or ""
        negative_prompt = kwargs.get("negative_prompt") or ""
        start_second = float(kwargs.get("start_second", 0.0) or 0.0)
        end_second = float(kwargs.get("end_second", 5.0) or 5.0)
        duration_seconds = float(kwargs.get("duration_seconds", 5.0) or 5.0)
        start_frame = max(0, int(kwargs.get("start_frame", 0) or 0))
        end_frame = int(kwargs.get("end_frame", 0) or 0)
        # 不再把 0 强行当成 81；优先用总帧数，否则用结束-起始
        raw_duration = kwargs.get("duration_frames", None)
        if raw_duration is None:
            duration_frames = 81
        else:
            try:
                duration_frames = int(raw_duration)
            except Exception:
                duration_frames = 0
        if duration_frames < 1:
            if end_frame > start_frame:
                duration_frames = end_frame - start_frame
            else:
                duration_frames = max(1, int(round(duration_seconds * max(1.0, float(kwargs.get("frame_rate", 16) or 16)))))
        duration_frames = max(1, duration_frames)
        if end_frame <= start_frame:
            end_frame = start_frame + duration_frames
        timeline_data = kwargs.get("timeline_data") or ""
        local_prompts = kwargs.get("local_prompts") or ""
        segment_lengths = kwargs.get("segment_lengths") or ""
        guide_strength = kwargs.get("guide_strength") or ""
        transition_smoothness = kwargs.get("transition_smoothness") or ""
        epsilon = float(kwargs.get("epsilon", 1e-3) or 0.0)
        frame_rate = float(kwargs.get("frame_rate", 16) or 0)
        if frame_rate < 1:
            frame_rate = 16.0
        display_mode = _normalize_display_mode(kwargs.get("display_mode"))
        # 宽度 / 高度：生成分辨率（不是对齐倍数）
        custom_width = int(kwargs.get("custom_width", 832) or 0)
        custom_height = int(kwargs.get("custom_height", 480) or 0)
        resize_method = _normalize_resize_method(kwargs.get("resize_method"))
        divisible_by = int(kwargs.get("divisible_by", 16) or 0)
        if divisible_by < 1:
            divisible_by = 16
        img_compression = int(kwargs.get("img_compression", 0) or 0)

        log.info(
            "[WanRemixDirector] 生成参数: 宽=%s 高=%s 总帧数=%s 帧率=%s 对齐倍数=%s 缩放=%s",
            custom_width, custom_height, duration_frames, frame_rate, divisible_by, resize_method,
        )

        # Parse timeline data
        try:
            tdata = json.loads(timeline_data) if timeline_data else {}
        except Exception as e:
            log.error(f"[WanRemixDirector] execute timeline_data parse error: {e}")
            tdata = {}

        is_retake_mode = tdata.get("retakeMode", False)
        is_retake_active = is_retake_mode and tdata.get("retakeVideo") is not None
        ic_video_dimensions = None

        # Extract global_prompt from timeline_data if not connected/empty
        if not global_prompt:
            if is_retake_mode:
                global_prompt = tdata.get("retake_global_prompt", "")
            else:
                global_prompt = tdata.get("global_prompt", "")

        log.info(f"[WanRemixDirector] execute RECEIVED global_prompt: {repr(global_prompt)}")

        # --- Build guide_data for sequential / guide nodes ---
        # modes: i2v (image/video), t2v (text-only segment)
        # transitions: flf=⇄首尾帧  cut=✕单独图生视频
        guide_data = {
            "images": [],
            "insert_frames": [],
            "strengths": [],
            "segment_prompts": [],
            "segment_lengths": [],
            "segment_transitions": [],
            "segment_modes": [],  # "i2v" | "t2v"
            "frame_rate": frame_rate,
        }
        derived_w, derived_h = custom_width, custom_height

        def _snap(val, div):
            return max(div, (int(val) // div) * div)

        def _resize_seg_tensor(tensor):
            src_h, src_w = tensor.shape[1], tensor.shape[2]
            if custom_width > 0 and custom_height > 0:
                return _resize_image(tensor, custom_width, custom_height, resize_method, divisible_by)
            if custom_width > 0:
                tgt_w = _snap(custom_width, divisible_by)
                tgt_h = _snap(int(src_h * tgt_w / max(1, src_w)), divisible_by)
                return _resize_image(tensor, tgt_w, tgt_h, "stretch to fit", divisible_by)
            if custom_height > 0:
                tgt_h = _snap(custom_height, divisible_by)
                tgt_w = _snap(int(src_w * tgt_h / max(1, src_h)), divisible_by)
                return _resize_image(tensor, tgt_w, tgt_h, "stretch to fit", divisible_by)
            return _resize_image(tensor, src_w, src_h, "maintain aspect ratio", divisible_by)

        try:
            range_end = start_frame + duration_frames
            all_segs = [
                s for s in (tdata.get("segments") or [])
                if s
                and s.get("type") != "ghost"
                and int(s.get("start", 0)) < range_end
                and int(s.get("start", 0)) + int(s.get("length", 1)) > start_frame
            ]
            all_segs.sort(key=lambda s: int(s.get("start", 0)))

            strengths = []
            if guide_strength.strip():
                strengths = [float(x.strip()) for x in guide_strength.split(",") if x.strip()]
            locals_list = [p.strip() for p in (local_prompts or "").split("|")] if local_prompts else []

            media_idx = 0  # index among image/video segments for strength list
            for idx, seg in enumerate(all_segs):
                seg_type = (seg.get("type") or "image").lower()
                seg_start = int(seg.get("start", 0))
                offset = max(0, start_frame - seg_start)
                raw_len = max(1, int(seg.get("length", 1)))
                clipped_len = max(1, raw_len - offset)

                seg_prompt = (seg.get("prompt") or "").strip()
                if not seg_prompt and idx < len(locals_list):
                    seg_prompt = locals_list[idx]

                link = (seg.get("transitionToNext") or seg.get("linkToNext") or "flf")
                if link not in ("flf", "cut"):
                    link = "flf"

                has_media = bool(seg.get("imageFile") or seg.get("imageB64") or seg.get("videoFile"))
                is_text = seg_type == "text" or (not has_media and seg_type not in ("image", "video"))

                if is_text or not has_media:
                    # 文生视频段：无图片，仅用分段/全局提示词
                    # 衔接模式与图片段一致（默认 ⇄），便于 图→文→图 时文字段也能首尾帧接到下一张图
                    guide_data["images"].append(None)
                    guide_data["insert_frames"].append(max(0, seg_start - start_frame))
                    guide_data["strengths"].append(0.0)
                    guide_data["segment_prompts"].append(seg_prompt)
                    guide_data["segment_lengths"].append(int(clipped_len))
                    guide_data["segment_transitions"].append(link)
                    guide_data["segment_modes"].append("t2v")
                    continue

                # 图/视频段
                work = dict(seg)
                if seg_type == "video":
                    if offset > 0:
                        work["trimStart"] = float(work.get("trimStart", 0)) + offset
                        work["length"] = max(1, int(work.get("length", 1)) - offset)
                    tensor = _load_video_tensor(work, float(frame_rate), required=True)
                else:
                    tensor = _load_image_tensor(work, required=True)

                tensor = _resize_seg_tensor(tensor)
                if img_compression > 0:
                    tensor = _compress_image(tensor, img_compression)

                if derived_w <= 0 or derived_h <= 0 or media_idx == 0:
                    derived_h = int(tensor.shape[1])
                    derived_w = int(tensor.shape[2])

                if work.get("isEndFrame"):
                    insert_frame = max(0, seg_start + int(work.get("length", 1)) - 1 - start_frame)
                else:
                    insert_frame = max(0, seg_start - start_frame)

                strength = (
                    strengths[media_idx]
                    if media_idx < len(strengths)
                    else float(work.get("guideStrength", 1.0) or 1.0)
                )
                guide_data["images"].append(tensor)
                guide_data["insert_frames"].append(insert_frame)
                guide_data["strengths"].append(float(strength))
                guide_data["segment_prompts"].append(seg_prompt)
                guide_data["segment_lengths"].append(int(clipped_len))
                guide_data["segment_transitions"].append(link)
                guide_data["segment_modes"].append("i2v")
                media_idx += 1

            # 时间线完全为空 → 纯文生视频一整段（用全局提示词 + 总帧数）
            if not guide_data["segment_modes"] and optional_latent is None:
                src_w, src_h = _resolve_output_base_dimensions(
                    custom_width,
                    custom_height,
                    False,
                    is_retake_mode,
                    None,
                )
                if custom_width > 0:
                    src_w = custom_width
                if custom_height > 0:
                    src_h = custom_height
                derived_w = max(16, _snap(src_w if src_w > 0 else 832, divisible_by))
                derived_h = max(16, _snap(src_h if src_h > 0 else 480, divisible_by))
                guide_data["images"].append(None)
                guide_data["insert_frames"].append(0)
                guide_data["strengths"].append(0.0)
                guide_data["segment_prompts"].append("")
                guide_data["segment_lengths"].append(int(duration_frames))
                guide_data["segment_transitions"].append("cut")
                guide_data["segment_modes"].append("t2v")
                log.info(
                    "[WanRemixDirector] 无时间线段 → 纯文生视频 T2V (%dx%d, %d帧)",
                    derived_w, derived_h, duration_frames,
                )

        except Exception as e:
            log.error("[WanRemixDirector] guide_data 构建失败: %s", e)
            raise

        # --- Auto-generate Wan latent (4n+1 frames, 16ch, spatial /8) ---
        if derived_w is None or derived_w <= 0:
            derived_w = custom_width if custom_width > 0 else 832
        if derived_h is None or derived_h <= 0:
            derived_h = custom_height if custom_height > 0 else 480

        wan_length = _wan_pixel_frames(duration_frames)

        if optional_latent is None:
            div = max(1, int(divisible_by) if divisible_by else 16)
            # Prefer 16-aligned dims for Wan; fall back gracefully if div is smaller.
            align = max(16, div) if div <= 16 else div
            latent_w = max(align, (int(derived_w) // align) * align)
            latent_h = max(align, (int(derived_h) // align) * align)
            latent_t = _wan_latent_frames(wan_length)
            samples = torch.zeros(
                [1, 16, latent_t, latent_h // 8, latent_w // 8],
                device=comfy.model_management.intermediate_device(),
            )
            latent = {"samples": samples}
            log.info(
                "[WanRemixDirector] Auto-generated Wan latent: %dx%d, %d pixel frames (%d latent frames)",
                latent_w, latent_h, wan_length, latent_t,
            )
        else:
            latent = optional_latent
            samples = latent["samples"]
            latent_w = int(samples.shape[-1] * 8)
            latent_h = int(samples.shape[-2] * 8)
            wan_length = int((samples.shape[2] - 1) * 4 + 1)

        positive_text = _build_timeline_prompt(
            global_prompt, local_prompts, segment_lengths, float(frame_rate)
        )
        if not negative_prompt:
            negative_prompt = tdata.get("negative_prompt", "") if isinstance(tdata, dict) else ""

        positive, negative = _encode_wan_prompts(clip, positive_text, negative_prompt)
        log.info("[WanRemixDirector] Positive prompt: %s", positive_text[:240])

        # 音频轨 / 参考视频轨已从产品中移除（Wan Remix 出片不使用）

        guide_data["timeline_data"] = timeline_data
        guide_data["start_frame"] = start_frame
        guide_data["duration_frames"] = wan_length
        guide_data["resize_method"] = resize_method
        guide_data["width"] = latent_w
        guide_data["height"] = latent_h
        guide_data["length"] = wan_length
        guide_data["global_prompt"] = global_prompt or ""
        guide_data["negative_prompt"] = negative_prompt or ""
        try:
            ov = int(kwargs.get("overlap_frames", 1) or 1)
        except Exception:
            ov = 1
        guide_data["overlap_frames"] = max(1, min(64, ov))

        return io.NodeOutput(
            model_high_noise,
            model_low_noise,
            positive,
            negative,
            latent,
            guide_data,
            float(frame_rate),
            int(wan_length),
            int(latent_w),
            int(latent_h),
        )


NODE_CLASS_MAPPINGS = {
    "WanRemixDirector": WanRemixDirector,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WanRemixDirector": "Lazy Wan2.2 Remix 导演台",
}
