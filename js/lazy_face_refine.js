/**
 * Lazy 二采修脸：控件错位纠错（按名称校验类型），不锁死用户设定。
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAME = "LazyFaceRefine";

const DEFAULTS = {
  启用: true,
  参考脸: false,
  身份阈值: 0.35,
  检测器: "DWPose",
  置信度: 0.35,
  裁切倍率: 2.5,
  画布宽: 768,
  画布高: 768,
  画布模式: "manual",
  步数: 8,
  重绘幅度: 0.55,
  采样器: "er_sde",
  调度器: "simple",
  小脸降噪倍率: 1.0,
  大脸降噪倍率: 0.3,
  贴回羽化: 6,
  贴回膨胀: 16,
  贴回混合: 1.0,
  选脸: "自动",
  位置平滑: 21,
  尺寸平滑: 51,
  平滑方式: "高斯",
  尺寸模式: "逐帧",
  脸大小模式: "相对本段",
  小脸像素: 70.0,
  大脸像素: 160.0,
  小脸偏向: 0.8,
  降噪平滑: 21,
  满修脸高: 80.0,
  强化保底: 0.45,
  快动起步: 0.05,
  快动满速: 0.20,
  快动保底: 0.30,
  贴回范围: "仅脸",
  贴回校色: 1.0,
  漏检处理: "淡出",
};

function findW(node, name) {
  return node.widgets?.find((w) => w.name === name);
}

function setW(node, name, value) {
  const w = findW(node, name);
  if (!w) return false;
  if (Array.isArray(w.options?.values) && w.options.values.length) {
    const ok = w.options.values.some((x) => String(x) === String(value));
    if (!ok && value !== w.value) return false;
  }
  const old = w.value;
  w.value = value;
  try {
    if (typeof w.callback === "function") w.callback(value);
  } catch (_) {}
  try {
    node.onWidgetChanged?.(name, value, old, w);
  } catch (_) {}
  return true;
}

function isMisaligned(node) {
  const det = findW(node, "检测器")?.value;
  const conf = findW(node, "置信度")?.value;
  const mode = findW(node, "画布模式")?.value;
  const steps = findW(node, "步数")?.value;
  const denoise = findW(node, "重绘幅度")?.value;
  const sampler = findW(node, "采样器")?.value;
  const feather = findW(node, "贴回羽化")?.value;
  const faceSel = findW(node, "选脸")?.value;
  const smoothM = findW(node, "平滑方式")?.value;
  const sizeM = findW(node, "尺寸模式")?.value;
  const faceM = findW(node, "脸大小模式")?.value;
  const pasteR = findW(node, "贴回范围")?.value;
  const missM = findW(node, "漏检处理")?.value;

  if (det === true || det === false || det === "启用" || det === "true" || det === "false") return true;
  if (typeof conf === "string" && String(conf).includes(".pt")) return true;
  if (mode != null && !["manual", "auto_no_downscale", "auto_capped_768"].includes(String(mode))) return true;
  if (typeof steps === "string" || Number(steps) > 40 || Number.isNaN(Number(steps))) return true;
  if (Number(denoise) > 1.0) return true;
  if (sampler != null && !["er_sde", "res_multistep", "euler", "dpmpp_2m"].includes(String(sampler))) return true;
  if (typeof feather === "number" && feather > 0 && feather < 1) return true;
  if (faceSel != null && !["自动", "左", "中间", "右"].includes(String(faceSel))) return true;
  if (smoothM != null && !["高斯", "保形", "均值"].includes(String(smoothM))) return true;
  if (sizeM != null && !["逐帧", "整段固定"].includes(String(sizeM))) return true;
  if (faceM != null && !["相对本段", "绝对像素"].includes(String(faceM))) return true;
  if (pasteR != null && !["仅脸", "椭圆脸", "整块裁切"].includes(String(pasteR))) return true;
  if (missM != null && !["淡出", "跳过", "仍贴回"].includes(String(missM))) return true;
  return false;
}

function resetAllDefaults(node) {
  const detW = findW(node, "检测器");
  let det = DEFAULTS.检测器;
  if (detW && Array.isArray(detW.options?.values) && detW.options.values.length) {
    const hit = detW.options.values.find((x) => String(x) === "DWPose")
      || detW.options.values.find((x) => String(x).includes("face_yolov8m"));
    if (hit != null) det = hit;
    else det = detW.options.values[0];
  }
  setW(node, "启用", DEFAULTS.启用);
  setW(node, "参考脸", DEFAULTS.参考脸);
  setW(node, "身份阈值", DEFAULTS.身份阈值);
  setW(node, "检测器", det);
  setW(node, "置信度", DEFAULTS.置信度);
  setW(node, "裁切倍率", DEFAULTS.裁切倍率);
  setW(node, "画布宽", DEFAULTS.画布宽);
  setW(node, "画布高", DEFAULTS.画布高);
  setW(node, "画布模式", DEFAULTS.画布模式);
  setW(node, "步数", DEFAULTS.步数);
  setW(node, "重绘幅度", DEFAULTS.重绘幅度);
  setW(node, "采样器", DEFAULTS.采样器);
  setW(node, "调度器", DEFAULTS.调度器);
  setW(node, "小脸降噪倍率", DEFAULTS.小脸降噪倍率);
  setW(node, "大脸降噪倍率", DEFAULTS.大脸降噪倍率);
  setW(node, "贴回羽化", DEFAULTS.贴回羽化);
  setW(node, "贴回膨胀", DEFAULTS.贴回膨胀);
  setW(node, "贴回混合", DEFAULTS.贴回混合);
  setW(node, "选脸", DEFAULTS.选脸);
  setW(node, "位置平滑", DEFAULTS.位置平滑);
  setW(node, "尺寸平滑", DEFAULTS.尺寸平滑);
  setW(node, "平滑方式", DEFAULTS.平滑方式);
  setW(node, "尺寸模式", DEFAULTS.尺寸模式);
  setW(node, "脸大小模式", DEFAULTS.脸大小模式);
  setW(node, "小脸像素", DEFAULTS.小脸像素);
  setW(node, "大脸像素", DEFAULTS.大脸像素);
  setW(node, "小脸偏向", DEFAULTS.小脸偏向);
  setW(node, "降噪平滑", DEFAULTS.降噪平滑);
  setW(node, "满修脸高", DEFAULTS.满修脸高);
  setW(node, "强化保底", DEFAULTS.强化保底);
  setW(node, "快动起步", DEFAULTS.快动起步);
  setW(node, "快动满速", DEFAULTS.快动满速);
  setW(node, "快动保底", DEFAULTS.快动保底);
  setW(node, "贴回范围", DEFAULTS.贴回范围);
  setW(node, "贴回校色", DEFAULTS.贴回校色);
  setW(node, "漏检处理", DEFAULTS.漏检处理);
  node.setDirtyCanvas?.(true, true);
  console.warn("[Lazy二采修脸] 检测到控件错位，已恢复推荐初始值（仍可手改并保存）");
}

function migrateRefFaceWidget(node) {
  const neu = findW(node, "参考脸");
  const old = findW(node, "只用参考脸");
  if (neu && old) {
    if (old.value === true) neu.value = true;
    try {
      old.hidden = true;
      old.computeSize = () => [0, -4];
    } catch (_) {}
  }
}

function sanitize(node) {
  if (!node || node.comfyClass !== NODE_NAME && node.type !== NODE_NAME) return;
  migrateRefFaceWidget(node);
  if (isMisaligned(node)) resetAllDefaults(node);
}

function previewHeight(node) {
  const wide = Math.max(160, (node.size?.[0] || 280) - 20);
  return Math.max(160, Math.min(280, Math.round(wide)));
}

function previewUrl(data) {
  const q = new URLSearchParams({
    filename: String(data.filename || ""),
    type: String(data.type || "temp"),
    subfolder: String(data.subfolder || ""),
    rand: String(Math.random()),
  });
  return api.apiURL(`/view?${q.toString()}`);
}

function showEmptyPreview(host) {
  if (!host) return;
  host.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "lazy-face-preview-empty";
  empty.textContent = "运行后显示跟踪的脸";
  empty.title = "跟踪到的脸部画面。";
  host.appendChild(empty);
}

function showFacePreview(node, data) {
  const host = node?.__lazyFacePreview;
  if (!host || !data?.filename) return;
  host.innerHTML = "";
  const img = document.createElement("img");
  img.className = "lazy-face-preview-img";
  img.alt = "跟踪脸";
  img.title = "跟踪到的脸部画面。";
  img.src = previewUrl(data);
  img.onload = () => {
    try {
      node.setDirtyCanvas?.(true, true);
    } catch (_) {}
  };
  img.onerror = () => showEmptyPreview(host);
  host.appendChild(img);
}

function installPreviewWidget(node) {
  if (!node || node.__lazyFacePreview) return;
  if (typeof node.addDOMWidget !== "function") return;

  const host = document.createElement("div");
  host.className = "lazy-face-preview-host";
  host.title = "跟踪到的脸部画面。";
  showEmptyPreview(host);

  const dw = node.addDOMWidget("lazy_face_preview", "div", host, {
    serialize: false,
    hideOnZoom: false,
  });
  if (dw) {
    dw.serialize = false;
    dw.serializeValue = () => undefined;
    dw.computeSize = () => {
      const h = previewHeight(node);
      host.style.height = `${h}px`;
      return [node.size ? node.size[0] : 280, h + 8];
    };
  }
  node.__lazyFacePreview = host;
  node.__lazyFacePreviewWidget = dw;
}

function findFaceNodes(nodeId) {
  const nodes = app.graph?._nodes || [];
  const isFace = (n) => n && (n.comfyClass === NODE_NAME || n.type === NODE_NAME);
  if (nodeId != null && String(nodeId) !== "") {
    const hit = nodes.find((n) => isFace(n) && String(n.id) === String(nodeId));
    if (hit) return [hit];
  }
  return nodes.filter(isFace);
}

function installPreviewStyles() {
  if (document.getElementById("lazy-face-preview-style")) return;
  const s = document.createElement("style");
  s.id = "lazy-face-preview-style";
  s.textContent = [
    ".lazy-face-preview-host{width:100%;box-sizing:border-box;overflow:hidden;",
    "  background:#111;border:1px solid #3a3a3a;border-radius:4px;}",
    ".lazy-face-preview-img{width:100%;height:100%;display:block;object-fit:contain;",
    "  background:#111;}",
    ".lazy-face-preview-empty{width:100%;height:100%;min-height:160px;display:flex;",
    "  align-items:center;justify-content:center;color:#888;font:12px/1.4 sans-serif;",
    "  background:#1a1a1a;text-align:center;padding:8px;box-sizing:border-box;}",
  ].join("");
  document.head.appendChild(s);
}

app.registerExtension({
  name: "Lazy.H3.FaceRefine.Sanitize",
  async setup() {
    installPreviewStyles();
    api.addEventListener("lazy_face_preview", (ev) => {
      let data = ev?.detail;
      if (Array.isArray(data)) data = data[0];
      if (!data || typeof data !== "object") return;
      for (const node of findFaceNodes(data.node_id)) {
        try {
          installPreviewWidget(node);
          showFacePreview(node, data);
          node.setDirtyCanvas?.(true, true);
        } catch (e) {
          console.warn("[Lazy二采修脸] 预览:", e);
        }
      }
    });
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      try {
        installPreviewStyles();
        installPreviewWidget(this);
      } catch (e) {
        console.warn("[Lazy二采修脸] 预览控件:", e);
      }
      requestAnimationFrame(() => {
        try {
          sanitize(this);
        } catch (e) {
          console.warn("[Lazy二采修脸] sanitize:", e);
        }
      });
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      try {
        installPreviewWidget(this);
      } catch (_) {}
      requestAnimationFrame(() => {
        try {
          sanitize(this);
        } catch (_) {}
      });
      return r;
    };
  },
});
