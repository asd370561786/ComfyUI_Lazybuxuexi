# -*- coding: utf-8 -*-
"""One-shot script to generate the example workflow JSON."""
import json
import os

out_dir = os.path.join(os.path.dirname(__file__), "example_workflows")
os.makedirs(out_dir, exist_ok=True)

negative = (
    "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，"
    "整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，"
    "画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，"
    "静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走"
)

global_prompt = (
    "cinematic video, natural motion, high quality, detailed face and hands, "
    "smooth camera, realistic lighting"
)

local_prompt = "the subject begins to move naturally, subtle expression change, soft lighting"

timeline = {
    "segments": [
        {
            "id": "start_frame_1",
            "start": 0,
            "length": 81,
            "prompt": local_prompt,
            "type": "image",
            "imageFile": "835A7679.JPG",
            "guideStrength": 1.0,
            "isEndFrame": False,
        }
    ],
    "audioSegments": [],
    "motionSegments": [],
    "global_prompt": global_prompt,
    "mainTrackEnabled": True,
    "audioTrackEnabled": True,
    "motionTrackEnabled": True,
}

# ComfyUI V1 控件顺序 = 全部 required 在前，再 optional。
# COMBO 用英文选项值（与节点 schema 一致），避免 “Value not in list”。
# global_prompt 为 forceInput：多数版本不进 widgets_values；若仍报错会再补空串。
director_widgets = [
    # --- required ---
    81,  # duration_frames
    0,  # start_frame
    81,  # end_frame
    0.0,  # start_second
    5.0625,  # end_second
    5.0625,  # duration_seconds
    0.001,  # epsilon
    json.dumps(timeline, ensure_ascii=False),  # timeline_data
    local_prompt,  # local_prompts
    "81",  # segment_lengths
    "1.00",  # guide_strength
    # --- optional（无 socket 的控件；跳过 optional_latent）---
    832,  # custom_width
    480,  # custom_height
    16.0,  # frame_rate
    # 注意：若你的前端把 forceInput 的 global_prompt 也算进 widgets，
    # 需要在 negative 前插 ""。下面先按「不算」处理。
    negative,  # negative_prompt
    "maintain aspect ratio",  # resize_method —— 必须是 options 里的英文
    16,  # divisible_by
    0,  # img_compression
    "seconds",  # display_mode —— 必须是 frames/seconds
    "",  # transition_smoothness
    False,  # use_custom_audio
    True,  # use_custom_motion
    True,  # inpaint_audio
    False,  # override_audio
    False,  # use_ic_video_size
]

nodes = []
links = []
link_id = 1


def add_link(from_node, from_slot, to_node, to_slot, typ):
    global link_id
    lid = link_id
    link_id += 1
    links.append([lid, from_node, from_slot, to_node, to_slot, typ])
    return lid


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
    "title": "UNET High Lighting (Remix)",
    "properties": {"cnr_id": "comfy-core", "Node name for S&R": "UNETLoader"},
    "widgets_values": [
        "Animate\\Wan2.2_Remix_NSFW_i2v_14b_high_lighting_fp8_e4m3fn_v3.0.safetensors",
        "default",
    ],
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
    "title": "UNET Low Lighting (Remix)",
    "properties": {"cnr_id": "comfy-core", "Node name for S&R": "UNETLoader"},
    "widgets_values": [
        "Animate\\Wan2.2_Remix_NSFW_i2v_14b_low_lighting_fp8_e4m3fn_v3.0.safetensors",
        "default",
    ],
    "color": "#223",
    "bgcolor": "#335",
})

nodes.append({
    "id": 3,
    "type": "CLIPLoader",
    "pos": [40, 280],
    "size": [420, 106],
    "flags": {},
    "order": 2,
    "mode": 0,
    "inputs": [
        {"name": "clip_name", "type": "COMBO", "widget": {"name": "clip_name"}, "link": None},
        {"name": "type", "type": "COMBO", "widget": {"name": "type"}, "link": None},
        {"name": "device", "type": "COMBO", "widget": {"name": "device"}, "link": None, "shape": 7},
    ],
    "outputs": [{"name": "CLIP", "type": "CLIP", "slot_index": 0, "links": []}],
    "title": "CLIP (wan)",
    "properties": {"cnr_id": "comfy-core", "Node name for S&R": "CLIPLoader"},
    "widgets_values": ["nsfw_wan_umt5-xxl_bf16_fixed.safetensors", "wan", "default"],
    "color": "#223",
    "bgcolor": "#335",
})

nodes.append({
    "id": 4,
    "type": "VAELoader",
    "pos": [40, 430],
    "size": [360, 58],
    "flags": {},
    "order": 3,
    "mode": 0,
    "inputs": [
        {"name": "vae_name", "type": "COMBO", "widget": {"name": "vae_name"}, "link": None},
    ],
    "outputs": [{"name": "VAE", "type": "VAE", "slot_index": 0, "links": []}],
    "title": "VAE Wan 2.1",
    "properties": {"cnr_id": "comfy-core", "Node name for S&R": "VAELoader"},
    "widgets_values": ["wan_2.1_vae.safetensors"],
    "color": "#223",
    "bgcolor": "#335",
})

dir_inputs = [
    {"name": "model_high_noise", "type": "MODEL", "link": None},
    {"name": "model_low_noise", "type": "MODEL", "link": None},
    {"name": "clip", "type": "CLIP", "link": None},
    {"name": "optional_latent", "type": "LATENT", "link": None, "shape": 7},
    {"name": "global_prompt", "type": "STRING", "link": None, "shape": 7},
]
for name, typ in [
    ("custom_width", "INT"),
    ("custom_height", "INT"),
    ("duration_frames", "INT"),
    ("frame_rate", "FLOAT"),
    ("start_frame", "INT"),
    ("end_frame", "INT"),
    ("start_second", "FLOAT"),
    ("end_second", "FLOAT"),
    ("duration_seconds", "FLOAT"),
    ("negative_prompt", "STRING"),
    ("resize_method", "COMBO"),
    ("divisible_by", "INT"),
    ("img_compression", "INT"),
    ("display_mode", "COMBO"),
    ("epsilon", "FLOAT"),
    ("timeline_data", "STRING"),
    ("local_prompts", "STRING"),
    ("segment_lengths", "STRING"),
    ("guide_strength", "STRING"),
    ("transition_smoothness", "STRING"),
    ("use_custom_audio", "BOOLEAN"),
    ("use_custom_motion", "BOOLEAN"),
    ("inpaint_audio", "BOOLEAN"),
    ("override_audio", "BOOLEAN"),
    ("use_ic_video_size", "BOOLEAN"),
]:
    dir_inputs.append({"name": name, "type": typ, "widget": {"name": name}, "link": None})

dir_outputs = [
    {"name": "model_high_noise", "type": "MODEL", "links": [], "slot_index": 0},
    {"name": "model_low_noise", "type": "MODEL", "links": [], "slot_index": 1},
    {"name": "positive", "type": "CONDITIONING", "links": [], "slot_index": 2},
    {"name": "negative", "type": "CONDITIONING", "links": [], "slot_index": 3},
    {"name": "video_latent", "type": "LATENT", "links": [], "slot_index": 4},
    {"name": "guide_data", "type": "GUIDE_DATA", "links": [], "slot_index": 5},
    {"name": "motion_guide_data", "type": "MOTION_GUIDE_DATA", "links": [], "slot_index": 6},
    {"name": "frame_rate", "type": "FLOAT", "links": [], "slot_index": 7},
    {"name": "combined_audio", "type": "AUDIO", "links": [], "slot_index": 8},
    {"name": "length", "type": "INT", "links": [], "slot_index": 9},
    {"name": "width", "type": "INT", "links": [], "slot_index": 10},
    {"name": "height", "type": "INT", "links": [], "slot_index": 11},
]

nodes.append({
    "id": 5,
    "type": "WanRemixDirector",
    "pos": [560, 40],
    "size": [1120, 780],
    "flags": {},
    "order": 4,
    "mode": 0,
    "inputs": dir_inputs,
    "outputs": dir_outputs,
    "title": "Wan Remix Director (导演台)",
    "properties": {
        "Node name for S&R": "WanRemixDirector",
        "cnr_id": "ceshi-WanRemixDirector",
    },
    "widgets_values": director_widgets,
    "color": "#232",
    "bgcolor": "#353",
})

nodes.append({
    "id": 6,
    "type": "WanRemixDirectorGuide",
    "pos": [1760, 200],
    "size": [360, 250],
    "flags": {},
    "order": 5,
    "mode": 0,
    "inputs": [
        {"name": "positive", "type": "CONDITIONING", "link": None},
        {"name": "negative", "type": "CONDITIONING", "link": None},
        {"name": "vae", "type": "VAE", "link": None},
        {"name": "latent", "type": "LATENT", "link": None},
        {"name": "guide_data", "type": "GUIDE_DATA", "link": None},
        {"name": "motion_guide_data", "type": "MOTION_GUIDE_DATA", "link": None, "shape": 7},
        {"name": "clip_vision_output", "type": "CLIP_VISION_OUTPUT", "link": None, "shape": 7},
        {"name": "width", "type": "INT", "widget": {"name": "width"}, "link": None},
        {"name": "height", "type": "INT", "widget": {"name": "height"}, "link": None},
        {"name": "length", "type": "INT", "widget": {"name": "length"}, "link": None},
        {"name": "strength_threshold", "type": "FLOAT", "widget": {"name": "strength_threshold"}, "link": None},
        {"name": "lock_radius", "type": "INT", "widget": {"name": "lock_radius"}, "link": None},
    ],
    "outputs": [
        {"name": "positive", "type": "CONDITIONING", "links": [], "slot_index": 0},
        {"name": "negative", "type": "CONDITIONING", "links": [], "slot_index": 1},
        {"name": "latent", "type": "LATENT", "links": [], "slot_index": 2},
        {"name": "width", "type": "INT", "links": [], "slot_index": 3},
        {"name": "height", "type": "INT", "links": [], "slot_index": 4},
        {"name": "length", "type": "INT", "links": [], "slot_index": 5},
    ],
    "title": "Wan Remix Director Guide",
    "properties": {"Node name for S&R": "WanRemixDirectorGuide"},
    "widgets_values": [0, 0, 0, 0.01, 0],
    "color": "#323",
    "bgcolor": "#535",
})

nodes.append({
    "id": 7,
    "type": "WanRemixMoESampler",
    "pos": [2200, 160],
    "size": [320, 360],
    "flags": {},
    "order": 6,
    "mode": 0,
    "inputs": [
        {"name": "model_high_noise", "type": "MODEL", "link": None},
        {"name": "model_low_noise", "type": "MODEL", "link": None},
        {"name": "positive", "type": "CONDITIONING", "link": None},
        {"name": "negative", "type": "CONDITIONING", "link": None},
        {"name": "latent_image", "type": "LATENT", "link": None},
        {"name": "boundary", "type": "FLOAT", "widget": {"name": "boundary"}, "link": None},
        {"name": "seed", "type": "INT", "widget": {"name": "seed"}, "link": None},
        {"name": "steps", "type": "INT", "widget": {"name": "steps"}, "link": None},
        {"name": "cfg_high_noise", "type": "FLOAT", "widget": {"name": "cfg_high_noise"}, "link": None},
        {"name": "cfg_low_noise", "type": "FLOAT", "widget": {"name": "cfg_low_noise"}, "link": None},
        {"name": "sampler_name", "type": "COMBO", "widget": {"name": "sampler_name"}, "link": None},
        {"name": "scheduler", "type": "COMBO", "widget": {"name": "scheduler"}, "link": None},
        {"name": "sigma_shift", "type": "FLOAT", "widget": {"name": "sigma_shift"}, "link": None},
        {"name": "denoise", "type": "FLOAT", "widget": {"name": "denoise"}, "link": None},
    ],
    "outputs": [{"name": "LATENT", "type": "LATENT", "links": [], "slot_index": 0}],
    "title": "Wan Remix MoE KSampler",
    "properties": {"Node name for S&R": "WanRemixMoESampler"},
    "widgets_values": [0.9, 42, "randomize", 20, 3.5, 3.5, "uni_pc", "simple", 5.0, 1.0],
    "color": "#432",
    "bgcolor": "#653",
})

nodes.append({
    "id": 8,
    "type": "VAEDecode",
    "pos": [2600, 220],
    "size": [210, 46],
    "flags": {},
    "order": 7,
    "mode": 0,
    "inputs": [
        {"name": "samples", "type": "LATENT", "link": None},
        {"name": "vae", "type": "VAE", "link": None},
    ],
    "outputs": [{"name": "IMAGE", "type": "IMAGE", "slot_index": 0, "links": []}],
    "properties": {"cnr_id": "comfy-core", "Node name for S&R": "VAEDecode"},
    "widgets_values": [],
})

nodes.append({
    "id": 9,
    "type": "VHS_VideoCombine",
    "pos": [2880, 120],
    "size": [340, 520],
    "flags": {},
    "order": 8,
    "mode": 0,
    "inputs": [
        {"name": "images", "type": "IMAGE", "link": None},
        {"name": "audio", "type": "AUDIO", "link": None, "shape": 7},
        {"name": "meta_batch", "type": "VHS_BatchManager", "link": None, "shape": 7},
        {"name": "vae", "type": "VAE", "link": None, "shape": 7},
    ],
    "outputs": [{"name": "Filenames", "type": "VHS_FILENAMES", "links": None}],
    "title": "Video Combine",
    "properties": {"Node name for S&R": "VHS_VideoCombine"},
    "widgets_values": {
        "frame_rate": 16,
        "loop_count": 0,
        "filename_prefix": "WanRemix/Director",
        "format": "video/h264-mp4",
        "pix_fmt": "yuv420p",
        "crf": 19,
        "save_metadata": True,
        "trim_to_audio": False,
        "pingpong": False,
        "save_output": True,
    },
})

nodes.append({
    "id": 10,
    "type": "Note",
    "pos": [40, 540],
    "size": [460, 300],
    "flags": {},
    "order": 9,
    "mode": 0,
    "inputs": [],
    "outputs": [],
    "properties": {},
    "widgets_values": [
        "【Wan2.2 Remix 导演台 I2V 工作流】\n\n"
        "1. 确认模型：\n"
        "   high/low = Animate/Wan2.2_Remix_NSFW_i2v_...\n"
        "   CLIP type 必须选 wan\n"
        "   VAE = wan_2.1_vae\n\n"
        "2. 打开「Wan Remix Director」时间线：\n"
        "   - 拖入或替换起始图片\n"
        "     (默认引用 input/835A7679.JPG，没有请换图)\n"
        "   - 编辑全局 / 分段 prompt\n"
        "   - 时长建议 4n+1 帧（默认 81）\n\n"
        "3. Queue Prompt 运行\n"
        "4. 视频输出: output/WanRemix/Director\n\n"
        "推荐采样: boundary=0.9, steps=20, cfg=3.5,\n"
        "uni_pc + simple, sigma_shift=5"
    ],
    "color": "#432",
    "bgcolor": "#653",
})

nodes.append({
    "id": 11,
    "type": "Note",
    "pos": [1760, 40],
    "size": [360, 130],
    "flags": {},
    "order": 10,
    "mode": 0,
    "inputs": [],
    "outputs": [],
    "properties": {},
    "widgets_values": [
        "Guide：把导演台关键帧写入 Wan I2V 条件。\n"
        "width/height/length=0 时自动用导演台尺寸。\n"
        "MoE 采样器内置 high→low 切换。"
    ],
    "color": "#323",
    "bgcolor": "#535",
})

# Wire: loaders -> director
by_id = {n["id"]: n for n in nodes}

def wire(fn, fs, tn, ts, typ):
    l = add_link(fn, fs, tn, ts, typ)
    by_id[fn]["outputs"][fs]["links"].append(l)
    by_id[tn]["inputs"][ts]["link"] = l
    return l

wire(1, 0, 5, 0, "MODEL")
wire(2, 0, 5, 1, "MODEL")
wire(3, 0, 5, 2, "CLIP")

# director -> guide
wire(5, 2, 6, 0, "CONDITIONING")
wire(5, 3, 6, 1, "CONDITIONING")
wire(4, 0, 6, 2, "VAE")
wire(5, 4, 6, 3, "LATENT")
wire(5, 5, 6, 4, "GUIDE_DATA")
wire(5, 6, 6, 5, "MOTION_GUIDE_DATA")

# models + guide out -> sampler
wire(5, 0, 7, 0, "MODEL")
wire(5, 1, 7, 1, "MODEL")
wire(6, 0, 7, 2, "CONDITIONING")
wire(6, 1, 7, 3, "CONDITIONING")
wire(6, 2, 7, 4, "LATENT")

# decode + export
wire(7, 0, 8, 0, "LATENT")
wire(4, 0, 8, 1, "VAE")
wire(8, 0, 9, 0, "IMAGE")
wire(5, 8, 9, 1, "AUDIO")

workflow = {
    "id": "wan-remix-director-i2v-basic",
    "revision": 0,
    "last_node_id": 11,
    "last_link_id": link_id - 1,
    "nodes": nodes,
    "links": links,
    "groups": [
        {
            "id": 1,
            "title": "1. Models",
            "bounding": [20, 0, 500, 530],
            "color": "#3f789e",
            "font_size": 24,
            "flags": {},
        },
        {
            "id": 2,
            "title": "2. Director Desk",
            "bounding": [540, 0, 1160, 850],
            "color": "#3f789e",
            "font_size": 24,
            "flags": {},
        },
        {
            "id": 3,
            "title": "3. Guide + MoE Sample + Export",
            "bounding": [1740, 0, 1540, 700],
            "color": "#3f789e",
            "font_size": 24,
            "flags": {},
        },
    ],
    "config": {},
    "extra": {
        "ds": {"scale": 0.65, "offset": [0, 0]},
        "info": {
            "name": "Wan Remix Director I2V Basic",
            "author": "ceshi",
            "description": "Wan2.2 Remix high/low lighting + Director timeline I2V workflow",
        },
    },
    "version": 0.4,
}

paths = [
    os.path.join(out_dir, "Wan_Remix_Director_I2V_Basic.json"),
    os.path.join(os.path.dirname(__file__), "Wan_Remix_Director_I2V_Basic.json"),
]
for p in paths:
    with open(p, "w", encoding="utf-8") as f:
        json.dump(workflow, f, ensure_ascii=False, indent=2)
    print("Wrote", p)

print("nodes", len(nodes), "links", len(links))
