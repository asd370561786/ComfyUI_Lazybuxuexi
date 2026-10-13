# Wan Remix Director (ceshi)

基于导演台时间线的 **Wan2.2 Remix NSFW I2V** 双专家工作流：

- `Wan2.2_Remix_NSFW_i2v_14b_high_lighting_fp8_e4m3fn_v3.0.safetensors`
- `Wan2.2_Remix_NSFW_i2v_14b_low_lighting_fp8_e4m3fn_v3.0.safetensors`

## 推荐：逐段生成（省显存 / 可无限加长）

```text
custom_nodes/ceshi/example_workflows/Wan_Remix_Director_Sequential_Test.json
```

流程：

```text
UNET high ─┐
UNET low  ─┼─► 导演台 ─ guide_data ─► 逐段生成 ─► 视频段拼合 ─► 导出
CLIP      ─┘              ▲              ▲
VAE ──────────────────────┴──────────────┘
```

### 时间线衔接规则

| 标记 | 含义 | 本段行为 |
|------|------|----------|
| **⇄**（蓝） | 首尾帧 | 首帧=当前图，尾帧=下一张图 |
| **✕**（红） | 硬切 | 仅当前图做图生视频 |
| **文字段**（无图） | 文生视频 | 只用全局+分段提示词，无 concat 图 |

每段单独跑 high→low MoE，解码后释放 latent，**显存只吃单段长度**；全部完成后再拼成一条长视频。

### 测试步骤

1. 重启 ComfyUI，浏览器 **Ctrl+F5** 强刷  
2. **Workflow → Open** 打开 `Wan_Remix_Director_Sequential_Test.json`  
3. 确认 high / low UNET、CLIP(`type=wan`)、VAE 路径  
4. 在导演台拖入你的图片；点段间图标切换 ⇄ / ✕  
5. 可选：加入纯文字段做 T2V  
6. 快速验证可把 **steps=4~8**、段长改短  
7. Queue Prompt → 看「运行信息」与导出结果  

## 备选：单段多关键帧（一次采样）

```text
custom_nodes/ceshi/Wan_Remix_Director_I2V_Basic.json
```

`导演台 → 关键帧引导 → MoE 采样器 → 解码`（整段一次采样，不适合超长）。

## 节点一览

| 节点 | 说明 |
|------|------|
| **Lazy Wan2.2 Remix 导演台** | 主轨时间线（图片/文字/视频）、guide_data；已移除音频/参考视频轨 |
| **Wan2.2 Remix 逐段生成** | 每段 I2V/FLF/T2V + high/low MoE |
| **Wan2.2 Remix 视频段拼合** | 多段 IMAGE 硬切合并 |
| **Wan2.2 Remix 关键帧引导** | 单段 concat 关键帧（非逐段模式） |
| **Wan2.2 Remix MoE 采样器** | 单次 high→low 采样 |
| 多图/音视频加载等 | 辅助节点 |

分类：`WanRemix/Director`

> 已弃用：`Keyframer` / `Sequencer`（LTX 残留，不再注册）。

## 依赖

- ComfyUI（Wan VAE / WanImageToVideo 能力）
- CLIP type = `wan`（如 UMT5-XXL）
- `wan_2.1_vae.safetensors`
- Remix high / low 两个 UNET

## License

GPL-3.0（继承 WhatDreamsCost / WanMoeKSampler 相关逻辑）。
