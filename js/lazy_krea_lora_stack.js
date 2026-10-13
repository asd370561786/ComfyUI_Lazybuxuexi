/**
 * Lazy Krea 多 LoRA
 * 每槽：启用 → LoRA → 强度 → 类型
 * 加载时迁移旧 widgets_values，避免错位成 LoRA=1 / 强度=默认
 */
import { app } from "../../scripts/app.js";

const NODE_NAME = "LazyKreaLoraStack";
const MAX_SLOTS = 8;
const BTN_WIDGET = "lazy_krea_lora_btns";
const TYPE_OPTS = ["默认", "风格", "人物"];

function findW(node, name) {
  return node.widgets?.find((w) => w && w.name === name);
}
function allBtnWidgets(node) {
  return (node.widgets || []).filter((w) => w && w.name === BTN_WIDGET);
}
function hideEl(w) {
  if (!w?.element) return;
  try {
    w.element.style.display = "none";
    w.element.hidden = true;
  } catch (_) {}
}
function toggleWidget(widget, visible) {
  if (!widget || widget.type === "converted-widget") return;
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
      widget.element.style.display = "";
      widget.element.hidden = false;
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
    hideEl(widget);
  }
}
function getCount(node) {
  if (typeof node._lazyKreaLoraCount === "number") return node._lazyKreaLoraCount;
  const n = Number(findW(node, "槽位数")?.value);
  return Math.max(0, Math.min(MAX_SLOTS, Number.isFinite(n) ? n : 1));
}
function setCount(node, n) {
  n = Math.max(0, Math.min(MAX_SLOTS, Number(n) || 0));
  node._lazyKreaLoraCount = n;
  const w = findW(node, "槽位数");
  if (w) w.value = n;
  return n;
}
function destroyBtn(node, w) {
  if (!w) return;
  w.type = "hidden";
  w.computeSize = () => [0, -4];
  hideEl(w);
  try {
    w.element?.remove?.();
  } catch (_) {}
  const i = node.widgets?.indexOf(w);
  if (i >= 0) node.widgets.splice(i, 1);
}
function sanitize(node) {
  const btns = allBtnWidgets(node);
  if (!btns.length) return;
  for (let i = 0; i < btns.length - 1; i++) destroyBtn(node, btns[i]);
  const kept = allBtnWidgets(node)[0];
  if (!kept) return;
  const idx = node.widgets.indexOf(kept);
  if (idx >= 0 && idx !== node.widgets.length - 1) {
    node.widgets.splice(idx, 1);
    node.widgets.push(kept);
  }
  kept.computeSize = (width) => [width || 300, 52];
  try {
    kept.hidden = false;
  } catch (_) {}
  if (kept.element) {
    kept.element.style.display = "";
    kept.element.hidden = false;
  }
  updateBtns(node);
}

function resetSlotDefaults(node, i) {
  const en = findW(node, `启用_${i}`);
  if (en) en.value = true;
  const lo = findW(node, `LoRA_${i}`);
  if (lo) {
    const vals = lo.options?.values || [];
    lo.value = vals.includes("none") ? "none" : vals[0] ?? "none";
  }
  const st = findW(node, `强度_${i}`);
  if (st) st.value = 1.0;
  const ty = findW(node, `类型_${i}`);
  if (ty) {
    const vals = ty.options?.values || TYPE_OPTS;
    ty.value = vals.includes("默认") ? "默认" : vals[0];
  }
}

function isValidLoraValue(lo) {
  if (!lo) return false;
  const v = lo.value;
  if (v === "none" || v === "None") return true;
  if (v == null || v === "") return false;
  if (typeof v === "number" || typeof v === "boolean") return false;
  const s = String(v);
  if (TYPE_OPTS.includes(s)) return false;
  if (!Number.isNaN(Number(s)) && String(Number(s)) === s) return false;
  const vals = lo.options?.values;
  if (Array.isArray(vals) && vals.length && !vals.includes(v)) return false;
  return true;
}

function slotLooksDirty(node, i) {
  const lo = findW(node, `LoRA_${i}`);
  const st = findW(node, `强度_${i}`);
  const ty = findW(node, `类型_${i}`);
  if (!isValidLoraValue(lo)) return true;
  if (st != null) {
    if (typeof st.value === "boolean") return true;
    if (TYPE_OPTS.includes(String(st.value))) return true;
    const n = Number(st.value);
    if (Number.isNaN(n) || Math.abs(n) > 99) return true;
  }
  if (ty) {
    const vals = ty.options?.values || TYPE_OPTS;
    if (!vals.includes(ty.value)) return true;
  }
  return false;
}

/**
 * 旧布局：槽位数 + N*(启用,LoRA,强度) + N*类型（类型在末尾）
 * 新布局：槽位数 + 8*(启用,LoRA,强度,类型)
 * 若 index4 是 boolean（旧的启用_2），按旧布局迁移，只保留前 8 槽。
 */
function migrateWidgetsValues(info) {
  if (!info || !Array.isArray(info.widgets_values)) return;
  const wv = info.widgets_values;
  if (wv.length < 4) return;

  const at4 = wv[4];
  const looksOldTypesAtEnd = at4 === true || at4 === false;
  const at6 = wv[6];
  const looksCorrupted =
    at6 === 1 ||
    at6 === "1" ||
    at6 === "默认" ||
    at6 === "风格" ||
    at6 === "人物" ||
    at6 === "none" ||
    typeof at6 === "number";

  if (looksOldTypesAtEnd) {
    // 旧版曾支持 16 槽：1+16*3+16=65；8 槽：1+8*3+8=33
    const oldSlots = wv.length >= 1 + 16 * 3 + 8 ? 16 : 8;
    const typeBase = 1 + oldSlots * 3;
    let count = Number(wv[0]) || 1;
    if (count > MAX_SLOTS) count = MAX_SLOTS;
    const next = [count];
    for (let i = 0; i < MAX_SLOTS; i++) {
      if (i < oldSlots) {
        const b = 1 + i * 3;
        next.push(wv[b] ?? true);
        next.push(wv[b + 1] ?? "none");
        const s = Number(wv[b + 2]);
        next.push(Number.isFinite(s) && Math.abs(s) <= 99 ? s : 1.0);
        const t = wv[typeBase + i];
        next.push(TYPE_OPTS.includes(t) ? t : "默认");
      } else {
        next.push(true, "none", 1.0, "默认");
      }
    }
    info.widgets_values = next;
    return;
  }

  if (looksCorrupted) {
    // 错位存盘：尽量保住第 1 槽，其余重置；槽数封顶 8
    let count = Number(wv[0]) || 1;
    if (count > MAX_SLOTS) count = MAX_SLOTS;
    const lo1 = wv[2];
    const keepLo1 =
      typeof lo1 === "string" &&
      lo1 !== "" &&
      !TYPE_OPTS.includes(lo1) &&
      Number.isNaN(Number(lo1));
    const s1 = Number(wv[3]);
    const next = [
      count,
      wv[1] ?? true,
      keepLo1 ? lo1 : "none",
      Number.isFinite(s1) && Math.abs(s1) <= 99 ? s1 : 1.0,
      TYPE_OPTS.includes(wv[4]) ? wv[4] : "默认",
    ];
    for (let i = 1; i < MAX_SLOTS; i++) {
      next.push(true, "none", 1.0, "默认");
    }
    info.widgets_values = next;
  }
}

function applyVis(node, count) {
  const n = setCount(node, count);
  for (let i = 1; i <= MAX_SLOTS; i++) {
    const show = i <= n;
    toggleWidget(findW(node, `启用_${i}`), show);
    toggleWidget(findW(node, `LoRA_${i}`), show);
    toggleWidget(findW(node, `强度_${i}`), show);
    toggleWidget(findW(node, `类型_${i}`), show);
    if (show && slotLooksDirty(node, i)) {
      resetSlotDefaults(node, i);
    }
  }
  toggleWidget(findW(node, "槽位数"), false);
  sanitize(node);
  try {
    if (node.computeSize) node.setSize([node.size[0], node.computeSize()[1]]);
  } catch (_) {}
  node.setDirtyCanvas?.(true, true);
}

function updateBtns(node) {
  const p = node._lazyKreaLoraBtns;
  if (!p?.addBtn) return;
  const n = getCount(node);
  p.addBtn.disabled = n >= MAX_SLOTS;
  p.delBtn.disabled = n <= 0;
  if (p.info) p.info.textContent = `槽位 ${n} / ${MAX_SLOTS}`;
}

function ensureButtons(node) {
  if (allBtnWidgets(node).length) {
    sanitize(node);
    if (node._lazyKreaLoraBtns?.addBtn) return;
    for (const w of allBtnWidgets(node)) destroyBtn(node, w);
  }
  const bar = document.createElement("div");
  bar.style.cssText =
    "display:flex;flex-direction:column;gap:6px;width:100%;padding:4px 0;pointer-events:auto;";
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:8px;width:100%;";
  const mk = (t, bg) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = t;
    b.style.cssText = `flex:1;cursor:pointer;border:1px solid #666;border-radius:4px;padding:7px 8px;font-size:12px;color:#eee;background:${bg};`;
    return b;
  };
  const addBtn = mk("＋ 添加 LoRA", "#2d4a3e");
  const delBtn = mk("－ 删除末槽", "#4a2d2d");
  addBtn.title = "增加槽位";
  delBtn.title = "删除末槽";
  addBtn.onclick = (e) => {
    e.stopPropagation();
    const c = getCount(node);
    if (c >= MAX_SLOTS) return;
    const next = c + 1;
    resetSlotDefaults(node, next);
    applyVis(node, next);
  };
  delBtn.onclick = (e) => {
    e.stopPropagation();
    const c = getCount(node);
    if (c <= 0) return;
    resetSlotDefaults(node, c);
    applyVis(node, c - 1);
  };
  row.appendChild(addBtn);
  row.appendChild(delBtn);
  const info = document.createElement("div");
  info.style.cssText = "font-size:11px;color:#aaa;text-align:center;";
  bar.appendChild(row);
  bar.appendChild(info);
  const dom = node.addDOMWidget(BTN_WIDGET, "div", bar, { serialize: false });
  if (dom) dom.computeSize = (w) => [w || 300, 52];
  node._lazyKreaLoraBtns = { addBtn, delBtn, info, dom };
  sanitize(node);
  updateBtns(node);
}

function initUI(node) {
  for (const w of allBtnWidgets(node)) destroyBtn(node, w);
  node._lazyKreaLoraBtns = null;
  ensureButtons(node);
  applyVis(node, getCount(node) || 1);
  node._lazyKreaLoraReady = true;
}

app.registerExtension({
  name: "Lazy.Krea.LoraStack",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      this._lazyKreaLoraCount = Number(findW(this, "槽位数")?.value ?? 1) || 1;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          try {
            initUI(this);
          } catch (e) {
            console.warn("[LazyKrea LoRA]", e);
          }
        })
      );
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      try {
        migrateWidgetsValues(info);
      } catch (e) {
        console.warn("[LazyKrea LoRA] migrate:", e);
      }
      const r = onConfigure?.apply(this, arguments);
      this._lazyKreaLoraCount = Number(findW(this, "槽位数")?.value ?? 1) || 1;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          try {
            initUI(this);
            // 再扫一遍脏槽
            const n = getCount(this);
            for (let i = 1; i <= n; i++) {
              if (slotLooksDirty(this, i)) resetSlotDefaults(this, i);
            }
          } catch (_) {}
        })
      );
      return r;
    };

    const onDrawForeground = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function () {
      try {
        if (this._lazyKreaLoraReady) sanitize(this);
      } catch (_) {}
      return onDrawForeground?.apply(this, arguments);
    };
  },
});
