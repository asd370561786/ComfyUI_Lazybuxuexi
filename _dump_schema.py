import os
import sys
import types

sys.path.insert(0, r"C:\Users\Administrator\ComfyUI-Installs\ComfyUI\ComfyUI")
os.chdir(r"C:\Users\Administrator\ComfyUI-Installs\ComfyUI\ComfyUI")


class DummyRoutes:
    def get(self, p):
        def deco(fn):
            return fn
        return deco

    def post(self, p):
        def deco(fn):
            return fn
        return deco


class DummyPS:
    instance = types.SimpleNamespace(routes=DummyRoutes())


sys.modules["server"] = types.SimpleNamespace(PromptServer=DummyPS)
sys.path.insert(0, r"C:\Users\Administrator\Documents\ComfyUI\custom_nodes\ceshi")

import wan_director as wd

schema = wd.WanRemixDirector.define_schema()
print("=== SCHEMA INPUTS ===")
for inp in schema.inputs:
    force = getattr(inp, "force_input", None)
    default = getattr(inp, "default", None)
    dname = getattr(inp, "display_name", None)
    print(
        f"{inp.id:25} display={dname!r:20} optional={inp.optional} force={force} "
        f"default={default!r} type={type(inp).__name__}"
    )

info = schema.get_v1_info(wd.WanRemixDirector)
print("\n=== V1 required (widget order) ===")
for k, v in info.input.get("required", {}).items():
    print(" R", k, "->", v)

print("\n=== V1 optional (widget order) ===")
for k, v in info.input.get("optional", {}).items():
    print(" O", k, "->", v)

print("\n=== input_order ===")
print(info.input_order)

# ComfyUI frontend typically builds widgets for all non-force-input fields in order:
# required then optional, skipping pure link types without widgets? Models still show as inputs.
# Widgets_values order is usually only widgets, not connected-only slots.
# Heuristic: fields that become widgets
widget_like = []
for section in ("required", "optional"):
    for k, v in info.input.get(section, {}).items():
        t = v[0] if isinstance(v, (list, tuple)) else v
        if t in ("MODEL", "CLIP", "VAE", "LATENT", "CONDITIONING", "IMAGE", "MASK", "AUDIO"):
            continue  # socket types
        # force_input string?
        cfg = v[1] if isinstance(v, (list, tuple)) and len(v) > 1 and isinstance(v[1], dict) else {}
        if cfg.get("forceInput"):
            continue
        widget_like.append((section, k, t, cfg.get("default"), cfg.get("min"), cfg.get("max"), cfg.get("options")))

print("\n=== inferred widgets_values order ===")
for i, item in enumerate(widget_like):
    print(i, item)
