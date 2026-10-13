"""
Lazy H3 双模型加载：分镜(fl2va) + 多参(ref2va)，双输出，不自动改连线。
"""
from __future__ import annotations

import logging

import comfy.sd
import folder_paths
import torch

log = logging.getLogger(__name__)


def _load_unet(unet_name: str, weight_dtype: str = "default"):
    if not unet_name or unet_name in ("none", "None", ""):
        return None
    model_options = {}
    if weight_dtype == "fp8_e4m3fn":
        model_options["dtype"] = torch.float8_e4m3fn
    elif weight_dtype == "fp8_e4m3fn_fast":
        model_options["dtype"] = torch.float8_e4m3fn
        model_options["fp8_optimizations"] = True
    elif weight_dtype == "fp8_e5m2":
        model_options["dtype"] = torch.float8_e5m2
    path = folder_paths.get_full_path_or_raise("diffusion_models", unet_name)
    return comfy.sd.load_diffusion_model(path, model_options=model_options)


class LazyH3ModelLoader:
    """一次加载分镜模型与多参模型，两个 MODEL 输出。"""

    @classmethod
    def INPUT_TYPES(cls):
        unets = folder_paths.get_filename_list("diffusion_models")
        unets_opt = ["none"] + list(unets)
        dtypes = ["default", "fp8_e4m3fn", "fp8_e4m3fn_fast", "fp8_e5m2"]
        return {
            "required": {
                "分镜模型fl": (unets, {
                    "tooltip": "H3 分镜 fl2va。",
                }),
                "数据类型": (dtypes, {
                    "default": "default",
                    "tooltip": "权重数据类型。",
                }),
            },
            "optional": {
                "多参模型ref": (unets_opt, {
                    "default": "none",
                    "tooltip": "H3 多参 ref2va。none=不加载。",
                }),
            },
        }

    RETURN_TYPES = ("MODEL", "MODEL")
    # 与导演台输入口同名，方便接线
    RETURN_NAMES = ("model_fl", "model_ref")
    FUNCTION = "load"
    CATEGORY = "Lazy/H3"
    DESCRIPTION = "Lazy H3 双模型加载"

    def load(self, **kwargs):
        fl_name = (
            kwargs.get("分镜模型fl")
            or kwargs.get("分镜模型")
            or kwargs.get("model_storyboard")
        )
        ref_name = (
            kwargs.get("多参模型ref")
            or kwargs.get("多参模型")
            or kwargs.get("model_ref")
            or "none"
        )
        dtype = kwargs.get("数据类型") or kwargs.get("weight_dtype") or "default"

        model_fl = _load_unet(fl_name, dtype)
        if model_fl is None:
            raise ValueError("请选择分镜模型。")

        model_ref = None
        used_ref_name = ref_name
        if ref_name and str(ref_name) not in ("none", "None"):
            try:
                model_ref = _load_unet(str(ref_name), dtype)
            except Exception as e:
                log.warning("[LazyH3] 多参模型加载失败: %s", e)
                model_ref = None

        # 未指定时自动找 ref2va，避免多参误用 fl2va 导致人物不像参考
        if model_ref is None:
            auto = None
            try:
                candidates = folder_paths.get_filename_list("diffusion_models") or []
            except Exception:
                candidates = []
            for n in candidates:
                nl = str(n).lower()
                if "ref2va" in nl or ("ref" in nl and "h3" in nl and "fl2va" not in nl):
                    auto = n
                    break
            if auto:
                try:
                    model_ref = _load_unet(auto, dtype)
                    used_ref_name = auto
                    log.info("[LazyH3] 多参模型未选，已自动加载: %s", auto)
                except Exception as e:
                    log.warning("[LazyH3] 自动加载多参模型失败: %s", e)
                    model_ref = None

        # 仍没有则占位分镜模型（并打警告）
        if model_ref is None:
            model_ref = model_fl
            used_ref_name = "(同用分镜/未找到 ref2va)"
            log.warning(
                "[LazyH3] 未加载 ref2va 多参模型，多参生成会很难锁住参考人脸。"
                "请选择 minimax_h3_ref2va_* 文件。"
            )

        log.info(
            "[LazyH3] 已加载分镜=%s 多参=%s",
            fl_name,
            used_ref_name,
        )
        return (model_fl, model_ref)
