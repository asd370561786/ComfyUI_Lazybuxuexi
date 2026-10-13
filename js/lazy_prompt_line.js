/**
 * Lazy 提示词：青绿样式，可从已连接的 COMBO 取选项。
 */
import { app } from "../../scripts/app.js";

const NODE_NAME = "LazyPromptLine";

function paint(node) {
  node.color = "#008181";
  node.bgcolor = "#1c3330";
}

app.registerExtension({
  name: "Lazy.PromptLine",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;
    const onAdded = nodeType.prototype.onAdded;
    nodeType.prototype.onAdded = function () {
      const ret = onAdded ? onAdded.apply(this, arguments) : undefined;
      paint(this);
      if (this.widgets?.some((w) => w?.name === "从COMBO取值")) return ret;
      const promptWidget = this.widgets?.find((w) => w?.name === "提示词");
      if (promptWidget && !promptWidget.value) promptWidget.value = "";
      this.addWidget(
        "button",
        "从COMBO取值",
        "",
        () => {
          const outputLink = this.outputs?.[1]?.links?.length
            ? this.outputs[1].links[0]
            : null;
          const target = app.graph?._nodes?.find((n) =>
            n.inputs?.some((input) => input.link === outputLink)
          );
          if (!outputLink || !target) return;
          const input = target.inputs.find((item) => item.link === outputLink);
          const widgetName = input?.widget?.name;
          const widget = target.widgets?.find((item) => item?.name === widgetName);
          let values = widget?.options?.values || null;
          if (typeof values === "function") {
            try {
              values = values();
            } catch (_) {
              values = null;
            }
          }
          if (Array.isArray(values) && promptWidget) {
            promptWidget.value = values.join("\n");
          }
        },
        { serialize: false }
      );
      return ret;
    };
  },
  nodeCreated(node) {
    if (node.comfyClass === NODE_NAME) paint(node);
  },
});
