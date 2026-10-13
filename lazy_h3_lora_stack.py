"""
Lazy H3 多 LoRA 组合：同一套槽位同时挂到 fl2va / ref2va。
每槽：开关 + 文件 + 强度；前端可动态增减显示槽数。
"""
from __future__ import annotations

import logging

import comfy.sd
import comfy.utils
import folder_paths

log = logging.getLogger(__name__)

MAX_LORAS = 16


def _lora_list():
    try:
        names = list(folder_paths.get_filename_list("loras") or [])
    except Exception:
        names = []
    return ["none"] + names


def _apply_model_lora(model, lora_name: str, strength: float):
    """仅模型 LoRA（对齐 LoraLoaderModelOnly）。"""
    if model is None:
        return None
    if not lora_name or str(lora_name) in ("none", "None", ""):
        return model
    strength = float(strength)
    if abs(strength) < 1e-8:
        return model
    path = folder_paths.get_full_path("loras", str(lora_name))
    if not path:
        log.warning("[LazyH3 LoRA] 找不到文件: %s", lora_name)
        return model
    try:
        lora = comfy.utils.load_torch_file(path, safe_load=True)
        model_lora, _ = comfy.sd.load_lora_for_models(model, None, lora, strength, 0.0)
        log.info("[LazyH3 LoRA] 已挂 %s @ %.3f", lora_name, strength)
        return model_lora
    except Exception as e:
        log.warning("[LazyH3 LoRA] 加载失败 %s: %s", lora_name, e)
        return model


class LazyH3LoraStack:
    """
    分镜(fl2va) + 多参(ref2va) 双进双出，多槽 LoRA 顺序叠加。
    """

    MAX_LORAS = MAX_LORAS

    @classmethod
    def INPUT_TYPES(cls):
        loras = _lora_list()
        # 槽控件放 required，避免被前端转成「隐藏输入口」导致只剩强度可见
        required = {
            "槽位数": ("INT", {
                "default": 1,
                "min": 0,
                "max": cls.MAX_LORAS,
                "step": 1,
                "tooltip": "当前槽位数。用底部按钮增减。",
            }),
        }
        for i in range(1, cls.MAX_LORAS + 1):
            required[f"启用_{i}"] = ("BOOLEAN", {
                "default": True,
                "tooltip": "本槽开关。",
            })
            required[f"LoRA_{i}"] = (loras, {
                "default": "none",
                "tooltip": "LoRA 文件。",
            })
            required[f"强度_{i}"] = ("FLOAT", {
                "default": 1.0,
                "min": -99.0,
                "max": 99.0,
                "step": 0.01,
                "tooltip": "本槽强度。",
            })
        optional = {
            "model_fl": ("MODEL", {
                "tooltip": "分镜模型 fl2va 输入。",
            }),
            "model_ref": ("MODEL", {
                "tooltip": "多参模型 ref2va 输入。",
            }),
        }
        return {"required": required, "optional": optional}

    RETURN_TYPES = ("MODEL", "MODEL")
    RETURN_NAMES = ("model_fl", "model_ref")
    FUNCTION = "apply"
    CATEGORY = "Lazy/H3"
    DESCRIPTION = "Lazy H3 多 LoRA · 双模型"

    def apply(self, **kwargs):
        g = kwargs.get
        model_fl = g("model_fl")
        model_ref = g("model_ref")
        try:
            n_slots = int(g("槽位数", g("num_loras", 1)) or 0)
        except Exception:
            n_slots = 1
        n_slots = max(0, min(self.MAX_LORAS, n_slots))

        ref_same = (
            model_ref is not None
            and model_fl is not None
            and model_ref is model_fl
        )

        applied = []
        for i in range(1, n_slots + 1):
            enabled = bool(g(f"启用_{i}", True))
            name = g(f"LoRA_{i}", g(f"lora_{i}", "none"))
            name = str(name).strip() if name is not None else "none"
            try:
                strength = float(g(f"强度_{i}", g(f"strength_{i}", 1.0)))
            except Exception:
                strength = 1.0

            if not enabled:
                continue
            if name in ("none", "None", ""):
                continue
            if abs(strength) < 1e-8:
                continue

            if model_fl is not None:
                model_fl = _apply_model_lora(model_fl, name, strength)
            if model_ref is not None:
                if ref_same:
                    model_ref = model_fl
                else:
                    model_ref = _apply_model_lora(model_ref, name, strength)
            applied.append(f"{name}@{strength:.2f}")

        if model_fl is None and model_ref is None:
            raise ValueError("请至少连接 model_fl 或 model_ref。")

        # 只接一侧时另一侧透传同结果，方便下游
        if model_fl is None:
            model_fl = model_ref
        if model_ref is None:
            model_ref = model_fl

        if applied:
            log.info(
                "[LazyH3 LoRA] 共 %d 个: %s",
                len(applied),
                " → ".join(applied),
            )
        else:
            log.info("[LazyH3 LoRA] 无生效槽位，原样输出模型。")

        return (model_fl, model_ref)
