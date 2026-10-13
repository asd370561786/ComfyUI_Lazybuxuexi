/**
 * Lazy Qwen2.1 生成：快速尺寸（前端控件，不进 widgets_values）+ 随机种子回写
 */
import { app } from "../../scripts/app.js";

const SIZE_PRESETS = {
  "1比1（1K）": [1024, 1024],
  "1比1（2K）": [2048, 2048],
  "16比9（720p）": [1280, 720],
  "16比9（1K）": [1920, 1080],
  "16比9（2K）": [2752, 1536],
  "9比16（720p）": [720, 1280],
  "9比16（1K）": [1080, 1920],
  "9比16（2K）": [1536, 2752],
  "4比3（2K）": [2400, 1792],
  "3比4（2K）": [1792, 2400],
  "3比2（2K）": [2528, 1696],
  "2比3（2K）": [1696, 2528],
};
const SIZE_OPTS = ["自定义", ...Object.keys(SIZE_PRESETS)];

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

function sanitizeQwenGenerate(node) {
  if (node.widgets?.length) {
    for (let i = node.widgets.length - 1; i >= 0; i--) {
      const w = node.widgets[i];
      if (!w) continue;
      if (w.name === "快速尺寸" && w._lazyQwenSizeUi !== true) {
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
    if (Number.isNaN(n) || n < 64 || n > 4096 || typeof wH.value === "boolean") {
      setWidget(node, ["高度", "height"], 1024, true);
    }
  }

  const wSteps = findW(node, ["步数", "steps"]);
  if (wSteps != null) {
    const n = Number(wSteps.value);
    if (Number.isNaN(n) || n < 1 || n > 150 || typeof wSteps.value === "boolean") {
      setWidget(node, ["步数", "steps"], 25, true);
    }
  }

  const wCfg = findW(node, ["CFG", "cfg"]);
  if (wCfg != null) {
    const n = Number(wCfg.value);
    if (Number.isNaN(n) || n < 0 || n > 20 || typeof wCfg.value === "boolean") {
      setWidget(node, ["CFG", "cfg"], 1.0, true);
    }
  }

  const wRes = findW(node, ["参考分辨率", "resolution"]);
  if (wRes != null) {
    const n = Number(wRes.value);
    if (Number.isNaN(n) || n < 0 || n > 4096 || typeof wRes.value === "boolean") {
      setWidget(node, ["参考分辨率", "resolution"], 2048, true);
    }
  }

  const wSeed = findW(node, ["种子", "seed"]);
  if (wSeed != null) {
    const n = Number(wSeed.value);
    if (Number.isNaN(n) || n < 0 || typeof wSeed.value === "boolean") {
      setWidget(node, ["种子", "seed"], 0, true);
    }
  }

  const wSp = findW(node, ["随机种子", "random_seed"]);
  if (wSp != null && typeof wSp.value !== "boolean") {
    const s = String(wSp.value).toLowerCase();
    const on = s === "true" || s === "1" || s === "yes";
    const off = s === "false" || s === "0" || s === "no";
    setWidget(node, ["随机种子", "random_seed"], on ? true : off ? false : true, true);
  }
}

function setupSizePreset(node) {
  if (node._lazyQwenSizePreset) return;
  const wW = findW(node, ["宽度", "width"]);
  const wH = findW(node, ["高度", "height"]);
  if (!wW || !wH) return;

  if (node.widgets?.length) {
    for (let i = node.widgets.length - 1; i >= 0; i--) {
      const w = node.widgets[i];
      if (!w) continue;
      if (w._lazyQwenSizeUi || (w.name === "快速尺寸" && w.serialize === false)) {
        node.widgets.splice(i, 1);
      }
    }
  }

  const cb = (v) => {
    const pair = SIZE_PRESETS[String(v)];
    if (!pair) return;
    node._lazyQwenSizeLock = true;
    try {
      setWidget(node, ["宽度", "width"], pair[0], true);
      setWidget(node, ["高度", "height"], pair[1], true);
    } finally {
      node._lazyQwenSizeLock = false;
    }
    node.setDirtyCanvas?.(true, true);
  };
  const wSize = node.addWidget("combo", "快速尺寸", "自定义", cb, { values: SIZE_OPTS });
  wSize._lazyQwenSizeUi = true;
  wSize.serialize = false;
  try {
    wSize.options = wSize.options || {};
    wSize.options.serialize = false;
  } catch (_) {}
  wSize.tooltip = "快捷填入宽高。";

  const widgets = node.widgets;
  if (widgets?.length) {
    const from = widgets.indexOf(wSize);
    if (from >= 0 && from !== widgets.length - 1) {
      widgets.splice(from, 1);
      widgets.push(wSize);
    }
  }

  const wrapManual = (w) => {
    if (!w || w._lazyQwenSizeWrapped) return;
    const prev = w.callback;
    w.callback = function (v) {
      try {
        prev?.apply(this, arguments);
      } catch (_) {}
      if (node._lazyQwenSizeLock) return;
      if (wSize && String(wSize.value) !== "自定义") {
        wSize.value = "自定义";
      }
    };
    w._lazyQwenSizeWrapped = true;
  };
  wrapManual(wW);
  wrapManual(wH);

  node._lazyQwenSizePreset = true;
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

app.registerExtension({
  name: "Lazy.Qwen.Generate.Sanitize",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "LazyQwenGenerate") return;

    const origComputeSize = nodeType.prototype.computeSize;
    nodeType.prototype.computeSize = function (width) {
      const size = origComputeSize
        ? origComputeSize.apply(this, arguments)
        : [this.size?.[0] || width || 300, this.size?.[1] || 200];
      const userH = Number(this.properties?.lazy_qwen_node_h || this._lazyQwenUserH || 0);
      if (userH > size[1]) size[1] = userH;
      return size;
    };

    const origOnResize = nodeType.prototype.onResize;
    nodeType.prototype.onResize = function (size) {
      const r = origOnResize ? origOnResize.apply(this, arguments) : undefined;
      try {
        const h = Math.round(Number(size?.[1] || this.size?.[1] || 0));
        if (h > 0) {
          this._lazyQwenUserH = h;
          this.properties = this.properties || {};
          this.properties.lazy_qwen_node_h = h;
        }
      } catch (_) {}
      return r;
    };

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      requestAnimationFrame(() => {
        try {
          sanitizeQwenGenerate(this);
          setupSizePreset(this);
        } catch (e) {
          console.warn("[LazyQwen] sanitize generate:", e);
        }
      });
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      try {
        const savedH = Number(this.properties?.lazy_qwen_node_h || 0);
        if (savedH > 0) this._lazyQwenUserH = savedH;
      } catch (_) {}
      this._lazyQwenSizePreset = false;
      requestAnimationFrame(() => {
        try {
          sanitizeQwenGenerate(this);
          setupSizePreset(this);
          const h = Number(this._lazyQwenUserH || this.properties?.lazy_qwen_node_h || 0);
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
        const wRand = findW(this, ["随机种子", "random_seed"]);
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
        console.warn("[LazyQwen] 更新随机种子失败:", e);
      }
      return r;
    };
  },
});
