"""图风格库读取。风格文件在外部 krea2 目录，合并台自定义风格单独存放。"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
from functools import lru_cache

log = logging.getLogger(__name__)

_PKG_DIR = os.path.dirname(os.path.abspath(__file__))
_STYLES_DIR = os.path.join(_PKG_DIR, "styles")
_SAMPLES_DIR = os.path.join(_STYLES_DIR, "samples")
_USER_FILE = "user_custom.json"
_USER_SAMPLE_SUB = "custom"

CHANNEL_QUAD = "quad_view"
CHANNEL_OUTPAINT = "outpaint"
CHANNEL_KREA = "krea"
CHANNEL_QWEN = "qwen"
QUAD_STYLE_NAMES = {"四视图", "Quad View", "QuadView", "quad_view", "quadview"}
OUTPAINT_STYLE_NAMES = {"扩图", "Outpaint", "outpaint", "图像扩展"}
_user_lock = threading.Lock()
_user_cache = {"sig": None, "items": None}
_builtin_name_cache = None


def styles_dir() -> str:
    from .lazy_user_store import ensure_user_store, krea_dir

    ensure_user_store()
    d = krea_dir()
    return d if os.path.isdir(d) else ""


def samples_dir() -> str:
    from .lazy_user_store import ensure_user_store, krea_samples_dir

    ensure_user_store()
    d = krea_samples_dir()
    os.makedirs(d, exist_ok=True)
    return d


def _safe_stem(name: str) -> str:
    s = re.sub(r"[^\w\u4e00-\u9fff\-]+", "_", str(name or "").strip(), flags=re.U)
    return s.strip("_") or "style"


@lru_cache(maxsize=1)
def list_style_files() -> tuple:
    d = styles_dir()
    if not d:
        return ("none",)
    names = []
    special = []
    for fn in sorted(os.listdir(d)):
        if not fn.endswith(".json") or fn.endswith(".example"):
            continue
        if fn in ("fooocus_styles.json", _USER_FILE, "yue_user_styles.json"):
            continue
        if fn.startswith("yue"):
            continue
        stem = fn[:-5]
        if stem in ("lazy_styles", "四视图") or stem.startswith("lazy_"):
            special.append(stem)
        else:
            names.append(stem)
    special = sorted(special, key=lambda s: (0 if s == "lazy_styles" else 1, s))
    ordered = special + names
    return ("none",) + tuple(ordered) if ordered else ("none",)


def clear_style_cache():
    global _builtin_name_cache
    _builtin_name_cache = None
    list_style_files.cache_clear()
    load_style_file.cache_clear()
    load_style_meta.cache_clear()


@lru_cache(maxsize=64)
def load_style_file(stem: str) -> tuple:
    meta = load_style_meta(stem)
    return tuple((m["name"], m["prompt"], m["negative_prompt"]) for m in meta)


@lru_cache(maxsize=64)
def load_style_meta(stem: str) -> tuple:
    if not stem or stem == "none":
        return tuple()
    d = styles_dir()
    path = os.path.join(d, stem + ".json")
    if not os.path.isfile(path):
        return tuple()
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        log.warning("[LazyKrea] 读风格失败 %s: %s", path, e)
        return tuple()
    if not isinstance(data, list):
        return tuple()
    out = []
    for item in data:
        if not isinstance(item, dict) or "name" not in item:
            continue
        name = str(item.get("name") or "")
        thumb = item.get("thumbnail") or ""
        if isinstance(thumb, list):
            thumb = thumb[0] if thumb else ""
        thumb = str(thumb or "")
        channel = str(item.get("channel") or "").strip().lower()
        if not channel:
            if name in QUAD_STYLE_NAMES:
                channel = CHANNEL_QUAD
            elif name in OUTPAINT_STYLE_NAMES:
                channel = CHANNEL_OUTPAINT
        out.append({
            "name": name,
            "name_cn": str(item.get("name_cn") or name),
            "prompt": str(item.get("prompt") or ""),
            "negative_prompt": str(item.get("negative_prompt") or ""),
            "thumbnail": thumb,
            "channel": channel,
        })
    return tuple(out)


def style_name_choices(stem: str) -> list:
    items = load_style_file(stem)
    return ["none"] + [x[0] for x in items if x[0]]


_USER_MARK = "user:"


def marked_user_name(style_name: str):
    """自定义风格选择值。None 表示不是自定义标记。"""
    text = str(style_name or "")
    if text.startswith(_USER_MARK):
        return text[len(_USER_MARK):]
    return None


def get_style_channel(style_file: str, style_name: str, include_user: bool = False) -> str:
    if not style_name or style_name == "none":
        return ""
    marked = marked_user_name(style_name)
    if marked is not None:
        if not include_user or not marked or marked == "none":
            return ""
        user = find_user_style(marked)
        return str(user.get("channel") or "") if user else ""
    if style_name in QUAD_STYLE_NAMES:
        return CHANNEL_QUAD
    if style_name in OUTPAINT_STYLE_NAMES:
        return CHANNEL_OUTPAINT
    if style_file and style_file != "none":
        for m in load_style_meta(style_file):
            if m["name"] == style_name:
                ch = (m.get("channel") or "").strip().lower()
                if ch in (CHANNEL_QUAD, CHANNEL_OUTPAINT):
                    return ch
                if m["name"] in QUAD_STYLE_NAMES:
                    return CHANNEL_QUAD
                if m["name"] in OUTPAINT_STYLE_NAMES:
                    return CHANNEL_OUTPAINT
                return ch
    if include_user:
        user = find_user_style(style_name)
        if user:
            return str(user.get("channel") or "")
    return ""


def is_quad_view_style(style_file: str, style_name: str) -> bool:
    return get_style_channel(style_file, style_name) == CHANNEL_QUAD


def is_outpaint_style(style_file: str, style_name: str) -> bool:
    return get_style_channel(style_file, style_name) == CHANNEL_OUTPAINT


def _sample_dirs() -> list:
    dirs = []
    try:
        from .lazy_user_store import krea_samples_dir, merge_samples_dir

        for folder in (merge_samples_dir(), krea_samples_dir()):
            if folder and os.path.isdir(folder) and folder not in dirs:
                dirs.append(folder)
    except Exception:
        pass
    sd = samples_dir()
    if sd and sd not in dirs:
        dirs.append(sd)
    pkg = _SAMPLES_DIR if os.path.isdir(_SAMPLES_DIR) else ""
    if pkg and pkg not in dirs:
        dirs.append(pkg)
    return dirs


def _find_local_sample(style_name: str, thumb: str = "") -> str:
    search_dirs = _sample_dirs()
    candidates = []
    thumb = str(thumb or "").replace("\\", "/").strip()
    if thumb and not thumb.startswith("http"):
        rel = thumb.lstrip("/")
        if rel.startswith("samples/"):
            rel = rel[len("samples/") :]
        candidates.append(rel)
        candidates.append(os.path.basename(rel))
    if style_name:
        raw = str(style_name).strip()
        candidates.append(raw)
        candidates.append(raw.replace(" ", "_"))
        candidates.append(_safe_stem(raw))
        candidates.append(raw.replace("/", "_").replace(":", "_").replace("!", ""))
    seen = set()
    for base in candidates:
        if not base or base in seen:
            continue
        seen.add(base)
        root, ext = os.path.splitext(base)
        if ext.lower() in (".jpg", ".jpeg", ".png", ".webp"):
            for sd in search_dirs:
                p = os.path.join(sd, base)
                if os.path.isfile(p):
                    return base
            base = root
        for e in (".jpg", ".jpeg", ".png", ".webp"):
            fn = base + e
            for sd in search_dirs:
                p = os.path.join(sd, fn)
                if os.path.isfile(p):
                    return fn
    return ""


def resolve_thumbnail_url(thumb: str, style_name: str = "") -> str:
    thumb = str(thumb or "").strip()
    if thumb.startswith("/lazy_krea/styles/image"):
        return thumb
    fn = _find_local_sample(style_name, thumb)
    if fn:
        from urllib.parse import quote

        return f"/lazy_krea/styles/image?file={quote(fn)}"
    return ""


def apply_style(user_prompt: str, style_file: str, style_name: str, include_user: bool = False) -> tuple[str, str]:
    user_prompt = (user_prompt or "").strip()
    if not style_name or style_name == "none":
        return user_prompt, ""
    found = None
    marked = marked_user_name(style_name)
    if marked is not None:
        if not include_user:
            return user_prompt, ""
        style_name = marked
        if not style_name or style_name == "none":
            return user_prompt, ""
    elif style_file and style_file != "none":
        items = {n: (p, ng) for n, p, ng in load_style_file(style_file)}
        if style_name in items:
            found = items[style_name]
    if found is None and include_user:
        user = find_user_style(style_name)
        if user:
            found = (user.get("prompt") or "", user.get("negative_prompt") or "")
    if found is None:
        return user_prompt, ""
    tmpl, neg = found
    if "{prompt}" in tmpl:
        pos = tmpl.replace("{prompt}", user_prompt)
    elif user_prompt:
        pos = f"{tmpl}, {user_prompt}" if tmpl else user_prompt
    else:
        pos = tmpl
    return pos.strip(), (neg or "").strip()


def _user_styles_path() -> str:
    from .lazy_user_store import ensure_user_store, merge_user_file

    ensure_user_store()
    return merge_user_file()


def _user_sig():
    path = _user_styles_path()
    try:
        st = os.stat(path)
        return (getattr(st, "st_mtime_ns", st.st_mtime), st.st_size)
    except Exception:
        return None


def _norm_model(channel: str) -> str:
    c = str(channel or "").strip().lower()
    if c in ("k2", "krea", "krea2"):
        return CHANNEL_KREA
    if c in ("qwen", "qwen2", "qwen2.1"):
        return CHANNEL_QWEN
    raise ValueError("请选择模型")


def _normalize_user_item(item):
    if not isinstance(item, dict):
        return None
    name = str(item.get("name") or "").strip()
    if not name or name.lower() == "none":
        return None
    ch = str(item.get("channel") or "").strip().lower()
    if ch in ("k2", "krea2"):
        ch = CHANNEL_KREA
    if ch in ("qwen2", "qwen2.1"):
        ch = CHANNEL_QWEN
    if ch not in (CHANNEL_KREA, CHANNEL_QWEN):
        return None
    return {
        "name": name,
        "name_cn": name,
        "prompt": str(item.get("prompt") or ""),
        "negative_prompt": str(item.get("negative_prompt") or ""),
        "thumbnail": str(item.get("thumbnail") or "").replace("\\", "/"),
        "channel": ch,
        "custom": True,
    }


def _load_user_styles_unlocked() -> list:
    sig = _user_sig()
    cached = _user_cache.get("items")
    if cached is not None and _user_cache.get("sig") == sig:
        return [dict(x) for x in cached]
    path = _user_styles_path()
    items = []
    if sig is not None and os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            log.warning("[LazyKrea] 读自定义风格失败: %s", e)
            data = []
        if isinstance(data, list):
            for raw in data:
                one = _normalize_user_item(raw)
                if one:
                    items.append(one)
    _user_cache["sig"] = sig
    _user_cache["items"] = items
    return [dict(x) for x in items]


def load_user_styles() -> list:
    with _user_lock:
        return _load_user_styles_unlocked()


def find_user_style(name: str):
    name = str(name or "")
    if not name:
        return None
    for item in load_user_styles():
        if item.get("name") == name:
            return item
    return None


def _builtin_style_names() -> set:
    global _builtin_name_cache
    if _builtin_name_cache is not None:
        return _builtin_name_cache
    names = set()
    for stem in list_style_files():
        if not stem or stem == "none":
            continue
        for meta in load_style_meta(stem):
            if meta.get("name"):
                names.add(meta["name"])
    _builtin_name_cache = names
    return names


def _write_user_styles_unlocked(items: list) -> None:
    path = _user_styles_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    payload = []
    for raw in items:
        one = _normalize_user_item(raw)
        if one:
            payload.append(one)
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)
    _user_cache["sig"] = None
    _user_cache["items"] = None


def _user_samples_dir() -> str:
    from .lazy_user_store import ensure_user_store, merge_samples_dir

    ensure_user_store()
    return merge_samples_dir()


def _preview_path(rel: str) -> str:
    rel = str(rel or "").replace("\\", "/").lstrip("/")
    if not rel.startswith(_USER_SAMPLE_SUB + "/") or ".." in rel.split("/"):
        return ""
    root = os.path.abspath(os.path.join(_user_samples_dir(), _USER_SAMPLE_SUB))
    path = os.path.abspath(os.path.join(_user_samples_dir(), rel))
    if path != root and not path.startswith(root + os.sep):
        return ""
    return path


def _delete_preview(rel: str) -> None:
    path = _preview_path(rel)
    if not path:
        return
    try:
        if os.path.isfile(path):
            os.remove(path)
    except Exception as e:
        log.warning("[LazyKrea] 删除预览图失败 %s: %s", rel, e)


def _save_preview(data: bytes) -> str:
    if not data or len(data) > 12 * 1024 * 1024:
        raise ValueError("预览图无效")
    try:
        import io
        import uuid
        from PIL import Image

        im = Image.open(io.BytesIO(data))
        im.load()
        if im.mode == "RGBA":
            bg = Image.new("RGB", im.size, (17, 17, 17))
            bg.paste(im, mask=im.split()[-1])
            im = bg
        else:
            im = im.convert("RGB")
        im.thumbnail((512, 512))
        folder = os.path.join(_user_samples_dir(), _USER_SAMPLE_SUB)
        os.makedirs(folder, exist_ok=True)
        fn = uuid.uuid4().hex + ".jpg"
        im.save(os.path.join(folder, fn), "JPEG", quality=85)
        return f"{_USER_SAMPLE_SUB}/{fn}"
    except ValueError:
        raise
    except Exception as e:
        raise ValueError("预览图无法识别") from e


def save_user_style(name: str, prompt: str, channel: str, old_name: str = "", image_bytes=None) -> dict:
    """新增或更新自定义风格。image_bytes 为空则保留原预览图。"""
    name = str(name or "").strip()
    old_name = str(old_name or "").strip()
    prompt = str(prompt or "")
    if not name or name.lower() == "none":
        raise ValueError("请填写名字")
    if "\0" in name:
        raise ValueError("名字无效")
    channel = _norm_model(channel)

    new_thumb = _save_preview(image_bytes) if image_bytes else ""
    item = None
    try:
        with _user_lock:
            items = _load_user_styles_unlocked()
            old = None
            if old_name:
                for it in items:
                    if it.get("name") == old_name:
                        old = it
                        break
                if old is None:
                    raise ValueError("找不到该风格")
            for it in items:
                if it.get("name") == name and name != old_name:
                    raise ValueError("这个名字已经存在")
            thumb = new_thumb or ((old.get("thumbnail") if old else "") or "")
            item = {
                "name": name,
                "name_cn": name,
                "prompt": prompt,
                "negative_prompt": "",
                "thumbnail": thumb,
                "channel": channel,
                "custom": True,
            }
            new_items = []
            replaced = False
            key = old_name or name
            for it in items:
                if not replaced and it.get("name") == key:
                    new_items.append(item)
                    replaced = True
                else:
                    new_items.append(dict(it))
            if not replaced:
                if old_name:
                    raise ValueError("找不到该风格")
                new_items.append(item)
            _write_user_styles_unlocked(new_items)
    except Exception:
        if new_thumb:
            _delete_preview(new_thumb)
        raise
    if new_thumb and old and old.get("thumbnail") and old.get("thumbnail") != new_thumb:
        _delete_preview(old.get("thumbnail") or "")
    return dict(item)


def remove_user_style(name: str) -> None:
    name = str(name or "").strip()
    if not name:
        raise ValueError("请填写名字")
    removed = None
    with _user_lock:
        items = _load_user_styles_unlocked()
        kept = []
        for it in items:
            if removed is None and it.get("name") == name:
                removed = it
            else:
                kept.append(it)
        if removed is None:
            raise ValueError("找不到该风格")
        _write_user_styles_unlocked(kept)
    _delete_preview((removed or {}).get("thumbnail") or "")
