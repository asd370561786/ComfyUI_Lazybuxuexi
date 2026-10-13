import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

function fitHeight(node) {
  try {
    node.setSize([node.size[0], node.computeSize([node.size[0], node.size[1]])[1]]);
  } catch (_) {
    node.size[1] = node.computeSize()[1];
  }
  node?.graph?.setDirtyCanvas(true);
}

function forwardCanvas(el) {
  const pass = (type, handler) => {
    el.addEventListener(type, (e) => {
      e.preventDefault();
      const fn = app.canvas?.[handler];
      if (typeof fn === "function") fn.call(app.canvas, e);
    }, true);
  };
  pass("contextmenu", "_mousedown_callback");
  pass("pointerdown", "_mousedown_callback");
  pass("pointermove", "_mousemove_callback");
  pass("pointerup", "_mouseup_callback");
  pass("mousewheel", "_mousewheel_callback");
  pass("wheel", "_mousewheel_callback");
}

app.registerExtension({
  name: "Lazy.VideoSave",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "LazyVideoSave") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    const onExecuted = nodeType.prototype.onExecuted;

    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      const node = this;
      const el = document.createElement("div");
      el.style.width = "100%";
      const widget = this.addDOMWidget("videopreview", "preview", el, { serialize: false });
      widget.computeSize = function (width) {
        if (this.aspectRatio && this.videoEl && !this.videoEl.hidden) {
          const h = (node.size[0] - 20) / this.aspectRatio + 10;
          return [width, Math.max(0, h)];
        }
        return [width, 0];
      };
      const video = document.createElement("video");
      video.controls = false;
      video.loop = true;
      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;
      video.style.width = "100%";
      video.style.display = "block";
      video.hidden = true;
      video.addEventListener("loadedmetadata", () => {
        if (video.videoWidth && video.videoHeight) {
          widget.aspectRatio = video.videoWidth / video.videoHeight;
          video.hidden = false;
          fitHeight(node);
        }
      });
      video.addEventListener("error", () => {
        video.hidden = true;
        fitHeight(node);
      });
      video.addEventListener("mouseenter", () => {
        video.muted = false;
      });
      video.addEventListener("mouseleave", () => {
        video.muted = true;
      });
      el.appendChild(video);
      forwardCanvas(el);
      widget.videoEl = video;
      this._lazyPreview = widget;
      return r;
    };

    nodeType.prototype.onExecuted = function (message) {
      if (onExecuted) onExecuted.apply(this, arguments);
      const g = message?.gifs?.[0];
      const widget = this._lazyPreview;
      if (!g?.filename || !widget?.videoEl) return;
      const params = {
        filename: g.filename,
        subfolder: g.subfolder || "",
        type: g.type || "output",
        format: g.format || "video/mp4",
        timestamp: Date.now(),
      };
      widget.videoEl.hidden = false;
      widget.videoEl.src = api.apiURL("/view?" + new URLSearchParams(params));
      widget.videoEl.play?.().catch(() => {});
    };
  },
});
