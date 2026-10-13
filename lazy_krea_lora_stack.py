"""
Lazy Krea 多 LoRA：可增减槽位，每槽开关 + 强度 + 类型。
三输出：模型(挂全部LoRA) + 底模 + LoRA配置(供生成按风格屏蔽)。
"""
from __future__ import annotations

import logging

import comfy.sd
import comfy.utils
import folder_paths

log = logging.getLogger(__name__)

MAX_LORAS = 8
LORA_TYPES = ["默认", "风格", "人物"]


def _lora_list():
    try:
        names = list(folder_paths.get_filename_list("loras") or [])
    except Exception:
        names = []
    return ["none"] + names


def _is_dirty_lora_name(name: str) -> bool:
    """控件错位产生的假 LoRA 名（数字/类型/布尔），不能拿去加载。"""
    n = (name or "").strip()
    if not n or n in ("none", "None"):
        return False
    if n in LORA_TYPES or n in ("true", "false", "True", "False"):
        return True
    # 整个名字是纯数字才算脏（避免误伤带数字的真实文件名）
    try:
        float(n)
        return True
    except Exception:
        return False


def _apply_model_lora(model, lora_name: str, strength: float):
    """
    挂模型 LoRA。
    - 不兼容键：不抛错中断整图，跳过并打日志
    - 临时关闭 reject_unloaded_lora_weights，避免个别键导致整栈失败
    """
    if model is None:
        return None
    if not lora_name or str(lora_name) in ("none", "None", ""):
        return model
    if _is_dirty_lora_name(str(lora_name)):
        log.warning("[LazyKrea LoRA] 非法名「%s」，跳过", lora_name)
        return model
    strength = float(strength)
    if abs(strength) < 1e-8:
        return model
    path = folder_paths.get_full_path("loras", str(lora_name))
    if not path:
        log.warning("[LazyKrea LoRA] 找不到: %s", lora_name)
        return model

    opts = getattr(model, "model_options", None)
    prev_reject = None
    had_key = False
    if isinstance(opts, dict):
        had_key = "reject_unloaded_lora_weights" in opts
        prev_reject = opts.get("reject_unloaded_lora_weights", None)
        opts["reject_unloaded_lora_weights"] = False

    try:
        lora = comfy.utils.load_torch_file(path, safe_load=True)
        model_lora, _ = comfy.sd.load_lora_for_models(model, None, lora, strength, 0.0)
        log.info("[LazyKrea LoRA] 已挂 %s @ %.3f", lora_name, strength)
        return model_lora
    except ValueError as e:
        msg = str(e)
        if "lora key not loaded" in msg or "NOT LOADED" in msg:
            log.warning(
                "[LazyKrea LoRA] 与当前模型不兼容，已跳过 %s | %s",
                lora_name,
                msg[:200],
            )
            return model
        log.warning("[LazyKrea LoRA] 加载失败 %s: %s", lora_name, e)
        return model
    except Exception as e:
        log.warning("[LazyKrea LoRA] 加载失败 %s: %s", lora_name, e)
        return model
    finally:
        if isinstance(opts, dict):
            if had_key:
                opts["reject_unloaded_lora_weights"] = prev_reject
            else:
                opts.pop("reject_unloaded_lora_weights", None)


def apply_lora_stack(model, stack: list, skip_types: set | None = None):
    """按配置挂 LoRA；skip_types 内的类型跳过（如 {'风格'}）。"""
    if model is None:
        return None
    skip_types = skip_types or set()
    applied = []
    skipped = []
    for slot in stack or []:
        if not isinstance(slot, dict):
            continue
        if not slot.get("on", True):
            continue
        typ = str(slot.get("type") or "默认")
        if typ in skip_types:
            skipped.append(f"{slot.get('name')}[{typ}]")
            continue
        name = str(slot.get("name") or "none")
        try:
            strength = float(slot.get("strength", 1.0))
        except Exception:
            strength = 1.0
        if name in ("none", "None", "") or abs(strength) < 1e-8:
            continue
        if _is_dirty_lora_name(name):
            log.warning("[LazyKrea LoRA] 配置中非法名「%s」，跳过", name)
            continue
        before = model
        model = _apply_model_lora(model, name, strength)
        if model is not before:
            applied.append(f"{name}[{typ}]@{strength:.2f}")
    if skipped:
        log.info("[LazyKrea LoRA] 已屏蔽: %s", ", ".join(skipped))
    if applied:
        log.info("[LazyKrea LoRA] 筛选挂载: %s", " → ".join(applied))
    return model


class LazyKreaLoraStack:
    MAX_LORAS = MAX_LORAS

    @classmethod
    def INPUT_TYPES(cls):
        loras = _lora_list()
        required = {
            "槽位数": ("INT", {
                "default": 1, "min": 0, "max": cls.MAX_LORAS, "step": 1,
                "tooltip": "当前槽位数。用底部按钮增减。",
            }),
            "模型": ("MODEL", {"tooltip": "待挂 LoRA 的模型。"}),
        }
        # 每槽：启用 → LoRA → 强度 → 类型
        for i in range(1, cls.MAX_LORAS + 1):
            required[f"启用_{i}"] = ("BOOLEAN", {"default": True, "tooltip": "本槽开关。"})
            required[f"LoRA_{i}"] = (loras, {"default": "none", "tooltip": "LoRA 文件。"})
            required[f"强度_{i}"] = ("FLOAT", {
                "default": 1.0, "min": -99.0, "max": 99.0, "step": 0.01,
                "tooltip": "本槽强度。",
            })
            required[f"类型_{i}"] = (LORA_TYPES, {
                "default": "默认",
                "tooltip": "默认=不特殊；风格=选工作台风格时自动屏蔽；人物=始终可保留。",
            })
        return {"required": required}

    RETURN_TYPES = ("MODEL", "MODEL", "KREA_LORA_STACK")
    RETURN_NAMES = ("模型", "底模", "LoRA配置")
    FUNCTION = "apply"
    CATEGORY = "Lazy/Krea"
    DESCRIPTION = "Lazy Krea 多LoRA"

    def apply(self, **kwargs):
        g = kwargs.get
        model = g("模型", g("model"))
        if model is None:
            raise ValueError("请连接模型。")
        base_model = model
        try:
            n_slots = int(g("槽位数", 1) or 0)
        except Exception:
            n_slots = 1
        n_slots = max(0, min(self.MAX_LORAS, n_slots))

        valid = set(_lora_list())
        stack = []
        applied = []
        for i in range(1, n_slots + 1):
            on = bool(g(f"启用_{i}", True))
            name = str(g(f"LoRA_{i}", "none") or "none").strip()

            if _is_dirty_lora_name(name) or (
                name not in ("none", "None", "") and name not in valid
            ):
                if name not in ("none", "None", ""):
                    log.warning("[LazyKrea LoRA] 槽%d 名异常或不存在「%s」→ none", i, name)
                name = "none"

            raw_st = g(f"强度_{i}", 1.0)
            if isinstance(raw_st, bool) or (
                isinstance(raw_st, str)
                and (raw_st in LORA_TYPES or raw_st in ("none", "None", ""))
            ):
                strength = 1.0
            else:
                try:
                    strength = float(raw_st)
                except Exception:
                    strength = 1.0
            if abs(strength) > 99.0:
                strength = 1.0

            typ = str(g(f"类型_{i}", "默认") or "默认")
            if typ not in LORA_TYPES:
                typ = "默认"

            stack.append({
                "on": on,
                "name": name,
                "strength": strength,
                "type": typ,
                "index": i,
            })
            if not on:
                continue
            if name in ("none", "None", "") or abs(strength) < 1e-8:
                continue

            before = model
            model = _apply_model_lora(model, name, strength)
            if model is not before:
                applied.append(f"{name}[{typ}]@{strength:.2f}")

        if applied:
            log.info("[LazyKrea LoRA] %s", " → ".join(applied))
        else:
            log.info("[LazyKrea LoRA] 无生效槽位（底模原样）")
        return (model, base_model, stack)
