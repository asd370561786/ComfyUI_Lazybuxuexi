/**
 * Lazy H3 逐段生成
 * 1) 加速开关：只改推荐默认（步数/调度偏移），不锁死；音频偏移不自动改
 * 2) 旧工作流控件错位时，按名称校验并回正脏值
 */
import { app } from "../../scripts/app.js";

function findW(node, names) {
  const list = Array.isArray(names) ? names : [names];
  return node.widgets?.find((w) => list.includes(w.name));
}

function setWidget(node, names, value) {
  const w = findW(node, names);
  if (!w) return false;
  // COMBO：非法值不写
  if (Array.isArray(w.options?.values) && w.options.values.length) {
    if (!w.options.values.includes(value) && value !== w.value) {
      // 允许 number/string 宽松匹配
      const ok = w.options.values.some((x) => String(x) === String(value));
      if (!ok) return false;
    }
  }
  const old = w.value;
  w.value = value;
  try {
    if (typeof w.callback === "function") w.callback(value);
  } catch (_) {}
  try {
    node.onWidgetChanged?.(w.name, value, old, w);
  } catch (_) {}
  node.setDirtyCanvas?.(true, true);
  return true;
}

/** 纠正旧图错位导致的脏默认 */
function sanitizeH3SequentialWidgets(node) {
  const accel = !!findW(node, ["加速模式", "accel_mode"])?.value;

  // 参考图精度：只能是 max/match
  const refW = findW(node, ["参考图精度", "ref_image_size"]);
  if (refW) {
    const v = String(refW.value ?? "");
    if (v !== "max" && v !== "match") {
      setWidget(node, ["参考图精度", "ref_image_size"], "max");
    }
  }

  // 视频偏移
  const sv = findW(node, ["视频偏移", "shift_video"]);
  if (sv != null && (Number(sv.value) < 0.5 || Number.isNaN(Number(sv.value)))) {
    setWidget(node, ["视频偏移", "shift_video"], 12);
  }

  // 音频偏移：脏值回标准默认，不跟加速开关联动
  const sa = findW(node, ["音频偏移", "shift_audio"]);
  if (sa != null && (Number(sa.value) < 0.5 || Number.isNaN(Number(sa.value)))) {
    setWidget(node, ["音频偏移", "shift_audio"], 3);
  }

  // 加速 LoRA：不能是纯数字（错位成偏移）
  const loraW = findW(node, ["加速LoRA", "accel_lora"]);
  if (loraW != null) {
    const lv = String(loraW.value ?? "");
    if (lv && lv !== "none" && !Number.isNaN(Number(lv)) && String(Number(lv)) === lv) {
      setWidget(node, ["加速LoRA", "accel_lora"], "none");
    }
  }

  // 加速强度：应在 -99～99
  const stW = findW(node, ["加速LoRA强度", "accel_lora_strength"]);
  if (stW != null) {
    const st = Number(stW.value);
    if (Number.isNaN(st) || Math.abs(st) > 99) {
      setWidget(node, ["加速LoRA强度", "accel_lora_strength"], 0.75);
    }
  }

  // 调度偏移：加速建议开
  if (accel) {
    const sh = findW(node, ["启用调度偏移", "apply_sigma_shift"]);
    if (sh && !sh.value) setWidget(node, ["启用调度偏移", "apply_sigma_shift"], true);
  }

  // 续接长度：仅允许 5/22/39/56（INT，兼容旧 COMBO 字符串）
  const mcLen = findW(node, ["续接长度", "context_length", "motion_context_length"]);
  if (mcLen) {
    const allowed = [22, 5, 39, 56];
    let n = Number(mcLen.value);
    if (Number.isNaN(n)) n = 22;
    if (!allowed.includes(n)) {
      n = allowed.reduce((best, x) => (Math.abs(x - n) < Math.abs(best - n) ? x : best), 22);
      setWidget(node, ["续接长度", "context_length", "motion_context_length"], n);
    } else if (mcLen.value !== n) {
      setWidget(node, ["续接长度", "context_length", "motion_context_length"], n);
    }
  }
}

function applyAccelDefaults(node, on) {
  setWidget(node, ["步数", "steps"], on ? 8 : 20);
  setWidget(node, ["视频偏移", "shift_video"], 12);
  if (on) setWidget(node, ["启用调度偏移", "apply_sigma_shift"], true);
}

app.registerExtension({
  name: "Lazy.H3.Sequential.AccelDefaults",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "LazyH3SequentialGenerate") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      try {
        const accelW = findW(this, ["加速模式", "accel_mode", "use_accel"]);
        if (accelW) {
          const prev = accelW.callback;
          accelW.callback = (v) => {
            if (prev) prev.call(this, v);
            applyAccelDefaults(this, !!v);
          };
        }
        // 加载后稍晚纠错（等 widget 值写完）
        requestAnimationFrame(() => {
          try {
            sanitizeH3SequentialWidgets(this);
          } catch (e) {
            console.warn("[LazyH3] sanitize widgets:", e);
          }
        });
      } catch (e) {
        console.warn("[LazyH3] accel defaults hook:", e);
      }
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      requestAnimationFrame(() => {
        try {
          sanitizeH3SequentialWidgets(this);
        } catch (_) {}
      });
      return r;
    };
  },
});
