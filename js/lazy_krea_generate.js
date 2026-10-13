/**
 * Lazy Krea2 生成：纠错控件错位；快速尺寸（前端控件，不进 widgets_values，避免错位）
 */
import { app } from "../../scripts/app.js";

const SIZE_PRESETS = {
  "16比9（720p）": [1280, 720],
  "16比9（1K）": [1920, 1080],
  "16比9（2K）": [2560, 1440],
  "9比16（720p）": [720, 1280],
  "9比16（1K）": [1080, 1920],
  "9比16（2K）": [1440, 2560],
};
const SIZE_OPTS = ["自定义", ...Object.keys(SIZE_PRESETS)];
const DUAL_OPTS = ["图1场景+图2人物", "图1人物+图2场景"];

function findW(node, names) {
  const list = Array.isArray(names) ? names : [names];
  return node.widgets?.find((w) => list.includes(w.name));
}

function setWidget(node, names, value, skipCb = false) {
  const w = findW(node, names);
  if (!w) return false;
  if (Array.isArray(w.options?.values) && w.options.values.length) {
    const ok = w.options.values.some((x) => String(x) === String(value));
    if (!ok && value !== w.value) return false;
  }
  const old = w.value;
  w.value = value;
  if (!skipCb) {
    try {
      if (typeof w.callback === "function") w.callback(value);
    } catch (_) {}
  }
  try {
    node.onWidgetChanged?.(w.name, value, old, w);
  } catch (_) {}
  node.setDirtyCanvas?.(true, true);
  return true;
}

function isLoraLike(v) {
  const s = String(v ?? "");
  if (!s || s === "none" || s === "None") return true;
  if (s.includes("图1") || s.includes("场景") || s.includes("人物")) return false;
  if (SIZE_OPTS.includes(s)) return false;
  if (s === "true" || s === "false") return false;
  if (s === "自定义") return false;
  if (!Number.isNaN(Number(s)) && String(Number(s)) === s) return false;
  return true;
}

function defaultEditLora(vals) {
  return (
    vals.find((x) => /identity_edit/i.test(String(x))) ||
    vals.find((x) => String(x) === "none") ||
    "none"
  );
}

function defaultQuadLora(vals) {
  return (
    vals.find((x) => /四视图|quadview|quad_view|quad-view/i.test(String(x))) ||
    vals.find((x) => String(x) === "none") ||
    "none"
  );
}

/**
 * 按控件名强制纠错。顺带清掉误入序列化的「快速尺寸」槽（旧版 Python 控件残留）。
 */
function sanitizeKreaGenerate(node) {
  // 旧版曾把「快速尺寸」写进 INPUT_TYPES，会挤占 widgets_values → 删掉该序列化控件
  if (node.widgets?.length) {
    for (let i = node.widgets.length - 1; i >= 0; i--) {
      const w = node.widgets[i];
      if (!w) continue;
      if (w.name === "快速尺寸" && w._lazyKreaSizeUi !== true) {
        node.widgets.splice(i, 1);
      }
    }
  }

  const wW = findW(node, ["宽度", "width"]);
  if (wW != null) {
    const n = Number(wW.value);
    if (Number.isNaN(n) || n < 64 || n > 4096 || typeof wW.value === "boolean") {
      setWidget(node, ["宽度", "width"], 1024, true);
    }
  }
  const wH = findW(node, ["高度", "height"]);
  if (wH != null) {
    const n = Number(wH.value);
    if (
      Number.isNaN(n) ||
      n < 64 ||
      n > 4096 ||
      typeof wH.value === "boolean" ||
      wH.value === true ||
      wH.value === false
    ) {
      setWidget(node, ["高度", "height"], 1024, true);
    }
  }

  const wSteps = findW(node, ["步数", "steps"]);
  if (wSteps != null) {
    const n = Number(wSteps.value);
    if (Number.isNaN(n) || n < 1 || n > 50 || typeof wSteps.value === "boolean") {
      setWidget(node, ["步数", "steps"], 8, true);
    }
  }

  const wCfg = findW(node, ["CFG", "cfg"]);
  if (wCfg != null) {
    const n = Number(wCfg.value);
    if (Number.isNaN(n) || n < 0 || n > 20 || typeof wCfg.value === "boolean") {
      setWidget(node, ["CFG", "cfg"], 1.0, true);
    }
  }

  const wEdit = findW(node, ["编辑LoRA", "edit_lora"]);
  if (wEdit != null && !isLoraLike(wEdit.value)) {
    const vals = wEdit.options?.values || [];
    setWidget(node, ["编辑LoRA", "edit_lora"], defaultEditLora(vals), true);
  }

  const wQuad = findW(node, ["四视图LoRA", "quad_lora"]);
  if (wQuad != null && !isLoraLike(wQuad.value)) {
    const vals = wQuad.options?.values || [];
    setWidget(node, ["四视图LoRA", "quad_lora"], defaultQuadLora(vals), true);
  }

  for (const names of [
    ["编辑LoRA强度", "edit_lora_strength"],
    ["四视图LoRA强度", "quad_lora_strength"],
  ]) {
    const w = findW(node, names);
    if (w == null) continue;
    const n = Number(w.value);
    if (
      Number.isNaN(n) ||
      Math.abs(n) > 99 ||
      typeof w.value === "boolean" ||
      typeof w.value === "string"
    ) {
      setWidget(node, names, 1.0, true);
    }
  }

  // —— 仅修「明显错位垃圾」；合法手改数值一律保留（分享默认靠 Python default）——
  const wMp = findW(node, ["百万像素", "megapixels"]);
  const wGp = findW(node, ["接地像素", "grounding_px"]);
  const wRb = findW(node, ["参考强度", "ref_boost"]);
  const wRa = findW(node, ["场景强度", "ref_boost_a"]);
  const widthN = wW != null ? Number(wW.value) : NaN;
  const heightN = wH != null ? Number(wH.value) : NaN;

  if (wMp != null) {
    const n = Number(wMp.value);
    const garbage =
      typeof wMp.value === "boolean" ||
      typeof wMp.value === "string" ||
      Number.isNaN(n) ||
      n < 0.1 ||
      n > 4 ||
      (Number.isInteger(n) && n >= 64) || // 768/1024 等像素串入
      n === widthN ||
      n === heightN;
    if (garbage) setWidget(node, ["百万像素", "megapixels"], 1.0, true);
  }

  if (wGp != null) {
    const n = Number(wGp.value);
    const garbage =
      typeof wGp.value === "boolean" ||
      typeof wGp.value === "string" ||
      Number.isNaN(n) ||
      n < 0 ||
      n > 4096 ||
      (n > 0 && n < 64) || // 1/4 等强度串入；0=原生允许
      n === widthN ||
      n === heightN;
    if (garbage) setWidget(node, ["接地像素", "grounding_px"], 768, true);
  }

  if (wRb != null) {
    const n = Number(wRb.value);
    const garbage =
      typeof wRb.value === "boolean" ||
      typeof wRb.value === "string" ||
      Number.isNaN(n) ||
      n < 0 ||
      n > 100 ||
      n >= 256; // 像素串入
    if (garbage) setWidget(node, ["参考强度", "ref_boost"], 4.0, true);
  }

  if (wRa != null) {
    const n = Number(wRa.value);
    const garbage =
      typeof wRa.value === "boolean" ||
      typeof wRa.value === "string" ||
      Number.isNaN(n) ||
      n < 0 ||
      n > 100 ||
      n >= 256;
    if (garbage) setWidget(node, ["场景强度", "ref_boost_a"], 1.0, true);
  }

  const wDual = findW(node, ["双图顺序", "dual_order"]);
  if (wDual != null && !DUAL_OPTS.includes(String(wDual.value))) {
    // 若 LoRA 路径串进来，拉回默认
    setWidget(node, ["双图顺序", "dual_order"], DUAL_OPTS[0], true);
  }

  const wSp = findW(node, ["随机种子", "每段递增种子", "seed_per", "random_seed"]);
  if (wSp != null) {
    if (wSp.name === "每段递增种子" || wSp.name === "seed_per") {
      try {
        wSp.name = "随机种子";
        if (wSp.label != null) wSp.label = "随机种子";
      } catch (_) {}
    }
    if (typeof wSp.value !== "boolean") {
      const s = String(wSp.value).toLowerCase();
      // 若串进 LoRA/尺寸名，默认开
      const on = s === "true" || s === "1" || s === "yes";
      const off = s === "false" || s === "0" || s === "no";
      setWidget(node, ["随机种子", "每段递增种子", "seed_per"], on ? true : off ? false : true, true);
    }
  }

  const wSeed = findW(node, ["种子", "seed"]);
  if (wSeed != null) {
    const n = Number(wSeed.value);
    if (Number.isNaN(n) || n < 0 || typeof wSeed.value === "boolean") {
      setWidget(node, ["种子", "seed"], 0, true);
    }
  }
}

/**
 * 前端追加「快速尺寸」（不序列化）。
 * 必须放在 widgets 末尾，禁止插到高度后面：
 * 生图后 Comfy 常按索引回写，中间插入会导致编辑LoRA 等被挤成 none。
 */
function setupSizePreset(node) {
  if (node._lazyKreaSizePreset) return;
  const wW = findW(node, ["宽度", "width"]);
  const wH = findW(node, ["高度", "height"]);
  if (!wW || !wH) return;

  // 清掉旧版插在中间的快速尺寸，避免继续搅乱索引
  if (node.widgets?.length) {
    for (let i = node.widgets.length - 1; i >= 0; i--) {
      const w = node.widgets[i];
      if (!w) continue;
      if (w._lazyKreaSizeUi || (w.name === "快速尺寸" && w.serialize === false)) {
        node.widgets.splice(i, 1);
      }
    }
  }

  const cb = (v) => {
    const pair = SIZE_PRESETS[String(v)];
    if (!pair) return;
    node._lazyKreaSizeLock = true;
    try {
      setWidget(node, ["宽度", "width"], pair[0], true);
      setWidget(node, ["高度", "height"], pair[1], true);
    } finally {
      node._lazyKreaSizeLock = false;
    }
    node.setDirtyCanvas?.(true, true);
  };
  const wSize = node.addWidget("combo", "快速尺寸", "自定义", cb, { values: SIZE_OPTS });
  wSize._lazyKreaSizeUi = true;
  wSize.serialize = false;
  try {
    wSize.options = wSize.options || {};
    wSize.options.serialize = false;
  } catch (_) {}
  wSize.tooltip = "快捷填入宽高，可再手动改。";

  // 确保在末尾（addWidget 一般已在末尾；若被别处挪过再拨回去）
  const widgets = node.widgets;
  if (widgets?.length) {
    const from = widgets.indexOf(wSize);
    if (from >= 0 && from !== widgets.length - 1) {
      widgets.splice(from, 1);
      widgets.push(wSize);
    }
  }

  const wrapManual = (w) => {
    if (!w || w._lazyKreaSizeWrapped) return;
    const prev = w.callback;
    w.callback = function (v) {
      try {
        prev?.apply(this, arguments);
      } catch (_) {}
      if (node._lazyKreaSizeLock) return;
      if (wSize && String(wSize.value) !== "自定义") {
        wSize.value = "自定义";
      }
    };
    w._lazyKreaSizeWrapped = true;
  };
  wrapManual(wW);
  wrapManual(wH);

  node._lazyKreaSizePreset = true;
  // 只在控件变高时增高节点；不压回用户手动拉过的尺寸
  try {
    const curW = node.size?.[0] || 0;
    const curH = node.size?.[1] || 0;
    const needH = node.computeSize?.(curW)?.[1] || curH;
    if (needH > curH) {
      node.setSize?.([curW || node.size[0], needH]);
    }
  } catch (_) {}
  node.setDirtyCanvas?.(true, true);
}

/**
 * 旧工作流：若 widgets_values 比当前可序列化控件多 1，且多在「高度」后
 * （旧版 Python「快速尺寸」），删掉该值再写回，避免整链错位。
 */
function migrateRemoveSerializedSize(node, info) {
  if (!info || !Array.isArray(info.widgets_values)) return;
  const wv = info.widgets_values;
  const serialWidgets = (node.widgets || []).filter(
    (w) => w && w.serialize !== false && w.type !== "hidden" && !w._lazyKreaSizeUi
  );
  // 多出来且落在高度后的值是尺寸选项 → 去掉
  if (wv.length === serialWidgets.length + 1) {
    const hIdx = serialWidgets.findIndex((w) => w.name === "高度" || w.name === "height");
    const maybe = hIdx >= 0 ? wv[hIdx + 1] : null;
    if (SIZE_OPTS.includes(String(maybe)) || String(maybe) === "自定义") {
      wv.splice(hIdx + 1, 1);
      return;
    }
    // 多在末尾（曾加在 optional 末尾）
    const last = wv[wv.length - 1];
    if (SIZE_OPTS.includes(String(last)) || String(last) === "自定义") {
      wv.pop();
    }
  }
}

app.registerExtension({
  name: "Lazy.Krea.Generate.Sanitize",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "LazyKreaGenerate") return;

    const origComputeSize = nodeType.prototype.computeSize;
    nodeType.prototype.computeSize = function (width) {
      const size = origComputeSize
        ? origComputeSize.apply(this, arguments)
        : [this.size?.[0] || width || 300, this.size?.[1] || 200];
      const userH = Number(this.properties?.lazy_krea_node_h || this._lazyKreaUserH || 0);
      if (userH > size[1]) size[1] = userH;
      return size;
    };

    const origOnResize = nodeType.prototype.onResize;
    nodeType.prototype.onResize = function (size) {
      const r = origOnResize ? origOnResize.apply(this, arguments) : undefined;
      try {
        const h = Math.round(Number(size?.[1] || this.size?.[1] || 0));
        if (h > 0) {
          this._lazyKreaUserH = h;
          this.properties = this.properties || {};
          this.properties.lazy_krea_node_h = h;
        }
      } catch (_) {}
      return r;
    };

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      requestAnimationFrame(() => {
        try {
          sanitizeKreaGenerate(this);
          setupSizePreset(this);
        } catch (e) {
          console.warn("[LazyKrea] sanitize generate:", e);
        }
      });
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      try {
        migrateRemoveSerializedSize(this, info);
      } catch (_) {}
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      try {
        const savedH = Number(this.properties?.lazy_krea_node_h || 0);
        if (savedH > 0) this._lazyKreaUserH = savedH;
      } catch (_) {}
      this._lazyKreaSizePreset = false;
      requestAnimationFrame(() => {
        try {
          sanitizeKreaGenerate(this);
          setupSizePreset(this);
          // 恢复用户高度（setup 只增高不压矮，这里显式还原）
          const h = Number(this._lazyKreaUserH || this.properties?.lazy_krea_node_h || 0);
          if (h > 0 && this.size && this.size[1] !== h) {
            this.setSize?.([this.size[0], h]);
          }
        } catch (_) {}
      });
      return r;
    };

    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      const r = onExecuted ? onExecuted.apply(this, arguments) : undefined;
      try {
        // 生图后只改种子，绝不动编辑LoRA等其它控件
        const wRand = findW(this, ["随机种子", "每段递增种子", "seed_per", "random_seed"]);
        if (!wRand || !wRand.value) return r;
        let next = message?.next_seed?.[0];
        if (next == null || Number.isNaN(Number(next))) {
          next = Math.floor(Math.random() * 0x100000000);
        }
        const wSeed = findW(this, ["种子", "seed"]);
        if (wSeed) {
          wSeed.value = Number(next);
          this.setDirtyCanvas?.(true, true);
        }
      } catch (e) {
        console.warn("[LazyKrea] 更新随机种子失败:", e);
      }
      return r;
    };
  },
});
