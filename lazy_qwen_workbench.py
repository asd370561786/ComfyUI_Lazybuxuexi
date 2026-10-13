"""
Lazy Qwen2.1 工作台：风格 + 多图/遮罩路径 + 多段提示词 → QWEN21_PACK。
由 Krea2 工作台复制，不改动原节点。
"""
from __future__ import annotations

import json
import logging
import os

import numpy as np
import torch
from PIL import Image, ImageOps

import folder_paths

from .lazy_krea_styles import (
    apply_style,
    is_outpaint_style,
    is_quad_view_style,
    list_style_files,
)

log = logging.getLogger(__name__)

MAX_IMAGES = 10


def _load_image_tensor(path: str):
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)
    if img.mode == "I":
        img = img.point(lambda i: i * (1 / 255))
    has_alpha = img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info)
    if has_alpha:
        image = img.convert("RGBA")
    else:
        image = img.convert("RGB")
    arr = np.array(image).astype(np.float32) / 255.0
    return torch.from_numpy(arr)[None, ...]


def _load_mask_tensor(path: str, h: int, w: int):
    if not path or not os.path.isfile(path):
        return torch.zeros((1, h, w), dtype=torch.float32)
    m = Image.open(path)
    m = ImageOps.exif_transpose(m).convert("L")
    if m.size != (w, h):
        m = m.resize((w, h), Image.Resampling.BILINEAR)
    arr = np.array(m).astype(np.float32) / 255.0
    return torch.from_numpy(arr)[None, ...]


def _resolve_path(name: str, folder_type: str = "input") -> str | None:
    """按 type=input/output/temp + 相对路径解析图片。"""
    if not name:
        return None
    name = str(name).strip().replace("\\", "/")
    if os.path.isfile(name):
        return name
    try:
        p = folder_paths.get_annotated_filepath(name)
        if p and os.path.isfile(p):
            return p
    except Exception:
        pass

    bases = []
    ft = (folder_type or "input").lower()
    try:
        if ft == "output":
            bases.append(folder_paths.get_output_directory())
        elif ft == "temp":
            bases.append(folder_paths.get_temp_directory())
        else:
            bases.append(folder_paths.get_input_directory())
    except Exception:
        pass
    for getter in (
        folder_paths.get_input_directory,
        folder_paths.get_output_directory,
        folder_paths.get_temp_directory,
    ):
        try:
            b = getter()
            if b and b not in bases:
                bases.append(b)
        except Exception:
            pass

    for base in bases:
        cand = os.path.join(base, name)
        if os.path.isfile(cand):
            return cand
        cand2 = os.path.join(base, os.path.basename(name))
        if os.path.isfile(cand2):
            return cand2
    return None


def _parse_prompts_json(raw: str) -> list[str]:
    """[{text,on}] 或换行文本 → 启用中的提示词列表。"""
    raw = (raw or "").strip()
    if not raw:
        return [""]
    if raw.startswith("["):
        try:
            data = json.loads(raw)
            out = []
            if isinstance(data, list):
                for item in data:
                    if isinstance(item, dict):
                        if item.get("on", True) is False:
                            continue
                        t = str(item.get("text") or "").strip()
                        if t:
                            out.append(t)
                    elif isinstance(item, str) and item.strip():
                        out.append(item.strip())
            return out or [""]
        except Exception:
            pass
    lines = [ln.strip() for ln in raw.splitlines() if ln.strip()]
    return lines or [""]


def _parse_media_json(raw: str) -> list[dict]:
    """[{image, mask}]"""
    raw = (raw or "").strip()
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except Exception:
        return [{"image": p, "mask": ""} for p in raw.splitlines() if p.strip()]
    if not isinstance(data, list):
        return []
    out = []
    for item in data:
        if isinstance(item, str) and item.strip():
            out.append({"image": item.strip(), "mask": ""})
        elif isinstance(item, dict) and item.get("image"):
            out.append({
                "image": str(item.get("image") or "").strip(),
                "mask": str(item.get("mask") or "").strip(),
                "type": str(item.get("type") or "input").strip() or "input",
                "subfolder": str(item.get("subfolder") or "").strip(),
                "maskType": str(item.get("maskType") or "").strip(),
                "maskSubfolder": str(item.get("maskSubfolder") or "").strip(),
            })
    return out[:MAX_IMAGES]


class LazyQwenWorkbench:
    """风格 / 多图遮罩 / 多提示词 → QWEN21_PACK。"""

    @classmethod
    def INPUT_TYPES(cls):
        files = list(list_style_files())
        default_file = files[1] if len(files) > 1 else "none"
        return {
            "required": {
                "风格库": (files, {
                    "default": default_file if default_file in files else files[0],
                    "tooltip": "风格库文件。",
                }),
                "风格": ("STRING", {
                    "default": "none",
                    "tooltip": "当前风格。",
                }),
                "图片数据": ("STRING", {
                    "default": "[]",
                    "multiline": True,
                    "tooltip": "参考图数据。",
                }),
                "提示词数据": ("STRING", {
                    "default": '[{"text":"","on":true}]',
                    "multiline": True,
                    "tooltip": "提示词数据。",
                }),
            },
            "optional": {
                "图像1": ("IMAGE", {"tooltip": "可选参考图。"}),
                "图像2": ("IMAGE", {"tooltip": "可选参考图。"}),
                "遮罩1": ("MASK", {"tooltip": "可选遮罩。"}),
                "提示词": ("STRING", {
                    "forceInput": True,
                    "default": "",
                    "multiline": True,
                    "tooltip": "外接提示词。",
                }),
            },
        }

    RETURN_TYPES = ("QWEN21_PACK", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("Qwen包", "正向提示", "模式", "运行信息")
    FUNCTION = "build"
    CATEGORY = "Lazy/Qwen"
    DESCRIPTION = "Lazy Qwen2.1 工作台"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def build(self, **kwargs):
        g = kwargs.get
        style_file = str(g("风格库", "none") or "none")
        style_name = str(g("风格", "none") or "none")
        media = _parse_media_json(str(g("图片数据", "[]") or "[]"))

        ext_prompt = g("提示词", None)
        if ext_prompt is not None and str(ext_prompt).strip():
            prompts = _parse_prompts_json(str(ext_prompt))
        else:
            prompts = _parse_prompts_json(str(g("提示词数据", "") or ""))

        img1 = g("图像1", g("image_1"))
        img2 = g("图像2", g("image_2"))
        mask1 = g("遮罩1", g("mask_1"))

        images = []
        masks = []
        has_mask = False

        def _add_tensor_image(img_t, mask_t=None):
            nonlocal has_mask
            if img_t is None:
                return
            if len(images) >= MAX_IMAGES:
                return
            t = img_t
            if t.ndim == 3:
                t = t.unsqueeze(0)
            images.append(t)
            h, w = int(t.shape[1]), int(t.shape[2])
            if mask_t is not None:
                m = mask_t
                if m.ndim == 2:
                    m = m.unsqueeze(0)
                if m.shape[-2] != h or m.shape[-1] != w:
                    m = torch.nn.functional.interpolate(
                        m.unsqueeze(1).float(), size=(h, w), mode="bilinear"
                    ).squeeze(1)
                masks.append(m)
                if float(m.max()) > 0.01:
                    has_mask = True
            else:
                masks.append(torch.zeros((t.shape[0], h, w), dtype=torch.float32))

        for item in media:
            ftype = str(item.get("type") or "input")
            rel = item.get("image") or ""
            sub = str(item.get("subfolder") or "").replace("\\", "/").strip("/")
            if sub and sub + "/" not in str(rel).replace("\\", "/"):
                rel = f"{sub}/{os.path.basename(str(rel))}"
            p = _resolve_path(rel, ftype)
            if not p:
                continue
            try:
                im = _load_image_tensor(p)
                mrel = str(item.get("mask") or "").strip()
                mk = None
                if mrel:
                    mtype = str(item.get("maskType") or item.get("type") or "input").strip() or "input"
                    msub = str(item.get("maskSubfolder") or "").replace("\\", "/").strip("/")
                    mpath = mrel.replace("\\", "/")
                    if msub and f"{msub}/" not in mpath:
                        mpath = f"{msub}/{os.path.basename(mpath)}"
                    mp = _resolve_path(mpath, mtype)
                    if not mp:
                        mp = _resolve_path(os.path.basename(mpath), "input")
                    if mp:
                        mk = _load_mask_tensor(mp, int(im.shape[1]), int(im.shape[2]))
                        if mk is not None and float(mk.max()) < 0.01:
                            try:
                                from PIL import Image as _PILImage
                                import numpy as _np
                                raw = _PILImage.open(mp)
                                raw = raw.convert("RGBA")
                                arr = _np.array(raw).astype(_np.float32) / 255.0
                                if arr.shape[-1] == 4 and float(arr[..., 3].min()) < 0.99:
                                    msk = 1.0 - arr[..., 3]
                                else:
                                    msk = arr[..., 2]
                                if msk.shape != (im.shape[1], im.shape[2]):
                                    msk = _np.array(
                                        _PILImage.fromarray((msk * 255).astype(_np.uint8)).resize(
                                            (im.shape[2], im.shape[1])
                                        )
                                    ).astype(_np.float32) / 255.0
                                mk = torch.from_numpy(msk)[None, ...]
                            except Exception:
                                pass
                    else:
                        log.warning("[LazyQwen] 找不到遮罩文件: %s", mrel)
                if mk is not None and float(mk.max()) > 0.01:
                    has_mask = True
                _add_tensor_image(im, mk)
            except Exception as e:
                log.warning("[LazyQwen] 读图失败 %s: %s", p, e)

        if not images:
            _add_tensor_image(img1, mask1)
            _add_tensor_image(img2, None)
        elif len(images) == 1 and img2 is not None:
            _add_tensor_image(img2, None)

        n_img = len(images)
        quad_view = is_quad_view_style(style_file, style_name)
        outpaint = is_outpaint_style(style_file, style_name)

        if quad_view or outpaint:
            tag = "四视图" if quad_view else "扩图"
            if n_img < 1:
                raise RuntimeError(
                    f"「{tag}」需要 1 张参考图。请在工作台放入图片后再生成。"
                )
            if n_img > 1:
                log.warning("[LazyQwen] %s仅用第 1 张参考图，已忽略其余图。", tag)
                images = images[:1]
                masks = masks[:1] if masks else []
                n_img = 1
            has_mask = False
            t0 = images[0]
            masks = [torch.zeros((t0.shape[0], t0.shape[1], t0.shape[2]), dtype=torch.float32)]
            mode = tag
        elif n_img <= 0:
            mode = "文生图"
        elif has_mask:
            mode = "局部编辑"
        elif n_img == 1:
            mode = "单图编辑"
        else:
            mode = "多图编辑"

        styled = []
        neg = ""
        for pr in prompts:
            pos, ng = apply_style(pr, style_file, style_name)
            styled.append(pos or pr)
            if ng and not neg:
                neg = ng

        first_pos = styled[0] if styled else ""
        channel = (
            "quad_view" if quad_view else ("outpaint" if outpaint else "")
        )
        pack = {
            "mode": mode,
            "prompts": styled,
            "negative": neg,
            "style_file": style_file,
            "style_name": style_name,
            "images": images,
            "masks": masks,
            "has_mask": has_mask,
            "n_images": n_img,
            "quad_view": bool(quad_view),
            "outpaint": bool(outpaint),
            "style_channel": channel,
        }
        info = (
            f"模式={mode} 图={n_img} 提示段={len(styled)} "
            f"风格={style_file}/{style_name} 遮罩={'有' if has_mask else '无'}"
            + (f" 通道={mode}" if channel else "")
        )
        log.info("[LazyQwen] %s", info)
        return (pack, first_pos, mode, info)
