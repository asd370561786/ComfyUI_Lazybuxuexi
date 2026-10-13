"""
导演台「逐段生成 → 再拼合」无限时长管线（省显存）：

1) WanRemixSequentialI2V：按时间线**每段单独** high/low MoE 采样
   - ⇄ flf  首尾帧：本段首帧=当前图，尾帧=下一张图
   - ✕ cut  硬切：本段仅图生视频（只有首帧）
   - 无图纯文字：文生视频 T2V
2) WanRemixMergeClips：全部段生成完后硬切拼成一条长视频

显存只占用「单段」长度，总时长可随段数增长。
"""

from __future__ import annotations

import gc
import logging

import torch
import node_helpers
import comfy.model_management
import comfy.utils
import comfy.samplers
import comfy.sample
import latent_preview

from .wan_moe_sampler import (
    set_shift,
    wan_ksampler_auto,
    DEFAULT_STEPS,
    DEFAULT_BOUNDARY,
    DEFAULT_CFG,
    DEFAULT_SAMPLER,
    DEFAULT_SCHEDULER,
    DEFAULT_SHIFT,
)
from .wan_director import _resize_image, _normalize_resize_method

log = logging.getLogger(__name__)


def _snap_4n1(n: int) -> int:
    """向下对齐到 4k+1（≥5）。"""
    n = max(1, int(n))
    return max(5, ((n - 1) // 4) * 4 + 1)


def _ceil_4n1(n: int) -> int:
    """向上对齐到 4k+1（≥5），用于「内容帧+重叠帧」总长，避免 snap 后裁完少帧。"""
    n = max(1, int(n))
    if n <= 5:
        return 5
    r = (n - 1) % 4
    if r == 0:
        return n
    return n + (4 - r)


def _encode_text(clip, text: str):
    return clip.encode_from_tokens_scheduled(clip.tokenize(text or ""))


def _empty_latent(vae, width, height, length):
    try:
        spatial = int(vae.spacial_compression_encode())
    except Exception:
        spatial = 8
    ch = getattr(vae, "latent_channels", 16) or 16
    latent_t = ((length - 1) // 4) + 1
    device = comfy.model_management.intermediate_device()
    latent = torch.zeros(
        [1, ch, latent_t, height // spatial, width // spatial],
        device=device,
    )
    return {"samples": latent}, spatial, ch, latent_t


def _build_i2v_cond(positive, negative, vae, width, height, length, start_image, end_image=None):
    """
    Wan 图生视频条件。

    - 仅首帧（硬切 / 单图）：对齐核心节点 WanImageToVideo
      mask 形状 [1, 1, T, H, W]，按 latent 时间维锁定
    - 有尾帧（首尾帧 ⇄）：对齐核心节点 WanFirstLastFrameToVideo
      mask 形状 [1, 4, T, H, W]（像素时间维再 fold）
    """
    latent_dict, spatial, ch, latent_t = _empty_latent(vae, width, height, length)

    start = None
    end = None
    if start_image is not None:
        start = start_image.unsqueeze(0) if start_image.ndim == 3 else start_image
        start = comfy.utils.common_upscale(
            start[:length].movedim(-1, 1), width, height, "bilinear", "center"
        ).movedim(1, -1)
    if end_image is not None:
        end = end_image.unsqueeze(0) if end_image.ndim == 3 else end_image
        end = comfy.utils.common_upscale(
            end[-length:].movedim(-1, 1), width, height, "bilinear", "center"
        ).movedim(1, -1)

    # —— 单图 I2V：官方 WanImageToVideo ——
    if start is not None and end is None:
        image = torch.ones(
            (length, height, width, start.shape[-1]),
            device=start.device,
            dtype=start.dtype,
        ) * 0.5
        image[: start.shape[0]] = start
        concat_latent = vae.encode(image[:, :, :, :3])
        # [1, 1, T, H, W] — 不是 [1, 4, T, ...]
        mask = torch.ones(
            (1, 1, latent_t, concat_latent.shape[-2], concat_latent.shape[-1]),
            device=start.device,
            dtype=start.dtype,
        )
        lock_t = ((start.shape[0] - 1) // 4) + 1
        mask[:, :, :lock_t] = 0.0
        log.info(
            "[I2V条件] 单图路径(WanImageToVideo) start_frames=%d lock_latent_t=%d mask=%s concat=%s",
            int(start.shape[0]), lock_t, tuple(mask.shape), tuple(concat_latent.shape),
        )

    # —— 首尾帧 / 仅尾帧：官方 WanFirstLastFrameToVideo ——
    else:
        image = torch.ones((length, height, width, 3), dtype=torch.float32) * 0.5
        # 像素时间维 mask，再 fold 成 [1, 4, T, H, W]
        mask = torch.ones(
            (1, 1, latent_t * 4, height // spatial, width // spatial),
            dtype=torch.float32,
        )
        if start is not None:
            image[: start.shape[0]] = start[:, :, :, :3]
            mask[:, :, : start.shape[0] + 3] = 0.0
        if end is not None:
            n = end.shape[0]
            image[-n:] = end[:, :, :, :3]
            mask[:, :, -n:] = 0.0
        concat_latent = vae.encode(image[:, :, :, :3])
        mask = mask.view(1, mask.shape[2] // 4, 4, mask.shape[3], mask.shape[4]).transpose(1, 2)
        log.info(
            "[I2V条件] 首尾帧路径(WanFirstLastFrame) start=%s end=%s mask=%s concat=%s",
            None if start is None else int(start.shape[0]),
            None if end is None else int(end.shape[0]),
            tuple(mask.shape),
            tuple(concat_latent.shape),
        )

    positive = node_helpers.conditioning_set_values(
        positive, {"concat_latent_image": concat_latent, "concat_mask": mask}
    )
    negative = node_helpers.conditioning_set_values(
        negative, {"concat_latent_image": concat_latent, "concat_mask": mask}
    )
    return positive, negative, latent_dict


def _build_t2v_cond(positive, negative, vae, width, height, length):
    """纯文生视频：空 latent，不写 concat（与原生 Wan T2V 一致）。"""
    latent_dict, _, _, _ = _empty_latent(vae, width, height, length)
    return positive, negative, latent_dict


def ksampler_advanced(
    model,
    add_noise,
    noise_seed,
    steps,
    cfg,
    sampler_name,
    scheduler,
    positive,
    negative,
    latent_image,
    start_at_step,
    end_at_step,
    return_with_leftover_noise,
    denoise=1.0,
):
    """对齐 ComfyUI「K采样器（高级）」的调用方式。"""
    force_full_denoise = return_with_leftover_noise != "enable"
    disable_noise = add_noise == "disable"

    latent = latent_image
    latent_image_t = latent["samples"]
    if disable_noise:
        noise = torch.zeros(
            latent_image_t.size(),
            dtype=latent_image_t.dtype,
            layout=latent_image_t.layout,
            device="cpu",
        )
    else:
        batch_inds = latent["batch_index"] if "batch_index" in latent else None
        noise = comfy.sample.prepare_noise(latent_image_t, noise_seed, batch_inds)

    noise_mask = latent.get("noise_mask", None)
    callback = latent_preview.prepare_callback(model, steps)
    disable_pbar = not comfy.utils.PROGRESS_BAR_ENABLED

    latent_image_t = comfy.sample.fix_empty_latent_channels(model, latent_image_t)
    samples = comfy.sample.sample(
        model,
        noise,
        steps,
        cfg,
        sampler_name,
        scheduler,
        positive,
        negative,
        latent_image_t,
        denoise=denoise,
        disable_noise=disable_noise,
        start_step=start_at_step,
        last_step=end_at_step,
        force_full_denoise=force_full_denoise,
        noise_mask=noise_mask,
        callback=callback,
        disable_pbar=disable_pbar,
        seed=noise_seed,
    )
    out = latent.copy()
    out["samples"] = samples
    return out


def sample_moe_auto(
    model_high,
    model_low,
    seed,
    steps,
    cfg_high,
    cfg_low,
    sampler_name,
    scheduler,
    positive,
    negative,
    latent,
    boundary=DEFAULT_BOUNDARY,
    sigma_shift=DEFAULT_SHIFT,
):
    """双专家自动切换（按 timestep boundary）+ SD3 shift。"""
    model_high = set_shift(model_high, sigma_shift)
    model_low = set_shift(model_low, sigma_shift)
    (out,) = wan_ksampler_auto(
        model_high, model_low, seed, steps,
        cfg_high, cfg_low, sampler_name, scheduler,
        positive, negative, latent,
        boundary=boundary, denoise=1.0,
    )
    return out


def _decode_frames(vae, latent, out_h=None, out_w=None):
    """解码为 ComfyUI 标准 IMAGE：float32 [N,H,W,3] 范围 0~1。"""
    frames = vae.decode(latent["samples"])
    frames = frames.detach().float()

    if frames.ndim == 5:
        b, t, h, w, c = frames.shape
        if c not in (1, 3, 4) and frames.shape[1] in (1, 3, 4):
            frames = frames.permute(0, 2, 3, 4, 1).contiguous()
            b, t, h, w, c = frames.shape
        frames = frames.reshape(b * t, h, w, c)
    elif frames.ndim == 4:
        if frames.shape[-1] not in (1, 3, 4) and frames.shape[1] in (1, 3, 4):
            frames = frames.permute(0, 2, 3, 1).contiguous()
    else:
        raise ValueError(f"VAE 解码输出维度异常: shape={tuple(frames.shape)}")

    if frames.shape[-1] > 3:
        frames = frames[..., :3]
    elif frames.shape[-1] == 1:
        frames = frames.repeat(1, 1, 1, 3)

    frames = frames.cpu().contiguous()
    mx = float(frames.max().item()) if frames.numel() else 0.0
    if mx > 1.5:
        frames = frames / 255.0
    frames = frames.clamp(0.0, 1.0)

    if out_h and out_w and (frames.shape[1] != out_h or frames.shape[2] != out_w):
        frames = comfy.utils.common_upscale(
            frames.movedim(-1, 1), out_w, out_h, "bilinear", "center"
        ).movedim(1, -1).contiguous()

    log.info(
        "[逐段生成] 解码 shape=%s range=[%.3f, %.3f]",
        tuple(frames.shape), float(frames.min()), float(frames.max()),
    )
    if frames.ndim != 4 or frames.shape[-1] != 3:
        raise ValueError(f"解码后不是标准 IMAGE [N,H,W,3]: {tuple(frames.shape)}")
    if frames.shape[1] < 8 or frames.shape[2] < 8:
        raise ValueError(f"解码分辨率异常过小: {tuple(frames.shape)}")
    return frames


def _tensor_has_content(img) -> bool:
    if img is None:
        return False
    if not isinstance(img, torch.Tensor):
        return False
    if img.numel() == 0:
        return False
    # 全黑接近 0 仍视为有图（用户可能故意用黑图）；仅 None 为无图
    return True


def _normalize_video_frames(frames: torch.Tensor) -> torch.Tensor:
    """已解码视频 → float [N,H,W,3] 0~1。"""
    if frames is None or not isinstance(frames, torch.Tensor) or frames.numel() == 0:
        raise ValueError("无法从上一段视频取帧：帧为空")
    t = frames
    if t.ndim == 5:
        t = t.reshape(-1, t.shape[-3], t.shape[-2], t.shape[-1])
    if t.ndim != 4:
        raise ValueError(f"上一段视频维度异常: {tuple(frames.shape)}")
    t = t.detach().float().cpu().contiguous()
    if t.shape[-1] > 3:
        t = t[..., :3]
    elif t.shape[-1] == 1:
        t = t.repeat(1, 1, 1, 3)
    if float(t.max().item()) > 1.5:
        t = t / 255.0
    return t.clamp(0.0, 1.0)


def _last_frame_as_image(frames: torch.Tensor) -> torch.Tensor:
    """从已解码视频 [N,H,W,3] 取最后一帧 → [1,H,W,3]。"""
    return _normalize_video_frames(frames)[-1:]


def _last_n_frames(frames: torch.Tensor, n: int) -> torch.Tensor:
    """取上一段最后 n 帧 → [n,H,W,3]。"""
    t = _normalize_video_frames(frames)
    n = max(1, min(int(n), int(t.shape[0])))
    return t[-n:].contiguous()


def _find_next_i2v_start(jobs, j):
    """向后查找下一段可用的关键帧图（跨过文字/续接段），用于 ⇄ 尾帧。"""
    for k in range(j + 1, len(jobs)):
        if jobs[k].get("mode") == "i2v" and jobs[k].get("start") is not None:
            return jobs[k]["start"]
    return None


class WanRemixSequentialI2V:
    """
    按导演台时间线逐段生成（每段独立 high→low MoE，解码后释放 latent）。

    - ⇄ 首尾帧 / ✕ 硬切：图生视频
    - 文字段（无图）：若前一段已有生成视频 → 用前段**最后一帧**继续图生（续写）
      仅当前面没有任何可续接视频时，才走纯文生 T2V
    """

    @classmethod
    def INPUT_TYPES(cls):
        # 界面中文；顺序固定，默认数值见 DEFAULT_*
        return {
            "required": {
                "高噪声模型": ("MODEL", {"tooltip": "高噪声专家模型"}),
                "低噪声模型": ("MODEL", {"tooltip": "低噪声专家模型"}),
                "文本编码": ("CLIP", {"tooltip": "文本编码（type=wan）"}),
                "VAE": ("VAE", {"tooltip": "VAE"}),
                "关键帧数据": ("GUIDE_DATA", {"tooltip": "接导演台输出"}),
                "种子": ("INT", {
                    "default": 0, "min": 0, "max": 0xffffffffffffffff,
                    "control_after_generate": True,
                    "tooltip": "随机种子",
                }),
                "步数": ("INT", {
                    "default": DEFAULT_STEPS, "min": 1, "max": 10000,
                    "tooltip": "总采样步数",
                }),
                "切换阈值": ("FLOAT", {
                    "default": DEFAULT_BOUNDARY, "min": 0.0, "max": 1.0, "step": 0.001, "round": 0.001,
                    "tooltip": "高低噪自动切换阈值，图生视频常用 0.9，文生视频常用 0.875",
                }),
                "CFG": ("FLOAT", {
                    "default": DEFAULT_CFG, "min": 0.0, "max": 100.0, "step": 0.1, "round": 0.01,
                    "tooltip": "高噪声 CFG",
                }),
                "采样器": (comfy.samplers.KSampler.SAMPLERS, {
                    "default": DEFAULT_SAMPLER,
                    "tooltip": "采样器名称",
                }),
                "调度器": (comfy.samplers.KSampler.SCHEDULERS, {
                    "default": DEFAULT_SCHEDULER,
                    "tooltip": "调度器名称",
                }),
                "Shift": ("FLOAT", {
                    "default": DEFAULT_SHIFT, "min": 0.0, "max": 100.0, "step": 0.01,
                    "tooltip": "采样算法 SD3 的 shift",
                }),
            },
            "optional": {
                "低噪声CFG": ("FLOAT", {
                    "default": DEFAULT_CFG, "min": 0.0, "max": 100.0, "step": 0.1, "round": 0.01,
                    "tooltip": "低噪声 CFG，≤0 则与 CFG 相同",
                }),
                "负向提示词": ("STRING", {
                    "default": "", "multiline": True, "tooltip": "负向提示词",
                }),
                "全局提示词覆盖": ("STRING", {
                    "default": "", "multiline": True, "tooltip": "全局提示词覆盖",
                }),
                "宽度": ("INT", {
                    "default": 0, "min": 0, "max": 8192, "step": 16,
                    "tooltip": "宽度，0=跟导演台",
                }),
                "高度": ("INT", {
                    "default": 0, "min": 0, "max": 8192, "step": 16,
                    "tooltip": "高度，0=跟导演台",
                }),
                "每段递增种子": ("BOOLEAN", {
                    "default": True, "tooltip": "每段递增种子",
                }),
                "首尾帧去重": ("BOOLEAN", {
                    "default": True, "tooltip": "首尾帧去重",
                }),
                "文字续接末帧": ("BOOLEAN", {
                    "default": True, "tooltip": "文字段续接上一段末帧",
                }),
            },
        }

    RETURN_TYPES = ("WAN_VIDEO_CLIPS", "STRING")
    RETURN_NAMES = ("视频片段包", "运行信息")
    FUNCTION = "run"
    CATEGORY = "WanRemix/Director"
    DESCRIPTION = (
        "Lazy Wan 逐段生成（每段独立 MoE，自动高低噪切换）| "
        f"默认 步数={DEFAULT_STEPS} / 切换阈值={DEFAULT_BOUNDARY} / CFG={DEFAULT_CFG}"
    )

    def run(self, **kwargs):
        g = kwargs.get
        model_high_noise = g("高噪声模型", g("model_high_noise"))
        model_low_noise = g("低噪声模型", g("model_low_noise"))
        clip = g("文本编码", g("clip"))
        vae = g("VAE", g("vae"))
        guide_data = g("关键帧数据", g("guide_data"))
        seed = int(g("种子", g("seed", 0)))
        steps = int(g("步数", g("steps", DEFAULT_STEPS)))
        boundary = float(g("切换阈值", g("boundary", DEFAULT_BOUNDARY)))
        cfg = float(g("CFG", g("cfg", DEFAULT_CFG)))
        sampler_name = g("采样器", g("sampler_name", DEFAULT_SAMPLER))
        scheduler = g("调度器", g("scheduler", DEFAULT_SCHEDULER))
        sigma_shift = float(g("Shift", g("shift", g("sigma_shift", DEFAULT_SHIFT))))
        cfg_low = g("低噪声CFG", g("cfg_low", DEFAULT_CFG))
        cfg_low = float(cfg_low) if cfg_low is not None else DEFAULT_CFG
        if cfg_low <= 0:
            cfg_low = cfg
        negative_prompt = g("负向提示词", g("negative_prompt", "")) or ""
        global_prompt = g("全局提示词覆盖", g("global_prompt", "")) or ""
        width = int(g("宽度", g("width", 0)) or 0)
        height = int(g("高度", g("height", 0)) or 0)
        seed_per_segment = bool(g("每段递增种子", g("seed_per_segment", True)))
        dedupe_flf_boundary = bool(g("首尾帧去重", g("dedupe_flf_boundary", True)))
        text_continue_prev = bool(g("文字续接末帧", g("text_continue_prev", True)))

        if sampler_name == "simple" or sampler_name not in comfy.samplers.KSampler.SAMPLERS:
            sampler_name = DEFAULT_SAMPLER
        if scheduler not in comfy.samplers.KSampler.SCHEDULERS:
            scheduler = DEFAULT_SCHEDULER
        if steps < 1:
            steps = DEFAULT_STEPS
        if sigma_shift < 2.0:
            sigma_shift = DEFAULT_SHIFT
        if boundary <= 0 or boundary >= 1:
            boundary = DEFAULT_BOUNDARY

        log.info(
            "[逐段] 自动高低噪: 步数=%d 切换阈值=%.3f CFG=%.2f/%.2f sampler=%s scheduler=%s shift=%.2f",
            steps, boundary, cfg, cfg_low, sampler_name, scheduler, sigma_shift,
        )

        if not guide_data:
            raise ValueError("关键帧数据为空，请先连接导演台。")

        images = list(guide_data.get("images") or [])
        strengths = list(guide_data.get("strengths") or [])
        seg_prompts = list(guide_data.get("segment_prompts") or [])
        seg_lengths = list(guide_data.get("segment_lengths") or [])
        transitions = list(guide_data.get("segment_transitions") or [])
        modes = list(guide_data.get("segment_modes") or [])

        # 兼容旧 guide_data：无 segment_modes 时按有无图推断
        n = max(len(images), len(seg_prompts), len(seg_lengths), 1)
        while len(images) < n:
            images.append(None)
        while len(modes) < n:
            img = images[len(modes)] if len(modes) < len(images) else None
            st = float(strengths[len(modes)]) if len(modes) < len(strengths) else 1.0
            if img is None or st <= 0.0:
                modes.append("t2v")
            else:
                modes.append("i2v")

        fps = float(guide_data.get("frame_rate", 16) or 16)
        if fps < 1:
            fps = 16.0
        out_w = int(width) if width > 0 else int(guide_data.get("width", 832) or 832)
        out_h = int(height) if height > 0 else int(guide_data.get("height", 480) or 480)
        out_w = max(16, (out_w // 16) * 16)
        out_h = max(16, (out_h // 16) * 16)

        g_prompt = (global_prompt or guide_data.get("global_prompt") or "").strip()
        n_prompt = (negative_prompt or guide_data.get("negative_prompt") or "").strip()
        cfg_l = float(cfg_low)
        resize_method = _normalize_resize_method(
            guide_data.get("resize_method") or "maintain aspect ratio"
        )

        jobs = []
        for i in range(n):
            mode = modes[i] if i < len(modes) else "i2v"
            img = images[i] if i < len(images) else None
            st = float(strengths[i]) if i < len(strengths) else 1.0
            prompt = seg_prompts[i] if i < len(seg_prompts) else ""
            slen = int(seg_lengths[i]) if i < len(seg_lengths) else 0
            length = _snap_4n1(slen if slen >= 5 else 81)
            link = transitions[i] if i < len(transitions) else "flf"
            if link not in ("flf", "cut"):
                link = "flf"

            # 无图 / 显式 t2v / strength<=0 → 文字类片段
            is_text_like = (
                mode == "t2v"
                or not _tensor_has_content(img)
                or st <= 0.0
            )

            if is_text_like:
                # 前面任意段都会生成视频：优先用上一段末帧继续图生
                # 衔接模式保留 ⇄/✕（默认 ⇄），便于接到下一张图做首尾帧
                use_link = link if link in ("flf", "cut") else "flf"
                if text_continue_prev and len(jobs) > 0:
                    jobs.append({
                        "index": i,
                        "mode": "continue",
                        "start": None,
                        "prompt": prompt,
                        "length": length,
                        "link": use_link,
                    })
                else:
                    jobs.append({
                        "index": i,
                        "mode": "t2v",
                        "start": None,
                        "prompt": prompt,
                        "length": length,
                        "link": use_link,
                    })
                continue

            start = img[0:1] if img.ndim == 4 else img.unsqueeze(0)
            jobs.append({
                "index": i,
                "mode": "i2v",
                "start": start,
                "prompt": prompt,
                "length": length,
                "link": link,
            })

        if not jobs:
            raise ValueError("没有可生成的片段。请在导演台加入图片或文字段。")

        # 导演台重叠帧：1=仅末帧；>1=多帧重叠生成后裁掉前缀
        try:
            ov_cfg = int(guide_data.get("overlap_frames", 1) or 1)
        except Exception:
            ov_cfg = 1
        ov_cfg = max(1, min(64, ov_cfg))

        clips = []
        info_lines = []
        meta_modes = []
        prev_clip = None  # 上一段最终出片（裁后），供续接/重叠

        for j, job in enumerate(jobs):
            parts = [p for p in (g_prompt, job["prompt"]) if p]
            pos_text = " ".join(parts) or "cinematic video, natural motion, high quality"
            seg_seed = int(seed) + (j if seed_per_segment else 0)
            mode_label = ""
            latent = None
            content_len = max(5, int(job["length"]))
            gen_length = content_len
            prefix_crop = 0
            used_overlap_n = 0
            # 上一段 -> 本段 的衔接写在上一段 link；硬切则本段不做重叠
            prev_link = jobs[j - 1].get("link", "flf") if j > 0 else None
            from_cut = prev_link == "cut"

            positive = _encode_text(clip, pos_text)
            negative = _encode_text(clip, n_prompt)

            if job["mode"] == "t2v" and (j == 0 or prev_clip is None or from_cut):
                mode_label = "硬切后文生T2V" if from_cut else "文生T2V"
                # 首段纯文生：若 ⇄ 且后方有图，用「仅尾帧」路径拉向下一关键帧
                end_only = None
                if job.get("link") == "flf":
                    nxt_start = _find_next_i2v_start(jobs, j)
                    if nxt_start is not None:
                        end_only = _resize_image(
                            nxt_start, out_w, out_h, resize_method, divisible_by=16
                        )
                        mode_label = "硬切后文生→尾帧⇄" if from_cut else "文生→尾帧⇄"
                        positive, negative, latent = _build_i2v_cond(
                            positive, negative, vae, out_w, out_h, gen_length, None, end_only
                        )
                if latent is None:
                    positive, negative, latent = _build_t2v_cond(
                        positive, negative, vae, out_w, out_h, gen_length
                    )
            else:
                # i2v / continue / 有前段的文字续接
                start_tensor = job.get("start")

                if j > 0 and prev_clip is not None and not from_cut:
                    # 上一段为 ⇄ 才允许重叠/末帧续接
                    if ov_cfg > 1:
                        # 生成=内容+N（向上 4n+1），裁前 N，再截到 content_len
                        used_overlap_n = min(ov_cfg, int(prev_clip.shape[0]))
                        start_tensor = _last_n_frames(prev_clip, used_overlap_n)
                        gen_length = _ceil_4n1(content_len + used_overlap_n)
                        prefix_crop = used_overlap_n
                        mode_label = f"重叠{used_overlap_n}帧"
                    else:
                        # N=1：续接段用末帧；图片段仍用自身关键帧
                        if job["mode"] == "continue" or start_tensor is None:
                            start_tensor = _last_frame_as_image(prev_clip)
                            mode_label = "续接末帧I2V"
                        else:
                            mode_label = "关键帧I2V"
                        gen_length = content_len
                        prefix_crop = 0
                elif from_cut:
                    # 硬切：不用上一段任何帧作运动前缀
                    if job["mode"] == "continue" or start_tensor is None:
                        mode_label = "硬切后文生T2V"
                        end_only = None
                        if job.get("link") == "flf":
                            nxt_start = _find_next_i2v_start(jobs, j)
                            if nxt_start is not None:
                                end_only = _resize_image(
                                    nxt_start, out_w, out_h, resize_method, divisible_by=16
                                )
                                mode_label = "硬切后文生→尾帧⇄"
                                positive, negative, latent = _build_i2v_cond(
                                    positive, negative, vae, out_w, out_h, gen_length, None, end_only
                                )
                        if latent is None:
                            positive, negative, latent = _build_t2v_cond(
                                positive, negative, vae, out_w, out_h, gen_length
                            )
                        start_tensor = None
                    else:
                        mode_label = "硬切关键帧I2V"
                        gen_length = content_len
                        prefix_crop = 0
                elif job["mode"] == "continue":
                    if prev_clip is None:
                        log.warning("[逐段生成] 文字续接无上一段视频，回退纯文生 T2V")
                        mode_label = "文生T2V(无前段)"
                        positive, negative, latent = _build_t2v_cond(
                            positive, negative, vae, out_w, out_h, gen_length
                        )
                        start_tensor = None
                    else:
                        start_tensor = _last_frame_as_image(prev_clip)
                        mode_label = "续接末帧I2V"

                if latent is None:
                    if start_tensor is None:
                        raise ValueError(f"段 #{job['index']+1} 缺少起始图")
                    start_img = _resize_image(
                        start_tensor, out_w, out_h, resize_method, divisible_by=16
                    )
                    end_img = None
                    # ⇄：向后查找下一张关键帧（可跨过文字段）
                    if job["link"] == "flf":
                        nxt_start = _find_next_i2v_start(jobs, j)
                        if nxt_start is not None:
                            end_img = _resize_image(
                                nxt_start, out_w, out_h, resize_method, divisible_by=16
                            )
                    if end_img is not None:
                        mode_label = (mode_label + "+尾帧⇄") if mode_label else "首尾帧⇄"
                    else:
                        if not mode_label:
                            mode_label = "硬切✕/单图I2V"
                    positive, negative, latent = _build_i2v_cond(
                        positive, negative, vae, out_w, out_h, gen_length, start_img, end_img
                    )

            log.info(
                "[逐段生成] (%d/%d) 段#%d 生成=%d 目标出片=%d 重叠前缀=%d 上段衔接=%s 模式=%s seed=%s",
                j + 1, len(jobs), job["index"] + 1, gen_length, content_len, prefix_crop,
                prev_link or "-", mode_label, seg_seed,
            )

            latent = sample_moe_auto(
                model_high_noise,
                model_low_noise,
                seg_seed,
                steps,
                float(cfg),
                cfg_l,
                sampler_name,
                scheduler,
                positive,
                negative,
                latent,
                boundary=boundary,
                sigma_shift=sigma_shift,
            )
            frames = _decode_frames(vae, latent, out_h=out_h, out_w=out_w)

            used_flf = "尾帧" in mode_label or "⇄" in mode_label
            # 多帧重叠：丢掉锁定前缀，再截到本段目标帧数
            if prefix_crop > 0 and frames.shape[0] > prefix_crop:
                frames = frames[prefix_crop:].contiguous()
                if frames.shape[0] > content_len:
                    frames = frames[:content_len].contiguous()
            elif dedupe_flf_boundary and used_flf and frames.shape[0] > 1 and prefix_crop <= 0:
                frames = frames[:-1].contiguous()

            if prefix_crop <= 0 and frames.shape[0] > content_len:
                frames = frames[:content_len].contiguous()

            # 下一段重叠/续接用本段最终出片
            prev_clip = frames

            clips.append(frames)
            if used_overlap_n > 1:
                meta_modes.append("overlap")
            elif from_cut:
                meta_modes.append("cut")
            elif job["mode"] == "continue":
                meta_modes.append("continue")
            elif job["mode"] == "t2v":
                meta_modes.append("t2v")
            elif used_flf:
                meta_modes.append("flf")
            else:
                meta_modes.append("cut")
            info_lines.append(
                f"段{j + 1}: #{job['index']+1}, 出{frames.shape[0]}帧/生{gen_length}/目标{content_len}, "
                f"重叠{used_overlap_n}, 上段={'cut' if from_cut else (prev_link or '-')}, "
                f"{mode_label}, seed={seg_seed}"
            )

            del positive, negative, latent
            # frames 仍被 prev_clip / clips 引用，勿 del frames
            gc.collect()
            try:
                comfy.model_management.soft_empty_cache()
            except Exception:
                pass

        pack = {
            "clips": clips,
            "fps": float(fps),
            "width": out_w,
            "height": out_h,
            "modes": meta_modes,
            "overlap_frames": ov_cfg,
        }
        total = sum(c.shape[0] for c in clips)
        info = (
            f"逐段生成完成：{len(clips)} 段，合计 {total} 帧 / {total / fps:.2f} 秒 "
            f"({out_w}x{out_h} @ {fps}fps)。重叠帧配置={ov_cfg}（硬切接缝不重叠）。"
            f"步数={steps} 切换阈值={boundary} CFG={cfg} 采样器={sampler_name} Shift={sigma_shift}。"
            f"请接「视频段拼合」节点。\n"
            + "\n".join(info_lines)
        )
        log.info("[逐段生成] %s", info.replace("\n", " | "))
        return (pack, info)


class WanRemixMergeClips:
    """将逐段生成的多段视频硬切拼成一条长视频（显存友好：在 CPU 上 cat）。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "视频片段包": ("WAN_VIDEO_CLIPS",),
            },
            "optional": {
                "重叠帧数": ("INT", {
                    "default": 0, "min": 0, "max": 32, "step": 1,
                    "tooltip": "丢掉下一段开头 N 帧（一般 0）",
                }),
            },
        }

    RETURN_TYPES = ("IMAGE", "INT", "FLOAT")
    RETURN_NAMES = ("合并视频", "总帧数", "帧率")
    FUNCTION = "merge"
    CATEGORY = "WanRemix/Director"
    DESCRIPTION = "Lazy · 将「逐段生成」输出的多段视频按顺序拼成一条长视频"

    def merge(self, **kwargs):
        pack = kwargs.get("视频片段包") or kwargs.get("clips_pack")
        overlap = int(kwargs.get("重叠帧数", kwargs.get("overlap_frames", 0)) or 0)
        if not pack or not pack.get("clips"):
            raise ValueError("视频片段包为空")
        clips = list(pack["clips"])
        fps = float(pack.get("fps", 16) or 16)

        fixed = []
        ref_h = ref_w = None
        for i, c in enumerate(clips):
            t = c
            if not isinstance(t, torch.Tensor):
                raise ValueError(f"第 {i+1} 段不是 tensor")
            t = t.detach().float().cpu()
            if t.ndim == 5:
                b, a, h, w, ch = t.shape
                if ch in (1, 3, 4):
                    t = t.reshape(b * a, h, w, ch)
                else:
                    t = t[0]
            if t.ndim == 4 and t.shape[-1] not in (1, 3, 4) and t.shape[1] in (1, 3, 4):
                t = t.permute(0, 2, 3, 1).contiguous()
            if t.ndim != 4:
                raise ValueError(f"第 {i+1} 段维度异常: {tuple(t.shape)}")
            if t.shape[-1] > 3:
                t = t[..., :3]
            elif t.shape[-1] == 1:
                t = t.repeat(1, 1, 1, 3)
            if t.max() > 1.5:
                t = t / 255.0
            t = t.clamp(0.0, 1.0).contiguous()
            if ref_h is None:
                ref_h, ref_w = int(t.shape[1]), int(t.shape[2])
            elif t.shape[1] != ref_h or t.shape[2] != ref_w:
                t = comfy.utils.common_upscale(
                    t.movedim(-1, 1), ref_w, ref_h, "bilinear", "center"
                ).movedim(1, -1).contiguous()
            if i > 0 and overlap > 0 and t.shape[0] > overlap:
                t = t[overlap:]
            fixed.append(t)

        merged = torch.cat(fixed, dim=0).contiguous().float()
        log.info("[拼合] IMAGE shape=%s 供 VHS/保存视频", tuple(merged.shape))
        if merged.ndim != 4 or merged.shape[-1] != 3:
            raise ValueError(f"拼合结果不是标准 IMAGE: {tuple(merged.shape)}")
        return (merged, int(merged.shape[0]), fps)


NODE_CLASS_MAPPINGS = {
    "WanRemixSequentialI2V": WanRemixSequentialI2V,
    "WanRemixMergeClips": WanRemixMergeClips,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WanRemixSequentialI2V": "Lazy Wan2.2 Remix 逐段生成（每段独立 MoE）",
    "WanRemixMergeClips": "Lazy 视频段拼合",
}
