"""
Lazy YuE 工作台：风格 / 歌词 / 参考原曲 / 乐谱 → YUE_PACK。
参考轨有原曲 = 翻唱，没有 = 直接生成。多段按时间线拼成一条，没有段落时按开始/结束裁切。
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading

import torch

from .lazy_h3_common import call_node_function, resolve_h3_node

log = logging.getLogger(__name__)

def _style_path() -> str:
    from .lazy_user_store import ensure_user_store, yue_styles_path

    ensure_user_store()
    return yue_styles_path()


_style_lock = threading.Lock()
_routes_ready = False
_yue_route_keys = set()
_whisper_lock = threading.Lock()
_whisper_model = None


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


def _load_audio_file(name: str):
    name = (name or "").strip()
    if not name:
        return None
    node = resolve_h3_node("LoadAudio")
    if node is None:
        raise RuntimeError("当前环境读不了音频。")
    try:
        out = call_node_function(node, audio=name)
    except Exception as e:
        raise RuntimeError(f"原曲读取失败：{name}") from e
    audio = _outs(out)[0] if _outs(out) else None
    if not isinstance(audio, dict) or "waveform" not in audio:
        raise RuntimeError(f"原曲读取失败：{name}")
    return audio


def _style_items() -> list:
    path = _style_path()
    if not os.path.isfile(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        log.warning("[LazyYuE] 读自定义风格失败: %s", e)
        return []
    if not isinstance(data, list):
        return []
    out = []
    for raw in data:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or "").strip()
        if not name:
            continue
        out.append({"name": name, "prompt": str(raw.get("prompt") or "")})
    return out


def _write_styles(items: list) -> None:
    path = _style_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)


def save_yue_style(name: str, prompt: str, old_name: str = "") -> dict:
    name = str(name or "").strip()
    old_name = str(old_name or "").strip()
    prompt = str(prompt or "")
    if not name or len(name) > 40:
        raise ValueError("请填写名字")
    with _style_lock:
        items = _style_items()
        if any(it["name"] == name and it["name"] != old_name for it in items):
            raise ValueError("已经存在")
        kept = [it for it in items if it["name"] not in (name, old_name)]
        item = {"name": name, "prompt": prompt}
        kept.append(item)
        _write_styles(kept)
        return item


def remove_yue_style(name: str) -> None:
    name = str(name or "").strip()
    with _style_lock:
        items = [it for it in _style_items() if it["name"] != name]
        _write_styles(items)


# 唱法靠这些词区分。多种语言可以一起选，写在风格最前。
_LANG_TAG = {
    "普通话": "Mandarin",
    "粤语": "Cantonese",
    "英语": "English",
    "日语": "Japanese",
    "韩语": "Korean",
    "闽南语": "Hokkien",
    "客家话": "Hakka",
    "法语": "French",
    "西班牙语": "Spanish",
    "葡萄牙语": "Portuguese",
    "意大利语": "Italian",
    "德语": "German",
    "俄语": "Russian",
    "阿拉伯语": "Arabic",
    "印地语": "Hindi",
    "泰语": "Thai",
    "越南语": "Vietnamese",
    "印尼语": "Indonesian",
    "马来语": "Malay",
    "土耳其语": "Turkish",
    "荷兰语": "Dutch",
    "瑞典语": "Swedish",
    "波兰语": "Polish",
    "希腊语": "Greek",
    "乌克兰语": "Ukrainian",
    "菲律宾语": "Filipino",
    "波斯语": "Persian",
    "希伯来语": "Hebrew",
    "拉丁语": "Latin",
}
_VOCAL = {
    "女声": "female vocal",
    "男声": "male vocal",
    "对唱": "male and female duet",
    "合唱": "choir vocals",
    "童声": "child vocal",
    "说唱": "rap vocal",
    "戏腔": "xiqu opera vocal",
    "吟唱": "chanted vocal",
    "假声": "falsetto vocal",
    "无人声": "instrumental, no lead vocal, no singing",
}
_TIMBRE = {
    "甜美": "sweet vocal",
    "沙哑": "raspy vocal",
    "磁性": "magnetic warm vocal",
    "清亮": "crystal clear vocal",
    "低沉": "very low vocal",
    "高亢": "powerful belting vocal",
    "气声": "breathy vocal",
    "沧桑": "weathered vocal",
    "空灵": "ethereal vocal",
    "柔和": "soft vocal",
    "温暖": "warm vocal",
    "冷感": "cold distant vocal",
    "烟嗓": "smoky vocal",
    "撕裂": "harsh screamed vocal",
    "醇厚": "rich chest vocal",
    "稚嫩": "youthful vocal",
    "慵懒": "lazy crooning vocal",
    "耳语": "whisper vocal",
    "鼻音": "nasal vocal",
    "圆润": "rounded vocal",
    "歌剧腔": "operatic vocal",
}
_GENRE = {
    "流行": "modern pop",
    "抒情": "piano ballad",
    "民谣": "folk",
    "摇滚": "rock",
    "硬摇": "hard rock",
    "朋克": "punk",
    "流行朋克": "pop punk",
    "金属": "heavy metal",
    "黑金属": "black metal",
    "死亡金属": "death metal",
    "新金属": "nu metal",
    "电子": "electronic",
    "舞曲": "EDM dance",
    "浩室": "house",
    "科技舞曲": "techno",
    "出神": "trance",
    "鼓打贝斯": "drum and bass",
    "回响贝斯": "dubstep",
    "未来贝斯": "future bass",
    "热带浩室": "tropical house",
    "嘻哈": "hip hop",
    "陷阱": "trap",
    "爵士": "jazz",
    "爵士嘻哈": "jazz hop",
    "R&B": "contemporary R&B",
    "灵魂": "soul",
    "新灵魂": "neo soul",
    "放克": "funk",
    "布鲁斯": "blues",
    "雷鬼": "reggae",
    "舞厅": "dancehall",
    "斯卡": "ska",
    "雷鬼顿": "reggaeton",
    "乡村": "country",
    "迪斯科": "disco",
    "合成器": "synthwave",
    "蒸汽波": "vaporwave",
    "暗潮": "darkwave",
    "城市流行": "city pop",
    "梦泡": "dream pop",
    "独立": "indie",
    "另类": "alternative",
    "后摇": "post-rock",
    "前卫": "progressive rock",
    "华丽摇滚": "glam rock",
    "车库": "garage rock",
    "哥特": "gothic",
    "工业": "industrial",
    "迷幻": "psychedelic",
    "氛围": "ambient",
    "轻音乐": "easy listening",
    "古典": "classical",
    "交响": "orchestral cinematic",
    "室内乐": "chamber music",
    "歌剧": "opera",
    "古风": "guzheng dizi erhu pentatonic",
    "戏曲": "xiqu opera jinghu banqiang",
    "新国风": "modern folk-pop with guzheng and dizi",
    "拉丁": "latino",
    "波萨诺瓦": "bossa nova",
    "萨尔萨": "salsa",
    "探戈": "tango",
    "弗拉门戈": "flamenco",
    "福音": "gospel",
    "洛菲": "lo-fi",
    "芯片": "8-bit chiptune",
    "电影": "cinematic film score",
    "史诗": "epic trailer music",
    "儿歌": "children song",
    "摇篮曲": "lullaby",
    "进行曲": "march",
    "实验": "experimental",
    "噪音": "noise music",
    "非洲节拍": "afrobeats",
    "世界": "world music",
}
_GEAR = {
    "钢琴": "piano",
    "电钢": "electric piano",
    "风琴": "organ",
    "手风琴": "accordion",
    "木吉他": "acoustic guitar",
    "电吉他": "electric guitar",
    "贝斯": "bass",
    "鼓": "drums",
    "电子鼓": "electronic drums",
    "808": "808 bass and drums",
    "弦乐": "strings",
    "小提琴": "violin",
    "大提琴": "cello",
    "竖琴": "harp",
    "古筝": "guzheng",
    "琵琶": "pipa",
    "二胡": "erhu",
    "笛子": "dizi",
    "箫": "xiao",
    "唢呐": "suona",
    "古琴": "guqin",
    "扬琴": "yangqin",
    "笙": "sheng",
    "葫芦丝": "hulusi",
    "马头琴": "morin khuur",
    "萨克斯": "saxophone",
    "小号": "trumpet",
    "长号": "trombone",
    "圆号": "horn",
    "长笛": "flute",
    "单簧管": "clarinet",
    "双簧管": "oboe",
    "口琴": "harmonica",
    "尤克里里": "ukulele",
    "班卓": "banjo",
    "曼陀林": "mandolin",
    "合成器": "synthesizer",
    "钟琴": "glockenspiel",
    "马林巴": "marimba",
    "木琴": "xylophone",
    "定音鼓": "timpani",
    "康加": "congas",
    "卡洪": "cajon",
    "太鼓": "taiko",
    "三味线": "shamisen",
    "尺八": "shakuhachi",
}
_MOOD = {
    "浪漫": "romantic",
    "伤感": "sad melancholic",
    "欢快": "cheerful",
    "治愈": "healing",
    "热血": "heroic fiery",
    "安静": "quiet",
    "紧张": "tense",
    "史诗": "epic",
    "神秘": "mysterious",
    "暗黑": "dark",
    "梦幻": "dreamy",
    "怀旧": "nostalgic",
    "孤独": "lonely",
    "甜蜜": "sweet",
    "愤怒": "angry",
    "平静": "peaceful",
    "希望": "hopeful",
    "压抑": "oppressive",
    "俏皮": "playful",
    "庄严": "solemn",
    "清冷": "cold and distant",
    "激昂": "passionate",
    "思念": "longing",
    "释然": "relieved",
    "恐怖": "horror",
    "温柔": "tender",
    "节日": "festive",
    "神圣": "sacred",
}
def _lang_chunk():
    words = set(_LANG_TAG) | set(_LANG_TAG.values())
    words.update({
        "Chinese", "Mandarin", "Cantonese", "English", "Japanese", "Korean",
        "Hokkien", "Hakka", "Taiwanese", "French", "Spanish", "Portuguese",
        "Italian", "German", "Russian", "Arabic", "Hindi", "Thai", "Vietnamese",
        "Indonesian", "Malay", "Turkish", "Dutch", "Swedish", "Polish", "Greek",
        "Ukrainian", "Filipino", "Persian", "Hebrew", "Latin",
        "普通话", "广东话", "粤语", "国语", "英语", "日语", "韩语", "中文",
        "闽南语", "客家话", "台语",
    })
    ascii_words = sorted((w for w in words if w.isascii()), key=len, reverse=True)
    other = sorted((w for w in words if not w.isascii()), key=len, reverse=True)
    parts = []
    if ascii_words:
        parts.append(r"(?i)\b(?:" + "|".join(re.escape(w) for w in ascii_words) + r")(?:[ \t]+(?:lyrics|pronunciation))?\b")
    if other:
        parts.append("(?:" + "|".join(re.escape(w) for w in other) + ")")
    return re.compile("|".join(parts)) if parts else re.compile(r"(?!)")


_LANG_CHUNK = _lang_chunk()


def _tidy_style(text: str) -> str:
    text = str(text or "").replace("，", ",")
    parts = []
    for part in text.split(","):
        item = " ".join(part.split()).strip()
        if item:
            parts.append(item)
    return ", ".join(parts)


def _split_picks(text, table) -> list:
    raw = str(text or "").strip()
    if not raw or raw == "不指定":
        return []
    out = []
    seen = set()
    for part in re.split(r"[,，、|/]+", raw):
        name = part.strip()
        if not name or name == "不指定" or name not in table or name in seen:
            continue
        seen.add(name)
        out.append(name)
    return out


def _apply_langs(text: str, langs) -> str:
    """选了的语言放到最前，并去掉风格里原来的语种词。"""
    tags = []
    for name in langs or []:
        tag = _LANG_TAG.get(name)
        if tag and tag not in tags:
            tags.append(tag)
    body = _tidy_style(text)
    if not tags:
        return body
    body = _tidy_style(_LANG_CHUNK.sub(" ", body))
    prefix = ", ".join(tags)
    if not body or body in tags:
        return prefix
    return f"{prefix}, {body}"


def _compose_style(text, lang, vocal, timbre, genre, bpm, gear="", mood="") -> str:
    """风格框里的字保留。点选的语言、曲风、人声、嗓音、配器、情绪、速度都叠上去，可多选。"""
    raw = str(text or "").strip()
    langs = _split_picks(lang, _LANG_TAG)
    vocals = _split_picks(vocal, _VOCAL)
    timbres = _split_picks(timbre, _TIMBRE)
    genres = _split_picks(genre, _GENRE)
    gears = _split_picks(gear, _GEAR)
    moods = _split_picks(mood, _MOOD)
    if "无人声" in vocals:
        vocals = ["无人声"]
        timbres = []
    extra = []
    for table, names in (
        (_VOCAL, vocals),
        (_TIMBRE, timbres),
        (_GENRE, genres),
        (_GEAR, gears),
        (_MOOD, moods),
    ):
        for name in names:
            extra.append(table[name])
    try:
        bpm = int(float(bpm or 0))
    except Exception:
        bpm = 0
    if bpm < 0:
        bpm = 0
    if bpm > 0:
        extra.append(f"{bpm} BPM")
    body = raw
    if extra:
        tail = ", ".join(extra)
        body = f"{body}, {tail}" if body else tail
    return _apply_langs(body, langs)


def _lyric_stats(lyrics: str) -> tuple:
    """返回 (演唱行数, 建议秒数)。空歌词秒数为 0。"""
    sections = 0
    lines = 0
    cjk = 0
    latin = 0
    for raw in str(lyrics or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        if re.match(r"^\[.*\]$", line):
            sections += 1
            continue
        lines += 1
        for ch in line:
            if "\u4e00" <= ch <= "\u9fff" or "\u3400" <= ch <= "\u4dbf":
                cjk += 1
            elif ch.isascii() and ch.isalpha():
                latin += 1
    if lines <= 0:
        return 0, 0.0
    sung = max(cjk / 2.8 + latin / 12.0, lines * 4.0)
    sung += max(sections, 1) * 3.0 + 10.0
    return lines, min(900.0, max(24.0, sung))


def _lyric_lines(lyrics: str) -> int:
    return int(_lyric_stats(lyrics)[0])


def _lyric_seconds(lyrics: str) -> float:
    return float(_lyric_stats(lyrics)[1])


def _with_length(style: str, seconds: float) -> str:
    """告诉模型要把整段歌词唱完，并给出大约时长。"""
    try:
        sec = int(round(float(seconds or 0)))
    except Exception:
        return str(style or "").strip()
    if sec < 45:
        return str(style or "").strip()
    minutes = max(1, (sec + 59) // 60)
    if minutes == 1:
        cue = "full song about one minute, sing every lyric line to the end"
    else:
        cue = f"full song about {minutes} minutes, sing every lyric line to the end"
    body = str(style or "").strip().rstrip(",")
    if "sing every lyric line" in body.lower():
        return body
    return f"{body}, {cue}" if body else cue


def _score_note_seconds(text: str) -> float:
    raw = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    if not raw.strip():
        return 0.0
    if not re.search(r"(?m)^V\s*:", raw):
        info = _abc_scan(raw)
        if not info.get("has_note"):
            return 0.0
        return float(_abc_ticks_to_sec(int(info["note_end"]), _abc_round_bpm(info["bpm"])))
    bpm = 120.0
    meter = "4/4"
    qm = re.search(r"(?m)^Q:\s*(.+)$", raw)
    if qm:
        got = _abc_bpm(qm.group(1))
        if got > 0:
            bpm = got
    mm = re.search(r"(?m)^M:\s*(.+)$", raw)
    if mm:
        meter = _abc_meter(mm.group(1))
    bars = 0
    for voice in re.split(r"(?m)^V\s*:", raw)[1:]:
        body = voice.split("\n", 1)[1] if "\n" in voice else ""
        bars = max(bars, len(re.findall(r"\|", body)))
    if bars <= 0:
        return 0.0
    try:
        beats = float(str(meter).split("/")[0])
    except Exception:
        beats = 4.0
    if beats <= 0:
        beats = 4.0
    return bars * beats * 60.0 / max(float(bpm), 1.0)


def _score_too_short(text: str, lyrics: str) -> bool:
    """乐谱明显盖不住歌词时，这次重新写谱。"""
    need = _lyric_seconds(lyrics)
    note = _score_note_seconds(text)
    return bool(need >= 24.0 and note > 0.0 and note + 8.0 < need * 0.75)


def _yue_json(payload, status: int = 200):
    from aiohttp import web

    resp = web.json_response(payload, status=status)
    resp.headers["Cache-Control"] = "no-store"
    return resp


async def _yue_style_list(_request):
    return _yue_json({"ok": True, "items": _style_items()})


async def _yue_style_post(request):
    if str(getattr(request, "method", "") or "").upper() == "GET":
        return await _yue_style_list(request)
    try:
        data = await request.json()
    except Exception:
        data = {}
    if not isinstance(data, dict):
        data = {}
    action = str(data.get("action") or "save").strip().lower()
    try:
        if action == "delete":
            remove_yue_style(str(data.get("name") or ""))
            return _yue_json({"ok": True, "items": _style_items()})
        item = save_yue_style(
            str(data.get("name") or ""),
            str(data.get("prompt") or ""),
            str(data.get("old_name") or ""),
        )
        return _yue_json({"ok": True, "item": item, "items": _style_items()})
    except Exception as e:
        return _yue_json({"ok": False, "error": str(e), "items": _style_items()}, 400)


def _yue_try_route(method: str, path: str, fn) -> bool:
    key = (method, path)
    if key in _yue_route_keys:
        return True
    try:
        from server import PromptServer

        server = getattr(PromptServer, "instance", None)
        if server is None or not hasattr(server, "routes"):
            return False
        getattr(server.routes, method)(path)(fn)
        _yue_route_keys.add(key)
        return True
    except Exception as e:
        log.warning("[LazyYuE] 注册路由失败 %s %s: %s", method, path, e)
        return False


def ensure_yue_routes() -> None:
    """自定义风格列表。可重复调用。"""
    global _routes_ready
    specs = (
        ("get", "/lazy_yue/style_list", _yue_style_list),
        ("get", "/lazy_yue/styles", _yue_style_list),
        ("post", "/lazy_yue/styles", _yue_style_post),
    )
    ok = True
    for method, path, fn in specs:
        if not _yue_try_route(method, path, fn):
            ok = False
    _routes_ready = ok


def _parse_clips(raw, fallback_name: str = "") -> list:
    """段落：时间线 t0/t1，原曲 s0/s1，单位秒。name 是这一段的文件。"""
    if not raw:
        return []
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    fallback_name = str(fallback_name or "").strip()
    out = []
    for item in data:
        if not isinstance(item, dict):
            continue
        try:
            t0 = float(item.get("t0", 0) or 0)
            t1 = float(item.get("t1", 0) or 0)
            s0 = float(item.get("s0", 0) or 0)
            s1 = float(item.get("s1", 0) or 0)
        except Exception:
            continue
        if t1 - t0 < 0.02 or s1 - s0 < 0.02:
            continue
        name = str(item.get("name") or fallback_name or "").strip()
        out.append({
            "t0": max(0.0, t0),
            "t1": t1,
            "s0": max(0.0, s0),
            "s1": s1,
            "name": name,
        })
    out.sort(key=lambda x: x["t0"])
    for i in range(1, len(out)):
        if out[i]["t0"] < out[i - 1]["t1"]:
            shift = out[i - 1]["t1"] - out[i]["t0"]
            out[i]["t0"] += shift
            out[i]["t1"] += shift
    return out


def _clip_tuples(clips: list) -> list:
    return [(c["t0"], c["t1"], c["s0"], c["s1"]) for c in clips]


def _as_bct(wf):
    if wf.ndim == 1:
        return wf.reshape(1, 1, -1)
    if wf.ndim == 2:
        return wf.unsqueeze(0)
    if wf.ndim == 3:
        return wf
    raise RuntimeError("原曲格式不对。")


def _match_channels(wf, channels: int):
    c = int(wf.shape[1])
    if c == channels:
        return wf
    if c == 1 and channels > 1:
        return wf.repeat(1, channels, 1)
    if c > channels:
        return wf[:, :channels]
    pad = wf[:, -1:].repeat(1, channels - c, 1)
    return torch.cat((wf, pad), dim=1)


def _resample(wf, src_sr: int, dst_sr: int):
    if src_sr == dst_sr or src_sr <= 0 or dst_sr <= 0:
        return wf
    n = int(wf.shape[-1])
    new_n = max(1, int(round(n * float(dst_sr) / float(src_sr))))
    if new_n == n:
        return wf
    flat = wf.reshape(-1, 1, n).float()
    out = torch.nn.functional.interpolate(flat, size=new_n, mode="linear", align_corners=False)
    return out.reshape(wf.shape[0], wf.shape[1], new_n).to(dtype=wf.dtype)


def _render_named_clips(clips: list) -> dict:
    """多段不同原曲按时间线拼成一条。空隙为静音。"""
    loaded = {}
    for clip in clips:
        name = str(clip.get("name") or "").strip()
        if not name or name in loaded:
            continue
        loaded[name] = _load_audio_file(name)
    if not loaded:
        return None
    first = next(iter(loaded.values()))
    sr = int(first.get("sample_rate") or 44100)
    if sr <= 0:
        sr = 44100
    prepared = {}
    channels = 1
    for name, audio in loaded.items():
        wf = _as_bct(audio["waveform"])
        src_sr = int(audio.get("sample_rate") or sr)
        wf = _resample(wf, src_sr, sr)
        channels = max(channels, int(wf.shape[1]))
        prepared[name] = wf
    for name in list(prepared):
        prepared[name] = _match_channels(prepared[name], channels)
    ref = next(iter(prepared.values()))
    total_t = min(900.0, max(float(c["t1"]) for c in clips))
    total = max(1, int(round(total_t * sr)))
    out_w = torch.zeros(1, channels, total, dtype=ref.dtype, device=ref.device)
    for clip in clips:
        wf = prepared.get(str(clip.get("name") or "").strip())
        if wf is None:
            continue
        n = int(wf.shape[-1])
        dur = n / float(sr)
        t0 = max(0.0, float(clip["t0"]))
        if t0 >= 900.0:
            continue
        s0 = min(max(0.0, float(clip["s0"])), dur)
        s1 = min(dur, max(s0, float(clip["s1"])))
        length = min(float(clip["t1"]) - t0, s1 - s0)
        if length < 0.02:
            continue
        i0 = max(0, min(n - 1, int(round(s0 * sr))))
        i1 = max(i0 + 1, min(n, int(round((s0 + length) * sr))))
        d0 = max(0, min(total - 1, int(round(t0 * sr))))
        take = min(i1 - i0, total - d0)
        if take <= 0:
            continue
        out_w[..., d0:d0 + take] = wf[0:1, :, i0:i0 + take]
    return {"waveform": out_w.contiguous(), "sample_rate": sr}


def _render_clips(audio: dict, clips: list) -> dict:
    """按时间线摆回原曲。空隙和开头留白为静音，只删掉的段落不会再出现。"""
    if not isinstance(audio, dict) or audio.get("waveform") is None or not clips:
        return audio
    try:
        import torch
    except Exception:
        return audio
    wf = audio["waveform"]
    try:
        sr = int(audio.get("sample_rate") or 44100)
        n = int(wf.shape[-1])
    except Exception:
        return audio
    if sr <= 0 or n <= 1:
        return audio
    dur = n / float(sr)
    placed = []
    for t0, t1, s0, s1 in clips:
        s0 = min(max(0.0, s0), dur)
        s1 = min(dur, max(s0, s1))
        length = min(t1 - t0, s1 - s0)
        if length < 0.02:
            continue
        placed.append((max(0.0, t0), max(0.0, t0) + length, s0, s0 + length))
    if not placed:
        return audio
    total = max(1, int(round(min(900.0, max(item[1] for item in placed)) * sr)))
    try:
        out_w = torch.zeros(*wf.shape[:-1], total, dtype=wf.dtype, device=wf.device)
    except Exception:
        return audio
    for t0, t1, s0, s1 in placed:
        if t0 >= 900.0:
            continue
        i0 = max(0, min(n - 1, int(round(s0 * sr))))
        i1 = max(i0 + 1, min(n, int(round(s1 * sr))))
        d0 = max(0, min(total - 1, int(round(t0 * sr))))
        take = min(i1 - i0, total - d0)
        if take <= 0:
            continue
        out_w[..., d0:d0 + take] = wf[..., i0:i0 + take]
    out = dict(audio)
    out["waveform"] = out_w.contiguous()
    return out


def _crop_audio(audio: dict, start, end) -> dict:
    """按秒裁参考曲。结束小于等于开始时保留到结尾。"""
    if not isinstance(audio, dict) or audio.get("waveform") is None:
        return audio
    wf = audio["waveform"]
    try:
        sr = int(audio.get("sample_rate") or 44100)
        n = int(wf.shape[-1])
    except Exception:
        return audio
    if sr <= 0 or n <= 1:
        return audio
    dur = n / float(sr)
    try:
        s = max(0.0, float(start or 0))
    except Exception:
        s = 0.0
    try:
        e = float(end or 0)
    except Exception:
        e = 0.0
    if e <= s:
        e = dur
    e = min(dur, max(s, e))
    s = min(s, max(0.0, e - 0.04))
    i0 = max(0, min(n - 1, int(round(s * sr))))
    i1 = max(i0 + 1, min(n, int(round(e * sr))))
    if i0 <= 0 and i1 >= n:
        return audio
    out = dict(audio)
    out["waveform"] = wf[..., i0:i1].contiguous()
    return out


_ABC_TICK = 1680


def _abc_gcd(a: int, b: int) -> int:
    a, b = abs(int(a)), abs(int(b))
    while b:
        a, b = b, a % b
    return a or 1


def _abc_meter(raw: str) -> str:
    text = str(raw or "4/4").strip()
    if text == "C|":
        return "2/2"
    if text == "C":
        return "4/4"
    match = re.match(r"(\d+)\s*/\s*(\d+)", text)
    return f"{match.group(1)}/{match.group(2)}" if match else "4/4"


def _abc_bar_ticks(meter: str) -> int:
    match = re.match(r"(\d+)/(\d+)$", _abc_meter(meter))
    six = max(1, int(round(int(match.group(1)) * 16 / int(match.group(2)))))
    return six * _ABC_TICK


def _abc_unit_ticks(raw: str) -> int:
    match = re.match(r"\s*(\d+)\s*/\s*(\d+)", str(raw or "1/8"))
    if not match:
        return 2 * _ABC_TICK
    return max(1, int(round(_ABC_TICK * 16 * int(match.group(1)) / int(match.group(2)))))


def _abc_bpm(raw: str) -> float:
    text = str(raw or "").strip()
    if not text:
        return 0.0
    eq = re.match(r"^(.*?)=\s*(\d+(?:\.\d+)?)", text)
    if eq:
        bpm = float(eq.group(2))
        left = re.search(r"(\d+)\s*/\s*(\d+)", eq.group(1))
        if left:
            return bpm * 4 * int(left.group(1)) / int(left.group(2))
        return bpm
    only = re.search(r"(\d+(?:\.\d+)?)", text)
    return float(only.group(1)) if only else 0.0


def _abc_round_bpm(bpm: float) -> int:
    try:
        n = int(round(float(bpm or 0)))
    except Exception:
        n = 0
    return n if n > 0 else 120


def _abc_sec_to_ticks(sec: float, bpm: float) -> int:
    b = _abc_round_bpm(bpm)
    return max(0, int(round(float(sec or 0) * b / 15.0))) * _ABC_TICK


def _abc_ticks_to_sec(ticks: int, bpm: float) -> float:
    b = _abc_round_bpm(bpm)
    return (int(ticks) / _ABC_TICK) * 15.0 / b


def _abc_len_suffix(ticks: int, unit: int) -> str:
    num = int(round(ticks))
    den = int(round(unit)) or _ABC_TICK
    if num <= 0:
        num = den
    g = _abc_gcd(num, den)
    num //= g
    den //= g
    if den == 1:
        return "" if num == 1 else str(num)
    if num == 1:
        return "/" if den == 2 else f"/{den}"
    return f"{num}/{den}"


def _abc_read_len(text: str, i: int) -> dict:
    num = None
    den = None
    used = False
    n = len(text)
    if i < n and text[i].isdigit():
        used = True
        num = 0
        while i < n and text[i].isdigit():
            num = num * 10 + ord(text[i]) - 48
            i += 1
    if i < n and text[i] == "/":
        used = True
        i += 1
        den = 0
        while i < n and text[i].isdigit():
            den = den * 10 + ord(text[i]) - 48
            i += 1
        if not den:
            den = 2
    dots = 0
    while i < n and text[i] == ".":
        used = True
        dots += 1
        i += 1
    tie = False
    if i < n and text[i] == "-":
        used = True
        tie = True
        i += 1
    return {"next": i, "num": num, "den": den, "dots": dots, "tie": tie, "used": used}


def _abc_read_note(text: str, i: int):
    n = len(text)
    if i >= n:
        return None
    acc = None
    if text.startswith("^^", i):
        acc = 2
        i += 2
    elif text.startswith("__", i):
        acc = -2
        i += 2
    elif text[i] == "^":
        acc = 1
        i += 1
    elif text[i] == "_":
        acc = -1
        i += 1
    elif text[i] == "=":
        acc = 0
        i += 1
    if i >= n or text[i] not in "ABCDEFGabcdefgzxZ":
        return None
    letter = text[i]
    i += 1
    if letter not in "zxZ":
        while i < n and text[i] == ",":
            i += 1
        while i < n and text[i] == "'":
            i += 1
    length = _abc_read_len(text, i)
    length["letter"] = letter
    length["rest"] = letter in "zxZ"
    length["acc"] = acc
    return length


def _abc_token_ticks(tok: dict, unit: int) -> int:
    num = 1 if tok.get("num") is None else int(tok["num"])
    den = 1 if tok.get("den") is None else int(tok["den"])
    ticks = max(1, int(round(unit * num / den)))
    add = ticks
    for _ in range(int(tok.get("dots") or 0)):
        add //= 2
        ticks += add
    return ticks


def _abc_scan(text: str) -> dict:
    raw = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    lines = raw.split("\n")
    meter = "4/4"
    unit = _abc_unit_ticks("1/8")
    bpm = 0.0
    body_at = 0
    seen = False
    offset = 0
    for line in lines:
        trim = line.strip()
        line_end = offset + len(line) + 1
        if not seen:
            if not trim or trim.startswith("%"):
                offset = min(len(raw), line_end)
                continue
            head = re.match(r"^([A-Za-z]):\s*(.*)$", trim)
            if head:
                key = head.group(1).upper()
                if key == "K":
                    km = re.match(r"^(\S+)\s*(.*)$", head.group(2) or "")
                    body_at = offset + line.find(head.group(2)) if head.group(2) else line_end
                    if km and km.group(2):
                        body_at = offset + line.find(km.group(2))
                    else:
                        body_at = min(len(raw), line_end)
                    seen = True
                    break
                if key in "XTMLQ":
                    if key == "M":
                        meter = _abc_meter(head.group(2))
                    elif key == "L":
                        unit = _abc_unit_ticks(head.group(2))
                    elif key == "Q":
                        got = _abc_bpm(head.group(2))
                        if got > 0:
                            bpm = got
                    offset = min(len(raw), line_end)
                    continue
            body_at = offset
            seen = True
            break
        offset = min(len(raw), line_end)
    if not seen:
        body_at = len(raw)
    s = raw[body_at:]
    pos = 0
    note_end = 0
    cut_rel = 0
    has_note = False
    i = 0
    tup = None
    broken = None
    last_dur = 0
    bar_re = re.compile("^(?:" + "|".join([r"\|\]", r"\|\|", r"\[\|", r"\|:", r":\|", "::", r"\|"]) + ")")
    while i < len(s):
        ch = s[i]
        if ch in " \t\r":
            i += 1
            continue
        if ch == "\n":
            i += 1
            field = re.match(r"^([A-Za-z]):[^\n]*", s[i:])
            if field:
                key = field.group(1).upper()
                val = field.group(0)[2:].strip()
                if key == "M":
                    meter = _abc_meter(val)
                elif key == "L":
                    unit = _abc_unit_ticks(val)
                elif key == "Q":
                    got = _abc_bpm(val)
                    if got > 0:
                        bpm = got
                elif key in ("V", "X"):
                    break
                i += len(field.group(0))
            continue
        if ch == "%":
            while i < len(s) and s[i] != "\n":
                i += 1
            continue
        if ch == "\\":
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
        if ch == "!" or (ch == "+" and i + 1 < len(s) and s[i + 1].isalpha()):
            j = s.find(ch, i + 1)
            i = len(s) if j < 0 else j + 1
            continue
        bar = bar_re.match(s[i:])
        if bar:
            i += len(bar.group(0))
            while i < len(s) and s[i] in "0123456789,-":
                i += 1
            continue
        if ch == "[":
            close = s.find("]", i + 1)
            if close < 0 or close - i > 80:
                i += 1
                continue
            inline = re.match(r"^\[([A-Za-z]):([^\]]*)\]", s[i:])
            if inline:
                key = inline.group(1).upper()
                if key == "M":
                    meter = _abc_meter(inline.group(2))
                elif key == "L":
                    unit = _abc_unit_ticks(inline.group(2))
                elif key == "Q":
                    got = _abc_bpm(inline.group(2))
                    if got > 0:
                        bpm = got
                i += len(inline.group(0))
                continue
            if re.match(r"^\[\d", s[i:]):
                i += 1
                while i < len(s) and s[i] not in "]|":
                    i += 1
                if i < len(s) and s[i] == "]":
                    i += 1
                continue
            i += 1
            best = None
            while i < len(s) and s[i] != "]":
                if s[i] in " \n":
                    i += 1
                    continue
                tok = _abc_read_note(s, i)
                if not tok:
                    i += 1
                    continue
                i = tok["next"]
                if not tok["rest"]:
                    ticks = _abc_token_ticks(tok, unit)
                    if best is None:
                        best = ticks
            if i < len(s) and s[i] == "]":
                i += 1
            tail = _abc_read_len(s, i)
            i = tail["next"]
            if best is not None:
                ticks = _abc_token_ticks(tail, unit) if tail["used"] else best
                ticks, last_dur, pos = _abc_apply_time(ticks, pos, tup, broken, last_dur)
                tup = tup if tup and tup["left"] > 0 else None
                broken = None
                note_end = pos
                has_note = True
                cut_rel = i
                last_dur = ticks
            continue
        if ch == "(" and i + 1 < len(s) and s[i + 1].isdigit():
            tm = re.match(r"^\((\d+)(?::(\d+))?(?::(\d+))?", s[i:])
            p = max(2, int(tm.group(1)))
            defaults = {2: 3, 3: 2, 4: 3, 5: 4, 6: 2, 7: 4, 8: 3, 9: 4}
            q = int(tm.group(2)) if tm.group(2) else defaults.get(p, 2)
            r = int(tm.group(3)) if tm.group(3) else p
            tup = {"left": max(1, r), "p": p, "q": q}
            i += len(tm.group(0))
            continue
        if ch in "~uvHLMOPST":
            i += 1
            continue
        if ch == "." and i + 1 < len(s) and s[i + 1] in "^_=ABCDEFGabcdefgzxZ":
            i += 1
            continue
        tok = _abc_read_note(s, i)
        if not tok:
            i += 1
            continue
        i = tok["next"]
        br = re.match(r"^(<{1,3}|>{1,3})", s[i:])
        mark = None
        if br:
            count = len(br.group(1))
            long = (2 ** (count + 1) - 1) / (2 ** count)
            short = 1 / (2 ** count)
            mark = (long, short) if br.group(1)[0] == ">" else (short, long)
            i += len(br.group(1))
        ticks = _abc_bar_ticks(meter) if tok["letter"] == "Z" and not tok["used"] else _abc_token_ticks(tok, unit)
        if tok["rest"]:
            if tup and tup["left"] > 0:
                ticks = max(1, int(round(ticks * tup["q"] / tup["p"])))
                tup["left"] -= 1
                if tup["left"] <= 0:
                    tup = None
            broken = None
            last_dur = 0
            pos += ticks
            continue
        ticks, last_dur, pos = _abc_apply_time(ticks, pos, tup, broken, last_dur)
        if tup and tup["left"] <= 0:
            tup = None
        broken = mark
        note_end = pos
        has_note = True
        cut_rel = i
        last_dur = ticks
    return {
        "raw": raw,
        "meter": meter,
        "unit": unit,
        "bpm": bpm,
        "note_end": note_end,
        "total": pos,
        "has_note": has_note,
        "cut": body_at + cut_rel,
    }


def _abc_apply_time(ticks: int, pos: int, tup, broken, last_dur: int):
    dur = max(1, int(round(ticks)))
    if tup and tup.get("left", 0) > 0:
        dur = max(1, int(round(dur * tup["q"] / tup["p"])))
        tup["left"] -= 1
    if broken and last_dur > 0:
        grown = max(1, int(round(last_dur * broken[0])))
        pos += grown - last_dur
        dur = max(1, int(round(dur * broken[1])))
        broken = None
    pos += dur
    return dur, dur, pos


def _abc_rest_tail(start: int, target: int, unit: int, bar: int) -> str:
    pos = max(0, int(start))
    target = max(pos, int(target))
    parts = [" "]
    bars = 0
    while pos < target:
        room = bar - (pos % bar)
        if room <= 0:
            room = bar
        take = min(target - pos, room)
        parts.append("z" + _abc_len_suffix(take, unit))
        pos += take
        if pos < target and pos % bar == 0:
            bars += 1
            parts.append(" |\n" if bars % 4 == 0 else " | ")
        elif pos < target:
            parts.append(" ")
    if pos % bar == 0:
        parts.append(" |")
    return "".join(parts).rstrip() + "\n"


def _fit_score(text: str, base_seconds: float):
    """有音符时，把乐谱补到不短于轨道的时长。返回 (文本, 秒)；没有音符时秒为 0。"""
    raw = str(text or "")
    if re.search(r"(?m)^V\s*:", raw):
        return raw, 0.0
    info = _abc_scan(raw)
    if not info["has_note"]:
        return str(text or ""), 0.0
    bpm = _abc_round_bpm(info["bpm"])
    bar = _abc_bar_ticks(info["meter"])
    total = max(int(info["note_end"]), _abc_sec_to_ticks(base_seconds, bpm))
    rem = total % bar
    if rem:
        total += bar - rem
    if total < bar:
        total = bar
    seconds = min(900.0, max(1.0, _abc_ticks_to_sec(total, bpm)))
    if int(info["total"]) == total:
        return info["raw"], seconds
    prefix = info["raw"][:info["cut"]].rstrip()
    tail = _abc_rest_tail(int(info["note_end"]), total, int(info["unit"]), bar)
    return prefix + tail, seconds


def _wave_seconds(audio) -> float:
    if not isinstance(audio, dict) or audio.get("waveform") is None:
        return 0.0
    try:
        wf = audio["waveform"]
        sr = int(audio.get("sample_rate") or 44100)
        return float(wf.shape[-1]) / max(sr, 1)
    except Exception:
        return 0.0


def _has_audio(audio) -> bool:
    if not isinstance(audio, dict):
        return False
    wf = audio.get("waveform")
    if wf is None:
        return False
    try:
        return int(wf.shape[-1]) > 0
    except Exception:
        return True


def _whisper_ckpt() -> str:
    names = ("large-v3-turbo.pt", "turbo.pt")
    roots = []
    try:
        import folder_paths

        md = folder_paths.models_dir
        roots.extend([
            os.path.join(md, "stt", "whisper"),
            os.path.join(md, "whisper"),
            os.path.join(md, "stt"),
            os.path.join(md, "audio_encoders"),
        ])
    except Exception:
        pass
    roots.append(os.path.expanduser(os.path.join("~", ".cache", "whisper")))
    for root in roots:
        if not root or not os.path.isdir(root):
            continue
        for name in names:
            path = os.path.join(root, name)
            if os.path.isfile(path):
                return path
        try:
            for fn in os.listdir(root):
                low = fn.lower()
                if low.endswith(".pt") and "turbo" in low:
                    return os.path.join(root, fn)
        except Exception:
            pass
    raise RuntimeError("没有找到歌词识别模型 large-v3-turbo.pt，请放到 models/stt/whisper。")


def _load_whisper():
    global _whisper_model
    with _whisper_lock:
        if _whisper_model is None:
            import whisper

            path = _whisper_ckpt()
            log.info("[LazyYuE] 加载歌词模型 %s", path)
            _whisper_model = whisper.load_model(path, device="cpu")
        return _whisper_model


def _audio_to_whisper(audio):
    wf = audio["waveform"]
    if not torch.is_tensor(wf):
        wf = torch.as_tensor(wf)
    wf = _as_bct(wf)
    sr = int(audio.get("sample_rate") or 44100)
    wf = _resample(wf, sr, 16000)
    mono = wf.detach().float().mean(dim=1)[0]
    return mono.contiguous().cpu().numpy()


def _slice_audio(audio, s0, s1):
    if not _has_audio(audio):
        return None
    wf = audio["waveform"]
    if not torch.is_tensor(wf):
        wf = torch.as_tensor(wf)
    wf = _as_bct(wf)
    sr = int(audio.get("sample_rate") or 44100)
    if sr <= 0:
        return None
    n = int(wf.shape[-1])
    dur = n / float(sr)
    try:
        a0 = min(max(0.0, float(s0 or 0)), dur)
        a1 = min(dur, max(a0, float(s1 or 0)))
    except Exception:
        return None
    if a1 - a0 < 0.02:
        return None
    i0 = max(0, min(n - 1, int(round(a0 * sr))))
    i1 = max(i0 + 1, min(n, int(round(a1 * sr))))
    return {"waveform": wf[..., i0:i1].contiguous(), "sample_rate": sr}


def _chunk_wav(wav, seconds: float = 24.0):
    n = int(getattr(wav, "size", 0) or 0)
    hop = max(1600, int(16000 * seconds))
    if n < 1600:
        return []
    if n <= hop:
        return [wav]
    chunks = []
    i = 0
    while i < n:
        sl = wav[i:min(n, i + hop)]
        if int(getattr(sl, "size", 0) or 0) >= 1600:
            chunks.append(sl)
        i += hop
    return chunks


def _text_from_result(result: dict) -> str:
    lines = []
    for seg in result.get("segments") or []:
        t = str(seg.get("text") or "").strip()
        if t:
            lines.append(t)
    text = "\n".join(lines).strip()
    if not text:
        text = str(result.get("text") or "").strip()
    return text


def _lyrics_waves(audio, clips=None, origin=None) -> list:
    waves = []
    cache = {}
    for clip in clips or []:
        name = str(clip.get("name") or "").strip()
        src = None
        a0, a1 = clip.get("s0"), clip.get("s1")
        if name:
            if name not in cache:
                try:
                    cache[name] = _load_audio_file(name)
                except Exception:
                    cache[name] = None
            src = cache[name]
        if not _has_audio(src) and _has_audio(origin):
            src = origin
        if not _has_audio(src) and _has_audio(audio):
            src = audio
            a0, a1 = clip.get("t0"), clip.get("t1")
        piece = _slice_audio(src, a0, a1) if _has_audio(src) else None
        wav = _audio_to_whisper(piece) if piece else None
        if wav is not None and int(getattr(wav, "size", 0) or 0) >= 1600:
            waves.append(wav)
    if waves:
        return waves
    if not _has_audio(audio):
        return []
    wav = _audio_to_whisper(audio)
    if wav is None or int(getattr(wav, "size", 0) or 0) < 1600:
        return []
    return [wav]


def _transcribe_lyrics(audio, clips=None, origin=None) -> str:
    waves = _lyrics_waves(audio, clips, origin)
    if not waves:
        raise RuntimeError("参考音频太短，识别不了歌词。")
    model = _load_whisper()
    device = "cuda" if torch.cuda.is_available() else "cpu"
    if device != "cpu":
        model = model.to(device)
    texts = []
    try:
        for wav in waves:
            for chunk in _chunk_wav(wav):
                try:
                    result = model.transcribe(
                        chunk,
                        fp16=device == "cuda",
                        task="transcribe",
                        verbose=False,
                        condition_on_previous_text=False,
                        no_speech_threshold=0.35,
                        compression_ratio_threshold=2.8,
                        temperature=(0.0, 0.2, 0.4, 0.6, 0.8, 1.0),
                    )
                except Exception as e:
                    log.warning("[LazyYuE] 一段歌词识别失败: %s", e)
                    continue
                t = _text_from_result(result or {})
                if t:
                    texts.append(t)
    finally:
        if device != "cpu":
            try:
                model.to("cpu")
            except Exception:
                pass
            try:
                torch.cuda.empty_cache()
            except Exception:
                pass
    text = "\n".join(texts).strip()
    if not text:
        raise RuntimeError("没有识别到歌词。")
    if not re.search(r"(?i)\[(verse|chorus|intro|outro|bridge|inst)\]", text):
        text = "[Verse]\n" + text
    return text


def _push_lyrics(node_id: str, lyrics: str):
    try:
        from server import PromptServer

        inst = getattr(PromptServer, "instance", None)
        if inst is None:
            return
        inst.send_sync("lazy_yue_lyrics", {
            "node_id": str(node_id or ""),
            "lyrics": lyrics or "",
        })
    except Exception as e:
        log.warning("[LazyYuE] 回写歌词失败: %s", e)


class LazyYueWorkbench:
    """风格、歌词、主轨、乐谱 → YUE_PACK。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "风格": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "tooltip": "风格。",
                }),
                "歌词": ("STRING", {
                    "default": "[Verse]\n\n[Chorus]\n",
                    "multiline": True,
                    "tooltip": "歌词。",
                }),
                "主轨": ("STRING", {
                    "default": "",
                    "tooltip": "原曲。",
                }),
                "乐谱": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "tooltip": "乐谱。",
                }),
                "模式": (["full", "melody"], {
                    "default": "full",
                    "tooltip": "模式。",
                }),
                "出乐谱": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "出乐谱。",
                }),
                "只出乐谱": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "只出乐谱。",
                }),
                "开始": ("FLOAT", {
                    "default": 0.0, "min": 0.0, "max": 3600.0, "step": 0.01,
                    "tooltip": "开始。",
                }),
                "结束": ("FLOAT", {
                    "default": 0.0, "min": 0.0, "max": 3600.0, "step": 0.01,
                    "tooltip": "结束。",
                }),
                "风格名": ("STRING", {
                    "default": "",
                    "tooltip": "风格名。",
                }),
                "秒数": ("FLOAT", {
                    "default": 120.0, "min": 1.0, "max": 900.0, "step": 1.0,
                    "tooltip": "秒数。",
                }),
                "自动": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "自动。",
                }),
                "段落": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "tooltip": "参考音频。",
                }),
                "原谱": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "tooltip": "原谱。",
                }),
                "改过": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "改过。",
                }),
            },
            "optional": {
                "音频": ("AUDIO", {"tooltip": "原曲。"}),
                "识别歌词": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "识别歌词。",
                }),
                "语言": ("STRING", {"default": "", "tooltip": "语言。"}),
                "人声": ("STRING", {"default": "", "tooltip": "人声。"}),
                "速度": ("INT", {
                    "default": 0, "min": 0, "max": 300, "step": 1,
                    "tooltip": "速度。",
                }),
                "嗓音": ("STRING", {"default": "", "tooltip": "嗓音。"}),
                "曲风": ("STRING", {"default": "", "tooltip": "曲风。"}),
                "配器": ("STRING", {"default": "", "tooltip": "配器。"}),
                "情绪": ("STRING", {"default": "", "tooltip": "情绪。"}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("YUE_PACK", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("YuE包", "歌词", "模式", "运行信息")
    FUNCTION = "build"
    CATEGORY = "Lazy/YuE"
    DESCRIPTION = "Lazy YuE 工作台"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def build(self, **kwargs):
        g = kwargs.get
        style = str(g("风格", "") or "")
        style_name = str(g("风格名", "") or "").strip()
        if not style.strip() and style_name:
            for it in _style_items():
                if it.get("name") == style_name:
                    style = str(it.get("prompt") or "")
                    break
        style = _compose_style(
            style,
            g("语言", ""),
            g("人声", ""),
            g("嗓音", ""),
            g("曲风", ""),
            g("速度", 0),
            g("配器", ""),
            g("情绪", ""),
        )
        lyrics = str(g("歌词", "") or "")
        shown = str(g("乐谱", "") or "")
        raw_abc = str(g("原谱", "") or "")
        edited = bool(g("改过", False))
        mode = str(g("模式", "full") or "full")
        if mode not in ("full", "melody"):
            mode = "full"
        make_score = bool(g("出乐谱", True))
        score_only = bool(g("只出乐谱", False))
        want_lyrics = bool(g("识别歌词", False))
        track = str(g("主轨", "") or "").strip()
        try:
            seconds = float(g("秒数", 120) or 120)
        except Exception:
            seconds = 120.0
        seconds = min(900.0, max(1.0, seconds))

        clips = _parse_clips(g("段落", ""), track)
        named = [c for c in clips if c.get("name")]
        audio = None
        origin = None
        if named:
            audio = _render_named_clips(named)
        else:
            if track:
                audio = _load_audio_file(track)
            if not _has_audio(audio):
                wired = g("音频", None)
                audio = wired if _has_audio(wired) else None
            origin = audio
            if _has_audio(audio):
                if clips:
                    audio = _render_clips(audio, _clip_tuples(clips))
                else:
                    audio = _crop_audio(audio, g("开始", 0), g("结束", 0))
        names = []
        for clip in named:
            if clip["name"] not in names:
                names.append(clip["name"])
        if not names and track:
            names = [track]

        has_ref = _has_audio(audio)
        if want_lyrics:
            if not has_ref:
                raise RuntimeError("识别歌词需要参考音频。")
            lyrics = _transcribe_lyrics(audio, clips, origin)
            _push_lyrics(str(g("unique_id", "") or ""), lyrics)
        auto = bool(g("自动", True))
        base = seconds
        if auto:
            end = _wave_seconds(audio) if has_ref else 0.0
            if end <= 0.05 and clips:
                end = max(float(c.get("t1") or 0) for c in clips)
            if end > 0.05:
                base = min(900.0, max(1.0, end))
            else:
                base = 0.0
        if edited:
            source = shown
        elif raw_abc.strip():
            source = raw_abc
        elif re.search(r"(?m)^V\s*:", shown):
            source = shown
        elif has_ref:
            source = ""
        else:
            source = shown
        fitted, musical = _fit_score(source, base)
        abc = source
        auto_len = auto and (has_ref or clips)
        if auto_len and base > 0:
            seconds = min(900.0, max(1.0, base))
        need = 0.0 if score_only else _lyric_seconds(lyrics)
        drop_short = (not has_ref) and (not edited) and (not score_only) and _score_too_short(source, lyrics)
        if drop_short:
            abc = ""
            raw_abc = ""
        elif musical > 0:
            abc = fitted
            # 有参考音频时，秒数跟音频，不用乐谱把成片拉长
            if not (auto_len and has_ref):
                seconds = min(900.0, max(1.0, musical))
        # 没有原曲卡住时长时，秒数至少要够把歌词唱完
        if need > 0 and not (auto_len and has_ref) and seconds < need:
            seconds = min(900.0, need)
        if not has_ref and not score_only:
            style = _with_length(style, seconds)

        kind = "翻唱" if has_ref else "直接生成"
        info = f"{kind} · {seconds:.0f}秒"
        picked_lang = _split_picks(g("语言", ""), _LANG_TAG)
        if picked_lang:
            info += " · " + "、".join(picked_lang)
        if drop_short:
            info += " · 重写乐谱"
        if want_lyrics:
            info += " · 识别歌词"
        if score_only:
            info += " · 只出乐谱"
        elif kind == "直接生成" and not abc.strip() and not make_score:
            info += " · 不出谱"

        pack = {
            "style": style,
            "style_name": style_name,
            "lyrics": lyrics,
            "abc": abc,
            "abc_raw": raw_abc,
            "score_edited": edited,
            "mode": mode,
            "make_score": make_score,
            "score_only": score_only,
            "audio": audio if _has_audio(audio) else None,
            "audio_name": "、".join(names),
            "node_id": str(g("unique_id", "") or ""),
            "kind": kind,
            "seconds": seconds,
        }
        n_ref = len(named) or (1 if _has_audio(audio) else 0)
        log.info(
            "[LazyYuE] 工作台 %s 模式=%s 乐谱=%s 改过=%s 音频=%d",
            kind, mode, "有" if abc.strip() else "空", "是" if edited else "否", n_ref,
        )
        return (pack, lyrics, kind, info)
