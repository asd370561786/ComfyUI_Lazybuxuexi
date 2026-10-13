# -*- coding: utf-8 -*-
"""
Lazy Wan MoE 采样器

默认：自动高低噪切换（按 timestep boundary），总步数 8，CFG=1，euler，simple，shift=8。
I2V 建议 boundary=0.9，T2V 建议 0.875。
"""

from __future__ import annotations

import math
import torch
import comfy.sample
import comfy.samplers
import comfy.utils
import comfy.model_sampling
import latent_preview

# 推荐默认（自动切换模式）
DEFAULT_STEPS = 8
DEFAULT_BOUNDARY = 0.9  # I2V
DEFAULT_CFG = 1.0
DEFAULT_SAMPLER = "euler"
DEFAULT_SCHEDULER = "simple"
DEFAULT_SHIFT = 8.0

# 兼容旧常量名
DEFAULT_STEPS_HIGH = 4
DEFAULT_STEPS_LOW = 4


def set_shift(model, sigma_shift: float):
    """等价于核心节点「采样算法(SD3)」：新建 sampling 再 patch。"""
    try:
        model = model.clone()
    except Exception:
        pass

    sampling_base = comfy.model_sampling.ModelSamplingDiscreteFlow
    sampling_type = comfy.model_sampling.CONST

    class ModelSamplingAdvanced(sampling_base, sampling_type):
        pass

    original = None
    try:
        original = model.get_model_object("model_sampling")
    except Exception:
        original = None

    model_sampling = ModelSamplingAdvanced(model.model.model_config)
    model_sampling.set_parameters(shift=float(sigma_shift), multiplier=1000)
    if original is not None and hasattr(original, "noise_scale") and hasattr(model_sampling, "set_noise_scale"):
        try:
            model_sampling.set_noise_scale(original.noise_scale)
        except Exception:
            pass
    model.add_object_patch("model_sampling", model_sampling)
    return model


def _safe_float(v, default: float) -> float:
    try:
        if v is None:
            return float(default)
        if isinstance(v, (list, tuple)):
            return float(default)
        x = float(v)
        if math.isnan(x) or math.isinf(x):
            return float(default)
        return x
    except Exception:
        return float(default)


def _safe_int(v, default: int) -> int:
    try:
        if v is None:
            return int(default)
        if isinstance(v, (list, tuple)):
            return int(default)
        x = float(v)
        if math.isnan(x) or math.isinf(x):
            return int(default)
        return int(x)
    except Exception:
        return int(default)


def coerce_sampler_params(
    steps_high=None,
    steps_low=None,
    cfg_high=None,
    cfg_low=None,
    sampler_name=None,
    scheduler=None,
    shift=None,
    force_default: bool = False,
):
    """
    清洗/纠正采样参数。
    控件错位（如采样器误为 simple、Shift 误为 0.9、CFG=NaN）时回退推荐默认。
    合法自定义会保留。
    """
    samplers = set(comfy.samplers.KSampler.SAMPLERS)
    schedulers = set(comfy.samplers.KSampler.SCHEDULERS)

    raw_cfg_high = cfg_high
    raw_cfg_low = cfg_low
    raw_sampler = sampler_name
    raw_scheduler = scheduler
    raw_shift = shift

    sh = _safe_int(steps_high, DEFAULT_STEPS_HIGH)
    sl = _safe_int(steps_low, DEFAULT_STEPS_LOW)
    ch = _safe_float(cfg_high, DEFAULT_CFG)
    cl = _safe_float(cfg_low, DEFAULT_CFG)
    sn = sampler_name if isinstance(sampler_name, str) else DEFAULT_SAMPLER
    sc = scheduler if isinstance(scheduler, str) else DEFAULT_SCHEDULER
    sf = _safe_float(shift, DEFAULT_SHIFT)

    scramble_hits = []

    try:
        if raw_cfg_high is not None and (isinstance(raw_cfg_high, float) and math.isnan(raw_cfg_high)):
            scramble_hits.append("cfg=NaN")
        elif raw_cfg_high is not None:
            float(raw_cfg_high)
    except Exception:
        scramble_hits.append(f"cfg={raw_cfg_high!r}")

    try:
        if raw_cfg_low is not None and (isinstance(raw_cfg_low, float) and math.isnan(raw_cfg_low)):
            scramble_hits.append("cfg_low=NaN")
        elif raw_cfg_low is not None and not isinstance(raw_cfg_low, (int, float, str)):
            float(raw_cfg_low)
    except Exception:
        scramble_hits.append(f"cfg_low={raw_cfg_low!r}")

    # simple 是调度器，不能出现在采样器
    if not isinstance(raw_sampler, str) or raw_sampler not in samplers or raw_sampler == "simple":
        scramble_hits.append(f"sampler={raw_sampler!r}")

    if not isinstance(raw_scheduler, str) or raw_scheduler not in schedulers:
        scramble_hits.append(f"scheduler={raw_scheduler!r}")

    try:
        rsf = float(raw_shift) if raw_shift is not None else sf
        if rsf < 2.0 or rsf > 50:
            scramble_hits.append(f"shift={rsf}")
    except Exception:
        scramble_hits.append(f"shift={raw_shift!r}")

    if ch <= 0 or ch > 30:
        scramble_hits.append(f"cfg={ch}")
    if cl <= 0 or cl > 30:
        scramble_hits.append(f"cfg_low={cl}")

    if abs(sf - 5.0) < 1e-6 and (
        sn != DEFAULT_SAMPLER or sc != DEFAULT_SCHEDULER or "sampler=" in str(scramble_hits)
    ):
        scramble_hits.append("shift=5+错位")

    if force_default or len(scramble_hits) >= 1:
        print(
            f"[Lazy采样器] 参数错位/非法 {scramble_hits} → 使用推荐默认 "
            f"{DEFAULT_STEPS_HIGH}+{DEFAULT_STEPS_LOW} / CFG={DEFAULT_CFG} / "
            f"{DEFAULT_SAMPLER}/{DEFAULT_SCHEDULER} / shift={DEFAULT_SHIFT}"
        )
        sh, sl = DEFAULT_STEPS_HIGH, DEFAULT_STEPS_LOW
        ch, cl = DEFAULT_CFG, DEFAULT_CFG
        sn, sc, sf = DEFAULT_SAMPLER, DEFAULT_SCHEDULER, DEFAULT_SHIFT

    if sn not in samplers or sn == "simple":
        sn = DEFAULT_SAMPLER
    if sc not in schedulers:
        sc = DEFAULT_SCHEDULER
    if sh < 0:
        sh = DEFAULT_STEPS_HIGH
    if sl < 0:
        sl = DEFAULT_STEPS_LOW
    if sh + sl < 1:
        sh, sl = DEFAULT_STEPS_HIGH, DEFAULT_STEPS_LOW
    if ch <= 0:
        ch = DEFAULT_CFG
    if cl <= 0:
        cl = ch
    if sf < 2.0:
        sf = DEFAULT_SHIFT

    return sh, sl, ch, cl, sn, sc, sf


# 兼容旧 import 名
coerce_zn_sampler_params = coerce_sampler_params
ZN_STEPS_HIGH = DEFAULT_STEPS_HIGH
ZN_STEPS_LOW = DEFAULT_STEPS_LOW
ZN_CFG = DEFAULT_CFG
ZN_SAMPLER = DEFAULT_SAMPLER
ZN_SCHEDULER = DEFAULT_SCHEDULER
ZN_SHIFT = DEFAULT_SHIFT


def wan_ksampler_auto(
    model_high_noise,
    model_low_noise,
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
    denoise=1.0,
):
    """
    自动高低噪切换（WanMoe 方式）：
    根据 sigma 对应的 timestep 与 boundary 比较，自动决定从哪一步切到低噪专家。
    I2V 推荐 boundary=0.9，T2V 推荐 0.875。
    """
    steps = max(1, int(steps))
    boundary = float(boundary)
    cfg_high = float(cfg_high)
    cfg_low = float(cfg_low)

    latent_image = latent["samples"]
    batch_inds = latent.get("batch_index")
    noise = comfy.sample.prepare_noise(latent_image, seed, batch_inds)
    noise_mask = latent.get("noise_mask")
    disable_pbar = not comfy.utils.PROGRESS_BAR_ENABLED

    sampling = model_high_noise.get_model_object("model_sampling")
    sigmas = comfy.samplers.calculate_sigmas(sampling, scheduler, steps)
    timesteps = [sampling.timestep(sigma) / 1000 for sigma in sigmas.tolist()]
    switching_step = steps
    for i, t in enumerate(timesteps[1:]):
        if t < boundary:
            switching_step = i
            break

    print(
        f"[Lazy采样器] 自动切换: 总步={steps} 切换步={switching_step} boundary={boundary:.3f} "
        f"CFG高={cfg_high} 低={cfg_low} 采样器={sampler_name} 调度={scheduler}"
    )

    start_step = 0
    last_step = 9999
    start_with_high = start_step < switching_step
    end_with_low = last_step >= switching_step

    if start_with_high:
        print(f"[Lazy采样器] → 高噪声专家  {start_step}→{min(last_step, switching_step)}")
        callback = latent_preview.prepare_callback(model_high_noise, steps)
        end_step = min(last_step, switching_step)
        latent_image = comfy.sample.fix_empty_latent_channels(model_high_noise, latent_image)
        latent_image = comfy.sample.sample(
            model_high_noise, noise, steps, cfg_high, sampler_name, scheduler,
            positive, negative, latent_image,
            denoise=denoise,
            disable_noise=end_with_low,
            start_step=start_step,
            last_step=end_step,
            force_full_denoise=end_with_low,
            noise_mask=noise_mask,
            callback=callback,
            disable_pbar=disable_pbar,
            seed=seed,
        )

    if end_with_low:
        print(f"[Lazy采样器] → 低噪声专家  {max(start_step, switching_step)}→{last_step}")
        callback = latent_preview.prepare_callback(model_low_noise, steps)
        begin_step = max(start_step, switching_step)
        latent_image = comfy.sample.fix_empty_latent_channels(model_low_noise, latent_image)
        latent_image = comfy.sample.sample(
            model_low_noise, noise, steps, cfg_low, sampler_name, scheduler,
            positive, negative, latent_image,
            denoise=denoise,
            disable_noise=False,
            start_step=begin_step,
            last_step=last_step,
            force_full_denoise=True,
            noise_mask=noise_mask,
            callback=callback,
            disable_pbar=disable_pbar,
            seed=seed,
        )

    out = latent.copy()
    out["samples"] = latent_image
    return (out,)


def wan_ksampler_manual(
    model_high_noise,
    model_low_noise,
    seed,
    steps_high,
    steps_low,
    cfg_high,
    cfg_low,
    sampler_name,
    scheduler,
    positive,
    negative,
    latent,
    denoise=1.0,
):
    """保留：手动高+低步（默认请用 wan_ksampler_auto）。"""
    if isinstance(cfg_high, (tuple, list)) and len(cfg_high) == 2:
        cfg_high, cfg_low = float(cfg_high[0]), float(cfg_high[1])
    steps_high = max(0, int(steps_high))
    steps_low = max(0, int(steps_low))
    total = steps_high + steps_low
    if total < 1:
        raise ValueError("高噪声步数+低噪声步数 至少为 1")

    cfg_high = float(cfg_high)
    cfg_low = float(cfg_low)
    latent_image = latent["samples"]
    batch_inds = latent.get("batch_index")
    noise = comfy.sample.prepare_noise(latent_image, seed, batch_inds)
    noise_mask = latent.get("noise_mask")
    disable_pbar = not comfy.utils.PROGRESS_BAR_ENABLED

    print(f"[Lazy采样器] 手动: 高={steps_high} 低={steps_low} 总={total}")

    if steps_high > 0:
        callback = latent_preview.prepare_callback(model_high_noise, total)
        latent_image = comfy.sample.fix_empty_latent_channels(model_high_noise, latent_image)
        latent_image = comfy.sample.sample(
            model_high_noise, noise, total, cfg_high, sampler_name, scheduler,
            positive, negative, latent_image,
            denoise=denoise, disable_noise=False, start_step=0, last_step=steps_high,
            force_full_denoise=(steps_low <= 0), noise_mask=noise_mask,
            callback=callback, disable_pbar=disable_pbar, seed=seed,
        )
    if steps_low > 0:
        callback = latent_preview.prepare_callback(model_low_noise, total)
        latent_image = comfy.sample.fix_empty_latent_channels(model_low_noise, latent_image)
        latent_image = comfy.sample.sample(
            model_low_noise, noise, total, cfg_low, sampler_name, scheduler,
            positive, negative, latent_image,
            denoise=denoise, disable_noise=(steps_high > 0),
            start_step=steps_high if steps_high > 0 else 0,
            last_step=total, force_full_denoise=True, noise_mask=noise_mask,
            callback=callback, disable_pbar=disable_pbar, seed=seed,
        )
    out = latent.copy()
    out["samples"] = latent_image
    return (out,)


class WanRemixMoESampler:
    """单段高低噪采样（自动切换）。界面中文。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "高噪声模型": ("MODEL", {"tooltip": "高噪声专家模型"}),
                "低噪声模型": ("MODEL", {"tooltip": "低噪声专家模型"}),
                "正向条件": ("CONDITIONING", {"tooltip": "正向条件"}),
                "负向条件": ("CONDITIONING", {"tooltip": "负向条件"}),
                "潜空间": ("LATENT", {"tooltip": "潜空间"}),
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
                "高噪声CFG": ("FLOAT", {
                    "default": DEFAULT_CFG, "min": 0.0, "max": 100.0, "step": 0.1, "round": 0.01,
                    "tooltip": "高噪声 CFG",
                }),
                "低噪声CFG": ("FLOAT", {
                    "default": DEFAULT_CFG, "min": 0.0, "max": 100.0, "step": 0.1, "round": 0.01,
                    "tooltip": "低噪声 CFG",
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
                "去噪强度": ("FLOAT", {
                    "default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01,
                    "tooltip": "去噪强度",
                }),
            },
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("潜空间",)
    FUNCTION = "sample"
    CATEGORY = "WanRemix/Director"
    DESCRIPTION = (
        "Lazy Wan 单段采样 | 自动高低噪切换，"
        f"默认 步数={DEFAULT_STEPS} / boundary={DEFAULT_BOUNDARY} / CFG={DEFAULT_CFG} / "
        f"{DEFAULT_SAMPLER} / {DEFAULT_SCHEDULER} / shift={DEFAULT_SHIFT}"
    )

    def sample(self, **kwargs):
        g = kwargs.get
        model_high_noise = g("高噪声模型", g("model_high_noise"))
        model_low_noise = g("低噪声模型", g("model_low_noise"))
        positive = g("正向条件", g("positive"))
        negative = g("负向条件", g("negative"))
        latent_image = g("潜空间", g("latent_image"))
        seed = int(g("种子", g("seed", 0)))
        steps = int(g("步数", g("steps", DEFAULT_STEPS)))
        boundary = float(g("切换阈值", g("boundary", DEFAULT_BOUNDARY)))
        cfg_high = float(g("高噪声CFG", g("cfg_high", g("CFG", DEFAULT_CFG))))
        cfg_low = float(g("低噪声CFG", g("cfg_low", DEFAULT_CFG)))
        sampler_name = g("采样器", g("sampler_name", DEFAULT_SAMPLER))
        scheduler = g("调度器", g("scheduler", DEFAULT_SCHEDULER))
        shift = float(g("Shift", g("shift", g("sigma_shift", DEFAULT_SHIFT))))
        denoise = float(g("去噪强度", g("denoise", 1.0)))

        if sampler_name == "simple" or sampler_name not in comfy.samplers.KSampler.SAMPLERS:
            sampler_name = DEFAULT_SAMPLER
        if scheduler not in comfy.samplers.KSampler.SCHEDULERS:
            scheduler = DEFAULT_SCHEDULER
        if steps < 1:
            steps = DEFAULT_STEPS
        if shift < 2.0:
            shift = DEFAULT_SHIFT
        if cfg_low <= 0:
            cfg_low = cfg_high

        print(
            f"[Lazy采样器·单段] 自动 步数={steps} boundary={boundary} "
            f"CFG={cfg_high}/{cfg_low} sampler={sampler_name} scheduler={scheduler} shift={shift}"
        )

        model_high_noise = set_shift(model_high_noise, shift)
        model_low_noise = set_shift(model_low_noise, shift)
        return wan_ksampler_auto(
            model_high_noise, model_low_noise, seed, steps,
            cfg_high, cfg_low, sampler_name, scheduler,
            positive, negative, latent_image,
            boundary=boundary, denoise=denoise,
        )


NODE_CLASS_MAPPINGS = {
    "WanRemixMoESampler": WanRemixMoESampler,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WanRemixMoESampler": "Lazy 采样器（Wan单段）",
}
