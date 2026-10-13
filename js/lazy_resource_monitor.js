/**
 * Lazy 资源监控浮层
 * 绿条为 Comfy 物理内存 / 显存；底部保留本机容量与 CPU/GPU；峰值；本次耗时；可最小化
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const STORAGE_KEY = "lazy_resource_monitor_minimized";
const POS_KEY = "lazy_resource_monitor_pos";

const CSS = `
#lazy-res-monitor {
  position: fixed;
  right: 14px;
  bottom: 14px;
  left: auto;
  top: auto;
  z-index: 99999;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: #e8e8e8;
  user-select: none;
  pointer-events: auto;
}
#lazy-res-monitor .lrm-panel {
  background: rgba(22, 24, 28, 0.92);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0,0,0,0.45);
  backdrop-filter: blur(10px);
  min-width: 300px;
  max-width: 360px;
  padding: 8px 10px 8px;
}
#lazy-res-monitor.minimized .lrm-panel {
  min-width: 0;
  max-width: none;
  width: auto;
  padding: 4px 8px;
}
#lazy-res-monitor .lrm-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
  cursor: move;
}
#lazy-res-monitor.minimized .lrm-head {
  margin-bottom: 0;
  gap: 6px;
  cursor: pointer;
}
#lazy-res-monitor .lrm-title {
  font-size: 11px;
  font-weight: 600;
  color: #cfd3dc;
  cursor: move;
}
#lazy-res-monitor.minimized .lrm-title {
  cursor: pointer;
}
#lazy-res-monitor .lrm-run {
  font-size: 11px;
  color: #9ad0ff;
  font-variant-numeric: tabular-nums;
}
#lazy-res-monitor .lrm-btn {
  width: 22px;
  height: 22px;
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 6px;
  background: rgba(255,255,255,0.06);
  color: #ddd;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  line-height: 1;
  padding: 0;
  flex-shrink: 0;
}
#lazy-res-monitor .lrm-btn:hover { background: rgba(255,255,255,0.14); }
#lazy-res-monitor .lrm-row {
  display: grid;
  grid-template-columns: 72px 1fr;
  gap: 6px;
  align-items: center;
  margin: 4px 0;
}
#lazy-res-monitor .lrm-label {
  font-size: 10px;
  color: #aab0bb;
  white-space: nowrap;
}
#lazy-res-monitor .lrm-bar-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
#lazy-res-monitor .lrm-bar {
  flex: 1;
  height: 8px;
  background: rgba(255,255,255,0.08);
  border-radius: 999px;
  overflow: hidden;
  min-width: 56px;
}
#lazy-res-monitor .lrm-bar > i {
  display: block;
  height: 100%;
  width: 0%;
  border-radius: 999px;
  transition: width 0.25s ease, background 0.2s ease;
  background: #3ecf6e;
}
#lazy-res-monitor .lrm-bar.ok > i { background: #3ecf6e; }
#lazy-res-monitor .lrm-bar.warn > i { background: #f0a030; }
#lazy-res-monitor .lrm-bar.danger > i { background: #e05050; }
#lazy-res-monitor .lrm-meta {
  font-size: 10px;
  color: #9aa3b2;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
/* 最小化：只留标题+还原按钮，进度条/页脚/按钮全部隐藏 */
#lazy-res-monitor.minimized .lrm-meta,
#lazy-res-monitor.minimized .lrm-run,
#lazy-res-monitor.minimized .lrm-row,
#lazy-res-monitor.minimized .lrm-expanded-only {
  display: none !important;
}
#lazy-res-monitor:not(.minimized) .lrm-mini-only {
  display: none !important;
}
#lazy-res-monitor .lrm-foot {
  margin-top: 6px;
  font-size: 10px;
  color: #7f8794;
  display: flex;
  flex-direction: column;
  gap: 2px;
  line-height: 1.35;
}
#lazy-res-monitor .lrm-foot span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#lazy-res-monitor .lrm-actions {
  margin-top: 6px;
  margin-bottom: 0;
  display: flex;
  gap: 6px;
}
#lazy-res-monitor .lrm-free-btn {
  flex: 1;
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 6px;
  background: rgba(90, 40, 40, 0.55);
  color: #f0d0d0;
  cursor: pointer;
  font-size: 11px;
  padding: 5px 8px;
  line-height: 1.2;
}
#lazy-res-monitor .lrm-free-btn:hover {
  background: rgba(140, 50, 50, 0.7);
  color: #fff;
}
#lazy-res-monitor .lrm-free-btn:disabled {
  opacity: 0.55;
  cursor: wait;
}
#lazy-res-monitor .lrm-free-msg {
  margin-top: 4px;
  margin-bottom: 0;
  font-size: 10px;
  color: #8fbc8f;
  line-height: 1.3;
}
/* 无文字时不占高度，避免按钮下大块空白 */
#lazy-res-monitor .lrm-free-msg:empty {
  display: none;
  margin: 0;
  min-height: 0;
}
#lazy-res-monitor.dragging { opacity: 0.92; }
`;

function levelClass(pct) {
  if (pct > 100) return "danger";
  if (pct >= 90) return "warn";
  return "ok";
}

function fmtTime(sec) {
  if (sec == null || sec < 0) return "—";
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec - m * 60);
  return `${m}m${String(s).padStart(2, "0")}s`;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function buildRow(label) {
  const row = el("div", "lrm-row");
  const lab = el("div", "lrm-label", label);
  lab.title = "当前占用、峰值与占比";
  const wrap = el("div", "lrm-bar-wrap");
  const bar = el("div", "lrm-bar ok");
  const fill = document.createElement("i");
  bar.appendChild(fill);
  const meta = el("div", "lrm-meta", "—");
  wrap.appendChild(bar);
  wrap.appendChild(meta);
  row.appendChild(lab);
  row.appendChild(wrap);
  return { row, bar, fill, meta };
}

function setRow(parts, percent, usedGb, peakGb, peakPct) {
  const pct = Math.max(0, Number(percent) || 0);
  parts.fill.style.width = `${Math.min(100, pct)}%`;
  parts.bar.className = `lrm-bar ${levelClass(pct)}`;
  const u = Number(usedGb) || 0;
  const p = Number(peakGb) || 0;
  const pp = Number(peakPct) || 0;
  parts.meta.textContent = `${u.toFixed(2)}G 峰值${p.toFixed(2)}G(${pp.toFixed(0)}%) ${pct.toFixed(0)}%`;
}

let root = null;
let minimized = false;
let runStart = null;
let runElapsedEl = null;
let runTimer = null;
let peaksLocal = { proc_ram: 0, proc_vram: 0 };

/** 贴屏幕右下角（right/bottom 锚定，展开向上长，不会出窗外） */
function snapBottomRight() {
  if (!root) return;
  root.style.left = "auto";
  root.style.top = "auto";
  root.style.right = "14px";
  root.style.bottom = "14px";
  try {
    localStorage.removeItem(POS_KEY);
  } catch (_) {}
}

function setMinimized(v, save = true) {
  minimized = !!v;
  if (root) {
    root.classList.toggle("minimized", minimized);
    // 最小/还原都贴右下角；先清 left/top 再锚定，避免向下撑出窗外
    snapBottomRight();
    requestAnimationFrame(() => snapBottomRight());
  }
  if (save) {
    try {
      localStorage.setItem(STORAGE_KEY, minimized ? "1" : "0");
    } catch (_) {}
  }
}

function loadPos() {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (typeof p?.left === "number" && typeof p?.top === "number") return p;
  } catch (_) {}
  return null;
}

function savePos(left, top) {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify({ left, top }));
  } catch (_) {}
}

function applyPos(left, top) {
  if (!root) return;
  const maxL = Math.max(0, window.innerWidth - root.offsetWidth - 4);
  const maxT = Math.max(0, window.innerHeight - root.offsetHeight - 4);
  left = Math.min(maxL, Math.max(0, left));
  top = Math.min(maxT, Math.max(0, top));
  root.style.left = `${left}px`;
  root.style.top = `${top}px`;
  root.style.right = "auto";
  root.style.bottom = "auto";
  savePos(left, top);
}

function enableDrag(handle) {
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let origL = 0;
  let origT = 0;
  let moved = false;

  const onDown = (e) => {
    if (e.button != null && e.button !== 0) return;
    // 最小化锁定右下角，不允许拖
    if (minimized) return;
    // 点到按钮不拖
    if (e.target?.closest?.(".lrm-btn")) return;
    dragging = true;
    moved = false;
    const rect = root.getBoundingClientRect();
    // 首次从 right/bottom 切到 left/top
    root.style.left = `${rect.left}px`;
    root.style.top = `${rect.top}px`;
    root.style.right = "auto";
    root.style.bottom = "auto";
    startX = e.clientX;
    startY = e.clientY;
    origL = rect.left;
    origT = rect.top;
    root.classList.add("dragging");
    e.preventDefault();
  };

  const onMove = (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
    applyPos(origL + dx, origT + dy);
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    root.classList.remove("dragging");
  };

  handle.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  // 防止拖完误触最小化
  handle.addEventListener("click", (e) => {
    if (moved) {
      e.stopPropagation();
      e.preventDefault();
      moved = false;
    }
  }, true);
}

function createUI() {
  if (document.getElementById("lazy-res-monitor")) return;

  const style = document.createElement("style");
  style.id = "lazy-res-monitor-style";
  style.textContent = CSS;
  document.head.appendChild(style);

  root = el("div");
  root.id = "lazy-res-monitor";

  const panel = el("div", "lrm-panel");
  const head = el("div", "lrm-head");
  const title = el("div", "lrm-title", "Lazy 资源");
  title.title = "按住拖动位置";
  runElapsedEl = el("div", "lrm-run lrm-expanded-only", "耗时 —");

  const btnMin = el("button", "lrm-btn lrm-expanded-only", "−");
  btnMin.title = "最小化";
  btnMin.addEventListener("click", (e) => {
    e.stopPropagation();
    setMinimized(true);
  });

  const btnMax = el("button", "lrm-btn lrm-mini-only", "▢");
  btnMax.title = "展开";
  btnMax.addEventListener("click", (e) => {
    e.stopPropagation();
    setMinimized(false);
  });

  // 最小化条：点标题也可还原
  title.addEventListener("click", (e) => {
    if (!minimized) return;
    e.stopPropagation();
    setMinimized(false);
  });
  head.addEventListener("dblclick", (e) => {
    if (e.target?.closest?.(".lrm-btn")) return;
    e.stopPropagation();
    setMinimized(!minimized);
  });

  const headRight = el("div");
  Object.assign(headRight.style, { display: "flex", alignItems: "center", gap: "6px" });
  headRight.appendChild(runElapsedEl);
  headRight.appendChild(btnMin);
  headRight.appendChild(btnMax);
  head.appendChild(title);
  head.appendChild(headRight);

  // 内存是整份 Comfy 正在占用的物理内存，不超过系统已用
  const rows = {
    proc_ram: buildRow("内存·Comfy"),
    proc_vram: buildRow("显存·Comfy"),
  };

  const foot = el("div", "lrm-foot lrm-expanded-only");
  foot.innerHTML =
    '<span id="lazy-res-memcap"></span><span id="lazy-res-cpu"></span><span id="lazy-res-gpu"></span>';

  // 底部：卸载内存与显存缓存
  const actions = el("div", "lrm-actions lrm-expanded-only");
  const freeBtn = el("button", "lrm-free-btn", "卸载内存与缓存");
  freeBtn.type = "button";
  freeBtn.title = "清理 Comfy 内存与缓存";
  freeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    freeMemoryCache(freeBtn);
  });
  actions.appendChild(freeBtn);
  const freeMsg = el("div", "lrm-free-msg lrm-expanded-only", "");
  freeMsg.id = "lazy-res-free-msg";

  panel.appendChild(head);
  panel.appendChild(rows.proc_ram.row);
  panel.appendChild(rows.proc_vram.row);
  panel.appendChild(foot);
  panel.appendChild(actions);
  panel.appendChild(freeMsg);
  root.appendChild(panel);
  document.body.appendChild(root);
  root._rows = rows;
  root._freeBtn = freeBtn;

  enableDrag(head);

  try {
    minimized = localStorage.getItem(STORAGE_KEY) === "1";
  } catch (_) {}
  setMinimized(minimized, false);

  // 启动：最小化强制右下角；展开可用上次拖动位置（仍会钳制在视口内）
  if (!minimized) {
    const pos = loadPos();
    if (pos) {
      requestAnimationFrame(() => applyPos(pos.left, pos.top));
    } else {
      requestAnimationFrame(() => snapBottomRight());
    }
  }

  // 窗口变化时：最小化保持右下角；展开用 left/top 时重新钳制
  window.addEventListener("resize", () => {
    if (!root) return;
    if (minimized) {
      snapBottomRight();
      return;
    }
    if (root.style.left && root.style.left !== "auto") {
      applyPos(parseFloat(root.style.left) || 0, parseFloat(root.style.top) || 0);
    }
  });
}

function applyStats(data) {
  if (!root?._rows) return;
  const r = root._rows;
  const sr = data.sys_ram || {};
  const pr = data.proc_ram || {};
  const sv = data.sys_vram || {};
  const pv = data.proc_vram || {};

  peaksLocal.proc_ram = Math.max(peaksLocal.proc_ram, pr.used_gb || 0, pr.peak_gb || 0);
  peaksLocal.proc_vram = Math.max(peaksLocal.proc_vram, pv.used_gb || 0, pv.peak_gb || 0);

  const ramTotal = Number(pr.total_gb || sr.total_gb) || 0;
  const vramTotal = Number(pv.total_gb || sv.total_gb) || 0;
  const prPct = ramTotal > 0 ? (Number(pr.used_gb) || 0) / ramTotal * 100 : (Number(pr.percent) || 0);
  const prPeakPct = ramTotal > 0 ? (peaksLocal.proc_ram / ramTotal) * 100 : 0;
  const pvPeakPct = vramTotal > 0 ? (peaksLocal.proc_vram / vramTotal) * 100 : 0;

  setRow(r.proc_ram, prPct, pr.used_gb, peaksLocal.proc_ram, prPeakPct);
  setRow(r.proc_vram, pv.percent, pv.used_gb, peaksLocal.proc_vram, pvPeakPct);

  // 底部：本机总容量（非进度条）
  const memEl = document.getElementById("lazy-res-memcap");
  if (memEl) {
    const sysRamTotal = Number(sr.total_gb) || Number(pr.total_gb) || 0;
    const sysVramTotal = Number(sv.total_gb) || Number(pv.total_gb) || 0;
    const sysRamUsed = Number(sr.used_gb) || 0;
    const sysVramUsed = Number(sv.used_gb) || 0;
    memEl.textContent = `系统内存 ${sysRamUsed.toFixed(1)}/${sysRamTotal.toFixed(1)}GB · 显存 ${sysVramUsed.toFixed(1)}/${sysVramTotal.toFixed(1)}GB`;
  }
  const cpuEl = document.getElementById("lazy-res-cpu");
  if (cpuEl) {
    const cpu = data.cpu_name ? String(data.cpu_name).trim() : "";
    cpuEl.textContent = cpu ? `CPU ${cpu}` : "";
    cpuEl.title = cpu;
  }
  const gpuEl = document.getElementById("lazy-res-gpu");
  if (gpuEl) {
    const g = data.gpu_name ? String(data.gpu_name).trim() : "";
    gpuEl.textContent = g ? `GPU ${g}` : "";
    gpuEl.title = g;
  }
}

async function fetchStats() {
  try {
    const res = await api.fetchApi("/lazy_wan_remix/resource_stats");
    const data = await res.json();
    if (data?.ok) applyStats(data);
  } catch (_) {}
}

async function freeMemoryCache(btn) {
  const msg = document.getElementById("lazy-res-free-msg");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "卸载中…";
  }
  if (msg) {
    msg.style.color = "#9aa3b2";
    msg.textContent = "清理 Comfy 中…";
  }

  // 与「资源统计」相同用 GET，避免部分环境 POST 405
  const tries = [
    { path: "/lazy_wan_remix/resource_free", method: "GET" },
    { path: "/lazy_resource_free", method: "GET" },
    { path: "/lazy_wan_remix/resource_free", method: "POST" },
  ];
  let lastErr = "";

  try {
    for (const t of tries) {
      try {
        const opt =
          t.method === "POST"
            ? {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}",
              }
            : { method: "GET" };
        const res = await api.fetchApi(t.path, opt);
        if (!res.ok) {
          lastErr = `HTTP ${res.status}`;
          continue;
        }
        let data = null;
        try {
          data = await res.json();
        } catch (_) {
          lastErr = "响应异常";
          continue;
        }
        if (data?.ok) {
          if (data.stats) applyStats(data.stats);
          // 稍等再刷，显存数字会掉下来
          setTimeout(() => {
            fetchStats();
          }, 400);
          await fetchStats();
          if (msg) {
            msg.style.color = "#8fbc8f";
            msg.textContent = "已清理 Comfy 内存与缓存";
          }
          return;
        }
        lastErr = data?.error || "清理失败";
      } catch (e) {
        lastErr = e?.message || String(e);
      }
    }

    if (msg) {
      msg.style.color = "#e08080";
      msg.textContent = lastErr
        ? `失败：${lastErr}（请完全重启 ComfyUI）`
        : "清理失败（请完全重启 ComfyUI）";
    }
    console.warn("[Lazy资源] 清理失败:", lastErr);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "卸载内存与缓存";
    }
  }
}

function tickRunTime() {
  if (!runElapsedEl) return;
  if (runStart == null) {
    runElapsedEl.textContent = "耗时 —";
    return;
  }
  runElapsedEl.textContent = `耗时 ${fmtTime((performance.now() - runStart) / 1000)}`;
}

function onExecutionStart() {
  runStart = performance.now();
  peaksLocal = { proc_ram: 0, proc_vram: 0 };
  try {
    api.fetchApi("/lazy_wan_remix/resource_peaks_reset", { method: "POST" });
  } catch (_) {}
  tickRunTime();
  if (runTimer) clearInterval(runTimer);
  runTimer = setInterval(tickRunTime, 200);
}

function onExecutionEnd() {
  tickRunTime();
  if (runTimer) {
    clearInterval(runTimer);
    runTimer = null;
  }
}

app.registerExtension({
  name: "Lazy.ResourceMonitor",
  async setup() {
    const start = () => {
      createUI();
      api.addEventListener("execution_start", onExecutionStart);
      api.addEventListener("execution_success", onExecutionEnd);
      api.addEventListener("execution_error", onExecutionEnd);
      api.addEventListener("execution_interrupted", onExecutionEnd);
      fetchStats();
      setInterval(fetchStats, 1000);
    };
    if (document.body) start();
    else document.addEventListener("DOMContentLoaded", start);
  },
  // 图加载后也再触发一次后端路由确认（依赖后端 import 时 ensure）
  async afterConfigureGraph() {
    try {
      await fetchStats();
    } catch (_) {}
  },
});
