"""
已弃用：原 LTX 序列器（继承 LTXVAddGuide）。

Wan2.2 Remix 请使用导演台 + 关键帧引导 / 逐段生成。
本文件保留以免旧工作流 import 报错，但不再注册为节点。
"""

from comfy_api.latest import io


class WanRemixSequencer(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="WanRemixSequencer",
            display_name="Wan Remix 序列器(已弃用)",
            category="WanRemix/Director",
            description="已弃用：LTX 残留，请改用导演台管线。",
            inputs=[
                io.Conditioning.Input("positive"),
                io.Conditioning.Input("negative"),
                io.Vae.Input("vae"),
                io.Latent.Input("latent"),
            ],
            outputs=[
                io.Conditioning.Output(display_name="positive"),
                io.Conditioning.Output(display_name="negative"),
                io.Latent.Output(display_name="latent"),
            ],
        )

    @classmethod
    def execute(cls, positive, negative, vae, latent, **kwargs) -> io.NodeOutput:
        raise RuntimeError(
            "WanRemixSequencer 已弃用（LTX 逻辑不适配 Wan）。"
            "请改用：导演台 → 关键帧引导 / 逐段生成 → 视频段拼合。"
        )
