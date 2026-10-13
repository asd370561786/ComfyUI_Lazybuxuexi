/**
 * Lazy H3 多 LoRA：底部唯一一组「添加 / 删除」。
 * 画布平移重绘时强制去重并贴底，防止顶部幽灵按钮条。
 */
import { app } from "../../scripts/app.js";

const NODE_NAME = "LazyH3LoraStack";
const MAX_SLOTS = 16;
const BTN_WIDGET = "lazy_lora_btns";

function findW(node, name) {
  return node.widgets?.find((w) => w && w.name === name);
}

function allBtnWidgets(node) {
  return (node.widgets || []).filter((w) => w && w.name === BTN_WIDGET);
}

function hideWidgetEl(w) {
  if (!w) return;
  try {
    if (w.element) {
      w.element.style.display = "none";
      w.element.hidden = true;
      w.element.style.height = "0";
      w.element.style.overflow = "hidden";
      w.element.style.margin = "0";
      w.element.style.padding = "0";
    }
  } catch (_) {}
  try {
    if (w.options?.element) {
      w.options.element.style.display = "none";
    }
  } catch (_) {}
}

function showWidgetEl(w) {
  if (!w) return;
  try {
    if (w.element) {
      w.element.style.display = "";
      w.element.hidden = false;
      w.element.style.height = "";
      w.element.style.overflow = "";
      w.element.style.margin = "";
      w.element.style.padding = "";
    }
  } catch (_) {}
}

/** 与 wan_sequencer 一致的显隐 */
function toggleWidget(widget, visible) {
  if (!widget) return;
  if (widget.type === "converted-widget") return;

  if (visible) {
    if (widget.origType !== undefined) {
      widget.type = widget.origType;
      widget.computeSize = widget.origComputeSize;
      delete widget.origType;
      delete widget.origComputeSize;
    }
    try {
      widget.hidden = false;
    } catch (_) {}
    if (widget.element) {
      try {
        widget.element.style.display = "";
        widget.element.hidden = false;
      } catch (_) {}
    }
  } else {
    if (widget.type !== "hidden") {
      widget.origType = widget.type;
      widget.origComputeSize = widget.computeSize;
      widget.type = "hidden";
      widget.computeSize = () => [0, -4];
    }
    try {
      widget.hidden = true;
    } catch (_) {}
    hideWidgetEl(widget);
  }
}

function getSlotCount(node) {
  if (typeof node._lazyLoraCount === "number") {
    return Math.max(0, Math.min(MAX_SLOTS, node._lazyLoraCount));
  }
  const w = findW(node, "槽位数");
  const n = Number(w?.value);
  return Math.max(0, Math.min(MAX_SLOTS, Number.isFinite(n) ? n : 1));
}

function setSlotCount(node, n) {
  n = Math.max(0, Math.min(MAX_SLOTS, Number(n) || 0));
  node._lazyLoraCount = n;
  const w = findW(node, "槽位数");
  if (w) w.value = n;
  return n;
}

function refreshNode(node) {
  try {
    if (typeof node.computeSize === "function") {
      const sz = node.computeSize();
      if (Array.isArray(sz) && sz.length >= 2) {
        node.setSize([node.size?.[0] || sz[0], sz[1]]);
      }
    }
  } catch (_) {}
  try {
    node.setDirtyCanvas?.(true, true);
  } catch (_) {}
}

function collapseBtnWidget(w) {
  if (!w) return;
  // 彻底不占位、不可见（防重绘后幽灵条）
  w.type = "hidden";
  w.computeSize = () => [0, -4];
  try {
    w.hidden = true;
  } catch (_) {}
  hideWidgetEl(w);
  try {
    w.draw = function () {};
  } catch (_) {}
}

function destroyBtnWidget(node, w) {
  if (!w) return;
  collapseBtnWidget(w);
  try {
    w.element?.remove?.();
  } catch (_) {}
  try {
    w.options?.element?.remove?.();
  } catch (_) {}
  const idx = node.widgets?.indexOf(w);
  if (idx >= 0) node.widgets.splice(idx, 1);
}

/** 只保留一条按钮，并固定在 widgets 末尾 */
function sanitizeButtons(node) {
  if (!node?.widgets) return null;

  const btns = allBtnWidgets(node);
  if (btns.length === 0) return null;

  // 多余条：折叠并移出数组
  if (btns.length > 1) {
    for (let i = 0; i < btns.length - 1; i++) {
      destroyBtnWidget(node, btns[i]);
    }
  }

  // 唯一条必须在末尾
  const kept = allBtnWidgets(node)[0];
  if (!kept) return null;

  const idx = node.widgets.indexOf(kept);
  if (idx >= 0 && idx !== node.widgets.length - 1) {
    node.widgets.splice(idx, 1);
    node.widgets.push(kept);
  }

  // 恢复可见尺寸
  if (kept.type === "hidden" && kept._lazyBtnOrigType) {
    kept.type = kept._lazyBtnOrigType;
  }
  if (!kept._lazyBtnOrigType && kept.type && kept.type !== "hidden") {
    kept._lazyBtnOrigType = kept.type;
  }
  if (kept.type === "hidden") {
    kept.type = kept._lazyBtnOrigType || "div";
  }
  kept.computeSize = function (width) {
    return [width || node.size?.[0] || 300, 52];
  };
  try {
    kept.hidden = false;
  } catch (_) {}
  showWidgetEl(kept);

  // 同步 pack
  if (node._lazyLoraBtns?.dom && node._lazyLoraBtns.dom !== kept) {
    // 丢弃旧 pack 引用，用当前 widget 的 DOM
  }
  if (kept.element?.querySelector) {
    const addBtn = kept.element.querySelector("[data-lazy-lora='add']");
    const delBtn = kept.element.querySelector("[data-lazy-lora='del']");
    const info = kept.element.querySelector("[data-lazy-lora='info']");
    if (addBtn && delBtn) {
      node._lazyLoraBtns = {
        bar: kept.element,
        addBtn,
        delBtn,
        info,
        dom: kept,
      };
    }
  } else if (node._lazyLoraBtns) {
    node._lazyLoraBtns.dom = kept;
  }

  updateButtonState(node);
  return kept;
}

function applySlotVisibility(node, count) {
  const n = setSlotCount(node, count);

  for (let i = 1; i <= MAX_SLOTS; i++) {
    const show = i <= n;
    toggleWidget(findW(node, `启用_${i}`), show);
    toggleWidget(findW(node, `LoRA_${i}`), show);
    toggleWidget(findW(node, `强度_${i}`), show);
  }

  toggleWidget(findW(node, "槽位数"), false);
  sanitizeButtons(node);
  refreshNode(node);
}

function updateButtonState(node) {
  const pack = node._lazyLoraBtns;
  if (!pack?.addBtn) return;
  const n = getSlotCount(node);
  pack.addBtn.disabled = n >= MAX_SLOTS;
  pack.delBtn.disabled = n <= 0;
  pack.addBtn.style.opacity = pack.addBtn.disabled ? "0.45" : "1";
  pack.delBtn.style.opacity = pack.delBtn.disabled ? "0.45" : "1";
  try {
    if (pack.info) pack.info.textContent = `槽位 ${n} / ${MAX_SLOTS}`;
  } catch (_) {}
}

function onAddSlot(node) {
  const cur = getSlotCount(node);
  if (cur >= MAX_SLOTS) return;
  applySlotVisibility(node, cur + 1);
}

function onDelSlot(node) {
  const cur = getSlotCount(node);
  if (cur <= 0) return;
  const i = cur;
  const en = findW(node, `启用_${i}`);
  const lo = findW(node, `LoRA_${i}`);
  const st = findW(node, `强度_${i}`);
  if (en) en.value = true;
  if (lo) {
    const vals = lo.options?.values;
    if (Array.isArray(vals) && vals.includes("none")) lo.value = "none";
    else if (Array.isArray(vals) && vals.length) lo.value = vals[0];
    else lo.value = "none";
  }
  if (st) st.value = 1.0;
  applySlotVisibility(node, cur - 1);
}

function ensureButtons(node) {
  // 先清理重复
  const existing = allBtnWidgets(node);
  if (existing.length >= 1) {
    sanitizeButtons(node);
    // 若 pack 按钮事件还在，直接返回
    if (node._lazyLoraBtns?.addBtn) return node._lazyLoraBtns;
    // pack 丢了：销毁后重建
    for (const w of allBtnWidgets(node)) destroyBtnWidget(node, w);
    node._lazyLoraBtns = null;
  }

  const bar = document.createElement("div");
  bar.className = "lazy-h3-lora-btns";
  bar.dataset.lazyLoraBar = "1";
  bar.style.cssText = `
    display:flex;flex-direction:column;gap:6px;width:100%;
    box-sizing:border-box;padding:4px 2px 2px;pointer-events:auto;
  `;

  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:8px;width:100%;";

  const mkBtn = (text, bg, key) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.dataset.lazyLora = key;
    b.style.cssText = `
      flex:1;cursor:pointer;border:1px solid #666;border-radius:4px;
      padding:7px 8px;font-size:12px;color:#eee;background:${bg};
      pointer-events:auto;user-select:none;
    `;
    return b;
  };

  const addBtn = mkBtn("＋ 添加 LoRA", "#2d4a3e", "add");
  const delBtn = mkBtn("－ 删除末槽", "#4a2d2d", "del");
  addBtn.title = "增加一个 LoRA 槽位";
  delBtn.title = "删除最后一个槽位";

  const bind = (el, fn) => {
    const handler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
      try {
        sanitizeButtons(node);
        fn(node);
      } catch (err) {
        console.warn("[LazyH3 LoRA] 按钮:", err);
      }
      return false;
    };
    el.addEventListener("pointerdown", handler, true);
    el.addEventListener("click", handler, true);
  };
  bind(addBtn, onAddSlot);
  bind(delBtn, onDelSlot);

  row.appendChild(addBtn);
  row.appendChild(delBtn);

  const info = document.createElement("div");
  info.dataset.lazyLora = "info";
  info.style.cssText =
    "font-size:11px;color:#aaa;text-align:center;line-height:1.2;";
  info.textContent = `槽位 1 / ${MAX_SLOTS}`;

  bar.appendChild(row);
  bar.appendChild(info);

  const dom = node.addDOMWidget(BTN_WIDGET, "div", bar, {
    serialize: false,
  });
  if (dom) {
    dom._lazyBtnOrigType = dom.type || "div";
    dom.computeSize = function (width) {
      return [width || node.size?.[0] || 300, 52];
    };
  }

  node._lazyLoraBtns = { bar, addBtn, delBtn, info, dom };
  sanitizeButtons(node);
  updateButtonState(node);
  return node._lazyLoraBtns;
}

function initNodeUI(node) {
  if (node._lazyLoraIniting) return;
  node._lazyLoraIniting = true;
  try {
    // 干掉历史残留的全部按钮条再创建一条
    for (const w of allBtnWidgets(node)) destroyBtnWidget(node, w);
    node._lazyLoraBtns = null;
    ensureButtons(node);
    const n = getSlotCount(node) || 1;
    applySlotVisibility(node, n);
    node._lazyLoraReady = true;
  } finally {
    node._lazyLoraIniting = false;
  }
}

app.registerExtension({
  name: "Lazy.H3.LoraStack",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      try {
        this._lazyLoraCount = Number(findW(this, "槽位数")?.value ?? 1) || 1;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            try {
              initNodeUI(this);
            } catch (e) {
              console.warn("[LazyH3 LoRA] init:", e);
            }
          });
        });
      } catch (e) {
        console.warn("[LazyH3 LoRA] onNodeCreated:", e);
      }
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      try {
        const n = Number(findW(this, "槽位数")?.value ?? 1) || 1;
        this._lazyLoraCount = n;
      } catch (_) {}
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          try {
            initNodeUI(this);
          } catch (e) {
            console.warn("[LazyH3 LoRA] configure:", e);
          }
        });
      });
      return r;
    };

    // 画布移出再移回会重排 DOM：每帧绘制前去重贴底
    const onDrawForeground = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      try {
        if (this._lazyLoraReady) sanitizeButtons(this);
      } catch (_) {}
      if (onDrawForeground) return onDrawForeground.apply(this, arguments);
    };

    const onDrawBackground = nodeType.prototype.onDrawBackground;
    nodeType.prototype.onDrawBackground = function (ctx) {
      try {
        if (this._lazyLoraReady) sanitizeButtons(this);
      } catch (_) {}
      if (onDrawBackground) return onDrawBackground.apply(this, arguments);
    };
  },
});
