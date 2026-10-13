"""
已弃用：原 LTX 关键帧器（依赖 vae.downscale_index_formula / LTX noise_mask 语义）。

Wan2.2 Remix 请使用：
  导演台 → 关键帧引导（单段）
  或 导演台 → 逐段生成 → 视频段拼合（多段省显存）

本文件保留以免旧工作流 import 报错，但不再注册为节点。
"""

from comfy_api.latest import io


class WanRemixKeyframer(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="WanRemixKeyframer",
            display_name="Wan Remix 关键帧器(已弃用)",
            category="WanRemix/Director",
            description="已弃用：LTX 残留，请改用「关键帧引导」或「逐段生成」。",
            inputs=[
                io.Vae.Input("vae"),
                io.Latent.Input("latent"),
                io.Image.Input("multi_input", optional=True),
            ],
            outputs=[io.Latent.Output(display_name="latent")],
        )

    @classmethod
    def execute(cls, vae, latent, multi_input=None, **kwargs) -> io.NodeOutput:
        raise RuntimeError(
            "WanRemixKeyframer 已弃用（LTX 逻辑不适配 Wan）。"
            "请改用：导演台 → 关键帧引导，或 导演台 → 逐段生成 → 视频段拼合。"
        )
