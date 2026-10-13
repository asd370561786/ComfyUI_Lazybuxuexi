"""
Lazy 合并台：风格 + 最多 10 张参考图。
文生图 / 四视图给 Krea2，编辑类给 Qwen2.1。
提示词在台内按行切分，一行一张图。
"""
from __future__ import annotations

import logging
import os

import torch

from .lazy_krea_styles import apply_style, get_style_channel, list_style_files
from .lazy_qwen_workbench import (
    MAX_IMAGES,
    _load_image_tensor,
    _load_mask_tensor,
    _parse_media_json,
    _resolve_path,
)

log = logging.getLogger(__name__)


def _prompt_lines(text, start_index=0, max_rows=1000, remove_empty=False) -> list[str]:
    """按行切分。空文本只保留一段空提示，避免多出空图。"""
    lines = str(text or "").splitlines()
    if remove_empty:
        lines = [line for line in lines if line.strip()]
    if not lines:
        return [""]
    start = max(0, min(int(start_index or 0), len(lines) - 1))
    count = max(1, int(max_rows or 1))
    return lines[start:start + count] or [""]


def _mask_from_preview(path: str, h: int, w: int):
    """遮罩若被存成彩色预览，改从透明或亮部还原。"""
    try:
        from PIL import Image as PILImage
        import numpy as np

        raw = PILImage.open(path).convert("RGBA")
        arr = np.array(raw).astype(np.float32) / 255.0
        if arr.shape[-1] == 4 and float(arr[..., 3].min()) < 0.99:
            msk = 1.0 - arr[..., 3]
        else:
            msk = arr[..., 2]
        if msk.shape != (h, w):
            msk = np.array(
                PILImage.fromarray((msk * 255).astype(np.uint8)).resize((w, h))
            ).astype(np.float32) / 255.0
        return torch.from_numpy(msk)[None, ...]
    except Exception:
        return None


class LazyMergeWorkbench:
    """风格 / 最多 10 张图 / 按行提示词 → 合并包。"""

    @classmethod
    def INPUT_TYPES(cls):
        files = list(list_style_files())
        default_file = files[1] if len(files) > 1 else "none"
        optional = {}
        for i in range(1, MAX_IMAGES + 1):
            optional[f"图像{i}"] = ("IMAGE", {"tooltip": "参考图。"})
        optional["遮罩1"] = ("MASK", {"tooltip": "遮罩。"})
        optional["提示词"] = ("STRING", {
            "forceInput": True,
            "default": "",
            "tooltip": "提示词。",
        })
        return {
            "required": {
                "风格库": (files, {
                    "default": default_file if default_file in files else files[0],
                    "tooltip": "风格库。",
                }),
                "风格": ("STRING", {
                    "default": "none",
                    "tooltip": "风格。",
                }),
                "图片数据": ("STRING", {
                    "default": "[]",
                    "multiline": True,
                    "tooltip": "参考图数据。",
                }),
                "提示词文本": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "tooltip": "提示词。",
                }),
                "起始索引": ("INT", {
                    "default": 0, "min": 0, "max": 9999,
                    "tooltip": "起始索引。",
                }),
                "最大行数": ("INT", {
                    "default": 1000, "min": 1, "max": 9999,
                    "tooltip": "最大行数。",
                }),
                "去除空行": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "去除空行。",
                }),
            },
            "optional": optional,
        }

    RETURN_TYPES = ("MERGE_PACK", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("工作台包", "正向提示", "模式", "运行信息")
    FUNCTION = "build"
    CATEGORY = "Lazy"
    DESCRIPTION = "Lazy 合并台"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def build(self, **kwargs):
        g = kwargs.get
        style_file = str(g("风格库", "none") or "none")
        style_name = str(g("风格", "none") or "none")
        media = _parse_media_json(str(g("图片数据", "[]") or "[]"))

        ext = g("提示词", None)
        if isinstance(ext, (list, tuple)):
            ext_text = "\n".join("" if item is None else str(item) for item in ext)
        elif ext is None:
            ext_text = ""
        else:
            ext_text = str(ext)
        text = ext_text if ext_text.strip() else str(g("提示词文本", "") or "")
        prompts = _prompt_lines(
            text,
            g("起始索引", 0),
            g("最大行数", 1000),
            bool(g("去除空行", False)),
        )

        images = []
        masks = []
        has_mask = False

        def _add_tensor_image(img_t, mask_t=None):
            nonlocal has_mask
            if img_t is None or len(images) >= MAX_IMAGES:
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

        wired = []
        for i in range(1, MAX_IMAGES + 1):
            img = g(f"图像{i}")
            if img is None:
                continue
            wired.append((img, g("遮罩1") if i == 1 else None))

        if wired:
            for img, mask in wired:
                _add_tensor_image(img, mask)
        else:
            for item in media:
                if len(images) >= MAX_IMAGES:
                    break
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
                        mp = _resolve_path(mpath, mtype) or _resolve_path(os.path.basename(mpath), "input")
                        if mp:
                            mk = _load_mask_tensor(mp, int(im.shape[1]), int(im.shape[2]))
                            if mk is not None and float(mk.max()) < 0.01:
                                mk = _mask_from_preview(mp, int(im.shape[1]), int(im.shape[2])) or mk
                        else:
                            log.warning("[Lazy合并台] 找不到遮罩文件: %s", mrel)
                    if mk is not None and float(mk.max()) > 0.01:
                        has_mask = True
                    _add_tensor_image(im, mk)
                except Exception as e:
                    log.warning("[Lazy合并台] 读图失败 %s: %s", p, e)

        n_img = len(images)
        channel = get_style_channel(style_file, style_name, include_user=True)
        quad_view = channel == "quad_view"
        outpaint = channel == "outpaint"

        if quad_view or outpaint:
            tag = "四视图" if quad_view else "扩图"
            if n_img < 1:
                raise RuntimeError(f"「{tag}」需要 1 张参考图。")
            if n_img > 1:
                log.warning("[Lazy合并台] %s仅用第 1 张参考图。", tag)
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
            pos, ng = apply_style(pr, style_file, style_name, include_user=True)
            styled.append(pos or pr)
            if ng and not neg:
                neg = ng

        first_pos = styled[0] if styled else ""
        model_tag = "K2" if channel == "krea" else ("Qwen" if channel == "qwen" else "")
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
        extra = f" 模型={model_tag}" if model_tag else ""
        info = (
            f"模式={mode} 图={n_img} 提示段={len(styled)} "
            f"风格={style_file}/{style_name}{extra} 遮罩={'有' if has_mask else '无'}"
        )
        log.info("[Lazy合并台] %s", info)
        return (pack, first_pos, mode, info)
