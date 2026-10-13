/**
 * Lazy YuE 工作台：自定义风格 / 直接输入风格 / 参考音轨（播放、剪辑）/ 乐谱
 * 参考轨有原曲 = 翻唱，没有 = 直接生成
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAME = "LazyYueWorkbench";

function findW(node, name) {
  return node.widgets?.find((w) => w?.name === name);
}
function hideWidget(w) {
  if (!w) return;
  if (w.type !== "hidden") {
    w.origType = w.type;
    w.origComputeSize = w.computeSize;
    w.type = "hidden";
    w.computeSize = () => [0, -4];
  }
  try {
    w.hidden = true;
  } catch (_) {}
  if (w.element) w.element.style.display = "none";
}
function setVal(w, v) {
  if (!w) return;
  w.value = v;
  try {
    w.callback?.(v);
  } catch (_) {}
}
function viewUrl(name) {
  const raw = String(name || "").replace(/\\/g, "/");
  const filename = raw.split("/").pop() || raw;
  const q = new URLSearchParams({ filename, type: "input", subfolder: "" });
  try {
    return api.apiURL(`/view?${q.toString()}`);
  } catch (_) {
    return `/view?${q.toString()}`;
  }
}
const AUDIO_EXT = /\.(mp3|wav|flac|ogg|m4a|aac|wma|aif|aiff|opus)$/i;
function isAudioName(name) {
  return AUDIO_EXT.test(String(name || "").split("?")[0].split("/").pop() || "");
}
function placeClip(origins, movingId, t0, t1) {
  const src = (origins || []).filter((c) => c && Number.isFinite(c.t0) && Number.isFinite(c.t1));
  const movingLen = Math.max(0.05, t1 - t0);
  const center = t0 + movingLen / 2;
  const others = src.filter((c) => c.id !== movingId).sort((a, b) => a.t0 - b.t0 || a.id - b.id);
  let idx = others.length;
  for (let i = 0; i < others.length; i++) {
    const mid = (others[i].t0 + others[i].t1) / 2;
    if (center <= mid + 0.001) {
      idx = i;
      break;
    }
  }
  const oldIds = src.slice().sort((a, b) => a.t0 - b.t0 || a.id - b.id).map((c) => c.id);
  const newIds = others.map((c) => c.id);
  newIds.splice(idx, 0, movingId);
  if (newIds.length === oldIds.length && newIds.every((id, i) => id === oldIds[i])) return null;
  const packFrom = Math.min(...src.map((c) => c.t0), t0);
  const lenOf = new Map(src.map((c) => [c.id, Math.max(0.05, c.t1 - c.t0)]));
  lenOf.set(movingId, movingLen);
  let t = Number.isFinite(packFrom) ? packFrom : 0;
  return newIds.map((id) => {
    const d = lenOf.get(id) || 0.05;
    const item = { id, t0: t, t1: t + d };
    t += d;
    return item;
  });
}
function parseAudioDrop(raw) {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s || s.startsWith("#")) return null;
  if (s.startsWith("file://")) {
    try {
      s = decodeURIComponent(s.replace(/^file:\/\/\//i, "").replace(/^file:\/\//i, ""));
      if (/^\/[a-zA-Z]:/.test(s)) s = s.slice(1);
    } catch (_) {}
  }
  if (/^https?:\/\//i.test(s) || s.startsWith("/") || s.includes("filename=") || s.includes("/view") || s.includes("/api/")) {
    try {
      const url = new URL(s, "http://local");
      const filename = url.searchParams.get("filename");
      if (filename && isAudioName(filename)) {
        return {
          filename: decodeURIComponent(filename),
          subfolder: decodeURIComponent(url.searchParams.get("subfolder") || ""),
          type: url.searchParams.get("type") || "input",
          fetchUrl: url.pathname + url.search,
        };
      }
      const base = decodeURIComponent((url.pathname || "").split("/").pop() || "");
      if (isAudioName(base)) {
        return { filename: base, subfolder: "", type: "input", fetchUrl: url.pathname + url.search };
      }
    } catch (_) {}
  }
  const typeM = /\[(input|output|temp)\]\s*$/i.exec(s);
  s = s.replace(/\s*\[(input|output|temp)\]\s*$/i, "").trim().replace(/\\/g, "/");
  if (!isAudioName(s)) return null;
  const parts = s.split("/").filter(Boolean);
  const filename = parts.pop();
  return {
    filename,
    subfolder: parts.join("/"),
    type: typeM ? typeM[1].toLowerCase() : "input",
    fetchUrl: "",
  };
}
function collectAudioDrops(dt) {
  if (!dt) return [];
  const seen = new Map();
  const add = (ref) => {
    if (!ref || !ref.filename || !isAudioName(ref.filename)) return;
    const name = String(ref.filename).split("/").pop();
    const key = name.toLowerCase();
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, {
        filename: name,
        subfolder: ref.subfolder || "",
        type: ref.type || "input",
        fetchUrl: ref.fetchUrl || "",
      });
      return;
    }
    if (!prev.subfolder && ref.subfolder) prev.subfolder = ref.subfolder;
    if ((prev.type || "input") === "input" && ref.type && ref.type !== "input") prev.type = ref.type;
    if (!prev.fetchUrl && ref.fetchUrl) prev.fetchUrl = ref.fetchUrl;
  };
  const tryGet = (mime) => {
    try {
      return dt.getData(mime) || "";
    } catch (_) {
      return "";
    }
  };
  const takeLines = (text, pair) => {
    const lines = String(text || "").split(/\r?\n/);
    for (let i = 0; i < lines.length; i += pair ? 2 : 1) {
      const line = (lines[i] || "").trim();
      if (line && !line.startsWith("#")) add(parseAudioDrop(line));
    }
  };
  takeLines(tryGet("text/uri-list"), false);
  takeLines(tryGet("text/x-moz-url"), true);
  takeLines(tryGet("text/plain"), false);
  takeLines(tryGet("text"), false);
  const mimes = ["application/json", "application/x-comfy-asset", "application/comfy-asset", "comfy/asset"];
  try {
    for (const t of Array.from(dt.types || [])) {
      if (mimes.indexOf(t) < 0 && /asset|json/i.test(t)) mimes.push(t);
    }
  } catch (_) {}
  for (const mime of mimes) {
    const plain = tryGet(mime);
    if (!plain) continue;
    try {
      const obj = JSON.parse(plain);
      const list = Array.isArray(obj) ? obj : obj?.assets || obj?.items || [obj];
      for (const item of list) {
        if (!item) continue;
        if (typeof item === "string") {
          add(parseAudioDrop(item));
          continue;
        }
        const name = item.filename || item.name || item.fileName || "";
        const url = item.url || item.preview_url || item.href || item.path || "";
        const sub = item.subfolder || "";
        const type = item.type || item.folder_type || "input";
        if (url) {
          const ref = parseAudioDrop(String(url));
          if (ref) {
            if (name && isAudioName(name)) ref.filename = String(name).split("/").pop();
            if (!ref.subfolder && sub) ref.subfolder = String(sub);
            if ((!ref.type || ref.type === "input") && type && String(type) !== "input") ref.type = String(type);
            add(ref);
            continue;
          }
        }
        if (name && isAudioName(name)) {
          add({
            filename: String(name).split("/").pop(),
            subfolder: String(sub || ""),
            type: String(type || "input"),
            fetchUrl: url ? String(url) : "",
          });
        }
      }
    } catch (_) {
      takeLines(plain, false);
    }
  }
  return Array.from(seen.values());
}
function findBenches(id) {
  const all = app.graph?.findNodesByType?.(NODE_NAME) || [];
  if (!id) return all;
  const hit = all.filter((n) => String(n.id) === String(id));
  return hit.length ? hit : all;
}
function fmt(sec) {
  const n = Math.max(0, Number(sec) || 0);
  return n.toFixed(2);
}

/* === ABC START === */
const ABC_TICK = 1680;
const ABC_STEP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const ABC_SHARP_N = { C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, "F#": 6, "C#": 7 };
const ABC_FLAT_N = { F: 1, Bb: 2, Eb: 3, Ab: 4, Db: 5, Gb: 6, Cb: 7 };
const ABC_SHARPS = ["F", "C", "G", "D", "A", "E", "B"];
const ABC_FLATS = ["B", "E", "A", "D", "G", "C", "F"];
const ABC_REL = {
  Am: "C", Em: "G", Bm: "D", "F#m": "A", "C#m": "E", "G#m": "B", "D#m": "F#", "A#m": "C#",
  Dm: "F", Gm: "Bb", Cm: "Eb", Fm: "Ab", Bbm: "Db", Ebm: "Gb", Abm: "Cb",
};
const ABC_SPELL_SHARP = [
  ["C", 0], ["C", 1], ["D", 0], ["D", 1], ["E", 0], ["F", 0],
  ["F", 1], ["G", 0], ["G", 1], ["A", 0], ["A", 1], ["B", 0],
];
const ABC_SPELL_FLAT = [
  ["C", 0], ["D", -1], ["D", 0], ["E", -1], ["E", 0], ["F", 0],
  ["G", -1], ["G", 0], ["A", -1], ["A", 0], ["B", -1], ["B", 0],
];

function abcGcd(a, b) {
  a = Math.abs(a | 0);
  b = Math.abs(b | 0);
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a || 1;
}
function abcMeter(raw) {
  const s = String(raw || "4/4").trim();
  if (s === "C|") return "2/2";
  if (s === "C") return "4/4";
  const m = /^(\d+)\s*\/\s*(\d+)/.exec(s);
  return m ? m[1] + "/" + m[2] : "4/4";
}
function abcBarSix(meter) {
  const m = /^(\d+)\/(\d+)$/.exec(abcMeter(meter));
  return Math.max(1, Math.round((+m[1] * 16) / +m[2]));
}
function abcBarTicks(meter) {
  return abcBarSix(meter) * ABC_TICK;
}
function abcUnitTicks(raw) {
  const m = /^\s*(\d+)\s*\/\s*(\d+)/.exec(String(raw || "1/8"));
  if (!m) return 2 * ABC_TICK;
  return Math.max(1, Math.round((ABC_TICK * 16 * +m[1]) / +m[2]));
}
function abcBpm(raw) {
  const s = String(raw || "").trim();
  if (!s) return 0;
  const eq = /^(.*?)=\s*(\d+(?:\.\d+)?)/.exec(s);
  if (eq) {
    const bpm = parseFloat(eq[2]);
    const lm = /(\d+)\s*\/\s*(\d+)/.exec(eq[1]);
    if (lm) return (bpm * 4 * +lm[1]) / +lm[2];
    return bpm;
  }
  const only = /(\d+(?:\.\d+)?)/.exec(s);
  return only ? parseFloat(only[1]) : 0;
}
function abcRoundBpm(bpm) {
  const n = Math.round(Number(bpm) || 0);
  return n > 0 ? n : 120;
}
function abcSecToTicks(sec, bpm) {
  const b = abcRoundBpm(bpm);
  return Math.max(0, Math.round((Number(sec) || 0) * b / 15)) * ABC_TICK;
}
function abcTicksToSec(ticks, bpm) {
  const b = abcRoundBpm(bpm);
  return (ticks / ABC_TICK) * 15 / b;
}
function abcMajorKey(raw) {
  let s = String(raw || "C").trim().split(/\s+/)[0] || "C";
  const mode = (String(raw || "").trim().split(/\s+/)[1] || "").toLowerCase();
  if (/min/.test(mode) && !/m$/i.test(s)) s += "m";
  if (ABC_REL[s]) return ABC_REL[s];
  if (Object.prototype.hasOwnProperty.call(ABC_SHARP_N, s)) return s;
  if (Object.prototype.hasOwnProperty.call(ABC_FLAT_N, s)) return s;
  return "C";
}
function abcKeyAcc(raw) {
  const key = abcMajorKey(raw);
  if (Object.prototype.hasOwnProperty.call(ABC_SHARP_N, key)) {
    return { sharp: ABC_SHARPS.slice(0, ABC_SHARP_N[key]), flat: [], name: key };
  }
  return { sharp: [], flat: ABC_FLATS.slice(0, ABC_FLAT_N[key] || 0), name: key };
}
function abcKeyOf(letter, keyAcc) {
  if (keyAcc.sharp.indexOf(letter) >= 0) return 1;
  if (keyAcc.flat.indexOf(letter) >= 0) return -1;
  return 0;
}
function abcUseFlats(raw) {
  const key = abcMajorKey(raw);
  return Object.prototype.hasOwnProperty.call(ABC_FLAT_N, key);
}
function abcIsChord(sym) {
  return /^[A-G][#b]?/.test(String(sym || "").trim());
}
function abcSongEnd(meta, notes, baseSeconds) {
  const bpm = abcRoundBpm(meta && meta.bpm);
  const bar = abcBarTicks((meta && meta.meter) || "4/4");
  let noteEnd = 0;
  for (const n of notes || []) noteEnd = Math.max(noteEnd, (n.s || 0) + (n.d || 0));
  let total = Math.max(noteEnd, abcSecToTicks(baseSeconds, bpm));
  const rem = total % bar;
  if (rem) total += bar - rem;
  if (total < bar) total = bar;
  return { total, noteEnd, bpm, bar };
}
function abcLengthSuffix(ticks, unit) {
  let num = Math.round(ticks);
  let den = Math.round(unit);
  if (den <= 0) den = ABC_TICK;
  if (num <= 0) num = den;
  const g = abcGcd(num, den);
  num /= g;
  den /= g;
  if (den === 1) return num === 1 ? "" : String(num);
  if (num === 1) return den === 2 ? "/" : "/" + den;
  return num + "/" + den;
}
function abcDots(ticks, dots) {
  let add = ticks;
  let out = ticks;
  for (let i = 0; i < dots; i++) {
    add = Math.floor(add / 2);
    out += add;
  }
  return out;
}

function parseAbc(text) {
  try {
    return parseAbcInner(text);
  } catch (err) {
    console.warn("[LazyYuE] 乐谱:", err);
    return { notes: [], chords: [], meter: "4/4", bpm: 0, key: "C", title: "", noteEnd: 0 };
  }
}
function parseAbcInner(text) {
  const s = String(text || "").replace(/\r\n/g, "\n");
  const head = {};
  let i = 0;
  while (i < s.length) {
    if (i !== 0 && s[i - 1] !== "\n") break;
    if (s[i] === "\n") {
      i += 1;
      continue;
    }
    if (s[i] === "%") {
      while (i < s.length && s[i] !== "\n") i += 1;
      continue;
    }
    const lineEnd = s.indexOf("\n", i);
    const line = s.slice(i, lineEnd < 0 ? s.length : lineEnd);
    if (!line.trim()) {
      i = lineEnd < 0 ? s.length : lineEnd + 1;
      continue;
    }
    const hm = /^([A-Za-z]):\s*(.*)$/.exec(line.trim());
    if (!hm) break;
    const k = hm[1].toUpperCase();
    if (k === "K") {
      const rawK = (hm[2] || "").trim();
      const km = /^(\S+)\s*(.*)$/.exec(rawK);
      const rest = km && km[2] ? km[2].trim() : "";
      const restIsMusic = !!rest && /^[\^_=A-Ga-gzxZ|"\[]/.test(rest);
      head.K = restIsMusic ? km[1] : rawK || "C";
      if (restIsMusic) i += line.indexOf(rest);
      else i = lineEnd < 0 ? s.length : lineEnd + 1;
      break;
    }
    if ("XTMLQ".indexOf(k) >= 0) head[k] = hm[2];
    i = lineEnd < 0 ? s.length : lineEnd + 1;
  }
  let meter = abcMeter(head.M || "4/4");
  let unit = abcUnitTicks(head.L || "1/8");
  let bpm = abcBpm(head.Q || "");
  let keyAcc = abcKeyAcc(head.K || "C");
  let barAcc = new Map();
  let pos = 0;
  let noteEnd = 0;
  const notes = [];
  const chords = [];
  let pendingChord = "";
  let last = null;
  let tiePrev = false;
  let tup = null;
  let broken = null;
  let voice = "";
  const voiceAt = new Map();
  const switchVoice = (name) => {
    if (voice) voiceAt.set(voice, pos);
    voice = name;
    pos = voiceAt.has(name) ? voiceAt.get(name) : 0;
    last = null;
    tiePrev = false;
    tup = null;
    broken = null;
    pendingChord = "";
    barAcc = new Map();
  };
  const finishNote = (midi, ticks, tie, span) => {
    let dur = Math.max(1, Math.round(ticks));
    if (tup && tup.left > 0) {
      dur = Math.max(1, Math.round(dur * tup.q / tup.p));
      tup.left -= 1;
      if (tup.left <= 0) tup = null;
    }
    if (broken && last) {
      const old = last.d;
      const nd = Math.max(1, Math.round(old * broken[0]));
      pos += nd - old;
      last.d = nd;
      noteEnd = Math.max(noteEnd, last.s + last.d);
      dur = Math.max(1, Math.round(dur * broken[1]));
      broken = null;
    }
    if (tiePrev && last && last.m === midi) {
      last.d += dur;
      if (span) {
        if (!last.spans) last.spans = [];
        last.spans.push(span);
      }
      noteEnd = Math.max(noteEnd, last.s + last.d);
      pos += dur;
      tiePrev = !!tie;
      return;
    }
    const note = { s: pos, d: dur, m: midi, v: voice };
    if (span) note.spans = [span];
    notes.push(note);
    last = note;
    if (pendingChord) {
      chords.push({ s: pos, sym: pendingChord, v: voice });
      pendingChord = "";
    }
    noteEnd = Math.max(noteEnd, pos + dur);
    pos += dur;
    tiePrev = !!tie;
  };
  const finishRest = (ticks) => {
    let dur = Math.max(1, Math.round(ticks));
    if (tup && tup.left > 0) {
      dur = Math.max(1, Math.round(dur * tup.q / tup.p));
      tup.left -= 1;
      if (tup.left <= 0) tup = null;
    }
    broken = null;
    tiePrev = false;
    last = null;
    pos += dur;
  };
  while (i < s.length) {
    const ch = s[i];
    if (ch === " " || ch === "\t" || ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "\n" || i === 0 || s[i - 1] === "\n") {
      if (ch === "\n") i += 1;
      const fm = /^([A-Za-z]):[^\n]*/.exec(s.slice(i));
      if (fm) {
        const k = fm[1].toUpperCase();
        const val = fm[0].slice(2).trim();
        if (k === "K") {
          keyAcc = abcKeyAcc(val);
          barAcc = new Map();
        } else if (k === "M") meter = abcMeter(val);
        else if (k === "L") unit = abcUnitTicks(val);
        else if (k === "Q") {
          const b = abcBpm(val);
          if (b > 0) bpm = b;
        } else if (k === "X") break;
        else if (k === "V") {
          const name = (val.split(/\s+/)[0] || "").trim();
          if (name !== voice) switchVoice(name);
          i += fm[0].length;
          continue;
        }
        i += fm[0].length;
        continue;
      }
      if (ch === "\n") continue;
    }
    if (ch === "%") {
      while (i < s.length && s[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === '"') {
      const j = s.indexOf('"', i + 1);
      const sym = s.slice(i + 1, j < 0 ? s.length : j).trim();
      i = j < 0 ? s.length : j + 1;
      if (abcIsChord(sym)) pendingChord = sym;
      continue;
    }
    if (ch === "{") {
      const j = s.indexOf("}", i + 1);
      i = j < 0 ? s.length : j + 1;
      continue;
    }
    if (ch === "!" || (ch === "+" && /[A-Za-z]/.test(s[i + 1] || ""))) {
      const j = s.indexOf(ch, i + 1);
      i = j < 0 ? s.length : j + 1;
      continue;
    }
    const bar = new RegExp("^(?:" + ["\\|\\]", "\\|\\|", "\\[\\|", "\\|:", ":\\|", "::", "\\|"].join("|") + ")").exec(s.slice(i));
    if (bar && bar[0]) {
      barAcc = new Map();
      tiePrev = false;
      i += bar[0].length;
      while (/[0-9,\-]/.test(s[i] || "")) i += 1;
      continue;
    }
    if (ch === "[") {
      const close = s.indexOf("]", i + 1);
      if (close < 0 || close - i > 80) {
        i += 1;
        continue;
      }
      const inl = /^\[([A-Za-z]):([^\]]*)\]/.exec(s.slice(i));
      if (inl) {
        const k = inl[1].toUpperCase();
        if (k === "K") {
          keyAcc = abcKeyAcc(inl[2]);
          barAcc = new Map();
        } else if (k === "M") meter = abcMeter(inl[2]);
        else if (k === "L") unit = abcUnitTicks(inl[2]);
        else if (k === "Q") {
          const b = abcBpm(inl[2]);
          if (b > 0) bpm = b;
        }
        i += inl[0].length;
        continue;
      }
      if (/^\[\d/.test(s.slice(i))) {
        i += 1;
        while (i < s.length && s[i] !== "]" && s[i] !== "|") i += 1;
        if (s[i] === "]") i += 1;
        continue;
      }
      i += 1;
      let best = null;
      while (i < s.length && s[i] !== "]") {
        if (s[i] === " " || s[i] === "\n") {
          i += 1;
          continue;
        }
        const tok = abcReadNote(s, i);
        if (!tok) {
          i += 1;
          continue;
        }
        i = tok.next;
        if (!tok.rest) {
          const midi = abcMidi(tok, keyAcc, barAcc);
          const ticks = abcTokenTicks(tok, unit);
          if (!best || midi > best.midi) best = { midi, ticks, tie: tok.tie };
        }
      }
      if (s[i] === "]") i += 1;
      const tail = abcReadLen(s, i);
      i = tail.next;
      if (best) finishNote(best.midi, tail.used ? abcTokenTicks(tail, unit) : best.ticks, tail.tie || best.tie, null);
      continue;
    }
    if (ch === "(" && /[0-9]/.test(s[i + 1] || "")) {
      const tm = /^\((\d+)(?::(\d+))?(?::(\d+))?/.exec(s.slice(i));
      const p = Math.max(2, parseInt(tm[1], 10));
      const defaults = { 2: 3, 3: 2, 4: 3, 5: 4, 6: 2, 7: 4, 8: 3, 9: 4 };
      const q = tm[2] ? parseInt(tm[2], 10) : (defaults[p] || 2);
      const r = tm[3] ? parseInt(tm[3], 10) : p;
      tup = { left: Math.max(1, r), p, q };
      i += tm[0].length;
      continue;
    }
    if ("~uvHLMOPST".indexOf(ch) >= 0) {
      i += 1;
      continue;
    }
    if (ch === "." && /[\^_=A-Ga-gzxZ]/.test(s[i + 1] || "")) {
      i += 1;
      continue;
    }
    const tok = abcReadNote(s, i);
    if (!tok) {
      i += 1;
      continue;
    }
    i = tok.next;
    const br = /^(<{1,3}|>{1,3})/.exec(s.slice(i));
    let brMark = null;
    if (br) {
      const n = br[1].length;
      const long = (Math.pow(2, n + 1) - 1) / Math.pow(2, n);
      const short = 1 / Math.pow(2, n);
      brMark = br[1][0] === ">" ? [long, short] : [short, long];
      i += br[1].length;
    }
    if (tok.rest) {
      if (tok.letter === "Z") finishRest(abcBarTicks(meter) * Math.max(1, tok.num == null ? 1 : tok.num));
      else finishRest(abcTokenTicks(tok, unit));
      continue;
    }
    finishNote(
      abcMidi(tok, keyAcc, barAcc),
      abcTokenTicks(tok, unit),
      tok.tie,
      tok.rest ? null : { from: tok.from, to: tok.pitchEnd }
    );
    if (brMark) broken = brMark;
  }
  return {
    notes,
    chords,
    meter,
    bpm,
    key: (head.K || "C").trim() || "C",
    title: head.T || "",
    noteEnd,
  };
}
function abcReadLen(s, i) {
  let num = null;
  let den = null;
  let used = false;
  if (/[0-9]/.test(s[i] || "")) {
    used = true;
    num = 0;
    while (/[0-9]/.test(s[i] || "")) {
      num = num * 10 + (s.charCodeAt(i) - 48);
      i += 1;
    }
  }
  if (s[i] === "/") {
    used = true;
    i += 1;
    den = 0;
    while (/[0-9]/.test(s[i] || "")) {
      den = den * 10 + (s.charCodeAt(i) - 48);
      i += 1;
    }
    if (!den) den = 2;
  }
  let dots = 0;
  while (s[i] === ".") {
    used = true;
    dots += 1;
    i += 1;
  }
  let tie = false;
  if (s[i] === "-") {
    used = true;
    tie = true;
    i += 1;
  }
  return { next: i, num, den, dots, tie, used, rest: false, letter: "C", acc: null, oct: 0, hasLen: used };
}
function abcReadNote(s, i) {
  const start = i;
  let acc = null;
  if (s.startsWith("^^", i)) {
    acc = 2;
    i += 2;
  } else if (s.startsWith("__", i)) {
    acc = -2;
    i += 2;
  } else if (s[i] === "^") {
    acc = 1;
    i += 1;
  } else if (s[i] === "_") {
    acc = -1;
    i += 1;
  } else if (s[i] === "=") {
    acc = 0;
    i += 1;
  }
  const letter = s[i] || "";
  if ("ABCDEFGabcdefgzxZ".indexOf(letter) < 0) return null;
  i += 1;
  let oct = 0;
  if ("zxZ".indexOf(letter) < 0) {
    while (s[i] === ",") {
      oct -= 1;
      i += 1;
    }
    while (s[i] === "'") {
      oct += 1;
      i += 1;
    }
  }
  const pitchEnd = i;
  const len = abcReadLen(s, i);
  return {
    next: len.next,
    acc,
    letter,
    oct,
    num: len.num,
    den: len.den,
    dots: len.dots,
    tie: len.tie,
    rest: "zxZ".indexOf(letter) >= 0,
    hasLen: len.used || i !== start + 1,
    from: start,
    pitchEnd,
  };
}
function abcTokenTicks(tok, unit) {
  const n = tok.num == null ? 1 : tok.num;
  const d = tok.den == null ? 1 : tok.den;
  return abcDots(Math.max(1, Math.round(unit * n / d)), tok.dots || 0);
}
function abcMidi(tok, keyAcc, barAcc) {
  const letter = tok.letter.toUpperCase();
  const base = tok.letter === tok.letter.toLowerCase() ? 5 : 4;
  const octave = base + (tok.oct || 0);
  let use = tok.acc;
  if (use == null) use = barAcc.has(letter) ? barAcc.get(letter) : abcKeyOf(letter, keyAcc);
  else barAcc.set(letter, use);
  return (octave + 1) * 12 + ABC_STEP[letter] + use;
}
function abcSpell(midi, keyName) {
  const pc = ((midi % 12) + 12) % 12;
  const table = abcUseFlats(keyName) ? ABC_SPELL_FLAT : ABC_SPELL_SHARP;
  const pair = table[pc];
  return { letter: pair[0], acc: pair[1], octave: Math.floor(midi / 12) - 1 };
}
function abcPitchToken(midi, keyAcc, barAcc) {
  const sp = abcSpell(midi, keyAcc.name);
  const cur = barAcc.has(sp.letter) ? barAcc.get(sp.letter) : abcKeyOf(sp.letter, keyAcc);
  let acc = "";
  if (sp.acc !== cur) {
    if (sp.acc === 0) acc = "=";
    else if (sp.acc > 0) acc = "^".repeat(sp.acc);
    else acc = "_".repeat(-sp.acc);
    barAcc.set(sp.letter, sp.acc);
  }
  let name = sp.octave >= 5 ? sp.letter.toLowerCase() : sp.letter;
  if (sp.octave > 5) name += "'".repeat(sp.octave - 5);
  if (sp.octave < 4) name += ",".repeat(4 - sp.octave);
  return acc + name;
}
function abcSanitize(notes) {
  const groups = new Map();
  for (const n of notes || []) {
    if (!n || !(n.d > 0)) continue;
    const v = n.v || "";
    if (!groups.has(v)) groups.set(v, []);
    groups.get(v).push(n);
  }
  const out = [];
  for (const [v, list] of groups) {
    list.sort((a, b) => a.s - b.s || a.m - b.m);
    let end = 0;
    for (const n of list) {
      const s = Math.max(n.s, end);
      if (s >= n.s + n.d) continue;
      const d = n.s + n.d - s;
      out.push({ s, d, m: n.m, v });
      end = s + d;
    }
  }
  return out;
}
function abcVoiceOrder(notes) {
  const seen = [];
  for (const n of notes || []) {
    const v = (n && n.v) || "";
    if (seen.indexOf(v) < 0) seen.push(v);
  }
  const head = [];
  for (const name of ["Vocal", "Ins"]) {
    const at = seen.indexOf(name);
    if (at >= 0) {
      head.push(name);
      seen.splice(at, 1);
    }
  }
  return head.concat(seen);
}
function writeVoiceBody(meta, notes, chords, totalTicks) {
  const key = String((meta && meta.key) || "C").trim() || "C";
  const keyAcc = abcKeyAcc(key);
  const bar = abcBarTicks(abcMeter(meta && meta.meter));
  const list = (notes || []).filter((n) => n && n.d > 0).sort((a, b) => a.s - b.s || a.m - b.m);
  const chordList = (chords || []).filter((c) => c && abcIsChord(c.sym)).sort((a, b) => a.s - b.s);
  let ci = 0;
  let held = "";
  const pull = (from, to) => {
    while (ci < chordList.length && chordList[ci].s < from) ci += 1;
    while (ci < chordList.length && chordList[ci].s >= from && chordList[ci].s < to) {
      held = chordList[ci].sym;
      ci += 1;
    }
  };
  let barAcc = new Map();
  let pos = 0;
  const parts = [];
  let lineBars = 0;
  const push = (tok) => parts.push(tok);
  const barline = () => {
    barAcc = new Map();
    push("|");
    lineBars += 1;
    push(lineBars >= 4 ? "\n" : " ");
    if (lineBars >= 4) lineBars = 0;
  };
  const emit = (ticks, midi) => {
    let left = ticks;
    let first = true;
    while (left > 0) {
      const room = bar - (pos % bar);
      const take = Math.min(left, room);
      if (take <= 0) break;
      if (midi == null) pull(pos, pos + take);
      let tok = (midi == null ? "z" : abcPitchToken(midi, keyAcc, barAcc)) + abcLengthSuffix(take, ABC_TICK);
      if (midi != null && first && held) {
        tok = '"' + held + '"' + tok;
        held = "";
        first = false;
      } else if (midi != null) first = false;
      if (midi != null && left > take) tok += "-";
      push(tok);
      push(" ");
      pos += take;
      left -= take;
      if (pos % bar === 0 && pos < totalTicks) barline();
    }
  };
  while (pos < totalTicks) {
    const next = list.find((n) => n.s + n.d > pos);
    if (!next) {
      emit(totalTicks - pos, null);
      break;
    }
    if (next.s > pos) emit(next.s - pos, null);
    const start = Math.max(pos, next.s);
    pull(next.s, next.s + next.d);
    emit(next.s + next.d - start, next.m);
  }
  if (pos > 0 && pos % bar === 0) {
    const tail = parts[parts.length - 1];
    if (tail !== "|" && tail !== "\n") barline();
  }
  let body = parts.join("").replace(/[ \t]+\n/g, "\n").replace(/[ \t]+$/g, "").trim();
  if (body && body[body.length - 1] !== "|") body += " |";
  return body;
}
function writeAbc(meta, notes, chords, totalTicks) {
  const meter = abcMeter(meta && meta.meter);
  const bpm = abcRoundBpm(meta && meta.bpm);
  const key = String((meta && meta.key) || "C").trim() || "C";
  const title = String((meta && meta.title) || "");
  const list = abcSanitize(notes);
  const voices = abcVoiceOrder(list);
  const named = voices.filter((v) => v);
  const vocalish = named.indexOf("Vocal") >= 0 || named.indexOf("Ins") >= 0;
  let head = "X:1\nT:" + title + "\nM:" + meter + "\nL:1/16\nQ:1/4=" + bpm + "\n";
  if (vocalish) {
    head += 'V: Vocal clef=treble name="Vocal Melody" snm="Vocal"\n';
    head += 'V: Ins clef=treble name="Ins Melody" snm="Inst."\n';
  }
  head += "K:" + key + "\n";
  if (!named.length) return head + writeVoiceBody(meta, list, chords, totalTicks) + "\n";
  const fallback = named.indexOf("Vocal") >= 0 ? "Vocal" : named[0];
  const tagged = list.map((n) => ({ s: n.s, d: n.d, m: n.m, v: n.v || fallback }));
  const parts = [];
  for (const name of abcVoiceOrder(tagged)) {
    if (!name) continue;
    const vn = tagged.filter((n) => n.v === name);
    if (!vn.length) continue;
    const vc = (chords || []).filter((c) => c && ((c.v || "") === name || (!(c.v) && name === fallback)));
    parts.push("V: " + name + "\n" + writeVoiceBody(meta, vn, vc, totalTicks));
  }
  return head + parts.join("\n") + "\n";
}
function abcGroupNotes(list) {
  const map = new Map();
  for (const n of list || []) {
    if (!n || !(n.d > 0)) continue;
    const v = n.v || "";
    if (!map.has(v)) map.set(v, []);
    map.get(v).push(n);
  }
  for (const arr of map.values()) arr.sort((a, b) => a.s - b.s || a.m - b.m);
  return map;
}
function patchCoverAbc(origin, notes) {
  const src = String(origin || "").replace(/\r\n/g, "\n");
  if (!src.trim()) return "";
  const parsed = parseAbc(src);
  const olds = abcGroupNotes(parsed.notes);
  const news = abcGroupNotes(notes);
  if (!olds.size || olds.size !== news.size) return "";
  const spans = [];
  for (const [v, a] of olds) {
    const b = news.get(v);
    if (!b || a.length !== b.length) return "";
    for (let i = 0; i < a.length; i++) {
      if (Math.abs(a[i].s - b[i].s) > 1 || Math.abs(a[i].d - b[i].d) > 1) return "";
      const list = a[i].spans;
      if (!list || !list.length) return "";
      for (const sp of list) {
        if (!(sp.from >= 0) || !(sp.to > sp.from)) return "";
        spans.push({ from: sp.from, to: sp.to, midi: b[i].m });
      }
    }
  }
  spans.sort((a, b) => a.from - b.from);
  let keyAcc = abcKeyAcc(parsed.key || "C");
  let barAcc = new Map();
  let prev = 0;
  const reps = [];
  for (const sp of spans) {
    const mid = src.slice(prev, sp.from);
    if (/\|/.test(mid)) barAcc = new Map();
    const km = /\[K:([^\]]+)\]/.exec(mid);
    if (km) {
      keyAcc = abcKeyAcc(km[1]);
      barAcc = new Map();
    }
    const lineK = /(?:^|\n)K:\s*(\S+)/.exec(mid);
    if (lineK) {
      keyAcc = abcKeyAcc(lineK[1]);
      barAcc = new Map();
    }
    reps.push({ from: sp.from, to: sp.to, token: abcPitchToken(sp.midi, keyAcc, barAcc) });
    prev = sp.to;
  }
  let out = src;
  for (let i = reps.length - 1; i >= 0; i--) {
    const r = reps[i];
    out = out.slice(0, r.from) + r.token + out.slice(r.to);
  }
  return out;
}
/* === ABC END === */

let _closeStyleDialog = null;
function closeStyleDialog() {
  try {
    _closeStyleDialog?.();
  } catch (_) {}
}

function ensureStore() {
  try {
    api.fetchApi("/lazy_zidingyi/ensure", { method: "POST" }).catch(() => {});
  } catch (_) {}
}

function openStyleDialog(item, onDone) {
  ensureStore();
  closeStyleDialog();
  const editing = !!(item && item.name);
  const mask = document.createElement("div");
  mask.style.cssText =
    "position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;pointer-events:auto;";
  const panel = document.createElement("div");
  panel.style.cssText =
    "width:360px;max-width:calc(100vw - 32px);background:#1a1a1a;color:#ddd;border:1px solid #444;border-radius:8px;padding:12px;box-sizing:border-box;font-size:12px;";
  const title = document.createElement("div");
  title.textContent = editing ? "编辑风格" : "添加风格";
  title.style.cssText = "font-weight:600;margin-bottom:8px;color:#cfd3dc;";
  const lab = (text) => {
    const d = document.createElement("div");
    d.textContent = text;
    d.style.cssText = "margin:8px 0 4px;color:#bbb;";
    return d;
  };
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "名字";
  nameInput.title = "名字";
  nameInput.value = editing ? item.name : "";
  nameInput.style.cssText =
    "width:100%;box-sizing:border-box;background:#111;color:#eee;border:1px solid #444;border-radius:4px;padding:6px 8px;";
  const promptInput = document.createElement("textarea");
  promptInput.placeholder = "风格";
  promptInput.title = "风格";
  promptInput.value = editing ? item.prompt || "" : "";
  promptInput.style.cssText =
    "width:100%;box-sizing:border-box;height:96px;resize:vertical;background:#111;color:#eee;border:1px solid #444;border-radius:4px;padding:6px 8px;";
  const err = document.createElement("div");
  err.style.cssText = "min-height:16px;color:#f66;margin-top:6px;";
  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:8px;";
  const btnCss =
    "cursor:pointer;border:1px solid #555;border-radius:4px;padding:4px 12px;background:#333;color:#eee;";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "取消";
  cancelBtn.title = "取消";
  cancelBtn.style.cssText = btnCss;
  const okBtn = document.createElement("button");
  okBtn.type = "button";
  okBtn.textContent = "保存";
  okBtn.title = "保存";
  okBtn.style.cssText = btnCss;
  actions.appendChild(cancelBtn);
  actions.appendChild(okBtn);
  panel.appendChild(title);
  panel.appendChild(lab("名字"));
  panel.appendChild(nameInput);
  panel.appendChild(lab("风格"));
  panel.appendChild(promptInput);
  panel.appendChild(err);
  panel.appendChild(actions);
  mask.appendChild(panel);
  const stop = (e) => e.stopPropagation();
  mask.addEventListener("pointerdown", stop);
  mask.addEventListener("wheel", stop, { passive: true });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    try {
      mask.remove();
    } catch (_) {}
    if (_closeStyleDialog === close) _closeStyleDialog = null;
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener("keydown", onKey, true);
  cancelBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  okBtn.onclick = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const name = nameInput.value.trim();
    if (!name) {
      err.textContent = "请填写名字";
      return;
    }
    okBtn.disabled = true;
    try {
      await onDone?.({
        action: "save",
        name,
        prompt: promptInput.value,
        old_name: editing ? item.name : "",
      });
      close();
    } catch (ex) {
      err.textContent = ex?.message || "保存失败";
      okBtn.disabled = false;
    }
  };
  _closeStyleDialog = close;
  document.body.appendChild(mask);
  try {
    nameInput.focus();
  } catch (_) {}
}

app.registerExtension({
  name: "Lazy.Yue.Workbench",
  async setup() {
    api.addEventListener("lazy_yue_abc", (ev) => {
      let data = ev?.detail;
      if (Array.isArray(data)) data = data[0];
      if (!data || typeof data !== "object") return;
      for (const node of findBenches(data.node_id)) {
        try {
          node._lazyYueWB?.applyAbc?.(String(data.abc || ""));
        } catch (e) {
          console.warn("[LazyYuE] 回写乐谱:", e);
        }
      }
    });
    api.addEventListener("lazy_yue_lyrics", (ev) => {
      let data = ev?.detail;
      if (Array.isArray(data)) data = data[0];
      if (!data || typeof data !== "object") return;
      for (const node of findBenches(data.node_id)) {
        try {
          node._lazyYueWB?.applyLyrics?.(String(data.lyrics || ""));
        } catch (e) {
          console.warn("[LazyYuE] 回写歌词:", e);
        }
      }
    });
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      const boot = (left) => {
        if (this._lazyYueWB) return;
        if (!this.widgets?.some((w) => w?.name === "风格")) {
          if (left > 0) setTimeout(() => boot(left - 1), 50);
          return;
        }
        try {
          setupWorkbench(this);
        } catch (e) {
          console.error("[LazyYuE] 初始化失败:", e);
        }
      };
      requestAnimationFrame(() => boot(8));
      return r;
    };
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      requestAnimationFrame(() => {
        try {
          if (!this._lazyYueWB) setupWorkbench(this);
          else this._lazyYueWB.refresh?.();
        } catch (e) {
          console.error("[LazyYuE] configure:", e);
        }
      });
      return r;
    };
  },
});

function setupWorkbench(node) {
  if (node._lazyYueWB) return;
  const wStyle = findW(node, "风格");
  if (!wStyle) return;
  const wLyrics = findW(node, "歌词");
  const wTrack = findW(node, "主轨");
  const wAbc = findW(node, "乐谱");
  const wRaw = findW(node, "原谱");
  const wEdited = findW(node, "改过");
  const wMode = findW(node, "模式");
  const wMake = findW(node, "出乐谱");
  const wOnly = findW(node, "只出乐谱");
  const wRec = findW(node, "识别歌词");
  const wStart = findW(node, "开始");
  const wEnd = findW(node, "结束");
  const wName = findW(node, "风格名");
  const wSec = findW(node, "秒数");
  const wAuto = findW(node, "自动");
  const wClips = findW(node, "段落");
  const wLang = findW(node, "语言");
  const wVocal = findW(node, "人声");
  const wBpm = findW(node, "速度");
  const wTimbre = findW(node, "嗓音");
  const wGenre = findW(node, "曲风");
  const wGear = findW(node, "配器");
  const wMood = findW(node, "情绪");
  let autoFit = wAuto ? !!wAuto.value : true;
  let scoreCanvas = null;
  let scoreGrid = null;
  let pitchCanvas = null;
  let scoreTime = null;
  let scoreNotes = [];
  let scoreChords = [];
  let scoreMeta = { meter: "4/4", bpm: 120, key: "C", title: "" };
  let scoreDrag = null;
  let scoreHome = false;
  let scoreEdited = !!wEdited?.value;
  let scoreLayoutKey = "";
  const LYRICS_H0 = 88;
  let lyricsH = LYRICS_H0;
  let fitBench = () => {};

  [wStyle, wLyrics, wTrack, wAbc, wRaw, wEdited, wMode, wMake, wOnly, wRec, wStart, wEnd, wName, wSec, wAuto, wClips, wLang, wVocal, wBpm, wTimbre, wGenre, wGear, wMood].forEach(hideWidget);

  const root = document.createElement("div");
  root.style.cssText =
    "width:100%;display:flex;flex-direction:column;gap:8px;box-sizing:border-box;pointer-events:auto;color:#ddd;font-size:12px;";
  root.addEventListener("pointerdown", (e) => e.stopPropagation());
  root.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

  const status = document.createElement("div");
  status.style.cssText =
    "font-weight:600;color:#d7e6ff;background:#1a2433;border:1px solid #345;border-radius:6px;padding:6px 8px;";

  const btnCss =
    "cursor:pointer;border:1px solid #555;border-radius:4px;padding:2px 8px;background:#333;color:#ccc;font-size:11px;";

  // —— 自定义风格栏 + 直接输入 ——
  const styleBox = document.createElement("div");
  styleBox.style.cssText =
    "border:1px solid #444;border-radius:8px;padding:8px;background:#1a1a1a;display:flex;flex-direction:column;gap:6px;";
  const styleHead = document.createElement("div");
  styleHead.style.cssText = "display:flex;justify-content:space-between;align-items:center;";
  const styleTitle = document.createElement("div");
  styleTitle.style.cssText = "font-weight:600;color:#cfd3dc;";
  styleTitle.textContent = "风格";
  const clearStyle = document.createElement("button");
  clearStyle.type = "button";
  clearStyle.textContent = "清除";
  clearStyle.title = "清除";
  clearStyle.style.cssText = btnCss;
  styleHead.appendChild(styleTitle);
  styleHead.appendChild(clearStyle);
  const optRow = document.createElement("div");
  optRow.style.cssText = "display:flex;flex-direction:column;gap:8px;max-height:280px;overflow:auto;padding-right:2px;";
  const fieldCss = "background:#222;color:#eee;border:1px solid #555;border-radius:4px;padding:3px 6px;";
  const LANGS = ["普通话", "粤语", "英语", "日语", "韩语", "闽南语", "客家话", "法语", "西班牙语", "葡萄牙语", "意大利语", "德语", "俄语", "阿拉伯语", "印地语", "泰语", "越南语", "印尼语", "马来语", "土耳其语", "荷兰语", "瑞典语", "波兰语", "希腊语", "乌克兰语", "菲律宾语", "波斯语", "希伯来语", "拉丁语"];
  const VOCALS = ["女声", "男声", "对唱", "合唱", "童声", "说唱", "戏腔", "吟唱", "假声", "无人声"];
  const TIMBRES = ["甜美", "沙哑", "磁性", "清亮", "低沉", "高亢", "气声", "沧桑", "空灵", "柔和", "温暖", "冷感", "烟嗓", "撕裂", "醇厚", "稚嫩", "慵懒", "耳语", "鼻音", "圆润", "歌剧腔"];
  const GENRES = ["流行", "抒情", "民谣", "摇滚", "硬摇", "朋克", "流行朋克", "金属", "黑金属", "死亡金属", "新金属", "电子", "舞曲", "浩室", "科技舞曲", "出神", "鼓打贝斯", "回响贝斯", "未来贝斯", "热带浩室", "嘻哈", "陷阱", "爵士", "爵士嘻哈", "R&B", "灵魂", "新灵魂", "放克", "布鲁斯", "雷鬼", "舞厅", "斯卡", "雷鬼顿", "乡村", "迪斯科", "合成器", "蒸汽波", "暗潮", "城市流行", "梦泡", "独立", "另类", "后摇", "前卫", "华丽摇滚", "车库", "哥特", "工业", "迷幻", "氛围", "轻音乐", "古典", "交响", "室内乐", "歌剧", "古风", "戏曲", "新国风", "拉丁", "波萨诺瓦", "萨尔萨", "探戈", "弗拉门戈", "福音", "洛菲", "芯片", "电影", "史诗", "儿歌", "摇篮曲", "进行曲", "实验", "噪音", "非洲节拍", "世界"];
  const GEARS = ["钢琴", "电钢", "风琴", "手风琴", "木吉他", "电吉他", "贝斯", "鼓", "电子鼓", "808", "弦乐", "小提琴", "大提琴", "竖琴", "古筝", "琵琶", "二胡", "笛子", "箫", "唢呐", "古琴", "扬琴", "笙", "葫芦丝", "马头琴", "萨克斯", "小号", "长号", "圆号", "长笛", "单簧管", "双簧管", "口琴", "尤克里里", "班卓", "曼陀林", "合成器", "钟琴", "马林巴", "木琴", "定音鼓", "康加", "卡洪", "太鼓", "三味线", "尺八"];
  const MOODS = ["浪漫", "伤感", "欢快", "治愈", "热血", "安静", "紧张", "史诗", "神秘", "暗黑", "梦幻", "怀旧", "孤独", "甜蜜", "愤怒", "平静", "希望", "压抑", "俏皮", "庄严", "清冷", "激昂", "思念", "释然", "恐怖", "温柔", "节日", "神圣"];
  function parsePicks(raw, choices) {
    const allow = new Set(choices);
    const out = [];
    String(raw || "")
      .split(/[,，、|/]+/)
      .forEach((part) => {
        const name = part.trim();
        if (!name || name === "不指定" || !allow.has(name) || out.indexOf(name) >= 0) return;
        out.push(name);
      });
    return out;
  }
  function chipGroup(label, widget, choices, exclusive) {
    const wrap = document.createElement("div");
    wrap.title = label + "。";
    wrap.style.cssText = "display:flex;flex-direction:column;gap:4px;";
    const lab = document.createElement("div");
    lab.textContent = label;
    lab.title = label + "。";
    lab.style.cssText = "color:#bbb;font-size:11px;";
    const row = document.createElement("div");
    row.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;";
    let picked = parsePicks(widget?.value, choices);
    const buttons = [];
    const paint = () => {
      buttons.forEach((b) => {
        const on = picked.indexOf(b.dataset.name) >= 0;
        b.style.background = on ? "#243044" : "#2a2a2a";
        b.style.color = on ? "#d7e6ff" : "#ccc";
        b.style.borderColor = on ? "#6af" : "#444";
      });
    };
    const commit = () => setVal(widget, picked.join("、"));
    choices.forEach((name) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = name;
      b.dataset.name = name;
      b.title = name;
      b.style.cssText =
        "cursor:pointer;border:1px solid #444;border-radius:999px;padding:2px 8px;background:#2a2a2a;color:#ccc;font-size:11px;";
      b.addEventListener("pointerdown", (e) => e.stopPropagation());
      b.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const on = picked.indexOf(name) >= 0;
        if (exclusive && name === exclusive) {
          picked = on ? [] : [name];
        } else if (on) {
          picked = picked.filter((item) => item !== name);
        } else {
          picked = picked.filter((item) => item !== exclusive);
          picked.push(name);
        }
        paint();
        commit();
      };
      buttons.push(b);
      row.appendChild(b);
    });
    wrap.appendChild(lab);
    wrap.appendChild(row);
    paint();
    return {
      wrap,
      value() {
        return picked.join("、");
      },
      refresh() {
        picked = parsePicks(widget?.value, choices);
        paint();
      },
      clear() {
        picked = [];
        paint();
        commit();
      },
    };
  }
  const langField = chipGroup("语言", wLang, LANGS);
  const genreField = chipGroup("曲风", wGenre, GENRES);
  const vocalField = chipGroup("人声", wVocal, VOCALS, "无人声");
  const timbreField = chipGroup("嗓音", wTimbre, TIMBRES);
  const gearField = chipGroup("配器", wGear, GEARS);
  const moodField = chipGroup("情绪", wMood, MOODS);
  const bpmWrap = document.createElement("label");
  bpmWrap.title = "速度。";
  bpmWrap.style.cssText = "display:flex;align-items:center;gap:4px;color:#ccc;";
  bpmWrap.appendChild(document.createTextNode("速度"));
  const bpmInput = document.createElement("input");
  bpmInput.type = "number";
  bpmInput.min = "0";
  bpmInput.max = "300";
  bpmInput.step = "1";
  bpmInput.title = "速度。";
  bpmInput.style.cssText = fieldCss + "width:64px;";
  bpmInput.value = String(parseInt(wBpm?.value, 10) || 0);
  const commitBpm = () => {
    let n = parseInt(bpmInput.value, 10);
    if (!Number.isFinite(n) || n < 0) n = 0;
    if (n > 300) n = 300;
    bpmInput.value = String(n);
    setVal(wBpm, n);
  };
  bpmInput.addEventListener("input", () => {
    const n = parseInt(bpmInput.value, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 300) setVal(wBpm, n);
  });
  bpmInput.addEventListener("change", commitBpm);
  bpmWrap.appendChild(bpmInput);
  bpmWrap.appendChild(document.createTextNode("BPM"));
  optRow.appendChild(langField.wrap);
  optRow.appendChild(genreField.wrap);
  optRow.appendChild(vocalField.wrap);
  optRow.appendChild(timbreField.wrap);
  optRow.appendChild(gearField.wrap);
  optRow.appendChild(moodField.wrap);
  optRow.appendChild(bpmWrap);
  const chipRow = document.createElement("div");
  chipRow.style.cssText =
    "display:flex;gap:6px;overflow-x:auto;padding-bottom:2px;min-height:64px;align-items:stretch;";
  const styleTa = document.createElement("textarea");
  styleTa.placeholder = "风格";
  styleTa.title = "风格";
  styleTa.rows = 3;
  styleTa.style.cssText =
    "width:100%;resize:none;box-sizing:border-box;background:#141414;color:#eee;border:1px solid #444;border-radius:6px;padding:6px;font:12px/1.45 sans-serif;";
  styleTa.value = String(wStyle.value || "");
  styleBox.appendChild(styleHead);
  styleBox.appendChild(optRow);
  styleBox.appendChild(chipRow);
  styleBox.appendChild(styleTa);

  let styles = [];
  let pickedPrompt = "";

  async function postStyle(payload) {
    const res = await api.fetchApi("/lazy_yue/styles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
    let data = {};
    try {
      data = await res.json();
    } catch (_) {}
    if (!res.ok || data?.ok === false) throw new Error(data?.error || "保存失败");
    return data;
  }
  function takeItems(data) {
    if (Array.isArray(data?.items)) styles = data.items;
  }
  function applyStyle(it) {
    const text = String(it?.prompt || "");
    pickedPrompt = text;
    setVal(wStyle, text);
    setVal(wName, it?.name || "");
    styleTa.value = text;
    paintChips();
  }
  function paintChips() {
    chipRow.innerHTML = "";
    const cur = String(wName?.value || "");
    (styles || []).forEach((it) => {
      const card = document.createElement("div");
      const on = cur && cur === it.name;
      card.style.cssText = `flex:0 0 108px;min-width:108px;min-height:64px;border:2px solid ${on ? "#6af" : "#333"};border-radius:6px;background:${on ? "#1a2a3a" : "#222"};padding:4px;display:flex;flex-direction:column;gap:4px;cursor:pointer;`;
      card.title = it.name;
      const ops = document.createElement("div");
      ops.style.cssText = "display:flex;gap:4px;";
      const mk = (text, fn) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = text;
        b.title = text;
        b.style.cssText =
          "flex:1;cursor:pointer;border:1px solid #555;border-radius:4px;padding:1px 0;background:#333;color:#ccc;font-size:10px;";
        b.addEventListener("pointerdown", (e) => e.stopPropagation());
        b.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          fn();
        };
        return b;
      };
      ops.appendChild(
        mk("编辑", () => {
          openStyleDialog(it, async (payload) => {
            const data = await postStyle(payload);
            takeItems(data);
            if (cur === it.name) setVal(wName, data?.item?.name || payload.name);
            await reloadStyles();
            paintChips();
          });
        })
      );
      ops.appendChild(
        mk("删除", async () => {
          if (!window.confirm("删除这个风格？")) return;
          const data = await postStyle({ action: "delete", name: it.name });
          takeItems(data);
          if (cur === it.name) {
            setVal(wName, "");
            pickedPrompt = "";
          }
          await reloadStyles();
          paintChips();
        })
      );
      const lab = document.createElement("div");
      lab.textContent = it.name;
      lab.style.cssText =
        "font-size:11px;text-align:center;color:#ddd;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;";
      card.appendChild(ops);
      card.appendChild(lab);
      card.onclick = () => {
        if (String(it.name) === "自定义") ensureStore();
        applyStyle(it);
      };
      chipRow.appendChild(card);
    });
    const plus = document.createElement("div");
    plus.textContent = "+";
    plus.title = "添加风格";
    plus.style.cssText =
      "flex:0 0 64px;border:2px dashed #555;border-radius:6px;background:#222;display:flex;align-items:center;justify-content:center;color:#9ab;font-size:28px;cursor:pointer;";
    plus.addEventListener("pointerdown", (e) => e.stopPropagation());
    plus.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openStyleDialog(null, async (payload) => {
        const data = await postStyle(payload);
        takeItems(data);
        const saved =
          data?.item ||
          (styles || []).find((x) => x.name === (data?.item?.name || payload.name));
        await reloadStyles();
        if (saved) applyStyle(saved);
        else paintChips();
      });
    };
    chipRow.appendChild(plus);
  }
  async function reloadStyles() {
    const urls = [`/lazy_yue/style_list?t=${Date.now()}`, `/lazy_yue/styles?t=${Date.now()}`];
    for (const url of urls) {
      try {
        const res = await api.fetchApi(url, { cache: "no-store" });
        const data = await res.json();
        if (!res.ok || data?.ok === false) continue;
        if (Array.isArray(data?.items)) {
          styles = data.items;
          break;
        }
      } catch (e) {
        console.warn("[LazyYuE] 风格列表失败:", e);
      }
    }
    const cur = styles.find((it) => it.name === wName?.value);
    pickedPrompt = cur ? String(cur.prompt || "") : pickedPrompt;
    paintChips();
  }
  styleTa.addEventListener("input", () => {
    setVal(wStyle, styleTa.value);
    if (styleTa.value !== pickedPrompt) {
      setVal(wName, "");
      pickedPrompt = "";
      paintChips();
    }
  });
  clearStyle.onclick = (e) => {
    e.stopPropagation();
    setVal(wStyle, "");
    setVal(wName, "");
    pickedPrompt = "";
    styleTa.value = "";
    langField.clear();
    genreField.clear();
    vocalField.clear();
    timbreField.clear();
    gearField.clear();
    moodField.clear();
    bpmInput.value = "0";
    setVal(wBpm, 0);
    paintChips();
  };

  function labeledArea(title, widget, placeholder, rows) {
    const box = document.createElement("div");
    box.style.cssText = "display:flex;flex-direction:column;gap:4px;";
    const lab = document.createElement("div");
    lab.style.cssText = "font-weight:600;color:#cfd3dc;";
    lab.textContent = title;
    const ta = document.createElement("textarea");
    ta.placeholder = placeholder;
    ta.title = title;
    ta.rows = rows;
    ta.style.cssText =
      "width:100%;height:" + LYRICS_H0 + "px;resize:none;overflow:auto;box-sizing:border-box;background:#141414;color:#eee;border:1px solid #444;border-radius:6px;padding:6px;font:12px/1.45 sans-serif;";
    ta.value = String(widget?.value || "");
    ta.addEventListener("input", () => setVal(widget, ta.value));
    const grip = document.createElement("div");
    grip.title = "高度。";
    grip.style.cssText =
      "display:flex;justify-content:center;align-items:center;height:12px;cursor:ns-resize;user-select:none;";
    const bar = document.createElement("div");
    bar.style.cssText = "width:36px;height:3px;border-radius:2px;background:#666;";
    grip.appendChild(bar);
    let dragH = null;
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragH = { y: e.clientY, h: ta.offsetHeight || lyricsH };
      try {
        grip.setPointerCapture(e.pointerId);
      } catch (_) {}
    });
    grip.addEventListener("pointermove", (e) => {
      if (!dragH) return;
      e.preventDefault();
      e.stopPropagation();
      lyricsH = Math.max(LYRICS_H0, Math.min(640, dragH.h + (e.clientY - dragH.y)));
      ta.style.height = lyricsH + "px";
      fitBench();
    });
    const endDrag = () => {
      dragH = null;
    };
    grip.addEventListener("pointerup", endDrag);
    grip.addEventListener("pointercancel", endDrag);
    box.appendChild(lab);
    box.appendChild(ta);
    box.appendChild(grip);
    return { box, ta };
  }
  const lyrics = labeledArea("歌词", wLyrics, "[Verse]  [Chorus]", 4);

  // —— 参考音频轨（多段） ——
  const SIDE = 92;
  const RULER = 18;
  const TRACK_H = 78;
  const trackBox = document.createElement("div");
  trackBox.style.cssText =
    "position:relative;border:1px solid #2a2a2a;border-radius:6px;background:#141414;display:flex;flex-direction:column;overflow:hidden;";
  const desk = document.createElement("div");
  desk.style.cssText = "display:flex;min-height:" + (RULER + TRACK_H) + "px;background:#101010;";
  const sideCol = document.createElement("div");
  sideCol.style.cssText =
    "width:" + SIDE + "px;flex:0 0 " + SIDE + "px;display:flex;flex-direction:column;background:#1e1e1e;border-right:1px solid #2a2a2a;";
  const sideRuler = document.createElement("div");
  sideRuler.style.cssText = "height:" + RULER + "px;flex:0 0 " + RULER + "px;background:#1a1a1a;border-bottom:1px solid #111;";
  const side = document.createElement("div");
  side.style.cssText =
    "flex:1;display:flex;align-items:center;justify-content:center;gap:6px;color:#ccc;font-size:12px;font-weight:700;";
  const sideLab = document.createElement("span");
  sideLab.textContent = "参考音频";
  const eyeBtn = document.createElement("button");
  eyeBtn.type = "button";
  eyeBtn.title = "静音";
  eyeBtn.style.cssText =
    "cursor:pointer;border:none;background:transparent;color:#aaa;width:14px;height:14px;padding:0;display:inline-flex;align-items:center;justify-content:center;";
  side.appendChild(sideLab);
  side.appendChild(eyeBtn);
  sideCol.appendChild(sideRuler);
  sideCol.appendChild(side);
  const view = document.createElement("div");
  view.style.cssText = "flex:1;min-width:0;overflow:hidden;background:#121212;";
  const wave = document.createElement("canvas");
  wave.style.cssText = "display:block;height:" + (RULER + TRACK_H) + "px;";
  view.appendChild(wave);
  desk.appendChild(sideCol);
  desk.appendChild(view);

  const info = document.createElement("div");
  info.style.cssText =
    "display:flex;align-items:center;gap:8px;padding:4px 8px 0;color:#ddd;font-size:12px;background:#161616;";
  const infoTime = document.createElement("span");
  infoTime.style.cssText =
    "font-weight:700;font-family:ui-monospace,monospace;font-variant-numeric:tabular-nums;display:inline-block;width:9ch;flex:0 0 9ch;text-align:left;";
  infoTime.textContent = "0.00s";
  const infoRange = document.createElement("span");
  infoRange.style.cssText = "color:#bbb;";
  infoRange.textContent = "开始：-  |  结束：-  |  长度：-";
  info.appendChild(infoTime);
  info.appendChild(infoRange);

  const playRow = document.createElement("div");
  playRow.style.cssText =
    "display:flex;align-items:center;gap:10px;padding:4px 8px 6px;background:#161616;";
  const iconBtn = (text, title) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.title = title;
    b.style.cssText =
      "width:28px;height:26px;cursor:pointer;border:1px solid #444;border-radius:4px;background:#2a2a2a;color:#eee;padding:0;";
    return b;
  };
  const playBtn = iconBtn("▶", "播放");
  const loopBtn = iconBtn("↻", "循环");
  const cutBtn = iconBtn("✂", "裁切");
  const seek = document.createElement("input");
  seek.type = "range";
  seek.min = "0";
  seek.max = "1000";
  seek.value = "0";
  seek.title = "播放";
  seek.style.cssText =
    "flex:1;height:6px;accent-color:#f44;cursor:pointer;background:#444;border-radius:3px;";
  const zoomOut = iconBtn("−", "缩小");
  const zoom = document.createElement("input");
  zoom.type = "range";
  zoom.min = "1";
  zoom.max = "4";
  zoom.step = "0.1";
  zoom.value = "1";
  zoom.title = "缩放";
  zoom.style.cssText = "width:72px;accent-color:#aaa;cursor:pointer;";
  const zoomIn = iconBtn("+", "放大");
  const zoomFit = iconBtn("↔", "适应");
  const secWrap = document.createElement("div");
  secWrap.style.cssText =
    "display:flex;flex-direction:column;align-items:flex-end;gap:2px;margin-left:4px;";
  const autoLab = document.createElement("label");
  autoLab.title = "自动";
  autoLab.style.cssText = "display:flex;align-items:center;gap:4px;color:#ccc;font-size:11px;cursor:pointer;";
  const autoCb = document.createElement("input");
  autoCb.type = "checkbox";
  autoCb.title = "自动";
  autoCb.checked = autoFit;
  const autoText = document.createElement("span");
  autoText.textContent = "自动";
  autoLab.appendChild(autoCb);
  autoLab.appendChild(autoText);
  const secBox = document.createElement("label");
  secBox.title = "秒数";
  secBox.style.cssText = "display:flex;align-items:center;gap:4px;color:#ccc;";
  const secLab = document.createElement("span");
  secLab.textContent = "秒数";
  const secInput = document.createElement("input");
  secInput.type = "number";
  secInput.min = "1";
  secInput.max = "900";
  secInput.step = "0.1";
  secInput.title = "秒数";
  const sec0 = parseFloat(wSec?.value);
  secInput.value = secondsText(Number.isFinite(sec0) && sec0 > 0 ? sec0 : 120);
  secInput.style.cssText =
    "width:58px;background:#222;color:#fff;border:1px solid #444;border-radius:4px;padding:3px 4px;text-align:center;";
  secBox.appendChild(secLab);
  secBox.appendChild(secInput);
  secWrap.appendChild(autoLab);
  secWrap.appendChild(secBox);
  playRow.appendChild(playBtn);
  playRow.appendChild(loopBtn);
  playRow.appendChild(cutBtn);
  playRow.appendChild(seek);
  playRow.appendChild(zoomOut);
  playRow.appendChild(zoom);
  playRow.appendChild(zoomIn);
  playRow.appendChild(zoomFit);
  playRow.appendChild(secWrap);

  {
    let st = document.getElementById("lazy-yue-desk-css");
    if (!st) {
      st = document.createElement("style");
      st.id = "lazy-yue-desk-css";
      document.head.appendChild(st);
    }
    st.textContent =
      ".lazy-yue-seek{-webkit-appearance:none;appearance:none;height:6px;background:#444;border-radius:3px;outline:none;border:1px solid #222;}" +
      ".lazy-yue-seek::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:14px;height:14px;border-radius:50%;background:#ff4444;cursor:pointer;border:2px solid #222;}" +
      ".lazy-yue-zoom{-webkit-appearance:none;appearance:none;height:4px;background:#444;border-radius:2px;outline:none;}" +
      ".lazy-yue-zoom::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:12px;height:12px;border-radius:50%;background:#aaa;cursor:pointer;}" +
      ".lazy-yue-on{color:#4fff8f !important;border-color:#4fff8f !important;background:#1a3a2a !important;}" +
      ".lazy-yue-pan{flex:1;min-width:0;width:auto;height:14px;margin:0;-webkit-appearance:none;appearance:none;background:transparent;cursor:pointer;}" +
      ".lazy-yue-pan::-webkit-slider-runnable-track{height:6px;background:#333;border-radius:3px;}" +
      ".lazy-yue-pan::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;height:12px;width:36px;margin-top:-3px;background:#9a9a9a;border-radius:3px;border:1px solid #222;cursor:pointer;}" +
      ".lazy-yue-pan::-moz-range-track{height:6px;background:#333;border-radius:3px;}" +
      ".lazy-yue-pan::-moz-range-thumb{height:12px;width:36px;background:#9a9a9a;border:1px solid #222;border-radius:3px;cursor:pointer;}";
  }
  seek.className = "lazy-yue-seek";
  zoom.className = "lazy-yue-zoom";
  const ICON_PLAY =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20"/></svg>';
  const ICON_PAUSE =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
  const ICON_LOOP =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12A9 9 0 0 0 6 5.3L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 15 6.7l3-2.7"/><path d="M21 21v-5h-5"/></svg>';
  const ICON_CUT =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>';
  const EYE_ON =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  playBtn.innerHTML = ICON_PLAY;
  loopBtn.innerHTML = ICON_LOOP;
  cutBtn.innerHTML = ICON_CUT;
  zoomOut.innerHTML = "−";
  zoomIn.innerHTML = "+";
  zoomFit.innerHTML = "↔";

  const audio = document.createElement("audio");
  audio.preload = "auto";
  audio.style.display = "none";
  const file = document.createElement("input");
  file.type = "file";
  file.accept = "audio/*,.mp3,.wav,.flac,.ogg,.m4a,.aac,.wma,.aif,.aiff,.opus";
  file.multiple = true;
  file.style.display = "none";
  const playLine = document.createElement("div");
  playLine.style.cssText =
    "position:absolute;top:14px;width:2px;background:#ff4444;pointer-events:none;z-index:6;display:none;";
  const panRow = document.createElement("div");
  panRow.style.cssText = "display:none;align-items:center;height:16px;background:#141414;";
  const panSide = document.createElement("div");
  panSide.style.cssText = "width:" + SIDE + "px;flex:0 0 " + SIDE + "px;";
  const pan = document.createElement("input");
  pan.type = "range";
  pan.min = "0";
  pan.max = "0";
  pan.step = "1";
  pan.value = "0";
  pan.title = "滚动";
  pan.className = "lazy-yue-pan";
  pan.style.flex = "1";
  pan.style.minWidth = "0";
  pan.style.width = "auto";
  panRow.appendChild(panSide);
  panRow.appendChild(pan);
  trackBox.appendChild(desk);
  trackBox.appendChild(panRow);
  trackBox.appendChild(info);
  trackBox.appendChild(playRow);
  trackBox.appendChild(audio);
  trackBox.appendChild(file);
  trackBox.appendChild(playLine);

  let duration = 0;
  let loopOn = false;
  let wantPlay = false;
  let playIcon = "";
  let heard = true;
  let drag = null;
  let scrub = false;
  let seeking = false;
  let dragOver = false;
  let playName = "";
  let adding = false;
  const sourceCache = new Map();
  const sourcePend = new Map();
  let layout = { slot: null, clip: null, clips: [], w: 320, playX: 0 };
  let lastView = 0;

  function num(w, fallback) {
    const n = parseFloat(w?.value);
    return Number.isFinite(n) ? n : fallback;
  }
  function paintEye() {
    eyeBtn.style.color = heard ? "#aaa" : "#444";
    eyeBtn.innerHTML = heard ? EYE_ON : EYE_OFF;
  }
  function paintPlay() {
    const next = wantPlay ? "pause" : "play";
    if (playIcon !== next) {
      playIcon = next;
      playBtn.innerHTML = wantPlay ? ICON_PAUSE : ICON_PLAY;
    }
    loopBtn.classList.toggle("lazy-yue-on", loopOn);
  }
  function viewW() {
    return Math.max(180, view.clientWidth || 320);
  }
  function layoutSpan() {
    let span = rulerSpan();
    if (scoreNotes && scoreNotes.length && scoreMeta) {
      let noteEnd = 0;
      for (const n of scoreNotes) noteEnd = Math.max(noteEnd, (n.s || 0) + (n.d || 0));
      const sec = abcTicksToSec(noteEnd, scoreMeta.bpm);
      if (sec > span) span = sec;
    }
    return span;
  }
  function canvasW() {
    return Math.round(layoutSpan() * pxPerSec()) + (clips.length ? 96 : 0);
  }
  function traceRound(ctx, x, y, w, h, r) {
    ctx.beginPath();
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    if (ctx.roundRect) ctx.roundRect(x, y, Math.max(0, w), Math.max(0, h), rr);
    else ctx.rect(x, y, Math.max(0, w), Math.max(0, h));
  }
  function tickLabel(t) {
    return String(Math.round(t));
  }
  function drawRuler(ctx, w, span) {
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(0, 0, w, RULER);
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    let major = steps[steps.length - 1];
    for (let i = 0; i < steps.length; i++) {
      if ((steps[i] / span) * w >= 56) {
        major = steps[i];
        break;
      }
    }
    const minor = major >= 60 ? 10 : major >= 10 ? major / 5 : major >= 2 ? 1 : 0.5;
    ctx.fillStyle = "#555";
    const nMinor = Math.ceil(span / minor);
    for (let i = 0; i <= nMinor && i < 4000; i++) {
      const t = i * minor;
      if (t > span) break;
      if (Math.abs(t / major - Math.round(t / major)) < 0.02) continue;
      ctx.fillRect(Math.floor((t / span) * w), RULER - 3, 1, 3);
    }
    ctx.font = "10px sans-serif";
    ctx.textBaseline = "middle";
    const nMajor = Math.ceil(span / major);
    for (let i = 0; i <= nMajor && i < 500; i++) {
      const t = i * major;
      if (t > span + 0.001) break;
      const x = (t / span) * w;
      ctx.fillStyle = "#aaa";
      ctx.fillRect(Math.floor(x), RULER - 6, 1, 6);
      const label = tickLabel(t);
      const half = ctx.measureText(label).width / 2 + 2;
      if (t > 0.001 && x > half && x < w - half) {
        ctx.textAlign = "center";
        ctx.fillText(label, x, 8);
      }
    }
    ctx.textAlign = "left";
    ctx.fillStyle = "#eee";
    ctx.fillText("0", 3, 8);
    ctx.fillStyle = "#111";
    ctx.fillRect(0, RULER - 1, w, 1);
  }
  let clips = [];
  let selectedId = 0;
  let playhead = 0;
  let nextId = 1;
  let hoverDesk = false;
  let playTimer = 0;
  let playStamp = 0;
  const MIN_LEN = 0.05;

  function round2(n) {
    return Math.round(Number(n) * 100) / 100;
  }
  function contentEnd() {
    let end = 0;
    for (const c of clips) end = Math.max(end, c.t1 || 0);
    return end;
  }
  function quantizeSec(sec) {
    let n = Math.round((Number(sec) || 0) * 10) / 10;
    if (n < 1) n = 1;
    if (n > 900) n = 900;
    if (Math.abs(n - Math.round(n)) < 0.05) n = Math.round(n);
    return n;
  }
  function secondsText(sec) {
    const n = quantizeSec(sec);
    if (Math.abs(n - Math.round(n)) < 0.001) return String(Math.round(n));
    return n.toFixed(1);
  }
  function setSeconds() {
    const n = num(wSec, 120);
    return Math.min(900, Math.max(1, Number.isFinite(n) && n > 0 ? n : 120));
  }
  function ownScoreSeconds() {
    if (!scoreNotes || !scoreNotes.length) return 0;
    const end = abcSongEnd(scoreMeta, scoreNotes, 0);
    const sec = abcTicksToSec(end.total, end.bpm);
    return sec > 0.05 ? sec : 0;
  }
  function autoSeconds() {
    const audioEnd = contentEnd();
    if (audioEnd > 0.05) return audioEnd;
    return ownScoreSeconds();
  }
  let syncingSec = false;
  function syncAutoSeconds() {
    if (!autoFit || syncingSec) return;
    if (document.activeElement === secInput) return;
    const raw = autoSeconds();
    if (!(raw > 0.05)) return;
    const v = quantizeSec(raw);
    const shown = secondsText(v);
    const cur = quantizeSec(parseFloat(secInput.value));
    if (secInput.value === shown && Math.abs(num(wSec, -1) - v) < 0.001) return;
    if (Math.abs(cur - v) < 0.001 && Math.abs(num(wSec, -1) - v) < 0.001) {
      secInput.value = shown;
      return;
    }
    syncingSec = true;
    secInput.value = shown;
    setVal(wSec, v);
    syncingSec = false;
  }
  function timeSpan() {
    if (drag && drag.span > 0 && drag.kind !== "play") return drag.span;
    if (!autoFit) return setSeconds();
    const end = contentEnd();
    if (end > 0.05) return Math.max(end, 1);
    const musical = ownScoreSeconds();
    if (musical > 0.05) return musical;
    return Math.max(end > 0 ? end : 10, 1);
  }
  function rulerSpan() {
    return Math.max(timeSpan(), contentEnd(), 0.001);
  }
  function basisSpan() {
    return timeSpan();
  }
  function zoomBase() {
    const z = Math.max(1, Math.min(4, parseFloat(zoom.value) || 1));
    return Math.round(viewW() * z);
  }
  function pxPerSec() {
    return zoomBase() / timeSpan();
  }
  function viewSpan() {
    return timeSpan();
  }
  function naturalSpan() {
    return Math.max(contentEnd(), 0.001);
  }
  function activeSpan() {
    return layoutSpan();
  }
  function sortedClips() {
    return clips.slice().sort((a, b) => a.t0 - b.t0);
  }
  function neighborsOf(id) {
    const list = sortedClips();
    const i = list.findIndex((c) => c.id === id);
    return {
      prev: i > 0 ? list[i - 1] : null,
      next: i >= 0 && i < list.length - 1 ? list[i + 1] : null,
    };
  }
  function findClip(t) {
    for (const c of sortedClips()) {
      if (t >= c.t0 - 0.0001 && t < c.t1 - 0.0001) return c;
    }
    return null;
  }
  function parseClips(raw, fallback) {
    let arr;
    try {
      arr = JSON.parse(raw);
    } catch (_) {
      return [];
    }
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const it of arr) {
      if (!it) continue;
      let s0 = Number(it.s0);
      let s1 = Number(it.s1);
      let t0 = Number(it.t0);
      if (![s0, s1, t0].every(Number.isFinite)) continue;
      const name = String(it.name || fallback || "").trim();
      if (!name) continue;
      s0 = Math.max(0, s0);
      if (s1 - s0 < MIN_LEN) continue;
      const len = s1 - s0;
      t0 = Math.max(0, t0);
      out.push({
        id: ++nextId,
        t0,
        t1: t0 + len,
        s0,
        s1: s0 + len,
        name,
        dur: 0,
        peaks: null,
      });
    }
    out.sort((a, b) => a.t0 - b.t0);
    for (let i = 1; i < out.length; i++) {
      if (out[i].t0 < out[i - 1].t1) {
        const shift = out[i - 1].t1 - out[i].t0;
        out[i].t0 += shift;
        out[i].t1 += shift;
      }
    }
    return out;
  }
  function loadClipsFromWidgets() {
    const fallback = String(wTrack?.value || "").trim();
    const raw = String(wClips?.value || "").trim();
    if (raw) {
      const parsed = parseClips(raw, fallback);
      if (parsed.length) return parsed;
    }
    if (!fallback) return [];
    let s0 = Math.max(0, num(wStart, 0));
    let s1 = num(wEnd, 0);
    const hasRange = s1 > s0 + 0.04;
    const len = hasRange ? s1 - s0 : MIN_LEN;
    return [{
      id: ++nextId,
      t0: 0,
      t1: len,
      s0,
      s1: hasRange ? s0 + len : 0,
      name: fallback,
      dur: 0,
      peaks: null,
      full: !hasRange,
    }];
  }
  function commitClips() {
    const data = sortedClips().map((c) => ({
      t0: round2(c.t0),
      t1: round2(c.t1),
      s0: round2(c.s0),
      s1: round2(c.s1),
      name: c.name || "",
    }));
    setVal(wClips, data.length ? JSON.stringify(data) : "");
    setVal(wTrack, data[0]?.name || "");
    if (data.length === 1 && data[0].t0 <= 0.001) {
      setVal(wStart, data[0].s0);
      setVal(wEnd, data[0].s1);
    } else if (!data.length) {
      setVal(wStart, 0);
      setVal(wEnd, 0);
    } else {
      setVal(wStart, 0);
      setVal(wEnd, round2(data[data.length - 1].t1));
    }
    paintStatus();
    onScoreBase();
  }
  function stopClock() {
    wantPlay = false;
    try {
      audio.pause();
    } catch (_) {}
    if (playTimer) cancelAnimationFrame(playTimer);
    playTimer = 0;
    playStamp = 0;
  }
  function placeAudio() {
    const c = findClip(playhead);
    if (!c || !c.name) {
      if (!audio.paused) audio.pause();
      return;
    }
    const srcT = Math.min(Math.max(c.s0, c.s1 - 0.01), c.s0 + Math.max(0, playhead - c.t0));
    if (playName !== c.name) {
      playName = c.name;
      audio.dataset.lazyName = c.name;
      const want = srcT;
      const onReady = () => {
        audio.removeEventListener("loadedmetadata", onReady);
        if (playName !== c.name) return;
        try {
          audio.currentTime = want;
        } catch (_) {}
        if (wantPlay && audio.paused) {
          audio.play().catch(() => {
            wantPlay = false;
            paintPlay();
          });
        }
      };
      audio.addEventListener("loadedmetadata", onReady);
      audio.src = viewUrl(c.name);
      return;
    }
    const cur = Number(audio.currentTime) || 0;
    if (Math.abs(cur - srcT) > 0.12) {
      try {
        audio.currentTime = srcT;
      } catch (_) {}
    }
    if (wantPlay && audio.paused) {
      audio.play().catch(() => {
        wantPlay = false;
        paintPlay();
      });
    }
  }
  function tickPlay(now) {
    if (!wantPlay) return;
    if (!playStamp) playStamp = now;
    const dt = Math.min(0.1, Math.max(0, (now - playStamp) / 1000));
    playStamp = now;
    const hold = seeking || scrub;
    const c = findClip(playhead);
    const same = !!(c && playName === c.name);
    if (!hold && same && !audio.paused && audio.currentTime >= c.s0 - 0.05 && audio.currentTime <= c.s1 + 0.08) {
      playhead = c.t0 + Math.max(0, audio.currentTime - c.s0);
      if (playhead > c.t1) playhead = c.t1;
    } else if (!hold) {
      playhead += dt;
    }
    const end = naturalSpan();
    if (playhead >= end - 0.02) {
      if (loopOn) {
        playhead = 0;
        placeAudio();
      } else {
        playhead = 0;
        stopClock();
        paint();
        return;
      }
    } else {
      placeAudio();
    }
    paint();
    playTimer = requestAnimationFrame(tickPlay);
  }
  function togglePlay() {
    if (!clips.length) return;
    if (wantPlay) {
      stopClock();
      paint();
      return;
    }
    if (playhead >= naturalSpan() - 0.02) playhead = 0;
    wantPlay = true;
    playStamp = 0;
    placeAudio();
    paintPlay();
    playTimer = requestAnimationFrame(tickPlay);
  }
  function paint() {
    syncAutoSeconds();
    const w = canvasW();
    const h = RULER + TRACK_H;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const bw = Math.max(1, Math.floor(w * dpr));
    const bh = Math.max(1, Math.floor(h * dpr));
    if (wave.width !== bw || wave.height !== bh) {
      wave.width = bw;
      wave.height = bh;
    }
    wave.style.width = w + "px";
    wave.style.height = h + "px";
    const ctx = wave.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const extra = clips.length ? 96 : 0;
    const timeW = Math.max(1, w - extra);
    const span = Math.max(0.001, activeSpan());
    drawRuler(ctx, timeW, span);
    if (w > timeW) {
      ctx.fillStyle = "#1a1a1a";
      ctx.fillRect(timeW, 0, w - timeW, RULER);
      ctx.fillStyle = "#111";
      ctx.fillRect(timeW, RULER - 1, w - timeW, 1);
    }
    ctx.fillStyle = "#121212";
    ctx.fillRect(0, RULER, w, TRACK_H);
    layout = { slot: null, clip: null, clips: [], w, timeW, playX: 0 };
    if (!clips.length) drawEmptySlot(ctx);
    else drawClips(ctx, timeW, span);
    const cur = Math.max(0, Math.min(span, playhead || 0));
    const px = (cur / span) * timeW;
    layout.playX = px;
    ctx.fillStyle = "#ff4444";
    ctx.beginPath();
    ctx.moveTo(px - 6, 0);
    ctx.lineTo(px + 6, 0);
    ctx.lineTo(px + 6, 8);
    ctx.lineTo(px, 14);
    ctx.lineTo(px - 6, 8);
    ctx.closePath();
    ctx.fill();
    const shown = clips.find((c) => c.id === selectedId) || findClip(playhead) || (clips.length === 1 ? clips[0] : null);
    let labelS = "-";
    let labelE = "-";
    let labelL = "-";
    if (!clips.length) {
      labelS = "-";
    } else if (shown) {
      labelS = fmt(shown.t0);
      labelE = fmt(shown.t1);
      labelL = fmt(shown.t1 - shown.t0);
    } else if (clips.length) {
      labelS = fmt(Math.min(...clips.map((c) => c.t0)));
      labelE = fmt(Math.max(...clips.map((c) => c.t1)));
      labelL = fmt(clips.reduce((n, c) => n + (c.t1 - c.t0), 0));
    }
    infoTime.textContent = fmt(cur) + "s";
    infoRange.textContent = "开始：" + labelS + "  |  结束：" + labelE + "  |  长度：" + labelL;
    if (!seeking) seek.value = span ? String(Math.round((cur / span) * 1000)) : "0";
    paintPlay();
    updateScorePlay();
    syncPan();
    if (scoreCanvas && scoreLayoutKey !== scoreKey()) paintScore();
  }
  function drawAdd(ctx, x, y, slotW, slotH) {
    ctx.save();
    traceRound(ctx, x, y, slotW, slotH, 6);
    ctx.clip();
    ctx.fillStyle = dragOver ? "#1a2430" : "#1a1a1a";
    ctx.fillRect(x, y, slotW, slotH);
    ctx.restore();
    ctx.strokeStyle = dragOver ? "#5af" : "#444";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    traceRound(ctx, x, y, slotW, slotH, 6);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#888";
    ctx.font = "20px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("＋", x + slotW / 2, y + slotH / 2);
    layout.slot = { x, y, w: slotW, h: slotH };
  }
  function drawEmptySlot(ctx) {
    const slotH = Math.max(36, Math.min(TRACK_H - 12, 64));
    const slotW = Math.round(slotH * 1.15);
    drawAdd(ctx, 8, RULER + (TRACK_H - slotH) / 2, slotW, slotH);
  }
  function drawWaveSlice(ctx, c, x0, x1, y, bh) {
    const peaks = c.peaks;
    const dur = c.dur || 0;
    if (!peaks || !peaks.length || x1 - x0 < 2 || !(c.s1 > c.s0) || !(dur > 0)) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y, Math.max(1, x1 - x0), bh);
    ctx.clip();
    ctx.strokeStyle = "#5af";
    ctx.lineWidth = 1;
    ctx.beginPath();
    const mid = y + bh / 2;
    const width = Math.max(1, x1 - x0);
    const step = Math.max(1, Math.floor(width / 220));
    for (let px = 0; px < width; px += step) {
      const u = (c.s0 + (px / width) * (c.s1 - c.s0)) / Math.max(0.001, dur);
      const i = Math.min(peaks.length - 1, Math.max(0, Math.floor(u * peaks.length)));
      const amp = Math.max(2, peaks[i] * (bh - 18));
      ctx.moveTo(x0 + px, mid - amp / 2);
      ctx.lineTo(x0 + px, mid + amp / 2);
    }
    ctx.stroke();
    ctx.restore();
  }
  function drawClips(ctx, w, span) {
    const y = RULER + 8;
    const bh = TRACK_H - 16;
    const list = sortedClips();
    const drawList =
      drag && drag.kind === "move" ? list.filter((c) => c.id !== drag.id).concat(list.filter((c) => c.id === drag.id)) : list;
    layout.clips = [];
    drawList.forEach((c) => {
      const idx = list.findIndex((x) => x.id === c.id);
      let x0 = (c.t0 / span) * w;
      let x1 = (c.t1 / span) * w;
      if (x0 > 0) x0 += 1;
      if (x1 < w - 1) x1 -= 1;
      if (x1 < x0 + 4) x1 = x0 + 4;
      const selected = c.id === selectedId;
      const wide = x1 - x0 >= 16;
      ctx.save();
      traceRound(ctx, x0, y, x1 - x0, bh, 4);
      ctx.clip();
      ctx.fillStyle = selected ? "#24344a" : "#1a2430";
      ctx.fillRect(x0, y, x1 - x0, bh);
      drawWaveSlice(ctx, c, x0, x1, y, bh);
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(x0 + 3, y + 3, 16, 14);
      ctx.fillStyle = "#9cf";
      ctx.font = "bold 10px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(idx + 1), x0 + 11, y + 10);
      if (x1 - x0 > 70) {
        const label = String(c.name || "").split("/").pop() || "";
        const text = label.length > 18 ? label.slice(0, 18) : label;
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(x0, y + bh - 16, x1 - x0, 16);
        ctx.fillStyle = "#ddd";
        ctx.font = "10px sans-serif";
        ctx.fillText(text, (x0 + x1) / 2, y + bh - 8);
      }
      const bx = x1 - 20;
      const by = y + 3;
      if (wide) {
        ctx.fillStyle = "rgba(0,0,0,0.65)";
        ctx.fillRect(bx, by, 16, 16);
        ctx.fillStyle = "#fff";
        ctx.font = "12px sans-serif";
        ctx.fillText("×", bx + 8, by + 8);
      }
      ctx.restore();
      ctx.strokeStyle = selected ? "#ffe08a" : "#5a7a9a";
      ctx.lineWidth = selected ? 2 : 1;
      traceRound(ctx, x0, y, Math.max(4, x1 - x0), bh, 4);
      ctx.stroke();
      ctx.fillStyle = selected ? "#fff" : "#c8c8c8";
      const hy = y + bh / 2 - 14;
      traceRound(ctx, x0 - 1, hy, 5, 28, 2);
      ctx.fill();
      traceRound(ctx, x1 - 4, hy, 5, 28, 2);
      ctx.fill();
      layout.clips.push({
        id: c.id,
        x0,
        x1,
        y,
        h: bh,
        xBtn: wide ? { x: bx, y: by, w: 16, h: 16 } : null,
      });
    });
    const slotH = Math.max(36, Math.min(TRACK_H - 12, 64));
    const slotW = Math.round(slotH * 1.05);
    drawAdd(ctx, w + 16, RULER + (TRACK_H - slotH) / 2, slotW, slotH);
  }
  async function loadPeaks(src) {
    let actx = null;
    try {
      const res = await fetch(src);
      const buf = await res.arrayBuffer();
      actx = new (window.AudioContext || window.webkitAudioContext)();
      const audioBuf = await actx.decodeAudioData(buf.slice(0));
      const ch = audioBuf.getChannelData(0);
      const bars = 480;
      const step = Math.max(1, Math.floor(ch.length / bars));
      const next = [];
      for (let i = 0; i < bars; i++) {
        let m = 0;
        const off = i * step;
        for (let j = 0; j < step && off + j < ch.length; j += 8) {
          const v = Math.abs(ch[off + j]);
          if (v > m) m = v;
        }
        next.push(m);
      }
      return { peaks: next, dur: Number(audioBuf.duration) || 0 };
    } catch (err) {
      console.warn("[LazyYuE] 波形失败:", err);
      return null;
    } finally {
      try {
        actx && actx.close();
      } catch (_) {}
    }
  }
  function ensureSource(name) {
    if (!name) return Promise.resolve(null);
    if (sourceCache.has(name)) return Promise.resolve(sourceCache.get(name));
    if (sourcePend.has(name)) return sourcePend.get(name);
    const pending = loadPeaks(viewUrl(name)).then((got) => {
      if (got && got.dur > 0) {
        sourceCache.set(name, got);
        return got;
      }
      return null;
    }).finally(() => {
      sourcePend.delete(name);
    });
    sourcePend.set(name, pending);
    return pending;
  }
  let hydrateGen = 0;
  let hydrateWait = false;
  async function hydrate() {
    const gen = ++hydrateGen;
    const names = [...new Set(clips.map((c) => c.name).filter(Boolean))];
    await Promise.all(names.map((n) => ensureSource(n)));
    if (gen !== hydrateGen) return;
    if (drag) {
      if (!hydrateWait) {
        hydrateWait = true;
        const retry = () => {
          if (drag) requestAnimationFrame(retry);
          else {
            hydrateWait = false;
            hydrate();
          }
        };
        requestAnimationFrame(retry);
      }
      return;
    }
    let any = false;
    for (const c of clips) {
      const src = sourceCache.get(c.name);
      if (!src || !(src.dur > 0)) continue;
      any = true;
      c.dur = src.dur;
      c.peaks = src.peaks;
      c.s0 = Math.max(0, Math.min(src.dur, c.s0 || 0));
      if (!(c.s1 > c.s0 + 0.04) || c.s1 > src.dur + 0.05 || c.full) {
        c.s1 = src.dur;
        c.full = false;
      } else {
        c.s1 = Math.min(src.dur, c.s1);
      }
      const len = Math.max(MIN_LEN, c.s1 - c.s0);
      c.s1 = c.s0 + len;
      c.t1 = c.t0 + len;
    }
    const list = sortedClips();
    for (let i = 1; i < list.length; i++) {
      if (list[i].t0 < list[i - 1].t1 - 0.001) {
        const shift = list[i - 1].t1 - list[i].t0;
        list[i].t0 += shift;
        list[i].t1 += shift;
      }
    }
    duration = any ? 1 : 0;
    if (playhead > contentEnd()) playhead = 0;
    paint();
    onScoreBase();
  }
  function paintStatus() {
    const on = clips.length > 0 || !!String(wTrack?.value || "").trim();
    if (on) {
      status.textContent = "翻唱";
      status.style.color = "#ffe2b0";
      status.style.background = "#2a2216";
      status.style.borderColor = "#655433";
    } else {
      status.textContent = "直接生成";
      status.style.color = "#d7e6ff";
      status.style.background = "#1a2433";
      status.style.borderColor = "#345";
      duration = 0;
      stopClock();
      playName = "";
      delete audio.dataset.lazyName;
      audio.removeAttribute("src");
    }
    paint();
  }
  function bindAudio(resetTrim) {
    stopClock();
    playName = "";
    if (resetTrim) {
      clips = [];
      selectedId = 0;
      playhead = 0;
      setVal(wClips, "");
      setVal(wStart, 0);
      setVal(wEnd, 0);
      setVal(wTrack, "");
    } else {
      clips = loadClipsFromWidgets();
      if (playhead > contentEnd()) playhead = 0;
      if (selectedId && !clips.some((c) => c.id === selectedId)) selectedId = 0;
    }
    duration = 0;
    paintStatus();
    if (clips.length) hydrate();
  }
  function isAudioFile(f) {
    if (!f) return false;
    if (f.type && f.type.startsWith("audio/")) return true;
    return isAudioName(f.name || "");
  }
  async function uploadOne(f) {
    const body = new FormData();
    body.append("image", f);
    body.append("type", "input");
    body.append("subfolder", "");
    const resp = await api.fetchApi("/upload/image", { method: "POST", body });
    if (!resp.ok) throw new Error("upload " + resp.status);
    const data = await resp.json();
    return data?.name || f.name;
  }
  async function addFiles(list) {
    const files = Array.from(list || []).filter(isAudioFile);
    if (!files.length || adding) return;
    adding = true;
    try {
      let added = 0;
      for (const f of files) {
        try {
          const name = await uploadOne(f);
          const meta = await ensureSource(name);
          const dur = meta && meta.dur > 0 ? meta.dur : 0;
          if (!(dur > 0)) continue;
          const start = clips.reduce((m, c) => Math.max(m, c.t1 || 0), 0);
          const clip = {
            id: ++nextId,
            t0: start,
            t1: start + dur,
            s0: 0,
            s1: dur,
            name,
            dur,
            peaks: meta.peaks,
          };
          clips.push(clip);
          selectedId = clip.id;
          added += 1;
        } catch (err) {
          console.error("[LazyYuE] 上传失败:", err);
        }
      }
      if (!added) return;
      duration = 1;
      if (wMode && wMode.value !== "melody") {
        setVal(wMode, "melody");
        modeSel.value = "melody";
      }
      commitClips();
      app.graph?.setDirtyCanvas?.(true, true);
      requestAnimationFrame(() => {
        view.scrollLeft = 0;
      });
    } finally {
      adding = false;
    }
  }
  function assetViewUrl(ref) {
    const q = new URLSearchParams({
      filename: ref.filename || "",
      type: ref.type || "input",
      subfolder: ref.subfolder || "",
    });
    try {
      return api.apiURL(`/view?${q.toString()}`);
    } catch (_) {
      return `/view?${q.toString()}`;
    }
  }
  async function addAssetRefs(refs) {
    const files = [];
    for (const ref of refs) {
      try {
        const primary = assetViewUrl(ref);
        let resp = await fetch(primary);
        const raw = String(ref.fetchUrl || "");
        if (!resp.ok && raw && raw !== primary) {
          resp = await fetch(raw);
        }
        if (!resp.ok) {
          console.error("[LazyYuE] 资产读取失败:", resp.status);
          continue;
        }
        const blob = await resp.blob();
        if (!blob || blob.size < 32) continue;
        const mime = (blob.type || "").toLowerCase();
        if (mime.startsWith("image/") || mime.startsWith("text/") || mime.includes("json")) continue;
        let name = String(ref.filename || "audio").split("/").pop();
        if (!isAudioName(name)) {
          const t = blob.type || "";
          const ext = t.includes("wav")
            ? ".wav"
            : t.includes("flac")
              ? ".flac"
              : t.includes("ogg")
                ? ".ogg"
                : t.includes("mp4") || t.includes("aac")
                  ? ".m4a"
                  : ".mp3";
          name = (name.replace(/\.[^.]+$/, "") || "audio") + ext;
        }
        const type = blob.type && blob.type.startsWith("audio/") ? blob.type : "audio/mpeg";
        files.push(new File([blob], name, { type }));
      } catch (err) {
        console.error("[LazyYuE] 资产读取失败:", err);
      }
    }
    if (!files.length) {
      paint();
      return;
    }
    await addFiles(files);
  }
  function clearTrack() {
    clips = [];
    selectedId = 0;
    playhead = 0;
    drag = null;
    playName = "";
    duration = 0;
    stopClock();
    setVal(wTrack, "");
    setVal(wStart, 0);
    setVal(wEnd, 0);
    setVal(wClips, "");
    setVal(wMode, "full");
    modeSel.value = "full";
    paintStatus();
    onScoreBase();
  }
  function removeClip(id) {
    const next = clips.filter((c) => c.id !== id);
    if (!next.length) {
      clearTrack();
      return;
    }
    clips = next;
    if (selectedId === id) selectedId = 0;
    commitClips();
  }
  function cutAtPlayhead() {
    if (!clips.length) return;
    const t = playhead;
    const c = clips.find((item) => t > item.t0 + MIN_LEN && t < item.t1 - MIN_LEN);
    if (!c) return;
    const src = c.s0 + (t - c.t0);
    const right = {
      id: ++nextId,
      t0: t,
      t1: c.t1,
      s0: src,
      s1: c.s1,
      name: c.name,
      dur: c.dur,
      peaks: c.peaks,
    };
    c.t1 = t;
    c.s1 = src;
    clips.push(right);
    selectedId = right.id;
    commitClips();
  }
  function commitSeconds() {
    let v = parseFloat(secInput.value);
    if (!Number.isFinite(v)) v = 120;
    v = quantizeSec(v);
    secInput.value = secondsText(v);
    if (autoFit) {
      autoFit = false;
      autoCb.checked = false;
      setVal(wAuto, false);
    }
    setVal(wSec, v);
    paint();
    onScoreBase();
  }
  function hit(b, x, y) {
    return !!b && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
  }
  function canvasPos(ev) {
    const r = wave.getBoundingClientRect();
    return {
      x: ((ev.clientX - r.left) / Math.max(1, r.width)) * canvasW(),
      y: ((ev.clientY - r.top) / Math.max(1, r.height)) * (RULER + TRACK_H),
    };
  }
  function secAt(x) {
    return Math.max(0, x / Math.max(0.001, pxPerSec()));
  }
  function followTime(t) {
    const px = t * pxPerSec();
    const right = view.scrollLeft + view.clientWidth;
    if (px > right - 28) view.scrollLeft = px - view.clientWidth + 56;
    else if (px < view.scrollLeft + 16) view.scrollLeft = Math.max(0, px - 40);
  }
  function focusNode() {
    try {
      const canvas = app.canvas;
      if (canvas && typeof canvas.selectNode === "function") canvas.selectNode(node, false);
    } catch (_) {}
  }
  function boxAt(p) {
    const boxes = layout.clips || [];
    for (let i = boxes.length - 1; i >= 0; i--) {
      const b = boxes[i];
      if (p.y < b.y || p.y > b.y + b.h) continue;
      if (p.x < b.x0 - 6 || p.x > b.x1 + 6) continue;
      const toL = Math.abs(p.x - b.x0);
      const toR = Math.abs(p.x - b.x1);
      let where = "move";
      if (b.x1 - b.x0 >= 28 && toL <= 12 && toL <= toR) where = "start";
      else if (b.x1 - b.x0 >= 28 && toR <= 12) where = "end";
      return { box: b, where };
    }
    return null;
  }
  function cursorFor(p) {
    if (hit(layout.slot, p.x, p.y)) return "pointer";
    if (!clips.length) return "default";
    const boxes = layout.clips || [];
    for (let i = boxes.length - 1; i >= 0; i--) {
      if (hit(boxes[i].xBtn, p.x, p.y)) return "pointer";
    }
    const hitBox = boxAt(p);
    if (!hitBox) return p.y <= RULER ? "col-resize" : "default";
    if (hitBox.where === "move") return "grab";
    return "ew-resize";
  }
  function nodeOn() {
    if (hoverDesk) return true;
    try {
      if (node.selected) return true;
      const bag = app.canvas && app.canvas.selected_nodes;
      if (bag && (bag[node.id] || bag[String(node.id)])) return true;
      if (bag && typeof bag.has === "function" && (bag.has(node.id) || bag.has(String(node.id)))) return true;
    } catch (_) {}
    return false;
  }
  function typingTarget(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    return !!el.isContentEditable;
  }
  function onDeskKey(e) {
    if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
    if (_closeStyleDialog) return;
    if (typingTarget(e.target)) return;
    if (!nodeOn()) return;
    if (e.key === " " || e.code === "Space") {
      if (!clips.length) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
      togglePlay();
    } else if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
      removeClip(selectedId);
    }
  }

  wave.style.touchAction = "none";
  paintEye();
  eyeBtn.onclick = (e) => {
    e.stopPropagation();
    heard = !heard;
    audio.muted = !heard;
    paintEye();
  };
  playBtn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    togglePlay();
  });
  cutBtn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    cutAtPlayhead();
  });
  autoCb.addEventListener("change", () => {
    autoFit = !!autoCb.checked;
    setVal(wAuto, autoFit);
    syncAutoSeconds();
    paint();
    onScoreBase();
  });
  secInput.addEventListener("change", commitSeconds);
  secInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitSeconds();
      secInput.blur();
    }
  });
  loopBtn.onclick = (e) => {
    e.stopPropagation();
    loopOn = !loopOn;
    paintPlay();
  };
  seek.addEventListener("pointerdown", () => {
    seeking = true;
  });
  const endSeek = () => {
    seeking = false;
  };
  seek.addEventListener("pointerup", endSeek);
  seek.addEventListener("pointercancel", endSeek);
  seek.addEventListener("input", () => {
    const span = activeSpan();
    if (!span || !clips.length) return;
    playhead = (Number(seek.value) / 1000) * span;
    if (wantPlay) placeAudio();
    paint();
  });
  function wheelPx(e) {
    let d = e.deltaY || e.deltaX || 0;
    if (e.deltaMode === 1) d *= 16;
    else if (e.deltaMode === 2) d *= view.clientWidth || 400;
    return d;
  }
  function applyZoom(z, anchorSec) {
    const next = Math.max(1, Math.min(4, Math.round(Number(z) * 100) / 100));
    const oldPx = Math.max(0.001, pxPerSec());
    const left = view.scrollLeft || 0;
    const vw = view.clientWidth || 0;
    let anchor = anchorSec;
    let local = vw / 2;
    if (!(anchor >= 0)) anchor = (left + local) / oldPx;
    else local = anchor * oldPx - left;
    zoom.value = String(next);
    paint();
    const newPx = Math.max(0.001, pxPerSec());
    const full = parseFloat(wave.style.width) || 0;
    const max = Math.max(0, full - (view.clientWidth || 0));
    view.scrollLeft = Math.max(0, Math.min(max, anchor * newPx - local));
    syncPan();
  }
  function syncPan() {
    if (!pan || !panRow) return;
    const full = parseFloat(wave.style.width) || 0;
    const max = Math.max(0, full - (view.clientWidth || 0));
    if (max < 2) {
      panRow.style.display = "none";
      updateScorePlay();
      return;
    }
    panRow.style.display = "flex";
    const maxS = String(Math.round(max));
    if (pan.max !== maxS) pan.max = maxS;
    const leftS = String(Math.round(Math.max(0, Math.min(max, view.scrollLeft || 0))));
    if (document.activeElement !== pan && pan.value !== leftS) pan.value = leftS;
    updateScorePlay();
  }
  pan.addEventListener("input", () => {
    view.scrollLeft = Number(pan.value) || 0;
    syncScoreScroll(view, scoreGrid);
    updateScorePlay();
  });
  trackBox.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey && !e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.ctrlKey) {
        const grid = scoreGrid && scoreRow && scoreRow.contains(e.target) ? scoreGrid : view;
        const rect = grid.getBoundingClientRect();
        const x = e.clientX - rect.left + (grid.scrollLeft || 0);
        const anchor = Math.max(0, x / Math.max(0.001, pxPerSec()));
        const cur = parseFloat(zoom.value) || 1;
        applyZoom(cur * Math.pow(1.1, -wheelPx(e) / 100), anchor);
      } else {
        const full = parseFloat(wave.style.width) || 0;
        const max = Math.max(0, full - (view.clientWidth || 0));
        view.scrollLeft = Math.max(0, Math.min(max, (view.scrollLeft || 0) + wheelPx(e)));
        syncScoreScroll(view, scoreGrid);
        syncPan();
        updateScorePlay();
      }
    },
    { passive: false }
  );
  zoom.addEventListener("input", () => applyZoom(parseFloat(zoom.value) || 1));
  zoomOut.onclick = (e) => {
    e.stopPropagation();
    applyZoom((parseFloat(zoom.value) || 1) - 0.5);
  };
  zoomIn.onclick = (e) => {
    e.stopPropagation();
    applyZoom((parseFloat(zoom.value) || 1) + 0.5);
  };
  zoomFit.onclick = (e) => {
    e.stopPropagation();
    zoom.value = "1";
    paint();
    view.scrollLeft = 0;
    syncPan();
  };
  window.addEventListener("keydown", onDeskKey, true);
  trackBox.addEventListener("pointerenter", () => {
    hoverDesk = true;
  });
  trackBox.addEventListener("pointerleave", () => {
    hoverDesk = false;
  });
  const prevRemoved = node.onRemoved;
  node.onRemoved = function () {
    window.removeEventListener("keydown", onDeskKey, true);
    stopClock();
    if (typeof prevRemoved === "function") prevRemoved.apply(this, arguments);
  };

  wave.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    focusNode();
    const p = canvasPos(ev);
    if (hit(layout.slot, p.x, p.y)) {
      file.click();
      return;
    }
    if (!clips.length) return;
    const boxes = layout.clips || [];
    for (let i = boxes.length - 1; i >= 0; i--) {
      if (hit(boxes[i].xBtn, p.x, p.y)) {
        removeClip(boxes[i].id);
        return;
      }
    }
    const hitBox = boxAt(p);
    const t = secAt(p.x);
    if (hitBox) {
      const c = clips.find((x) => x.id === hitBox.box.id);
      if (!c) return;
      selectedId = c.id;
      stopClock();
      const spanNow = timeSpan();
      drag = {
        kind: hitBox.where,
        id: c.id,
        t0: c.t0,
        t1: c.t1,
        s0: c.s0,
        s1: c.s1,
        dur: c.dur > 0 ? c.dur : c.s1,
        x0: p.x,
        px: spanNow > 0 ? zoomBase() / spanNow : pxPerSec(),
        span: spanNow,
        origins: clips.map((item) => ({ id: item.id, t0: item.t0, t1: item.t1 })),
      };
      paint();
      wave.setPointerCapture?.(ev.pointerId);
      return;
    }
    selectedId = 0;
    drag = { kind: "play", from: t };
    scrub = true;
    playhead = Math.max(0, Math.min(activeSpan(), t));
    if (wantPlay) placeAudio();
    paint();
    wave.setPointerCapture?.(ev.pointerId);
  });
  wave.addEventListener("pointermove", (ev) => {
    const p = canvasPos(ev);
    if (!drag) {
      wave.style.cursor = cursorFor(p);
      wave.title = hit(layout.slot, p.x, p.y) ? "添加" : "";
      return;
    }
    wave.style.cursor = drag.kind === "play" ? "col-resize" : drag.kind === "move" ? "grabbing" : "ew-resize";
    if (!clips.length) return;
    if (drag.kind === "play") {
      const t = secAt(p.x);
      playhead = Math.max(0, Math.min(activeSpan(), t));
      if (wantPlay) placeAudio();
      paint();
      return;
    }
    const c = clips.find((x) => x.id === drag.id);
    if (!c) return;
    const delta = (p.x - drag.x0) / Math.max(0.001, drag.px);
    const { prev, next } = neighborsOf(c.id);
    const srcDur = drag.dur > 0 ? drag.dur : drag.s1;
    if (drag.kind === "start") {
      let newT0 = drag.t0 + delta;
      const minT = Math.max(prev ? prev.t1 : 0, drag.t0 - drag.s0);
      const maxT = drag.t1 - MIN_LEN;
      newT0 = Math.max(minT, Math.min(maxT, newT0));
      c.t0 = newT0;
      c.s0 = drag.s0 + (newT0 - drag.t0);
      c.t1 = drag.t1;
      c.s1 = drag.s1;
      drag.dirty = true;
    } else if (drag.kind === "end") {
      let newT1 = drag.t1 + delta;
      const maxT = Math.min(next ? next.t0 : 900, drag.t1 + Math.max(0, srcDur - drag.s1));
      newT1 = Math.max(drag.t0 + MIN_LEN, Math.min(maxT, newT1));
      c.t1 = newT1;
      c.s1 = drag.s1 + (newT1 - drag.t1);
      c.t0 = drag.t0;
      c.s0 = drag.s0;
      drag.dirty = true;
    } else if (drag.kind === "move") {
      const len = Math.max(MIN_LEN, drag.t1 - drag.t0);
      let newT0 = drag.t0 + delta;
      newT0 = Math.max(0, Math.min(900 - len, newT0));
      c.t0 = newT0;
      c.t1 = newT0 + len;
      c.s0 = drag.s0;
      c.s1 = drag.s1;
      drag.dirty = true;
    }
    paint();
  });
  const endDrag = () => {
    let changed = !!(drag && drag.dirty);
    if (drag && drag.kind === "move") {
      const moving = clips.find((x) => x.id === drag.id);
      const placed = moving ? placeClip(drag.origins, drag.id, moving.t0, moving.t1) : null;
      if (placed) {
        for (const p of placed) {
          const item = clips.find((x) => x.id === p.id);
          if (!item) continue;
          item.t0 = p.t0;
          item.t1 = p.t1;
        }
        changed = true;
      } else if (moving) {
        const sorted = (drag.origins || []).slice().sort((a, b) => a.t0 - b.t0 || a.id - b.id);
        const i = sorted.findIndex((o) => o.id === drag.id);
        const prev = i > 0 ? sorted[i - 1] : null;
        const next = i >= 0 && i < sorted.length - 1 ? sorted[i + 1] : null;
        const len = Math.max(MIN_LEN, drag.t1 - drag.t0);
        const minT = prev ? prev.t1 : 0;
        let hi = next ? next.t0 - len : 900 - len;
        if (hi < minT) hi = minT;
        const t0 = Math.max(minT, Math.min(hi, moving.t0));
        for (const o of drag.origins || []) {
          const item = clips.find((x) => x.id === o.id);
          if (!item || item.id === moving.id) continue;
          item.t0 = o.t0;
          item.t1 = o.t1;
        }
        moving.t0 = t0;
        moving.t1 = t0 + len;
        moving.s0 = drag.s0;
        moving.s1 = drag.s1;
        changed = Math.abs(t0 - drag.t0) > 0.001;
      } else {
        changed = false;
      }
    }
    drag = null;
    scrub = false;
    wave.style.cursor = "default";
    if (changed) commitClips();
    else paint();
  };
  wave.addEventListener("pointerup", endDrag);
  wave.addEventListener("pointercancel", endDrag);

  file.onchange = () => {
    const list = file.files ? Array.from(file.files) : [];
    file.value = "";
    addFiles(list).catch((err) => console.error("[LazyYuE] 上传失败:", err));
  };
  trackBox.addEventListener("dragenter", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  trackBox.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    if (!dragOver) {
      dragOver = true;
      paint();
    }
  });
  trackBox.addEventListener("dragleave", (e) => {
    if (e.relatedTarget && trackBox.contains(e.relatedTarget)) return;
    dragOver = false;
    paint();
  });
  trackBox.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragOver = false;
    const list = Array.from(e.dataTransfer?.files || []).filter((f) => f && f.size > 0 && isAudioFile(f));
    if (list.length) {
      addFiles(list).catch((err) => console.error("[LazyYuE] 上传失败:", err));
      return;
    }
    const refs = collectAudioDrops(e.dataTransfer);
    if (!refs.length) {
      paint();
      return;
    }
    addAssetRefs(refs).catch((err) => console.error("[LazyYuE] 资产读取失败:", err));
  });
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => {
      const next = view.clientWidth || 0;
      if (next && Math.abs(next - lastView) > 2) {
        lastView = next;
        paint();
      }
    });
    ro.observe(view);
  }
  paintEye();

  const row = document.createElement("div");
  row.style.cssText = "display:flex;flex-wrap:wrap;gap:10px;align-items:center;";
  const modeSel = document.createElement("select");
  modeSel.title = "模式";
  modeSel.style.cssText =
    "background:#222;color:#eee;border:1px solid #555;border-radius:4px;padding:3px 6px;";
  for (const [val, label] of [
    ["full", "旋律加和弦"],
    ["melody", "只留旋律"],
  ]) {
    const op = document.createElement("option");
    op.value = val;
    op.textContent = label;
    modeSel.appendChild(op);
  }
  modeSel.value = wMode?.value === "melody" ? "melody" : "full";
  modeSel.onchange = () => setVal(wMode, modeSel.value);
  function check(label, widget, title) {
    const wrap = document.createElement("label");
    wrap.title = title;
    wrap.style.cssText = "display:flex;align-items:center;gap:4px;color:#ccc;";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!widget?.value;
    cb.onchange = () => setVal(widget, cb.checked);
    wrap.appendChild(cb);
    wrap.appendChild(document.createTextNode(label));
    return { wrap, cb };
  }
  const make = check("出乐谱", wMake, "出乐谱");
  const only = check("只出乐谱", wOnly, "只出乐谱");
  const rec = check("识别歌词", wRec, "识别歌词");
  const runBtn = document.createElement("button");
  runBtn.type = "button";
  runBtn.textContent = "运行";
  runBtn.title = "运行。";
  runBtn.style.cssText = btnCss + "padding:3px 12px;";
  runBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setVal(wStyle, styleTa.value);
    setVal(wLyrics, lyrics.ta.value);
    if (scoreDrag) scoreFinish();
    const hasNotes = scoreNotes.some((n) => n && n.d > 0);
    const hasScore = hasNotes || String(activeScoreText()).trim().length > 0;
    if (!hasScore) {
      setVal(wMake, true);
      make.cb.checked = true;
      setVal(wOnly, true);
      only.cb.checked = true;
    } else {
      setVal(wOnly, false);
      only.cb.checked = false;
    }
    const queued = app.queuePrompt?.(0);
    if (queued && typeof queued.catch === "function") {
      queued.catch((err) => console.error("[LazyYuE] 运行失败:", err));
    }
  };
  row.appendChild(modeSel);
  row.appendChild(make.wrap);
  row.appendChild(only.wrap);
  row.appendChild(rec.wrap);
  row.appendChild(runBtn);

  const scoreLab = document.createElement("div");
  scoreLab.textContent = "乐谱";
  scoreLab.style.cssText =
    "position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font-weight:700;font-size:12px;line-height:1;color:#ccc;z-index:3;pointer-events:none;white-space:nowrap;";
  scoreTime = document.createElement("span");
  scoreTime.title = "时长。";
  scoreTime.style.cssText = "color:#bbb;font-variant-numeric:tabular-nums;";
  const clearScore = document.createElement("button");
  clearScore.type = "button";
  clearScore.textContent = "清空";
  clearScore.title = "清空";
  clearScore.style.cssText = btnCss;
  const scoreTools = document.createElement("div");
  scoreTools.style.cssText =
    "position:absolute;right:14px;top:20px;z-index:4;display:flex;align-items:center;gap:6px;pointer-events:auto;";
  scoreTools.appendChild(scoreTime);
  scoreTools.appendChild(clearScore);
  const scoreRow = document.createElement("div");
  scoreRow.style.cssText =
    "position:relative;display:flex;height:220px;background:#101010;user-select:none;";
  const pitchBox = document.createElement("div");
  pitchBox.style.cssText =
    "width:" + SIDE + "px;flex:0 0 " + SIDE + "px;overflow:hidden;position:relative;background:#1a1a1a;border-right:1px solid #2a2a2a;";
  pitchCanvas = document.createElement("canvas");
  pitchCanvas.style.cssText = "display:block;position:absolute;left:0;top:0;";
  pitchBox.appendChild(pitchCanvas);
  pitchBox.appendChild(scoreLab);
  scoreGrid = document.createElement("div");
  scoreGrid.title = "乐谱。";
  scoreGrid.style.cssText =
    "position:relative;flex:1;min-width:0;height:220px;overflow-x:hidden;overflow-y:auto;background:#101010;";
  scoreCanvas = document.createElement("canvas");
  scoreCanvas.draggable = false;
  scoreCanvas.style.cssText = "display:block;";
  scoreGrid.appendChild(scoreCanvas);
  scoreRow.appendChild(pitchBox);
  scoreRow.appendChild(scoreGrid);
  scoreRow.appendChild(scoreTools);

  function scoreBaseSeconds() {
    if (autoFit) {
      const end = contentEnd();
      if (end > 0.05) return end;
      const musical = ownScoreSeconds();
      if (musical > 0.05) return musical;
    }
    return setSeconds();
  }
  function scoreFmt(sec) {
    const n = Math.round((Number(sec) || 0) * 10) / 10;
    if (Math.abs(n - Math.round(n)) < 0.05) return String(Math.round(n)) + "秒";
    return n.toFixed(1) + "秒";
  }
  function scoreRange() {
    if (scoreDrag && scoreDrag.range) return scoreDrag.range;
    let lo = 48;
    let hi = 84;
    for (const n of scoreNotes) {
      if (!(n.m >= 0)) continue;
      if (n.m < lo) lo = n.m;
      if (n.m > hi) hi = n.m;
    }
    lo = Math.min(48, Math.max(36, lo - 2));
    hi = Math.max(84, Math.min(96, hi + 2));
    return { lo, hi };
  }
  function scoreKey() {
    return String(canvasW()) + ":" + String(Math.round(activeSpan() * 100));
  }
  function scoreGeom() {
    const range = scoreRange();
    const end = abcSongEnd(scoreMeta, scoreNotes, scoreBaseSeconds());
    const extra = clips.length ? 96 : 0;
    const width = Math.max(1, canvasW());
    const timeW = Math.max(1, width - extra);
    const span = Math.max(0.001, activeSpan());
    const pxPer = timeW / span;
    const sixSec = 15 / end.bpm;
    const draw = Math.max(end.total + end.bar, abcSecToTicks(span, end.bpm));
    return {
      range,
      end,
      draw,
      px: Math.max(0.25, sixSec * pxPer),
      pxPer,
      timeW,
      span,
      width,
      height: 18 + (range.hi - range.lo + 1) * 16,
      head: 18,
      row: 16,
    };
  }
  function scoreX(ticks, g) {
    return abcTicksToSec(ticks, g.end.bpm) * g.pxPer;
  }
  function scoreTicksAt(x, g) {
    const sec = Math.max(0, x / Math.max(0.001, g.pxPer));
    return Math.max(0, Math.min(g.draw, abcSecToTicks(sec, g.end.bpm)));
  }
  function updateScorePlay() {
    if (!playLine || !scoreRow || !scoreRow.isConnected) return;
    const extra = clips.length ? 96 : 0;
    const width = Math.max(1, parseFloat(wave.style.width) || canvasW());
    const timeW = Math.max(1, width - extra);
    const span = Math.max(0.001, activeSpan());
    const x = (Math.max(0, Math.min(span, playhead || 0)) / span) * timeW;
    const local = x - (view.scrollLeft || 0);
    const visible = view.clientWidth || 0;
    if (local < -1 || (visible && local > visible + 1)) {
      playLine.style.display = "none";
      return;
    }
    const deskH = desk.offsetHeight || RULER + TRACK_H;
    const scoreH = scoreRow.offsetHeight || 220;
    const scoreBottom = Math.max(scoreRow.offsetTop, deskH) + scoreH;
    playLine.style.display = "block";
    playLine.style.left = SIDE + local - 1 + "px";
    playLine.style.top = "13px";
    playLine.style.height = Math.max(0, scoreBottom - 13) + "px";
  }
  function scoreMidiAt(y, g) {
    if (y < g.head) return null;
    const row = Math.floor((y - g.head) / g.row);
    const midi = g.range.hi - row;
    if (midi < g.range.lo || midi > g.range.hi) return null;
    return midi;
  }
  function scoreEventPos(ev) {
    const r = scoreCanvas.getBoundingClientRect();
    return {
      x: ((ev.clientX - r.left) / Math.max(1, r.width)) * scoreCanvas.width,
      y: ((ev.clientY - r.top) / Math.max(1, r.height)) * scoreCanvas.height,
    };
  }
  function scoreNoteAt(ticks, midi) {
    let any = null;
    for (let i = scoreNotes.length - 1; i >= 0; i--) {
      const n = scoreNotes[i];
      if (ticks < n.s || ticks >= n.s + n.d) continue;
      if (midi != null && n.m === midi) return n;
      if (!any) any = n;
    }
    return midi == null ? any : null;
  }
  function scoreBeatOf(ticks) {
    const beat = 4 * ABC_TICK;
    return Math.floor(Math.max(0, ticks) / beat) * beat;
  }
  function scoreOverlap(s, d, except, voice) {
    const e = s + d;
    const v = voice || "";
    return scoreNotes.some((n) => n !== except && (n.v || "") === v && n.s < e && n.s + n.d > s);
  }
  function scoreIsolate(note, beat, midi) {
    const voice = note.v || "";
    const b1 = beat + 4 * ABC_TICK;
    const n0 = note.s;
    const n1 = note.s + note.d;
    const s = Math.max(n0, beat);
    const e = Math.min(n1, b1);
    if (e <= s) {
      note.m = midi;
      return note;
    }
    if (n0 >= beat && n1 <= b1) {
      note.m = midi;
      return note;
    }
    const parts = [];
    if (n0 < s) parts.push({ s: n0, d: s - n0, m: note.m, v: voice });
    const mid = { s, d: e - s, m: midi, v: voice };
    parts.push(mid);
    if (n1 > e) parts.push({ s: e, d: n1 - e, m: note.m, v: voice });
    const at = scoreNotes.indexOf(note);
    if (at >= 0) scoreNotes.splice(at, 1, ...parts);
    return mid;
  }
  function defaultVoice() {
    const names = [];
    for (const n of scoreNotes) {
      const v = n.v || "";
      if (v && names.indexOf(v) < 0) names.push(v);
    }
    if (names.indexOf("Vocal") >= 0) return "Vocal";
    return names[0] || "";
  }
  function activeScoreText() {
    if (scoreEdited) return String(wAbc?.value || "");
    const raw = String(wRaw?.value || "").trim();
    if (raw) return raw;
    return String(wAbc?.value || "");
  }
  function onScoreBase() {
    if (!scoreCanvas) return;
    paintScore();
  }
  function loadScore(text) {
    const raw = String(text || "");
    scoreDrag = null;
    if (!raw.trim()) {
      scoreNotes = [];
      scoreChords = [];
      scoreMeta = { meter: "4/4", bpm: 120, key: "C", title: "" };
    } else {
      const parsed = parseAbc(raw);
      scoreNotes = parsed.notes || [];
      scoreChords = parsed.chords || [];
      scoreMeta = {
        meter: parsed.meter || "4/4",
        bpm: parsed.bpm > 0 ? parsed.bpm : 120,
        key: parsed.key || "C",
        title: parsed.title || "",
      };
    }
    paintScore();
  }
  function commitScore() {
    scoreEdited = true;
    setVal(wEdited, true);
    scoreNotes = scoreNotes.filter((n) => n && n.d > 0);
    if (!scoreNotes.length) {
      scoreChords = [];
      setVal(wAbc, "");
      paintScore();
      return;
    }
    const end = abcSongEnd(scoreMeta, scoreNotes, scoreBaseSeconds());
    const origin = String(wRaw?.value || "").trim();
    let text = origin ? patchCoverAbc(origin, scoreNotes) : "";
    if (!text) {
      try {
        text = writeAbc(scoreMeta, scoreNotes, scoreChords, end.total);
      } catch (err) {
        console.warn("[LazyYuE] 乐谱:", err);
      }
    }
    if (text) setVal(wAbc, text);
    paintScore();
  }
  function paintScore() {
    if (!scoreCanvas || !scoreGrid || !pitchCanvas) return;
    syncAutoSeconds();
    const g = scoreGeom();
    scoreCanvas.width = g.width;
    scoreCanvas.height = g.height;
    scoreCanvas.style.width = g.width + "px";
    scoreCanvas.style.height = g.height + "px";
    pitchCanvas.width = SIDE;
    pitchCanvas.height = g.height;
    pitchCanvas.style.width = SIDE + "px";
    pitchCanvas.style.height = g.height + "px";
    const ctx = scoreCanvas.getContext("2d");
    const beat = 4 * ABC_TICK;
    const beatPx = Math.max(0.25, scoreX(beat, g));
    const barBeats = Math.max(1, Math.round(g.end.bar / beat));
    const beats = Math.max(1, Math.ceil(g.draw / beat));
    const songX = scoreX(g.end.total, g);
    ctx.fillStyle = "#101010";
    ctx.fillRect(0, 0, g.width, g.height);
    for (let midi = g.range.hi; midi >= g.range.lo; midi--) {
      const y = g.head + (g.range.hi - midi) * g.row;
      const pc = ((midi % 12) + 12) % 12;
      const black = pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10;
      ctx.fillStyle = black ? "#141414" : "#1c1c1c";
      ctx.fillRect(0, y, g.width, g.row);
    }
    if (songX < g.width) {
      ctx.fillStyle = "rgba(255,255,255,.04)";
      ctx.fillRect(songX, g.head, g.width - songX, g.height - g.head);
    }
    ctx.strokeStyle = "#2a2a2a";
    for (let midi = g.range.hi; midi >= g.range.lo; midi--) {
      const y = g.head + (g.range.hi - midi) * g.row + g.row;
      ctx.beginPath();
      ctx.moveTo(0, y - 0.5);
      ctx.lineTo(g.width, y - 0.5);
      ctx.stroke();
    }
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(0, 0, g.width, g.head);
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (beatPx < 12) {
      ctx.strokeStyle = "#242424";
      const nSec = Math.ceil(g.span);
      for (let t = 0; t <= nSec && t < 2000; t++) {
        const x = Math.round(t * g.pxPer) + 0.5;
        if (x > g.timeW) break;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, g.height);
        ctx.stroke();
        if (g.pxPer >= 28 && x + 8 < g.timeW) {
          ctx.fillStyle = "#666";
          ctx.fillText(String(t), x + 8, g.head / 2);
        }
      }
    }
    for (let i = 0; i < beats; i++) {
      const x = Math.round(scoreX(i * beat, g)) + 0.5;
      if (x > g.width) break;
      const edge = i % barBeats === 0;
      if (!edge && beatPx < 4) continue;
      ctx.strokeStyle = edge ? "#6a6a6a" : "#2c2c2c";
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, g.height);
      ctx.stroke();
      ctx.fillStyle = edge ? "#ddd" : "#777";
      if (beatPx >= 14 && x + 4 < g.timeW) ctx.fillText(String((i % barBeats) + 1), x + beatPx / 2, g.head / 2);
    }
    for (const n of scoreNotes) {
      if (n.m < g.range.lo || n.m > g.range.hi) continue;
      const x = scoreX(n.s, g) + 1;
      const w = Math.max(3, scoreX(n.d, g) - 2);
      const y = g.head + (g.range.hi - n.m) * g.row + 1;
      ctx.fillStyle = scoreDrag && scoreDrag.note === n ? "#9fd0ff" : "#3d8bfd";
      ctx.fillRect(x, y, w, g.row - 2);
    }
    const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    const pctx = pitchCanvas.getContext("2d");
    pctx.fillStyle = "#1a1a1a";
    pctx.fillRect(0, 0, SIDE, g.height);
    pctx.font = "10px sans-serif";
    pctx.textAlign = "right";
    pctx.textBaseline = "middle";
    for (let midi = g.range.hi; midi >= g.range.lo; midi--) {
      const pc = ((midi % 12) + 12) % 12;
      const oct = Math.floor(midi / 12) - 1;
      const y = g.head + (g.range.hi - midi) * g.row + g.row / 2;
      pctx.fillStyle = pc === 0 ? "#eee" : "#888";
      pctx.fillText(names[pc] + oct, SIDE - 6, y);
    }
    updateScorePlay();
    scoreLayoutKey = scoreKey();
    scoreTime.textContent = scoreFmt(abcTicksToSec(g.end.total, g.end.bpm));
    if (!scoreHome) {
      scoreHome = true;
      const focus = scoreNotes.length ? scoreNotes[Math.floor(scoreNotes.length / 2)].m : 72;
      scoreGrid.scrollTop = Math.max(0, (g.range.hi - focus) * g.row - 70);
    }
    pitchCanvas.style.transform = "translateY(" + (-scoreGrid.scrollTop) + "px)";
  }
  function scoreFinish() {
    const dirty = !!(scoreDrag && scoreDrag.dirty);
    scoreDrag = null;
    if (dirty) commitScore();
    else paintScore();
  }
  clearScore.onclick = (e) => {
    e.stopPropagation();
    scoreNotes = [];
    scoreChords = [];
    scoreMeta = { meter: "4/4", bpm: 120, key: "C", title: "" };
    scoreDrag = null;
    scoreEdited = false;
    setVal(wEdited, false);
    setVal(wRaw, "");
    setVal(wAbc, "");
    paintScore();
  };
  let scoreScrollLock = false;
  function syncScoreScroll(from, to) {
    if (!from || !to || scoreScrollLock) return;
    if (to.scrollLeft === from.scrollLeft) return;
    scoreScrollLock = true;
    to.scrollLeft = from.scrollLeft;
    scoreScrollLock = false;
  }
  view.addEventListener("scroll", () => {
    syncScoreScroll(view, scoreGrid);
    updateScorePlay();
    syncPan();
  });
  scoreGrid.addEventListener("scroll", () => {
    syncScoreScroll(scoreGrid, view);
    if (pitchCanvas) pitchCanvas.style.transform = "translateY(" + (-scoreGrid.scrollTop) + "px)";
    updateScorePlay();
  });
  scoreCanvas.addEventListener("pointerdown", (ev) => {
    if (ev.button === 2) return;
    ev.preventDefault();
    ev.stopPropagation();
    const g = scoreGeom();
    const pos = scoreEventPos(ev);
    if (pos.y < g.head) return;
    const ticks = scoreTicksAt(pos.x, g);
    const midi = scoreMidiAt(pos.y, g);
    if (midi == null) return;
    const at = Math.min(ticks, g.draw - 1);
    const hit = scoreNoteAt(at, midi);
    if (hit && midi === hit.m) {
      const x1 = scoreX(hit.s + hit.d, g);
      const wide = scoreX(hit.d, g) >= 16;
      if (wide && pos.x >= x1 - 8) scoreDrag = { kind: "len", note: hit, dirty: false, range: g.range };
      else scoreDrag = { kind: "pitch", note: hit, beat: scoreBeatOf(ticks), dirty: false, range: g.range };
    } else if (scoreNoteAt(at, null)) {
      return;
    } else {
      const b = scoreBeatOf(ticks);
      const d = 4 * ABC_TICK;
      const voice = defaultVoice();
      if (scoreOverlap(b, d, null, voice)) return;
      const note = { s: b, d, m: midi, v: voice };
      scoreNotes.push(note);
      scoreDrag = { kind: "new", note, dirty: true, range: g.range };
    }
    try {
      scoreCanvas.setPointerCapture(ev.pointerId);
    } catch (_) {}
    paintScore();
  });
  scoreCanvas.addEventListener("pointermove", (ev) => {
    const g = scoreGeom();
    const pos = scoreEventPos(ev);
    if (!scoreDrag) {
      const midi = scoreMidiAt(pos.y, g);
      const hit = midi == null ? null : scoreNoteAt(scoreTicksAt(pos.x, g), midi);
      let cursor = "crosshair";
      if (hit && midi === hit.m) {
        const x1 = scoreX(hit.s + hit.d, g);
        cursor = scoreX(hit.d, g) >= 16 && pos.x >= x1 - 8 ? "ew-resize" : "ns-resize";
      }
      scoreCanvas.style.cursor = cursor;
      return;
    }
    const note = scoreDrag.note;
    if (!note) return;
    if (scoreDrag.kind === "pitch") {
      const midi = scoreMidiAt(pos.y, g);
      if (midi != null && midi !== note.m) {
        if (scoreDrag.beat != null) {
          scoreDrag.note = scoreIsolate(note, scoreDrag.beat, midi);
          scoreDrag.beat = null;
        } else scoreDrag.note.m = midi;
        scoreDrag.dirty = true;
      }
    } else {
      let endTick = scoreTicksAt(pos.x, g);
      if (pos.x >= g.width - 12) endTick = note.s + note.d + 4 * ABC_TICK;
      const voice = note.v || "";
      const next = scoreNotes.filter((n) => n !== note && (n.v || "") === voice && n.s > note.s).sort((a, b) => a.s - b.s)[0];
      let minEnd = note.s + ABC_TICK;
      if (next && next.s - note.s < ABC_TICK) minEnd = next.s;
      endTick = Math.max(minEnd, endTick);
      if (next) endTick = Math.min(endTick, next.s);
      const dur = Math.max(next && next.s <= note.s + ABC_TICK ? next.s - note.s : ABC_TICK, endTick - note.s);
      if (dur > 0 && dur !== note.d) {
        note.d = dur;
        scoreDrag.dirty = true;
        if (scoreDrag.kind === "new") {
          const midi = scoreMidiAt(pos.y, g);
          if (midi != null && midi !== note.m) note.m = midi;
        }
        const x = scoreX(note.s + note.d, g);
        if (x > scoreGrid.scrollLeft + scoreGrid.clientWidth - 24) {
          scoreGrid.scrollLeft = Math.max(0, x - scoreGrid.clientWidth + 48);
        }
      } else if (scoreDrag.kind === "new") {
        const midi = scoreMidiAt(pos.y, g);
        if (midi != null && midi !== note.m) {
          note.m = midi;
          scoreDrag.dirty = true;
        }
      }
    }
    paintScore();
  });
  scoreCanvas.addEventListener("pointerup", scoreFinish);
  scoreCanvas.addEventListener("pointercancel", scoreFinish);
  scoreCanvas.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const g = scoreGeom();
    const pos = scoreEventPos(ev);
    const midi = scoreMidiAt(pos.y, g);
    const hit = midi == null ? null : scoreNoteAt(scoreTicksAt(pos.x, g), midi);
    if (!hit || hit.m !== midi) return;
    const b = scoreBeatOf(scoreTicksAt(pos.x, g));
    const b1 = b + 4 * ABC_TICK;
    const s = Math.max(hit.s, b);
    const e = Math.min(hit.s + hit.d, b1);
    const parts = [];
    if (hit.s < s) parts.push({ s: hit.s, d: s - hit.s, m: hit.m, v: hit.v || "" });
    if (hit.s + hit.d > e) parts.push({ s: e, d: hit.s + hit.d - e, m: hit.m, v: hit.v || "" });
    const at = scoreNotes.indexOf(hit);
    if (at >= 0) scoreNotes.splice(at, 1, ...parts);
    commitScore();
  });
  loadScore(activeScoreText());

  trackBox.insertBefore(scoreRow, info);
  root.appendChild(status);
  root.appendChild(styleBox);
  root.appendChild(lyrics.box);
  root.appendChild(trackBox);
  root.appendChild(row);

  const dom = node.addDOMWidget("lazy_yue_wb", "div", root, { serialize: false });
  fitBench = () => {
    const extra = Math.max(0, lyricsH - LYRICS_H0);
    const body = 1292 + extra;
    if (dom) dom.computeSize = (width) => [width || 460, body];
    try {
      const w = Math.max(node.size?.[0] || 460, 460);
      node.setSize([w, 1372 + extra]);
    } catch (_) {}
    app.graph?.setDirtyCanvas?.(true, true);
  };
  fitBench();

  node._lazyYueWB = {
    refresh() {
      styleTa.value = String(wStyle?.value || "");
      langField.refresh();
      genreField.refresh();
      vocalField.refresh();
      timbreField.refresh();
      gearField.refresh();
      moodField.refresh();
      bpmInput.value = String(parseInt(wBpm?.value, 10) || 0);
      lyrics.ta.value = String(wLyrics?.value || "");
      scoreEdited = !!wEdited?.value;
      loadScore(activeScoreText());
      modeSel.value = wMode?.value === "melody" ? "melody" : "full";
      make.cb.checked = !!wMake?.value;
      only.cb.checked = !!wOnly?.value;
      rec.cb.checked = !!wRec?.value;
      autoFit = wAuto ? !!wAuto.value : true;
      autoCb.checked = autoFit;
      secInput.value = secondsText(num(wSec, 120) || 120);
      syncAutoSeconds();
      bindAudio(false);
      reloadStyles();
      onScoreBase();
    },
    applyAbc(text) {
      scoreEdited = false;
      setVal(wEdited, false);
      setVal(wRaw, text);
      setVal(wAbc, text);
      loadScore(text);
      app.graph?.setDirtyCanvas?.(true, true);
    },
    applyLyrics(text) {
      const t = String(text || "");
      lyrics.ta.value = t;
      setVal(wLyrics, t);
      app.graph?.setDirtyCanvas?.(true, true);
    },
  };
  if (wStyle) wStyle.serializeValue = () => String(styleTa.value || "");
  if (wLyrics) wLyrics.serializeValue = () => String(lyrics.ta.value || "");
  if (wLang) wLang.serializeValue = () => langField.value();
  if (wVocal) wVocal.serializeValue = () => vocalField.value();
  if (wTimbre) wTimbre.serializeValue = () => timbreField.value();
  if (wGenre) wGenre.serializeValue = () => genreField.value();
  if (wGear) wGear.serializeValue = () => gearField.value();
  if (wMood) wMood.serializeValue = () => moodField.value();
  if (wBpm) wBpm.serializeValue = () => parseInt(bpmInput.value, 10) || 0;
  bindAudio(false);
  reloadStyles();
}
