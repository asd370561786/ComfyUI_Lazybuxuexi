# -*- coding: utf-8 -*-
"""生成「导演台 + 逐段生成 + 拼合」省显存测试工作流。"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
out_paths = [
    os.path.join(HERE, "example_workflows", "Lazy_Wan_Remix_逐段生成_测试.json"),
    os.path.join(HERE, "example_workflows", "Wan_Remix_Director_Sequential_Test.json"),
    os.path.join(HERE, "Wan_Remix_Director_Sequential_Infinite.json"),
    os.path.join(HERE, "example_workflows", "Wan_Remix_Director_Sequential_Infinite.json"),
]
os.makedirs(os.path.join(HERE, "example_workflows"), exist_ok=True)

negative = (
    "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，"
    "整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，"
    "画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，"
    "静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走"
)

# 测试时间线：
# 图1 ⇄ 图2（首尾帧）→ 图2 ✕ 图3（硬切）→ 图3
# 请在导演台里换成你自己的图片（input 目录下的文件名）
local_prompt = "自然运动，镜头缓慢推进 | 动作延续，光影变化 | 收尾，平稳结束"
timeline = {
    "segments": [
        {
            "id": "img1",
            "start": 0,
            "length": 49,
            "prompt": "自然运动，镜头缓慢推进",
            "type": "image",
            "imageFile": "example.png",
            "guideStrength": 1.0,
            "isEndFrame": False,
            "transitionToNext": "flf",
        },
        {
            "id": "img2",
            "start": 49,
            "length": 49,
            "prompt": "动作延续，光影变化",
            "type": "image",
            "imageFile": "example.png",
            "guideStrength": 1.0,
            "isEndFrame": False,
            "transitionToNext": "cut",
        },
        {
            "id": "img3",
            "start": 98,
            "length": 49,
            "prompt": "收尾，平稳结束",
            "type": "image",
            "imageFile": "example.png",
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

# SCHEMA_WAN_20（已去掉音频/参考视频 5 个布尔控件）
director_widgets = [
    147,  # duration_frames = 3*49
    0,
    147,
    0.0,
    9.1875,
    9.1875,
    0.001,
    json.dumps(timeline, ensure_ascii=False),
    local_prompt,
    "49,49,49",
    "1.00,1.00,1.00",
    832,
    480,
    16.0,
    negative,
    "maintain aspect ratio",
    16,
    0,
    "seconds",
    "",  # transition_smoothness
]

nodes = []
links = []
link_id = 1


def add_link(fn, fs, tn, ts, typ):
    global link_id
    lid = link_id
    link_id += 1
    links.append([lid, fn, fs, tn, ts, typ])
    return lid


def wire(by_id, from_id, from_slot, to_id, to_slot, typ):
    lid = add_link(from_id, from_slot, to_id, to_slot, typ)
    src = by_id[from_id]
    dst = by_id[to_id]
    # output links
    outs = src.get("outputs") or []
    if from_slot < len(outs):
        if outs[from_slot].get("links") is None:
            outs[from_slot]["links"] = []
        outs[from_slot]["links"].append(lid)
        outs[from_slot]["slot_index"] = from_slot
    # input link
    ins = dst.get("inputs") or []
    if to_slot < len(ins):
        ins[to_slot]["link"] = lid
    return lid


HIGH = "Animate\\Wan2.2_Remix_NSFW_i2v_14b_high_lighting_fp8_e4m3fn_v3.0.safetensors"
LOW = "Animate\\Wan2.2_Remix_NSFW_i2v_14b_low_lighting_fp8_e4m3fn_v3.0.safetensors"
CLIP = "umt5_xxl_fp8_e4m3fn_scaled.safetensors"
VAE = "wan_2.1_vae.safetensors"

# --- Nodes ---
nodes.append({
    "id": 1,
    "type": "UNETLoader",
    "pos": [40, 40],
    "size": [460, 82],
    "flags": {},
    "order": 0,
    "mode": 0,
    "inputs": [
        {"name": "unet_name", "type": "COMBO", "widget": {"name": "unet_name"}, "link": None},
        {"name": "weight_dtype", "type": "COMBO", "widget": {"name": "weight_dtype"}, "link": None},
    ],
    "outputs": [{"name": "MODEL", "type": "MODEL", "slot_index": 0, "links": []}],
    "title": "UNET 高噪声 high_lighting",
    "properties": {"Node name for S&R": "UNETLoader"},
    "widgets_values": [HIGH, "default"],
    "color": "#223",
    "bgcolor": "#335",
})

nodes.append({
    "id": 2,
    "type": "UNETLoader",
    "pos": [40, 160],
    "size": [460, 82],
    "flags": {},
    "order": 1,
    "mode": 0,
    "inputs": [
        {"name": "unet_name", "type": "COMBO", "widget": {"name": "unet_name"}, "link": None},
        {"name": "weight_dtype", "type": "COMBO", "widget": {"name": "weight_dtype"}, "link": None},
    ],
    "outputs": [{"name": "MODEL", "type": "MODEL", "slot_index": 0, "links": []}],
    "title": "UNET 低噪声 low_lighting",
    "properties": {"Node name for S&R": "UNETLoader"},
    "widgets_values": [LOW, "default"],
    "color": "#232",
    "bgcolor": "#353",
})

nodes.append({
    "id": 3,
    "type": "CLIPLoader",
    "pos": [40, 280],
    "size": [460, 106],
    "flags": {},
    "order": 2,
    "mode": 0,
    "inputs": [
        {"name": "clip_name", "type": "COMBO", "widget": {"name": "clip_name"}, "link": None},
        {"name": "type", "type": "COMBO", "widget": {"name": "type"}, "link": None},
        {"name": "device", "type": "COMBO", "widget": {"name": "device"}, "link": None},
    ],
    "outputs": [{"name": "CLIP", "type": "CLIP", "slot_index": 0, "links": []}],
    "title": "CLIP wan (UMT5)",
    "properties": {"Node name for S&R": "CLIPLoader"},
    "widgets_values": [CLIP, "wan", "default"],
})

nodes.append({
    "id": 4,
    "type": "VAELoader",
    "pos": [40, 420],
    "size": [460, 58],
    "flags": {},
    "order": 3,
    "mode": 0,
    "inputs": [
        {"name": "vae_name", "type": "COMBO", "widget": {"name": "vae_name"}, "link": None},
    ],
    "outputs": [{"name": "VAE", "type": "VAE", "slot_index": 0, "links": []}],
    "title": "VAE wan_2.1",
    "properties": {"Node name for S&R": "VAELoader"},
    "widgets_values": [VAE],
})

# Director
dir_outputs = [
    {"name": "model_high", "type": "MODEL", "links": [], "slot_index": 0},
    {"name": "model_low", "type": "MODEL", "links": [], "slot_index": 1},
    {"name": "positive", "type": "CONDITIONING", "links": [], "slot_index": 2},
    {"name": "negative", "type": "CONDITIONING", "links": [], "slot_index": 3},
    {"name": "latent", "type": "LATENT", "links": [], "slot_index": 4},
    {"name": "guide_data", "type": "GUIDE_DATA", "links": [], "slot_index": 5},
    {"name": "frame_rate", "type": "FLOAT", "links": [], "slot_index": 6},
    {"name": "length", "type": "INT", "links": [], "slot_index": 7},
    {"name": "width", "type": "INT", "links": [], "slot_index": 8},
    {"name": "height", "type": "INT", "links": [], "slot_index": 9},
]

nodes.append({
    "id": 5,
    "type": "WanRemixDirector",
    "pos": [560, 40],
    "size": [900, 700],
    "flags": {},
    "order": 4,
    "mode": 0,
    "inputs": [
        {"name": "model_high_noise", "type": "MODEL", "link": None},
        {"name": "model_low_noise", "type": "MODEL", "link": None},
        {"name": "clip", "type": "CLIP", "link": None},
        {"name": "optional_latent", "type": "LATENT", "link": None, "shape": 7},
        {"name": "global_prompt", "type": "STRING", "link": None, "shape": 7, "widget": {"name": "global_prompt"}},
    ],
    "outputs": dir_outputs,
    "title": "Lazy Wan2.2 Remix 导演台（时间线）",
    "properties": {
        "Node name for S&R": "WanRemixDirector",
        "cnr_id": "ceshi",
    },
    "widgets_values": director_widgets,
})

# Sequential I2V
nodes.append({
    "id": 6,
    "type": "WanRemixSequentialI2V",
    "pos": [1520, 40],
    "size": [380, 460],
    "flags": {},
    "order": 5,
    "mode": 0,
    "inputs": [
        {"name": "model_high_noise", "type": "MODEL", "link": None},
        {"name": "model_low_noise", "type": "MODEL", "link": None},
        {"name": "clip", "type": "CLIP", "link": None},
        {"name": "vae", "type": "VAE", "link": None},
        {"name": "guide_data", "type": "GUIDE_DATA", "link": None},
        {"name": "seed", "type": "INT", "widget": {"name": "seed"}, "link": None},
        {"name": "steps", "type": "INT", "widget": {"name": "steps"}, "link": None},
        {"name": "cfg", "type": "FLOAT", "widget": {"name": "cfg"}, "link": None},
        {"name": "sampler_name", "type": "COMBO", "widget": {"name": "sampler_name"}, "link": None},
        {"name": "scheduler", "type": "COMBO", "widget": {"name": "scheduler"}, "link": None},
    ],
    "outputs": [
        {"name": "视频片段包", "type": "WAN_VIDEO_CLIPS", "links": [], "slot_index": 0},
        {"name": "运行信息", "type": "STRING", "links": [], "slot_index": 1},
    ],
    "title": "Lazy Wan2.2 Remix 逐段生成（每段独立 MoE）",
    "properties": {"Node name for S&R": "WanRemixSequentialI2V"},
    "widgets_values": [
        42,          # seed
        "randomize",
        20,          # steps
        3.5,         # cfg
        "uni_pc",
        "simple",
        0.0,         # cfg_low
        0.9,         # boundary I2V
        5.0,         # sigma_shift
        "",          # negative override
        "",          # global override
        0,           # width
        0,           # height
        True,        # seed_per_segment
        True,        # dedupe_flf_boundary
        0.875,       # t2v_boundary
        True,        # text_continue_prev：文字段接上一段末帧
    ],
    "color": "#322",
    "bgcolor": "#533",
})

# Merge
nodes.append({
    "id": 7,
    "type": "WanRemixMergeClips",
    "pos": [1960, 40],
    "size": [300, 100],
    "flags": {},
    "order": 6,
    "mode": 0,
    "inputs": [{"name": "视频片段包", "type": "WAN_VIDEO_CLIPS", "link": None}],
    "outputs": [
        {"name": "合并视频", "type": "IMAGE", "links": [], "slot_index": 0},
        {"name": "总帧数", "type": "INT", "links": [], "slot_index": 1},
        {"name": "帧率", "type": "FLOAT", "links": [], "slot_index": 2},
    ],
    "title": "Lazy Wan2.2 Remix 视频段拼合",
    "properties": {"Node name for S&R": "WanRemixMergeClips"},
    "widgets_values": [0],
    "color": "#223",
    "bgcolor": "#335",
})

# Note note
nodes.append({
    "id": 8,
    "type": "Note",
    "pos": [1520, 500],
    "size": [420, 280],
    "flags": {},
    "order": 7,
    "mode": 0,
    "inputs": [],
    "outputs": [],
    "properties": {},
    "widgets_values": [
        "【Lazy 逐段生成 · 测试说明】\n"
        "1. 确认 high/low UNET、CLIP(type=wan)、VAE 路径\n"
        "2. 导演台时间线换成你的图片\n"
        "3. 段间图标：\n"
        "   ⇄ 蓝 = 首尾帧（本段首=图A 尾=图B）\n"
        "   ✕ 红 = 硬切（本段仅图生视频）\n"
        "4. 图片后加「文字段」→ 自动取上一段视频最后一帧继续图生\n"
        "   （不是纯文生；仅最前无前段时才纯文生）\n"
        "5. 快速测试可 steps=4~8、段长改短\n"
        "6. 点导演台「说明」可看完整用法\n"
        "\n"
        "流程：Lazy 导演台 → Lazy 逐段生成 → Lazy 拼合 → 导出"
    ],
    "color": "#432",
    "bgcolor": "#653",
})

# Optional VHS if present — use SaveAnimatedWEBP as fallback-friendly export
nodes.append({
    "id": 9,
    "type": "SaveAnimatedWEBP",
    "pos": [2320, 40],
    "size": [320, 220],
    "flags": {},
    "order": 8,
    "mode": 0,
    "inputs": [
        {"name": "images", "type": "IMAGE", "link": None},
        {"name": "filename_prefix", "type": "STRING", "widget": {"name": "filename_prefix"}, "link": None},
        {"name": "fps", "type": "FLOAT", "widget": {"name": "fps"}, "link": None},
    ],
    "outputs": [],
    "title": "导出 WEBP 动画（测试）",
    "properties": {"Node name for S&R": "SaveAnimatedWEBP"},
    "widgets_values": ["Lazy/WanRemix_sequential", 16.0, False, 90, "default"],
})

by_id = {n["id"]: n for n in nodes}

# Links
wire(by_id, 1, 0, 5, 0, "MODEL")       # high → director
wire(by_id, 2, 0, 5, 1, "MODEL")       # low → director
wire(by_id, 3, 0, 5, 2, "CLIP")        # clip → director

wire(by_id, 5, 0, 6, 0, "MODEL")       # director high → sequential
wire(by_id, 5, 1, 6, 1, "MODEL")       # director low → sequential
wire(by_id, 3, 0, 6, 2, "CLIP")        # clip → sequential
wire(by_id, 4, 0, 6, 3, "VAE")         # vae → sequential
wire(by_id, 5, 5, 6, 4, "GUIDE_DATA")  # guide_data → sequential

wire(by_id, 6, 0, 7, 0, "WAN_VIDEO_CLIPS")
wire(by_id, 7, 0, 9, 0, "IMAGE")

workflow = {
    "id": "lazy-wan-remix-sequential",
    "revision": 2,
    "last_node_id": 9,
    "last_link_id": link_id - 1,
    "nodes": nodes,
    "links": links,
    "groups": [],
    "config": {},
    "extra": {
        "ds": {"scale": 0.75, "offset": [0, 0]},
        "info": {
            "name": "Lazy Wan Remix 逐段生成测试",
            "description": (
                "Lazy 导演台 → 逐段 high/low MoE → 拼合 → 导出。"
                "⇄首尾帧 / ✕硬切；文字段续接上一段末帧；省显存。"
            ),
        },
    },
    "version": 0.4,
}

for p in out_paths:
    with open(p, "w", encoding="utf-8") as f:
        json.dump(workflow, f, ensure_ascii=False, indent=2)
    print("Wrote", p)

print("OK: sequential test workflow generated")
