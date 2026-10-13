/**
 * Lazy 合并生成：快速尺寸（不进 widgets_values）+ 随机种子回写
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

function setupSizePreset(node) {
  if (node._lazyMergeSizePreset) return;
  const wW = findW(node, ["宽度", "width"]);
  const wH = findW(node, ["高度", "height"]);
  if (!wW || !wH) return;

  if (node.widgets?.length) {
    for (let i = node.widgets.length - 1; i >= 0; i--) {
      const w = node.widgets[i];
      if (!w) continue;
      if (w._lazyMergeSizeUi || (w.name === "快速尺寸" && w.serialize === false)) {
        node.widgets.splice(i, 1);
      }
    }
  }

  const cb = (v) => {
    const pair = SIZE_PRESETS[String(v)];
    if (!pair) return;
    node._lazyMergeSizeLock = true;
    try {
      setWidget(node, ["宽度", "width"], pair[0], true);
      setWidget(node, ["高度", "height"], pair[1], true);
    } finally {
      node._lazyMergeSizeLock = false;
    }
    node.setDirtyCanvas?.(true, true);
  };
  const wSize = node.addWidget("combo", "快速尺寸", "自定义", cb, { values: SIZE_OPTS });
  wSize._lazyMergeSizeUi = true;
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
    if (!w || w._lazyMergeSizeWrapped) return;
    const prev = w.callback;
    w.callback = function () {
      try {
        prev?.apply(this, arguments);
      } catch (_) {}
      if (node._lazyMergeSizeLock) return;
      if (wSize && String(wSize.value) !== "自定义") {
        wSize.value = "自定义";
      }
    };
    w._lazyMergeSizeWrapped = true;
  };
  wrapManual(wW);
  wrapManual(wH);

  node._lazyMergeSizePreset = true;
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
  name: "Lazy.Merge.Generate",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "LazyMergeGenerate") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      requestAnimationFrame(() => {
        try {
          setupSizePreset(this);
        } catch (e) {
          console.warn("[Lazy合并] 快速尺寸:", e);
        }
      });
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      this._lazyMergeSizePreset = false;
      requestAnimationFrame(() => {
        try {
          setupSizePreset(this);
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
        console.warn("[Lazy合并] 更新种子失败:", e);
      }
      return r;
    };
  },
});
