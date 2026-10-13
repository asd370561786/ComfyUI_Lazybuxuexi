import logging
import math
import os

import av
import numpy as np
import torch
import comfy
import comfy.utils
import folder_paths
import node_helpers
from comfy_api.latest import io

from .wan_director import GuideData, MotionGuideData, _resize_image

log = logging.getLogger(__name__)


def _clone_noise_mask(latent, latent_image):
    if "noise_mask" in latent and latent["noise_mask"] is not None:
        return latent["noise_mask"].clone()
    batch, _, frames, _, _ = latent_image.shape
    return torch.ones(
        (batch, 1, frames, 1, 1),
        dtype=torch.float32,
        device=latent_image.device,
    )


def _resolve_input_video_path(video_file):
    if os.path.isabs(str(video_file)) and os.path.exists(str(video_file)):
        return str(video_file)
    input_dir = folder_paths.get_input_directory()
    candidate = os.path.join(input_dir, str(video_file))
    if os.path.exists(candidate):
        return candidate
    try:
        annotated = folder_paths.get_annotated_filepath(str(video_file))
        if annotated and os.path.exists(annotated):
            return annotated
    except Exception:
        pass
    raise FileNotFoundError(f"Could not find motion guide video: {video_file}")


def _load_motion_video_frames(video_file, trim_start_frames, length_frames, director_fps):
    path = _resolve_input_video_path(video_file)
    target_fps = max(1.0, float(director_fps))
    start_s = max(0.0, float(trim_start_frames) / target_fps)
    dur_s = max(0.0, float(length_frames) / target_fps)
    end_s = start_s + dur_s if dur_s > 0 else None

    container = av.open(path)
    stream = container.streams.video[0]
    stream.thread_type = "AUTO"
    try:
        source_fps = float(stream.average_rate) if stream.average_rate else float(stream.base_rate)
    except Exception:
        source_fps = target_fps
    if source_fps <= 0:
        source_fps = target_fps

    if start_s > 0:
        try:
            if stream.time_base:
                seek_pts = int(max(0, start_s - 0.5) / float(stream.time_base))
            else:
                seek_pts = int(max(0, start_s - 0.5) * av.time_base)
            container.seek(seek_pts, stream=stream, backward=True)
        except Exception:
            pass

    frames = []
    decoded_count = 0
    for frame in container.decode(stream):
        if frame.time is not None:
            t = float(frame.time)
        elif frame.pts is not None and stream.time_base is not None:
            t = float(frame.pts * stream.time_base)
        else:
            t = float(decoded_count / source_fps)
        decoded_count += 1
        if t < start_s - 0.01:
            continue
        if end_s is not None and t >= end_s:
            break
        frames.append(frame.to_ndarray(format="rgb24"))
    container.close()

    if not frames:
        raise ValueError(f"No frames decoded for motion guide segment: {video_file}")

    frames_np = np.array(frames, dtype=np.float32) / 255.0
    images = torch.from_numpy(frames_np)
    target_count = max(1, int(round(float(length_frames))))
    if images.shape[0] != target_count:
        idx = torch.linspace(0, images.shape[0] - 1, target_count).round().long().clamp(0, images.shape[0] - 1)
        images = images.index_select(0, idx)
    return images


def _pixel_to_latent_index(pixel_frame: int, length: int) -> int:
    """Map a pixel-space frame index into Wan latent temporal index (stride 4)."""
    pixel_frame = max(0, min(int(pixel_frame), max(0, length - 1)))
    return pixel_frame // 4


class WanRemixDirectorGuide:
    """Apply director timeline keyframes as Wan I2V concat conditioning.

    Supports multi-keyframe placement (first / middle / last frames locked via concat_mask),
    following the same idea as native WanImageToVideo / WanFirstLastFrameToVideo.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "positive": ("CONDITIONING", {"tooltip": "正向条件（来自导演台）"}),
                "negative": ("CONDITIONING", {"tooltip": "负向条件（来自导演台）"}),
                "vae": ("VAE", {"tooltip": "Wan VAE"}),
                "latent": ("LATENT", {"tooltip": "视频潜空间（来自导演台）"}),
                "guide_data": ("GUIDE_DATA", {"tooltip": "关键帧数据（来自导演台）"}),
            },
            "optional": {
                "clip_vision_output": ("CLIP_VISION_OUTPUT", {"tooltip": "CLIP Vision（可选）"}),
                "宽度": ("INT", {
                    "default": 0, "min": 0, "max": 8192, "step": 16,
                    "tooltip": "生成宽度。0=自动使用导演台/潜空间尺寸",
                }),
                "高度": ("INT", {
                    "default": 0, "min": 0, "max": 8192, "step": 16,
                    "tooltip": "生成高度。0=自动使用导演台/潜空间尺寸",
                }),
                "帧数": ("INT", {
                    "default": 0, "min": 0, "max": 10000, "step": 1,
                    "tooltip": "生成帧数。0=自动（4n+1）",
                }),
                "强度阈值": ("FLOAT", {
                    "default": 0.01, "min": 0.0, "max": 1.0, "step": 0.01,
                    "tooltip": "低于此强度的关键帧将被忽略",
                }),
                "锁定半径": ("INT", {
                    "default": 0, "min": 0, "max": 8, "step": 1,
                    "tooltip": "关键帧锁定半径（额外锁定的像素帧）",
                }),
            },
        }

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT", "INT", "INT", "INT")
    RETURN_NAMES = ("正向条件", "负向条件", "潜空间", "宽度", "高度", "帧数")
    FUNCTION = "execute"
    CATEGORY = "WanRemix/Director"

    def execute(
        self,
        positive,
        negative,
        vae,
        latent,
        guide_data,
        clip_vision_output=None,
        **kwargs,
    ):
        # 兼容中文控件名 + 旧英文名
        width = kwargs.get("宽度", kwargs.get("width", 0)) or 0
        height = kwargs.get("高度", kwargs.get("height", 0)) or 0
        length = kwargs.get("帧数", kwargs.get("length", 0)) or 0
        strength_threshold = kwargs.get("强度阈值", kwargs.get("strength_threshold", 0.01))
        lock_radius = kwargs.get("锁定半径", kwargs.get("lock_radius", 0)) or 0

        latent_image = latent["samples"].clone()
        batch, channels, latent_t, latent_h, latent_w = latent_image.shape

        # Infer spatial / temporal sizes
        try:
            spatial_scale = int(vae.spacial_compression_encode())
        except Exception:
            spatial_scale = 8

        out_w = int(width) if width and int(width) > 0 else int(guide_data.get("width", 0) or latent_w * spatial_scale)
        out_h = int(height) if height and int(height) > 0 else int(guide_data.get("height", 0) or latent_h * spatial_scale)
        out_len = int(length) if length and int(length) > 0 else int(guide_data.get("length", 0) or ((latent_t - 1) * 4 + 1))
        # Snap to Wan 4n+1
        out_len = max(5, ((out_len - 1) // 4) * 4 + 1)

        # Rebuild empty latent if shape mismatch
        expected_t = ((out_len - 1) // 4) + 1
        expected_h = out_h // spatial_scale
        expected_w = out_w // spatial_scale
        if latent_image.shape[2:] != (expected_t, expected_h, expected_w) or latent_image.shape[1] != getattr(vae, "latent_channels", channels):
            ch = getattr(vae, "latent_channels", channels) or 16
            latent_image = torch.zeros(
                [batch, ch, expected_t, expected_h, expected_w],
                device=comfy.model_management.intermediate_device(),
                dtype=latent_image.dtype,
            )
            log.info(
                "[WanRemixDirectorGuide] Reshaped latent to B=%d C=%d T=%d H=%d W=%d",
                batch, ch, expected_t, expected_h, expected_w,
            )

        images = list(guide_data.get("images", []) or [])
        insert_frames = list(guide_data.get("insert_frames", []) or [])
        strengths = list(guide_data.get("strengths", []) or [])
        resize_method = guide_data.get("resize_method", "crop") or "crop"
        # 兼容导演台中文缩放选项
        _rm = {
            "保持宽高比": "maintain aspect ratio",
            "拉伸填充": "stretch to fit",
            "填充黑边": "pad",
            "填充绿边": "pad green",
            "裁剪": "crop",
        }
        resize_method = _rm.get(resize_method, resize_method)

        # 运动参考 / IC-LoRA 已从产品移除，不再合并 motion 段

        # Build pixel canvas for concat encode (Wan I2V style)
        image = torch.ones((out_len, out_h, out_w, 3), dtype=torch.float32) * 0.5
        # Mask in pixel-time domain later folded to latent (1 = free/noise, 0 = locked)
        mask = torch.ones((1, 1, expected_t * 4, expected_h, expected_w), dtype=torch.float32)
        has_lock = False

        for idx, img_tensor in enumerate(images):
            if img_tensor is None:
                continue
            strength = strengths[idx] if idx < len(strengths) else 1.0
            if float(strength) < float(strength_threshold):
                continue
            if not isinstance(img_tensor, torch.Tensor):
                continue

            f_idx = int(insert_frames[idx]) if idx < len(insert_frames) else 0
            f_idx = max(0, min(f_idx, out_len - 1))

            pixels = img_tensor
            if pixels.ndim != 4:
                continue
            resized = _resize_image(
                pixels, out_w, out_h, resize_method, divisible_by=max(1, spatial_scale)
            )
            n = min(resized.shape[0], out_len - f_idx)
            if n <= 0:
                continue
            image[f_idx:f_idx + n] = resized[:n, :, :, :3]

            # strength=1 → 完全锁定(mask=0)；strength=0.5 → mask=0.5 半锁
            lock_val = max(0.0, min(1.0, 1.0 - float(strength)))
            lock_start = max(0, f_idx - int(lock_radius))
            lock_end = min(out_len, f_idx + n + int(lock_radius))
            if f_idx == 0:
                lock_end = max(lock_end, min(out_len, n + 3))
            # 多关键帧取更强锁定（更小 mask）
            region = mask[:, :, lock_start:lock_end]
            mask[:, :, lock_start:lock_end] = torch.minimum(
                region, torch.full_like(region, lock_val)
            )
            has_lock = True
            log.info(
                "[WanRemixDirectorGuide] Locked keyframe idx=%d frame=%d n=%d strength=%.2f mask=%.2f",
                idx, f_idx, n, strength, lock_val,
            )

        if has_lock:
            concat_latent_image = vae.encode(image[:, :, :, :3])
            # Fold pixel-time mask -> latent-time mask [1, 4, T, H, W] then used as concat_mask
            mask = mask.view(1, mask.shape[2] // 4, 4, mask.shape[3], mask.shape[4]).transpose(1, 2)
            positive = node_helpers.conditioning_set_values(
                positive, {"concat_latent_image": concat_latent_image, "concat_mask": mask}
            )
            negative = node_helpers.conditioning_set_values(
                negative, {"concat_latent_image": concat_latent_image, "concat_mask": mask}
            )
        else:
            log.info("[WanRemixDirectorGuide] No locked keyframes; returning text-only conditioning.")

        if clip_vision_output is not None:
            positive = node_helpers.conditioning_set_values(positive, {"clip_vision_output": clip_vision_output})
            negative = node_helpers.conditioning_set_values(negative, {"clip_vision_output": clip_vision_output})

        out_latent = {"samples": latent_image}
        return (positive, negative, out_latent, int(out_w), int(out_h), int(out_len))


class WanRemixDirectorCropGuides:
    """Utility: crop/resize a batch of guide images to a target size (kept for UI parity)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "width": ("INT", {"default": 832, "min": 16, "max": 8192, "step": 16}),
                "height": ("INT", {"default": 480, "min": 16, "max": 8192, "step": 16}),
                "resize_method": (
                    ["maintain aspect ratio", "stretch to fit", "pad", "pad green", "crop"],
                    {"default": "crop"},
                ),
                "divisible_by": ("INT", {"default": 16, "min": 1, "max": 256, "step": 1}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "execute"
    CATEGORY = "WanRemix/Director"

    def execute(self, images, width, height, resize_method="crop", divisible_by=16):
        out = _resize_image(images, width, height, resize_method, divisible_by=divisible_by)
        return (out,)


NODE_CLASS_MAPPINGS = {
    "WanRemixDirectorGuide": WanRemixDirectorGuide,
    "WanRemixDirectorCropGuides": WanRemixDirectorCropGuides,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WanRemixDirectorGuide": "Lazy Wan2.2 Remix 关键帧引导",
    "WanRemixDirectorCropGuides": "Lazy Wan2.2 Remix 关键帧裁剪",
}
