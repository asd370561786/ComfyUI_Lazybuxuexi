"""风格目录：custom_nodes/ComfyUI_Lazybuxuexi_zidingyi。

各工作流分开，不互通。
- krea2/：图风格库和样图。Krea、Qwen、合并台的风格库读这里。
- merge/：合并台自己的自定义风格。
- yue2/：YuE 自己的风格。
节点里的 styles 只在外部还没有对应文件时补一次，不覆盖。
"""
from __future__ import annotations

import os
import shutil
import threading

_PKG_DIR = os.path.dirname(os.path.abspath(__file__))
_ROOT_NAME = "ComfyUI_Lazybuxuexi_zidingyi"
_LOCK = threading.Lock()
_READY = False
_SKIP_LIB = {"yue_user_styles.json", "user_custom.json", "fooocus_styles.json"}


def user_root() -> str:
    return os.path.join(os.path.dirname(_PKG_DIR), _ROOT_NAME)


def yue_dir() -> str:
    return os.path.join(user_root(), "yue2")


def krea_dir() -> str:
    return os.path.join(user_root(), "krea2")


def merge_dir() -> str:
    return os.path.join(user_root(), "merge")


def yue_styles_path() -> str:
    return os.path.join(yue_dir(), "yue_user_styles.json")


def krea_user_file() -> str:
    return os.path.join(krea_dir(), "user_custom.json")


def merge_user_file() -> str:
    return os.path.join(merge_dir(), "user_custom.json")


def krea_samples_dir() -> str:
    return os.path.join(krea_dir(), "samples")


def merge_samples_dir() -> str:
    return os.path.join(merge_dir(), "samples")


def _pkg_styles() -> str:
    return os.path.join(_PKG_DIR, "styles")


def _copy_if_missing(src: str, dst: str) -> None:
    if os.path.isfile(dst) or not os.path.isfile(src):
        return
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src, dst)


def _copy_tree_missing(src_dir: str, dst_dir: str) -> None:
    if not os.path.isdir(src_dir):
        return
    os.makedirs(dst_dir, exist_ok=True)
    for name in os.listdir(src_dir):
        src = os.path.join(src_dir, name)
        dst = os.path.join(dst_dir, name)
        if os.path.isdir(src):
            _copy_tree_missing(src, dst)
        elif os.path.isfile(src) and not os.path.exists(dst):
            shutil.copy2(src, dst)


def _move_if_missing(src: str, dst: str) -> None:
    if not os.path.isfile(src) or os.path.isfile(dst):
        return
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.move(src, dst)


def _seed() -> None:
    os.makedirs(yue_dir(), exist_ok=True)
    os.makedirs(krea_dir(), exist_ok=True)
    os.makedirs(os.path.join(merge_samples_dir(), "custom"), exist_ok=True)
    os.makedirs(krea_samples_dir(), exist_ok=True)

    styles = _pkg_styles()
    _move_if_missing(krea_user_file(), merge_user_file())
    _copy_tree_missing(
        os.path.join(krea_samples_dir(), "custom"),
        os.path.join(merge_samples_dir(), "custom"),
    )
    _copy_if_missing(os.path.join(styles, "yue_user_styles.json"), yue_styles_path())
    _copy_if_missing(os.path.join(styles, "user_custom.json"), merge_user_file())
    _copy_tree_missing(
        os.path.join(styles, "samples", "custom"),
        os.path.join(merge_samples_dir(), "custom"),
    )

    if not os.path.isdir(styles):
        return
    for name in os.listdir(styles):
        if not name.endswith(".json") or name in _SKIP_LIB or name.startswith("yue"):
            continue
        _copy_if_missing(os.path.join(styles, name), os.path.join(krea_dir(), name))
    src_samples = os.path.join(styles, "samples")
    if not os.path.isdir(src_samples):
        return
    dst_samples = krea_samples_dir()
    for name in os.listdir(src_samples):
        if name == "custom":
            continue
        src = os.path.join(src_samples, name)
        dst = os.path.join(dst_samples, name)
        if os.path.isdir(src):
            _copy_tree_missing(src, dst)
        elif os.path.isfile(src) and not os.path.exists(dst):
            shutil.copy2(src, dst)


def ensure_user_store() -> str:
    """没有外部目录就建好，并补齐还没迁过去的风格。已有文件不覆盖。"""
    global _READY
    root = user_root()
    if _READY and os.path.isdir(krea_dir()) and os.path.isdir(yue_dir()):
        return root
    with _LOCK:
        if not (_READY and os.path.isdir(krea_dir()) and os.path.isdir(yue_dir())):
            _seed()
            _READY = True
    return root
