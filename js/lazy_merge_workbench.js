/**
 * Lazy 合并台：风格样图 / 最多 10 张参考图 / 按行提示词。
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import * as appMod from "../../scripts/app.js";
import {
  bindDomWidgetWidthToNode,
  configureFullWidthDomWidget,
} from "./dom_widget_layout.js";

function getComfyApp() {
  const named = appMod?.ComfyApp;
  if (named && (named.open_maskeditor || named.copyToClipspace)) return named;
  if (typeof window !== "undefined" && window.ComfyApp) return window.ComfyApp;
  const C = app?.constructor;
  if (C && (C.open_maskeditor || C.copyToClipspace)) return C;
  return named || C || null;
}

const NODE_NAME = "LazyMergeWorkbench";
const MAX_IMAGES = 10;
const H_KEY = "lazy_merge_wb_heights";

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
function parseJSON(raw, fallback) {
  try {
    const v = JSON.parse(raw || "");
    return v ?? fallback;
  } catch (_) {
    return fallback;
  }
}
function loadHeights() {
  try {
    return JSON.parse(localStorage.getItem(H_KEY) || "{}") || {};
  } catch (_) {
    return {};
  }
}
function saveHeights(h) {
  try {
    localStorage.setItem(H_KEY, JSON.stringify(h));
  } catch (_) {}
}

function makeSplitter(getH, setH, save) {
  const sp = document.createElement("div");
  sp.title = "拖动调整高度";
  sp.style.cssText =
    "height:8px;cursor:row-resize;flex-shrink:0;background:#333;border-radius:2px;margin:2px 0;touch-action:none;";
  sp.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startH = getH();
    const pid = e.pointerId;
    let ended = false;
    try {
      sp.setPointerCapture(pid);
    } catch (_) {}
    const end = (ev) => {
      if (ended) return;
      if (ev && ev.type !== "blur" && ev.pointerId != null && ev.pointerId !== pid) return;
      ended = true;
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      window.removeEventListener("mouseup", end, true);
      window.removeEventListener("blur", end, true);
      try {
        sp.releasePointerCapture(pid);
      } catch (_) {}
      save?.();
    };
    const move = (ev) => {
      if (ended || (ev.pointerId != null && ev.pointerId !== pid)) return;
      if (ev.buttons != null && (ev.buttons & 1) === 0) {
        end(ev);
        return;
      }
      ev.preventDefault?.();
      ev.stopPropagation?.();
      setH(Math.max(90, startH + (ev.clientY - startY)));
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
    window.addEventListener("mouseup", end, true);
    window.addEventListener("blur", end, true);
  });
  return sp;
}

function cardCss(sel) {
  return `cursor:pointer;border:2px solid ${sel ? "#6af" : "#333"};border-radius:6px;padding:4px;background:${sel ? "#1a2a3a" : "#222"};`;
}

let _closeStyleDialog = null;
function closeStyleDialog() {
  try {
    _closeStyleDialog?.();
  } catch (_) {}
}

function fileToPreviewJpeg(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      resolve("");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      reject(new Error("预览图过大"));
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const max = 512;
        let w = img.naturalWidth || img.width || 1;
        let h = img.naturalHeight || img.height || 1;
        const scale = Math.min(1, max / Math.max(w, h));
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#111";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.86));
      } catch (err) {
        reject(err);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("预览图无法识别"));
    };
    img.src = url;
  });
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
  panel.appendChild(title);

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
  promptInput.placeholder = "提示词";
  promptInput.title = "提示词";
  promptInput.value = editing ? item.prompt || "" : "";
  promptInput.style.cssText =
    "width:100%;box-sizing:border-box;height:96px;resize:vertical;background:#111;color:#eee;border:1px solid #444;border-radius:4px;padding:6px 8px;";

  const preview = document.createElement("div");
  preview.title = "预览图";
  preview.style.cssText =
    "height:96px;border:1px dashed #555;border-radius:6px;background:#111;display:flex;align-items:center;justify-content:center;overflow:hidden;cursor:pointer;color:#888;font-size:28px;";
  preview.textContent = "+";
  let picked = null;
  const showPreview = (src) => {
    preview.textContent = "";
    if (!src) {
      preview.textContent = "+";
      return;
    }
    const img = document.createElement("img");
    img.src = src;
    img.alt = "预览图";
    img.style.cssText = "width:100%;height:100%;object-fit:cover;";
    preview.appendChild(img);
  };
  if (editing && item.thumbnail) {
    let src = item.thumbnail;
    try {
      if (String(src).startsWith("/") && typeof api?.apiURL === "function") src = api.apiURL(src);
    } catch (_) {}
    showPreview(src);
  }
  const filePick = document.createElement("input");
  filePick.type = "file";
  filePick.accept = "image/*";
  filePick.style.display = "none";
  preview.onclick = () => filePick.click();
  filePick.onchange = () => {
    const file = filePick.files && filePick.files[0];
    if (!file) return;
    picked = file;
    showPreview(URL.createObjectURL(file));
  };

  let model = editing && item.channel === "qwen" ? "qwen" : "krea";
  const modelRow = document.createElement("div");
  modelRow.style.cssText = "display:flex;gap:8px;";
  const modelBtns = [];
  const paintModel = () => {
    modelBtns.forEach((b) => {
      const on = b.dataset.model === model;
      b.style.borderColor = on ? "#6af" : "#444";
      b.style.background = on ? "#1a2a3a" : "#222";
      b.style.color = on ? "#fff" : "#ccc";
    });
  };
  [
    ["K2", "krea"],
    ["Qwen", "qwen"],
  ].forEach(([label, value]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = "模型";
    b.dataset.model = value;
    b.style.cssText =
      "flex:1;cursor:pointer;border:1px solid #444;border-radius:4px;padding:6px 0;background:#222;color:#ccc;";
    b.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      model = value;
      paintModel();
    };
    modelBtns.push(b);
    modelRow.appendChild(b);
  });
  paintModel();

  const err = document.createElement("div");
  err.style.cssText = "min-height:16px;color:#f66;margin-top:6px;";
  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:8px;";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "取消";
  cancelBtn.title = "取消";
  const okBtn = document.createElement("button");
  okBtn.type = "button";
  okBtn.textContent = "保存";
  okBtn.title = "保存";
  const btnCss =
    "cursor:pointer;border:1px solid #555;border-radius:4px;padding:4px 12px;background:#333;color:#eee;";
  cancelBtn.style.cssText = btnCss;
  okBtn.style.cssText = btnCss;
  actions.appendChild(cancelBtn);
  actions.appendChild(okBtn);

  panel.appendChild(lab("名字"));
  panel.appendChild(nameInput);
  panel.appendChild(lab("提示词"));
  panel.appendChild(promptInput);
  panel.appendChild(lab("预览图"));
  panel.appendChild(preview);
  panel.appendChild(filePick);
  panel.appendChild(lab("模型"));
  panel.appendChild(modelRow);
  panel.appendChild(err);
  panel.appendChild(actions);
  mask.appendChild(panel);

  const stop = (e) => e.stopPropagation();
  mask.addEventListener("pointerdown", stop);
  mask.addEventListener("wheel", stop, { passive: true });
  panel.addEventListener("pointerdown", stop);

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
    err.textContent = "";
    const name = nameInput.value.trim();
    const prompt = promptInput.value.trim();
    if (!name) {
      err.textContent = "请填写名字";
      return;
    }
    okBtn.disabled = true;
    try {
      let image_b64 = "";
      if (picked) image_b64 = await fileToPreviewJpeg(picked);
      await onDone?.({
        action: "save",
        name,
        prompt,
        model,
        old_name: editing ? item.name : "",
        image_b64,
      });
      close();
    } catch (ex) {
      const msg = ex?.message || "保存失败";
      if (msg.includes("已经存在")) {
        close();
        return;
      }
      err.textContent = msg;
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
  name: "Lazy.Merge.Workbench",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      // 延后一帧，确保 widget 已建好
      requestAnimationFrame(() => {
        try {
          setupWorkbench(this);
        } catch (e) {
          console.error("[Lazy合并台] 初始化失败:", e);
        }
      });
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      requestAnimationFrame(() => {
        try {
          if (!this._lazyMergeWB) setupWorkbench(this);
          else this._lazyMergeWB.refresh?.();
        } catch (e) {
          console.error("[Lazy合并台] configure:", e);
        }
      });
      return r;
    };
  },
});

function setupWorkbench(node) {
  if (node._lazyMergeWB) return;
  const prevRemoved = node.onRemoved;
  node.onRemoved = function () {
    closeStyleDialog();
    if (prevRemoved) return prevRemoved.apply(this, arguments);
  };

  const wLib = findW(node, "风格库");
  const wStyle = findW(node, "风格");
  const wMedia = findW(node, "图片数据");
  const wText = findW(node, "提示词文本");
  const wStart = findW(node, "起始索引");
  const wRows = findW(node, "最大行数");
  const wEmpty = findW(node, "去除空行");
  hideWidget(wMedia);
  hideWidget(wStyle);
  hideWidget(wText);
  hideWidget(wStart);
  hideWidget(wRows);
  hideWidget(wEmpty);

  const heights = Object.assign({ style: 210, img: 240, prompt: 220 }, loadHeights());

  let domWidget = null;
  const contentHeight = () =>
    Number(heights.style || 210) +
    Number(heights.img || 240) +
    Number(heights.prompt || 220) +
    36;
  const contentWidth = () => Math.max(Number(node.size?.[0]) || 0, 420);
  const refreshDomSize = () => {
    const total = contentHeight();
    if (domWidget) {
      domWidget.computeSize = () => [contentWidth(), Math.max(320, total)];
    }
    configureFullWidthDomWidget(root);
    try {
      const w = Math.max(Number(node.size?.[0]) || 420, 420);
      const h = total + 90;
      if (!node.size || node.size[1] !== h) node.setSize([w, h]);
      node.setDirtyCanvas?.(true, true);
    } catch (_) {}
  };

  const root = document.createElement("div");
  root.style.cssText =
    "width:100%;max-width:100%;min-width:0;height:auto;max-height:100%;overflow:hidden;display:flex;flex-direction:column;box-sizing:border-box;pointer-events:auto;color:#ddd;font-size:12px;";
  configureFullWidthDomWidget(root);

  // —— ① 风格 ——
  const styleBox = document.createElement("div");
  styleBox.style.cssText =
    "width:100%;max-width:100%;min-width:0;box-sizing:border-box;border:1px solid #444;border-radius:8px;padding:8px;background:#1a1a1a;display:flex;flex-direction:column;overflow:hidden;flex-shrink:0;";
  const styleHead = document.createElement("div");
  styleHead.style.cssText =
    "display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;flex-shrink:0;";
  const styleTitle = document.createElement("span");
  styleTitle.style.cssText = "font-weight:600;color:#cfd3dc;";
  styleTitle.textContent = "① 风格";
  const clearStyleBtn = document.createElement("button");
  clearStyleBtn.type = "button";
  clearStyleBtn.textContent = "清除";
  clearStyleBtn.title = "取消风格";
  clearStyleBtn.style.cssText =
    "cursor:pointer;border:1px solid #555;border-radius:4px;padding:2px 8px;background:#333;color:#ccc;font-size:11px;";
  styleHead.appendChild(styleTitle);
  styleHead.appendChild(clearStyleBtn);
  const styleScroll = document.createElement("div");
  styleScroll.style.cssText = "flex:1;width:100%;max-width:100%;min-width:0;overflow:auto;min-height:0;";
  const styleGrid = document.createElement("div");
  styleGrid.style.cssText =
    "width:100%;min-width:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;";
  styleScroll.appendChild(styleGrid);
  styleBox.appendChild(styleHead);
  styleBox.appendChild(styleScroll);

  const applyStyleH = (h) => {
    heights.style = h;
    styleBox.style.height = h + "px";
    refreshDomSize();
  };

  let styleItemsCache = [];
  let userStylesCache = [];

  function makeThumb(name, label, thumbUrl) {
    const thumb = document.createElement("div");
    thumb.style.cssText =
      "height:70px;border-radius:4px;overflow:hidden;background:#111;display:flex;align-items:center;justify-content:center;";
    if (thumbUrl) {
      const img = document.createElement("img");
      let src = thumbUrl;
      try {
        if (String(thumbUrl).startsWith("/") && typeof api?.apiURL === "function") {
          src = api.apiURL(thumbUrl);
        }
      } catch (_) {}
      img.src = src;
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = label;
      img.style.cssText = "width:100%;height:100%;object-fit:cover;";
      img.onerror = () => {
        thumb.textContent = "无样图";
        thumb.style.color = "#666";
        thumb.style.fontSize = "10px";
        try {
          img.remove();
        } catch (_) {}
      };
      thumb.appendChild(img);
    } else {
      thumb.textContent = name === "none" ? "不套风格" : "无样图";
      thumb.style.color = "#888";
      thumb.style.fontSize = "11px";
    }
    return thumb;
  }

  async function postUserStyle(payload) {
    const res = await api.fetchApi("/lazy_merge/user_styles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
    let data = {};
    try {
      data = await res.json();
    } catch (_) {}
    if (!res.ok || data?.ok === false) {
      throw new Error(data?.error || "操作失败");
    }
    return data;
  }

  function renderStyleCards(items) {
    const cur = wStyle?.value || "none";
    styleGrid.innerHTML = "";
    const addCard = (name, label, thumbUrl, selected) => {
      const card = document.createElement("div");
      card.style.cssText = cardCss(selected);
      card.title = label;
      const lab = document.createElement("div");
      lab.style.cssText =
        "margin-top:4px;font-size:10px;text-align:center;color:#ccc;max-height:2.4em;overflow:hidden;line-height:1.2;";
      lab.textContent = label;
      card.appendChild(makeThumb(name, label, thumbUrl));
      card.appendChild(lab);
      card.onclick = () => {
        setVal(wStyle, name);
        renderStyleCards(styleItemsCache);
      };
      styleGrid.appendChild(card);
    };
    addCard("none", "none", "", cur === "none");
    (items || []).forEach((it) => {
      addCard(it.name, it.name_cn || it.name, it.thumbnail || "", cur === it.name);
    });
    const sameCustom = (name) => cur === name || cur === `user:${name}`;
    (userStylesCache || []).forEach((it) => {
      const card = document.createElement("div");
      const selected = sameCustom(it.name);
      card.style.cssText = cardCss(selected);
      card.title = it.name;
      const ops = document.createElement("div");
      ops.style.cssText = "display:flex;gap:4px;margin-bottom:4px;";
      const mk = (text, fn) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = text;
        b.title = text;
        b.style.cssText =
          "flex:1;cursor:pointer;border:1px solid #555;border-radius:4px;padding:1px 0;background:#333;color:#ccc;font-size:10px;";
        const halt = (e) => {
          e.preventDefault();
          e.stopPropagation();
        };
        b.addEventListener("pointerdown", halt);
        b.onclick = (e) => {
          halt(e);
          fn();
        };
        return b;
      };
      ops.appendChild(
        mk("编辑", () => {
          openStyleDialog(it, async (payload) => {
            try {
              const data = await postUserStyle(payload);
              const saved = data?.item?.name || payload.name;
              if (sameCustom(it.name)) setVal(wStyle, `user:${saved}`);
            } finally {
              await reloadStyles();
            }
          });
        })
      );
      ops.appendChild(
        mk("删除", async () => {
          if (!window.confirm("删除这个风格？")) return;
          try {
            await postUserStyle({ action: "delete", name: it.name });
            if (sameCustom(it.name)) setVal(wStyle, "none");
            await reloadStyles();
          } catch (ex) {
            window.alert(ex?.message || "删除失败");
          }
        })
      );
      const lab = document.createElement("div");
      lab.style.cssText =
        "margin-top:4px;font-size:10px;text-align:center;color:#ccc;max-height:2.4em;overflow:hidden;line-height:1.2;";
      lab.textContent = it.name;
      const modelLab = document.createElement("div");
      modelLab.style.cssText = "font-size:10px;text-align:center;color:#8ab;";
      modelLab.textContent = it.channel === "qwen" ? "Qwen" : "K2";
      card.appendChild(ops);
      card.appendChild(makeThumb(it.name, it.name, it.thumbnail || ""));
      card.appendChild(lab);
      card.appendChild(modelLab);
      card.onclick = () => {
        if (String(it.name) === "自定义") ensureStore();
        setVal(wStyle, `user:${it.name}`);
        renderStyleCards(styleItemsCache);
      };
      styleGrid.appendChild(card);
    });
    const plus = document.createElement("div");
    plus.title = "添加风格";
    plus.textContent = "+";
    plus.style.cssText =
      "cursor:pointer;border:2px dashed #555;border-radius:6px;background:#222;min-height:96px;display:flex;align-items:center;justify-content:center;color:#9ab;font-size:28px;";
    plus.addEventListener("pointerdown", (e) => e.stopPropagation());
    plus.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openStyleDialog(null, async (payload) => {
        try {
          const data = await postUserStyle(payload);
          setVal(wStyle, `user:${data?.item?.name || payload.name}`);
        } finally {
          await reloadStyles();
        }
      });
    };
    styleGrid.appendChild(plus);
  }

  async function fetchUserStyles() {
    try {
      const res = await api.fetchApi(`/lazy_merge/user_style_list?t=${Date.now()}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || "读取失败");
      }
      userStylesCache = Array.isArray(data?.items) ? data.items : [];
    } catch (e) {
      console.warn("[LazyMerge] 自定义风格读取失败:", e);
      userStylesCache = [];
    }
  }

  async function reloadStyles() {
    const lib = wLib?.value || "none";
    const userTask = fetchUserStyles();
    if (!lib || lib === "none") {
      styleItemsCache = [];
      await userTask;
      const curName = String(wStyle?.value || "");
      const keep = (userStylesCache || []).some(
        (s) => curName === s.name || curName === `user:${s.name}`
      );
      if (!keep) setVal(wStyle, "none");
      renderStyleCards([]);
      return;
    }
    try {
      const res = await api.fetchApi(
        `/lazy_krea/styles?name=${encodeURIComponent(lib)}`
      );
      const data = await res.json();
      styleItemsCache = data?.items || [];
    } catch (e) {
      console.warn("[LazyMerge] 风格列表失败:", e);
      styleItemsCache = [];
    }
    await userTask;
    renderStyleCards(styleItemsCache);
  }
  clearStyleBtn.onclick = (e) => {
    e.stopPropagation();
    setVal(wStyle, "none");
    renderStyleCards(styleItemsCache);
  };
  if (wLib) {
    const prev = wLib.callback;
    wLib.callback = (v) => {
      try {
        prev?.(v);
      } catch (_) {}
      reloadStyles();
    };
  }

  // —— ② 参考图 ——
  const imgBox = document.createElement("div");
  imgBox.style.cssText =
    "width:100%;max-width:100%;min-width:0;box-sizing:border-box;border:1px solid #444;border-radius:8px;padding:8px;background:#1a1a1a;display:flex;flex-direction:column;overflow:hidden;flex-shrink:0;";
  const imgHead = document.createElement("div");
  imgHead.style.cssText =
    "font-weight:600;color:#cfd3dc;margin-bottom:6px;flex-shrink:0;";
  imgHead.textContent = "② 参考图（最多10张）";
  const dropZone = document.createElement("div");
  dropZone.style.cssText =
    "flex:1;min-height:100px;border:2px dashed #555;border-radius:8px;background:#141414;display:flex;flex-wrap:wrap;gap:10px;align-content:flex-start;padding:10px;overflow:auto;position:relative;";
  const dropHint = document.createElement("div");
  dropHint.style.cssText =
    "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#777;font-size:13px;pointer-events:none;text-align:center;padding:12px;";
  dropHint.textContent = "点击添加，或拖入本地/资产图片";
  dropZone.appendChild(dropHint);
  imgBox.appendChild(imgHead);
  imgBox.appendChild(dropZone);

  const applyImgH = (h) => {
    heights.img = h;
    imgBox.style.height = h + "px";
    refreshDomSize();
  };

  const fileImg = document.createElement("input");
  fileImg.type = "file";
  fileImg.accept = "image/*";
  fileImg.multiple = true;
  fileImg.style.display = "none";
  function getMedia() {
    const arr = parseJSON(wMedia?.value, []);
    return Array.isArray(arr) ? arr : [];
  }
  function setMedia(arr) {
    setVal(wMedia, JSON.stringify((arr || []).slice(0, MAX_IMAGES)));
    renderMedia();
  }
  function viewUrl(item) {
    const raw = String(item?.image || "").replace(/\\/g, "/");
    const type = item?.type || "input";
    const sub = item?.subfolder || "";
    let filename = raw.split("/").pop() || raw;
    let subfolder = sub;
    // image 里可能已带 subfolder/xxx.png
    if (!subfolder && raw.includes("/")) {
      const parts = raw.split("/").filter(Boolean);
      filename = parts.pop();
      subfolder = parts.join("/");
    }
    const q = new URLSearchParams({
      filename,
      type,
      subfolder,
    });
    try {
      return api.apiURL(`/view?${q.toString()}`);
    } catch (_) {
      return `/view?${q.toString()}`;
    }
  }

  function renderMedia() {
    const arr = getMedia();
    dropZone.querySelectorAll("[data-card]").forEach((el) => el.remove());
    dropHint.style.display = arr.length ? "none" : "flex";
    arr.forEach((item, idx) => {
      const card = document.createElement("div");
      card.dataset.card = "1";
      card.style.cssText =
        "width:132px;border:1px solid #555;border-radius:8px;padding:6px;background:#222;flex-shrink:0;";
      const previewWrap = document.createElement("div");
      previewWrap.style.cssText =
        "position:relative;width:100%;height:110px;background:#0d0d0d;border-radius:4px;overflow:hidden;";
      const img = document.createElement("img");
      const name = String(item.image || "").replace(/\\/g, "/").split("/").pop();
      img.src = item.maskPreview || viewUrl(item);
      img.style.cssText =
        "width:100%;height:110px;object-fit:contain;display:block;";
      img.onerror = () => {
        if ((item.type || "input") === "input" && !item.maskPreview) {
          img.onerror = () => {
            img.style.opacity = "0.3";
          };
          img.src = viewUrl({ ...item, type: "output" });
        } else {
          img.style.opacity = "0.3";
        }
      };
      previewWrap.appendChild(img);
      if (item.mask && !item.maskPreview) {
        // 异步叠蓝遮罩预览
        composeMaskPreview(item).then((url) => {
          if (url) {
            img.src = url;
            const arr = getMedia();
            if (arr[idx]) {
              arr[idx].maskPreview = url;
              setVal(wMedia, JSON.stringify(arr));
            }
          }
        });
      }
      if (item.mask) {
        const badge = document.createElement("div");
        badge.style.cssText =
          "position:absolute;left:4px;top:4px;background:rgba(0,120,255,.85);color:#fff;font-size:9px;padding:1px 5px;border-radius:3px;";
        badge.textContent = "遮罩";
        previewWrap.appendChild(badge);
      }
      const lab = document.createElement("div");
      lab.style.cssText =
        "font-size:10px;color:#aaa;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      lab.textContent = `<image${idx + 1}> ${name}`;
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:4px;margin-top:4px;";
      const mkBtn = (t, title) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = t;
        b.title = title;
        b.style.cssText =
          "flex:1;font-size:10px;cursor:pointer;border:1px solid #555;border-radius:3px;background:#333;color:#eee;padding:3px;";
        return b;
      };
      const maskBtn = mkBtn(item.mask ? "改遮罩" : "遮罩", "打开原生遮罩编辑器");
      maskBtn.onclick = (e) => {
        e.stopPropagation();
        openNativeMaskEditor(item, idx);
      };
      const clearMask = mkBtn("清罩", "清除遮罩");
      clearMask.onclick = (e) => {
        e.stopPropagation();
        const next = getMedia();
        if (!next[idx]) return;
        next[idx].mask = "";
        next[idx].maskType = "";
        next[idx].maskSubfolder = "";
        next[idx].maskPreview = "";
        setMedia(next);
      };
      const del = mkBtn("删除", "删除");
      del.onclick = (e) => {
        e.stopPropagation();
        const next = getMedia();
        next.splice(idx, 1);
        setMedia(next);
      };
      row.appendChild(maskBtn);
      if (item.mask) row.appendChild(clearMask);
      row.appendChild(del);
      card.appendChild(previewWrap);
      card.appendChild(lab);
      card.appendChild(row);
      dropZone.appendChild(card);
    });
  }

  function composeMaskPreview(item) {
    return new Promise((resolve) => {
      const base = new Image();
      base.crossOrigin = "anonymous";
      base.onload = () => {
        const mask = new Image();
        mask.crossOrigin = "anonymous";
        mask.onload = () => {
          const c = document.createElement("canvas");
          c.width = base.width;
          c.height = base.height;
          const ctx = c.getContext("2d");
          ctx.drawImage(base, 0, 0);
          const mc = document.createElement("canvas");
          mc.width = base.width;
          mc.height = base.height;
          const mctx = mc.getContext("2d");
          mctx.drawImage(mask, 0, 0, base.width, base.height);
          const md = mctx.getImageData(0, 0, mc.width, mc.height);
          const id = ctx.getImageData(0, 0, c.width, c.height);
          for (let i = 0; i < md.data.length; i += 4) {
            const v = md.data[i];
            if (v > 20) {
              // 缩略图半透明红罩（仅预览）
              id.data[i] = Math.min(255, Math.round(id.data[i] * 0.55 + 255 * 0.45));
              id.data[i + 1] = Math.round(id.data[i + 1] * 0.55);
              id.data[i + 2] = Math.round(id.data[i + 2] * 0.55);
            }
          }
          ctx.putImageData(id, 0, 0);
          resolve(c.toDataURL("image/png"));
        };
        mask.onerror = () => resolve("");
        mask.src = viewUrl({
          image: item.mask,
          type: item.maskType || "input",
          subfolder: item.maskSubfolder || "",
        });
      };
      base.onerror = () => resolve("");
      base.src = viewUrl(item);
    });
  }

  async function uploadFiles(files) {
    let arr = getMedia();
    for (const file of files) {
      if (arr.length >= MAX_IMAGES) break;
      const ok =
        file?.type?.startsWith?.("image/") ||
        /\.(png|jpe?g|webp|gif|bmp)$/i.test(file?.name || "");
      if (!ok) continue;
      try {
        const form = new FormData();
        form.append("image", file);
        form.append("overwrite", "true");
        const res = await api.fetchApi("/upload/image", {
          method: "POST",
          body: form,
        });
        const data = await res.json();
        const sub = data?.subfolder || "";
        const fname = data?.name || file.name;
        arr.push({
          image: sub ? `${sub}/${fname}` : fname,
          mask: "",
          type: "input",
          subfolder: sub,
        });
      } catch (err) {
        console.warn("[LazyMerge] 上传失败", err);
      }
    }
    setMedia(arr);
  }

  /** 解析 Comfy 资产拖放（对齐导演台逻辑） */
  function parseAssetRef(raw) {
    if (!raw || typeof raw !== "string") return null;
    let s = raw.trim();
    if (!s || s.startsWith("#")) return null;
    if (!/\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(s.split("?")[0].split("/").pop() || s) &&
        !s.includes("filename=")) {
      // 允许带 view 参数的 URL
      if (!/filename=/i.test(s)) return null;
    }
    try {
      let url = null;
      if (/^https?:\/\//i.test(s) || s.startsWith("/")) {
        url = new URL(s, window.location.origin);
      } else if (s.includes("filename=")) {
        url = new URL(s.startsWith("?") ? s : `?${s}`, window.location.origin);
      }
      if (url && url.searchParams.get("filename")) {
        const filename = decodeURIComponent(url.searchParams.get("filename"));
        const subfolder = decodeURIComponent(url.searchParams.get("subfolder") || "");
        const type = url.searchParams.get("type") || "input";
        return {
          image: subfolder ? `${subfolder}/${filename}` : filename,
          mask: "",
          type,
          subfolder,
        };
      }
    } catch (_) {}
    s = s.replace(/\s*\[(input|output|temp)\]\s*$/i, "").trim().replace(/\\/g, "/");
    if (!/\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(s)) return null;
    const parts = s.split("/").filter(Boolean);
    const filename = parts.pop();
    const subfolder = parts.join("/");
    return {
      image: subfolder ? `${subfolder}/${filename}` : filename,
      mask: "",
      type: "input",
      subfolder,
    };
  }

  function extractAssetRefs(dt) {
    if (!dt) return [];
    const out = [];
    const seen = new Set();
    const add = (raw) => {
      const ref = parseAssetRef(raw);
      if (!ref?.image || seen.has(ref.image + "|" + (ref.type || ""))) return;
      seen.add(ref.image + "|" + (ref.type || ""));
      out.push(ref);
    };
    const tryGet = (mime) => {
      try {
        return dt.getData(mime) || "";
      } catch (_) {
        return "";
      }
    };
    const uriList = tryGet("text/uri-list");
    if (uriList) {
      for (const line of uriList.split(/\r?\n/)) {
        if (line && !line.startsWith("#")) add(line);
      }
    }
    const moz = tryGet("text/x-moz-url");
    if (moz) {
      const lines = moz.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 2) if (lines[i]) add(lines[i]);
    }
    for (const mime of ["text/plain", "text", "application/json", "application/x-comfy-asset", "comfy/asset"]) {
      const plain = tryGet(mime);
      if (!plain) continue;
      if (mime.includes("json") || mime.includes("asset")) {
        try {
          const obj = JSON.parse(plain);
          const list = Array.isArray(obj) ? obj : [obj];
          for (const o of list) {
            if (!o) continue;
            if (typeof o === "string") add(o);
            else {
              const fn = o.filename || o.name || o.fileName || "";
              const sub = o.subfolder || "";
              const type = o.type || "input";
              if (fn) {
                add(`/view?filename=${encodeURIComponent(fn)}&type=${type}&subfolder=${encodeURIComponent(sub)}`);
              }
            }
          }
        } catch (_) {
          for (const line of plain.split(/\r?\n/)) if (line.trim()) add(line.trim());
        }
      } else {
        for (const line of plain.split(/\r?\n/)) if (line.trim()) add(line.trim());
      }
    }
    return out;
  }

  dropZone.addEventListener("click", (e) => {
    if (e.target.closest("button") || e.target.closest("[data-card]")) return;
    if (getMedia().length >= MAX_IMAGES) {
      alert("最多 10 张参考图。");
      return;
    }
    fileImg.click();
  });
  fileImg.onchange = async () => {
    const files = [...(fileImg.files || [])];
    fileImg.value = "";
    await uploadFiles(files);
  };

  function parseImageRef(item) {
    const raw = String(item?.image || "").replace(/\\/g, "/");
    const type = item?.type || "input";
    let filename = raw.split("/").pop() || raw;
    let subfolder = String(item?.subfolder || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!subfolder && raw.includes("/")) {
      const parts = raw.split("/").filter(Boolean);
      filename = parts.pop();
      subfolder = parts.join("/");
    }
    return { filename, subfolder, type };
  }

  function loadImageWidgetValue(item) {
    const { filename, subfolder, type } = parseImageRef(item);
    return `${subfolder ? subfolder + "/" : ""}${filename} [${type}]`;
  }

  function nodeImageSig(n) {
    const w = n?.widgets?.find((x) => x?.name === "image");
    if (w?.value) return String(w.value);
    if (n?.images?.[0]) return JSON.stringify(n.images[0]);
    return "";
  }

  function waitForNodeImgs(n, ms = 8000) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        if (n?.imgs?.length) return resolve(n.imgs);
        if (Date.now() - t0 > ms) return reject(new Error("图片预览加载超时"));
        setTimeout(tick, 120);
      };
      tick();
    });
  }

  function removeTempNode(n) {
    try {
      if (n && app.graph) app.graph.remove(n);
    } catch (_) {}
  }

  /** 调用 Comfy 原生遮罩编辑器，保存后写回工作台 */
  async function openNativeMaskEditor(item, idx) {
    const CA = getComfyApp();
    try {
      if (typeof CA?.open_maskeditor !== "function" || typeof CA?.copyToClipspace !== "function") {
        alert("当前前端没有原生遮罩编辑器入口。");
        return;
      }
      if (typeof LiteGraph === "undefined" || !LiteGraph.createNode) {
        alert("无法创建临时节点（LiteGraph 不可用）。");
        return;
      }

      const temp = LiteGraph.createNode("LoadImage");
      if (!temp) {
        alert("无法创建 LoadImage 临时节点。");
        return;
      }
      temp.title = "Lazy临时遮罩";
      temp.pos = [-12000, -12000];
      temp.size = [220, 80];
      temp.flags = temp.flags || {};
      temp.flags.collapsed = true;
      app.graph.add(temp);

      const imgW = temp.widgets?.find((w) => w?.name === "image");
      if (!imgW) {
        removeTempNode(temp);
        alert("临时节点缺少 image 控件。");
        return;
      }
      const widgetVal = loadImageWidgetValue(item);
      imgW.value = widgetVal;
      try {
        await imgW.callback?.(widgetVal, undefined, temp, undefined, undefined);
      } catch (_) {}
      // 强制塞预览图，保证原生编辑器能打开
      if (!temp.imgs?.length) {
        const im = new Image();
        im.crossOrigin = "anonymous";
        im.src = viewUrl(item);
        await new Promise((res, rej) => {
          im.onload = () => res();
          im.onerror = () => rej(new Error("原图加载失败"));
        });
        temp.imgs = [im];
        temp.images = [parseImageRef(item)];
      } else {
        await waitForNodeImgs(temp).catch(() => {});
      }

      const initialSig = nodeImageSig(temp);
      const prevReturn = CA.clipspace_return_node;
      CA.copyToClipspace(temp);
      CA.clipspace_return_node = temp;

      let done = false;
      const finish = async (saved) => {
        if (done) return;
        done = true;
        clearInterval(watcher);
        try {
          if (saved) await syncNativeMaskToWorkbench(temp, idx, item);
        } catch (err) {
          console.warn("[LazyMerge] 同步原生遮罩失败", err);
          alert("同步原生遮罩失败：" + (err?.message || err));
        } finally {
          if (CA.clipspace_return_node === temp) {
            CA.clipspace_return_node = prevReturn ?? null;
          }
          removeTempNode(temp);
          app.graph?.setDirtyCanvas?.(true, true);
        }
      };

      let attempts = 0;
      const watcher = setInterval(() => {
        attempts += 1;
        const sig = nodeImageSig(temp);
        if (sig && sig !== initialSig) {
          finish(true);
          return;
        }
        const stillThere =
          !!temp.graph ||
          (Array.isArray(app.graph?._nodes) && app.graph._nodes.includes(temp));
        if (attempts > 900 || !stillThere) {
          finish(false);
        }
      }, 400);

      CA.open_maskeditor();
    } catch (err) {
      console.warn("[LazyMerge] 打开原生遮罩失败", err);
      alert("打开原生遮罩失败：" + (err?.message || err));
    }
  }

  async function syncNativeMaskToWorkbench(tempNode, idx, origItem) {
    // 原生保存 painted-masked：遮罩在 alpha（刷过=低 alpha）
    let ref = tempNode.images?.[0];
    if (!ref) {
      const w = tempNode.widgets?.find((x) => x?.name === "image");
      const v = String(w?.value || "");
      const m = v.match(/^(.*?)(?:\s*\[(input|output|temp)\])?\s*$/i);
      if (!m || !m[1]) throw new Error("未拿到遮罩结果文件");
      const path = m[1].replace(/\\/g, "/");
      const parts = path.split("/").filter(Boolean);
      const filename = parts.pop();
      const subfolder = parts.join("/");
      ref = { filename, subfolder, type: (m[2] || "input").toLowerCase() };
    }

    const paintedUrl = viewUrl({
      image: ref.filename,
      subfolder: ref.subfolder || "",
      type: ref.type || "input",
    });

    // 用 fetch+bitmap 保留 alpha，避免 <img> 丢透明通道
    const resp = await fetch(paintedUrl);
    if (!resp.ok) throw new Error("读取遮罩结果图失败");
    const paintedBlob = await resp.blob();
    const bmp = await createImageBitmap(paintedBlob);

    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0);
    const id = ctx.getImageData(0, 0, c.width, c.height);

    const maskC = document.createElement("canvas");
    maskC.width = c.width;
    maskC.height = c.height;
    const mctx = maskC.getContext("2d");
    const md = mctx.createImageData(c.width, c.height);
    let paintedPx = 0;
    let minA = 255;
    for (let i = 0; i < id.data.length; i += 4) {
      const a = id.data[i + 3];
      if (a < minA) minA = a;
    }
    // 自适应阈值：有透明则按 alpha；否则退回亮度差
    const useAlpha = minA < 250;
    for (let i = 0; i < id.data.length; i += 4) {
      let on = false;
      if (useAlpha) {
        on = id.data[i + 3] < 200;
      } else {
        // 极端情况 alpha 丢失：用相对暗/亮差异不可靠，尽量不误判
        on = false;
      }
      const v = on ? 255 : 0;
      if (v) paintedPx++;
      md.data[i] = md.data[i + 1] = md.data[i + 2] = v;
      md.data[i + 3] = 255;
    }
    if (!paintedPx) {
      alert("未检测到遮罩笔触（请在原生编辑器画完后点保存）。");
      return;
    }
    mctx.putImageData(md, 0, 0);

    // 缩略图：原图 + 半透明红罩（仅预览，绝不进模型）
    const preview = document.createElement("canvas");
    preview.width = c.width;
    preview.height = c.height;
    const pctx = preview.getContext("2d");
    const baseImg = new Image();
    baseImg.crossOrigin = "anonymous";
    await new Promise((res) => {
      baseImg.onload = () => res();
      baseImg.onerror = () => res();
      baseImg.src = viewUrl(origItem);
    });
    if (baseImg.width) pctx.drawImage(baseImg, 0, 0, c.width, c.height);
    else pctx.drawImage(bmp, 0, 0);
    const overlay = document.createElement("canvas");
    overlay.width = c.width;
    overlay.height = c.height;
    const octx = overlay.getContext("2d");
    const od = octx.createImageData(c.width, c.height);
    for (let i = 0; i < md.data.length; i += 4) {
      if (md.data[i] > 20) {
        od.data[i] = 255;
        od.data[i + 1] = 64;
        od.data[i + 2] = 64;
        od.data[i + 3] = 120;
      }
    }
    octx.putImageData(od, 0, 0);
    pctx.drawImage(overlay, 0, 0);

    const blob = await new Promise((r) => maskC.toBlob(r, "image/png"));
    if (!blob) throw new Error("导出遮罩失败");
    const filename = `lazy_mask_${Date.now()}.png`;
    const form = new FormData();
    form.append("image", blob, filename);
    form.append("overwrite", "true");
    const res = await api.fetchApi("/upload/image", { method: "POST", body: form });
    if (!res.ok) throw new Error(`上传失败 HTTP ${res.status}`);
    const data = await res.json();

    const arr = getMedia();
    if (arr[idx]) {
      arr[idx].mask = data?.name || filename;
      arr[idx].maskType = "input";
      arr[idx].maskSubfolder = data?.subfolder || "";
      arr[idx].maskPreview = preview.toDataURL("image/png");
      // 确保原图路径不被原生编辑器结果覆盖
      if (!arr[idx].image) {
        arr[idx].image = origItem.image;
        arr[idx].type = origItem.type || "input";
        arr[idx].subfolder = origItem.subfolder || "";
      }
      setMedia(arr);
    }
    try {
      bmp.close?.();
    } catch (_) {}
  }
  ["dragenter", "dragover"].forEach((ev) => {
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.style.borderColor = "#6af";
    });
  });
  dropZone.addEventListener("dragleave", (e) => {
    e.preventDefault();
    dropZone.style.borderColor = "#555";
  });
  dropZone.addEventListener("drop", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.style.borderColor = "#555";
    const dt = e.dataTransfer;
    // 资产优先：侧栏拖图常同时带空 files + uri-list
    const refs = extractAssetRefs(dt || {});
    const files = [...(dt?.files || [])].filter(
      (f) => f?.type?.startsWith?.("image/") || /\.(png|jpe?g|webp|gif)$/i.test(f?.name || "")
    );
    if (refs.length) {
      let arr = getMedia();
      for (const ref of refs) {
        if (arr.length >= MAX_IMAGES) break;
        arr.push(ref);
      }
      setMedia(arr);
      return;
    }
    if (files.length) {
      await uploadFiles(files);
    }
  });

  const promptBox = document.createElement("div");
  promptBox.style.cssText =
    "width:100%;max-width:100%;min-width:0;box-sizing:border-box;border:1px solid #3d6b63;border-radius:8px;padding:8px;background:#1c3330;display:flex;flex-direction:column;overflow:hidden;flex-shrink:0;";
  const promptHead = document.createElement("div");
  promptHead.style.cssText =
    "font-weight:600;color:#d5ece8;margin-bottom:6px;flex-shrink:0;";
  promptHead.textContent = "③ 提示词";
  const promptArea = document.createElement("textarea");
  promptArea.placeholder = "";
  promptArea.spellcheck = false;
  promptArea.style.cssText =
    "flex:1;width:100%;min-height:72px;resize:none;box-sizing:border-box;background:#1a1a1a;color:#eee;border:1px solid #3d5c56;border-radius:4px;padding:6px;font-size:13px;";
  const optRow = document.createElement("div");
  optRow.style.cssText =
    "display:flex;gap:8px;align-items:center;margin-top:6px;flex-shrink:0;color:#cfe3df;";
  function numField(label, widget, fallback) {
    const wrap = document.createElement("label");
    wrap.style.cssText = "display:flex;align-items:center;gap:4px;";
    wrap.appendChild(document.createTextNode(label));
    const input = document.createElement("input");
    input.type = "number";
    input.value = String(widget?.value ?? fallback);
    input.style.cssText =
      "width:72px;background:#1a1a1a;color:#eee;border:1px solid #3d5c56;border-radius:4px;padding:2px 4px;";
    input.oninput = () => setVal(widget, Number(input.value || fallback));
    wrap.appendChild(input);
    return { wrap, input };
  }
  const startField = numField("起始索引", wStart, 0);
  const rowsField = numField("最大行数", wRows, 1000);
  const emptyWrap = document.createElement("label");
  emptyWrap.style.cssText = "display:flex;align-items:center;gap:4px;margin-left:auto;";
  emptyWrap.appendChild(document.createTextNode("去除空行"));
  const emptyInput = document.createElement("input");
  emptyInput.type = "checkbox";
  emptyInput.checked = Boolean(wEmpty?.value);
  emptyInput.onchange = () => setVal(wEmpty, emptyInput.checked);
  emptyWrap.appendChild(emptyInput);
  optRow.appendChild(startField.wrap);
  optRow.appendChild(rowsField.wrap);
  optRow.appendChild(emptyWrap);
  promptBox.appendChild(promptHead);
  promptBox.appendChild(promptArea);
  promptBox.appendChild(optRow);

  const applyPromptH = (h) => {
    heights.prompt = h;
    promptBox.style.height = h + "px";
    refreshDomSize();
  };
  promptArea.oninput = () => setVal(wText, promptArea.value);
  function renderPrompt() {
    promptArea.value = wText?.value || "";
    startField.input.value = String(wStart?.value ?? 0);
    rowsField.input.value = String(wRows?.value ?? 1000);
    emptyInput.checked = Boolean(wEmpty?.value);
  }

  root.appendChild(styleBox);
  root.appendChild(
    makeSplitter(
      () => heights.style,
      applyStyleH,
      () => saveHeights(heights)
    )
  );
  root.appendChild(imgBox);
  root.appendChild(
    makeSplitter(
      () => heights.img,
      applyImgH,
      () => saveHeights(heights)
    )
  );
  root.appendChild(promptBox);
  root.appendChild(
    makeSplitter(
      () => heights.prompt,
      applyPromptH,
      () => saveHeights(heights)
    )
  );
  root.appendChild(fileImg);

  domWidget = node.addDOMWidget("lazy_merge_wb", "div", root, {
    serialize: false,
  });
  bindDomWidgetWidthToNode(domWidget, node);
  if (domWidget) {
    domWidget.computeSize = () => [contentWidth(), Math.max(280, contentHeight())];
  }

  applyStyleH(heights.style);
  applyImgH(heights.img);
  applyPromptH(heights.prompt);

  node._lazyMergeWB = {
    refresh() {
      reloadStyles();
      renderMedia();
      renderPrompt();
      refreshDomSize();
    },
  };

  reloadStyles();
  renderMedia();
  renderPrompt();
  refreshDomSize();
}
