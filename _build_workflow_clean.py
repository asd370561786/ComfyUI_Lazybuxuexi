# -*- coding: utf-8 -*-
"""生成一份干净、可直接加载的 Lazy Wan 逐段工作流（匹配当前节点接口）。"""
from __future__ import annotations

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))

NEGATIVE = (
    "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，"
    "整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，"
    "画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，"
    "静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走"
)

# 三段测试时间线（可在导演台里换成你的图）
SEG_LEN = 49  # 4n+1
N_SEG = 3
TOTAL = SEG_LEN * N_SEG  # 147
FPS = 16.0
DUR_SEC = TOTAL / FPS  # 9.1875

timeline = {
    "segments": [
        {
            "id": "seg1",
            "start": 0,
            "length": SEG_LEN,
            "prompt": "自然运动，镜头缓慢推进，细微表情",
            "type": "image",
            "imageFile": "分镜_00001_.png",
            "guideStrength": 1.0,
            "isEndFrame": False,
            "transitionToNext": "flf",
        },
        {
            "id": "seg2",
            "start": SEG_LEN,
            "length": SEG_LEN,
            "prompt": "动作延续，光影变化，人物转向",
            "type": "image",
            "imageFile": "分镜_00002_.png",
            "guideStrength": 1.0,
            "isEndFrame": False,
            "transitionToNext": "cut",
        },
        {
            "id": "seg3",
            "start": SEG_LEN * 2,
            "length": SEG_LEN,
            "prompt": "收尾，平稳结束，自然停顿",
            "type": "image",
            "imageFile": "分镜_00021_.png",
            "guideStrength": 1.0,
            "isEndFrame": False,
            "transitionToNext": "flf",
        },
    ],
    "audioSegments": [],
    "motionSegments": [],
    "global_prompt": "cinematic video, natural motion, high quality, detailed face, smooth camera",
    "mainTrackEnabled": True,
    "audioTrackEnabled": False,
    "motionTrackEnabled": False,
}

local_prompts = " | ".join(s["prompt"] for s in timeline["segments"])
segment_lengths = ",".join(str(SEG_LEN) for _ in range(N_SEG))
guide_strength = ",".join("1.00" for _ in range(N_SEG))

# 导演台 widgets：按 js SCHEMA_WAN_20 字段名顺序
director_widgets = [
    TOTAL,  # duration_frames
    0,  # start_frame
    TOTAL,  # end_frame
    0.0,  # start_second
    DUR_SEC,  # end_second
    DUR_SEC,  # duration_seconds
    0.001,  # epsilon
    json.dumps(timeline, ensure_ascii=False),  # timeline_data
    local_prompts,  # local_prompts
    segment_lengths,  # segment_lengths
    guide_strength,  # guide_strength
    832,  # custom_width
    480,  # custom_height
    FPS,  # frame_rate
    NEGATIVE,  # negative_prompt
    "maintain aspect ratio",  # resize_method
    16,  # divisible_by
    0,  # img_compression
    "seconds",  # display_mode
    "",  # transition_smoothness
]

# 逐段采样器 widgets（中文 INPUT_TYPES 顺序）
# 种子, control_after_generate, 高噪声步数, 低噪声步数, CFG, 采样器, 调度器, Shift,
# 低噪声CFG, 负向提示词, 全局提示词覆盖, 宽度, 高度, 每段递增种子, 首尾帧去重, 文字续接末帧
sampler_widgets = [
    42, "fixed",
    4, 4, 1.0, "euler", "simple", 8.0,
    1.0,
    "",
    "",
    0, 0,
    True, True, True,
]

nodes = [
    {
        "id": 1,
        "type": "UNETLoader",
        "pos": [40, 40],
        "size": [480, 82],
        "flags": {},
        "order": 0,
        "mode": 0,
        "inputs": [],
        "outputs": [{"name": "MODEL", "type": "MODEL", "slot_index": 0, "links": [1]}],
        "title": "高噪声 UNET (high_lighting)",
        "properties": {"Node name for S&R": "UNETLoader"},
        "widgets_values": [
            "Animate\\Wan2.2_Remix_NSFW_i2v_14b_high_lighting_fp8_e4m3fn_v3.0.safetensors",
            "default",
        ],
        "color": "#223",
        "bgcolor": "#335",
    },
    {
        "id": 2,
        "type": "UNETLoader",
        "pos": [40, 160],
        "size": [480, 82],
        "flags": {},
        "order": 1,
        "mode": 0,
        "inputs": [],
        "outputs": [{"name": "MODEL", "type": "MODEL", "slot_index": 0, "links": [2]}],
        "title": "低噪声 UNET (low_lighting)",
        "properties": {"Node name for S&R": "UNETLoader"},
        "widgets_values": [
            "Animate\\Wan2.2_Remix_NSFW_i2v_14b_low_lighting_fp8_e4m3fn_v3.0.safetensors",
            "default",
        ],
        "color": "#232",
        "bgcolor": "#353",
    },
    {
        "id": 3,
        "type": "CLIPLoader",
        "pos": [40, 280],
        "size": [480, 106],
        "flags": {},
        "order": 2,
        "mode": 0,
        "inputs": [],
        "outputs": [{"name": "CLIP", "type": "CLIP", "slot_index": 0, "links": [3, 6]}],
        "title": "CLIP 文本编码 (wan)",
        "properties": {"Node name for S&R": "CLIPLoader"},
        "widgets_values": ["nsfw_wan_umt5-xxl_bf16_fixed.safetensors", "wan", "default"],
        "color": "#323",
        "bgcolor": "#535",
    },
    {
        "id": 4,
        "type": "VAELoader",
        "pos": [40, 420],
        "size": [480, 58],
        "flags": {},
        "order": 3,
        "mode": 0,
        "inputs": [],
        "outputs": [{"name": "VAE", "type": "VAE", "slot_index": 0, "links": [7]}],
        "title": "VAE wan_2.1",
        "properties": {"Node name for S&R": "VAELoader"},
        "widgets_values": ["wan_2.1_vae.safetensors"],
        "color": "#323",
        "bgcolor": "#535",
    },
    {
        "id": 5,
        "type": "WanRemixDirector",
        "pos": [560, 40],
        "size": [920, 620],
        "flags": {},
        "order": 4,
        "mode": 0,
        "inputs": [
            {"name": "model_high_noise", "type": "MODEL", "link": 1},
            {"name": "model_low_noise", "type": "MODEL", "link": 2},
            {"name": "clip", "type": "CLIP", "link": 3},
            {"name": "optional_latent", "type": "LATENT", "link": None, "shape": 7},
            {"name": "global_prompt", "type": "STRING", "link": None, "shape": 7},
        ],
        "outputs": [
            {"name": "高噪声模型", "type": "MODEL", "links": [4], "slot_index": 0},
            {"name": "低噪声模型", "type": "MODEL", "links": [5], "slot_index": 1},
            {"name": "正向条件", "type": "CONDITIONING", "links": None, "slot_index": 2},
            {"name": "负向条件", "type": "CONDITIONING", "links": None, "slot_index": 3},
            {"name": "视频潜空间", "type": "LATENT", "links": None, "slot_index": 4},
            {"name": "关键帧数据", "type": "GUIDE_DATA", "links": [8], "slot_index": 5},
            {"name": "帧率", "type": "FLOAT", "links": [11], "slot_index": 6},
            {"name": "帧数", "type": "INT", "links": None, "slot_index": 7},
            {"name": "宽度", "type": "INT", "links": None, "slot_index": 8},
            {"name": "高度", "type": "INT", "links": None, "slot_index": 9},
        ],
        "title": "Lazy Wan2.2 Remix 导演台",
        "properties": {
            "Node name for S&R": "WanRemixDirector",
            "cnr_id": "ComfyUI_Lazy_Wan_Remix",
        },
        "widgets_values": director_widgets,
        "color": "#223",
        "bgcolor": "#335",
    },
    {
        "id": 6,
        "type": "WanRemixSequentialI2V",
        "pos": [1540, 40],
        "size": [400, 520],
        "flags": {},
        "order": 5,
        "mode": 0,
        "inputs": [
            {"name": "高噪声模型", "type": "MODEL", "link": 4},
            {"name": "低噪声模型", "type": "MODEL", "link": 5},
            {"name": "文本编码", "type": "CLIP", "link": 6},
            {"name": "VAE", "type": "VAE", "link": 7},
            {"name": "关键帧数据", "type": "GUIDE_DATA", "link": 8},
        ],
        "outputs": [
            {"name": "视频片段包", "type": "WAN_VIDEO_CLIPS", "links": [9], "slot_index": 0},
            {"name": "运行信息", "type": "STRING", "links": None, "slot_index": 1},
        ],
        "title": "Lazy Wan2.2 Remix 逐段生成（每段独立 MoE）",
        "properties": {
            "Node name for S&R": "WanRemixSequentialI2V",
            "cnr_id": "ComfyUI_Lazy_Wan_Remix",
        },
        "widgets_values": sampler_widgets,
        "color": "#322",
        "bgcolor": "#533",
    },
    {
        "id": 7,
        "type": "WanRemixMergeClips",
        "pos": [2000, 40],
        "size": [300, 100],
        "flags": {},
        "order": 6,
        "mode": 0,
        "inputs": [
            {"name": "视频片段包", "type": "WAN_VIDEO_CLIPS", "link": 9},
        ],
        "outputs": [
            {"name": "合并视频", "type": "IMAGE", "links": [10], "slot_index": 0},
            {"name": "总帧数", "type": "INT", "links": None, "slot_index": 1},
            {"name": "帧率", "type": "FLOAT", "links": None, "slot_index": 2},
        ],
        "title": "Lazy 视频段拼合",
        "properties": {
            "Node name for S&R": "WanRemixMergeClips",
            "cnr_id": "ComfyUI_Lazy_Wan_Remix",
        },
        "widgets_values": [0],
        "color": "#223",
        "bgcolor": "#335",
    },
    {
        "id": 8,
        "type": "VHS_VideoCombine",
        "pos": [2360, 40],
        "size": [320, 420],
        "flags": {},
        "order": 7,
        "mode": 0,
        "inputs": [
            {"name": "images", "type": "IMAGE", "link": 10},
            {"name": "audio", "type": "AUDIO", "link": None, "shape": 7},
            {"name": "meta_batch", "type": "VHS_BatchManager", "link": None, "shape": 7},
            {"name": "vae", "type": "VAE", "link": None, "shape": 7},
            {"name": "frame_rate", "type": "FLOAT", "widget": {"name": "frame_rate"}, "link": 11},
        ],
        "outputs": [
            {"name": "Filenames", "type": "VHS_FILENAMES", "links": None},
        ],
        "title": "导出 MP4",
        "properties": {"Node name for S&R": "VHS_VideoCombine"},
        "widgets_values": {
            "frame_rate": 16,
            "loop_count": 0,
            "filename_prefix": "Lazy/WanRemix_sequential",
            "format": "video/h264-mp4",
            "pix_fmt": "yuv420p",
            "crf": 19,
            "save_metadata": True,
            "trim_to_audio": False,
            "pingpong": False,
            "save_output": True,
        },
        "color": "#232",
        "bgcolor": "#353",
    },
    {
        "id": 9,
        "type": "Note",
        "pos": [1540, 600],
        "size": [460, 260],
        "flags": {},
        "order": 8,
        "mode": 0,
        "inputs": [],
        "outputs": [],
        "properties": {},
        "widgets_values": [
            "【Lazy Wan Remix 逐段工作流 · 干净版】\n"
            "\n"
            "接线：\n"
            "1. 高/低噪声 UNET + CLIP + VAE\n"
            "2. → 导演台（时间线放图/写提示词）\n"
            "3. → 逐段生成（每段独立 high→low）\n"
            "4. → 视频段拼合 → 导出 MP4\n"
            "\n"
            "采样默认（与官方图生视频一致）：\n"
            "高步4 + 低步4 / CFG1 / euler / simple / Shift8\n"
            "\n"
            "使用：在导演台替换图片与提示词后 Queue。\n"
            "若采样器误显示 simple，请改为 euler。"
        ],
        "color": "#432",
        "bgcolor": "#653",
    },
]

# links: [id, from_node, from_slot, to_node, to_slot, type]
links = [
    [1, 1, 0, 5, 0, "MODEL"],
    [2, 2, 0, 5, 1, "MODEL"],
    [3, 3, 0, 5, 2, "CLIP"],
    [4, 5, 0, 6, 0, "MODEL"],
    [5, 5, 1, 6, 1, "MODEL"],
    [6, 3, 0, 6, 2, "CLIP"],
    [7, 4, 0, 6, 3, "VAE"],
    [8, 5, 5, 6, 4, "GUIDE_DATA"],
    [9, 6, 0, 7, 0, "WAN_VIDEO_CLIPS"],
    [10, 7, 0, 8, 0, "IMAGE"],
    [11, 5, 6, 8, 4, "FLOAT"],
]

workflow = {
    "id": "lazy-wan-remix-sequential-clean-v1",
    "revision": 1,
    "last_node_id": 9,
    "last_link_id": 11,
    "nodes": nodes,
    "links": links,
    "groups": [
        {
            "id": 1,
            "title": "1. 加载模型",
            "bounding": [20, 0, 520, 520],
            "color": "#3f789e",
            "font_size": 24,
            "flags": {},
        },
        {
            "id": 2,
            "title": "2. 导演台时间线",
            "bounding": [540, 0, 960, 700],
            "color": "#3f789e",
            "font_size": 24,
            "flags": {},
        },
        {
            "id": 3,
            "title": "3. 逐段采样 → 拼合 → 导出",
            "bounding": [1520, 0, 1200, 520],
            "color": "#a1309b",
            "font_size": 24,
            "flags": {},
        },
    ],
    "config": {},
    "extra": {
        "info": {
            "name": "Lazy Wan Remix 逐段生成（干净版）",
            "author": "Lazy",
            "description": (
                "导演台 → 逐段 MoE 采样(4+4/euler/simple/shift8) → 拼合 → MP4。"
                "匹配 ComfyUI_Lazy_Wan_Remix 当前接口。"
            ),
            "version": "1.0",
        },
        "ds": {"scale": 0.75, "offset": [0, 0]},
    },
    "version": 0.4,
}

out_paths = [
    os.path.join(HERE, "example_workflows", "Lazy_Wan_Remix_逐段生成_干净版.json"),
    os.path.join(
        os.path.expanduser("~"),
        "Documents",
        "ComfyUI",
        "user",
        "default",
        "workflows",
        "Lazy_Wan_Remix_逐段生成_干净版.json",
    ),
    # 覆盖旧测试流，避免用户继续打开错误版本
    os.path.join(HERE, "example_workflows", "Lazy_Wan_Remix_逐段生成_测试.json"),
    os.path.join(
        os.path.expanduser("~"),
        "Documents",
        "ComfyUI",
        "user",
        "default",
        "workflows",
        "Lazy_导演台_逐段生成_测试.json",
    ),
]

text = json.dumps(workflow, ensure_ascii=False, indent=2)
for p in out_paths:
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(text)
    print("wrote", p)

print("done. sampler defaults: 4+4 / CFG1 / euler / simple / shift8")
