/**
 * Lazy H3 导演台：工作台模式快捷提示（分镜 / 多参）。
 * 完整时间线 UI 由 wan_director.js 挂载 LazyH3Director。
 */
import { app } from "../../scripts/app.js";

app.registerExtension({
  name: "Lazy.H3.Director.Workbench",
  async beforeRegisterNodeDef(nodeType, nodeData, appRef) {
    if (nodeData.name !== "LazyH3Director") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      try {
        const modeW = this.widgets?.find(
          (w) => w.name === "workspace_mode" || w.name === "工作台"
        );
        if (modeW) {
          const prev = modeW.callback;
          modeW.callback = (v) => {
            if (prev) prev.call(this, v);
            this.title =
              v === "多参" ? "Lazy MinimaxH3 导演台 · 多参" : "Lazy MinimaxH3 导演台 · 分镜";
          };
          // 初始化标题
          this.title =
            modeW.value === "多参"
              ? "Lazy MinimaxH3 导演台 · 多参"
              : "Lazy MinimaxH3 导演台 · 分镜";
        }
      } catch (e) {
        console.warn("[LazyH3] workbench hook:", e);
      }
      return r;
    };
  },
});
