"""
Lazy 提示词：多行文本按行输出。
行为对齐常用「提示词行」，不依赖外部节点包。
"""
from __future__ import annotations


class LazyPromptLine:
    """多行提示词。默认不填内容。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "提示词": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "tooltip": "提示词。",
                }),
                "起始索引": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 9999,
                    "tooltip": "起始索引。",
                }),
                "最大行数": ("INT", {
                    "default": 1000,
                    "min": 1,
                    "max": 9999,
                    "tooltip": "最大行数。",
                }),
                "去除空行": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "去除空行。",
                }),
            },
        }

    RETURN_TYPES = ("STRING", "COMBO")
    RETURN_NAMES = ("字符串", "COMBO")
    OUTPUT_IS_LIST = (True, True)
    FUNCTION = "run"
    CATEGORY = "Lazy"
    DESCRIPTION = "Lazy 提示词"

    def run(self, 提示词="", 起始索引=0, 最大行数=1000, 去除空行=False):
        text = 提示词 if isinstance(提示词, str) else ("" if 提示词 is None else str(提示词))
        lines = text.split("\n")
        if 去除空行:
            lines = [line for line in lines if line.strip()]
        if not lines:
            rows = [""]
        else:
            start = max(0, min(int(起始索引), len(lines) - 1))
            end = min(start + max(1, int(最大行数)), len(lines))
            rows = lines[start:end] or [""]
        return (rows, rows)
