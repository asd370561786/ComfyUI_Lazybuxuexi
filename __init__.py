from typing_extensions import override

from comfy_api.latest import ComfyExtension, io

from .wan_director import WanRemixDirector, ensure_director_routes
from .wan_director_guide import WanRemixDirectorGuide, WanRemixDirectorCropGuides
from .wan_moe_sampler import WanRemixMoESampler
from .wan_sequential_i2v import WanRemixSequentialI2V, WanRemixMergeClips
from .multi_image_loader import MultiImageLoader
from .load_audio_ui import LoadAudioUI
from .load_video_ui import LoadVideoUI, ensure_video_ui_routes
from .speech_length_calculator import SpeechLengthCalculator
from .resource_monitor import ensure_resource_monitor_routes
from .lazy_h3_director import LazyH3Director
from .lazy_h3_sequential import LazyH3SequentialGenerate, LazyH3MergeClips
from .lazy_video_save import LazyVideoSave
from .lazy_h3_model_loader import LazyH3ModelLoader
from .lazy_h3_lora_stack import LazyH3LoraStack
from .lazy_krea_lora_stack import LazyKreaLoraStack
from .lazy_krea_workbench import LazyKreaWorkbench
from .lazy_krea_generate import LazyKreaGenerate
from .lazy_qwen_workbench import LazyQwenWorkbench
from .lazy_qwen_generate import LazyQwenGenerate
from .lazy_merge_generate import LazyMergeGenerate
from .lazy_merge_workbench import LazyMergeWorkbench
from .lazy_prompt_line import LazyPromptLine
from .lazy_upscale_rife import LazyUpscaleRife
from .lazy_face_refine import LazyFaceRefine
from .lazy_h3_spatial import LazyH3Spatial
from .lazy_yue_workbench import LazyYueWorkbench, ensure_yue_routes
from .lazy_yue_generate import LazyYueGenerate

# LTX 残留节点已停用，不再注册（见 wan_keyframer / wan_sequencer 文件头说明）

WEB_DIRECTORY = "./js"

# 尝试注册 HTTP 路由（PromptServer 就绪时）
try:
    ensure_director_routes()
    ensure_video_ui_routes()
    ensure_resource_monitor_routes()
    ensure_yue_routes()
except Exception:
    pass


def _lazy_retry_routes():
    """PromptServer 晚就绪时再挂路由。"""
    try:
        ensure_director_routes()
        ensure_video_ui_routes()
        ensure_resource_monitor_routes()
        ensure_yue_routes()
    except Exception:
        pass


# 延迟再挂一次，避免 import 时 instance 仍为 None 导致卸载接口 404
try:
    import threading

    def _delayed():
        import time

        for _ in range(20):
            time.sleep(0.5)
            try:
                from server import PromptServer

                if getattr(PromptServer, "instance", None) is not None:
                    _lazy_retry_routes()
                    break
            except Exception:
                pass

    threading.Thread(target=_delayed, daemon=True).start()
except Exception:
    pass


class WanRemixExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        # 仅 V3 Schema 节点走 Extension API；其余仍由 NODE_CLASS_MAPPINGS 注册
        try:
            ensure_director_routes()
            ensure_video_ui_routes()
            ensure_resource_monitor_routes()
            ensure_yue_routes()
        except Exception:
            pass
        return [WanRemixDirector, LazyH3Director]


async def comfy_entrypoint() -> WanRemixExtension:
    return WanRemixExtension()


NODE_CLASS_MAPPINGS = {
    "WanRemixDirector": WanRemixDirector,
    "WanRemixDirectorGuide": WanRemixDirectorGuide,
    "WanRemixDirectorCropGuides": WanRemixDirectorCropGuides,
    "WanRemixMoESampler": WanRemixMoESampler,
    "WanRemixSequentialI2V": WanRemixSequentialI2V,
    "WanRemixMergeClips": WanRemixMergeClips,
    "WanRemixMultiImageLoader": MultiImageLoader,
    "WanRemixLoadAudioUI": LoadAudioUI,
    "WanRemixLoadVideoUI": LoadVideoUI,
    "WanRemixSpeechLengthCalculator": SpeechLengthCalculator,
    # —— Lazy H3 系列（与 Wan 套件并行，互不影响）——
    "LazyH3Director": LazyH3Director,
    "LazyH3SequentialGenerate": LazyH3SequentialGenerate,
    "LazyH3MergeClips": LazyH3MergeClips,
    "LazyVideoSave": LazyVideoSave,
    "LazyH3ModelLoader": LazyH3ModelLoader,
    "LazyH3LoraStack": LazyH3LoraStack,
    # —— Lazy Krea2 ——
    "LazyKreaLoraStack": LazyKreaLoraStack,
    "LazyKreaWorkbench": LazyKreaWorkbench,
    "LazyKreaGenerate": LazyKreaGenerate,
    "LazyQwenWorkbench": LazyQwenWorkbench,
    "LazyQwenGenerate": LazyQwenGenerate,
    "LazyMergeGenerate": LazyMergeGenerate,
    "LazyMergeWorkbench": LazyMergeWorkbench,
    "LazyPromptLine": LazyPromptLine,
    "LazyUpscaleRife": LazyUpscaleRife,
    "LazyFaceRefine": LazyFaceRefine,
    "LazyH3Spatial": LazyH3Spatial,
    # —— Lazy YuE（不改现有节点）——
    "LazyYueWorkbench": LazyYueWorkbench,
    "LazyYueGenerate": LazyYueGenerate,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WanRemixDirector": "Lazy 导演台",
    "WanRemixDirectorGuide": "Lazy 关键帧引导",
    "WanRemixDirectorCropGuides": "Lazy 关键帧裁剪",
    "WanRemixMoESampler": "Lazy 采样器（Wan单段）",
    "WanRemixSequentialI2V": "Lazy Wan2.2 Remix 逐段生成（每段独立 MoE）",
    "WanRemixMergeClips": "Lazy 视频段拼合",
    "WanRemixMultiImageLoader": "Lazy 多图加载",
    "WanRemixLoadAudioUI": "Lazy 音频加载",
    "WanRemixLoadVideoUI": "Lazy 视频加载",
    "WanRemixSpeechLengthCalculator": "Lazy 语音时长计算",
    "LazyH3Director": "Lazy MinimaxH3 导演台",
    "LazyH3SequentialGenerate": "Lazy H3 逐段生成",
    "LazyH3MergeClips": "Lazy H3 段拼合",
    "LazyVideoSave": "Lazy 视频保存",
    "LazyH3ModelLoader": "Lazy H3 模型加载",
    "LazyH3LoraStack": "Lazy H3 多LoRA",
    "LazyKreaLoraStack": "Lazy Krea 多LoRA",
    "LazyKreaWorkbench": "Lazy Krea2 工作台",
    "LazyKreaGenerate": "Lazy Krea2 生成",
    "LazyQwenWorkbench": "Lazy Qwen2.1 工作台",
    "LazyQwenGenerate": "Lazy Qwen2.1 生成",
    "LazyMergeGenerate": "Lazy 合并生成",
    "LazyMergeWorkbench": "Lazy 合并台",
    "LazyPromptLine": "Lazy 提示词",
    "LazyUpscaleRife": "Lazy 超分+补帧",
    "LazyFaceRefine": "Lazy 二采修脸",
    "LazyH3Spatial": "Lazy 空间二采",
    "LazyYueWorkbench": "Lazy YuE 工作台",
    "LazyYueGenerate": "Lazy YuE 生成",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY", "comfy_entrypoint"]
