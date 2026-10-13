"""
Lazy YuE 生成。
主轨有原曲：转旋律谱再唱（翻唱）。没有：按风格和歌词直接生成。
没改过谱就用原谱。有参考音频时，时长跟参考音频。调音时只改原谱里的音高，翻唱格式不动。
"""
from __future__ import annotations

import logging
import random
import re

import torch

from .lazy_h3_common import call_node_function, resolve_h3_node

log = logging.getLogger(__name__)


def _has_voices(text: str) -> bool:
    return bool(re.search(r"(?m)^V\s*:", text or ""))


def decide(has_audio: bool, abc: str, mode: str, make_score: bool, score_only: bool, edited: bool = False, original: str = "") -> dict:
    """纯逻辑：翻唱 / 直接生成，以及乐谱从哪来。没改过就用原谱。"""
    mode = mode if mode in ("full", "melody") else ("melody" if has_audio else "full")
    shown = (abc or "").strip()
    raw = (original or "").strip()
    edited = bool(edited)
    if edited and shown:
        action = "use"
    elif not edited and (raw or (has_audio and _has_voices(shown))):
        action = "reuse" if has_audio else "keep"
    elif has_audio:
        action = "transcribe"
    elif shown and not edited:
        action = "keep"
    elif make_score:
        action = "plan"
    else:
        action = "off"
    return {
        "kind": "翻唱" if has_audio else "直接生成",
        "mode": mode,
        "action": action,
        "score_only": bool(score_only),
    }


def _outs(out):
    if out is None:
        return []
    if hasattr(out, "args"):
        try:
            return list(out.args)
        except Exception:
            pass
    if isinstance(out, tuple):
        return list(out)
    if isinstance(out, list):
        return list(out)
    return [out]


def _first(out):
    vals = _outs(out)
    if not vals:
        raise RuntimeError("节点没有返回结果。")
    return vals[0]


def _abc_text(val) -> str:
    if isinstance(val, (list, tuple)):
        for item in val:
            text = _abc_text(item).strip()
            if text:
                return text
        return ""
    if val is None:
        return ""
    return str(val).strip()


def _need(class_name: str):
    node = resolve_h3_node(class_name)
    if node is None:
        raise RuntimeError("当前 ComfyUI 没有 YuE2，请先更新。")
    return node


def _fit_audio(audio, seconds: float):
    """参考曲长于秒数时，只保留开头这一段。"""
    if not isinstance(audio, dict) or audio.get("waveform") is None:
        return audio
    try:
        wf = audio["waveform"]
        sr = int(audio.get("sample_rate") or 44100)
        keep = max(1, int(float(seconds) * max(sr, 1)))
        if int(wf.shape[-1]) <= keep:
            return audio
        out = dict(audio)
        out["waveform"] = wf[..., :keep]
        return out
    except Exception:
        return audio


_ABC_STEP = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
_ABC_SHARP_N = {"C": 0, "G": 1, "D": 2, "A": 3, "E": 4, "B": 5, "F#": 6, "C#": 7}
_ABC_FLAT_N = {"F": 1, "Bb": 2, "Eb": 3, "Ab": 4, "Db": 5, "Gb": 6, "Cb": 7}
_ABC_SHARPS = ["F", "C", "G", "D", "A", "E", "B"]
_ABC_FLATS = ["B", "E", "A", "D", "G", "C", "F"]
_ABC_REL = {
    "Am": "C", "Em": "G", "Bm": "D", "F#m": "A", "C#m": "E", "G#m": "B", "D#m": "F#", "A#m": "C#",
    "Dm": "F", "Gm": "Bb", "Cm": "Eb", "Fm": "Ab", "Bbm": "Db", "Ebm": "Gb", "Abm": "Cb",
}
_ABC_SPELL_SHARP = [
    ("C", 0), ("C", 1), ("D", 0), ("D", 1), ("E", 0), ("F", 0),
    ("F", 1), ("G", 0), ("G", 1), ("A", 0), ("A", 1), ("B", 0),
]
_ABC_SPELL_FLAT = [
    ("C", 0), ("D", -1), ("D", 0), ("E", -1), ("E", 0), ("F", 0),
    ("G", -1), ("G", 0), ("A", -1), ("A", 0), ("B", -1), ("B", 0),
]
_VOCAL_HEAD = 'V: Vocal clef=treble name="Vocal Melody" snm="Vocal"'
_INS_HEAD = 'V: Ins clef=treble name="Ins Melody" snm="Inst."'
_BAR_RE = re.compile(r"^(?:\|\]|\|\||\[\||\|:|:\||::|\|)")


def _abc_norm(text: str) -> str:
    return str(text or "").replace("\r\n", "\n").replace("\r", "\n")


def _abc_major_key(raw: str) -> str:
    parts = str(raw or "C").strip().split()
    name = parts[0] if parts else "C"
    mode = parts[1].lower() if len(parts) > 1 else ""
    if "min" in mode and not name.endswith("m"):
        name += "m"
    if name in _ABC_REL:
        return _ABC_REL[name]
    if name in _ABC_SHARP_N or name in _ABC_FLAT_N:
        return name
    return "C"


def _abc_key_acc(raw: str) -> dict:
    key = _abc_major_key(raw)
    if key in _ABC_SHARP_N:
        return {letter: 1 for letter in _ABC_SHARPS[: _ABC_SHARP_N[key]]}, key
    n = _ABC_FLAT_N.get(key, 0)
    return {letter: -1 for letter in _ABC_FLATS[:n]}, key


def _abc_midi(acc, letter: str, octs: int, key_acc: dict, bar_acc: dict) -> int:
    name = letter.upper()
    base = 5 if letter == letter.lower() else 4
    octave = base + int(octs or 0)
    if acc is None:
        use = bar_acc[name] if name in bar_acc else key_acc.get(name, 0)
    else:
        use = acc
        bar_acc[name] = use
    return (octave + 1) * 12 + _ABC_STEP[name] + use


def _abc_spell(midi: int, key_name: str, key_acc: dict, bar_acc: dict) -> str:
    pc = ((int(midi) % 12) + 12) % 12
    table = _ABC_SPELL_FLAT if key_name in _ABC_FLAT_N else _ABC_SPELL_SHARP
    letter, acc = table[pc]
    cur = bar_acc[letter] if letter in bar_acc else key_acc.get(letter, 0)
    mark = ""
    if acc != cur:
        if acc == 0:
            mark = "="
        elif acc > 0:
            mark = "^" * acc
        else:
            mark = "_" * (-acc)
        bar_acc[letter] = acc
    octave = int(midi) // 12 - 1
    name = letter.lower() if octave >= 5 else letter
    if octave > 5:
        name += "'" * (octave - 5)
    if octave < 4:
        name += "," * (4 - octave)
    return mark + name


def _abc_read_pitch(s: str, i: int):
    n = len(s)
    if i >= n:
        return None
    start = i
    acc = None
    if s.startswith("^^", i):
        acc = 2
        i += 2
    elif s.startswith("__", i):
        acc = -2
        i += 2
    elif s[i] == "^":
        acc = 1
        i += 1
    elif s[i] == "_":
        acc = -1
        i += 1
    elif s[i] == "=":
        acc = 0
        i += 1
    if i >= n or s[i] not in "ABCDEFGabcdefgzxZ":
        return None
    letter = s[i]
    i += 1
    octs = 0
    if letter not in "zxZ":
        while i < n and s[i] == ",":
            octs -= 1
            i += 1
        while i < n and s[i] == "'":
            octs += 1
            i += 1
    pitch_to = i
    if i < n and s[i].isdigit():
        while i < n and s[i].isdigit():
            i += 1
    if i < n and s[i] == "/":
        i += 1
        while i < n and s[i].isdigit():
            i += 1
    while i < n and s[i] == ".":
        i += 1
    tie = False
    if i < n and s[i] == "-":
        tie = True
        i += 1
    return {
        "from": start,
        "to": pitch_to,
        "next": i,
        "acc": acc,
        "letter": letter,
        "oct": octs,
        "rest": letter in "zxZ",
        "tie": tie,
    }


def _abc_cover_notes(text: str) -> tuple[str, str, list]:
    s = _abc_norm(text)
    i = 0
    head_k = "C"
    while i < len(s):
        if i != 0 and s[i - 1] != "\n":
            break
        if s[i] == "\n":
            i += 1
            continue
        if s[i] == "%":
            while i < len(s) and s[i] != "\n":
                i += 1
            continue
        line_end = s.find("\n", i)
        line = s[i:] if line_end < 0 else s[i:line_end]
        if not line.strip():
            i = len(s) if line_end < 0 else line_end + 1
            continue
        field = re.match(r"^([A-Za-z]):\s*(.*)$", line.strip())
        if not field:
            break
        key = field.group(1).upper()
        if key == "K":
            raw = (field.group(2) or "").strip()
            km = re.match(r"^(\S+)\s*(.*)$", raw)
            rest = km.group(2).strip() if km and km.group(2) else ""
            music = bool(rest) and bool(re.match(r"^[\^_=A-Ga-gzxZ|\"\[]", rest))
            head_k = km.group(1) if music and km else (raw or "C")
            if music:
                i += line.find(rest)
            else:
                i = len(s) if line_end < 0 else line_end + 1
            break
        i = len(s) if line_end < 0 else line_end + 1
    key_acc, key_name = _abc_key_acc(head_k)
    bar_acc = {}
    voice = ""
    notes = []
    last = None
    tie_prev = False
    while i < len(s):
        ch = s[i]
        if ch in " \t\r":
            i += 1
            continue
        at_line = i == 0 or s[i - 1] == "\n"
        if ch == "\n" or at_line:
            if ch == "\n":
                i += 1
            field = re.match(r"^([A-Za-z]):[^\n]*", s[i:])
            if field:
                key = field.group(1).upper()
                val = field.group(0)[2:].strip()
                if key == "K":
                    key_acc, key_name = _abc_key_acc(val)
                    bar_acc = {}
                elif key == "X":
                    break
                elif key == "V":
                    name = (val.split() or [""])[0].strip()
                    if name != voice:
                        voice = name
                        last = None
                        tie_prev = False
                        bar_acc = {}
                    i += len(field.group(0))
                    continue
                i += len(field.group(0))
                continue
            if ch == "\n":
                continue
        if ch == "%":
            while i < len(s) and s[i] != "\n":
                i += 1
            continue
        if ch == '"':
            j = s.find('"', i + 1)
            i = len(s) if j < 0 else j + 1
            continue
        if ch == "{":
            j = s.find("}", i + 1)
            i = len(s) if j < 0 else j + 1
            continue
        bar = _BAR_RE.match(s[i:])
        if bar:
            bar_acc = {}
            tie_prev = False
            i += len(bar.group(0))
            while i < len(s) and s[i] in "0123456789,-":
                i += 1
            continue
        if ch == "[":
            inline = re.match(r"^\[([A-Za-z]):([^\]]*)\]", s[i:])
            if inline:
                if inline.group(1).upper() == "K":
                    key_acc, key_name = _abc_key_acc(inline.group(2))
                    bar_acc = {}
                i += len(inline.group(0))
                continue
            close = s.find("]", i + 1)
            i = close + 1 if close >= 0 else i + 1
            continue
        tok = _abc_read_pitch(s, i)
        if not tok:
            i += 1
            continue
        i = tok["next"]
        if tok["rest"]:
            last = None
            tie_prev = False
            continue
        midi = _abc_midi(tok["acc"], tok["letter"], tok["oct"], key_acc, bar_acc)
        span = (tok["from"], tok["to"])
        if tie_prev and last and last["midi"] == midi and last["voice"] == voice:
            last["spans"].append(span)
        else:
            last = {"voice": voice, "midi": midi, "spans": [span]}
            notes.append(last)
        tie_prev = bool(tok["tie"])
    return s, head_k, notes


def _patch_cover_abc(original: str, shown: str) -> str:
    """把改过的音高写回原谱，翻唱用的乐谱格式保持不变。"""
    raw = (original or "").strip()
    edited = (shown or "").strip()
    if not raw or not edited or raw == edited:
        return raw
    src, head_k, olds = _abc_cover_notes(raw)
    _, _, news = _abc_cover_notes(edited)
    if not olds or len(olds) != len(news):
        return ""
    def by_voice(items):
        out = {}
        for item in items:
            out.setdefault(item["voice"], []).append(item)
        return out
    a = by_voice(olds)
    b = by_voice(news)
    if set(a) != set(b):
        return ""
    midi_of = {}
    for voice, left in a.items():
        right = b[voice]
        if len(left) != len(right):
            return ""
        for i, note in enumerate(left):
            midi_of[id(note)] = right[i]["midi"]
    spans = []
    for note in olds:
        midi = midi_of[id(note)]
        for start, end in note["spans"]:
            spans.append((start, end, midi))
    spans.sort(key=lambda x: x[0])
    key_acc, key_name = _abc_key_acc(head_k)
    bar_acc = {}
    prev = 0
    reps = []
    for start, end, midi in spans:
        mid = src[prev:start]
        if "|" in mid:
            bar_acc = {}
        km = re.search(r"\[K:([^\]]+)\]", mid)
        if km:
            key_acc, key_name = _abc_key_acc(km.group(1))
            bar_acc = {}
        line_k = re.search(r"(?:^|\n)K:\s*(\S+)", mid)
        if line_k:
            key_acc, key_name = _abc_key_acc(line_k.group(1))
            bar_acc = {}
        reps.append((start, end, _abc_spell(midi, key_name, key_acc, bar_acc)))
        prev = end
    out = src
    for start, end, token in reversed(reps):
        out = out[:start] + token + out[end:]
    return out


def _ensure_cover_voices(original: str, shown: str) -> str:
    text = shown or ""
    if 'name="Vocal Melody"' in text:
        return text
    if 'name="Vocal Melody"' not in (original or ""):
        return text
    if re.search(r"(?m)^K:", text):
        return re.sub(r"(?m)^K:", _VOCAL_HEAD + "\n" + _INS_HEAD + "\nK:", text, count=1)
    return text


def _audio_seconds(audio) -> float:
    try:
        wf = audio["waveform"]
        sr = int(audio.get("sample_rate") or 44100)
        return float(wf.shape[-1]) / max(sr, 1)
    except Exception:
        return 0.0


def _silence(seconds: float = 0.2, sample_rate: int = 44100):
    n = max(1, int(sample_rate * seconds))
    return {
        "waveform": torch.zeros((1, 2, n), dtype=torch.float32),
        "sample_rate": sample_rate,
    }


def _push_abc(node_id: str, abc: str, kind: str):
    try:
        from server import PromptServer

        inst = getattr(PromptServer, "instance", None)
        if inst is None:
            return
        inst.send_sync("lazy_yue_abc", {
            "node_id": str(node_id or ""),
            "abc": abc or "",
            "kind": kind or "",
        })
    except Exception as e:
        log.warning("[LazyYuE] 回写乐谱失败: %s", e)


def _pick_sheetsage() -> str:
    import folder_paths

    names = list(folder_paths.get_filename_list("audio_encoders") or [])
    exact = [n for n in names if n.replace("\\", "/").split("/")[-1] == "sheetsage2_bf16.safetensors"]
    if exact:
        return exact[0]
    hits = [n for n in names if "sheetsage" in n.lower()]
    if hits:
        return hits[0]
    raise RuntimeError("翻唱需要 sheetsage2 编码器，请放到 models/audio_encoders。")


class LazyYueGenerate:
    """按 YuE 包翻唱或直接生成。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "模型": ("MODEL", {"tooltip": "模型。"}),
                "文本编码": ("CLIP", {"tooltip": "文本编码。"}),
                "VAE": ("VAE", {"tooltip": "VAE。"}),
                "YuE包": ("YUE_PACK", {"tooltip": "工作台输出。"}),
                "种子": ("INT", {
                    "default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF,
                    "tooltip": "种子。",
                }),
                "最大时长": ("FLOAT", {
                    "default": 360.0, "min": 0.04, "max": 900.0, "step": 0.04,
                    "tooltip": "最大时长。",
                }),
                "步数": ("INT", {
                    "default": 32, "min": 1, "max": 150,
                    "tooltip": "步数。",
                }),
                "随机种子": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "随机种子。",
                }),
            },
            "optional": {
                "音频编码": ("AUDIO_ENCODER", {"tooltip": "音频编码。"}),
            },
        }

    RETURN_TYPES = ("AUDIO", "STRING", "STRING")
    RETURN_NAMES = ("音频", "乐谱", "运行信息")
    FUNCTION = "generate"
    CATEGORY = "Lazy/YuE"
    DESCRIPTION = "Lazy YuE 生成"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def generate(self, **kwargs):
        _install_yue_finish()
        g = kwargs.get
        model = g("模型", None)
        clip = g("文本编码", None)
        vae = g("VAE", None)
        pack = g("YuE包", None)
        if model is None or clip is None or vae is None:
            raise RuntimeError("请连接模型、文本编码和 VAE。")
        if not isinstance(pack, dict):
            raise RuntimeError("请连接 Lazy YuE 工作台。")

        style = str(pack.get("style") or "")
        lyrics = str(pack.get("lyrics") or "")
        if not style.strip():
            name = str(pack.get("style_name") or "").strip()
            if name:
                try:
                    from .lazy_yue_workbench import _style_items

                    for it in _style_items():
                        if it.get("name") == name:
                            style = str(it.get("prompt") or "")
                            break
                except Exception:
                    pass
        score_only = bool(pack.get("score_only", False))
        if not score_only:
            if not style.strip():
                raise RuntimeError("请填写风格。")
            if not lyrics.strip():
                raise RuntimeError("请填写歌词。")

        try:
            seed = int(g("种子", 0) or 0)
        except Exception:
            seed = 0
        if bool(g("随机种子", True)):
            seed = random.getrandbits(63)
        seed = max(0, seed)

        raw_sec = pack.get("seconds", None)
        if raw_sec is not None:
            try:
                max_duration = float(raw_sec)
            except Exception:
                max_duration = 120.0
        else:
            try:
                max_duration = float(g("最大时长", 360.0))
            except Exception:
                max_duration = 360.0
        max_duration = min(900.0, max(1.0, max_duration))
        if not (isinstance(pack.get("audio"), dict) and pack.get("audio", {}).get("waveform") is not None):
            try:
                from .lazy_yue_workbench import _lyric_seconds

                need = float(_lyric_seconds(str(pack.get("lyrics") or "")))
            except Exception:
                need = 0.0
            if need > max_duration:
                max_duration = min(900.0, need)

        try:
            steps = int(g("步数", 32))
        except Exception:
            steps = 32
        steps = min(150, max(1, steps))

        audio_in = pack.get("audio")
        has_audio = isinstance(audio_in, dict) and audio_in.get("waveform") is not None
        edited = bool(pack.get("score_edited"))
        original = str(pack.get("abc_raw") or "")
        plan = decide(
            has_audio,
            str(pack.get("abc") or ""),
            str(pack.get("mode") or "full"),
            bool(pack.get("make_score", True)),
            bool(pack.get("score_only", False)),
            edited,
            original,
        )
        mode = plan["mode"]
        action = plan["action"]
        kind = plan["kind"]
        if action == "keep" and not has_audio and not edited and not plan["score_only"]:
            try:
                from .lazy_yue_workbench import _score_too_short

                held = (original or str(pack.get("abc") or "")).strip()
                if _score_too_short(held, lyrics):
                    action = "plan"
            except Exception:
                pass

        if has_audio:
            sec = _audio_seconds(audio_in)
            if sec > 1.0:
                max_duration = min(max_duration, sec)
            audio_in = _fit_audio(audio_in, max_duration)

        abc = ""
        if action == "use":
            shown = str(pack.get("abc") or "").strip()
            if has_audio and original.strip() and shown:
                patched = _patch_cover_abc(original, shown)
                abc = patched or shown
                abc = _ensure_cover_voices(original, abc)
            else:
                abc = shown
        elif action in ("reuse", "keep"):
            abc = (original or str(pack.get("abc") or "")).strip()
        elif action == "transcribe":
            encoder = g("音频编码", None)
            if encoder is None:
                loader = _need("AudioEncoderLoader")
                encoder = _first(call_node_function(loader, audio_encoder_name=_pick_sheetsage()))
            sage = _need("SheetSage2AudioToABC")
            abc = _abc_text(_first(call_node_function(
                sage, audio_encoder=encoder, audio=audio_in, mode=mode,
            )))
            if not abc:
                raise RuntimeError("原曲没有转出乐谱。")
        elif action == "plan":
            planner = _need("YuE2GenerateABC")
            abc = _abc_text(_first(call_node_function(
                planner,
                clip=clip,
                style=style,
                lyrics=lyrics,
                seed=seed,
                mode=mode,
                max_abc_tokens=8192,
                temperature=0.7,
                top_p=0.9,
                top_k=30,
                repetition_penalty=1.005,
                penalty_window=100,
            )))
            if not abc:
                raise RuntimeError("没有写出乐谱。")

        if action in ("transcribe", "plan"):
            _push_abc(str(pack.get("node_id") or ""), abc, kind)

        if plan["score_only"]:
            if not abc:
                raise RuntimeError("没有可出的乐谱。请勾选出乐谱，或上传原曲。")
            info = f"{kind} · 只出乐谱 · {mode}"
            log.info("[LazyYuE] %s", info)
            try:
                from comfy_execution.graph_utils import ExecutionBlocker
                audio_out = ExecutionBlocker(None)
            except Exception:
                audio_out = _silence()
            return (audio_out, abc, info)

        music = _need("YuE2GenerateMusic")
        cond_out = call_node_function(
            music,
            clip=clip,
            style=style,
            lyrics=lyrics,
            abc=abc,
            seed=seed,
            mode=mode if abc else "full",
            max_duration=max_duration,
            temperature=1.0,
            top_p=0.95,
            top_k=100,
            repetition_penalty=1.2,
            cfg_scale=1.0 if abc else 1.01,
        )
        cond_vals = _outs(cond_out)
        if len(cond_vals) < 2:
            raise RuntimeError("生成条件失败。")
        positive = cond_vals[0]
        try:
            seconds = float(cond_vals[1])
        except Exception:
            seconds = max_duration
        seconds = min(1000.0, max(0.04, seconds))

        zero = _need("ConditioningZeroOut")
        negative = _first(call_node_function(zero, conditioning=positive))

        empty = _need("EmptyYuE2LatentAudio")
        latent = _first(call_node_function(empty, seconds=seconds, batch_size=1))

        sampler_name, scheduler = _sampler_pair()
        sampler = _need("KSampler")
        sampled = _first(call_node_function(
            sampler,
            model=model,
            seed=seed,
            steps=steps,
            cfg=1.0,
            sampler_name=sampler_name,
            scheduler=scheduler,
            positive=positive,
            negative=negative,
            latent_image=latent,
            denoise=1.0,
        ))

        decoder = _need("VAEDecodeAudio")
        audio = _first(call_node_function(decoder, vae=vae, samples=sampled))
        if not isinstance(audio, dict) or "waveform" not in audio:
            raise RuntimeError("音频解码失败。")

        src = {
            "use": "手改乐谱",
            "transcribe": "原曲转谱",
            "reuse": "原曲转谱",
            "plan": "自动出谱",
            "keep": "自动出谱",
            "off": "不出谱",
        }.get(action, action)
        info = f"{kind} · {src} · {mode if abc else 'off'} · {seconds:.1f}s · {steps}步"
        if action in ("plan", "transcribe"):
            info += " · 乐谱已回写"
        log.info("[LazyYuE] %s", info)
        return (audio, abc, info)


def _install_yue_finish():
    """歌词没唱完不许写结束符。乐谱也要盖住歌词行数。"""
    try:
        import comfy.text_encoders.yue2 as yue2
    except Exception as e:
        log.warning("[LazyYuE] 唱完保护没装上: %s", e)
        return
    if getattr(yue2, "_lazy_finish", False):
        return
    fps = int(getattr(yue2, "FRAMES_PER_SECOND", 25) or 25)

    orig_tok = yue2.YuE2Tokenizer.tokenize_with_weights

    def tokenize_with_weights(self, text, return_word_ids=False, **kwargs):
        out = orig_tok(self, text, return_word_ids=return_word_ids, **kwargs)
        if not isinstance(out, dict):
            return out
        try:
            from .lazy_yue_workbench import _lyric_lines, _lyric_seconds

            lyrics = str(kwargs.get("lyrics") or "")
            need = float(_lyric_seconds(lyrics))
            lines = int(_lyric_lines(lyrics))
            budget = int(out.get("max_tokens") or 0)
            budget_sec = (budget / float(fps)) if budget > 0 else 0.0
            if need <= 0 or budget <= 0:
                hold = 0
            elif budget_sec > need * 1.5:
                hold = int(need * 0.82 * fps)
            else:
                hold = int(min(budget_sec, max(need, budget_sec)) * 0.82 * fps)
            room = max(1, 2 * fps)
            if budget > 0:
                hold = min(max(0, hold), max(0, budget - room))
            out["lazy_sem_min"] = max(0, int(hold))
            abc_min = min(6000, max(160, lines * 28)) if lines >= 4 else 0
            out["lazy_abc_min"] = max(0, int(abc_min))
        except Exception:
            log.warning("[LazyYuE] 没能按歌词计算最短时长", exc_info=True)
        return out

    yue2.YuE2Tokenizer.tokenize_with_weights = tokenize_with_weights

    orig_step = yue2.YuE2TEModel._generate

    def _generate(self, prefix, seed, max_tokens, phase, dtype, negative=None, cfg_scale=1.0, legacy_off=False, **sampling):
        hold = 0
        if phase == "semantic":
            hold = int(getattr(self, "_lazy_sem_min", 0) or 0)
        elif phase == "abc":
            hold = int(getattr(self, "_lazy_abc_min", 0) or 0)
        if hold > 0:
            room = 48 if phase == "abc" else max(1, 2 * fps)
            cap = max(0, int(max_tokens) - room)
            cur = int(sampling.get("min_tokens") or 0)
            sampling = dict(sampling)
            sampling["min_tokens"] = min(cap, max(cur, hold))
        return orig_step(
            self, prefix, seed, max_tokens, phase, dtype,
            negative=negative, cfg_scale=cfg_scale, legacy_off=legacy_off, **sampling,
        )

    yue2.YuE2TEModel._generate = _generate

    orig_encode = yue2.YuE2TEModel.encode_token_weights

    def encode_token_weights(self, tokens):
        prev = getattr(self, "_lazy_sem_min", 0)
        if isinstance(tokens, dict):
            self._lazy_sem_min = int(tokens.get("lazy_sem_min") or 0)
        try:
            return orig_encode(self, tokens)
        finally:
            self._lazy_sem_min = prev

    yue2.YuE2TEModel.encode_token_weights = encode_token_weights

    orig_abc = yue2.YuE2TEModel.generate

    def generate(self, tokens, *args, **kwargs):
        prev = getattr(self, "_lazy_abc_min", 0)
        if isinstance(tokens, dict):
            hold = int(tokens.get("lazy_abc_min") or 0)
            try:
                max_length = int(kwargs.get("max_length") or 0)
            except Exception:
                max_length = 0
            if max_length <= 0 and args:
                try:
                    max_length = int(args[0])
                except Exception:
                    max_length = 0
            if max_length > 0:
                hold = min(hold, max(0, max_length - 48))
            self._lazy_abc_min = max(0, hold)
        try:
            return orig_abc(self, tokens, *args, **kwargs)
        finally:
            self._lazy_abc_min = prev

    yue2.YuE2TEModel.generate = generate
    yue2._lazy_finish = True
    log.info("[LazyYuE] 已按歌词拦住提前结束")


def _sampler_pair():
    try:
        import comfy.samplers as samplers

        names = list(samplers.KSampler.SAMPLERS)
        scheds = list(samplers.KSampler.SCHEDULERS)
    except Exception:
        names, scheds = ["dpm_2"], ["sgm_uniform"]
    name = "dpm_2" if "dpm_2" in names else (names[0] if names else "euler")
    sched = "sgm_uniform" if "sgm_uniform" in scheds else (scheds[0] if scheds else "normal")
    return name, sched


_install_yue_finish()
