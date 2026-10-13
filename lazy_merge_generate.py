"""
Lazy 合并生成：文生图 / 四视图走 Krea2，编辑类走 Qwen2.1。
不改原 Krea / Qwen 节点，只按模式把对应模型、文本编码、VAE 和参数送进去。
"""
from __future__ import annotations

import logging

import comfy.samplers

from .lazy_krea_generate import LazyKreaGenerate, _default_quad_lora
from .lazy_qwen_generate import LazyQwenGenerate

log = logging.getLogger(__name__)


class _AnyPack(str):
    """前端当成 * ，Krea包 / Qwen包 都能接。"""

    def __ne__(self, other):
        return False


PACK = _AnyPack("*")

_KREA_MODES = {"文生图", "四视图"}


def use_krea2(pack: dict) -> bool:
    """文生图、四视图用 Krea2；图像编辑 / 参考多图 / 遮罩 / 扩图用 Qwen2.1。
    自定义风格的 style_channel 为 krea / qwen 时，按风格指定的模型走。"""
    if not isinstance(pack, dict):
        return True
    ch = str(pack.get("style_channel") or "")
    if ch == "qwen":
        return False
    if ch == "krea" or bool(pack.get("quad_view")) or ch == "quad_view":
        return True
    mode = str(pack.get("mode") or "文生图")
    return mode in _KREA_MODES


class LazyMergeGenerate:
    """双模型入口。编辑不使用 Krea 编辑 LoRA。"""

    @classmethod
    def INPUT_TYPES(cls):
        try:
            import folder_paths
            loras = ["none"] + list(folder_paths.get_filename_list("loras") or [])
        except Exception:
            loras = ["none"]
        samplers = list(comfy.samplers.KSampler.SAMPLERS)
        schedulers = list(comfy.samplers.KSampler.SCHEDULERS)
        sampler0 = "euler" if "euler" in samplers else samplers[0]
        sched0 = "simple" if "simple" in schedulers else schedulers[0]
        quad_default = _default_quad_lora(loras)
        return {
            "required": {
                "Krea模型": ("MODEL", {"tooltip": "Krea2 模型。文生可经多LoRA。"}),
                "Krea文本编码": ("CLIP", {"tooltip": "Krea2 文本编码。"}),
                "KreaVAE": ("VAE", {"tooltip": "Krea2 VAE。"}),
                "Qwen模型": ("MODEL", {"tooltip": "Qwen2.1 模型。"}),
                "Qwen文本编码": ("CLIP", {"tooltip": "Qwen2.1 文本编码。"}),
                "QwenVAE": ("VAE", {"tooltip": "Qwen2.1 VAE。"}),
                "工作台包": (PACK, {"tooltip": "工作台输出。"}),
                "种子": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF, "tooltip": "随机种子。"}),
                "Krea步数": ("INT", {"default": 8, "min": 1, "max": 50, "tooltip": "Krea2 步数。"}),
                "KreaCFG": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 20.0, "step": 0.1, "tooltip": "Krea2 CFG。"}),
                "Krea采样器": (samplers, {"default": sampler0, "tooltip": "Krea2 采样器。"}),
                "Krea调度器": (schedulers, {"default": sched0, "tooltip": "Krea2 调度器。"}),
                "宽度": ("INT", {"default": 1024, "min": 64, "max": 4096, "step": 8, "tooltip": "输出宽度。"}),
                "高度": ("INT", {"default": 1024, "min": 64, "max": 4096, "step": 8, "tooltip": "输出高度。"}),
                "Qwen步数": ("INT", {"default": 25, "min": 1, "max": 150, "tooltip": "Qwen2.1 步数。"}),
                "QwenCFG": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 20.0, "step": 0.1, "tooltip": "Qwen2.1 CFG。"}),
                "Qwen采样器": (samplers, {"default": sampler0, "tooltip": "Qwen2.1 采样器。"}),
                "Qwen调度器": (schedulers, {"default": sched0, "tooltip": "Qwen2.1 调度器。"}),
            },
            "optional": {
                "Krea底模": ("MODEL", {"tooltip": "Krea2 底模。四视图用。"}),
                "LoRA配置": ("KREA_LORA_STACK", {"tooltip": "Krea 多LoRA 配置。文生选风格时用。"}),
                "四视图LoRA": (loras, {"default": quad_default, "tooltip": "四视图 LoRA。"}),
                "四视图LoRA强度": ("FLOAT", {
                    "default": 1.0, "min": -99.0, "max": 99.0, "step": 0.01,
                    "tooltip": "四视图 LoRA 强度。",
                }),
                "参考分辨率": ("INT", {
                    "default": 2048, "min": 0, "max": 4096, "step": 32,
                    "tooltip": "参考分辨率上限。",
                }),
                "自定义画布": ("BOOLEAN", {"default": False, "tooltip": "Qwen 编辑使用上方宽高。"}),
                "缓存设备": (["auto", "gpu", "cpu", "off"], {"default": "auto", "tooltip": "Qwen 缓存设备。"}),
                "缓存精度": (["default", "int8", "int4"], {"default": "default", "tooltip": "Qwen 缓存精度。"}),
                "透明底": ("BOOLEAN", {"default": False, "tooltip": "Qwen 透明背景。"}),
                "随机种子": ("BOOLEAN", {"default": True, "tooltip": "生成后更换种子。"}),
            },
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("图像", "运行信息")
    FUNCTION = "generate"
    CATEGORY = "Lazy"
    DESCRIPTION = "Lazy 合并生成"

    def generate(self, **kwargs):
        g = kwargs.get
        pack = g("工作台包", g("Krea包", g("Qwen包")))
        if not isinstance(pack, dict):
            raise ValueError("请连接工作台。")

        krea = use_krea2(pack)
        mode = str(pack.get("mode") or "文生图")
        ch = str(pack.get("style_channel") or "")
        seed = g("种子", 0)
        random_seed = bool(g("随机种子", True))
        width = g("宽度", g("Krea宽度", g("Qwen宽度", 1024)))
        height = g("高度", g("Krea高度", g("Qwen高度", 1024)))
        if krea:
            model = g("Krea模型")
            clip = g("Krea文本编码")
            vae = g("KreaVAE")
            if model is None or clip is None or vae is None:
                if ch == "krea":
                    raise ValueError("此风格使用 K2，请连接 Krea模型、Krea文本编码、KreaVAE。")
                raise ValueError("文生图 / 四视图请连接 Krea模型、Krea文本编码、KreaVAE。")
            base = g("Krea底模")
            if base is None and (bool(pack.get("quad_view")) or mode == "四视图"):
                base = model
                log.warning("[Lazy合并] 四视图未接 Krea底模，改用 Krea模型。")
            log.info("[Lazy合并] 模式=%s → Krea2", mode)
            out = LazyKreaGenerate().generate(
                模型=model,
                文本编码=clip,
                VAE=vae,
                Krea包=pack,
                种子=seed,
                步数=g("Krea步数", 8),
                CFG=g("KreaCFG", 1.0),
                采样器=g("Krea采样器", "euler"),
                调度器=g("Krea调度器", "simple"),
                宽度=width,
                高度=height,
                底模=base,
                LoRA配置=g("LoRA配置"),
                编辑LoRA="none",
                编辑LoRA强度=0.0,
                四视图LoRA=g("四视图LoRA", "none"),
                四视图LoRA强度=g("四视图LoRA强度", 1.0),
                随机种子=random_seed,
                文生保留LoRA=True,
            )
            tag = "Krea2"
        else:
            model = g("Qwen模型")
            clip = g("Qwen文本编码")
            vae = g("QwenVAE")
            if model is None or clip is None or vae is None:
                if ch == "qwen":
                    raise ValueError("此风格使用 Qwen，请连接 Qwen模型、Qwen文本编码、QwenVAE。")
                raise ValueError("图像编辑 / 多图 / 遮罩 / 扩图请连接 Qwen模型、Qwen文本编码、QwenVAE。")
            log.info("[Lazy合并] 模式=%s → Qwen2.1", mode)
            out = LazyQwenGenerate().generate(
                模型=model,
                文本编码=clip,
                VAE=vae,
                Qwen包=pack,
                种子=seed,
                步数=g("Qwen步数", 25),
                CFG=g("QwenCFG", 1.0),
                采样器=g("Qwen采样器", "euler"),
                调度器=g("Qwen调度器", "simple"),
                宽度=width,
                高度=height,
                参考分辨率=g("参考分辨率", 2048),
                自定义画布=bool(g("自定义画布", False)),
                缓存设备=g("缓存设备", "auto"),
                缓存精度=g("缓存精度", "default"),
                透明底=bool(g("透明底", False)),
                随机种子=random_seed,
            )
            tag = "Qwen2.1"
        return _tag_result(out, tag, mode)


def _tag_result(out, tag: str, mode: str):
    prefix = f"后端={tag} 模式={mode}"

    def _join(info):
        text = str(info or "")
        return f"{prefix} | {text}" if text else prefix

    if isinstance(out, dict):
        result = out.get("result")
        if isinstance(result, tuple) and len(result) >= 2:
            out = dict(out)
            out["result"] = (result[0], _join(result[1]))
        return out
    if isinstance(out, tuple) and len(out) >= 2:
        return (out[0], _join(out[1]))
    return out
