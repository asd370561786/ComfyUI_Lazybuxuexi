import os
import asyncio
import logging
import torch
import numpy as np
import folder_paths
import av
from server import PromptServer
from aiohttp import web
import comfy.utils

log = logging.getLogger(__name__)

_registered = set()
_pending = []


def _try_register(method, path, handler):
    key = (method, path)
    if key in _registered:
        return True
    try:
        server = getattr(PromptServer, "instance", None)
        if server is not None and hasattr(server, "routes"):
            getattr(server.routes, method)(path)(handler)
            _registered.add(key)
            log.info("[LoadVideoUI] Registered route %s %s", method.upper(), path)
            return True
    except Exception as e:
        log.warning("[LoadVideoUI] Route register failed %s %s: %s", method, path, e)
    return False


def ensure_video_ui_routes():
    """Retry deferred route registration (safe if PromptServer was not ready at import)."""
    still = []
    for method, path, handler in _pending:
        if not _try_register(method, path, handler):
            still.append((method, path, handler))
    _pending[:] = still


def _safe_route(method, path):
    def deco(fn):
        if not _try_register(method, path, fn):
            _pending.append((method, path, fn))
        return fn
    return deco


def _is_under_dir(path, root):
    try:
        real = os.path.realpath(path)
        root_real = os.path.realpath(root)
        return real == root_real or real.startswith(root_real + os.sep)
    except Exception:
        return False


def _resolve_safe_input_path(filename: str):
    """Only allow files under ComfyUI input directory (no arbitrary absolute paths)."""
    if not filename:
        return None
    input_dir = folder_paths.get_input_directory()
    clean = str(filename).replace("\\", "/").lstrip("/")
    # Reject path traversal tokens
    parts = [p for p in clean.split("/") if p and p != "."]
    if any(p == ".." for p in parts):
        return None
    candidate = os.path.normpath(os.path.join(input_dir, *parts))
    if _is_under_dir(candidate, input_dir) and os.path.isfile(candidate):
        return candidate
    # basename fallback under input / whatdreamscost
    base = os.path.basename(clean)
    for sub in ("", "whatdreamscost"):
        p = os.path.join(input_dir, sub, base) if sub else os.path.join(input_dir, base)
        if os.path.isfile(p) and _is_under_dir(p, input_dir):
            return p
    return None


def _read_and_write_file_chunk(file, file_path, mode):
    chunk_bytes = file.file.read()
    with open(file_path, mode) as f:
        f.write(chunk_bytes)


# Serve previews only from the ComfyUI input folder (prevents arbitrary file read).
@_safe_route("get", "/video_ui_custom_view")
async def custom_view(request):
    ensure_video_ui_routes()
    file_path = request.query.get("filename", "")
    safe = _resolve_safe_input_path(file_path)
    if safe:
        return web.FileResponse(safe)
    return web.Response(status=404, text="File not found")


@_safe_route("post", "/video_ui_upload_chunk")
async def upload_chunk(request):
    ensure_video_ui_routes()
    post = await request.post()
    file = post.get("file")
    filename = post.get("filename")
    chunk_index = int(post.get("chunk_index", 0))
    total_chunks = int(post.get("total_chunks", 1))

    if not file or not filename:
        return web.json_response({"error": "Missing file or filename"}, status=400)

    # Sanitize: basename only, no path traversal
    filename = os.path.basename(str(filename))
    if not filename or filename in (".", ".."):
        return web.json_response({"error": "Invalid filename"}, status=400)

    upload_dir = os.path.join(folder_paths.get_input_directory(), "whatdreamscost")
    os.makedirs(upload_dir, exist_ok=True)
    file_path = os.path.join(upload_dir, filename)

    if not _is_under_dir(file_path, upload_dir):
        return web.json_response({"error": "Invalid filename"}, status=400)

    mode = "ab" if chunk_index > 0 else "wb"
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _read_and_write_file_chunk, file, file_path, mode)

    if chunk_index == total_chunks - 1:
        return web.json_response({"name": f"whatdreamscost/{filename}"})
    return web.json_response({"status": "ok"})


class LoadVideoUI:
    @classmethod
    def INPUT_TYPES(s):
        ensure_video_ui_routes()
        return {
            "required": {
                "video": ("STRING", {"default": ""}),
                "start_time": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100000.0, "step": 0.01}),
                "end_time": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100000.0, "step": 0.01}),
                "duration": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100000.0, "step": 0.01}),
                "start_frame": ("INT", {"default": 0, "min": 0, "max": 10000000, "step": 1}),
                "end_frame": ("INT", {"default": 0, "min": 0, "max": 10000000, "step": 1}),
                "duration_frames": ("INT", {"default": 0, "min": 0, "max": 10000000, "step": 1}),
                "resize_method": (["maintain aspect ratio", "stretch to fit", "pad", "crop"], {"default": "maintain aspect ratio"}),
                "custom_width": ("INT", {"default": 0, "min": 0, "max": 100000, "step": 8, "tooltip": "Custom width. 0 means original width."}),
                "custom_height": ("INT", {"default": 0, "min": 0, "max": 100000, "step": 8, "tooltip": "Custom height. 0 means original height."}),
                "frame_rate": ("INT", {"default": 24, "min": 1, "max": 120, "step": 1, "tooltip": "Force the video to a specific frame rate for extraction."}),
                "display_mode": (["seconds", "frames"], {"default": "seconds"}),
                "crop_x": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.001}),
                "crop_y": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.001}),
                "crop_w": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.001}),
                "crop_h": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.001}),
            }
        }

    RETURN_TYPES = ("IMAGE", "AUDIO", "FLOAT", "INT")
    RETURN_NAMES = ("images", "audio", "duration", "frame_count")
    FUNCTION = "load_video"
    CATEGORY = "WanRemix/Director"

    def load_video(
        self,
        video,
        frame_rate,
        display_mode,
        start_time,
        end_time,
        duration,
        start_frame,
        end_frame,
        duration_frames,
        custom_width=0,
        custom_height=0,
        resize_method="maintain aspect ratio",
        crop_x=0.0,
        crop_y=0.0,
        crop_w=1.0,
        crop_h=1.0,
        **kwargs,
    ):
        ensure_video_ui_routes()
        if not video:
            empty_image = torch.zeros((1, 512, 512, 3), dtype=torch.float32)
            empty_audio = {"waveform": torch.zeros((1, 1, 44100)), "sample_rate": 44100}
            return (empty_image, empty_audio, 0.0, 0)

        # Resolve path: absolute only if already under input dir; else annotated / input relative
        video_path = None
        if os.path.isabs(str(video)):
            input_dir = folder_paths.get_input_directory()
            if _is_under_dir(video, input_dir) and os.path.isfile(video):
                video_path = video
        if video_path is None:
            video_path = _resolve_safe_input_path(video)
        if video_path is None:
            try:
                annotated = folder_paths.get_annotated_filepath(video)
                if annotated and os.path.isfile(annotated):
                    input_dir = folder_paths.get_input_directory()
                    if _is_under_dir(annotated, input_dir) or _is_under_dir(annotated, folder_paths.get_output_directory()):
                        video_path = annotated
            except Exception:
                pass
        if not video_path:
            raise FileNotFoundError(f"Video file not found or outside allowed directories: {video}")

        container = av.open(video_path)

        video_stream = container.streams.video[0] if len(container.streams.video) > 0 else None
        video_duration = 0
        if video_stream and video_stream.duration and video_stream.time_base:
            video_duration = float(video_stream.duration * video_stream.time_base)

        orig_w = video_stream.codec_context.width if video_stream else 512
        orig_h = video_stream.codec_context.height if video_stream else 512

        try:
            from av.video.reformatter import Colorspace, ColorRange
            fallback_cs = Colorspace.ITU709 if max(orig_w, orig_h) >= 720 else Colorspace.ITU601
            fallback_cr = ColorRange.MPEG
            dst_range = ColorRange.JPEG
        except ImportError:
            fallback_cs = "itu709" if max(orig_w, orig_h) >= 720 else "itu601"
            fallback_cr = "mpeg"
            dst_range = "jpeg"

        src_colorspace = fallback_cs
        src_color_range = fallback_cr

        if video_stream and video_stream.codec_context:
            cc = video_stream.codec_context
            c_space = getattr(cc, "colorspace", getattr(cc, "color_space", None))
            if c_space and hasattr(c_space, "name") and c_space.name != "UNSPECIFIED":
                src_colorspace = c_space
            elif c_space and isinstance(c_space, str) and "unspecified" not in c_space.lower():
                src_colorspace = c_space
            c_range = getattr(cc, "color_range", None)
            if c_range and hasattr(c_range, "name") and c_range.name != "UNSPECIFIED":
                src_color_range = c_range
            elif c_range and isinstance(c_range, str) and "unspecified" not in c_range.lower():
                src_color_range = c_range

        target_w = custom_width if custom_width > 0 else orig_w
        target_h = custom_height if custom_height > 0 else orig_h
        target_w = target_w - (target_w % 2)
        target_h = target_h - (target_h % 2)

        manual_crop_left = int(orig_w * crop_x)
        manual_crop_top = int(orig_h * crop_y)
        manual_crop_right = orig_w - int(orig_w * (crop_x + crop_w))
        manual_crop_bottom = orig_h - int(orig_h * (crop_y + crop_h))
        manual_crop_left = max(0, min(manual_crop_left, orig_w - 1))
        manual_crop_top = max(0, min(manual_crop_top, orig_h - 1))
        manual_crop_right = max(0, min(manual_crop_right, orig_w - manual_crop_left - 1))
        manual_crop_bottom = max(0, min(manual_crop_bottom, orig_h - manual_crop_top - 1))

        cropped_orig_w = orig_w - manual_crop_left - manual_crop_right
        cropped_orig_h = orig_h - manual_crop_top - manual_crop_bottom

        if custom_width == 0:
            target_w = cropped_orig_w - (cropped_orig_w % 2)
        if custom_height == 0:
            target_h = cropped_orig_h - (cropped_orig_h % 2)

        scale_w, scale_h = target_w, target_h
        pad_left = pad_right = pad_top = pad_bottom = 0
        crop_left = crop_right = crop_top = crop_bottom = 0

        if custom_width > 0 or custom_height > 0:
            if resize_method in ("maintain aspect ratio", "pad"):
                ratio = min(target_w / max(1, cropped_orig_w), target_h / max(1, cropped_orig_h))
                scale_w = int(cropped_orig_w * ratio)
                scale_h = int(cropped_orig_h * ratio)
                scale_w = scale_w - (scale_w % 2)
                scale_h = scale_h - (scale_h % 2)
                if resize_method == "pad":
                    pad_x = target_w - scale_w
                    pad_y = target_h - scale_h
                    pad_left = pad_x // 2
                    pad_right = pad_x - pad_left
                    pad_top = pad_y // 2
                    pad_bottom = pad_y - pad_top
                else:
                    target_w, target_h = scale_w, scale_h
            elif resize_method == "crop":
                ratio = max(target_w / max(1, cropped_orig_w), target_h / max(1, cropped_orig_h))
                scale_w = int(cropped_orig_w * ratio)
                scale_h = int(cropped_orig_h * ratio)
                scale_w = scale_w - (scale_w % 2)
                scale_h = scale_h - (scale_h % 2)
                crop_x_px = scale_w - target_w
                crop_y_px = scale_h - target_h
                crop_left = crop_x_px // 2
                crop_right = crop_x_px - crop_left
                crop_top = crop_y_px // 2
                crop_bottom = crop_y_px - crop_top
            elif resize_method == "stretch to fit":
                scale_w, scale_h = target_w, target_h

        fr = float(frame_rate) if frame_rate > 0 else 24.0
        # Resolve time window: prefer duration if end not set
        if display_mode == "frames":
            actual_start_time = float(start_frame) / fr
            if end_frame > start_frame:
                actual_end_time = float(end_frame) / fr
            elif duration_frames > 0:
                actual_end_time = actual_start_time + float(duration_frames) / fr
            else:
                actual_end_time = video_duration
        else:
            actual_start_time = float(start_time or 0.0)
            if end_time > start_time:
                actual_end_time = float(end_time)
            elif duration > 0:
                actual_end_time = actual_start_time + float(duration)
            else:
                actual_end_time = video_duration

        if actual_end_time <= 0:
            actual_end_time = float("inf")

        frames = []
        image_tensor = None
        frames_loaded = 0

        if video_stream:
            video_stream.thread_type = "AUTO"
            if video_stream.time_base:
                seek_pts = int(actual_start_time / float(video_stream.time_base))
            else:
                seek_pts = int(actual_start_time * av.time_base)
            container.seek(seek_pts, stream=video_stream, backward=True)

            frame_interval = 1.0 / fr
            expected_target_time = actual_start_time
            alloc_end_time = actual_end_time if actual_end_time != float("inf") else video_duration
            expected_frames = 0
            if alloc_end_time > 0:
                duration_to_extract = alloc_end_time - actual_start_time
                if duration_to_extract > 0:
                    expected_frames = int(np.ceil(duration_to_extract / frame_interval)) + 2

            pbar = comfy.utils.ProgressBar(expected_frames) if expected_frames > 0 else None

            for frame in container.decode(video_stream):
                frame_time = frame.time
                if frame_time is None:
                    frame_time = (
                        float(frame.pts * float(video_stream.time_base))
                        if frame.pts and video_stream.time_base
                        else 0.0
                    )
                if frame_time < actual_start_time:
                    continue
                if frame_time > actual_end_time + frame_interval:
                    break

                try:
                    frame = frame.reformat(
                        format="rgb24",
                        src_colorspace=src_colorspace,
                        src_color_range=src_color_range,
                        dst_color_range=dst_range,
                    )
                    frame_rgb = frame.to_ndarray(format="rgb24")
                except Exception as e:
                    print(f"[LoadVideoUI] Color reformat failed, using default: {e}")
                    frame_rgb = frame.to_ndarray(format="rgb24")

                if manual_crop_left > 0 or manual_crop_top > 0 or manual_crop_right > 0 or manual_crop_bottom > 0:
                    frame_rgb = frame_rgb[
                        manual_crop_top : orig_h - manual_crop_bottom,
                        manual_crop_left : orig_w - manual_crop_right,
                        :,
                    ]

                if scale_w != cropped_orig_w or scale_h != cropped_orig_h:
                    import cv2
                    frame_rgb = cv2.resize(frame_rgb, (scale_w, scale_h), interpolation=cv2.INTER_AREA)

                if crop_left > 0 or crop_top > 0 or crop_right > 0 or crop_bottom > 0:
                    frame_rgb = frame_rgb[crop_top : scale_h - crop_bottom, crop_left : scale_w - crop_right, :]
                if pad_left > 0 or pad_top > 0 or pad_right > 0 or pad_bottom > 0:
                    frame_rgb = np.pad(
                        frame_rgb,
                        ((pad_top, pad_bottom), (pad_left, pad_right), (0, 0)),
                        mode="constant",
                        constant_values=0,
                    )

                while expected_target_time <= frame_time and expected_target_time < actual_end_time - 1e-5:
                    if image_tensor is None and expected_frames > 0:
                        height, width = frame_rgb.shape[:2]
                        alloc_frames = expected_frames + 50
                        try:
                            image_tensor = torch.zeros((alloc_frames, height, width, 3), dtype=torch.float32)
                        except Exception as e:
                            print(f"[LoadVideoUI] Pre-allocation failed, falling back to list: {e}")
                            expected_frames = 0

                    if image_tensor is not None:
                        if frames_loaded >= image_tensor.shape[0]:
                            extension = torch.zeros(
                                (50, image_tensor.shape[1], image_tensor.shape[2], 3),
                                dtype=torch.float32,
                            )
                            image_tensor = torch.cat((image_tensor, extension), dim=0)
                        image_tensor[frames_loaded] = torch.from_numpy(frame_rgb).float().div_(255.0)
                        frames_loaded += 1
                    else:
                        frames.append(frame_rgb)

                    if pbar:
                        pbar.update(1)
                    expected_target_time += frame_interval

        if image_tensor is not None:
            image_tensor = image_tensor[:frames_loaded] if frames_loaded > 0 else torch.zeros((1, 512, 512, 3), dtype=torch.float32)
        elif len(frames) > 0:
            frames_np = np.array(frames, dtype=np.float32) / 255.0
            image_tensor = torch.from_numpy(frames_np)
        else:
            image_tensor = torch.zeros((1, 512, 512, 3), dtype=torch.float32)

        audio_dict = {"waveform": torch.zeros((1, 1, 44100)), "sample_rate": 44100}

        if len(container.streams.audio) > 0:
            try:
                audio_stream = container.streams.audio[0]
                audio_stream.thread_type = "AUTO"
                sample_rate = getattr(audio_stream, "rate", 44100) or 44100
                if audio_stream.time_base:
                    seek_pts = int(actual_start_time / float(audio_stream.time_base))
                else:
                    seek_pts = int(actual_start_time * av.time_base)
                container.seek(seek_pts, stream=audio_stream, backward=True)
                resampler = av.AudioResampler(format="fltp")
                audio_data = []
                first_frame_time = None
                for frame in container.decode(audio_stream):
                    frame_time = frame.time
                    if frame_time is None:
                        frame_time = (
                            float(frame.pts * float(audio_stream.time_base))
                            if frame.pts and audio_stream.time_base
                            else 0.0
                        )
                    if frame_time > actual_end_time + 1.0:
                        break
                    if first_frame_time is None:
                        first_frame_time = frame_time
                    for r_frame in resampler.resample(frame):
                        audio_data.append(r_frame.to_ndarray())
                if audio_data:
                    waveform_np = np.concatenate(audio_data, axis=1)
                    waveform = torch.from_numpy(waveform_np).float()
                    if first_frame_time is None:
                        first_frame_time = 0.0
                    offset_sec = max(0.0, actual_start_time - first_frame_time)
                    start_sample = int(offset_sec * sample_rate)
                    duration_sec_audio = actual_end_time - actual_start_time
                    end_sample = start_sample + int(duration_sec_audio * sample_rate)
                    if end_sample > start_sample:
                        waveform = waveform[:, start_sample:end_sample]
                    else:
                        waveform = waveform[:, start_sample:]
                    waveform = waveform.unsqueeze(0)
                    audio_dict = {"waveform": waveform, "sample_rate": sample_rate}
            except Exception as e:
                print(f"[LoadVideoUI] Audio track extraction skipped or failed: {e}")

        container.close()

        final_duration_sec = float(max(0.0, actual_end_time - actual_start_time)) if actual_end_time != float("inf") else 0.0
        frame_count = image_tensor.shape[0] if (frames_loaded > 0 or len(frames) > 0) else 0
        if frame_count == 0 and final_duration_sec > 0:
            frame_count = int(np.floor(final_duration_sec * fr))

        return (image_tensor, audio_dict, final_duration_sec, frame_count)
