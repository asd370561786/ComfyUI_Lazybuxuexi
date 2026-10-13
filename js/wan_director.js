const { app } = window.comfyAPI.app;
const { api } = window.comfyAPI.api;
import { calculatePlaybackDurationFrames, calculateSegmentRange, calculateTimelineDurationFrames, pullSegmentsAfterShrink, pushOverlappingSegmentsForward, shouldAutoSyncDuration, splitSegmentTailAfterShrink } from "./timeline_duration.js";
import { clampSegmentLengthToSource } from "./director_video_segments.js";

// --- UI Constants & Configuration ---
const RULER_HEIGHT = 24;
const BLOCK_HEIGHT = 200; // 主轨高度（音频/参考视频轨已移除）
const AUDIO_TRACK_HEIGHT = 0; // 已移除音频轨
const MOTION_TRACK_HEIGHT = 0; // 已移除参考视频轨
const CANVAS_HEIGHT = RULER_HEIGHT + BLOCK_HEIGHT + MOTION_TRACK_HEIGHT + AUDIO_TRACK_HEIGHT;
const DISABLE_AUDIO_MOTION_UI = true; // 产品层关闭音频/参考视频
const HANDLE_HIT_PX = 14;
const MIN_SEGMENT_LENGTH = 6;
const MAX_THUMBNAIL_DIM = 512; // Increased to maintain quality for taller images

const HIDDEN_WIDGET_NAMES = ["timeline_data", "local_prompts", "segment_lengths", "transition_smoothness", "guide_strength", "audio_data", "use_custom_audio", "inpaint_audio", "use_custom_motion", "override_audio", "use_ic_video_size"];
const SETTINGS_WIDGETS_VISIBLE_PROPERTY = "wanRemixSettingsWidgetsVisible";
const GLOBAL_PROMPT_VISIBLE_PROPERTY = "wanRemixGlobalPromptVisible";

function hideWidget(w) {
  if (!w) return;

  w.hidden = true;
  if (!w.options) w.options = {};
  w.options.hidden = true;

  // Use computeSize and draw overrides to safely collapse in LiteGraph 
  // without triggering ComfyUI's "convert to input slot" auto-behavior.
  if (!window.LiteGraph || !window.LiteGraph.vueNodesMode) {
    w.computeSize = () => [0, -4]; // -4 cancels out ComfyUI's hardcoded 4px widget padding
    if (!w._hiddenDrawHooked) {
      w._origDraw = w.hasOwnProperty('draw') ? w.draw : undefined;
      w._hiddenDrawHooked = true;
    }
    w.draw = () => { };
  }

  if (w.element) w.element.style.display = "none";
  if (w.callback) w.callback(w.value);
}

function showWidget(w) {
  if (!w) return;

  w.hidden = false;
  if (w.options) w.options.hidden = false;

  if (!window.LiteGraph || !window.LiteGraph.vueNodesMode) {
    delete w.computeSize;
    if (w._hiddenDrawHooked) {
      if (w._origDraw !== undefined) {
        w.draw = w._origDraw;
      } else {
        delete w.draw;
      }
      delete w._hiddenDrawHooked;
    }
  }

  if (w.element) w.element.style.display = "";
  if (w.callback) w.callback(w.value);
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// --- Modern Dark/Grey UI CSS (ComfyUI Match) ---
const STYLES = `
  .pr-wrapper {
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
    height: 100%;
    box-sizing: border-box;
    padding-bottom: 4px;
  }
  .pr-wrapper.drag-active {
    outline: 2px dashed #888;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 6px;
  }
  .pr-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 2px 0px;
    flex-wrap: nowrap;
    gap: 6px;
    position: relative;
    min-height: 36px;
    width: 100%;
    box-sizing: border-box;
  }
  .pr-actions {
    display: flex;
    gap: 6px;
    flex-wrap: nowrap;
    align-items: center;
    z-index: 2;
  }
  .pr-btn {
    background: #222;
    color: #e0e0e0;
    border: 1px solid #111;
    border-radius: 4px;
    padding: 6px 12px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    transition: all 0.2s ease;
  }
  .pr-btn:hover:not(:disabled) {
    background: #333;
    border-color: #555;
  }
  .pr-btn.toggle-on {
    background: #1c222d;
    border-color: #283142;
    color: #e0e0e0;
  }
  .pr-btn.toggle-on:hover:not(:disabled) {
    background: #2a3445;
    border-color: #3b4b66;
  }
  .pr-btn-danger:hover:not(:disabled) {
    background: #4a1515;
    border-color: #cc4444;
    color: #ffaaaa;
  }
  /* 分镜/多参：与「添加图片」同排同尺寸，横排 */
  .pr-btn-mode.active {
    background: #3d3d3d !important;
    border-color: #777 !important;
    color: #fff !important;
    font-weight: 600;
  }
  .pr-btn-mode:not(.active) {
    opacity: 0.85;
  }
  .pr-btn-mode.active:hover:not(:disabled) {
    background: #4a4a4a !important;
    border-color: #999 !important;
  }
  .pr-canvas {
    background: #2a2a2a;
    cursor: default;
    width: 100%;
    outline: none;
    display: block; /* Ensure no inline baseline gaps */
  }
  .pr-prop-container {
    display: flex;
    flex-direction: column;
    width: 100%;
    flex-grow: 0;
    flex-shrink: 0;
    min-height: 40px;
    max-width: 100%;
    overflow: hidden;
    box-sizing: border-box;
  }
  .pr-prompt-wrapper {
    position: relative;
    width: 100%;
    height: 100%;
    max-width: 100%;
    background: #222;
    border: 1px solid #111;
    border-radius: 6px;
    box-sizing: border-box;
    transition: border-color 0.2s ease, opacity 0.2s ease;
    overflow: hidden;
  }
  .pr-prompt-wrapper.focus-active {
    border-color: #888;
  }
  .pr-wrapper.has-focus .pr-prompt-wrapper:not(.focus-active),
  .pr-wrapper:has(.pr-prompt-wrapper.focus-active) .pr-prompt-wrapper:not(.focus-active) {
    opacity: 0.65;
  }
  .pr-prompt-label {
    position: absolute;
    top: 5px;
    left: 8px;
    font-size: 9px;
    font-weight: bold;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    pointer-events: none;
    user-select: none;
    z-index: 5;
  }
  .pr-prompt-area {
    position: absolute;
    top: 20px;
    left: 0;
    width: 100%;
    height: calc(100% - 20px);
    background: transparent;
    color: #e0e0e0;
    border: none;
    padding: 0 8px 8px 8px;
    resize: none; /* Removed the manual resize corner handle */
    font-size: 12px;
    line-height: 1.4;
    box-sizing: border-box;
    outline: none;
  }
  .pr-prompt-area:focus {
    border-color: #888;
  }
  .pr-motion-info {
    width: 100%;
    height: 100%;
    background: #181818;
    color: #aaa;
    border: 1px solid #111;
    border-radius: 6px;
    padding: 10px;
    font-size: 12px;
    line-height: 1.6;
    box-sizing: border-box;
    display: none;
  }
  .pr-motion-info span { color: #fff; font-weight: 500; }
  .pr-audio-info {
    width: 100%;
    height: 100%;
    background: #181818;
    color: #aaa;
    border: 1px solid #111;
    border-radius: 6px;
    padding: 10px;
    font-size: 12px;
    line-height: 1.6;
    box-sizing: border-box;
    display: none;
  }
  .pr-audio-info span { color: #fff; font-weight: 500; }
  .pr-controls-group {
    background: #1e1e1e;
    border: 1px solid #333;
    border-radius: 6px;
    padding: 6px 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 4px;
    box-sizing: border-box;
    width: 100%;
  }
  .pr-strength-row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    box-sizing: border-box;
  }
  .pr-height-resizer {
    height: 6px;
    background: #2a2a2a;
    cursor: ns-resize;
    border-radius: 3px;
    margin: 2px 0;
    transition: background 0.15s;
    border: 1px solid #1e1e1e;
  }
  .pr-height-resizer:hover {
    background: #444;
    border-color: #555;
  }
  .pr-strength-label {
    font-size: 11px;
    font-weight: 600;
    color: #fff;
    white-space: nowrap;
    margin-left: auto;
    user-select: none;
    -webkit-user-select: none;
  }
  .pr-strength-slider {
    -webkit-appearance: none;
    appearance: none;
    width: 80px;
    height: 4px;
    background: #444;
    border-radius: 2px;
    outline: none;
    cursor: pointer;
    border: 1px solid #222;
  }
  .pr-strength-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #aaa;
    cursor: pointer;
  }
  .pr-strength-slider:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }
  .pr-strength-input {
    font-size: 12px;
    color: #fff;
    background: #222;
    border: 1px solid #444;
    border-radius: 4px;
    width: 52px;
    text-align: center;
    padding: 3px;
    user-select: none;
    -webkit-user-select: none;
  }
  .pr-strength-input::-webkit-outer-spin-button,
  .pr-strength-input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  .pr-strength-input[type=number] {
    -moz-appearance: textfield;
  }
  .pr-strength-input:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
  .pr-gap-menu {
    position: fixed;
    background: #1e1e1e;
    border: 1px solid #444;
    border-radius: 6px;
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    z-index: 9999;
    box-shadow: 0 4px 16px rgba(0,0,0,0.6);
    max-height: calc(100vh - 16px);
    overflow-y: auto;
    scrollbar-width: thin;
  }
  .pr-gap-menu-btn {
    background: #2a2a2a;
    color: #e0e0e0;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 6px 14px;
    font-size: 11px;
    font-family: inherit;
    cursor: pointer;
    text-align: left;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 6px;
    transition: background 0.15s ease;
  }
  .pr-gap-menu-btn:hover {
    background: #3a3a3a;
    border-color: #666;
  }
  .pr-player-controls {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 12px;
    padding: 2px 0;
    flex-wrap: wrap;
    width: 100%;
  }
  .pr-icon-btn {
    background: #2a2a2a;
    border: 1px solid #444;
    color: #eee;
    cursor: pointer;
    padding: 6px 12px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
  }
  .pr-icon-btn * {
    pointer-events: none;
  }
  .pr-icon-btn:hover {
    color: #fff;
    background: #3a3a3a;
    border-color: #666;
  }
  .pr-icon-btn.active {
    color: #4fff8f;
    border-color: #4fff8f;
    background: #1a3a2a;
  }
  .pr-seek-bar {
    -webkit-appearance: none;
    appearance: none;
    height: 6px;
    background: #444;
    border-radius: 3px;
    outline: none;
    cursor: pointer;
    border: 1px solid #222;
  }
  .pr-seek-bar::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #ff4444;
    cursor: pointer;
    border: 2px solid #222;
  }
  .pr-timeline-viewport {
    position: relative;
    width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    padding-bottom: 10px;
    box-sizing: content-box;
  }
  .pr-timeline-viewport::-webkit-scrollbar {
    height: 10px;
  }
  .pr-timeline-viewport::-webkit-scrollbar-track {
    background: #151515;
    border-radius: 5px;
  }
  .pr-timeline-viewport::-webkit-scrollbar-thumb {
    background: #444;
    border-radius: 5px;
    border: 1px solid #000;
  }
  .pr-timeline-viewport::-webkit-scrollbar-thumb:hover {
    background: #666;
    border-color: #000;
  }
  .pr-zoom-controls {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-left: 12px;
  }
  .pr-zoom-slider {
    width: 80px;
    -webkit-appearance: none;
    appearance: none;
    height: 4px;
    background: #444;
    border-radius: 2px;
    outline: none;
    cursor: pointer;
  }
  .pr-zoom-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #aaa;
    cursor: pointer;
  }
  .pr-right-group {
    display: flex;
    align-items: center;
    gap: 12px;
    z-index: 2;
  }
  .pr-segment-bounds {
    font-size: 12px;
    color: #aaa;
    font-family: monospace;
    user-select: none;
    -webkit-user-select: none;
  }
  .pr-timecode {
    font-size: 14px;
    font-weight: bold;
    color: #e0e0e0;
    font-family: monospace;
    user-select: none;
    -webkit-user-select: none;
  }
  .pr-settings-menu {
    position: fixed;
    background: #1e1e1e;
    border: 1px solid #444;
    border-radius: 6px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 9999;
    box-shadow: 0 4px 20px rgba(0,0,0,0.7);
    min-width: 250px;
  }
  .pr-settings-title {
    font-size: 11px;
    font-weight: 600;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding-bottom: 4px;
    border-bottom: 1px solid #333;
    margin-bottom: 2px;
  }
  .pr-settings-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .pr-settings-label {
    font-size: 12px;
    color: #bbb;
    flex: 1;
    white-space: nowrap;
  }
  .pr-number-control {
    display: flex;
    align-items: center;
    border: 1px solid #444;
    border-radius: 4px;
    background: #2a2a2a;
    overflow: hidden;
  }
  .pr-number-btn {
    background: #333;
    color: #aaa;
    border: none;
    width: 20px;
    height: 22px;
    cursor: pointer;
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s;
    user-select: none;
  }
  .pr-number-btn:hover {
    background: #444;
    color: #fff;
  }
  .pr-settings-input {
    background: transparent;
    color: #e0e0e0;
    border: none;
    padding: 0 4px;
    font-size: 12px;
    width: 50px;
    height: 22px;
    text-align: center;
    font-family: monospace;
    outline: none;
    -moz-appearance: textfield;
  }
  .pr-settings-input::-webkit-outer-spin-button,
  .pr-settings-input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  .pr-settings-select {
    background: #2a2a2a;
    color: #e0e0e0;
    border: 1px solid #444;
    border-radius: 4px;
    padding: 3px 4px;
    font-size: 12px;
    width: 98px;
    cursor: pointer;
  }
  .pr-settings-divider {
    border: none;
    border-top: 1px solid #2a2a2a;
    margin: 2px 0;
  }
  .pr-settings-toggle-btn {
    width: 100%;
    box-sizing: border-box;
    margin: 0;
    background: #252525;
    color: #fff;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 5px 8px;
    font-size: 11px;
    cursor: pointer;
    text-align: center;
    transition: all 0.15s;
  }
  .pr-settings-toggle-btn:hover {
    background: #2e2e2e;
    color: #fff;
    border-color: #555;
  }
  .pr-settings-close-btn {
    background: transparent;
    color: #888;
    border: none;
    cursor: pointer;
    padding: 2px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    transition: all 0.15s;
  }
  .pr-settings-close-btn:hover {
    color: #fff;
    background: rgba(255,255,255,0.1);
  }
  .pr-segmented-control {
    display: flex;
    background: #1e1e1e;
    border: 1px solid #333;
    border-radius: 6px;
    padding: 2px;
    width: 110px;
    height: 25px;
    align-items: center;
    box-sizing: border-box;
  }
  .pr-segment {
    flex: 1;
    text-align: center;
    font-size: 10px;
    font-weight: 500;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    cursor: pointer;
    border-radius: 4px;
    color: #888;
    transition: all 0.15s ease;
  }
  .pr-segment.active {
    background: #333;
    color: #fff;
  }
  .pr-settings-divider {
    border-top: 1px solid #333;
    margin: 4px 0;
  }
`;

let styleEl = document.getElementById("prompt-relay-styles");
if (!styleEl) {
  styleEl = document.createElement("style");
  styleEl.id = "prompt-relay-styles";
  document.head.appendChild(styleEl);
}
styleEl.textContent = STYLES;

// --- Icons ---
const ICONS = {
  upload: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>`,
  audio: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`,
  motion: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>`,
  trash: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`,
  text: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"></polyline><line x1="9" y1="20" x2="15" y2="20"></line><line x1="12" y1="4" x2="12" y2="20"></line></svg>`,
  play: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`,
  pause: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`,
  loop: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12A9 9 0 0 0 6 5.3L3 8"></path><polyline points="3 3 3 8 8 8"></polyline><path d="M3 12a9 9 0 0 0 15 6.7l3-2.7"></path><polyline points="21 21 21 16 16 16"></polyline></svg>`,
  minus: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg>`,
  plus: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`,
  fit: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="21" y2="12"></line><polyline points="8 7 3 12 8 17"></polyline><polyline points="16 7 21 12 16 17"></polyline></svg>`,
  gear: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`,
  close: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
  start: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 3H13.5a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1" /></svg>`,
  end: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1" /></svg>`,
  mark: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 3H7.5a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1" /><path d="M15.5 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1" /></svg>`,
  help: `<svg width="14" height="14" viewBox="-5 -5 38 38" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M10.398,22.811h4.618v4.964h-4.618V22.811z M21.058,1.594C19.854,0.532,17.612,0,14.33,0c-3.711,0-6.205,0.514-7.482,1.543 c-1.277,1.027-1.916,3.027-1.916,6L4.911,8.551h4.577l-0.02-1.049c0-1.424,0.303-2.377,0.907-2.854 c0.604-0.477,1.814-0.717,3.632-0.717c1.936,0,3.184,0.228,3.74,0.676c0.559,0.451,0.837,1.457,0.837,3.017 c0,1.883-0.745,3.133-2.237,3.752l-1.797,0.766c-1.882,0.781-3.044,1.538-3.489,2.27c-0.442,0.732-0.665,2.242-0.665,4.529h4.68 v-0.646c0-1.41,0.987-2.533,2.965-3.365c2.03-0.861,3.343-1.746,3.935-2.651c0.592-0.908,0.888-2.498,0.888-4.771 C22.863,4.625,22.261,2.655,21.058,1.594z"/></svg>`,
  magnet: `<svg width="15" height="15" viewBox="-30 -55 580 580" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path stroke="currentColor" stroke-width="15" stroke-linejoin="round" stroke-linecap="round" d="M502.915,274.353l-64.2-64.2c-5.5-5.5-14.4-5.5-19.9,0l-155.1,155c-45.4,45.4-99.2,20.4-119.6,0 c-20.3-20.3-45.8-73.8,0-119.6l155.1-155c5.5-5.5,5.5-14.4,0-19.9l-64.2-64.2c-2.6-2.6-9.9-9.9-19.9,0l-155.1,155 c-101.4,116.1-55.4,232.4,0,287.9c49.4,49.4,171.9,99.3,287.8,0l155.1-155.1C512.915,284.253,505.615,276.953,502.915,274.353z M225.115,36.253l44.3,44.3l-26,26l-44.3-44.3L225.115,36.253z M328.015,429.453c-61.3,61.3-175.2,72.8-248,0 c-72.9-72.9-64.9-183.1,0-248l99.2-99.2l44.3,44.3l-99.2,99.2c-47.5,47.5-45.1,114.2,0,159.4c44.8,44.8,114.4,45,159.4,0 l99.2-99.2l44.3,44.3L328.015,429.453z M447.115,310.253l-44.3-44.3l26-26l44.3,44.3L447.115,310.253z"/></svg>`,
  scissors: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><line x1="20" y1="4" x2="8.12" y2="15.88"></line><line x1="14.47" y1="14.48" x2="20" y2="20"></line><line x1="8.12" y1="8.12" x2="12" y2="12"></line></svg>`
};

// --- Data Models ---
function parseInitial(jsonStr) {
  let parsed = {
    segments: [],
    motionSegments: [],
    audioSegments: [],
    global_prompt: "",
    retake_global_prompt: "",
    mainTrackEnabled: true,
    audioTrackEnabled: true,
    motionTrackEnabled: true,
    propHeight: 90,
    globalPropHeight: 60,
    showFilenames: true,
    manualOutputRange: false,
    useICVideoSize: false,
    overrideAudio: false,
    inpaint_audio: true,
    retakeMode: false,
    retakeStart: 24,
    retakeLength: 48,
    retakePrompt: "",
    retakeStrength: 1.0,
    retakeVideo: null,
    normalStartFrame: 0,
    normalDurationFrames: 120,
    _hasOverrideAudio: false
  };
  try {
    if (jsonStr) {
      const p = JSON.parse(jsonStr);
      if (p.global_prompt !== undefined) parsed.global_prompt = p.global_prompt;
      if (p.retake_global_prompt !== undefined) parsed.retake_global_prompt = p.retake_global_prompt;
      if (p.mainTrackEnabled !== undefined) parsed.mainTrackEnabled = p.mainTrackEnabled;
      if (p.audioTrackEnabled !== undefined) parsed.audioTrackEnabled = p.audioTrackEnabled;
      if (p.motionTrackEnabled !== undefined) parsed.motionTrackEnabled = p.motionTrackEnabled;
      if (p.propHeight !== undefined) parsed.propHeight = p.propHeight;
      if (p.globalPropHeight !== undefined) parsed.globalPropHeight = p.globalPropHeight;
      if (p.showFilenames !== undefined) parsed.showFilenames = p.showFilenames;
      if (p.manualOutputRange !== undefined) parsed.manualOutputRange = !!p.manualOutputRange;
      if (p.useICVideoSize !== undefined) parsed.useICVideoSize = !!p.useICVideoSize;
      if (p.overrideAudio !== undefined) {
        parsed.overrideAudio = p.overrideAudio;
        parsed._hasOverrideAudio = true;
      }
      if (p.inpaint_audio !== undefined) parsed.inpaint_audio = p.inpaint_audio;
      if (p.retakeMode !== undefined) parsed.retakeMode = p.retakeMode;
      if (p.retakeStart !== undefined) parsed.retakeStart = p.retakeStart;
      if (p.retakeLength !== undefined) parsed.retakeLength = p.retakeLength;
      if (p.retakePrompt !== undefined) parsed.retakePrompt = p.retakePrompt;
      if (p.retakeStrength !== undefined) parsed.retakeStrength = p.retakeStrength;
      if (p.retakeVideo !== undefined) parsed.retakeVideo = p.retakeVideo;
      if (p.normalStartFrame !== undefined) parsed.normalStartFrame = p.normalStartFrame;
      if (p.normalDurationFrames !== undefined) parsed.normalDurationFrames = p.normalDurationFrames;
      if (Array.isArray(p.segments)) {
        parsed.segments = p.segments.map(s => {
          const { imgObj, videoEl, _isSeeking, thumbnails, _extractingThumbs, _sSecs, _lSecs, _tSecs, _dSecs, _uploading, _blobUrl, ...rest } = s;
          return rest;
        });
      }
      if (Array.isArray(p.motionSegments)) {
        parsed.motionSegments = p.motionSegments.map(s => {
          const { videoEl, _isSeeking, thumbnails, _extractingThumbs, _sSecs, _lSecs, _tSecs, _dSecs, _uploading, _blobUrl, ...rest } = s;
          return rest;
        });
      }
      if (Array.isArray(p.audioSegments)) {
        parsed.audioSegments = p.audioSegments.map(s => {
          const { _sSecs, _lSecs, _tSecs, _dSecs, _uploading, _decoding, ...rest } = s;
          return rest;
        });
      }
      if (p.h3MultiRef && typeof p.h3MultiRef === "object") {
        parsed.h3MultiRef = p.h3MultiRef;
      }
      if (p.h3Tracks && typeof p.h3Tracks === "object") {
        parsed.h3Tracks = p.h3Tracks;
      }
      if (p.workspace_mode !== undefined) parsed.workspace_mode = p.workspace_mode;
      if (p.h3WorkspaceMode !== undefined) parsed.workspace_mode = p.h3WorkspaceMode;
    }
  } catch (e) { }

  let currentStart = 0;
  for (let seg of parsed.segments) {
    if (seg.start === undefined) {
      seg.start = currentStart;
      currentStart += seg.length;
    }
    // Guarantee ID assignment to prevent node loading drag breaks
    if (!seg.id) {
      seg.id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
    }
    if (seg.isEndFrame === undefined) {
      seg.isEndFrame = false;
    }
  }

  for (let seg of parsed.motionSegments) {
    if (!seg.id) {
      seg.id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
    }
    if (seg.trimStart === undefined) seg.trimStart = 0;
  }

  for (let seg of parsed.audioSegments) {
    if (!seg.id) {
      seg.id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
    }
    if (seg.trimStart === undefined) seg.trimStart = 0;
  }

  return parsed;
}

class TimelineEditor {
  constructor(node, container, domWidget) {
    this.node = node;
    this.container = container;
    this.domWidget = domWidget;
    this.isH3Director = !!(node && (node.comfyClass === "LazyH3Director" || node.type === "LazyH3Director"));
    this.h3WorkspaceMode = "分镜";
    this.h3MultiSelSegIndex = 0;

    // Track heights (dynamic)
    this.rulerHeight = RULER_HEIGHT;
    this.blockHeight = BLOCK_HEIGHT;
    this.refTrackHeight = 0; // H3 多参：第 1 轨「多参图」
    this.motionTrackHeight = MOTION_TRACK_HEIGHT;
    this.audioTrackHeight = AUDIO_TRACK_HEIGHT;
    this.canvasHeight = CANVAS_HEIGHT;

    // Core data
    this.timeline = { segments: [], motionSegments: [], audioSegments: [] };
    this.selectionType = "image"; // "image", "motion", or "audio"
    this.selectedSegmentIds = [];
    this._selectedIndex = -1;
    this._audioTrackWasEnabledBeforeOverride = false;

    // Selection box tracking
    this._isSelectingBox = false;
    this._selectBoxStart = null;
    this._selectBoxCurrent = null;
    this._selectBoxInitialSelectedIds = null;

    // Interactions
    this._isDragging = false;
    this._dragType = null;
    this._dragStartX = 0;
    this._dragInitialTimeline = null;
    this.zoomLevel = 1.0;
    this._lastZoom = 1.0;
    this._lastScale = 1.0;
    this._dragTargetId = null;
    this._dragTargetIdRight = null;
    this._previewSegments = null;
    this._lastWidth = 0;
    this._hoveredGapIdx = -1;
    this._isHovering = false;

    // Playback state
    this.currentFrame = 0;
    this.isPlaying = false;
    this.isLooping = false;
    this.audioContext = null;
    this.activeAudioNodes = [];
    this.playbackStartTime = 0;
    this.playbackStartFrame = 0;
    this._playLoopId = null;

    // File handling
    this.currentFileHandle = null;

    // --- Ghost dragging state ---
    this._ghostSegmentId = null;
    this._ghostTrack = null;
    this._ghostInitialTimeline = null;

    // Attach to Python widgets
    this._gapMenu = null;         // Active gap popup menu element
    this._gapMenuDismisser = null;

    // Attach to Python widgets
    this.startFramesWidget = this.node.widgets.find(w => w.name === "start_frame");
    this.startSecondsWidget = this.node.widgets.find(w => w.name === "start_second");
    this.endFramesWidget = this.node.widgets.find(w => w.name === "end_frame");
    this.endSecondsWidget = this.node.widgets.find(w => w.name === "end_second");
    this.durationFramesWidget = this.node.widgets.find(w => w.name === "duration_frames");
    this.durationSecondsWidget = this.node.widgets.find(w => w.name === "duration_seconds");
    this.frameRateWidget = this.node.widgets.find(w => w.name === "frame_rate");
    this.timelineDataWidget = this.node.widgets.find(w => w.name === "timeline_data");
    this.localPromptsWidget = this.node.widgets.find(w => w.name === "local_prompts");
    this.segmentLengthsWidget = this.node.widgets.find(w => w.name === "segment_lengths");
    this.guideStrengthWidget = this.node.widgets.find(w => w.name === "guide_strength");
    this.displayModeWidget = this.node.widgets.find(w => w.name === "display_mode");

    // Track the last-known frame rate so we can compute the rescale ratio
    // inside the frameRateWidget callback (the widget value is already updated
    // to the new value before the callback fires, so we can't read "old" from it).
    this._prevFrameRate = this.getFrameRate();
    this._prevStartFrames = this.getStartFrames();
    this._prevStartSeconds = this.startSecondsWidget ? this.startSecondsWidget.value : 0;

    this.timeline = parseInitial(this.timelineDataWidget?.value);
    // 重拍模式已移除：始终关闭
    this.retakeMode = false;
    this.timeline.retakeMode = false;
    if (this.node.properties) this.node.properties.retakeMode = false;
    if (this.timeline.global_prompt) {
      if (!this.node.properties) this.node.properties = {};
      this.node.properties.global_prompt = this.timeline.global_prompt;
    }
    // Treat this.timeline (from timeline_data widget) as the absolute source of truth!
    this.mainTrackEnabled = this.timeline.mainTrackEnabled !== false;
    // 产品已移除音频/参考视频轨：强制关闭
    this.audioTrackEnabled = false;
    this.motionTrackEnabled = false;
    this.timeline.audioTrackEnabled = false;
    this.timeline.motionTrackEnabled = false;
    this.manualOutputRange = this.timeline.manualOutputRange === true;
    this.useICVideoSize = this.timeline.useICVideoSize === true;

    // Sync the properties dictionary too so they match
    this.node.properties.mainTrackEnabled = this.mainTrackEnabled;
    this.node.properties.audioTrackEnabled = this.audioTrackEnabled;
    this.node.properties.motionTrackEnabled = this.motionTrackEnabled;
    if (this.timeline.showFilenames !== undefined) {
      this.node.properties.showFilenames = this.timeline.showFilenames;
    }
    const overrideWidget = this.node.widgets?.find(w => w.name === "override_audio");
    if (this.timeline._hasOverrideAudio) {
      this.node.properties.overrideAudio = this.timeline.overrideAudio;
    } else if (overrideWidget) {
      this.timeline.overrideAudio = !!overrideWidget.value;
      this.node.properties.overrideAudio = !!overrideWidget.value;
    }
    if (this.timeline.inpaint_audio !== undefined) {
      this.node.properties.inpaint_audio = this.timeline.inpaint_audio;
    }

    // Sync widgets to match the timeline data
    const inpaintWidget = this.node.widgets?.find(w => w.name === "inpaint_audio");
    if (inpaintWidget && this.timeline.inpaint_audio !== undefined) {
      inpaintWidget.value = this.timeline.inpaint_audio;
    }
    if (overrideWidget && this.timeline._hasOverrideAudio) {
      overrideWidget.value = this.timeline.overrideAudio;
    }

    this._audioTrackWasEnabledBeforeOverride = this.node.properties.audioTrackWasEnabledBeforeOverride || false;
    this.loadMedia();

    this.createDOM();
    this.updateRetakeUIState();
    if (this.timeline.segments.length > 0) {
      this.selectedIndex = 0;
    }
    this.updateUIFromSelection();
    this.syncWidgetsAndUI();
    this.commitChanges(true);
    // Hide settings widgets by default to reduce node clutter.
    // Deferred so all widget types are finalized before we touch them.
    setTimeout(() => this.hideSettingsWidgets(), 0);

    let isSyncing = false;

    // --- Start Callbacks ---
    const origStartFramesCallback = this.startFramesWidget?.callback;
    if (this.startFramesWidget) {
      this.startFramesWidget.callback = (...args) => {
        if (origStartFramesCallback) origStartFramesCallback.apply(this.startFramesWidget, args);

        if (!isSyncing && this.startSecondsWidget && this.durationFramesWidget && this.endFramesWidget) {
          isSyncing = true;

          let newStartFrames = this.getStartFrames();
          const endFrame = this.endFramesWidget.value || 1;
          let newDurationFrames = Math.max(1, endFrame - newStartFrames);

          if (newDurationFrames <= 1) {
            newStartFrames = endFrame - 1;
            this.startFramesWidget.value = newStartFrames;
            newDurationFrames = 1;
          }

          this.startSecondsWidget.value = parseFloat((newStartFrames / this.getFrameRate()).toFixed(3));

          this.durationFramesWidget.value = newDurationFrames;
          if (this.durationSecondsWidget) {
            this.durationSecondsWidget.value = parseFloat((newDurationFrames / this.getFrameRate()).toFixed(3));
          }

          this._prevStartFrames = newStartFrames;
          this._prevStartSeconds = this.startSecondsWidget.value;

          isSyncing = false;
        }

        this.commitChanges();
      };
    }

    const origStartSecondsCallback = this.startSecondsWidget?.callback;
    if (this.startSecondsWidget) {
      this.startSecondsWidget.callback = (...args) => {
        if (origStartSecondsCallback) origStartSecondsCallback.apply(this.startSecondsWidget, args);

        if (!isSyncing && this.startFramesWidget && this.durationSecondsWidget && this.endFramesWidget) {
          isSyncing = true;

          let newStartSeconds = this.startSecondsWidget.value;
          let newStartFrames = Math.max(0, Math.round(newStartSeconds * this.getFrameRate()));

          const endFrame = this.endFramesWidget.value || 1;
          let newDurationFrames = Math.max(1, endFrame - newStartFrames);

          if (newDurationFrames <= 1) {
            newStartFrames = endFrame - 1;
            newStartSeconds = newStartFrames / this.getFrameRate();
            this.startSecondsWidget.value = parseFloat(newStartSeconds.toFixed(3));
            newDurationFrames = 1;
          }

          this.startFramesWidget.value = newStartFrames;

          this.durationFramesWidget.value = newDurationFrames;
          if (this.durationSecondsWidget) {
            this.durationSecondsWidget.value = parseFloat((newDurationFrames / this.getFrameRate()).toFixed(3));
          }

          this._prevStartFrames = newStartFrames;
          this._prevStartSeconds = this.startSecondsWidget.value;

          isSyncing = false;
        }

        this.commitChanges();
      };
    }

    // --- End Callbacks ---
    const origEndFramesCallback = this.endFramesWidget?.callback;
    if (this.endFramesWidget) {
      this.endFramesWidget.callback = (...args) => {
        if (origEndFramesCallback) origEndFramesCallback.apply(this.endFramesWidget, args);

        if (!isSyncing && this.endSecondsWidget && this.durationFramesWidget && this.startFramesWidget) {
          isSyncing = true;

          let newEndFrames = this.endFramesWidget.value;
          const startFrame = this.startFramesWidget.value || 0;
          let newDurationFrames = Math.max(1, newEndFrames - startFrame);

          if (newDurationFrames <= 1) {
            newEndFrames = startFrame + 1;
            this.endFramesWidget.value = newEndFrames;
            newDurationFrames = 1;
          }

          this.endSecondsWidget.value = parseFloat((newEndFrames / this.getFrameRate()).toFixed(3));

          this.durationFramesWidget.value = newDurationFrames;
          if (this.durationSecondsWidget) {
            this.durationSecondsWidget.value = parseFloat((newDurationFrames / this.getFrameRate()).toFixed(3));
          }

          isSyncing = false;
        }

        this.commitChanges();
      };
    }

    const origEndSecondsCallback = this.endSecondsWidget?.callback;
    if (this.endSecondsWidget) {
      this.endSecondsWidget.callback = (...args) => {
        if (origEndSecondsCallback) origEndSecondsCallback.apply(this.endSecondsWidget, args);

        if (!isSyncing && this.endFramesWidget && this.durationSecondsWidget && this.startFramesWidget) {
          isSyncing = true;

          let newEndSeconds = this.endSecondsWidget.value;
          let newEndFrames = Math.max(1, Math.round(newEndSeconds * this.getFrameRate()));

          const startFrame = this.startFramesWidget.value || 0;
          let newDurationFrames = Math.max(1, newEndFrames - startFrame);

          if (newDurationFrames <= 1) {
            newEndFrames = startFrame + 1;
            newEndSeconds = newEndFrames / this.getFrameRate();
            this.endSecondsWidget.value = parseFloat(newEndSeconds.toFixed(3));
            newDurationFrames = 1;
          }

          this.endFramesWidget.value = newEndFrames;

          this.durationFramesWidget.value = newDurationFrames;
          if (this.durationSecondsWidget) {
            this.durationSecondsWidget.value = parseFloat((newDurationFrames / this.getFrameRate()).toFixed(3));
          }

          isSyncing = false;
        }

        this.commitChanges();
      };
    }

    // --- Duration Callbacks ---
    // 不自动改「手动范围」：开/关只跟按钮走，生成回写、改时长都不会强行打开

    const origDurationFramesCallback = this.durationFramesWidget?.callback;
    if (this.durationFramesWidget) {
      this.durationFramesWidget.callback = (...args) => {
        if (origDurationFramesCallback) origDurationFramesCallback.apply(this.durationFramesWidget, args);

        if (!isSyncing && this.durationSecondsWidget && this.startFramesWidget && this.endFramesWidget) {
          isSyncing = true;
          const newFrames = Math.max(1, Math.round(Number(this.durationFramesWidget.value) || 1));
          this.durationFramesWidget.value = newFrames;
          this.durationSecondsWidget.value = parseFloat((newFrames / this.getFrameRate()).toFixed(3));

          const newEndFrames = this.startFramesWidget.value + newFrames;
          this.endFramesWidget.value = newEndFrames;
          if (this.endSecondsWidget) {
            this.endSecondsWidget.value = parseFloat((newEndFrames / this.getFrameRate()).toFixed(3));
          }

          isSyncing = false;
        }

        this.commitChanges();
      };
    }

    const origDurationSecondsCallback = this.durationSecondsWidget?.callback;
    if (this.durationSecondsWidget) {
      this.durationSecondsWidget.callback = (...args) => {
        if (origDurationSecondsCallback) origDurationSecondsCallback.apply(this.durationSecondsWidget, args);

        if (!isSyncing && this.durationFramesWidget && this.startFramesWidget && this.endFramesWidget) {
          isSyncing = true;
          const secs = Math.max(0.01, Number(this.durationSecondsWidget.value) || 0.01);
          this.durationSecondsWidget.value = parseFloat(secs.toFixed(3));
          const newFrames = Math.max(1, Math.round(secs * this.getFrameRate()));
          this.durationFramesWidget.value = newFrames;

          const newEndFrames = this.startFramesWidget.value + newFrames;
          this.endFramesWidget.value = newEndFrames;
          if (this.endSecondsWidget) {
            this.endSecondsWidget.value = parseFloat((newEndFrames / this.getFrameRate()).toFixed(3));
          }

          isSyncing = false;
        }

        this.commitChanges();
      };
    }

    const origFrameRateCallback = this.frameRateWidget?.callback;
    if (this.frameRateWidget) {
      this.frameRateWidget.callback = (...args) => {
        if (origFrameRateCallback) origFrameRateCallback.apply(this.frameRateWidget, args);

        // Keep start_seconds and end_seconds constant; recompute frames to match the new rate.
        if (!isSyncing && this.durationSecondsWidget && this.durationFramesWidget) {
          isSyncing = true;
          const newFPS = this.getFrameRate();

          // Recompute all segment frame values from their seconds snapshots.
          // Using the snapshot avoids cumulative rounding errors when the user
          // drags the slider rapidly through many intermediate FPS values.
          this._rebaseSegmentsToFPS(newFPS);

          if (this.startSecondsWidget && this.startFramesWidget) {
            const newStartFrames = Math.max(0, Math.round(this.startSecondsWidget.value * newFPS));
            this.startFramesWidget.value = newStartFrames;
            this._prevStartFrames = newStartFrames;
          }

          if (this.endSecondsWidget && this.endFramesWidget) {
            const newEndFrames = Math.max(1, Math.round(this.endSecondsWidget.value * newFPS));
            this.endFramesWidget.value = newEndFrames;
          }

          const newFrames = Math.max(1, Math.round(this.durationSecondsWidget.value * newFPS));
          this.durationFramesWidget.value = newFrames;

          // Update our tracked previous rate now that the change is complete.
          this._prevFrameRate = newFPS;
          isSyncing = false;
        }

        this.commitChanges();
      };
    }

    const origDisplayModeCallback = this.displayModeWidget?.callback;
    if (this.displayModeWidget) {
      this.displayModeWidget.callback = (...args) => {
        if (origDisplayModeCallback) origDisplayModeCallback.apply(this.displayModeWidget, args);
        this.updateWidgetVisibility();
        this.updateUIFromSelection();
        this.render();
      };
      this.updateWidgetVisibility(); // Initial trigger
    }

    // Polling is much more reliable in Comfy than ResizeObserver due to scale transforms
    this._renderLoop = requestAnimationFrame(() => this.checkResize());
  }

  isMultiSelectActive() {
    if (!this.selectedSegmentIds || this.selectedSegmentIds.length <= 1) return false;
    const baseIds = new Set();
    for (const id of this.selectedSegmentIds) {
      const baseId = (id.endsWith("_v") || id.endsWith("_a")) ? id.slice(0, -2) : id;
      baseIds.add(baseId);
    }
    return baseIds.size > 1;
  }

  _startBoxSelect(x, y, e) {
    this._isSelectingBox = true;
    this._isDragging = true;
    this._dragType = "box_select";
    this._selectBoxStart = { x, y };
    this._selectBoxCurrent = { x, y };
    this._selectBoxInitialSelectedIds =
      e && (e.ctrlKey || e.metaKey) ? [...(this.selectedSegmentIds || [])] : [];
    this._selectBoxInitialRefIndexes =
      e && (e.ctrlKey || e.metaKey) ? [...(this.selectedH3RefIndexes || [])] : [];
    this.selectedSegmentIds = [...this._selectBoxInitialSelectedIds];
    this.selectedH3RefIndexes = [...this._selectBoxInitialRefIndexes];
    this.syncSelectionTypeAndIndex();
    this.updateUIFromSelection();
    this.render();
  }

  updateSelectionFromBox() {
    if (!this._selectBoxStart || !this._selectBoxCurrent) return;

    const width = this.canvas.offsetWidth;
    const totalFrames = this.getVisualDurationFrames();
    if (!width || totalFrames <= 0) return;

    const sx = this._selectBoxStart.x;
    const sy = this._selectBoxStart.y;
    const cx = this._selectBoxCurrent.x;
    const cy = this._selectBoxCurrent.y;

    const left = Math.min(sx, cx);
    const right = Math.max(sx, cx);
    const top = Math.min(sy, cy);
    const bottom = Math.max(sy, cy);

    const newSelectedIds = new Set(this._selectBoxInitialSelectedIds || []);
    const multi = this.isH3MultiMode && this.isH3MultiMode();
    const mainTop = this.getMainTrackTop();

    for (const track of ["image", "motion", "audio"]) {
      const arr = this.getSegmentArray(track);
      if (!arr) continue;

      let trackTop = 0;
      let trackBottom = 0;

      if (track === "image") {
        trackTop = mainTop;
        trackBottom = mainTop + this.blockHeight;
      } else if (multi) {
        // H3 多参：主轨 → 参考视频 → 驱动音频
        if (track === "motion") {
          trackTop = this.getMotionTrackTop();
          trackBottom = trackTop + (this.motionTrackHeight || 0);
        } else if (track === "audio") {
          trackTop = this.getAudioTrackTop();
          trackBottom = trackTop + (this.audioTrackHeight || 0);
        }
      } else if (track === "audio") {
        trackTop = mainTop + this.blockHeight;
        trackBottom = mainTop + this.blockHeight + this.audioTrackHeight;
      } else if (track === "motion") {
        trackTop = mainTop + this.blockHeight + this.audioTrackHeight;
        trackBottom =
          mainTop + this.blockHeight + this.audioTrackHeight + this.motionTrackHeight;
      }

      for (const seg of arr) {
        const startX = (seg.start / totalFrames) * width;
        const pxWidth = (seg.length / totalFrames) * width;
        const endX = startX + pxWidth;

        const intersects = (left <= endX && right >= startX && top <= trackBottom && bottom >= trackTop);

        if (intersects) {
          newSelectedIds.add(seg.id);
          const sibId = seg.id.endsWith("_v") ? seg.id.slice(0, -2) + "_a" : (seg.id.endsWith("_a") ? seg.id.slice(0, -2) + "_v" : null);
          if (sibId) {
            newSelectedIds.add(sibId);
          }
        }
      }
    }

    // H3 多参图槽框选
    const refIdx = new Set(this._selectBoxInitialRefIndexes || []);
    if (multi) {
      const layout = this._h3RefLayout || this.getH3RefLayout?.(width);
      if (layout?.slots?.length) {
        for (const s of layout.slots) {
          if (!s?.item) continue;
          const intersects =
            left <= s.x + s.w &&
            right >= s.x &&
            top <= s.y + s.h &&
            bottom >= s.y;
          if (intersects) refIdx.add(s.index);
        }
      }
    }
    this.selectedH3RefIndexes = Array.from(refIdx).sort((a, b) => a - b);

    this.selectedSegmentIds = Array.from(newSelectedIds);
    this.syncSelectionTypeAndIndex();
  }

  syncSelectionTypeAndIndex() {
    if (!this.selectedSegmentIds || this.selectedSegmentIds.length === 0) {
      this._selectedIndex = -1;
      return;
    }
    if (this.isMultiSelectActive()) {
      this._selectedIndex = -1;
      return;
    }
    // Sync single selection (which might be video + audio sibling)
    const firstId = this.selectedSegmentIds[0];
    for (const track of ["image", "motion", "audio"]) {
      const arr = this.getSegmentArray(track);
      const idx = arr.findIndex(s => s.id === firstId);
      if (idx !== -1) {
        this.selectionType = track;
        this._selectedIndex = idx;
        break;
      }
    }
  }

  get selectedIndex() {
    return this._selectedIndex;
  }

  set selectedIndex(val) {
    this._selectedIndex = val;
    if (this.selectedSegmentIds && !this.isMultiSelectActive()) {
      if (val === -1) {
        this.selectedSegmentIds = [];
      } else {
        const arr = this.getSegmentArray(this.selectionType);
        const seg = arr ? arr[val] : null;
        if (seg) {
          this.selectedSegmentIds = [seg.id];
          if (seg.id.endsWith("_v")) {
            const sibId = seg.id.slice(0, -2) + "_a";
            if (!this.selectedSegmentIds.includes(sibId)) this.selectedSegmentIds.push(sibId);
          } else if (seg.id.endsWith("_a")) {
            const sibId = seg.id.slice(0, -2) + "_v";
            if (!this.selectedSegmentIds.includes(sibId)) this.selectedSegmentIds.push(sibId);
          }
        } else {
          this.selectedSegmentIds = [];
        }
      }
    }
  }

  destroy() {
    cancelAnimationFrame(this._renderLoop);
    this.pauseAudio();
    window.removeEventListener("keydown", this.handleKeyDown, true);
    window.removeEventListener("paste", this.handlePaste, true);
  }

  getStartFrames() {
    return parseInt((this.startFramesWidget && this.startFramesWidget.value >= 0) ? this.startFramesWidget.value : 0, 10);
  }

  getDurationFrames() {
    const raw = this.durationFramesWidget ? parseInt(this.durationFramesWidget.value, 10) : 0;
    if (Number.isFinite(raw) && raw >= 1) return raw;
    // 不再默认 81：用结束-起始，至少 1
    const start = this.getStartFrames();
    const end = this.endFramesWidget ? parseInt(this.endFramesWidget.value, 10) : NaN;
    if (Number.isFinite(end) && end > start) return end - start;
    return 1;
  }

  getFrameRate() {
    return parseInt((this.frameRateWidget && this.frameRateWidget.value > 0) ? this.frameRateWidget.value : 24, 10);
  }

  // Grow the timeline duration to fit `requiredFrames` if it is currently shorter.
  // The timeline only ever grows — never shrinks — through this method.
  growTimelineIfNeeded(requiredFrames) {
    if (!shouldAutoSyncDuration(this.manualOutputRange)) return;
    const current = this.getDurationFrames();
    if (requiredFrames <= current) return; // already big enough

    const newFrames = Math.ceil(requiredFrames);
    if (this.durationFramesWidget) {
      this.durationFramesWidget.value = newFrames;
    }
    if (this.durationSecondsWidget) {
      this.durationSecondsWidget.value = parseFloat((newFrames / this.getFrameRate()).toFixed(3));
    }
    // Notify ComfyUI that the widget value changed so it serialises correctly.
    if (window.app && window.app.graph) {
      window.app.graph.setDirtyCanvas(true, true);
    }
  }

  syncDurationToTimelineSegments() {
    const multi = this.isH3MultiMode && this.isH3MultiMode();
    let totalFrames;
    if (this.isH3Director) {
      // 分镜/多参：有驱动音频则总时长跟驱动；否则跟主轨（多参）或主轨+其它轨
      const driveF = this.getH3DriveAudioDurationFrames?.() || 0;
      if (driveF > 0) {
        totalFrames = driveF;
      } else if (multi) {
        totalFrames = calculateTimelineDurationFrames(0, this.timeline.segments);
      } else {
        totalFrames = calculateTimelineDurationFrames(
          0,
          this.timeline.segments,
          this.timeline.audioSegments,
          this.timeline.motionSegments,
        );
      }
    } else {
      totalFrames = calculateTimelineDurationFrames(
        0,
        this.timeline.segments,
        this.timeline.audioSegments,
        this.timeline.motionSegments,
      );
    }
    if (this.durationFramesWidget) this.durationFramesWidget.value = totalFrames;
    if (this.durationSecondsWidget) {
      this.durationSecondsWidget.value = parseFloat((totalFrames / this.getFrameRate()).toFixed(3));
    }
    if (this.endFramesWidget) this.endFramesWidget.value = this.getStartFrames() + totalFrames;
    if (this.endSecondsWidget) this.endSecondsWidget.value = parseFloat((this.endFramesWidget.value / this.getFrameRate()).toFixed(3));
    return totalFrames;
  }

  syncDurationToTimelineSegmentsIfAuto() {
    if (!shouldAutoSyncDuration(this.manualOutputRange)) return this.getDurationFrames();
    return this.syncDurationToTimelineSegments();
  }

  // Force all start/end/duration widgets to match the retake video's duration exactly.
  syncWidgetsToRetakeDuration(durationFrames) {
    if (durationFrames <= 0) return;
    const rate = this.getFrameRate();
    const durationSeconds = parseFloat((durationFrames / rate).toFixed(3));

    const wasSuppressing = this._suppressCommit;
    this._suppressCommit = true;

    if (this.startFramesWidget) {
      this.startFramesWidget.value = 0;
      if (this.startFramesWidget.callback) {
        try { this.startFramesWidget.callback(0); } catch (_) {}
      }
    }
    if (this.startSecondsWidget) {
      this.startSecondsWidget.value = 0;
    }

    if (this.durationFramesWidget) {
      this.durationFramesWidget.value = durationFrames;
      if (this.durationFramesWidget.callback) {
        try { this.durationFramesWidget.callback(durationFrames); } catch (_) {}
      }
    }
    if (this.durationSecondsWidget) {
      this.durationSecondsWidget.value = durationSeconds;
    }

    if (this.endFramesWidget) {
      this.endFramesWidget.value = durationFrames;
    }
    if (this.endSecondsWidget) {
      this.endSecondsWidget.value = durationSeconds;
    }

    this._suppressCommit = wasSuppressing;
  }

  // Returns the maximum allowed zoom level, computed so that at max zoom
  // the viewport shows exactly 4 seconds of the visual timeline.
  getMaxZoom() {
    const visualDurationSecs = this.getVisualDurationFrames() / this.getFrameRate();
    const baseMaxZoom = Math.max(1, visualDurationSecs / 4);

    // Limit max zoom to prevent canvas width from exceeding browser limits (causing crash)
    const viewportWidth = this.viewport ? this.viewport.clientWidth : 1000;
    const MAX_CANVAS_WIDTH = 32768; // Extended limit for modern browsers
    const limitMaxZoom = MAX_CANVAS_WIDTH / Math.max(1, viewportWidth);

    return Math.max(1, Math.min(baseMaxZoom, limitMaxZoom));
  }

  // Returns the visual timeline length in frames:
  // the furthest segment end (across both tracks) × 1.30, with a floor of getDurationFrames().
  // This is used for all rendering/positioning — the actual output duration is getDurationFrames().
  getVisualDurationFrames() {
    if (this.retakeMode) {
      if (this.timeline.retakeVideo) {
        const baseVideoDur = this.timeline.retakeVideo.videoDurationFrames || 0;
        // Add 15% visual buffer duration on the right to prevent the video segment
        // from being cut off by the DOM clipping (right ~9% of the viewport is clipped by ComfyUI).
        return Math.max(24, Math.ceil(baseVideoDur * 1.15));
      } else {
        return 24;
      }
    }

    // 多参：主轨 + 驱动音频（有则以其时长为准）
    const multi = this.isH3MultiMode && this.isH3MultiMode();
    const furthest = multi
      ? Math.max(
          calculateTimelineDurationFrames(0, this.timeline.segments),
          this.getH3DriveAudioDurationFrames?.() || 0,
        )
      : calculateTimelineDurationFrames(
          0,
          this.timeline.segments,
          this.timeline.audioSegments,
          this.timeline.motionSegments,
        );
    const outputDuration = this.getDurationFrames();
    if (furthest <= 0) return outputDuration;
    return Math.max(outputDuration, Math.ceil(furthest * 1.30));
  }

  getSeekableDurationFrames() {
    if (this.retakeMode) {
      if (!this.timeline.retakeVideo) return this.getDurationFrames();
      return Math.max(1, this.timeline.retakeVideo.videoDurationFrames || this.getDurationFrames());
    }

    const multi = this.isH3MultiMode && this.isH3MultiMode();
    const contentDuration = multi
      ? Math.max(
          calculateTimelineDurationFrames(this.getDurationFrames(), this.timeline.segments),
          this.getH3DriveAudioDurationFrames?.() || 0,
        )
      : calculateTimelineDurationFrames(
          this.getDurationFrames(),
          this.timeline.segments,
          this.timeline.audioSegments,
          this.timeline.motionSegments,
        );
    return Math.max(1, contentDuration);
  }

  getPlaybackDurationFrames() {
    return calculatePlaybackDurationFrames(this.getDurationFrames(), this.getSeekableDurationFrames());
  }

  // Sync the zoom slider's max attribute to the current getMaxZoom() value,
  // clamping zoomLevel if it now exceeds the new max.
  updateZoomSliderMax() {
    if (!this.zoomSlider) return;
    const maxZoom = this.getMaxZoom();
    this.zoomSlider.max = maxZoom.toFixed(2);
    if (this.zoomLevel > maxZoom) {
      this.zoomLevel = maxZoom;
      this.zoomSlider.value = maxZoom;
      // Resize the canvas to match the clamped zoom
      const viewportWidth = this.viewport ? this.viewport.clientWidth : 0;
      if (viewportWidth > 0) {
        const newCanvasWidth = Math.max(viewportWidth, viewportWidth * this.zoomLevel);
        this.canvas.style.width = newCanvasWidth + "px";
        this.resizeCanvas(newCanvasWidth);
      }
    }
  }

  _liveScrubVideo(seg, edge) {
    if (!seg || (seg.type !== "video" && seg.type !== "motion_video")) return;
    this._ensureVideoEl(seg);
    if (!seg.videoEl) return;
    const targetSec = edge === "end"
      ? (seg.trimStart + seg.length) / this.getFrameRate()
      : seg.trimStart / this.getFrameRate();

    seg._scrubTargetSec = targetSec;
  }

  _liveScrubPlayhead() {
    const targetFrame = this.currentFrame;
    if (this.retakeMode && this.timeline.retakeVideo) {
      const retakeVid = this.timeline.retakeVideo;
      this._ensureVideoEl(retakeVid);
      if (retakeVid.videoEl) {
        const targetSec = targetFrame / this.getFrameRate();
        retakeVid._scrubTargetSec = targetSec;
      }
      return;
    }

    const seg = this.timeline.segments.find(s => s.type === "video" && targetFrame >= s.start && targetFrame < s.start + s.length);
    if (seg) {
      this._ensureVideoEl(seg);
      if (seg.videoEl) {
        const targetSec = (seg.trimStart + (targetFrame - seg.start)) / this.getFrameRate();
        seg._scrubTargetSec = targetSec;
      }
    }

    const motionSeg = this.timeline.motionSegments.find(s => s.type === "motion_video" && targetFrame >= s.start && targetFrame < s.start + s.length);
    if (motionSeg) {
      this._ensureVideoEl(motionSeg);
      if (motionSeg.videoEl) {
        const targetSec = (motionSeg.trimStart + (targetFrame - motionSeg.start)) / this.getFrameRate();
        motionSeg._scrubTargetSec = targetSec;
      }
    }
  }

  async _ensureThumbnails(seg) {
    if (seg.thumbnails) return;
    if (seg._extractingThumbs) return;

    const fileKey = seg.imageFile || seg.videoFile || seg._blobUrl;
    if (!fileKey) return;

    this._thumbnailCache = this._thumbnailCache || new Map();
    this._thumbnailPromises = this._thumbnailPromises || new Map();

    if (this._thumbnailCache.has(fileKey)) {
      seg.thumbnails = this._thumbnailCache.get(fileKey);
      this.render();
      return;
    }

    if (this._thumbnailPromises.has(fileKey)) {
      seg._extractingThumbs = true;
      try {
        const thumbs = await this._thumbnailPromises.get(fileKey);
        seg.thumbnails = thumbs;
      } catch (err) {
        console.error("Failed to await thumbnails promise:", err);
      } finally {
        seg._extractingThumbs = false;
        this.render();
      }
      return;
    }

    // Otherwise, we extract the thumbnails
    seg._extractingThumbs = true;
    seg.thumbnails = [];

    const extractPromise = (async () => {
      const thumbs = [];
      const parts = fileKey.split(/[/\\\\]/);
      const filename = parts.pop() || '';
      const subfolder = parts.join('/');
      const vidUrl = seg._blobUrl || (seg.videoEl ? seg.videoEl.src : null) || api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);

      const bgVid = document.createElement('video');
      bgVid.crossOrigin = "Anonymous";
      bgVid.muted = true;
      bgVid.preload = 'auto';

      try {
        await new Promise(r => {
          let resolved = false;
          const done = () => {
            if (!resolved) {
              resolved = true;
              r();
            }
          };
          bgVid.onloadeddata = done;
          bgVid.onerror = done;
          bgVid.src = vidUrl;
          if (bgVid.readyState >= 2) {
            done();
          }
        });

        if (!bgVid.duration) {
          return thumbs;
        }

        const duration = bgVid.duration;
        const isLargeFile = seg.fileSize > 500 * 1024 * 1024;
        const numFrames = isLargeFile ? 10 : Math.max(5, Math.min(25, Math.ceil(duration * 1.0)));
        const canvas = document.createElement('canvas');
        let w = bgVid.videoWidth, h = bgVid.videoHeight;
        if (w === 0 || h === 0) return thumbs;

        if (h > this.blockHeight) {
          w = Math.round(w * (this.blockHeight / h));
          h = this.blockHeight;
        }
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');

        for (let i = 0; i < numFrames; i++) {
          // Check if the file/segment is still active in the current timeline
          const exists = this.timeline.segments.find(s => s.imageFile === fileKey || s.videoFile === fileKey || s._blobUrl === fileKey) ||
            this.timeline.motionSegments.find(s => s.imageFile === fileKey || s.videoFile === fileKey || s._blobUrl === fileKey) ||
            (this.timeline.retakeVideo && (this.timeline.retakeVideo.imageFile === fileKey || this.timeline.retakeVideo._blobUrl === fileKey));
          if (!exists) break;

          const time = (i / numFrames) * duration;
          bgVid.currentTime = time;

          await new Promise(r => {
            let resolved = false;
            const onSeek = () => { if (!resolved) { resolved = true; r(); } };
            bgVid.onseeked = onSeek;
            setTimeout(onSeek, 1000);
          });

          ctx.drawImage(bgVid, 0, 0, w, h);
          const img = new Image();
          img.src = canvas.toDataURL('image/jpeg', 0.5);
          await new Promise(r => { img.onload = r; });

          thumbs.push({ time, img });

          // Propagate the partial progress live to all active segments sharing this file
          const matchingSegs = [
            ...this.timeline.segments.filter(s => s.imageFile === fileKey || s.videoFile === fileKey || s._blobUrl === fileKey),
            ...(this.timeline.motionSegments || []).filter(s => s.imageFile === fileKey || s.videoFile === fileKey || s._blobUrl === fileKey)
          ];
          if (this.timeline.retakeVideo && (this.timeline.retakeVideo.imageFile === fileKey || this.timeline.retakeVideo._blobUrl === fileKey)) {
            matchingSegs.push(this.timeline.retakeVideo);
          }
          for (const ms of matchingSegs) {
            ms.thumbnails = thumbs;
          }

          this.render();
        }
      } catch (err) {
        console.error("Thumbnail extraction loop failed:", err);
      } finally {
        try {
          bgVid.pause();
          bgVid.onloadeddata = null;
          bgVid.onerror = null;
          bgVid.onseeked = null;
          bgVid.src = "";
          bgVid.load();
        } catch (_) { }
      }
      return thumbs;
    })();

    this._thumbnailPromises.set(fileKey, extractPromise);

    try {
      const thumbs = await extractPromise;
      this._thumbnailCache.set(fileKey, thumbs);

      const matchingSegs = [
        ...this.timeline.segments.filter(s => s.imageFile === fileKey || s.videoFile === fileKey || s._blobUrl === fileKey),
        ...(this.timeline.motionSegments || []).filter(s => s.imageFile === fileKey || s.videoFile === fileKey || s._blobUrl === fileKey)
      ];
      if (this.timeline.retakeVideo && (this.timeline.retakeVideo.imageFile === fileKey || this.timeline.retakeVideo._blobUrl === fileKey)) {
        matchingSegs.push(this.timeline.retakeVideo);
      }
      for (const ms of matchingSegs) {
        ms.thumbnails = thumbs;
        ms._extractingThumbs = false;

        // If fileKey is a blob URL, and the segment now has a server file path, cache under that path too
        if (fileKey.startsWith("blob:")) {
          const serverKey = ms.imageFile || ms.videoFile;
          if (serverKey) {
            this._thumbnailCache.set(serverKey, thumbs);
          }
        }
      }
    } catch (err) {
      console.error("Extraction error:", err);
      const matchingSegs = [
        ...this.timeline.segments.filter(s => s.imageFile === fileKey || s.videoFile === fileKey || s._blobUrl === fileKey),
        ...(this.timeline.motionSegments || []).filter(s => s.imageFile === fileKey || s.videoFile === fileKey || s._blobUrl === fileKey)
      ];
      if (this.timeline.retakeVideo && (this.timeline.retakeVideo.imageFile === fileKey || this.timeline.retakeVideo._blobUrl === fileKey)) {
        matchingSegs.push(this.timeline.retakeVideo);
      }
      for (const ms of matchingSegs) {
        ms._extractingThumbs = false;
      }
    } finally {
      this._thumbnailPromises.delete(fileKey);
      this.render();
    }
  }

  getSegmentArray(trackType) {
    if (trackType === "ref") return null;
    if (trackType === "motion") return this.timeline.motionSegments;
    if (trackType === "audio") return this.timeline.audioSegments;
    return this.timeline.segments;
  }

  getOverrideAudioEnabled() {
    const widget = this.node.widgets?.find(w => w.name === "override_audio");
    if (widget) return !!widget.value;
    return !!(this.node.properties?.overrideAudio || this.timeline.overrideAudio);
  }

  getSnappedPlayhead(mouseFrameX, logicalWidth) {
    if (!this.isSnapping) return mouseFrameX;

    const totalFrames = this.getVisualDurationFrames();
    const thresholdFrames = (15 / logicalWidth) * totalFrames;
    const snapCandidates = [0, this.getDurationFrames()];

    // Add start and end frames of active generation range
    snapCandidates.push(this.getStartFrames());
    if (this.endFramesWidget && this.endFramesWidget.value !== undefined) {
      snapCandidates.push(parseInt(this.endFramesWidget.value, 10));
    }

    if (this.retakeMode) {
      if (this.timeline.retakeVideo) {
        const baseVideoDur = this.timeline.retakeVideo.videoDurationFrames || 0;
        snapCandidates.push(baseVideoDur);
      }
      if (this.timeline.retakeStart !== undefined) {
        snapCandidates.push(this.timeline.retakeStart);
        if (this.timeline.retakeLength !== undefined) {
          snapCandidates.push(this.timeline.retakeStart + this.timeline.retakeLength);
        }
      }
    }

    const allTracks = [
      this.timeline.segments || [],
      this.timeline.motionSegments || [],
      this.timeline.audioSegments || []
    ];
    for (const track of allTracks) {
      for (const seg of track) {
        snapCandidates.push(seg.start);
        snapCandidates.push(seg.start + seg.length);
      }
    }

    let bestFrame = mouseFrameX;
    let minDiff = thresholdFrames;
    for (const candidate of snapCandidates) {
      const diff = Math.abs(mouseFrameX - candidate);
      if (diff < minDiff) {
        minDiff = diff;
        bestFrame = candidate;
      }
    }
    return bestFrame;
  }

  getRefTrackHeight() {
    return this.refTrackHeight || 0;
  }

  /** 主轨顶边 Y（多参时含多参图轨高度） */
  getMainTrackTop() {
    return RULER_HEIGHT + this.getRefTrackHeight();
  }

  /** H3 多参：参考音频轨顶边（主轨下方） */
  getRefAudioTrackTop() {
    return this.getMainTrackTop() + this.blockHeight;
  }

  getMotionTrackTop() {
    // H3 多参：主轨 → 参考音频 → 参考视频
    if (this.isH3MultiMode && this.isH3MultiMode()) {
      return this.getMainTrackTop() + this.blockHeight + (this.refAudioTrackHeight || 0);
    }
    return this.getAudioTrackTop() + (this.audioTrackHeight || 0);
  }

  getAudioTrackTop() {
    // H3 多参：驱动音频在参考视频下方
    if (this.isH3MultiMode && this.isH3MultiMode()) {
      return (
        this.getMainTrackTop() +
        this.blockHeight +
        (this.refAudioTrackHeight || 0) +
        (this.motionTrackHeight || 0)
      );
    }
    return this.getMainTrackTop() + this.blockHeight;
  }

  /** H3 分镜/多参：驱动音频时长（帧）；无则 0 */
  getH3DriveAudioDurationFrames() {
    if (!this.isH3Director) return 0;
    const driveSegs = (this.timeline?.audioSegments || []).filter((s) => s?.isH3Drive);
    if (driveSegs.length) {
      let maxEnd = 0;
      for (const s of driveSegs) {
        maxEnd = Math.max(maxEnd, (s.start || 0) + (s.length || 0));
      }
      return Math.max(1, Math.round(maxEnd));
    }
    const d = this.ensureH3MultiData?.() || this.timeline?.h3MultiRef;
    const a = d?.driveAudio || null;
    const sec = Number(a?.duration) || 0;
    if (sec <= 0) return 0;
    return Math.max(1, Math.round(sec * this.getFrameRate()));
  }

  getTrackFromY(y) {
    const refH = this.getRefTrackHeight();
    const audioH = this.audioTrackHeight || 0;
    const motionH = this.motionTrackHeight || 0;
    if (y < RULER_HEIGHT) return "image";
    if (refH > 0 && y < RULER_HEIGHT + refH) return "ref";
    const mainTop = RULER_HEIGHT + refH;
    const imgBottom = mainTop + this.blockHeight;
    if (y < imgBottom) return "image";
    // H3 多参轨序：主轨 → 参考音频 → 参考视频 → 驱动音频
    if (this.isH3MultiMode && this.isH3MultiMode()) {
      const refAudH = this.refAudioTrackHeight || 0;
      if (refAudH > 0 && y < imgBottom + refAudH) return "ref_audio";
      if (motionH > 0 && y < imgBottom + refAudH + motionH) return "motion";
      if (audioH > 0 && y < imgBottom + refAudH + motionH + audioH) return "audio";
      return "image";
    }
    if (audioH > 0 && y < imgBottom + audioH) return "audio";
    if (motionH > 0 && y < imgBottom + audioH + motionH) return "motion";
    return "image";
  }

  _ensureVideoEl(seg) {
    if (!seg) return;

    if (seg.videoEl) {
      if (seg.videoEl.duration && !seg.videoDurationFrames) {
        const frameRate = this.getFrameRate();
        seg.videoDurationFrames = Math.max(1, Math.ceil(seg.videoEl.duration * frameRate));
      }
      if (this.retakeMode && seg === this.timeline.retakeVideo && seg.videoDurationFrames) {
        this.syncWidgetsToRetakeDuration(seg.videoDurationFrames);
        this.updateZoomSliderMax();
        this.commitChanges(true);
      }
      return;
    }

    const cacheKey = seg.imageFile || seg.videoFile || seg._blobUrl;
    if (!cacheKey) return;

    this._videoElementsCache = this._videoElementsCache || new Map();

    if (this._videoElementsCache.has(cacheKey)) {
      // Reuse the existing shared video element — do NOT re-seek it.
      // Running initVideoSeek on an already-initialized element causes cascading seeks
      // when multiple split segments share it (e.g. seg2 seeks to 5min, seg3 seeks to 10min),
      // which breaks playback on long videos. Just grab the reference and ensure thumbnails.
      seg.videoEl = this._videoElementsCache.get(cacheKey);
      if (seg.videoEl.duration && !seg.videoDurationFrames) {
        const frameRate = this.getFrameRate();
        seg.videoDurationFrames = Math.max(1, Math.ceil(seg.videoEl.duration * frameRate));
      }
      if (this.retakeMode && seg === this.timeline.retakeVideo && seg.videoDurationFrames) {
        this.syncWidgetsToRetakeDuration(seg.videoDurationFrames);
        this.updateZoomSliderMax();
        this.commitChanges(true);
      }
      this._ensureThumbnails(seg);
      return;
    }

    const isRetake = seg === this.timeline?.retakeVideo;
    const isVideo = (seg.type === "video" || isRetake) && (seg.imageFile || seg._blobUrl);
    const isMotionVideo = seg.type === "motion_video" && seg.videoFile;
    if (!isVideo && !isMotionVideo) return;

    const fileKey = (seg.type === "video" || isRetake) ? seg.imageFile : seg.videoFile;
    let vidUrl = seg._blobUrl;
    if (!vidUrl && fileKey) {
      const fileParts = fileKey.split(/[/\\\\]/);
      const justName = fileParts.pop() || '';
      const subfolder = fileParts.join('/');
      vidUrl = api.apiURL(`/view?filename=${encodeURIComponent(justName)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);
    }
    if (!vidUrl) return;

    const vid = document.createElement('video');
    vid.crossOrigin = "Anonymous";
    vid.muted = true;
    vid.preload = 'auto';

    seg.videoEl = vid;
    this._videoElementsCache.set(cacheKey, vid);

    vid.addEventListener('seeked', () => {
      this.render();
    });

    const onSeekedHandler = () => {
      vid.removeEventListener('seeked', onSeekedHandler);
      if (!seg.imageB64 || !seg.imgObj) {
        const canvas = document.createElement('canvas');
        canvas.width = Math.min(vid.videoWidth, 512);
        canvas.height = Math.round((vid.videoHeight / vid.videoWidth) * canvas.width);
        canvas.getContext('2d').drawImage(vid, 0, 0, canvas.width, canvas.height);
        seg.imageB64 = canvas.toDataURL('image/jpeg');
        const img = new Image();
        img.onload = () => {
          seg.imgObj = img;
          this.render();
          this.commitChanges(true);
        };
        img.src = seg.imageB64;
      } else {
        this.render();
      }
    };

    let seekInitialized = false;
    const initVideoSeek = () => {
      if (seekInitialized) return;
      seekInitialized = true;

      if (vid.duration) {
        const frameRate = this.getFrameRate();
        const clipFrames = Math.max(1, Math.ceil(vid.duration * frameRate));
        seg.videoDurationFrames = clipFrames;
        if (this.retakeMode && seg === this.timeline.retakeVideo) {
          this.syncWidgetsToRetakeDuration(clipFrames);
          this.updateZoomSliderMax();
          this.commitChanges(true);
        }
      }

      vid.addEventListener('seeked', onSeekedHandler);
      vid.currentTime = (seg.trimStart || 0) / this.getFrameRate() + 0.01;
      this._ensureThumbnails(seg);
    };

    vid.addEventListener('loadedmetadata', initVideoSeek, { once: true });
    vid.addEventListener('loadeddata', initVideoSeek, { once: true });

    vid.src = vidUrl;

    if (vid.readyState >= 1) {
      initVideoSeek();
    }
  }

  async _getOrExtractAudio(seg) {
    if (!seg.audioFile) return;
    const isVideoFile = seg.audioFile.toLowerCase().match(/\.(mp4|webm|mkv|avi|mov|m4v|flv|wmv)$/);
    if (!isVideoFile) return;

    this._audioExtractionPromises = this._audioExtractionPromises || new Map();
    const fileKey = seg.audioFile;

    if (this._audioExtractionPromises.has(fileKey)) {
      try {
        const res = await this._audioExtractionPromises.get(fileKey);
        if (res && res.audio_file && res.peaks) {
          seg.audioFile = res.audio_file;
          seg.waveformPeaks = res.peaks;
        }
      } catch (err) {
        console.warn("[WanRemixDirector] Awaiting shared server audio extract promise failed:", err);
      }
      return;
    }

    const extractionPromise = (async () => {
      const resp = await api.fetchApi(`/wan_remix_director_get_audio?filename=${encodeURIComponent(fileKey)}`);
      if (resp.status === 200) {
        return await resp.json();
      }
      throw new Error(`Server returned status ${resp.status}`);
    })();

    this._audioExtractionPromises.set(fileKey, extractionPromise);

    try {
      const res = await extractionPromise;
      if (res && res.audio_file && res.peaks) {
        seg.audioFile = res.audio_file;
        seg.waveformPeaks = res.peaks;

        // Update all other segments matching this fileKey in the timeline
        const allAudioSegs = this.timeline.audioSegments || [];
        for (const s of allAudioSegs) {
          if (s.audioFile === fileKey) {
            s.audioFile = res.audio_file;
            s.waveformPeaks = res.peaks;
          }
        }
      }
    } catch (err) {
      console.warn("[WanRemixDirector] Server audio check/extract failed:", err);
    } finally {
      this._audioExtractionPromises.delete(fileKey);
    }
  }

  _extractAudioOnClient(file, audSegId, blobUrl) {
    (async () => {
      try {
        const arrayBuffer = await file.arrayBuffer();
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        const channelData = audioBuffer.getChannelData(0);
        const peaks = [];
        const numPeaks = 200;
        const step = Math.floor(channelData.length / numPeaks);
        for (let i = 0; i < numPeaks; i++) {
          let max = 0;
          for (let j = 0; j < step; j++) {
            const val = Math.abs(channelData[i * step + j]);
            if (val > max) max = val;
          }
          peaks.push(max);
        }
        for (let s of this.timeline.audioSegments) {
          if (s.id === audSegId || (blobUrl && s._blobUrl === blobUrl)) {
            s.waveformPeaks = peaks;
            s._decoding = false;
            s._audioBuffer = audioBuffer;
          }
        }
        this.render();
      } catch (e) {
        console.warn("No audio in video or decode failed", e);
        for (let s of this.timeline.audioSegments) {
          if (s.id === audSegId || (blobUrl && s._blobUrl === blobUrl)) {
            s._decoding = false;
          }
        }
        this.render();
      }
    })();
  }

  _isAudioDecodingAllowed(seg) {
    if (seg.audioFile && seg.audioFile.toLowerCase().match(/\.(wav|mp3|ogg|flac|m4a)$/)) {
      return true;
    }
    const isVideo = (seg.audioFile && seg.audioFile.toLowerCase().match(/\.(mp4|webm|mkv|avi|mov|m4v|flv|wmv)$/)) ||
      (!seg.audioFile && seg._blobUrl);
    if (isVideo) {
      const isSmall = seg.fileSize && seg.fileSize <= 100 * 1024 * 1024;
      return !!isSmall;
    }
    return true;
  }

  async _preloadAudioSegment(seg) {
    if (seg._audioBuffer || seg._decoding) return;
    if (!seg.audioFile && !seg._blobUrl) return;

    seg._decoding = true;
    if (!this._isDragging) this.render();

    try {
      await this._getOrExtractAudio(seg);

      if (!this._isAudioDecodingAllowed(seg)) {
        seg._decoding = false;
        return;
      }

      if (!this.audioContext) {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }

      const parts = (seg.audioFile || "").split(/[/\\\\]/);
      const filename = parts.pop() || '';
      const subfolder = parts.join('/');
      const audioUrl = seg._blobUrl || api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);

      this._audioBufferCache = this._audioBufferCache || new Map();
      this._audioBufferPromises = this._audioBufferPromises || new Map();
      const cacheKey = seg.audioFile || audioUrl;

      let audioBuffer;
      if (this._audioBufferCache.has(cacheKey)) {
        audioBuffer = this._audioBufferCache.get(cacheKey);
      } else if (this._audioBufferPromises.has(cacheKey)) {
        audioBuffer = await this._audioBufferPromises.get(cacheKey);
      } else {
        const decodePromise = (async () => {
          const resp = await fetch(audioUrl);
          const arrayBuffer = await resp.arrayBuffer();
          return await this.audioContext.decodeAudioData(arrayBuffer);
        })();
        this._audioBufferPromises.set(cacheKey, decodePromise);
        try {
          audioBuffer = await decodePromise;
          this._audioBufferCache.set(cacheKey, audioBuffer);
        } finally {
          this._audioBufferPromises.delete(cacheKey);
        }
      }

      const matchingSegs = this.timeline.audioSegments.filter(s => s.audioFile === seg.audioFile || s._blobUrl === seg._blobUrl);
      for (const s of matchingSegs) {
        s._audioBuffer = audioBuffer;
        s._decoding = false;
      }
    } catch (err) {
      console.warn("Failed to preload audio segment:", err);
      seg._decoding = false;
    } finally {
      if (!this._isDragging) this.render();
    }
  }


  async _preloadMotionAudioSegment(seg) {
    if (seg._audioBuffer || seg._decodingAudio) return;
    if (!seg.videoFile && !seg._blobUrl) return;

    seg._decodingAudio = true;

    try {
      const mockSeg = {
        audioFile: seg.videoFile || seg.fileName,
        _blobUrl: seg._blobUrl,
        fileSize: seg.fileSize
      };

      await this._getOrExtractAudio(mockSeg);

      if (!this._isAudioDecodingAllowed(mockSeg)) {
        seg._decodingAudio = false;
        return;
      }

      if (!this.audioContext) {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }

      const parts = (mockSeg.audioFile || "").split(/[/\\\\]/);
      const filename = parts.pop() || '';
      const subfolder = parts.join('/');
      const audioUrl = mockSeg._blobUrl || api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);

      this._audioBufferCache = this._audioBufferCache || new Map();
      this._audioBufferPromises = this._audioBufferPromises || new Map();
      const cacheKey = mockSeg.audioFile || audioUrl;

      let audioBuffer;
      if (this._audioBufferCache.has(cacheKey)) {
        audioBuffer = this._audioBufferCache.get(cacheKey);
      } else if (this._audioBufferPromises.has(cacheKey)) {
        audioBuffer = await this._audioBufferPromises.get(cacheKey);
      } else {
        const decodePromise = (async () => {
          const resp = await fetch(audioUrl);
          const arrayBuffer = await resp.arrayBuffer();
          return await this.audioContext.decodeAudioData(arrayBuffer);
        })();
        this._audioBufferPromises.set(cacheKey, decodePromise);
        try {
          audioBuffer = await decodePromise;
          this._audioBufferCache.set(cacheKey, audioBuffer);
        } finally {
          this._audioBufferPromises.delete(cacheKey);
        }
      }
      seg._audioBuffer = audioBuffer;
    } catch (e) {
      console.warn("Failed to preload motion audio segment:", e);
    } finally {
      seg._decodingAudio = false;
    }
  }


  loadMedia() {
    for (const seg of this.timeline.segments) {
      if (seg.imageB64 && !seg.imgObj) {
        seg.imgObj = new Image();
        seg.imgObj.onload = () => { if (!this._isDragging) this.render(); };
        seg.imgObj.src = seg.imageB64;
      }
      if (seg.type === "video") {
        this._ensureVideoEl(seg);
        this._ensureThumbnails(seg);
      }
    }

    if (this.timeline.motionSegments) {
      const isOverrideAudio = this.getOverrideAudioEnabled();
      for (const seg of this.timeline.motionSegments) {
        if (seg.imageB64 && !seg.imgObj) {
          seg.imgObj = new Image();
          seg.imgObj.onload = () => { if (!this._isDragging) this.render(); };
          seg.imgObj.src = seg.imageB64;
        }
        if (seg.type === "motion_video") {
          this._ensureVideoEl(seg);
          this._ensureThumbnails(seg);
          if (isOverrideAudio) {
            this._preloadMotionAudioSegment(seg);
          }
        }
      }
    }

    if (this.timeline.audioSegments) {
      for (const seg of this.timeline.audioSegments) {
        if (seg.type === "audio") {
          this._preloadAudioSegment(seg);
        }
      }
    }

    if (this.timeline.retakeVideo) {
      this._ensureVideoEl(this.timeline.retakeVideo);
      this._ensureThumbnails(this.timeline.retakeVideo);
    }
  }

  createDOM() {
    this.wrapper = document.createElement("div");
    this.wrapper.className = "pr-wrapper";

    this.wrapper.addEventListener("mouseenter", () => { this._isHovering = true; });
    this.wrapper.addEventListener("mouseleave", () => { this._isHovering = false; });

    this.handleKeyDown = (e) => {
      const activeTag = document.activeElement ? document.activeElement.tagName : "";
      if (activeTag === "INPUT" || activeTag === "TEXTAREA") return;

      const isCtrl = e.ctrlKey || e.metaKey;

      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        this._isHovering &&
        (this.selectedIndex !== -1 ||
          (this.selectedSegmentIds && this.selectedSegmentIds.length > 0) ||
          (this.selectedH3RefIndexes && this.selectedH3RefIndexes.length > 0))
      ) {
        this.deleteSelectedSegment();
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
      } else if ((e.key === " " || e.code === "Space") && this._isHovering) {
        this.togglePlay();
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
      } else if ((e.key === "b" || e.key === "B") && isCtrl && this._isHovering) {
        if (this.selectedIndex !== -1) {
          const arr = this.getSegmentArray(this.selectionType);
          const seg = arr[this.selectedIndex];
          if (seg) this.splitSegmentAtPlayhead(seg, this.selectionType);
        }
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
      } else if ((e.key === "c" || e.key === "C") && isCtrl && this._isHovering) {
        if (this.selectedIndex !== -1) {
          const arr = this.getSegmentArray(this.selectionType);
          const seg = arr[this.selectedIndex];
          if (seg) {
            window._ltxCopiedSegment = { main: { ...seg }, sibling: null };
            window._ltxCopiedSegmentType = this.selectionType;

            // Keep image/video elements
            if (seg.imgObj) window._ltxCopiedSegment.main.imgObj = seg.imgObj;
            if (seg.videoEl) window._ltxCopiedSegment.main.videoEl = seg.videoEl;

            if (seg.id.endsWith("_v") || seg.id.endsWith("_a")) {
              const isVid = seg.id.endsWith("_v");
              const sibId = isVid ? seg.id.slice(0, -2) + "_a" : seg.id.slice(0, -2) + "_v";
              const sibArr = isVid ? this.timeline.audioSegments : this.timeline.segments;
              const sib = sibArr.find(s => s.id === sibId);
              if (sib) {
                window._ltxCopiedSegment.sibling = { ...sib };
                if (sib.imgObj) window._ltxCopiedSegment.sibling.imgObj = sib.imgObj;
                if (sib.videoEl) window._ltxCopiedSegment.sibling.videoEl = sib.videoEl;
              }
            }
          }
        }
      } else if ((e.key === "v" || e.key === "V") && isCtrl && this._isHovering) {
        if (window._ltxCopiedSegment) {
          this.pasteCopiedSegment();
          e.stopPropagation();
          e.stopImmediatePropagation();
          e.preventDefault();
        }
      } else if ((e.key === "s" || e.key === "S") && !isCtrl && this._isHovering) {
        this.isSnapping = !this.isSnapping;
        this.node.properties.isSnapping = this.isSnapping;
        if (typeof this.updateSnapStyle === "function") {
          this.updateSnapStyle();
        }
        this.commitChanges();
        this.render();
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
      } else if ((e.key === "i" || e.key === "I") && !isCtrl && this._isHovering) {
        this.setStartAtPlayhead();
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
      } else if ((e.key === "o" || e.key === "O") && !isCtrl && this._isHovering) {
        this.setEndAtPlayhead();
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
      } else if ((e.key === "x" || e.key === "X") && !isCtrl && this._isHovering) {
        this.markCurrentSelection();
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", this.handleKeyDown, true);

    this.handlePaste = (e) => {
      if (this._isHovering) {
        const activeTag = document.activeElement ? document.activeElement.tagName : "";
        if (activeTag === "INPUT" || activeTag === "TEXTAREA") return;

        if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length > 0) {
          const imageFiles = Array.from(e.clipboardData.files).filter(f => f.type.startsWith("image/"));
          if (imageFiles.length > 0) {
            this.handleImageUpload(imageFiles, this.currentFrame);
            e.preventDefault();
            e.stopPropagation();
          }
        }
      }
    };
    window.addEventListener("paste", this.handlePaste, true);

    // --- Toolbar ---
    const toolbar = document.createElement("div");
    toolbar.className = "pr-toolbar";
    this.toolbarEl = toolbar;

    const actionGroup = document.createElement("div");
    actionGroup.className = "pr-actions";

    this.fileInput = document.createElement("input");
    this.fileInput.type = "file";
    this.fileInput.accept = "image/*";
    this.fileInput.multiple = true;
    this.fileInput.style.display = "none";
    this.fileInput.addEventListener("change", (e) => {
      if (this.isH3MultiMode && this.isH3MultiMode()) {
        this.h3AddRefImages(Array.from(e.target.files || []));
        e.target.value = "";
        return;
      }
      this.handleImageUpload(e.target.files);
    });

    this.audioFileInput = document.createElement("input");
    this.audioFileInput.type = "file";
    this.audioFileInput.accept = "audio/*";
    this.audioFileInput.multiple = true;
    this.audioFileInput.style.display = "none";
    this.audioFileInput.addEventListener("change", (e) => {
      if (this.isH3MultiMode && this.isH3MultiMode()) {
        this.h3AddRefAudios(Array.from(e.target.files || []));
        e.target.value = "";
        return;
      }
      this.handleAudioUpload(e.target.files);
    });

    this.motionFileInput = document.createElement("input");
    this.motionFileInput.type = "file";
    this.motionFileInput.accept = "video/*";
    this.motionFileInput.multiple = true;
    this.motionFileInput.style.display = "none";
    this.motionFileInput.addEventListener("change", (e) => {
      if (this.isH3MultiMode && this.isH3MultiMode()) {
        this.h3AddRefVideos(Array.from(e.target.files || []));
        e.target.value = "";
        return;
      }
      this.handleMotionUpload(e.target.files);
    });

    this.videoFileInput = document.createElement("input");
    this.videoFileInput.type = "file";
    this.videoFileInput.accept = "video/*";
    this.videoFileInput.multiple = true;
    this.videoFileInput.style.display = "none";
    this.videoFileInput.addEventListener("change", (e) => this.handleVideoUpload(e.target.files));

    const uploadBtn = document.createElement("button");
    uploadBtn.className = "pr-btn";
    uploadBtn.innerHTML = `${ICONS.upload} 添加图片`;
    uploadBtn.title = "添加图片";
    uploadBtn.addEventListener("click", () => {
      if (this.isH3MultiMode && this.isH3MultiMode()) {
        this.promptAddH3RefImage();
        return;
      }
      this.fileInput.click();
    });
    this.uploadBtn = uploadBtn;

    const uploadAudioBtn = document.createElement("button");
    uploadAudioBtn.className = "pr-btn";
    uploadAudioBtn.innerHTML = `${ICONS.audio} 添加音频`;
    uploadAudioBtn.title = "添加音频";
    uploadAudioBtn.addEventListener("click", () => {
      if (this.isH3MultiMode && this.isH3MultiMode()) {
        this.promptAddH3RefAudio();
        return;
      }
      this.audioFileInput.click();
    });
    this.uploadAudioBtn = uploadAudioBtn;

    const uploadMotionBtn = document.createElement("button");
    uploadMotionBtn.className = "pr-btn";
    uploadMotionBtn.innerHTML = `${ICONS.motion} 添加参考视频`;
    uploadMotionBtn.title = "添加参考视频";
    uploadMotionBtn.addEventListener("click", () => {
      if (this.isH3MultiMode && this.isH3MultiMode()) {
        this.promptAddH3RefVideo();
        return;
      }
      this.motionFileInput.click();
    });
    this.uploadMotionBtn = uploadMotionBtn;

    const uploadVideoBtn = document.createElement("button");
    uploadVideoBtn.className = "pr-btn";
    uploadVideoBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg> 添加视频`;
    uploadVideoBtn.title = "添加视频";
    uploadVideoBtn.addEventListener("click", () => {
      this.videoFileInput.click();
    });
    this.uploadVideoBtn = uploadVideoBtn;

    const addTextBtn = document.createElement("button");
    addTextBtn.className = "pr-btn";
    addTextBtn.innerHTML = `${ICONS.text} 添加文字`;
    addTextBtn.title = "添加文字段（文生视频）";
    addTextBtn.addEventListener("click", () => this.addTextSegmentFreeSpace());
    this.addTextBtn = addTextBtn;

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "pr-btn pr-btn-danger";
    deleteBtn.innerHTML = `${ICONS.trash} 删除`;
    deleteBtn.title = "删除选中片段";
    deleteBtn.addEventListener("click", () => this.deleteSelectedSegment());
    this.deleteBtn = deleteBtn;

    actionGroup.appendChild(this.fileInput);
    actionGroup.appendChild(this.videoFileInput);
    actionGroup.appendChild(this.audioFileInput);
    actionGroup.appendChild(this.motionFileInput);
    // 默认分镜顺序；多参时由 applyH3ToolbarButtons 重排
    actionGroup.appendChild(uploadBtn);
    actionGroup.appendChild(addTextBtn);
    actionGroup.appendChild(uploadVideoBtn);
    actionGroup.appendChild(uploadAudioBtn);
    actionGroup.appendChild(uploadMotionBtn);
    actionGroup.appendChild(deleteBtn);
    uploadAudioBtn.style.display = "none";
    uploadMotionBtn.style.display = "none";
    this.uploadAudioBtn = uploadAudioBtn;
    this.uploadMotionBtn = uploadMotionBtn;
    this.actionGroup = actionGroup;

    // Retake-mode-only delete button (shown next to Add Video when retakeMode is on)
    const deleteRetakeBtn = document.createElement("button");
    deleteRetakeBtn.className = "pr-btn pr-btn-danger";
    deleteRetakeBtn.innerHTML = `${ICONS.trash} 删除`;
    deleteRetakeBtn.title = "删除重拍视频";
    deleteRetakeBtn.style.display = "none"; // hidden until retakeMode + video loaded
    deleteRetakeBtn.addEventListener("click", () => {
      this._deleteRetakeVideo();
    });
    this.deleteRetakeBtn = deleteRetakeBtn;
    actionGroup.appendChild(deleteRetakeBtn);

    // H3：分镜/多参 = 与「添加图片」同一行、同一套 pr-btn（横排，不包一层组）
    if (this.isH3Director) {
      const storyBtn = document.createElement("button");
      storyBtn.type = "button";
      storyBtn.className = "pr-btn pr-btn-mode active";
      storyBtn.textContent = "分镜";
      storyBtn.title = "分镜页面";
      storyBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.setH3WorkspaceMode("分镜");
      });

      const refBtn = document.createElement("button");
      refBtn.type = "button";
      refBtn.className = "pr-btn pr-btn-mode";
      refBtn.textContent = "多参";
      refBtn.title = "多参页面";
      refBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.setH3WorkspaceMode("多参");
      });

      actionGroup.appendChild(storyBtn);
      actionGroup.appendChild(refBtn);
      this.h3ModeStoryBtn = storyBtn;
      this.h3ModeRefBtn = refBtn;
    }

    toolbar.appendChild(actionGroup);

    const rightGroup = document.createElement("div");
    rightGroup.className = "pr-right-group";

    this.segmentBoundsDisplay = document.createElement("div");
    this.segmentBoundsDisplay.className = "pr-segment-bounds";
    this.segmentBoundsDisplay.textContent = "开始: - | 结束: - | 长度: -";

    this.timeCodeDisplay = document.createElement("div");
    this.timeCodeDisplay.className = "pr-timecode";
    this.timeCodeDisplay.textContent = this.formatTime(0);

    const settingsBtn = document.createElement("button");
    settingsBtn.className = "pr-btn";
    settingsBtn.style.padding = "6px";
    settingsBtn.style.display = "flex";
    settingsBtn.style.alignItems = "center";
    settingsBtn.style.justifyContent = "center";
    settingsBtn.style.width = "28px";
    settingsBtn.style.height = "28px";
    settingsBtn.style.boxSizing = "border-box";
    settingsBtn.innerHTML = ICONS.gear;
    settingsBtn.title = "设置";
    settingsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this._settingsMenu) {
        this.dismissSettingsMenu();
      } else {
        this.showSettingsMenu(settingsBtn);
      }
    });

    const inpaintToggleBtn = document.createElement("button");
    inpaintToggleBtn.className = "pr-btn";
    inpaintToggleBtn.style.padding = "4px 0px";
    inpaintToggleBtn.style.fontSize = "9px";
    inpaintToggleBtn.style.lineHeight = "1";
    inpaintToggleBtn.style.marginRight = "0px";
    inpaintToggleBtn.style.marginTop = "8px"; // Adjust this value to fine-tune spacing between the title and button
    inpaintToggleBtn.style.width = "72px";
    inpaintToggleBtn.style.whiteSpace = "nowrap";
    inpaintToggleBtn.style.textAlign = "center";
    inpaintToggleBtn.style.justifyContent = "center";
    inpaintToggleBtn.style.alignItems = "center";
    inpaintToggleBtn.style.gap = "0px";
    inpaintToggleBtn.style.boxSizing = "border-box";
    inpaintToggleBtn.style.borderRadius = "2px";
    inpaintToggleBtn.textContent = "补全: 开";
    inpaintToggleBtn.title = "切换音频空隙补全";

    this.updateInpaintToggleStyle = (isOn) => {
      inpaintToggleBtn.textContent = isOn ? "补全: 开" : "补全: 关";
      if (isOn) {
        inpaintToggleBtn.classList.add("toggle-on");
      } else {
        inpaintToggleBtn.classList.remove("toggle-on");
      }
    };

    this.syncInpaintState = () => {
      const customAudioWidget = this.node.widgets?.find(w => w.name === "use_custom_audio");
      if (customAudioWidget && !customAudioWidget.value) {
        inpaintToggleBtn.disabled = true;
        inpaintToggleBtn.style.opacity = "0.4";
        inpaintToggleBtn.style.cursor = "default";
        inpaintToggleBtn.title = "需要先开启时间线音频";
      } else {
        inpaintToggleBtn.disabled = false;
        inpaintToggleBtn.style.opacity = "1.0";
        inpaintToggleBtn.style.cursor = "pointer";
        inpaintToggleBtn.title = "切换音频空隙补全";
      }
    };



    inpaintToggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (inpaintToggleBtn.disabled) return;
      const widget = this.node.widgets?.find(w => w.name === "inpaint_audio");
      if (widget) {
        widget.value = !widget.value;
        if (this.node.properties) {
          this.node.properties.inpaint_audio = widget.value;
        }
        this.updateInpaintToggleStyle(widget.value);
        this.commitChanges(true);
        this.node.setDirtyCanvas(true, true);
      }
    });

    // Initial state check (widgets might not be ready immediately)
    setTimeout(() => {
      const inpaintWidget = this.node.widgets?.find(w => w.name === "inpaint_audio");
      if (inpaintWidget) {
        this.updateInpaintToggleStyle(inpaintWidget.value);
      }
    }, 100);

    const overrideAudioToggleBtn = document.createElement("button");
    overrideAudioToggleBtn.className = "pr-btn";
    overrideAudioToggleBtn.style.padding = "4px 0px";
    overrideAudioToggleBtn.style.fontSize = "9px";
    overrideAudioToggleBtn.style.lineHeight = "1";
    overrideAudioToggleBtn.style.marginRight = "0px";
    overrideAudioToggleBtn.style.marginTop = "8px"; // Adjust this value to fine-tune spacing between the title and button
    overrideAudioToggleBtn.style.width = "72px";
    overrideAudioToggleBtn.style.whiteSpace = "nowrap";
    overrideAudioToggleBtn.style.textAlign = "center";
    overrideAudioToggleBtn.style.justifyContent = "center";
    overrideAudioToggleBtn.style.alignItems = "center";
    overrideAudioToggleBtn.style.gap = "0px";
    overrideAudioToggleBtn.style.boxSizing = "border-box";
    overrideAudioToggleBtn.style.borderRadius = "2px";
    overrideAudioToggleBtn.textContent = "音频: 关";
    overrideAudioToggleBtn.title = "使用参考视频中的音频";

    this.updateOverrideAudioToggleStyle = (isOn) => {
      overrideAudioToggleBtn.textContent = isOn ? "音频: 开" : "音频: 关";
      if (isOn) {
        overrideAudioToggleBtn.classList.add("toggle-on");
      } else {
        overrideAudioToggleBtn.classList.remove("toggle-on");
      }
    };

    overrideAudioToggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (overrideAudioToggleBtn.disabled) return;
      const widget = this.node.widgets?.find(w => w.name === "override_audio");
      if (widget) {
        widget.value = !widget.value;
        this.node.properties.overrideAudio = widget.value;
        this.timeline.overrideAudio = widget.value;
        this.updateOverrideAudioToggleStyle(widget.value);

        if (widget.value) {
          // When this is toggled on, the audio track will automatically be disabled/muted.
          this._audioTrackWasEnabledBeforeOverride = this.audioTrackEnabled;
          this.audioTrackEnabled = false;
          updateTrackIcon(this.audioTrackLabel._eyeBtn, "audio", false);

          const customAudioWidget = this.node.widgets?.find(w => w.name === "use_custom_audio");
          if (customAudioWidget) {
            customAudioWidget.value = false;
            if (this.updateToggleStyle) this.updateToggleStyle(false);
          }

          inpaintToggleBtn.disabled = true;
          inpaintToggleBtn.style.opacity = "0.3";

          if (this.timeline.motionSegments) {
            for (const seg of this.timeline.motionSegments) {
              if (seg.type === "motion_video") {
                this._preloadMotionAudioSegment(seg);
              }
            }
          }
        } else {
          // When toggled off, restore the audio track status if it was previously enabled
          if (this._audioTrackWasEnabledBeforeOverride) {
            this.audioTrackEnabled = true;
            updateTrackIcon(this.audioTrackLabel._eyeBtn, "audio", true);

            const customAudioWidget = this.node.widgets?.find(w => w.name === "use_custom_audio");
            if (customAudioWidget) {
              customAudioWidget.value = true;
              if (this.updateToggleStyle) this.updateToggleStyle(true);
            }

            inpaintToggleBtn.disabled = false;
            inpaintToggleBtn.style.opacity = "1.0";
          }
          this._audioTrackWasEnabledBeforeOverride = false;
        }

        this.commitChanges(true);
        this.render();
      }
    });

    // Initial state check (widgets might not be ready immediately)
    setTimeout(() => {
      const overrideWidget = this.node.widgets?.find(w => w.name === "override_audio");
      if (overrideWidget) {
        this.updateOverrideAudioToggleStyle(overrideWidget.value);
      }
    }, 100);

    const helpBtn = document.createElement("button");
    helpBtn.className = "pr-btn";
    helpBtn.style.padding = "4px 8px";
    helpBtn.style.display = "flex";
    helpBtn.style.alignItems = "center";
    helpBtn.style.justifyContent = "center";
    helpBtn.style.minWidth = "40px";
    helpBtn.style.height = "28px";
    helpBtn.style.boxSizing = "border-box";
    helpBtn.style.fontSize = "12px";
    helpBtn.style.fontWeight = "600";
    helpBtn.style.whiteSpace = "nowrap";
    helpBtn.textContent = "说明";
    helpBtn.title = "使用说明";
    helpBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.showLazyHelpDialog();
    });

    this.isSnapping = this.node.properties.isSnapping !== false;

    const snapBtn = document.createElement("button");
    snapBtn.className = "pr-btn";
    snapBtn.style.padding = "6px";
    snapBtn.style.display = "flex";
    snapBtn.style.alignItems = "center";
    snapBtn.style.justifyContent = "center";
    snapBtn.style.width = "28px";
    snapBtn.style.height = "28px";
    snapBtn.style.boxSizing = "border-box";
    snapBtn.innerHTML = ICONS.magnet;

    const updateSnapStyle = () => {
      snapBtn.title = this.isSnapping ? "关闭吸附" : "开启吸附";
      if (this.isSnapping) {
        snapBtn.classList.add("toggle-on");
      } else {
        snapBtn.classList.remove("toggle-on");
      }
    };
    this.updateSnapStyle = updateSnapStyle;
    updateSnapStyle();

    snapBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.isSnapping = !this.isSnapping;
      this.node.properties.isSnapping = this.isSnapping;
      updateSnapStyle();
      this.commitChanges();
      this.render();
    });

    const startBtn = document.createElement("button");
    startBtn.className = "pr-btn";
    startBtn.style.padding = "6px";
    startBtn.style.display = "flex";
    startBtn.style.alignItems = "center";
    startBtn.style.justifyContent = "center";
    startBtn.style.width = "28px";
    startBtn.style.height = "28px";
    startBtn.style.boxSizing = "border-box";
    startBtn.innerHTML = ICONS.start;
    startBtn.title = "将播放头设为起始";
    startBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.retakeMode) return;
      this.setStartAtPlayhead();
    });

    const endBtn = document.createElement("button");
    endBtn.className = "pr-btn";
    endBtn.style.padding = "6px";
    endBtn.style.display = "flex";
    endBtn.style.alignItems = "center";
    endBtn.style.justifyContent = "center";
    endBtn.style.width = "28px";
    endBtn.style.height = "28px";
    endBtn.style.boxSizing = "border-box";
    endBtn.innerHTML = ICONS.end;
    endBtn.title = "将播放头设为结束";
    endBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.retakeMode) return;
      this.setEndAtPlayhead();
    });

    const markBtn = document.createElement("button");
    markBtn.className = "pr-btn";
    markBtn.style.padding = "6px";
    markBtn.style.display = "flex";
    markBtn.style.alignItems = "center";
    markBtn.style.justifyContent = "center";
    markBtn.style.width = "28px";
    markBtn.style.height = "28px";
    markBtn.style.boxSizing = "border-box";
    markBtn.innerHTML = ICONS.mark;
    markBtn.title = "标记选区 (X)";
    markBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.retakeMode) return;
      this.markCurrentSelection();
    });

    // 重拍模式已从产品移除（Wan Remix 出片不用）
    this.retakeMode = false;
    if (this.timeline) this.timeline.retakeMode = false;
    if (this.node.properties) this.node.properties.retakeMode = false;
    this.updateRetakeStyle = () => {};

    const btnGroup = document.createElement("div");
    btnGroup.style.display = "flex";
    btnGroup.style.gap = "6px";
    btnGroup.style.alignItems = "center";
    // 不再挂载「重拍模式」按钮
    btnGroup.appendChild(snapBtn);
    btnGroup.appendChild(startBtn);
    btnGroup.appendChild(endBtn);
    btnGroup.appendChild(markBtn);
    btnGroup.appendChild(helpBtn);
    btnGroup.appendChild(settingsBtn);
    rightGroup.appendChild(btnGroup);

    toolbar.appendChild(rightGroup);

    // --- Canvas & Viewport ---
    this.viewport = document.createElement("div");
    this.viewport.className = "pr-timeline-viewport";

    this.viewport.addEventListener("wheel", (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();

        let zoomDelta = e.deltaY > 0 ? -0.5 : 0.5;
        this.zoomLevel = Math.max(1, Math.min(this.getMaxZoom(), this.zoomLevel + zoomDelta));
        if (this.zoomSlider) this.zoomSlider.value = this.zoomLevel;

        const oldWidth = this.canvas.offsetWidth;
        const newWidth = this.viewport.clientWidth * this.zoomLevel;
        const mouseX = e.clientX - this.viewport.getBoundingClientRect().left;
        const scrollRatio = (this.viewport.scrollLeft + mouseX) / oldWidth;

        this.canvas.style.width = newWidth + "px";
        this.resizeCanvas(newWidth);
        this._lastWidth = this.viewport.clientWidth;
        this._lastZoom = this.zoomLevel;
        this.viewport.scrollLeft = scrollRatio * newWidth - mouseX;

        if (this.node) this.node.setDirtyCanvas?.(true, true);
        else if (window.app && window.app.graph) window.app.graph.setDirtyCanvas(true, true);
      }
    }, { passive: false, capture: true });

    this.canvas = document.createElement("canvas");
    this.canvas.className = "pr-canvas";
    this.ctx = this.canvas.getContext("2d");
    this.canvas.style.width = "100%";

    this.viewport.style.position = "relative";
    this.viewport.appendChild(this.canvas);

    // H3 多参图：隐藏 file input（画布轨 + / 拖入）
    if (this.isH3Director) {
      const fileIn = document.createElement("input");
      fileIn.type = "file";
      fileIn.accept = "image/*";
      fileIn.multiple = true;
      fileIn.style.display = "none";
      fileIn.addEventListener("change", async (e) => {
        const files = Array.from(e.target.files || []);
        e.target.value = "";
        const start = this._h3RefTargetIndex;
        this._h3RefTargetIndex = undefined;
        await this.h3AddRefImages(files, start);
      });
      this.h3RefImageInput = fileIn;
      this.wrapper?.appendChild?.(fileIn);
      // wrapper 可能尚未创建，稍后挂到 container
      this._pendingH3FileIn = fileIn;
    }

    this.canvas.addEventListener("mousedown", (e) => this.onMouseDown(e));
    this.canvas.addEventListener("contextmenu", (e) => this.onContextMenu(e));
    this.canvas.style.height = `${CANVAS_HEIGHT}px`;

    // --- Content Area Container ---
    if (!this.node.properties) this.node.properties = {};
    if (this.node.properties.showFilenames === undefined) {
      this.node.properties.showFilenames = (this.timeline.showFilenames !== undefined) ? this.timeline.showFilenames : true;
    }
    if (this.node.properties.overrideAudio === undefined) {
      this.node.properties.overrideAudio = (this.timeline.overrideAudio !== undefined) ? this.timeline.overrideAudio : false;
    }
    if (this.node.properties.propHeight === undefined && this.timeline.propHeight !== undefined) {
      this.node.properties.propHeight = this.timeline.propHeight;
    }
    this.initialPropHeight = this.node.properties.propHeight || 90;
    this.propHeight = this.initialPropHeight;

    const propContainer = document.createElement("div");
    propContainer.className = "pr-prop-container";
    propContainer.style.position = "relative";
    propContainer.style.flex = "none";
    propContainer.style.height = `${this.propHeight}px`;
    propContainer.style.marginBottom = "5px"; // Add some spacing between the two prompt boxes
    this.propContainer = propContainer;

    if (this.node.properties.globalPropHeight === undefined && this.timeline.globalPropHeight !== undefined) {
      this.node.properties.globalPropHeight = this.timeline.globalPropHeight;
    }
    if (!this.node.properties.globalPropHeight) this.node.properties.globalPropHeight = 60;
    this.globalPropHeight = this.node.properties.globalPropHeight;

    const globalPropContainer = document.createElement("div");
    globalPropContainer.className = "pr-prop-container";
    globalPropContainer.style.position = "relative";
    globalPropContainer.style.flex = "none";
    globalPropContainer.style.height = `${this.globalPropHeight}px`;
    this.globalPropContainer = globalPropContainer;

    const globalPromptWrapper = document.createElement("div");
    globalPromptWrapper.className = "pr-prompt-wrapper";
    globalPromptWrapper.style.width = "100%";
    globalPromptWrapper.style.height = "100%";

    this.globalPromptLabel = document.createElement("div");
    this.globalPromptLabel.className = "pr-prompt-label";
    this.globalPromptLabel.textContent = "全局提示词";
    globalPromptWrapper.appendChild(this.globalPromptLabel);

    this.globalPromptInput = document.createElement("textarea");
    this.globalPromptInput.className = "pr-prompt-area";
    this.globalPromptInput.placeholder = "在此输入全局提示词...";
    this.globalPromptInput.spellcheck = false;
    globalPromptWrapper.appendChild(this.globalPromptInput);

    this.globalPromptInput.addEventListener("focus", () => {
      globalPromptWrapper.classList.add("focus-active");
      this.wrapper.classList.add("has-focus");
    });
    this.globalPromptInput.addEventListener("blur", () => {
      globalPromptWrapper.classList.remove("focus-active");
      this.wrapper.classList.remove("has-focus");
    });
    let saveTimeout = null;
    const triggerAutoSave = () => {
      try {
        const canvasEl = app.canvasEl || app.canvas?.canvas;
        if (canvasEl) {
          canvasEl.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
        }
        if (app.canvas && app.canvas.checkState) app.canvas.checkState();
        if (app.canvas && app.canvas.captureCanvasState) app.canvas.captureCanvasState();
      } catch (_) { }
    };

    this.globalPromptInput.addEventListener("input", (e) => {
      const val = e.target.value;
      this.syncGlobalPrompt(val);

      if (this.selectionType === "motion") {
        this.promptInput.value = val;
      }
      this.commitChanges(true);
      this.render();

      // Debounce ComfyUI auto-save by 300ms to avoid lag while typing
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = setTimeout(triggerAutoSave, 300);
    });

    this.globalPromptInput.addEventListener("blur", () => {
      if (saveTimeout) clearTimeout(saveTimeout);
      triggerAutoSave();
    });

    const globalPropResizer = document.createElement("div");
    globalPropResizer.style.position = "absolute";
    globalPropResizer.style.bottom = "0px";
    globalPropResizer.style.left = "0px";
    globalPropResizer.style.width = "100%";
    globalPropResizer.style.height = "12px"; // Hit area
    globalPropResizer.style.cursor = "ns-resize";
    globalPropResizer.style.display = "flex";
    globalPropResizer.style.justifyContent = "center";
    globalPropResizer.style.alignItems = "flex-end";
    globalPropResizer.style.paddingBottom = "4px";
    globalPropResizer.style.zIndex = "10";
    globalPropResizer.innerHTML = `<div style="width: 40px; height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px;"></div>`;

    let isGlobalResizing = false;
    let startGlobalY = 0;
    let startGlobalH = 0;

    globalPropResizer.addEventListener("mousedown", (ev) => {
      isGlobalResizing = true;
      startGlobalY = ev.clientY;
      startGlobalH = this.globalPropHeight;
      ev.stopPropagation();
      ev.preventDefault();
    });

    document.addEventListener("mousemove", (ev) => {
      if (isGlobalResizing) {
        const newH = Math.max(60, startGlobalH + (ev.clientY - startGlobalY));
        this.globalPropHeight = newH;
        this.node.properties.globalPropHeight = newH;
        globalPropContainer.style.height = `${newH}px`;

        if (this.node && this.node.computeSize) {
          const sz = this.node.computeSize();
          this.node.size[1] = sz[1];
          if (window.app && window.app.graph) {
            window.app.graph.setDirtyCanvas(true, true);
          }
        }
      }
    });

    document.addEventListener("mouseup", () => {
      if (isGlobalResizing) {
        isGlobalResizing = false;
      }
    });

    globalPropContainer.appendChild(globalPromptWrapper);
    globalPropContainer.appendChild(globalPropResizer);

    const propResizer = document.createElement("div");
    propResizer.style.position = "absolute";
    propResizer.style.bottom = "0px";
    propResizer.style.left = "0px";
    propResizer.style.width = "100%";
    propResizer.style.height = "12px"; // Hit area
    propResizer.style.cursor = "ns-resize";
    propResizer.style.display = "flex";
    propResizer.style.justifyContent = "center";
    propResizer.style.alignItems = "flex-end";
    propResizer.style.paddingBottom = "4px";
    propResizer.innerHTML = `<div style="width: 40px; height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px;"></div>`;

    propResizer.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = this.propHeight;

      const doDrag = (ev) => {
        if (ev.buttons === 0) {
          stopDrag();
          return;
        }
        const newH = Math.max(90, startH + (ev.clientY - startY));
        this.propHeight = newH;
        this.node.properties.propHeight = newH;
        propContainer.style.height = `${newH}px`;

        if (this.node && this.node.computeSize) {
          const sz = this.node.computeSize();
          this.node.size[1] = sz[1];
          if (window.app && window.app.graph) {
            window.app.graph.setDirtyCanvas(true, true);
          }
        }
      };

      const stopDrag = () => {
        window.removeEventListener("mousemove", doDrag, true);
        window.removeEventListener("mouseup", stopDrag, true);
        document.body.style.cursor = "default";
      };

      document.body.style.cursor = "ns-resize";
      window.addEventListener("mousemove", doDrag, true);
      window.addEventListener("mouseup", stopDrag, true);
    });

    // --- Text Area (Image/Text) ---
    this.promptWrapper = document.createElement("div");
    this.promptWrapper.className = "pr-prompt-wrapper";
    this.promptWrapper.style.width = "100%";
    this.promptWrapper.style.height = "100%";
    this.promptWrapper.style.display = "none";

    this.segmentPromptLabel = document.createElement("div");
    this.segmentPromptLabel.className = "pr-prompt-label";
    this.segmentPromptLabel.textContent = "分段提示词";
    this.promptWrapper.appendChild(this.segmentPromptLabel);

    this.promptInput = document.createElement("textarea");
    this.promptInput.className = "pr-prompt-area";
    this.promptInput.placeholder = "未选中片段";
    this.promptInput.style.opacity = "0.4";
    this.promptWrapper.appendChild(this.promptInput);

    this.promptInput.addEventListener("focus", () => {
      this.promptWrapper.classList.add("focus-active");
      this.wrapper.classList.add("has-focus");
    });
    this.promptInput.addEventListener("blur", () => {
      this.promptWrapper.classList.remove("focus-active");
      this.wrapper.classList.remove("has-focus");
    });

    this.promptInput.addEventListener("input", () => {
      if (this.retakeMode) {
        this.timeline.retakePrompt = this.promptInput.value;
        this.commitChanges();
        return;
      }
      if (this.selectionType === "image" && this.timeline.segments[this.selectedIndex]) {
        this.timeline.segments[this.selectedIndex].prompt = this.promptInput.value;
        this.commitChanges();
      } else if (this.selectionType === "motion") {
        const val = this.promptInput.value;
        if (this.globalPromptInput) {
          this.globalPromptInput.value = val;
        }
        this.syncGlobalPrompt(val);
        this.commitChanges(true);
        this.render();

        // Debounce ComfyUI auto-save by 300ms to avoid lag while typing
        if (saveTimeout) clearTimeout(saveTimeout);
        saveTimeout = setTimeout(triggerAutoSave, 300);
      }
    });

    // --- Motion Info Area ---
    this.motionInfoArea = document.createElement("div");
    this.motionInfoArea.className = "pr-motion-info";

    // --- Audio Info Area ---
    this.audioInfoArea = document.createElement("div");
    this.audioInfoArea.className = "pr-audio-info";

    propContainer.appendChild(this.promptWrapper);
    propContainer.appendChild(this.motionInfoArea);
    propContainer.appendChild(this.audioInfoArea);
    propContainer.appendChild(propResizer);

    this.wrapper.addEventListener("dragover", (e) => {
      e.preventDefault();
      this.wrapper.classList.add("drag-active");

      if (this.retakeMode) {
        return; // Skip ghost segments rendering when in retakeMode
      }

      const { x, y } = this.getMousePos(e);
      const logicalWidth = this.canvas.offsetWidth;
      const totalFrames = this.getVisualDurationFrames();
      if (!logicalWidth || totalFrames <= 0) return;

      const trackType = this.getTrackFromY(y);
      // H3：图/参考音/参考视频/驱动音槽轨 — Drop 提示
      if (
        this.isH3Director &&
        (trackType === "ref" ||
          trackType === "ref_audio" ||
          trackType === "audio" ||
          trackType === "motion")
      ) {
        e.dataTransfer.dropEffect = "copy";
        this._ghostSegmentId = "GHOST_MULTI";
        this._ghostTrack = trackType;
        this._ghostInitialTimeline = null;
        this._previewSegments = null;
        this._refDropGhost =
          trackType === "ref"
            ? { mouseX: x, start: 0, length: 24 }
            : null;
        this._multiDropTrack = trackType;
        this.render();
        return;
      }

      // 离开多参槽轨时清掉提示
      this._refDropGhost = null;
      this._multiDropTrack = null;

      const arrToModify = this.getSegmentArray(trackType);
      if (!arrToModify) return;

      if (!this._ghostSegmentId || this._ghostTrack !== trackType || this._ghostTrack === "ref") {
        this._ghostSegmentId = "GHOST_" + Date.now();
        this._ghostTrack = trackType;
        this._ghostInitialTimeline = arrToModify.map(s => ({ ...s }));

        const frameRate = this.getFrameRate();
        const newLength = Math.max(1, frameRate * 1);

        let mouseFrameX = x * (totalFrames / logicalWidth);
        let startFrame = clamp(Math.round(mouseFrameX - newLength / 2), 0, totalFrames - newLength);

        this._ghostInitialTimeline.push({
          id: this._ghostSegmentId,
          start: startFrame,
          length: newLength,
          type: "ghost"
        });
      }

      let mouseFrameX = x * (totalFrames / logicalWidth);
      const ghost = this._ghostInitialTimeline.find(s => s.id === this._ghostSegmentId);
      if (!ghost) return;
      let D_mouse_start = mouseFrameX - ghost.length / 2;

      this._previewSegments = this._applyCenterDragPhysics(
        this._ghostInitialTimeline,
        this._ghostSegmentId,
        D_mouse_start,
        mouseFrameX,
        totalFrames,
        totalFrames,
        logicalWidth
      );

      for (let ps of this._previewSegments) {
        const orig = arrToModify.find(s => s.id === ps.id);
        if (orig) {
          ps.videoEl = orig.videoEl;
          ps.imgObj = orig.imgObj;
          if (orig.thumbnails) ps.thumbnails = orig.thumbnails;
        }
      }

      this.render();
    });

    this.wrapper.addEventListener("dragleave", (e) => {
      const rect = this.wrapper.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX >= rect.right ||
        e.clientY < rect.top || e.clientY >= rect.bottom) {
        this.wrapper.classList.remove("drag-active");
        this._ghostSegmentId = null;
        this._ghostTrack = null;
        this._ghostInitialTimeline = null;
        this._previewSegments = null;
        this._refDropGhost = null;
        this._multiDropTrack = null;
        this.render();
      }
    });

    this.wrapper.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.wrapper.classList.remove("drag-active");

      let targetFrameStart = null;
      let targetTrack = this._ghostTrack || "image";

      // 优先按鼠标 Y 判断是否多参图轨
      try {
        const { y: dropY } = this.getMousePos(e);
        if (this.getRefTrackHeight() > 0 && this.getTrackFromY(dropY) === "ref") {
          targetTrack = "ref";
        }
      } catch (_) {}

      if (this._ghostSegmentId && this._previewSegments) {
        const ghost = this._previewSegments.find(s => s.id === this._ghostSegmentId);
        if (ghost) {
          targetFrameStart = ghost.resolvedStart !== undefined ? ghost.resolvedStart : ghost.start;
        }
      }
      this._ghostSegmentId = null;
      this._ghostTrack = null;
      this._ghostInitialTimeline = null;
      this._previewSegments = null;
      this._refDropGhost = null;
      this._multiDropTrack = null;
      this.render();

      // H3：按轨分流（分镜也可拖驱动音）
      if (this.isH3Director) {
        try {
          const { y: dy } = this.getMousePos(e);
          const tt = this.getTrackFromY(dy);
          if (tt === "ref" || tt === "ref_audio" || tt === "audio" || tt === "motion") {
            targetTrack = tt;
          }
        } catch (_) {}
        const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|tiff?|avif)$/i;
        const AUDIO_RE = /\.(mp3|wav|ogg|flac|m4a|aac|wma)$/i;
        const VIDEO_RE = /\.(mp4|webm|mkv|avi|mov|m4v|flv|wmv)$/i;
        const imageFiles = [];
        const audioFiles = [];
        const videoFiles = [];
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          for (const file of e.dataTransfer.files) {
            const name = file.name || "";
            if (file.type.startsWith("video/") || VIDEO_RE.test(name)) videoFiles.push(file);
            else if (file.type.startsWith("audio/") || AUDIO_RE.test(name)) audioFiles.push(file);
            else if (file.type.startsWith("image/") || IMAGE_RE.test(name)) imageFiles.push(file);
          }
        }
        const multi = this.isH3MultiMode && this.isH3MultiMode();
        if (targetTrack === "audio") {
          if (audioFiles.length) this.h3AddDriveAudios(audioFiles);
          return;
        }
        if (multi && targetTrack === "ref_audio") {
          if (audioFiles.length) this.h3AddRefAudios(audioFiles);
          else {
            const paths = this._extractDroppedMediaPaths(e.dataTransfer) || [];
            const auds = paths.filter((r) => r.kind === "audio");
            if (auds.length) this.h3AddRefAudioPaths(auds);
          }
          return;
        }
        if (multi && targetTrack === "motion") {
          if (videoFiles.length) this.h3AddRefVideos(videoFiles);
          else if (imageFiles.length) this.h3AddRefImages(imageFiles);
          return;
        }
        if (multi && (targetTrack === "image" || !targetTrack)) {
          if (videoFiles.length) {
            this.handleVideoUpload(videoFiles, targetFrameStart);
            return;
          }
          const mediaPaths = this._extractDroppedMediaPaths(e.dataTransfer);
          const vidRefs = (mediaPaths || []).filter((r) => {
            const kind = r.kind || this._guessMediaKind(r.filename || r.imageFile);
            return kind === "video";
          });
          if (vidRefs.length) {
            this.handleMediaPathsDrop(vidRefs, targetFrameStart, "image");
            return;
          }
        }
        if (multi) {
          if (imageFiles.length) this.h3AddRefImages(imageFiles);
          if (audioFiles.length) this.h3AddRefAudios(audioFiles);
          if (videoFiles.length) this.h3AddRefVideos(videoFiles);
          if (imageFiles.length || audioFiles.length || videoFiles.length) return;
          return;
        }
        // 分镜：非驱动轨继续走下方通用逻辑
      }

      // 1) Comfy 侧栏资产：优先 text/uri-list /view 路径（已在服务器，无需重传）
      //    浏览器拖缩略图时可能同时塞进合成 File，不能只认 files
      const mediaPaths = this._extractDroppedMediaPaths(e.dataTransfer);
      const preferAssetPaths = mediaPaths.length > 0 && (
        mediaPaths.some(r => r.fromViewUrl) ||
        (() => {
          try {
            return !!(e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/x-moz-url"));
          } catch (_) {
            return false;
          }
        })() ||
        !(e.dataTransfer.files && e.dataTransfer.files.length)
      );
      if (preferAssetPaths) {
        this.handleMediaPathsDrop(mediaPaths, targetFrameStart, targetTrack);
        return;
      }

      // 2) 本机文件拖入
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const imageFiles = [];
        const audioFiles = [];
        const videoFiles = [];
        const VIDEO_RE = /\.(mp4|webm|mkv|avi|mov|m4v|flv|wmv)$/i;
        const AUDIO_RE = /\.(mp3|wav|ogg|flac|m4a|aac|wma)$/i;
        const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|tiff?|avif)$/i;
        for (let file of e.dataTransfer.files) {
          const name = file.name || "";
          if (file.type.startsWith("video/") || VIDEO_RE.test(name)) videoFiles.push(file);
          else if (file.type.startsWith("audio/") || AUDIO_RE.test(name)) audioFiles.push(file);
          else if (file.type.startsWith("image/") || IMAGE_RE.test(name)) imageFiles.push(file);
        }

        if (videoFiles.length > 0) {
          if (targetTrack === "motion") {
            this.handleMotionUpload(videoFiles, targetFrameStart);
          } else {
            this.handleVideoUpload(videoFiles, targetFrameStart);
          }
        } else if (audioFiles.length > 0 && (targetTrack === "audio" || imageFiles.length === 0)) {
          this.handleAudioUpload(audioFiles, targetFrameStart);
        } else if (imageFiles.length > 0) {
          this.handleImageUpload(imageFiles, targetFrameStart);
        } else if (mediaPaths.length > 0) {
          // files 无有效 MIME 时回退路径
          this.handleMediaPathsDrop(mediaPaths, targetFrameStart, targetTrack);
        }
      }
    });

    window.addEventListener("mousemove", (e) => this.onMouseMove(e));
    window.addEventListener("mouseup", (e) => this.onMouseUp(e));

    // --- Player Controls ---
    const playerControls = document.createElement("div");
    playerControls.className = "pr-player-controls";

    this.playBtn = document.createElement("button");
    this.playBtn.className = "pr-icon-btn";
    this.playBtn.style.padding = "4px";
    this.playBtn.innerHTML = ICONS.play;
    this.playBtn.title = "播放/暂停";
    this.playBtn.addEventListener("click", () => this.togglePlay());

    this.loopBtn = document.createElement("button");
    this.loopBtn.className = "pr-icon-btn";
    this.loopBtn.style.padding = "4px";
    this.loopBtn.innerHTML = ICONS.loop;
    this.loopBtn.title = "循环播放";
    this.loopBtn.addEventListener("click", () => this.toggleLoop());

    this.seekBar = document.createElement("input");
    this.seekBar.type = "range";
    this.seekBar.className = "pr-seek-bar";
    this.seekBar.min = "0";
    this.seekBar.value = "0";
    this.seekBar.style.flex = "1"; // take up remaining space
    this.seekBar.addEventListener("input", (e) => {
      let val = parseInt(e.target.value, 10);
      const maxFrame = this.getPlaybackDurationFrames();
      if (val > maxFrame) {
        val = maxFrame;
        this.seekBar.value = val;
      }
      this.currentFrame = val;
      this.updateSeekBarBackground();
      this.render();
      if (this.isPlaying) {
        this.playAudio();
      }
    });

    // --- Zoom Controls ---
    const zoomControls = document.createElement("div");
    zoomControls.className = "pr-zoom-controls";

    const zoomOutBtn = document.createElement("button");
    zoomOutBtn.className = "pr-icon-btn";
    zoomOutBtn.style.padding = "4px";
    zoomOutBtn.innerHTML = ICONS.minus;
    zoomOutBtn.title = "缩小";
    zoomOutBtn.addEventListener("click", () => {
      const currentZoom = parseFloat(this.zoomSlider.value);
      this.zoomSlider.value = Math.max(1, currentZoom - 0.5);
      this.zoomSlider.dispatchEvent(new Event("input"));
    });

    this.zoomSlider = document.createElement("input");
    this.zoomSlider.type = "range";
    this.zoomSlider.className = "pr-zoom-slider";
    this.zoomSlider.min = "1";
    this.zoomSlider.max = "1"; // Updated dynamically via updateZoomSliderMax()
    this.zoomSlider.step = "0.1";
    this.zoomSlider.value = "1";
    this.zoomSlider.title = "缩放级别";
    this.zoomSlider.addEventListener("input", (e) => {
      this.zoomLevel = parseFloat(e.target.value);

      const viewportWidth = this.viewport.clientWidth;
      const newCanvasWidth = Math.max(viewportWidth, viewportWidth * this.zoomLevel);

      this.canvas.style.width = newCanvasWidth + "px";
      this.resizeCanvas(newCanvasWidth);
      this._lastWidth = viewportWidth;
      this._lastZoom = this.zoomLevel;

      // Keep playhead centered
      const totalFrames = this.getVisualDurationFrames();
      const playheadRatio = this.currentFrame / totalFrames;
      const newPlayheadX = playheadRatio * newCanvasWidth;
      this.viewport.scrollLeft = newPlayheadX - (viewportWidth / 2);

      if (this.node) this.node.setDirtyCanvas?.(true, true);
      else if (window.app && window.app.graph) window.app.graph.setDirtyCanvas(true, true);
    });

    const zoomInBtn = document.createElement("button");
    zoomInBtn.className = "pr-icon-btn";
    zoomInBtn.style.padding = "4px";
    zoomInBtn.innerHTML = ICONS.plus;
    zoomInBtn.title = "放大";
    zoomInBtn.addEventListener("click", () => {
      const currentZoom = parseFloat(this.zoomSlider.value);
      this.zoomSlider.value = Math.min(this.getMaxZoom(), currentZoom + 0.5);
      this.zoomSlider.dispatchEvent(new Event("input"));
    });

    const zoomFitBtn = document.createElement("button");
    zoomFitBtn.className = "pr-icon-btn";
    zoomFitBtn.style.padding = "4px";
    zoomFitBtn.style.marginLeft = "4px";
    zoomFitBtn.innerHTML = ICONS.fit;
    zoomFitBtn.title = "适应窗口（显示完整时间线）";
    zoomFitBtn.addEventListener("click", () => {
      this.zoomLevel = 1;
      this.zoomSlider.value = 1;
      const viewportWidth = this.viewport.clientWidth;
      this.canvas.style.width = viewportWidth + "px";
      this.resizeCanvas(viewportWidth);
      this._lastWidth = viewportWidth;
      this._lastZoom = 1;
      this.viewport.scrollLeft = 0;

      if (this.node) this.node.setDirtyCanvas?.(true, true);
      else if (window.app && window.app.graph) window.app.graph.setDirtyCanvas(true, true);
    });

    zoomControls.appendChild(zoomOutBtn);
    zoomControls.appendChild(this.zoomSlider);
    zoomControls.appendChild(zoomInBtn);
    zoomControls.appendChild(zoomFitBtn);

    playerControls.appendChild(this.playBtn);
    playerControls.appendChild(this.loopBtn);
    playerControls.appendChild(this.seekBar);
    playerControls.appendChild(zoomControls);



    // --- Guide Strength Slider ---
    this.strengthRow = document.createElement("div");
    this.strengthRow.className = "pr-strength-row";

    this.strengthLabel = document.createElement("span");
    this.strengthLabel.className = "pr-strength-label";
    this.strengthLabel.textContent = "引导强度:";

    this.strengthValue = document.createElement("input");
    this.strengthValue.type = "text";
    this.strengthValue.className = "pr-strength-input";
    this.strengthValue.value = "1.00";
    this.strengthValue.disabled = true;
    this.strengthValue.style.cursor = "ew-resize";

    this.vidStrLabel = document.createElement("span");
    this.vidStrLabel.className = "pr-strength-label";
    this.vidStrLabel.textContent = "视频强度:";
    this.vidStrLabel.style.display = "none";

    this.vidStrValue = document.createElement("input");
    this.vidStrValue.type = "text";
    this.vidStrValue.className = "pr-strength-input";
    this.vidStrValue.value = "1.00";
    this.vidStrValue.style.display = "none";
    this.vidStrValue.style.width = "40px";
    this.vidStrValue.style.cursor = "ew-resize";

    this.vidAttnLabel = document.createElement("span");
    this.vidAttnLabel.className = "pr-strength-label";
    this.vidAttnLabel.textContent = "视频注意力:";
    this.vidAttnLabel.style.display = "none";
    this.vidAttnLabel.style.marginLeft = "10px";

    this.vidAttnValue = document.createElement("input");
    this.vidAttnValue.type = "text";
    this.vidAttnValue.className = "pr-strength-input";
    this.vidAttnValue.value = "0.65";
    this.vidAttnValue.style.display = "none";
    this.vidAttnValue.style.width = "40px";
    this.vidAttnValue.style.cursor = "ew-resize";

    this.durationLabel = document.createElement("span");
    this.durationLabel.className = "pr-strength-label";
    this.durationLabel.textContent = "时长:";
    this.durationLabel.style.marginLeft = "10px";

    this.durationValue = document.createElement("input");
    this.durationValue.type = "text";
    this.durationValue.className = "pr-strength-input";
    this.durationValue.value = "0.00";
    this.durationValue.style.width = "52px";
    this.durationValue.title = "选中片段时长（秒）";
    this.durationValue.addEventListener("change", (e) => this.setSelectedDurationSeconds(e.target.value));
    this.durationValue.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        this.setSelectedDurationSeconds(e.target.value);
        this.durationValue.blur();
      }
    });

    this.cropCutBtn = document.createElement("button");
    this.cropCutBtn.className = "pr-icon-btn";
    this.cropCutBtn.innerHTML = ICONS.scissors;
    this.cropCutBtn.title = "在播放头处裁切选中片段";
    Object.assign(this.cropCutBtn.style, {
      width: "26px",
      height: "24px",
      padding: "4px",
      marginLeft: "4px",
      display: "none",
    });
    this.cropCutBtn.addEventListener("click", () => this.cutSelectedSegmentAtPlayhead());

    this.manualOutputRangeBtn = document.createElement("button");
    this.manualOutputRangeBtn.className = "pr-btn";
    Object.assign(this.manualOutputRangeBtn.style, {
      padding: "4px 8px",
      marginLeft: "8px",
      fontSize: "10px",
      height: "24px",
      whiteSpace: "nowrap",
    });
    this.manualOutputRangeBtn.addEventListener("click", () => {
      this.setManualOutputRange(!this.manualOutputRange);
    });
    this.updateManualOutputRangeToggle();

    this.icVideoSizeBtn = document.createElement("button");
    this.icVideoSizeBtn.className = "pr-btn";
    Object.assign(this.icVideoSizeBtn.style, {
      padding: "4px 8px",
      marginLeft: "6px",
      fontSize: "10px",
      height: "24px",
      whiteSpace: "nowrap",
    });
    this.icVideoSizeBtn.addEventListener("click", () => {
      this.setICVideoSize(!this.useICVideoSize);
    });
    this.updateICVideoSizeToggle();

    this.vidStrValue.addEventListener("change", (e) => {
      let val = parseFloat(e.target.value);
      if (isNaN(val)) val = 1.0;
      val = Math.max(0, Math.min(1, val));
      this.vidStrValue.value = val.toFixed(2);
      if (this.selectionType === "motion" && this.timeline.motionSegments[this.selectedIndex]) {
        this.timeline.motionSegments[this.selectedIndex].videoStrength = val;
        this.commitChanges();
      }
    });

    this.vidAttnValue.addEventListener("change", (e) => {
      let val = parseFloat(e.target.value);
      if (isNaN(val)) val = 0.65;
      val = Math.max(0, Math.min(1, val));
      this.vidAttnValue.value = val.toFixed(2);
      if (this.selectionType === "motion" && this.timeline.motionSegments[this.selectedIndex]) {
        this.timeline.motionSegments[this.selectedIndex].videoAttentionStrength = val;
        this.commitChanges();
      }
    });

    // Dragging logic for video strength
    this.vidStrValue.addEventListener("mousedown", (e) => {
      if (this.vidStrValue.disabled) return;
      const vStrStartX = e.clientX;
      const vStrStartVal = parseFloat(this.vidStrValue.value) || 1.0;
      let vStrHasMoved = false;
      let vStrIsDragging = false;

      const onMouseMove = (moveEvent) => {
        const deltaX = moveEvent.clientX - vStrStartX;
        if (Math.abs(deltaX) > 3) {
          vStrHasMoved = true;
          vStrIsDragging = true;
        }

        if (vStrIsDragging) {
          moveEvent.preventDefault();
          const sensitivity = 0.002;
          let newVal = vStrStartVal + deltaX * sensitivity;

          if (newVal < 0) newVal = 0;
          if (newVal > 1) newVal = 1;

          this.vidStrValue.value = newVal.toFixed(2);

          if (this.selectionType === "motion" && this.timeline.motionSegments[this.selectedIndex]) {
            this.timeline.motionSegments[this.selectedIndex].videoStrength = newVal;
            this.commitChanges();
          }
        }
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);

        if (!vStrHasMoved) {
          this.vidStrValue.focus();
          this.vidStrValue.select();
        }
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });

    // Dragging logic for video attention strength
    this.vidAttnValue.addEventListener("mousedown", (e) => {
      if (this.vidAttnValue.disabled) return;
      const vAttnStartX = e.clientX;
      const vAttnStartVal = parseFloat(this.vidAttnValue.value) || 0.65;
      let vAttnHasMoved = false;
      let vAttnIsDragging = false;

      const onMouseMove = (moveEvent) => {
        const deltaX = moveEvent.clientX - vAttnStartX;
        if (Math.abs(deltaX) > 3) {
          vAttnHasMoved = true;
          vAttnIsDragging = true;
        }

        if (vAttnIsDragging) {
          moveEvent.preventDefault();
          const sensitivity = 0.002;
          let newVal = vAttnStartVal + deltaX * sensitivity;

          if (newVal < 0) newVal = 0;
          if (newVal > 1) newVal = 1;

          this.vidAttnValue.value = newVal.toFixed(2);

          if (this.selectionType === "motion" && this.timeline.motionSegments[this.selectedIndex]) {
            this.timeline.motionSegments[this.selectedIndex].videoAttentionStrength = newVal;
            this.commitChanges();
          }
        }
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);

        if (!vAttnHasMoved) {
          this.vidAttnValue.focus();
          this.vidAttnValue.select();
        }
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });

    // Dragging logic for guide strength
    let isDragging = false;
    let startX = 0;
    let startVal = 0;
    let hasMoved = false;

    this.strengthValue.addEventListener("mousedown", (e) => {
      if (this.strengthValue.disabled) return;
      startX = e.clientX;
      startVal = parseFloat(this.strengthValue.value) || 1.0;
      hasMoved = false;

      const onMouseMove = (moveEvent) => {
        const deltaX = moveEvent.clientX - startX;
        if (Math.abs(deltaX) > 3) {
          hasMoved = true;
          isDragging = true;
        }

        if (isDragging) {
          moveEvent.preventDefault();
          const sensitivity = 0.002;
          let newVal = startVal + deltaX * sensitivity;

          if (newVal < 0) newVal = 0;
          if (newVal > 1) newVal = 1;

          this.strengthValue.value = newVal.toFixed(2);

          if (this.retakeMode) {
            this.timeline.retakeStrength = newVal;
            this.commitChanges();
          } else if (this.selectionType === "image" && this.timeline.segments[this.selectedIndex]) {
            const seg = this.timeline.segments[this.selectedIndex];
            if (seg.type !== "text") {
              seg.guideStrength = newVal;
              this.commitChanges();
            }
          }
        }
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);

        if (!hasMoved) {
          this.strengthValue.focus();
          this.strengthValue.select();
        }
        isDragging = false;
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });

    this.strengthValue.addEventListener("change", (e) => {
      let val = parseFloat(e.target.value);
      if (isNaN(val)) val = 1;
      val = Math.max(0, Math.min(1, val));
      this.strengthValue.value = val.toFixed(2);
      if (this.retakeMode) {
        this.timeline.retakeStrength = val;
        this.commitChanges();
      } else if (this.selectionType === "image" && this.timeline.segments[this.selectedIndex]) {
        const seg = this.timeline.segments[this.selectedIndex];
        if (seg.type !== "text") {
          seg.guideStrength = val;
          this.commitChanges();
        }
      }
    });

    this.strengthRow.appendChild(this.timeCodeDisplay);
    this.strengthRow.appendChild(this.segmentBoundsDisplay);
    this.strengthRow.appendChild(this.strengthLabel);
    this.strengthRow.appendChild(this.strengthValue);
    this.strengthRow.appendChild(this.vidStrLabel);
    this.strengthRow.appendChild(this.vidStrValue);
    this.strengthRow.appendChild(this.vidAttnLabel);
    this.strengthRow.appendChild(this.vidAttnValue);
    this.strengthRow.appendChild(this.durationLabel);
    this.strengthRow.appendChild(this.durationValue);
    this.strengthRow.appendChild(this.cropCutBtn);
    this.strengthRow.appendChild(this.manualOutputRangeBtn);
    // 参考视频尺寸开关已移除
    if (this.icVideoSizeBtn) this.icVideoSizeBtn.style.display = "none";



    // Layout container for sidebar + viewport
    this.layoutContainer = document.createElement("div");
    this.layoutContainer.className = "pr-timeline-layout";
    this.layoutContainer.style.display = "flex";
    this.layoutContainer.style.flexDirection = "row";
    this.layoutContainer.style.width = "100%";
    this.layoutContainer.style.border = "1px solid #111";
    this.layoutContainer.style.borderRadius = "6px";
    this.layoutContainer.style.overflow = "hidden";

    // Sidebar
    this.sidebar = document.createElement("div");
    this.sidebar.className = "pr-timeline-sidebar";
    this.sidebar.style.width = "120px";
    this.sidebar.style.flexShrink = "0";
    this.sidebar.style.display = "flex";
    this.sidebar.style.flexDirection = "column";
    this.sidebar.style.borderRight = "1px solid #111";
    this.sidebar.style.boxSizing = "border-box";
    this.sidebar.style.backgroundColor = "#1e1e1e";
    this.sidebar.style.userSelect = "none";

    // Spacer for Ruler
    this.rulerSpacer = document.createElement("div");
    this.rulerSpacer.style.height = `${RULER_HEIGHT}px`;
    this.rulerSpacer.style.width = "100%";
    this.rulerSpacer.style.borderBottom = "1px solid #111";
    this.rulerSpacer.style.backgroundColor = "#1e1e1e";
    this.rulerSpacer.style.boxSizing = "border-box";
    this.rulerSpacer.style.flexShrink = "0";
    this.sidebar.appendChild(this.rulerSpacer);

    const getTrackIconHtml = (trackId, isEnabled) => {
      if (trackId === "audio") {
        if (isEnabled) {
          return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                </svg>`;
        } else {
          return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                  <line x1="1" y1="1" x2="23" y2="23"></line>
                </svg>`;
        }
      } else {
        return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
              <circle cx="12" cy="12" r="3"></circle>
              ${!isEnabled ? '<line x1="1" y1="1" x2="23" y2="23"></line>' : ''}
            </svg>`;
      }
    };

    const updateTrackIcon = (btn, trackId, isEnabled) => {
      btn.style.color = isEnabled ? "#aaa" : "#444";
      btn.innerHTML = getTrackIconHtml(trackId, isEnabled);
    };
    this.updateTrackIcon = updateTrackIcon;

    const createTrackLabel = (text, bgColor, trackId, isEnabled, toggleCallback) => {
      const el = document.createElement("div");
      el.style.display = "flex";
      el.style.flexDirection = "column";
      el.style.alignItems = "center";
      el.style.justifyContent = "center";
      el.style.borderBottom = "1px solid #111";
      el.style.backgroundColor = bgColor;
      el.style.boxSizing = "border-box";
      el.style.gap = "4px";
      el.style.overflow = "hidden";
      el.style.position = "relative";
      el.style.flexShrink = "0";

      const headerRow = document.createElement("div");
      headerRow.style.display = "flex";
      headerRow.style.alignItems = "center";
      headerRow.style.justifyContent = "center";
      headerRow.style.gap = "6px";

      const textSpan = document.createElement("span");
      textSpan.style.color = "#ccc";
      textSpan.style.fontSize = "12px";
      textSpan.style.fontWeight = "bold";
      textSpan.style.lineHeight = "1";
      textSpan.style.display = "inline-flex";
      textSpan.style.alignItems = "center";
      textSpan.textContent = text;

      const eyeBtn = document.createElement("div");
      eyeBtn.style.cursor = "pointer";
      eyeBtn.style.display = "inline-flex";
      eyeBtn.style.alignItems = "center";
      eyeBtn.style.justifyContent = "center";
      eyeBtn.style.width = "14px";
      eyeBtn.style.height = "14px";
      eyeBtn.style.color = isEnabled ? "#aaa" : "#444";
      eyeBtn.innerHTML = getTrackIconHtml(trackId, isEnabled);

      eyeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleCallback();
      });

      // Store reference so we can update it later
      el._eyeBtn = eyeBtn;

      headerRow.appendChild(textSpan);
      headerRow.appendChild(eyeBtn);
      el.appendChild(headerRow);

      return el;
    };

    // 多参图：第 1 轨标签（仅 H3 多参显示，无开关）
    this.refTrackLabel = document.createElement("div");
    this.refTrackLabel.style.display = "none";
    this.refTrackLabel.style.flexDirection = "column";
    this.refTrackLabel.style.alignItems = "center";
    this.refTrackLabel.style.justifyContent = "center";
    this.refTrackLabel.style.borderBottom = "1px solid #111";
    this.refTrackLabel.style.backgroundColor = "#1e1e1e";
    this.refTrackLabel.style.boxSizing = "border-box";
    this.refTrackLabel.style.flexShrink = "0";
    this.refTrackLabel.style.height = "0px";
    this.refTrackLabel.style.overflow = "hidden";
    const refLbl = document.createElement("span");
    refLbl.style.color = "#ccc";
    refLbl.style.fontSize = "12px";
    refLbl.style.fontWeight = "bold";
    refLbl.textContent = "多参图";
    this.refTrackLabel.appendChild(refLbl);

    this.mainTrackLabel = createTrackLabel("主轨", "#1e1e1e", "main", this.mainTrackEnabled, () => {
      this.mainTrackEnabled = !this.mainTrackEnabled;
      updateTrackIcon(this.mainTrackLabel._eyeBtn, "main", this.mainTrackEnabled);
      this.commitChanges(true);
      this.render();
    });

    this.audioTrackLabel = createTrackLabel("音频", "#1e1e1e", "audio", this.audioTrackEnabled, () => {
      this.audioTrackEnabled = !this.audioTrackEnabled;
      updateTrackIcon(this.audioTrackLabel._eyeBtn, "audio", this.audioTrackEnabled);

      if (this.audioTrackEnabled) {
        const overrideWidget = this.node.widgets?.find(w => w.name === "override_audio");
        if (overrideWidget && overrideWidget.value) {
          overrideWidget.value = false;
          this.node.properties.overrideAudio = false;
          this.timeline.overrideAudio = false;
          if (this.updateOverrideAudioToggleStyle) this.updateOverrideAudioToggleStyle(false);
        }
        this._audioTrackWasEnabledBeforeOverride = false;
      }

      // Auto-disable custom audio if track disabled
      const customAudioWidget = this.node.widgets?.find(w => w.name === "use_custom_audio");
      if (customAudioWidget) {
        if (!this.audioTrackEnabled) {
          // Store previous state just in case, though the user requested it auto-enables
          this._prevCustomAudioState = customAudioWidget.value;
          customAudioWidget.value = false;
        } else {
          // Auto-turn it back on as requested
          customAudioWidget.value = true;
        }
        if (this.updateToggleStyle) this.updateToggleStyle(customAudioWidget.value);
      }

      // Disable toggle buttons visually
      inpaintToggleBtn.disabled = !this.audioTrackEnabled;
      inpaintToggleBtn.style.opacity = this.audioTrackEnabled ? "1.0" : "0.3";

      this.commitChanges(true);
      this.render();
    });
    this.audioTrackLabel.appendChild(inpaintToggleBtn);

    // Initialize audio toggle states immediately
    inpaintToggleBtn.disabled = !this.audioTrackEnabled;
    inpaintToggleBtn.style.opacity = this.audioTrackEnabled ? "1.0" : "0.3";

    // H3 多参：参考音频轨（与驱动音频分开）
    this.refAudioTrackLabel = createTrackLabel("参考音频", "#1e1e1e", "ref_audio", true, () => {
      // 参考音频轨暂不提供静音开关，点击仅刷新
      this.render?.();
    });
    this.refAudioTrackLabel.style.display = "none";

    this.motionTrackLabel = createTrackLabel("参考视频", "#1e1e1e", "motion", this.motionTrackEnabled, () => {
      this.motionTrackEnabled = !this.motionTrackEnabled;
      updateTrackIcon(this.motionTrackLabel._eyeBtn, "motion", this.motionTrackEnabled);

      // Auto-disable custom motion if track disabled
      const customMotionWidget = this.node.widgets?.find(w => w.name === "use_custom_motion");
      if (customMotionWidget) {
        if (!this.motionTrackEnabled) {
          customMotionWidget.value = false;
        } else {
          customMotionWidget.value = true;
        }
      }

      overrideAudioToggleBtn.disabled = !this.motionTrackEnabled;
      overrideAudioToggleBtn.style.opacity = this.motionTrackEnabled ? "1.0" : "0.3";
      if (!this.motionTrackEnabled) {
        const overrideWidget = this.node.widgets?.find(w => w.name === "override_audio");
        if (overrideWidget && overrideWidget.value) {
          overrideWidget.value = false;
          this.node.properties.overrideAudio = false;
          this.timeline.overrideAudio = false;
          if (this.updateOverrideAudioToggleStyle) this.updateOverrideAudioToggleStyle(false);

          // Restore audio track if it was previously enabled
          if (this._audioTrackWasEnabledBeforeOverride) {
            this.audioTrackEnabled = true;
            updateTrackIcon(this.audioTrackLabel._eyeBtn, "audio", true);

            const customAudioWidget = this.node.widgets?.find(w => w.name === "use_custom_audio");
            if (customAudioWidget) {
              customAudioWidget.value = true;
              if (this.updateToggleStyle) this.updateToggleStyle(true);
            }

            inpaintToggleBtn.disabled = false;
            inpaintToggleBtn.style.opacity = "1.0";
          }
          this._audioTrackWasEnabledBeforeOverride = false;
        }
      }

      this.commitChanges(true);
      this.render();
    });
    this.motionTrackLabel.appendChild(overrideAudioToggleBtn);

    // Initialize motion override states immediately
    overrideAudioToggleBtn.disabled = !this.motionTrackEnabled;
    overrideAudioToggleBtn.style.opacity = this.motionTrackEnabled ? "1.0" : "0.3";


    // 轨道顺序：多参图 → 主轨 → 参考音频 → 参考视频 → 驱动音频（H3 多参）
    this.sidebar.appendChild(this.refTrackLabel);
    this.sidebar.appendChild(this.mainTrackLabel);
    this.sidebar.appendChild(this.refAudioTrackLabel);
    this.sidebar.appendChild(this.motionTrackLabel);
    this.sidebar.appendChild(this.audioTrackLabel);
    if (this.audioTrackLabel) this.audioTrackLabel.style.display = "none";
    if (this.motionTrackLabel) this.motionTrackLabel.style.display = "none";
    if (this.refAudioTrackLabel) this.refAudioTrackLabel.style.display = "none";

    const setupSidebarLabelResizing = (labelEl, dragType) => {
      labelEl.addEventListener("mousemove", (e) => {
        if (this.retakeMode) {
          labelEl.style.cursor = "default";
          return;
        }
        if (this._isDragging) return;
        const rect = labelEl.getBoundingClientRect();
        const y = e.clientY - rect.top;
        if (rect.height - y <= 8) {
          labelEl.style.cursor = "ns-resize";
        } else {
          labelEl.style.cursor = "default";
        }
      });

      labelEl.addEventListener("mousedown", (e) => {
        if (this.retakeMode) return;
        if (e.button !== 0) return;
        if (e.target.closest("svg") || e.target.style.cursor === "pointer" || window.getComputedStyle(e.target).cursor === "pointer") {
          return;
        }
        const rect = labelEl.getBoundingClientRect();
        const y = e.clientY - rect.top;
        if (rect.height - y <= 8) {
          this._isDragging = true;
          this._dragType = dragType;
          this._startBlockHeight = this.blockHeight;
          this._startAudioTrackHeight = this.audioTrackHeight;
          this._startMotionTrackHeight = this.motionTrackHeight;
          this._startRefTrackHeight = this.refTrackHeight || 96;
          this._startY = this.getMousePos(e).y;
          document.body.style.userSelect = "none";
          document.body.style.cursor = "ns-resize";
          e.preventDefault();
          e.stopPropagation();
        }
      });
    };

    setupSidebarLabelResizing(this.refTrackLabel, "ref_divider");
    setupSidebarLabelResizing(this.mainTrackLabel, "divider");
    setupSidebarLabelResizing(this.audioTrackLabel, "audio_divider");
    setupSidebarLabelResizing(this.motionTrackLabel, "height_resize");

    this.updateSidebarHeights();

    this.layoutContainer.appendChild(this.sidebar);

    // Viewport takes remaining space
    this.viewport.style.flexGrow = "1";
    this.viewport.style.minWidth = "0";
    this.layoutContainer.appendChild(this.viewport);

    this.wrapper.appendChild(toolbar);

    // 时间线 + 播放 + 提示词（分镜/多参共用；多参时 4 轨：多参图/主轨/音频/参考视频）
    if (this.isH3Director) {
      this.ensureH3MultiData();
      if (this._pendingH3FileIn) {
        this.wrapper.appendChild(this._pendingH3FileIn);
        this.h3RefImageInput = this._pendingH3FileIn;
        this._pendingH3FileIn = null;
      } else if (this.h3RefImageInput && !this.h3RefImageInput.parentNode) {
        this.wrapper.appendChild(this.h3RefImageInput);
      }
    }
    this.wrapper.appendChild(this.layoutContainer);
    const controlsGroup = document.createElement("div");
    controlsGroup.className = "pr-controls-group";
    controlsGroup.appendChild(this.strengthRow);
    controlsGroup.appendChild(playerControls);
    this.wrapper.appendChild(controlsGroup);
    this.wrapper.appendChild(propContainer);
    this.wrapper.appendChild(this.globalPropContainer);

    this.container.appendChild(this.wrapper);

    if (this.isH3Director) {
      const wMode =
        this.node.widgets?.find((w) => w.name === "workspace_mode")?.value ||
        this.node.properties?.workspace_mode ||
        this.timeline?.workspace_mode ||
        "分镜";
      // 先定当前工作台再迁移/装载主轨，避免旧工程误写入另一台
      this.h3WorkspaceMode = wMode === "多参" ? "多参" : "分镜";
      this._h3MigrateMainTracksIfNeeded();
      this.setH3WorkspaceMode(this.h3WorkspaceMode, true);
    }
  }

  ensureH3MultiData() {
    if (!this.timeline.h3MultiRef || typeof this.timeline.h3MultiRef !== "object") {
      this.timeline.h3MultiRef = { images: [], audios: [], videos: [], driveAudio: null };
    }
    const d = this.timeline.h3MultiRef;
    if (!("driveAudio" in d)) d.driveAudio = null;
    if (!Array.isArray(this.selectedH3RefIndexes)) this.selectedH3RefIndexes = [];
    // 仅把明确标记为驱动的项迁到 driveAudio；普通 audios[] 仍是「参考音频」槽
    if (!d.driveAudio && Array.isArray(d.audios)) {
      const driveLike = d.audios.find(
        (x) => x && (x.role === "drive" || (Array.isArray(x.pieces) && x.pieces.length))
      );
      if (driveLike) {
        d.driveAudio = driveLike;
        d.audios = d.audios.map((x) => (x === driveLike ? null : x));
      }
    }
    // 从 driveAudio.pieces 恢复多段（仅当当前没有驱动段，且用户未主动清空）
    const hasDriveSeg = (this.timeline?.audioSegments || []).some((s) => s?.isH3Drive);
    if (!hasDriveSeg && d.driveAudio && !this._h3DriveUserCleared) {
      const pieces = Array.isArray(d.driveAudio.pieces) && d.driveAudio.pieces.length
        ? d.driveAudio.pieces
        : null;
      if (pieces && pieces.length) {
        if (!Array.isArray(this.timeline.audioSegments)) this.timeline.audioSegments = [];
        for (const p of pieces) {
          const durF = Math.max(
            1,
            Number(p.length) ||
              Math.round((Number(p.duration) || 0) * this.getFrameRate()) ||
              1
          );
          this.timeline.audioSegments.push({
            id: p.id || "h3_drive_" + Date.now() + Math.random().toString(36).slice(2, 5),
            type: "audio",
            isH3Drive: true,
            start: Number(p.start) || 0,
            length: durF,
            trimStart: Number(p.trimStart) || 0,
            audioDurationFrames:
              Number(p.audioDurationFrames) ||
              (Number(p.trimStart) || 0) + durF,
            name: p.name || d.driveAudio.name,
            audioFile: p.fileName || d.driveAudio.fileName,
            fileName: p.fileName || d.driveAudio.fileName,
            waveformPeaks: p.waveformPeaks || d.driveAudio.waveformPeaks || [],
            _blobUrl: null,
          });
        }
        this.timeline.audioSegments.sort((a, b) => a.start - b.start);
      } else {
        this._h3EnsureDriveSegmentFromMeta?.(d.driveAudio);
      }
      if (!(d.driveAudio.waveformPeaks?.length > 2)) {
        this._h3EnsureDrivePeaks?.(d.driveAudio);
      }
    }
    // 载入的 audioSegments 若缺 isH3Drive 但属于驱动文件，补标
    const driveFile = d.driveAudio?.fileName || d.driveAudio?.name;
    if (driveFile && Array.isArray(this.timeline?.audioSegments)) {
      for (const s of this.timeline.audioSegments) {
        if (!s) continue;
        if (s.isH3Drive) continue;
        if (s.audioFile === driveFile || s.fileName === driveFile) s.isH3Drive = true;
        if (!s.audioDurationFrames) {
          s.audioDurationFrames = Math.max(s.length || 1, (s.trimStart || 0) + (s.length || 0));
        }
      }
    }
    if (!Array.isArray(d.images)) d.images = [];
    if (!Array.isArray(d.audios)) d.audios = [];
    if (!Array.isArray(d.videos)) d.videos = [];
    // 空槽压掉：从左到右始终是 1、2、3…，删图或换位后立刻重排
    d.images = d.images
      .filter((x) => x && (x.fileName || x.previewUrl || x.name))
      .slice(0, 9);
    // 参考音槽：剔除误混入的驱动项（role=drive / pieces）
    d.audios = d.audios
      .slice(0, 3)
      .map((x) => {
        if (!x || !(x.fileName || x.previewUrl || x.name)) return null;
        if (x.role === "drive" || (Array.isArray(x.pieces) && x.pieces.length)) return null;
        return x;
      });
    while (d.audios.length > 0 && !d.audios[d.audios.length - 1]) d.audios.pop();
    d.videos = d.videos
      .slice(0, 3)
      .map((x) => (x && (x.fileName || x.previewUrl || x.name || x.videoFile) ? x : null));
    return d;
  }

  /** 多参主轨加视频：不配对驱动音轨 */
  _h3SkipVideoAudioPair() {
    return !!(this.isH3Director && this.isH3MultiMode && this.isH3MultiMode());
  }

  isH3MultiMode() {
    if (!this.isH3Director) return false;
    if (this.h3WorkspaceMode === "多参") return true;
    // 兜底：避免 h3WorkspaceMode 未同步时仍按多参 UI 启用了音轨，却按分镜播残留
    try {
      const w = this.node?.widgets?.find((x) => x.name === "workspace_mode")?.value;
      const p = this.node?.properties?.workspace_mode;
      return w === "多参" || p === "多参";
    } catch (_) {
      return false;
    }
  }

  /**
   * 分镜 / 多参 工具栏按钮文案与顺序
   * 多参：参考图 → 主轨文本 → 添加视频 → 删除 → 分镜 → 多参（参考音/参考视频/驱动音用轨道＋）
   * 分镜：图片 → 文字 → 视频 → 删除 → 分镜 → 多参
   */
  applyH3ToolbarButtons(isMulti) {
    if (!this.isH3Director || !this.actionGroup) return;
    const g = this.actionGroup;
    const append = (el) => {
      if (el) g.appendChild(el);
    };

    // 隐藏文件 input 仍挂在组内，放最后
    const fileInputs = [this.fileInput, this.videoFileInput, this.audioFileInput, this.motionFileInput].filter(Boolean);

    if (isMulti) {
      if (this.uploadBtn) {
        this.uploadBtn.style.display = "";
        this.uploadBtn.innerHTML = `${ICONS.upload} 添加参考图`;
        this.uploadBtn.title = "添加参考图";
      }
      if (this.addTextBtn) {
        this.addTextBtn.style.display = "";
        this.addTextBtn.innerHTML = `${ICONS.text} 添加主轨文本`;
        this.addTextBtn.title = "主轨添加文本提示词";
      }
      // 多参：参考图 / 主轨文本 / 主轨视频；参考视频、驱动音频用轨道 ＋ 添加
      if (this.uploadVideoBtn) {
        this.uploadVideoBtn.style.display = "";
        this.uploadVideoBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg> 添加视频`;
        this.uploadVideoBtn.title = "主轨添加视频";
      }
      if (this.uploadAudioBtn) this.uploadAudioBtn.style.display = "none";
      if (this.uploadMotionBtn) this.uploadMotionBtn.style.display = "none";
      if (this.deleteBtn) this.deleteBtn.style.display = "";

      // 顺序：参考图、主轨文本、添加视频、删除、分镜、多参
      append(this.uploadBtn);
      append(this.addTextBtn);
      append(this.uploadVideoBtn);
      append(this.deleteBtn);
      if (this.deleteRetakeBtn) append(this.deleteRetakeBtn);
      append(this.h3ModeStoryBtn);
      append(this.h3ModeRefBtn);
    } else {
      if (this.uploadBtn) {
        this.uploadBtn.style.display = "";
        this.uploadBtn.innerHTML = `${ICONS.upload} 添加图片`;
        this.uploadBtn.title = "添加图片";
      }
      if (this.addTextBtn) {
        this.addTextBtn.style.display = "";
        this.addTextBtn.innerHTML = `${ICONS.text} 添加文字`;
        this.addTextBtn.title = "添加文字段";
      }
      if (this.uploadVideoBtn) {
        this.uploadVideoBtn.style.display = "";
        this.uploadVideoBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg> 添加视频`;
        this.uploadVideoBtn.title = "添加视频";
      }
      if (this.uploadAudioBtn) this.uploadAudioBtn.style.display = "none";
      if (this.uploadMotionBtn) this.uploadMotionBtn.style.display = "none";
      if (this.deleteBtn) this.deleteBtn.style.display = "";

      // 分镜顺序：图片、文字、视频、删除、分镜、多参
      append(this.uploadBtn);
      append(this.addTextBtn);
      append(this.uploadVideoBtn);
      append(this.deleteBtn);
      if (this.deleteRetakeBtn) append(this.deleteRetakeBtn);
      append(this.h3ModeStoryBtn);
      append(this.h3ModeRefBtn);
    }
    // file inputs 始终挂在组内（隐藏）
    for (const fi of fileInputs) append(fi);
  }

  h3EnsureImageEl(item) {
    if (!item) return null;
    if (item._imgObj && item._imgObj.complete) return item._imgObj;
    if (!item._imgObj) {
      const img = new Image();
      img.onload = () => {
        if (!this._isDragging) this.render?.();
      };
      const src =
        item.previewUrl ||
        (item.fileName && typeof api?.apiURL === "function"
          ? api.apiURL(`/view?filename=${encodeURIComponent(item.fileName)}&type=input`)
          : "");
      if (src) img.src = src;
      item._imgObj = img;
    }
    return item._imgObj;
  }

  async h3UploadOneImage(file) {
    if (!file || !file.type || !file.type.startsWith("image/")) return null;
    const previewUrl = URL.createObjectURL(file);
    let fileName = file.name;
    try {
      const form = new FormData();
      form.append("image", file, file.name);
      form.append("overwrite", "true");
      form.append("type", "input");
      const resp = await api.fetchApi("/upload/image", { method: "POST", body: form });
      if (resp.ok) {
        const data = await resp.json();
        if (data?.name) fileName = data.name;
      }
    } catch (err) {
      console.warn("[LazyH3] 参考图上传失败，仅本地预览:", err);
    }
    const item = {
      id: "img" + Date.now() + Math.random().toString(36).slice(2, 6),
      name: file.name,
      fileName,
      previewUrl,
    };
    this.h3EnsureImageEl(item);
    return item;
  }

  async h3AddRefImages(files, startIndex) {
    const d = this.ensureH3MultiData();
    while (d.images.length < 9) d.images.push(null);
    let idx =
      typeof startIndex === "number" && startIndex >= 0
        ? startIndex
        : d.images.findIndex((x) => !x);
    if (idx < 0) idx = 0;
    for (const f of files || []) {
      if (idx >= 9) break;
      if (!f.type || !f.type.startsWith("image/")) continue;
      while (idx < 9 && d.images[idx]) idx++;
      if (idx >= 9) break;
      const item = await this.h3UploadOneImage(f);
      if (item) {
        d.images[idx] = item;
        idx++;
      }
    }
    while (d.images.length > 0 && !d.images[d.images.length - 1]) d.images.pop();
    this.render?.();
    this.commitChanges?.(true);
  }

  h3RemoveRefImage(index) {
    const d = this.ensureH3MultiData();
    if (!Array.isArray(d.images)) d.images = [];
    if (index < 0 || index >= d.images.length) return;
    d.images.splice(index, 1);
    this.selectedH3RefIndexes = (this.selectedH3RefIndexes || [])
      .filter((i) => i !== index)
      .map((i) => (i > index ? i - 1 : i));
    this.render?.();
    this.commitChanges?.(true);
  }

  /** 把参考图从 from 插到视觉位置 to（to 是松手时的插入点，可等于张数表示末尾）。 */
  h3MoveRefImage(from, to) {
    const d = this.ensureH3MultiData();
    const arr = (d.images || []).filter(Boolean);
    if (from < 0 || from >= arr.length) return;
    const item = arr.splice(from, 1)[0];
    let insert = to;
    if (insert > from) insert -= 1;
    insert = Math.max(0, Math.min(arr.length, insert));
    arr.splice(insert, 0, item);
    d.images = arr;
    if (insert !== from) {
      this.selectedH3RefIndexes = [insert];
      this.commitChanges?.(true);
    }
    this.render?.();
  }

  /** 鼠标所在的插入点：0 表示插到最前，等于张数表示插到最后。 */
  h3RefInsertIndex(mouseX) {
    const layout = this._h3RefLayout || this.getH3RefLayout(this.canvas?.offsetWidth || 0);
    const slots = layout?.slots || [];
    if (!slots.length) return 0;
    for (let i = 0; i < slots.length; i++) {
      const mid = slots[i].x + slots[i].w / 2;
      if (mouseX < mid) return i;
    }
    return slots.length;
  }

  promptAddH3RefImage(startIndex) {
    if (typeof startIndex === "number") this._h3RefTargetIndex = startIndex;
    else this._h3RefTargetIndex = undefined;
    if (!this.h3RefImageInput) {
      const fileIn = document.createElement("input");
      fileIn.type = "file";
      fileIn.accept = "image/*";
      fileIn.multiple = true;
      fileIn.style.display = "none";
      fileIn.addEventListener("change", async (e) => {
        const files = Array.from(e.target.files || []);
        e.target.value = "";
        const start = this._h3RefTargetIndex;
        this._h3RefTargetIndex = undefined;
        await this.h3AddRefImages(files, start);
      });
      this.h3RefImageInput = fileIn;
      (this.wrapper || this.container)?.appendChild(fileIn);
    }
    this.h3RefImageInput.click();
  }

  // --- 多参音频（最多 3）---
  async h3UploadOneAudio(file) {
    if (!file) return null;
    const isAud =
      (file.type && file.type.startsWith("audio/")) ||
      /\.(mp3|wav|ogg|flac|m4a|aac|wma)$/i.test(file.name || "");
    if (!isAud) return null;
    const previewUrl = URL.createObjectURL(file);
    let fileName = file.name;
    let uploaded = false;
    try {
      const form = new FormData();
      form.append("image", file, file.name); // Comfy 通用上传口
      form.append("overwrite", "true");
      form.append("type", "input");
      const resp = await api.fetchApi("/upload/image", { method: "POST", body: form });
      if (resp.ok) {
        const data = await resp.json();
        if (data?.name) {
          const sub = data.subfolder || "";
          fileName = sub ? `${sub}/${data.name}` : data.name;
          uploaded = true;
        }
      } else {
        console.warn("[LazyH3] 参考音频上传失败 HTTP", resp.status);
      }
    } catch (err) {
      console.warn("[LazyH3] 参考音频上传失败，仅本地预览:", err);
    }
    if (!uploaded) {
      console.warn("[LazyH3] 参考音频未落到 input，后端读不到:", fileName);
    }
    let duration = 0;
    try {
      duration = await new Promise((resolve) => {
        const a = new Audio(previewUrl);
        a.addEventListener("loadedmetadata", () => resolve(a.duration || 0));
        a.addEventListener("error", () => resolve(0));
        setTimeout(() => resolve(0), 3000);
      });
    } catch (_) {}
    return {
      id: "aud" + Date.now() + Math.random().toString(36).slice(2, 6),
      name: file.name,
      fileName,
      previewUrl,
      duration,
    };
  }

  /** 客户端提取驱动音频波形 peaks（归一化到 0~1，保证起伏可见） */
  async _h3ExtractDrivePeaks(fileOrUrl) {
    try {
      let arrayBuffer;
      if (fileOrUrl instanceof Blob || fileOrUrl instanceof File) {
        arrayBuffer = await fileOrUrl.arrayBuffer();
      } else if (typeof fileOrUrl === "string") {
        const resp = await fetch(fileOrUrl);
        arrayBuffer = await resp.arrayBuffer();
      } else {
        return [];
      }
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const copy = arrayBuffer.slice(0);
      const audioBuffer = await audioCtx.decodeAudioData(copy);
      try { audioCtx.close?.(); } catch (_) {}
      const channelData = audioBuffer.getChannelData(0);
      const peaks = [];
      const numPeaks = Math.min(800, Math.max(120, Math.floor(channelData.length / 256)));
      const step = Math.max(1, Math.floor(channelData.length / numPeaks));
      let peakMax = 1e-6;
      for (let i = 0; i < numPeaks; i++) {
        let max = 0;
        const start = i * step;
        const end = Math.min(channelData.length, start + step);
        for (let j = start; j < end; j++) {
          const val = Math.abs(channelData[j]);
          if (val > max) max = val;
        }
        peaks.push(max);
        if (max > peakMax) peakMax = max;
      }
      // 归一化，避免整体过小像一条线、或过大糊成实心
      return peaks.map((p) => Math.min(1, p / peakMax));
    } catch (e) {
      console.warn("[LazyH3] 驱动音频波形提取失败:", e);
      return [];
    }
  }

  /** 若内存里 peaks 丢失，按 previewUrl/fileName 补提 */
  async _h3EnsureDrivePeaks(item) {
    if (!item) return;
    if (Array.isArray(item.waveformPeaks) && item.waveformPeaks.length > 2) return;
    if (item._peaksLoading) return;
    item._peaksLoading = true;
    try {
      let src = item.previewUrl || item._blobUrl || null;
      if (!src && item.fileName && typeof api?.apiURL === "function") {
        src = api.apiURL(
          `/view?filename=${encodeURIComponent(item.fileName)}&type=input`
        );
      }
      if (!src) return;
      const peaks = await this._h3ExtractDrivePeaks(src);
      if (peaks.length > 2) {
        item.waveformPeaks = peaks;
        const d = this.ensureH3MultiData();
        if (d.driveAudio === item) {
          this.render?.();
          this.commitChanges?.(true);
        }
      }
    } finally {
      item._peaksLoading = false;
    }
  }

  /** 仅在没有任何驱动段时，从 meta 建第 1 段（绝不覆盖已有多段） */
  _h3EnsureDriveSegmentFromMeta(item) {
    if (!this.timeline || !item) return;
    const has = (this.timeline.audioSegments || []).some((s) => s?.isH3Drive);
    if (has) return;
    this._h3AppendDriveAudioSegment(item, 0);
  }

  /** 追加一段驱动音频（可多段）；startFrame 默认接在最后一段后或红线处 */
  _h3AppendDriveAudioSegment(item, startFrame) {
    if (!this.timeline || !item) return null;
    const fps = this.getFrameRate();
    const durF = Math.max(
      1,
      Math.round((Number(item.duration) || 0) * fps) || 1
    );
    const driveSegs = (this.timeline.audioSegments || []).filter((s) => s?.isH3Drive);
    let start = typeof startFrame === "number" ? Math.max(0, Math.round(startFrame)) : null;
    if (start == null) {
      if (driveSegs.length) {
        start = driveSegs.reduce((m, s) => Math.max(m, (s.start || 0) + (s.length || 0)), 0);
      } else {
        start = Math.max(0, Math.round(this.currentFrame || 0));
      }
    }
    const seg = {
      id: "h3_drive_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
      type: "audio",
      isH3Drive: true,
      start,
      length: durF,
      trimStart: 0,
      audioDurationFrames: durF,
      name: item.name,
      audioFile: item.fileName || item.name,
      fileName: item.fileName || item.name,
      _blobUrl: item.previewUrl || item._blobUrl || null,
      waveformPeaks: item.waveformPeaks || [],
      duration: item.duration || durF / fps,
      fileSize: item.fileSize,
    };
    if (!Array.isArray(this.timeline.audioSegments)) this.timeline.audioSegments = [];
    this.timeline.audioSegments.push(seg);
    this.timeline.audioSegments.sort((a, b) => a.start - b.start);
    this._h3RefreshDriveMetaFromSegments();
    return seg;
  }

  /** 多参「参考音频」槽（最多 3，进模型参考，不定总时长） */
  async h3AddRefAudios(files, startIndex) {
    const d = this.ensureH3MultiData();
    while (d.audios.length < 3) d.audios.push(null);
    let idx =
      typeof startIndex === "number" && startIndex >= 0
        ? startIndex
        : d.audios.findIndex((x) => !x);
    if (idx < 0) idx = 0;
    for (const f of files || []) {
      if (idx >= 3) break;
      while (idx < 3 && d.audios[idx]) idx++;
      if (idx >= 3) break;
      const item = await this.h3UploadOneAudio(f);
      if (!item) continue;
      item.role = "ref";
      d.audios[idx] = item;
      idx++;
    }
    while (d.audios.length > 0 && !d.audios[d.audios.length - 1]) d.audios.pop();
    this.render?.();
    this.commitChanges?.(true);
  }

  /** 侧栏已有音频：写入参考音频槽，不再上传 */
  h3AddRefAudioPaths(refs) {
    const d = this.ensureH3MultiData();
    while (d.audios.length < 3) d.audios.push(null);
    let idx = d.audios.findIndex((x) => !x);
    if (idx < 0) idx = 0;
    for (const r of refs || []) {
      if (idx >= 3) break;
      while (idx < 3 && d.audios[idx]) idx++;
      if (idx >= 3) break;
      const fn = r.imageFile || r.filename || "";
      if (!fn) continue;
      d.audios[idx] = {
        id: "aud" + Date.now() + Math.random().toString(36).slice(2, 6),
        name: r.filename || fn,
        fileName: fn,
        duration: 0,
        role: "ref",
      };
      idx++;
    }
    while (d.audios.length > 0 && !d.audios[d.audios.length - 1]) d.audios.pop();
    this.render?.();
    this.commitChanges?.(true);
  }

  _h3SerializeRefAudios() {
    const d = this.timeline?.h3MultiRef;
    if (!d) return [];
    const src = []
      .concat(Array.isArray(d.refAudios) ? d.refAudios : [])
      .concat(Array.isArray(d.audios) ? d.audios : []);
    const out = [];
    const seen = new Set();
    for (const a of src) {
      if (!a || a.role === "drive") continue;
      if (Array.isArray(a.pieces) && a.pieces.length) continue;
      const fileName = a.fileName || a.audioFile || a.name || "";
      if (!fileName || seen.has(fileName)) continue;
      seen.add(fileName);
      out.push({
        id: a.id,
        name: a.name,
        fileName,
        duration: a.duration || 0,
        role: "ref",
      });
      if (out.length >= 3) break;
    }
    return out;
  }

  /** 多参「驱动音频」多段（定总时长 / 口型 Lock）——与参考音频独立 */
  async h3AddDriveAudios(files) {
    const list = Array.from(files || []);
    if (!list.length) return;
    this._h3DriveUserCleared = false;
    this.clearLegacyMultiTimelineMedia?.({ stopPlayback: true });
    let lastSeg = null;
    for (const f of list) {
      const item = await this.h3UploadOneAudio(f);
      if (!item) continue;
      item.role = "drive";
      item.waveformPeaks = await this._h3ExtractDrivePeaks(f);
      lastSeg = this._h3AppendDriveAudioSegment(item);
    }
    if (lastSeg) {
      this.selectionType = "audio";
      this.selectedIndex = this.timeline.audioSegments.findIndex((s) => s.id === lastSeg.id);
      this.selectedSegmentIds = [lastSeg.id];
      this.selectedH3RefIndexes = [];
    }
    if (!this.manualOutputRange) this.syncDurationToTimelineSegments();
    this.updateUIFromSelection?.();
    this.render?.();
    this.commitChanges?.(true);
  }

  h3RemoveDriveAudio() {
    const d = this.ensureH3MultiData();
    this.h3StopMediaPreview?.();
    try { this.pauseAudio?.(true); } catch (_) {}
    const removed = d.driveAudio;
    if (removed?.previewUrl) {
      try { URL.revokeObjectURL(removed.previewUrl); } catch (_) {}
    }
    // 禁止 ensureH3MultiData 再从 meta 自动重建
    this._h3DriveUserCleared = true;
    d.driveAudio = null;
    if (this.timeline) {
      this.timeline.audioSegments = (this.timeline.audioSegments || []).filter((s) => !s?.isH3Drive);
    }
    this._purgeAudioBufferCache?.(removed);
    this.selectedIndex = -1;
    this.selectedSegmentIds = (this.selectedSegmentIds || []).filter((id) => {
      const s = (this.timeline?.audioSegments || []).find((x) => x.id === id);
      return s && !s.isH3Drive;
    });
    if (this.selectionType === "audio") this.selectionType = "image";
    if (!this.manualOutputRange) this.syncDurationToTimelineSegments();
    this.updateUIFromSelection?.();
    this.render?.();
    this.commitChanges?.(true);
  }

  h3RemoveRefAudio(index) {
    const d = this.ensureH3MultiData();
    while (d.audios.length < 3) d.audios.push(null);
    if (index < 0 || index >= 3) return;
    if (this._h3PlayingAudioIdx === index) this.h3StopMediaPreview();
    const removed = d.audios[index];
    d.audios[index] = null;
    while (d.audios.length > 0 && !d.audios[d.audios.length - 1]) d.audios.pop();
    if (removed?.previewUrl) {
      try { URL.revokeObjectURL(removed.previewUrl); } catch (_) {}
    }
    this.render?.();
    this.commitChanges?.(true);
  }

  _h3GetDriveAudio() {
    const d = this.ensureH3MultiData();
    return d.driveAudio || null;
  }

  /** 添加参考音频（3 槽） */
  promptAddH3RefAudio(startIndex) {
    this._h3RefAudioTargetIndex = typeof startIndex === "number" ? startIndex : undefined;
    if (!this.h3RefAudioInput) {
      const fileIn = document.createElement("input");
      fileIn.type = "file";
      fileIn.accept = "audio/*";
      fileIn.multiple = true;
      fileIn.style.display = "none";
      fileIn.addEventListener("change", async (e) => {
        const files = Array.from(e.target.files || []);
        e.target.value = "";
        const start = this._h3RefAudioTargetIndex;
        this._h3RefAudioTargetIndex = undefined;
        await this.h3AddRefAudios(files, start);
      });
      this.h3RefAudioInput = fileIn;
      (this.wrapper || this.container)?.appendChild(fileIn);
    }
    this.h3RefAudioInput.click();
  }

  /** 添加驱动音频（时间线多段） */
  promptAddH3DriveAudio() {
    if (!this.h3DriveAudioInput) {
      const fileIn = document.createElement("input");
      fileIn.type = "file";
      fileIn.accept = "audio/*";
      fileIn.multiple = true;
      fileIn.style.display = "none";
      fileIn.addEventListener("change", async (e) => {
        const files = Array.from(e.target.files || []);
        e.target.value = "";
        await this.h3AddDriveAudios(files);
      });
      this.h3DriveAudioInput = fileIn;
      (this.wrapper || this.container)?.appendChild(fileIn);
    }
    this.h3DriveAudioInput.click();
  }

  // --- 多参参考视频（最多 3）---
  async h3UploadOneVideo(file) {
    if (!file) return null;
    const isVid =
      (file.type && file.type.startsWith("video/")) ||
      /\.(mp4|webm|mkv|avi|mov|m4v|flv|wmv)$/i.test(file.name || "");
    if (!isVid) return null;
    const previewUrl = URL.createObjectURL(file);
    let fileName = file.name;
    try {
      const form = new FormData();
      form.append("image", file, file.name);
      form.append("overwrite", "true");
      form.append("type", "input");
      const resp = await api.fetchApi("/upload/image", { method: "POST", body: form });
      if (resp.ok) {
        const data = await resp.json();
        if (data?.name) fileName = data.name;
      }
    } catch (err) {
      console.warn("[LazyH3] 参考视频上传失败，仅本地预览:", err);
    }
    let duration = 0;
    let thumbUrl = "";
    try {
      const meta = await new Promise((resolve) => {
        const v = document.createElement("video");
        v.preload = "metadata";
        v.muted = true;
        v.src = previewUrl;
        v.addEventListener("loadeddata", () => {
          try {
            v.currentTime = Math.min(0.1, (v.duration || 1) * 0.01);
          } catch (_) {}
        });
        v.addEventListener("seeked", () => {
          try {
            const c = document.createElement("canvas");
            c.width = v.videoWidth || 160;
            c.height = v.videoHeight || 90;
            const ctx = c.getContext("2d");
            ctx.drawImage(v, 0, 0, c.width, c.height);
            resolve({ duration: v.duration || 0, thumbUrl: c.toDataURL("image/jpeg", 0.7) });
          } catch (_) {
            resolve({ duration: v.duration || 0, thumbUrl: "" });
          }
        });
        v.addEventListener("error", () => resolve({ duration: 0, thumbUrl: "" }));
        setTimeout(() => resolve({ duration: 0, thumbUrl: "" }), 5000);
      });
      duration = meta.duration;
      thumbUrl = meta.thumbUrl;
    } catch (_) {}
    return {
      id: "vid" + Date.now() + Math.random().toString(36).slice(2, 6),
      name: file.name,
      fileName,
      videoFile: fileName,
      previewUrl,
      thumbUrl,
      duration,
    };
  }

  async h3AddRefVideos(files, startIndex) {
    const d = this.ensureH3MultiData();
    while (d.videos.length < 3) d.videos.push(null);
    let idx =
      typeof startIndex === "number" && startIndex >= 0
        ? startIndex
        : d.videos.findIndex((x) => !x);
    if (idx < 0) idx = 0;
    for (const f of files || []) {
      if (idx >= 3) break;
      while (idx < 3 && d.videos[idx]) idx++;
      if (idx >= 3) break;
      const item = await this.h3UploadOneVideo(f);
      if (item) {
        d.videos[idx] = item;
        idx++;
      }
    }
    while (d.videos.length > 0 && !d.videos[d.videos.length - 1]) d.videos.pop();
    this.render?.();
    this.commitChanges?.(true);
  }

  h3RemoveRefVideo(index) {
    const d = this.ensureH3MultiData();
    while (d.videos.length < 3) d.videos.push(null);
    if (index < 0 || index >= 3) return;
    if (this._h3PlayingVideoIdx === index) this.h3StopMediaPreview();
    try {
      this.pauseAudio?.(true);
    } catch (_) {}
    this.h3StopMediaPreview?.();
    const removed = d.videos[index];
    d.videos[index] = null;
    while (d.videos.length > 0 && !d.videos[d.videos.length - 1]) d.videos.pop();
    if (removed?.previewUrl) {
      try { URL.revokeObjectURL(removed.previewUrl); } catch (_) {}
    }
    this.clearLegacyMultiTimelineMedia();
    this._purgeAudioBufferCache?.(removed);
    if (!this.manualOutputRange) this.syncDurationToTimelineSegments();
    this.render?.();
    this.commitChanges?.(true);
  }

  promptAddH3RefVideo(startIndex) {
    this._h3RefVideoTargetIndex = typeof startIndex === "number" ? startIndex : undefined;
    if (!this.h3RefVideoInput) {
      const fileIn = document.createElement("input");
      fileIn.type = "file";
      fileIn.accept = "video/*";
      fileIn.multiple = true;
      fileIn.style.display = "none";
      fileIn.addEventListener("change", async (e) => {
        const files = Array.from(e.target.files || []);
        e.target.value = "";
        const start = this._h3RefVideoTargetIndex;
        this._h3RefVideoTargetIndex = undefined;
        await this.h3AddRefVideos(files, start);
      });
      this.h3RefVideoInput = fileIn;
      (this.wrapper || this.container)?.appendChild(fileIn);
    }
    this.h3RefVideoInput.click();
  }

  h3StopMediaPreview() {
    if (this._h3PreviewAudio) {
      try {
        this._h3PreviewAudio.pause();
        this._h3PreviewAudio.currentTime = 0;
      } catch (_) {}
      this._h3PreviewAudio = null;
    }
    if (this._h3PreviewVideo) {
      try {
        this._h3PreviewVideo.pause();
        this._h3PreviewVideo.currentTime = 0;
        if (this._h3PreviewVideo.parentNode) this._h3PreviewVideo.parentNode.removeChild(this._h3PreviewVideo);
      } catch (_) {}
      this._h3PreviewVideo = null;
    }
    if (this._h3PreviewRaf) {
      cancelAnimationFrame(this._h3PreviewRaf);
      this._h3PreviewRaf = null;
    }
    this._h3PlayingAudioIdx = -1;
    this._h3PlayingAudioKind = null;
    this._h3PlayingVideoIdx = -1;
    this._h3PreviewRemain = 0;
    this.render?.();
  }

  h3TogglePlayAudio(index, kind = "ref") {
    const d = this.ensureH3MultiData();
    const item =
      kind === "drive"
        ? this._h3GetDriveAudio?.()
        : (d.audios && d.audios[index]) || null;
    if (!item) return;
    if (kind === "drive") index = 0;
    if (this._h3PlayingAudioIdx === index && this._h3PlayingAudioKind === kind) {
      this.h3StopMediaPreview();
      return;
    }
    this.h3StopMediaPreview();
    const src =
      item.previewUrl ||
      (item.fileName && typeof api?.apiURL === "function"
        ? api.apiURL(`/view?filename=${encodeURIComponent(item.fileName)}&type=input`)
        : "");
    if (!src) return;
    const a = new Audio(src);
    this._h3PreviewAudio = a;
    this._h3PlayingAudioIdx = index;
    this._h3PlayingAudioKind = kind;
    a.play().catch(() => this.h3StopMediaPreview());
    const tick = () => {
      if (!this._h3PreviewAudio || this._h3PlayingAudioIdx !== index) return;
      const rem = Math.max(0, (a.duration || item.duration || 0) - (a.currentTime || 0));
      this._h3PreviewRemain = rem;
      this.render?.();
      if (!a.ended && !a.paused) this._h3PreviewRaf = requestAnimationFrame(tick);
      else this.h3StopMediaPreview();
    };
    a.addEventListener("ended", () => this.h3StopMediaPreview());
    this._h3PreviewRaf = requestAnimationFrame(tick);
  }

  h3TogglePlayVideo(index) {
    const d = this.ensureH3MultiData();
    const item = d.videos[index];
    if (!item) return;
    if (this._h3PlayingVideoIdx === index) {
      this.h3StopMediaPreview();
      return;
    }
    this.h3StopMediaPreview();
    const src =
      item.previewUrl ||
      (item.fileName && typeof api?.apiURL === "function"
        ? api.apiURL(`/view?filename=${encodeURIComponent(item.fileName)}&type=input`)
        : "");
    if (!src) return;
    const v = document.createElement("video");
    v.src = src;
    v.muted = false;
    v.playsInline = true;
    v.style.cssText =
      "position:fixed;right:16px;bottom:16px;width:320px;max-width:40vw;z-index:99999;border-radius:8px;background:#000;box-shadow:0 8px 24px rgba(0,0,0,.5);";
    document.body.appendChild(v);
    this._h3PreviewVideo = v;
    this._h3PlayingVideoIdx = index;
    v.play().catch(() => this.h3StopMediaPreview());
    const tick = () => {
      if (!this._h3PreviewVideo || this._h3PlayingVideoIdx !== index) return;
      const rem = Math.max(0, (v.duration || item.duration || 0) - (v.currentTime || 0));
      this._h3PreviewRemain = rem;
      this.render?.();
      if (!v.ended && !v.paused) this._h3PreviewRaf = requestAnimationFrame(tick);
      else this.h3StopMediaPreview();
    };
    v.addEventListener("ended", () => this.h3StopMediaPreview());
    this._h3PreviewRaf = requestAnimationFrame(tick);
  }

  /** 从 Comfy 路径添加多参图 */
  async h3AddRefImagesFromPaths(paths) {
    const d = this.ensureH3MultiData();
    while (d.images.length < 9) d.images.push(null);
    let idx = d.images.findIndex((x) => !x);
    if (idx < 0) idx = 0;
    for (const p of paths || []) {
      if (idx >= 9) break;
      while (idx < 9 && d.images[idx]) idx++;
      if (idx >= 9) break;
      const fileName = p.name || p.filename || p.path || "";
      if (!fileName) continue;
      const item = {
        id: "img" + Date.now() + Math.random().toString(36).slice(2, 6),
        name: fileName,
        fileName,
      };
      this.h3EnsureImageEl(item);
      d.images[idx] = item;
      idx++;
    }
    while (d.images.length > 0 && !d.images[d.images.length - 1]) d.images.pop();
    this.render?.();
    this.commitChanges?.(true);
  }

  /** 兼容旧调用：多参图已改为画布轨 */
  renderH3RefStrip() {
    this.render?.();
  }

  /** 多参图轨布局：左侧缩略图 + 命中区 */
  getH3RefLayout(width) {
    const refH = this.getRefTrackHeight();
    if (refH <= 0) return { slots: [], plus: null, top: RULER_HEIGHT, height: 0 };
    const d = this.ensureH3MultiData();
    const top = RULER_HEIGHT;
    const pad = 8;
    const gap = 8;
    const slotH = Math.max(28, Math.min(refH - 16, 80));
    const slotW = slotH;
    const slots = [];
    let x = pad;
    for (let i = 0; i < 9; i++) {
      const item = d.images[i];
      if (!item) continue;
      const y = top + (refH - slotH) / 2;
      slots.push({
        index: i,
        item,
        x,
        y,
        w: slotW,
        h: slotH,
        xBtn: { x: x + slotW - 18, y: y + 2, w: 16, h: 16 },
      });
      x += slotW + gap;
    }
    // 与其它轨一致：空隙中央 + 号（视口可见中心）
    const count = slots.length;
    let plus = null;
    if (count < 9) {
      const viewLeft = this.viewport?.scrollLeft || 0;
      const viewW = this.viewport?.clientWidth || width || 400;
      const centerX = viewLeft + Math.max(40, viewW * 0.5);
      const centerY = top + refH / 2;
      plus = { centerX, centerY, r: 12 };
    }
    return { slots, plus, top, height: refH, nextIndex: count };
  }

  drawH3RefTrack(width) {
    const refH = this.getRefTrackHeight();
    if (refH <= 0 || !this.ctx) return;
    const top = RULER_HEIGHT;
    // 与音频轨同色灰底
    this.ctx.fillStyle = "#141414";
    this.ctx.fillRect(0, top, width, refH);

    const layout = this.getH3RefLayout(width);
    this._h3RefLayout = layout;

    const refDrag = this._h3RefDrag?.active ? this._h3RefDrag : null;
    layout.slots.forEach((s, visualIdx) => {
      const dim = refDrag && visualIdx === refDrag.from;
      if (dim) this.ctx.globalAlpha = 0.35;
      this.ctx.save();
      this.ctx.beginPath();
      if (this.ctx.roundRect) this.ctx.roundRect(s.x, s.y, s.w, s.h, 6);
      else this.ctx.rect(s.x, s.y, s.w, s.h);
      this.ctx.clip();
      this.ctx.fillStyle = "#1a1a1a";
      this.ctx.fillRect(s.x, s.y, s.w, s.h);
      const imgEl = this.h3EnsureImageEl(s.item);
      if (imgEl && imgEl.complete && imgEl.naturalWidth > 0) {
        const ir = imgEl.naturalWidth / imgEl.naturalHeight;
        const sr = s.w / s.h;
        let dw, dh, dx, dy;
        if (ir > sr) {
          dh = s.h;
          dw = s.h * ir;
          dx = s.x - (dw - s.w) / 2;
          dy = s.y;
        } else {
          dw = s.w;
          dh = s.w / ir;
          dx = s.x;
          dy = s.y - (dh - s.h) / 2;
        }
        this.ctx.drawImage(imgEl, dx, dy, dw, dh);
      }
      this.ctx.restore();

      // 边框（选中高亮）
      const refSelected = (this.selectedH3RefIndexes || []).includes(s.index);
      this.ctx.strokeStyle = refSelected ? "#6af" : "#333";
      this.ctx.lineWidth = refSelected ? 2.5 : 1;
      this.ctx.beginPath();
      if (this.ctx.roundRect) this.ctx.roundRect(s.x, s.y, s.w, s.h, 6);
      else this.ctx.rect(s.x, s.y, s.w, s.h);
      this.ctx.stroke();
      if (refSelected) {
        this.ctx.fillStyle = "rgba(100,170,255,0.18)";
        this.ctx.fill();
      }

      // 编号
      this.ctx.fillStyle = "rgba(0,0,0,0.7)";
      this.ctx.fillRect(s.x + 3, s.y + 3, 18, 16);
      this.ctx.fillStyle = "#9cf";
      this.ctx.font = "bold 10px sans-serif";
      this.ctx.textAlign = "center";
      this.ctx.textBaseline = "middle";
      this.ctx.fillText(String(visualIdx + 1), s.x + 12, s.y + 11);

      // 删除 ×
      this.ctx.fillStyle = "rgba(0,0,0,0.65)";
      this.ctx.fillRect(s.xBtn.x, s.xBtn.y, s.xBtn.w, s.xBtn.h);
      this.ctx.fillStyle = "#fff";
      this.ctx.font = "12px sans-serif";
      this.ctx.fillText("×", s.xBtn.x + s.xBtn.w / 2, s.xBtn.y + s.xBtn.h / 2 + 0.5);
      if (dim) this.ctx.globalAlpha = 1;
    });

    if (refDrag && layout.slots.length) {
      const slots = layout.slots;
      const at = Math.max(0, Math.min(slots.length, refDrag.over ?? refDrag.from));
      const markX = at >= slots.length
        ? slots[slots.length - 1].x + slots[slots.length - 1].w + 4
        : slots[at].x - 4;
      this.ctx.fillStyle = "#9cf";
      this.ctx.fillRect(markX, top + 8, 2, refH - 16);
      const src = slots[refDrag.from];
      if (src) {
        const gw = src.w;
        const gh = src.h;
        const gx = (refDrag.x || 0) - gw / 2;
        const gy = (refDrag.y || 0) - gh / 2;
        this.ctx.save();
        this.ctx.globalAlpha = 0.9;
        this.ctx.fillStyle = "#1a1a1a";
        this.ctx.fillRect(gx, gy, gw, gh);
        const imgEl = this.h3EnsureImageEl(src.item);
        if (imgEl && imgEl.complete && imgEl.naturalWidth > 0) {
          this.ctx.drawImage(imgEl, gx, gy, gw, gh);
        }
        this.ctx.strokeStyle = "#9cf";
        this.ctx.lineWidth = 2;
        this.ctx.strokeRect(gx, gy, gw, gh);
        this.ctx.restore();
      }
    }

    // 拖入 Drop 提示框（与主轨 Drop to Place 一致）
    if (this._ghostTrack === "ref" && this._refDropGhost) {
      const totalFrames = Math.max(1, this.getVisualDurationFrames());
      const g = this._refDropGhost;
      let startX;
      let boxW;
      if (g.mouseX != null) {
        // 跟随鼠标：方块居中在指针下
        const slotH = Math.max(28, Math.min(refH - 16, 80));
        boxW = Math.max(slotH, 72);
        startX = g.mouseX - boxW / 2;
      } else {
        startX = ((g.start || 0) / totalFrames) * width;
        boxW = Math.max(48, ((g.length || 24) / totalFrames) * width);
      }
      startX = Math.max(4, Math.min(startX, width - boxW - 4));
      const boxY = top + 6;
      const boxH = Math.max(28, refH - 12);

      this.ctx.globalAlpha = 0.9;
      this.ctx.fillStyle = "#2a2a2a";
      this.ctx.fillRect(startX, boxY, boxW, boxH);
      this.ctx.strokeStyle = "#777";
      this.ctx.lineWidth = 2;
      this.ctx.setLineDash([5, 5]);
      this.ctx.strokeRect(startX + 1, boxY + 1, boxW - 2, boxH - 2);
      this.ctx.setLineDash([]);
      this.ctx.fillStyle = "#aaa";
      this.ctx.textAlign = "center";
      this.ctx.textBaseline = "middle";
      this.ctx.font = "bold 12px sans-serif";
      this.ctx.fillText("Drop to Place", startX + boxW / 2, boxY + boxH / 2);
      this.ctx.globalAlpha = 1.0;
    }

    // 分隔线
    this.ctx.fillStyle = "#111";
    this.ctx.fillRect(0, top + refH - 1, width, 1);
  }

  /** 多参：驱动音频多段绘制（与主轨音段相同：波形+选中柄，可拖动） */
  drawH3DriveAudioTrack(width, trackTop, trackH) {
    if (trackH <= 0 || !this.ctx) return;
    this.ctx.fillStyle = "#141414";
    this.ctx.fillRect(0, trackTop, width, trackH);

    const driveSegs = (this.timeline?.audioSegments || []).filter((s) => s?.isH3Drive);
    const meta = this._h3GetDriveAudio?.();
    if (!driveSegs.length && meta) {
      this._h3EnsureDriveSegmentFromMeta(meta);
    }
    const segs = (this.timeline?.audioSegments || []).filter((s) => s?.isH3Drive);
    const visFrames = Math.max(1, this.getVisualDurationFrames());

    if (!segs.length) {
      this.ctx.fillStyle = "#888";
      this.ctx.font = "12px sans-serif";
      this.ctx.textAlign = "center";
      this.ctx.textBaseline = "middle";
      this.ctx.fillText("＋ 添加驱动音频（可多段）", Math.max(120, width * 0.25), trackTop + trackH / 2);
      this._h3AudioLayout = { mode: "drive", item: null, top: trackTop, height: trackH, slots: [] };
    } else {
      for (const seg of segs) {
        if (!seg.audioDurationFrames) {
          seg.audioDurationFrames = Math.max(
            (seg.trimStart || 0) + (seg.length || 0),
            seg.length || 1
          );
        }
        if (!(seg.waveformPeaks?.length > 2) && meta) {
          seg.waveformPeaks = meta.waveformPeaks;
          this._h3EnsureDrivePeaks?.(meta);
        }
        const rawStartX = (seg.start / visFrames) * width;
        const rawEndX = ((seg.start + seg.length) / visFrames) * width;
        const startX = Math.floor(rawStartX);
        const pxWidth = Math.max(1, Math.floor(rawEndX) - startX);
        const isSelected = (this.selectedSegmentIds || []).includes(seg.id);
        const showHandles = !this.isMultiSelectActive();
        this.drawAudioSegmentVisuals(
          this.ctx,
          seg,
          isSelected,
          trackTop,
          trackH,
          startX,
          pxWidth,
          isSelected ? "#fff" : null,
          showHandles
        );
      }
      this._h3AudioLayout = { mode: "drive", item: meta, top: trackTop, height: trackH, slots: [] };
    }

    if (this._multiDropTrack === "audio") {
      this.ctx.strokeStyle = "#3ecf6e";
      this.ctx.lineWidth = 2;
      this.ctx.setLineDash([5, 5]);
      this.ctx.strokeRect(4, trackTop + 4, Math.max(80, width * 0.4), trackH - 8);
      this.ctx.setLineDash([]);
    }
    this.ctx.fillStyle = "#111";
    this.ctx.fillRect(0, trackTop + trackH - 1, width, 1);
  }

  /** @deprecated 保留别名，避免旧调用报错 */
  drawH3MultiAudioTrack(width, trackTop, trackH) {
    return this.drawH3DriveAudioTrack(width, trackTop, trackH);
  }

  /** 多参：参考音频轨画 3 槽（与驱动音频独立） */
  drawH3MultiRefAudioTrack(width, trackTop, trackH) {
    if (trackH <= 0 || !this.ctx) return;
    this.ctx.fillStyle = "#121212";
    this.ctx.fillRect(0, trackTop, width, trackH);
    const d = this.ensureH3MultiData();
    const pad = 8;
    const gap = 8;
    const slotH = Math.max(36, Math.min(trackH - 12, 64));
    const slotW = Math.round(slotH * 1.6);
    const slots = [];
    let x = pad;
    for (let i = 0; i < 3; i++) {
      const item = d.audios[i];
      const y = trackTop + (trackH - slotH) / 2;
      const playing = this._h3PlayingAudioIdx === i && this._h3PlayingAudioKind === "ref";
      this.ctx.save();
      this.ctx.beginPath();
      if (this.ctx.roundRect) this.ctx.roundRect(x, y, slotW, slotH, 6);
      else this.ctx.rect(x, y, slotW, slotH);
      this.ctx.clip();
      this.ctx.fillStyle = item ? "#1a2430" : "#1a1a1a";
      this.ctx.fillRect(x, y, slotW, slotH);
      if (item) {
        // 简易波形装饰
        this.ctx.strokeStyle = "#5af";
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        const mid = y + slotH / 2;
        for (let px = 0; px < slotW; px += 3) {
          const h = 4 + ((px * 7 + i * 13) % 17);
          this.ctx.moveTo(x + px, mid - h / 2);
          this.ctx.lineTo(x + px, mid + h / 2);
        }
        this.ctx.stroke();
        const name = String(item.name || item.fileName || "音").slice(0, 8);
        this.ctx.fillStyle = "rgba(0,0,0,0.55)";
        this.ctx.fillRect(x, y + slotH - 16, slotW, 16);
        this.ctx.fillStyle = "#ddd";
        this.ctx.font = "10px sans-serif";
        this.ctx.textAlign = "center";
        this.ctx.textBaseline = "middle";
        this.ctx.fillText(name, x + slotW / 2, y + slotH - 8);
      }
      this.ctx.restore();
      this.ctx.strokeStyle = item ? "#555" : "#444";
      this.ctx.lineWidth = 1;
      this.ctx.setLineDash(item ? [] : [4, 4]);
      this.ctx.beginPath();
      if (this.ctx.roundRect) this.ctx.roundRect(x, y, slotW, slotH, 6);
      else this.ctx.rect(x, y, slotW, slotH);
      this.ctx.stroke();
      this.ctx.setLineDash([]);

      this.ctx.fillStyle = "rgba(0,0,0,0.7)";
      this.ctx.fillRect(x + 3, y + 3, 16, 14);
      this.ctx.fillStyle = "#9cf";
      this.ctx.font = "bold 10px sans-serif";
      this.ctx.textAlign = "center";
      this.ctx.textBaseline = "middle";
      this.ctx.fillText(String(i + 1), x + 11, y + 10);

      if (item) {
        const cx = x + slotW / 2;
        const cy = y + slotH / 2 - 4;
        this.ctx.fillStyle = "rgba(0,0,0,0.55)";
        this.ctx.beginPath();
        this.ctx.arc(cx, cy, 12, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.fillStyle = "#fff";
        if (playing) {
          this.ctx.font = "bold 11px sans-serif";
          this.ctx.fillText(String(Math.ceil(this._h3PreviewRemain || 0)), cx, cy + 0.5);
        } else {
          this.ctx.beginPath();
          this.ctx.moveTo(cx - 4, cy - 6);
          this.ctx.lineTo(cx - 4, cy + 6);
          this.ctx.lineTo(cx + 6, cy);
          this.ctx.closePath();
          this.ctx.fill();
        }
        this.ctx.fillStyle = "rgba(0,0,0,0.65)";
        this.ctx.fillRect(x + slotW - 18, y + 2, 16, 16);
        this.ctx.fillStyle = "#fff";
        this.ctx.font = "12px sans-serif";
        this.ctx.fillText("×", x + slotW - 10, y + 10);
      } else {
        this.ctx.fillStyle = "#888";
        this.ctx.font = "20px sans-serif";
        this.ctx.fillText("＋", x + slotW / 2, y + slotH / 2);
      }
      slots.push({
        index: i,
        item,
        x,
        y,
        w: slotW,
        h: slotH,
        play: { x: x + slotW / 2 - 12, y: y + slotH / 2 - 16, w: 24, h: 24 },
        xBtn: { x: x + slotW - 18, y: y + 2, w: 16, h: 16 },
      });
      x += slotW + gap;
    }
    this._h3RefAudioLayout = { slots, top: trackTop, height: trackH, mode: "ref_audio" };
    if (this._multiDropTrack === "ref_audio") {
      this.ctx.strokeStyle = "#5af";
      this.ctx.lineWidth = 2;
      this.ctx.setLineDash([5, 5]);
      this.ctx.strokeRect(4, trackTop + 4, Math.max(100, width * 0.28), trackH - 8);
      this.ctx.setLineDash([]);
    }
    this.ctx.fillStyle = "#111";
    this.ctx.fillRect(0, trackTop + trackH - 1, width, 1);
  }

  /** 多参：参考视频轨画 3 槽首帧+播放 */
  drawH3MultiVideoTrack(width, trackTop, trackH) {
    if (trackH <= 0 || !this.ctx) return;
    this.ctx.fillStyle = "#121212";
    this.ctx.fillRect(0, trackTop, width, trackH);
    const d = this.ensureH3MultiData();
    const pad = 8;
    const gap = 8;
    const slotH = Math.max(36, Math.min(trackH - 12, 72));
    const slotW = Math.round(slotH * 1.4);
    const slots = [];
    let x = pad;
    for (let i = 0; i < 3; i++) {
      const item = d.videos[i];
      const y = trackTop + (trackH - slotH) / 2;
      const playing = this._h3PlayingVideoIdx === i;
      this.ctx.save();
      this.ctx.beginPath();
      if (this.ctx.roundRect) this.ctx.roundRect(x, y, slotW, slotH, 6);
      else this.ctx.rect(x, y, slotW, slotH);
      this.ctx.clip();
      this.ctx.fillStyle = item ? "#111" : "#1a1a1a";
      this.ctx.fillRect(x, y, slotW, slotH);
      if (item && item.thumbUrl) {
        if (!item._thumbImg) {
          item._thumbImg = new Image();
          item._thumbImg.onload = () => this.render?.();
          item._thumbImg.src = item.thumbUrl;
        }
        if (item._thumbImg.complete && item._thumbImg.naturalWidth) {
          const ir = item._thumbImg.naturalWidth / item._thumbImg.naturalHeight;
          const sr = slotW / slotH;
          let dw, dh, dx, dy;
          if (ir > sr) {
            dh = slotH;
            dw = slotH * ir;
            dx = x - (dw - slotW) / 2;
            dy = y;
          } else {
            dw = slotW;
            dh = slotW / ir;
            dx = x;
            dy = y - (dh - slotH) / 2;
          }
          this.ctx.drawImage(item._thumbImg, dx, dy, dw, dh);
        }
      }
      this.ctx.restore();
      this.ctx.strokeStyle = item ? "#555" : "#444";
      this.ctx.lineWidth = 1;
      this.ctx.setLineDash(item ? [] : [4, 4]);
      this.ctx.beginPath();
      if (this.ctx.roundRect) this.ctx.roundRect(x, y, slotW, slotH, 6);
      else this.ctx.rect(x, y, slotW, slotH);
      this.ctx.stroke();
      this.ctx.setLineDash([]);

      this.ctx.fillStyle = "rgba(0,0,0,0.7)";
      this.ctx.fillRect(x + 3, y + 3, 16, 14);
      this.ctx.fillStyle = "#9cf";
      this.ctx.font = "bold 10px sans-serif";
      this.ctx.textAlign = "center";
      this.ctx.textBaseline = "middle";
      this.ctx.fillText(String(i + 1), x + 11, y + 10);

      if (item) {
        const cx = x + slotW / 2;
        const cy = y + slotH / 2;
        this.ctx.fillStyle = "rgba(0,0,0,0.55)";
        this.ctx.beginPath();
        this.ctx.arc(cx, cy, 14, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.fillStyle = "#fff";
        if (playing) {
          this.ctx.font = "bold 12px sans-serif";
          this.ctx.fillText(String(Math.ceil(this._h3PreviewRemain || 0)), cx, cy + 0.5);
        } else {
          this.ctx.beginPath();
          this.ctx.moveTo(cx - 5, cy - 7);
          this.ctx.lineTo(cx - 5, cy + 7);
          this.ctx.lineTo(cx + 7, cy);
          this.ctx.closePath();
          this.ctx.fill();
        }
        this.ctx.fillStyle = "rgba(0,0,0,0.65)";
        this.ctx.fillRect(x + slotW - 18, y + 2, 16, 16);
        this.ctx.fillStyle = "#fff";
        this.ctx.font = "12px sans-serif";
        this.ctx.fillText("×", x + slotW - 10, y + 10);
      } else {
        this.ctx.fillStyle = "#888";
        this.ctx.font = "20px sans-serif";
        this.ctx.fillText("＋", x + slotW / 2, y + slotH / 2);
      }
      slots.push({
        index: i,
        item,
        x,
        y,
        w: slotW,
        h: slotH,
        play: { x: x + slotW / 2 - 14, y: y + slotH / 2 - 14, w: 28, h: 28 },
        xBtn: { x: x + slotW - 18, y: y + 2, w: 16, h: 16 },
      });
      x += slotW + gap;
    }
    this._h3VideoLayout = { slots, top: trackTop, height: trackH };
    if (this._multiDropTrack === "motion") {
      this.ctx.strokeStyle = "#888";
      this.ctx.lineWidth = 2;
      this.ctx.setLineDash([5, 5]);
      this.ctx.strokeRect(4, trackTop + 4, Math.max(100, width * 0.28), trackH - 8);
      this.ctx.setLineDash([]);
      this.ctx.fillStyle = "#aaa";
      this.ctx.font = "bold 12px sans-serif";
      this.ctx.textAlign = "center";
      this.ctx.textBaseline = "middle";
      this.ctx.fillText("Drop to Place", Math.max(100, width * 0.28) / 2 + 4, trackTop + trackH / 2);
    }
    this.ctx.fillStyle = "#111";
    this.ctx.fillRect(0, trackTop + trackH - 1, width, 1);
  }

  hitH3MultiMediaSlots(mx, my, layout) {
    if (!layout) return null;
    if (my < layout.top || my > layout.top + layout.height) return null;
    // 驱动音频空轨：点空白即添加
    if (layout.mode === "drive" && !layout.item && layout.empty) {
      const e = layout.empty;
      if (mx >= e.x && mx <= e.x + e.w && my >= e.y && my <= e.y + e.h) {
        return { type: "add", index: 0 };
      }
      return { type: "add", index: 0 };
    }
    if (!layout.slots) return null;
    for (const s of layout.slots) {
      if (s.item) {
        const xb = s.xBtn;
        if (mx >= xb.x && mx <= xb.x + xb.w && my >= xb.y && my <= xb.y + xb.h) {
          return { type: "x", index: s.index };
        }
        const p = s.play;
        if (mx >= p.x && mx <= p.x + p.w && my >= p.y && my <= p.y + p.h) {
          return { type: "play", index: s.index };
        }
        if (mx >= s.x && mx <= s.x + s.w && my >= s.y && my <= s.y + s.h) {
          return { type: "play", index: s.index };
        }
      } else if (mx >= s.x && mx <= s.x + s.w && my >= s.y && my <= s.y + s.h) {
        return { type: "add", index: s.index };
      }
    }
    return { type: "track" };
  }

  hitH3RefTrack(mx, my) {
    const layout = this._h3RefLayout || this.getH3RefLayout(this.canvas?.offsetWidth || 0);
    if (!layout || layout.height <= 0) return null;
    if (my < layout.top || my > layout.top + layout.height) return null;
    for (const s of layout.slots) {
      const xb = s.xBtn;
      if (mx >= xb.x && mx <= xb.x + xb.w && my >= xb.y && my <= xb.y + xb.h) {
        return { type: "x", index: s.index };
      }
      if (mx >= s.x && mx <= s.x + s.w && my >= s.y && my <= s.y + s.h) {
        return { type: "img", index: s.index };
      }
    }
    if (layout.plus) {
      const dx = mx - layout.plus.centerX;
      const dy = my - layout.plus.centerY;
      if (dx * dx + dy * dy <= (layout.plus.r + 4) * (layout.plus.r + 4)) {
        return { type: "plus", index: layout.nextIndex };
      }
    }
    return { type: "track" };
  }

  /** 多参切换时同步节点高度，避免底部输入框溢出背景框 */
  syncH3NodeHeight() {
    if (!this.isH3Director || !this.node) return;
    try {
      // 优先节点 computeSize（含标题/其它控件），否则用 timeline_ui 控件高度估算
      let h = 0;
      if (typeof this.node.computeSize === "function") {
        const sz = this.node.computeSize(this.node.size?.[0] || 1375);
        if (Array.isArray(sz) && sz[1] > 0) h = sz[1];
      }
      if (h <= 0) {
        const w = this.node.widgets?.find(
          (x) => x.name === "timeline_ui" || x.type === "timeline_ui"
        );
        if (w && typeof w.computeSize === "function") {
          const sz = w.computeSize(this.node.size?.[0] || 1375);
          // DOM 控件高度 + 节点标题/边距余量
          if (Array.isArray(sz) && sz[1] > 0) h = sz[1] + 80;
        }
      }
      if (h > 0) {
        // 多参内容更高时抬高；切回分镜时也允许按计算结果收一收
        this.node.size[1] = h;
      }
      this.node.setDirtyCanvas?.(true, true);
      if (window.app?.graph) window.app.graph.setDirtyCanvas(true, true);
    } catch (e) {
      console.warn("[LazyH3] syncH3NodeHeight:", e);
    }
  }

  applyH3TrackLayout(isMulti) {
    const REF_H = this.refTrackHeight > 40 ? this.refTrackHeight : 96;
    const REF_AUD_H = 78; // 参考音频 3 槽
    const AUDIO_H = 64; // 驱动音频波形轨
    const MOTION_H = 90;
    this.blockHeight = this.blockHeight > 40 ? this.blockHeight : BLOCK_HEIGHT;
    if (isMulti) {
      this.refTrackHeight = REF_H;
      this.refAudioTrackHeight = REF_AUD_H;
      this.audioTrackEnabled = true;
      this.motionTrackEnabled = true;
      this.timeline.audioTrackEnabled = true;
      this.timeline.motionTrackEnabled = true;
      this.audioTrackHeight = AUDIO_H;
      this.motionTrackHeight = MOTION_H;
      // DOM 顺序：多参图 → 主轨 → 参考音频 → 参考视频 → 驱动音频
      if (this.sidebar) {
        try {
          if (this.refTrackLabel) this.sidebar.appendChild(this.refTrackLabel);
          if (this.mainTrackLabel) this.sidebar.appendChild(this.mainTrackLabel);
          if (this.refAudioTrackLabel) this.sidebar.appendChild(this.refAudioTrackLabel);
          if (this.motionTrackLabel) this.sidebar.appendChild(this.motionTrackLabel);
          if (this.audioTrackLabel) this.sidebar.appendChild(this.audioTrackLabel);
        } catch (_) {}
      }
      if (this.refTrackLabel) {
        this.refTrackLabel.style.display = "flex";
        this.refTrackLabel.style.height = `${this.refTrackHeight}px`;
      }
      if (this.refAudioTrackLabel) {
        this.refAudioTrackLabel.style.display = "flex";
        this.refAudioTrackLabel.style.height = `${REF_AUD_H}px`;
        const sp = this.refAudioTrackLabel.querySelector("span");
        if (sp) sp.textContent = "参考音频";
      }
      if (this.audioTrackLabel) {
        this.audioTrackLabel.style.display = "flex";
        this.audioTrackLabel.style.height = `${AUDIO_H}px`;
        const sp = this.audioTrackLabel.querySelector("span");
        if (sp) sp.textContent = "驱动音频";
      }
      if (this.motionTrackLabel) {
        this.motionTrackLabel.style.display = "flex";
        this.motionTrackLabel.style.height = `${MOTION_H}px`;
        const sp = this.motionTrackLabel.querySelector("span");
        if (sp) sp.textContent = "参考视频";
      }
      this.applyH3ToolbarButtons?.(true);
    } else {
      // 分镜：主轨 + 驱动音频（无多参图/参考音/参考视频）
      this.refTrackHeight = 0;
      this.refAudioTrackHeight = 0;
      this.audioTrackEnabled = true;
      this.motionTrackEnabled = false;
      this.timeline.audioTrackEnabled = true;
      this.timeline.motionTrackEnabled = false;
      this.audioTrackHeight = AUDIO_H;
      this.motionTrackHeight = 0;
      if (this.sidebar) {
        try {
          if (this.refTrackLabel) this.sidebar.appendChild(this.refTrackLabel);
          if (this.mainTrackLabel) this.sidebar.appendChild(this.mainTrackLabel);
          if (this.audioTrackLabel) this.sidebar.appendChild(this.audioTrackLabel);
          if (this.refAudioTrackLabel) this.sidebar.appendChild(this.refAudioTrackLabel);
          if (this.motionTrackLabel) this.sidebar.appendChild(this.motionTrackLabel);
        } catch (_) {}
      }
      if (this.refTrackLabel) {
        this.refTrackLabel.style.display = "none";
        this.refTrackLabel.style.height = "0px";
      }
      if (this.refAudioTrackLabel) {
        this.refAudioTrackLabel.style.display = "none";
        this.refAudioTrackLabel.style.height = "0px";
      }
      if (this.audioTrackLabel) {
        this.audioTrackLabel.style.display = "flex";
        this.audioTrackLabel.style.height = `${AUDIO_H}px`;
        const sp = this.audioTrackLabel.querySelector("span");
        if (sp) sp.textContent = "驱动音频";
      }
      if (this.motionTrackLabel) {
        this.motionTrackLabel.style.display = "none";
        this.motionTrackLabel.style.height = "0px";
      }
      this.applyH3ToolbarButtons?.(false);
    }
    // 多参 5 轨 / 分镜 2 轨（主轨+驱动）
    this.canvasHeight =
      RULER_HEIGHT +
      this.refTrackHeight +
      this.blockHeight +
      (this.refAudioTrackHeight || 0) +
      this.motionTrackHeight +
      this.audioTrackHeight;
    if (this.mainTrackLabel) {
      this.mainTrackLabel.style.display = "flex";
      this.mainTrackLabel.style.height = `${this.blockHeight}px`;
      const sp = this.mainTrackLabel.querySelector("span");
      if (sp) sp.textContent = "主轨";
    }
    if (this.canvas) this.canvas.style.height = `${this.canvasHeight}px`;
    if (this.viewport) {
      this.viewport.style.height = `${this.canvasHeight}px`;
      this.viewport.style.minHeight = `${this.canvasHeight}px`;
      this.viewport.style.display = "";
      this.viewport.style.flexGrow = "1";
      this.viewport.style.minWidth = "0";
      this.viewport.style.position = "relative";
    }
    if (this.layoutContainer) {
      this.layoutContainer.style.display = "flex";
      this.layoutContainer.style.flexDirection = "row";
      this.layoutContainer.style.width = "100%";
    }
    this.updateSidebarHeights?.();
    if (this.updateTrackIcon && this.audioTrackLabel?._eyeBtn) {
      this.updateTrackIcon(this.audioTrackLabel._eyeBtn, "audio", this.audioTrackEnabled);
    }
    if (this.updateTrackIcon && this.motionTrackLabel?._eyeBtn) {
      this.updateTrackIcon(this.motionTrackLabel._eyeBtn, "motion", this.motionTrackEnabled);
    }
    if (this.updateTrackIcon && this.mainTrackLabel?._eyeBtn) {
      this.updateTrackIcon(this.mainTrackLabel._eyeBtn, "main", this.mainTrackEnabled !== false);
    }
    const relayout = () => {
      try {
        if (typeof this.forceLayout === "function") this.forceLayout(true);
        else if (this.viewport && this.canvas) {
          const vw = this.viewport.clientWidth || 800;
          const cw = Math.max(vw, vw * (this.zoomLevel || 1));
          this.canvas.style.width = `${cw}px`;
          this.resizeCanvas?.(cw);
        }
        this.render?.();
        this.syncH3NodeHeight?.();
      } catch (e) {
        console.warn("[LazyH3] track relayout:", e);
      }
    };
    requestAnimationFrame(() => requestAnimationFrame(relayout));
  }

  /** H3：分镜/多参各自独立主轨（互不串改） */
  _h3EnsureTrackBanks() {
    if (!this.timeline) this.timeline = { segments: [] };
    if (!this.timeline.h3Tracks || typeof this.timeline.h3Tracks !== "object") {
      this.timeline.h3Tracks = { "分镜": { segments: [] }, "多参": { segments: [] } };
    }
    if (!this.timeline.h3Tracks["分镜"]) this.timeline.h3Tracks["分镜"] = { segments: [] };
    if (!this.timeline.h3Tracks["多参"]) this.timeline.h3Tracks["多参"] = { segments: [] };
    if (!Array.isArray(this.timeline.h3Tracks["分镜"].segments)) {
      this.timeline.h3Tracks["分镜"].segments = [];
    }
    if (!Array.isArray(this.timeline.h3Tracks["多参"].segments)) {
      this.timeline.h3Tracks["多参"].segments = [];
    }
  }

  _h3CloneMainSegments(segs) {
    return (Array.isArray(segs) ? segs : []).map((s) => {
      if (!s || typeof s !== "object") return s;
      const {
        imgObj, videoEl, _isSeeking, thumbnails, _extractingThumbs,
        _sSecs, _lSecs, _tSecs, _dSecs, _uploading, _blobUrl, ...rest
      } = s;
      try {
        return JSON.parse(JSON.stringify(rest));
      } catch (_) {
        return { ...rest };
      }
    });
  }

  _h3SaveMainTrack(mode) {
    if (!this.isH3Director) return;
    this._h3EnsureTrackBanks();
    const m = mode === "多参" ? "多参" : "分镜";
    this.timeline.h3Tracks[m] = {
      segments: this._h3CloneMainSegments(this.timeline.segments),
    };
  }

  _h3LoadMainTrack(mode) {
    if (!this.isH3Director) return;
    this._h3EnsureTrackBanks();
    const m = mode === "多参" ? "多参" : "分镜";
    const bank = this.timeline.h3Tracks[m] || { segments: [] };
    this.timeline.segments = this._h3CloneMainSegments(bank.segments || []);
    // 重挂预览图（与解析加载一致）
    for (const seg of this.timeline.segments) {
      if (!seg) continue;
      if (seg.imageB64 && !seg.imgObj) {
        try {
          seg.imgObj = new Image();
          seg.imgObj.onload = () => {
            if (!this._isDragging) this.render?.();
          };
          seg.imgObj.src = seg.imageB64;
        } catch (_) {}
      }
    }
    this.selectedId = null;
    this.selectedSegment = null;
  }

  _h3MigrateMainTracksIfNeeded() {
    if (!this.isH3Director) return;
    this._h3EnsureTrackBanks();
    const mode = this.h3WorkspaceMode === "多参" ? "多参" : "分镜";
    const bank = this.timeline.h3Tracks[mode];
    const bankEmpty = !bank?.segments?.length;
    const liveHas = Array.isArray(this.timeline.segments) && this.timeline.segments.length > 0;
    // 旧工程只有一份 segments：写入当前工作台，另一台保持空（不反向覆盖正在编辑的主轨）
    if (bankEmpty && liveHas) {
      this.timeline.h3Tracks[mode] = {
        segments: this._h3CloneMainSegments(this.timeline.segments),
      };
    } else if (!bankEmpty && !liveHas) {
      // 分库有数据、现场空：装回当前工作台
      this._h3LoadMainTrack(mode);
    }
  }

  /**
   * H3：分镜 = 单主轨时间线；多参 = 顶部编号参考图 + 主轨/音频/参考视频 三轨时间线
   * 分镜主轨与多参主轨互不干扰。
   */
  setH3WorkspaceMode(mode, silent) {
    if (!this.isH3Director) return;
    const m = mode === "多参" ? "多参" : "分镜";
    const prev = this.h3WorkspaceMode === "多参" ? "多参" : "分镜";

    // 切换前保存当前主轨，再加载目标主轨
    if (prev !== m) {
      this._h3SaveMainTrack(prev);
      this._h3LoadMainTrack(m);
    } else {
      this._h3MigrateMainTracksIfNeeded();
    }

    this.h3WorkspaceMode = m;
    const isRef = m === "多参";

    if (this.h3ModeStoryBtn && this.h3ModeRefBtn) {
      this.h3ModeStoryBtn.classList.toggle("active", !isRef);
      this.h3ModeRefBtn.classList.toggle("active", isRef);
    }

    // 时间线始终显示（分镜/多参 UI 不同；主轨数据已隔离）
    if (this.layoutContainer) this.layoutContainer.style.display = "flex";
    if (this.propContainer) this.propContainer.style.display = "flex";
    if (this.globalPropContainer) this.globalPropContainer.style.display = "flex";

    this.applyH3TrackLayout(isRef);
    this.applyH3ToolbarButtons(isRef);

    if (isRef) {
      this.ensureH3MultiData();
      // 进多参：清旧时间轴音/视频段 + 停播，避免幽灵音与错误时长
      this.clearLegacyMultiTimelineMedia();
      if (!this.manualOutputRange) this.syncDurationToTimelineSegments();
      this.updateManualOutputRangeToggle?.();
    } else {
      if (!this.manualOutputRange) this.syncDurationToTimelineSegments?.();
    }

    const w = this.node.widgets?.find((x) => x.name === "workspace_mode");
    if (w && w.value !== m) {
      w.value = m;
      if (!silent && typeof w.callback === "function") w.callback(m);
    }
    if (this.node.properties) this.node.properties.workspace_mode = m;
    this.node.title = isRef ? "Lazy MinimaxH3 导演台 · 多参" : "Lazy MinimaxH3 导演台 · 分镜";

    this.render?.();
    if (!silent) this.commitChanges?.(true);

    // 多参内容更高：同步节点高度，底部输入框不溢出
    requestAnimationFrame(() => {
      this.syncH3NodeHeight();
      try {
        this.node?.setDirtyCanvas?.(true, true);
      } catch (_) {}
    });
  }

  syncWidgetsAndUI() {
    // 1. Sync the widgets with the loaded track enablement states
    const customAudioWidget = this.node.widgets?.find(w => w.name === "use_custom_audio");
    if (customAudioWidget) {
      customAudioWidget.value = this.audioTrackEnabled;
    }
    const customMotionWidget = this.node.widgets?.find(w => w.name === "use_custom_motion");
    if (customMotionWidget) {
      customMotionWidget.value = this.motionTrackEnabled;
    }

    // 2. Sync the track icon buttons
    if (this.mainTrackLabel?._eyeBtn && this.updateTrackIcon) {
      this.updateTrackIcon(this.mainTrackLabel._eyeBtn, "main", this.mainTrackEnabled);
    }
    if (this.audioTrackLabel?._eyeBtn && this.updateTrackIcon) {
      this.updateTrackIcon(this.audioTrackLabel._eyeBtn, "audio", this.audioTrackEnabled);
    }
    if (this.motionTrackLabel?._eyeBtn && this.updateTrackIcon) {
      this.updateTrackIcon(this.motionTrackLabel._eyeBtn, "motion", this.motionTrackEnabled);
    }

    // 3. Sync the inpaint button disabled/opacity state
    const inpaintToggleBtn = this.audioTrackLabel?.querySelector(".pr-btn");
    if (inpaintToggleBtn) {
      inpaintToggleBtn.disabled = !this.audioTrackEnabled;
      inpaintToggleBtn.style.opacity = this.audioTrackEnabled ? "1.0" : "0.3";
    }

    if (this.updateInpaintToggleStyle) {
      const inpaintWidget = this.node.widgets?.find(w => w.name === "inpaint_audio");
      if (inpaintWidget) {
        this.updateInpaintToggleStyle(inpaintWidget.value);
      }
    }

    // 4. Sync the override audio button disabled/opacity state
    const overrideAudioToggleBtn = this.motionTrackLabel?.querySelector(".pr-btn");
    if (overrideAudioToggleBtn) {
      overrideAudioToggleBtn.disabled = !this.motionTrackEnabled;
      overrideAudioToggleBtn.style.opacity = this.motionTrackEnabled ? "1.0" : "0.3";
    }

    if (this.updateOverrideAudioToggleStyle) {
      const overrideWidget = this.node.widgets?.find(w => w.name === "override_audio");
      if (overrideWidget) {
        this.node.properties.overrideAudio = !!overrideWidget.value;
        this.timeline.overrideAudio = !!overrideWidget.value;
        this.updateOverrideAudioToggleStyle(overrideWidget.value);
      }
    }
  }

  checkResize() {
    this.syncLayoutToNode(false);
    const viewportWidth = this.viewport.clientWidth;
    const currentScale = this.getRenderScale();

    if (viewportWidth > 0 && (this._lastWidth !== viewportWidth || this._lastZoom !== this.zoomLevel || this._lastScale !== currentScale)) {
      this._lastWidth = viewportWidth;
      this._lastZoom = this.zoomLevel;
      this._lastScale = currentScale;

      const newCanvasWidth = Math.max(viewportWidth, viewportWidth * this.zoomLevel);
      this.canvas.style.width = newCanvasWidth + "px";
      this.resizeCanvas(newCanvasWidth);

      if (this.node) this.node.setDirtyCanvas?.(true, true);
      else if (window.app && window.app.graph) window.app.graph.setDirtyCanvas(true, true);
    }
    this._renderLoop = requestAnimationFrame(() => this.checkResize());
  }

  syncLayoutToNode(forceRender = true) {
    const nodeWidth = this.node?.size?.[0] || 1375;
    const targetWidth = Math.max(10, nodeWidth - 30);

    if (this.container) {
      this.container.style.width = `${targetWidth}px`;
      this.container.style.maxWidth = `${targetWidth}px`;
      this.container.style.setProperty("height", "auto", "important");
      this.container.style.boxSizing = "border-box";
    }
    if (this.wrapper) {
      this.wrapper.style.width = "100%";
      this.wrapper.style.maxWidth = "100%";
      this.wrapper.style.setProperty("height", "auto", "important");
      this.wrapper.style.boxSizing = "border-box";
    }
    if (this.viewport) {
      this.viewport.style.boxSizing = "content-box";
      this.viewport.style.height = `${this.canvasHeight}px`;
      this.viewport.style.minHeight = `${this.canvasHeight}px`;
      this.viewport.style.flexShrink = "0";
    }
    if (this.layoutContainer) {
      this.layoutContainer.style.flexShrink = "0";
    }

    const viewportWidth = this.viewport?.clientWidth || targetWidth;
    const canvasWidth = Math.max(viewportWidth, viewportWidth * this.zoomLevel);
    const currentWidth = parseFloat(this.canvas?.style?.width) || 0;
    if (viewportWidth > 0 && Math.abs(currentWidth - canvasWidth) > 1) {
      this.canvas.style.width = `${canvasWidth}px`;
      this.resizeCanvas(canvasWidth);
      this._lastWidth = viewportWidth;
      this._lastZoom = this.zoomLevel;
      if (forceRender) this.render();
    }
  }

  getRenderScale() {
    const dpr = window.devicePixelRatio || 1;
    let graphScale = 1;
    try {
      if (window.app && window.app.canvas && window.app.canvas.ds && window.app.canvas.ds.scale) {
        graphScale = window.app.canvas.ds.scale;
      }
    } catch (e) { }
    // Scale up if zoomed in, but don't drop below 1x DPR if zoomed out
    return dpr * Math.max(1, graphScale);
  }

  resizeCanvas(widthPx) {
    const scale = this.getRenderScale();
    const targetWidth = Math.round(widthPx * scale);
    const targetHeight = Math.round(this.canvasHeight * scale);

    this.canvas.width = targetWidth;
    this.canvas.height = targetHeight;
    this.ctx.setTransform(scale, 0, 0, scale, 0, 0);
    this.render();
  }

  // Helper to map mouse events accurately regardless of canvas scaling
  getMousePos(e) {
    const rect = this.canvas.getBoundingClientRect();

    const scaleX = this.canvas.offsetWidth / rect.width;
    const scaleY = this.canvas.offsetHeight / rect.height;

    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    return { x, y };
  }

  // --- Async Image Upload Logic (Handles multiple images simultaneously) ---
  _guessMediaKind(name) {
    const n = String(name || "").toLowerCase().split("?")[0];
    if (/\.(mp4|webm|mkv|avi|mov|m4v|flv|wmv)$/i.test(n)) return "video";
    if (/\.(mp3|wav|ogg|flac|m4a|aac|wma)$/i.test(n)) return "audio";
    if (/\.(png|jpe?g|webp|gif|bmp|tiff?|avif)$/i.test(n)) return "image";
    return null;
  }

  /** 解析拖入的路径 / view URL / 资产文本为 { imageFile, filename, subfolder, type, kind } */
  _parseDroppedMediaRef(raw) {
    if (!raw || typeof raw !== "string") return null;
    let s = raw.trim();
    if (!s || s.startsWith("#")) return null;

    // file://
    if (s.startsWith("file://")) {
      try {
        s = decodeURIComponent(s.replace(/^file:\/\/\//i, "").replace(/^file:\/\//i, ""));
        // Windows: /C:/path → C:/path
        if (/^\/[a-zA-Z]:/.test(s)) s = s.slice(1);
      } catch (_) { /* keep s */ }
    }

    // /view?filename= 或完整 URL
    if (/^https?:\/\//i.test(s) || s.startsWith("/") || s.includes("filename=") || s.includes("/view")) {
      try {
        let url = null;
        if (/^https?:\/\//i.test(s) || s.startsWith("/")) {
          url = new URL(s, window.location.origin);
        } else if (s.includes("filename=")) {
          url = new URL(s.startsWith("?") ? s : "?" + s, window.location.origin);
        }
        if (url) {
          const filename = url.searchParams.get("filename");
          if (filename) {
            const subfolder = url.searchParams.get("subfolder") || "";
            const type = url.searchParams.get("type") || "input";
            const imageFile = subfolder ? `${subfolder}/${filename}` : filename;
            return {
              imageFile,
              filename,
              subfolder,
              type,
              kind: this._guessMediaKind(filename),
              absolute: false,
              fromViewUrl: true,
            };
          }
        }
      } catch (_) { /* fall through */ }
    }

    // LoadImage 风格：name [input]
    s = s.replace(/\s*\[(input|output|temp)\]\s*$/i, "").trim().replace(/\\/g, "/");
    if (!s) return null;

    const absolute = /^[a-zA-Z]:\//.test(s) || s.startsWith("//");
    const base = s.split("/").pop() || s;
    const kind = this._guessMediaKind(base);
    if (!kind) return null;

    if (absolute) {
      return { imageFile: s, filename: base, subfolder: "", type: "input", kind, absolute: true };
    }
    const parts = s.split("/").filter(Boolean);
    const filename = parts.pop();
    const subfolder = parts.join("/");
    return {
      imageFile: subfolder ? `${subfolder}/${filename}` : filename,
      filename,
      subfolder,
      type: "input",
      kind,
      absolute: false,
    };
  }

  _extractDroppedMediaPaths(dt) {
    if (!dt) return [];
    const refs = [];
    const seen = new Set();
    const add = (raw) => {
      const ref = this._parseDroppedMediaRef(raw);
      if (!ref || !ref.imageFile || !ref.kind) return;
      if (seen.has(ref.imageFile)) return;
      seen.add(ref.imageFile);
      refs.push(ref);
    };

    const tryGet = (mime) => {
      try { return dt.getData(mime) || ""; } catch (_) { return ""; }
    };

    // text/uri-list（Comfy 资产缩略图主通道）
    const uriList = tryGet("text/uri-list");
    if (uriList) {
      for (const line of uriList.split(/\r?\n/)) {
        if (!line || line.startsWith("#")) continue;
        add(line);
      }
    }

    // Firefox 标题行成对
    const moz = tryGet("text/x-moz-url");
    if (moz) {
      const lines = moz.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 2) {
        if (lines[i]) add(lines[i]);
      }
    }

    for (const mime of ["text/plain", "text"]) {
      const plain = tryGet(mime);
      if (!plain) continue;
      for (const line of plain.split(/\r?\n/)) {
        if (line && line.trim()) add(line.trim());
      }
    }

    for (const mime of ["application/json", "application/x-comfy-asset", "comfy/asset"]) {
      const j = tryGet(mime);
      if (!j) continue;
      try {
        const obj = JSON.parse(j);
        const arr = Array.isArray(obj) ? obj : (obj?.assets || obj?.items || [obj]);
        for (const item of arr) {
          if (!item) continue;
          if (typeof item === "string") add(item);
          else if (item.filename) {
            const sub = item.subfolder || "";
            const t = item.type || item.folder_type || "input";
            // 构造成 view 风格，便于带上 type
            const q = `filename=${encodeURIComponent(item.filename)}&subfolder=${encodeURIComponent(sub)}&type=${encodeURIComponent(t)}`;
            add(`/view?${q}`);
          } else if (item.path) add(item.path);
          else if (item.name) add(item.name);
          else if (item.url) add(item.url);
        }
      } catch (_) { /* ignore */ }
    }

    return refs;
  }

  _mediaViewUrl(ref) {
    const filename = ref.filename || (ref.imageFile || "").split("/").pop();
    const subfolder = ref.subfolder != null
      ? ref.subfolder
      : ((ref.imageFile || "").includes("/")
        ? (ref.imageFile || "").split("/").slice(0, -1).join("/")
        : "");
    const type = ref.type || "input";
    return api.apiURL(
      `/view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(type)}&subfolder=${encodeURIComponent(subfolder || "")}`
    );
  }

  async handleMediaPathsDrop(refs, targetFrameStart = null, targetTrack = "image") {
    if (!refs || !refs.length) return;
    let frame = targetFrameStart;
    for (const ref of refs) {
      const kind = ref.kind || this._guessMediaKind(ref.filename || ref.imageFile);
      if (kind === "video") {
        if (targetTrack === "motion") {
          frame = await this._addMotionByPath(ref, frame);
        } else {
          frame = await this._addVideoByPath(ref, frame);
        }
      } else if (kind === "audio") {
        frame = await this._addAudioByPath(ref, frame);
      } else if (kind === "image") {
        // 资产拖入：优先拉真实文件再上传到 input，避免只记路径却生成时读错图
        const ok = await this._importAssetImageAsUpload(ref, frame);
        if (ok != null) {
          frame = ok;
        } else {
          frame = await this._addImageByPath(ref, frame);
        }
      }
    }
  }

  /** 从 /view 拉取资产并走正式上传，保证 imageFile 在 input 下可被 Python 稳定加载 */
  async _importAssetImageAsUpload(ref, targetFrameStart = null) {
    try {
      const imgUrl = this._mediaViewUrl(ref);
      const resp = await fetch(imgUrl);
      if (!resp.ok) {
        console.warn("[WanRemixDirector] 资产拉取失败", resp.status, imgUrl);
        return null;
      }
      const blob = await resp.blob();
      if (!blob || blob.size < 32) return null;
      let name = ref.filename || (ref.imageFile || "asset.png").split("/").pop() || "asset.png";
      // 浏览器合成拖拽有时没有正确扩展名
      if (!/\.(png|jpe?g|webp|gif|bmp|tiff?|avif)$/i.test(name)) {
        const ext = (blob.type || "").includes("jpeg") ? ".jpg"
          : (blob.type || "").includes("webp") ? ".webp"
          : (blob.type || "").includes("gif") ? ".gif"
          : ".png";
        name = name.replace(/\.[^.]+$/, "") + ext;
      }
      const file = new File([blob], name, { type: blob.type || "image/png" });
      const beforeIds = new Set((this.timeline.segments || []).map(s => s.id));
      await this.handleImageUpload([file], targetFrameStart);
      // 回写 media 类型并返回下一段起点
      const added = (this.timeline.segments || []).filter(s => !beforeIds.has(s.id));
      for (const s of added) {
        s.imageMediaType = "input";
      }
      if (added.length) {
        const last = added.sort((a, b) => a.start - b.start).pop();
        return last.start + last.length;
      }
      if (targetFrameStart != null) return targetFrameStart;
      return null;
    } catch (err) {
      console.error("[WanRemixDirector] 资产导入上传失败", err);
      return null;
    }
  }

  async _addImageByPath(ref, targetFrameStart = null, explicitLength = null) {
    const frameRate = this.getFrameRate();
    const newLength = explicitLength !== null ? explicitLength : frameRate * 1;
    const imageFile = ref.imageFile;
    const mediaType = ref.type || "input";
    const imgUrl = this._mediaViewUrl(ref);

    return await new Promise((resolve) => {
      try {
        const img = new Image();
        img.onload = () => {
          let newStart = targetFrameStart;
          if (newStart === null) {
            newStart = 0;
            this.timeline.segments.sort((a, b) => a.start - b.start);
            for (let i = 0; i < this.timeline.segments.length; i++) {
              let seg = this.timeline.segments[i];
              if (newStart + newLength <= seg.start) break;
              newStart = Math.max(newStart, seg.start + seg.length);
            }
          }

          const currentDuration = this.getVisualDurationFrames();
          if (targetFrameStart !== null) {
            let tempId = "TEMP_" + Date.now();
            this.timeline.segments.push({ id: tempId, start: newStart, length: newLength, type: "temp" });
            let physicsCenter = newStart + this.getFrameRate() / 2;
            let result = this._applyCenterDragPhysics(this.timeline.segments, tempId, newStart, physicsCenter, currentDuration, currentDuration, 1);
            let siblingPhysics = (this.timeline.audioSegments || []).map(s => ({ ...s }));
            this._resolveGlobalPhysics(result, siblingPhysics, currentDuration, this.timeline.segments, this.timeline.audioSegments);
            for (let shiftedSeg of result) {
              let original = this.timeline.segments.find(s => s.id === shiftedSeg.id);
              if (original) {
                original.start = shiftedSeg.resolvedStart !== undefined ? shiftedSeg.resolvedStart : shiftedSeg.start;
              }
            }
            for (let shiftedSib of siblingPhysics) {
              let originalSib = this.timeline.audioSegments.find(s => s.id === shiftedSib.id);
              if (originalSib) originalSib.start = shiftedSib.start;
            }
            let tempSeg = this.timeline.segments.find(s => s.id === tempId);
            newStart = tempSeg.start;
            this.timeline.segments = this.timeline.segments.filter(s => s.id !== tempId);
          }

          const seg = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
            start: newStart,
            length: newLength,
            prompt: "",
            type: "image",
            imageFile: imageFile,
            imageMediaType: mediaType,
            imageB64: imgUrl,
            transitionToNext: "flf",
          };

          const displayImg = new Image();
          displayImg.onload = () => {
            seg.imgObj = displayImg;
            this.render();
          };
          displayImg.src = imgUrl;

          this.timeline.segments.push(seg);
          this.timeline.segments.sort((a, b) => a.start - b.start);
          this.selectionType = "image";
          this.selectedIndex = this.timeline.segments.findIndex(s => s.id === seg.id);

          if (!this.retakeMode) {
            this.growTimelineIfNeeded(seg.start + seg.length);
          }

          this.updateUIFromSelection();
          this.commitChanges(true);
          resolve(newStart + newLength);
        };
        img.onerror = () => {
          console.error("[WanRemixDirector] 资产图片加载失败", imageFile, mediaType, imgUrl);
          resolve(targetFrameStart);
        };
        img.src = imgUrl;
      } catch (err) {
        console.error("[WanRemixDirector] 资产图片添加失败", err);
        resolve(targetFrameStart);
      }
    });
  }

  async _addVideoByPath(ref, targetFrameStart = null) {
    const skipAudioPair = this._h3SkipVideoAudioPair();
    const frameRate = this.getFrameRate();
    const imageFile = ref.imageFile;
    const vidUrl = this._mediaViewUrl(ref);
    const fileName = ref.filename || imageFile.split("/").pop();

    return await new Promise((resolve) => {
      try {
        if (this.retakeMode) {
          if (this.timeline.retakeVideo) {
            const oldVid = this.timeline.retakeVideo;
            if (oldVid.videoEl) {
              oldVid.videoEl.pause();
              oldVid.videoEl.src = "";
              oldVid.videoEl.load();
            }
          }
          const vid = document.createElement("video");
          vid.crossOrigin = "Anonymous";
          vid.preload = "auto";
          vid.muted = true;
          vid.onloadeddata = () => {
            vid.onloadeddata = null;
            const clipFrames = Math.max(1, Math.ceil((vid.duration || 1) * frameRate));
            this.timeline.retakeVideo = {
              fileName,
              imageFile,
              videoDurationFrames: clipFrames,
              fileSize: 0,
              videoEl: vid,
              _uploading: false,
            };
            const retakeLen = Math.max(1, Math.round(clipFrames * 0.5));
            this.timeline.retakeStart = Math.round((clipFrames - retakeLen) / 2);
            this.timeline.retakeLength = retakeLen;
            if (this.timeline.retakePrompt === undefined) this.timeline.retakePrompt = "";
            if (this.timeline.retakeStrength === undefined) this.timeline.retakeStrength = 1.0;
            this._ensureThumbnails(this.timeline.retakeVideo);
            this.syncWidgetsToRetakeDuration(clipFrames);
            this.commitChanges(true);
            this.render();
            resolve(targetFrameStart);
          };
          vid.onerror = () => resolve(targetFrameStart);
          vid.src = vidUrl;
          return;
        }

        const vid = document.createElement("video");
        vid.crossOrigin = "Anonymous";
        vid.preload = "auto";
        vid.muted = true;
        vid.onerror = () => {
          console.error("[WanRemixDirector] 资产视频加载失败", imageFile);
          resolve(targetFrameStart);
        };
        vid.onloadeddata = () => {
          vid.onloadeddata = null;
          const clipFrames = Math.max(1, Math.ceil((vid.duration || 1) * frameRate));
          let newLength = clipFrames;
          let newStart = targetFrameStart;

          if (newStart === null) {
            newStart = 0;
            this.timeline.segments.sort((a, b) => a.start - b.start);
            for (let i = 0; i < this.timeline.segments.length; i++) {
              let seg = this.timeline.segments[i];
              if (newStart + newLength <= seg.start) break;
              newStart = Math.max(newStart, seg.start + seg.length);
            }
          }

          const currentDuration = this.getVisualDurationFrames();
          if (targetFrameStart !== null) {
            let tempId = "TEMP_" + Date.now();
            let tempVidId = tempId + "_v";
            let tempAudId = tempId + "_a";
            this.timeline.segments.push({ id: tempVidId, start: newStart, length: newLength, type: "temp" });
            if (!skipAudioPair) {
              this.timeline.audioSegments.push({ id: tempAudId, start: newStart, length: newLength, type: "temp" });
            }
            let physicsCenter = newStart + this.getFrameRate() / 2;
            let resultSegments = this._applyCenterDragPhysics(this.timeline.segments, tempVidId, newStart, physicsCenter, currentDuration, currentDuration, 1);
            if (!skipAudioPair) {
              let resultAudioSegments = this._applyCenterDragPhysics(this.timeline.audioSegments, tempAudId, newStart, physicsCenter, currentDuration, currentDuration, 1);
              this._resolveGlobalPhysics(resultSegments, resultAudioSegments, currentDuration, this.timeline.segments, this.timeline.audioSegments);
              for (let shiftedSib of resultAudioSegments) {
                let originalSib = this.timeline.audioSegments.find(s => s.id === shiftedSib.id);
                if (originalSib) originalSib.start = shiftedSib.resolvedStart !== undefined ? shiftedSib.resolvedStart : shiftedSib.start;
              }
              this.timeline.audioSegments = this.timeline.audioSegments.filter(s => s.id !== tempAudId);
            }
            for (let shiftedSeg of resultSegments) {
              let original = this.timeline.segments.find(s => s.id === shiftedSeg.id);
              if (original) original.start = shiftedSeg.resolvedStart !== undefined ? shiftedSeg.resolvedStart : shiftedSeg.start;
            }
            let tempVidSeg = resultSegments.find(s => s.id === tempVidId);
            newStart = tempVidSeg.start;
            this.timeline.segments = this.timeline.segments.filter(s => s.id !== tempVidId);
          }

          const sharedId = Date.now().toString() + Math.random().toString(36).substr(2, 5);
          const vidSeg = {
            id: sharedId + "_v",
            type: "video",
            start: newStart,
            length: newLength,
            trimStart: 0,
            videoDurationFrames: clipFrames,
            imageFile,
            fileName,
            prompt: "",
            videoEl: vid,
            _uploading: false,
            fileSize: 0,
          };
          const audSeg = {
            id: sharedId + "_a",
            type: "audio",
            start: newStart,
            length: newLength,
            trimStart: 0,
            audioDurationFrames: clipFrames,
            audioFile: imageFile,
            fileName,
            waveformPeaks: [],
            _uploading: false,
            _decoding: true,
            fileSize: 0,
          };

          let finished = false;
          const finishAdd = () => {
            if (finished) return;
            finished = true;
            try {
              const canvas = document.createElement("canvas");
              canvas.width = Math.min(vid.videoWidth || 512, 512);
              canvas.height = Math.round(((vid.videoHeight || 288) / (vid.videoWidth || 512)) * canvas.width) || 288;
              const ctx = canvas.getContext("2d");
              if (vid.videoWidth) ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
              vidSeg.imageB64 = canvas.toDataURL("image/jpeg");
              const imgObj = new Image();
              imgObj.onload = () => { vidSeg.imgObj = imgObj; this.render(); };
              imgObj.src = vidSeg.imageB64;
            } catch (_) { /* ignore thumb errors */ }

            this.timeline.segments.push(vidSeg);
            if (!skipAudioPair) {
              this.timeline.audioSegments.push(audSeg);
              this.timeline.audioSegments.sort((a, b) => a.start - b.start);
            }
            this.timeline.segments.sort((a, b) => a.start - b.start);
            if (!this.retakeMode) {
              this.growTimelineIfNeeded(vidSeg.start + vidSeg.length);
            }
            this.selectionType = "image";
            this.selectedIndex = this.timeline.segments.findIndex(s => s.id === vidSeg.id);
            this.updateUIFromSelection();
            this.commitChanges(true);
            this._ensureThumbnails(vidSeg);

            if (!skipAudioPair) {
            api.fetchApi(`/wan_remix_director_get_audio?filename=${encodeURIComponent(imageFile)}`)
              .then(r => r.json())
              .then(res => {
                if (res.audio_file && res.peaks) {
                  for (let s of this.timeline.audioSegments) {
                    if (s.id === audSeg.id || s.audioFile === imageFile) {
                      s.audioFile = res.audio_file;
                      s.waveformPeaks = res.peaks;
                      s._decoding = false;
                      this._preloadAudioSegment(s);
                    }
                  }
                } else {
                  for (let s of this.timeline.audioSegments) {
                    if (s.id === audSeg.id) s._decoding = false;
                  }
                }
                this.commitChanges(true);
                this.render();
              })
              .catch(() => {
                for (let s of this.timeline.audioSegments) {
                  if (s.id === audSeg.id) s._decoding = false;
                }
              });
            }

            resolve(newStart + newLength);
          };
          vid.onseeked = () => {
            vid.onseeked = null;
            finishAdd();
          };
          try { vid.currentTime = 0.01; } catch (_) { finishAdd(); }
          setTimeout(finishAdd, 600);
        };
        vid.src = vidUrl;
      } catch (err) {
        console.error("[WanRemixDirector] 资产视频添加失败", err);
        resolve(targetFrameStart);
      }
    });
  }

  async _addMotionByPath(ref, targetFrameStart = null) {
    const frameRate = this.getFrameRate();
    const videoFile = ref.imageFile;
    const vidUrl = this._mediaViewUrl(ref);
    const fileName = ref.filename || videoFile.split("/").pop();

    return await new Promise((resolve) => {
      try {
        const vid = document.createElement("video");
        vid.crossOrigin = "Anonymous";
        vid.preload = "auto";
        vid.muted = true;
        vid.onerror = () => resolve(targetFrameStart);
        vid.onloadeddata = () => {
          vid.onloadeddata = null;
          const clipFrames = Math.max(1, Math.ceil((vid.duration || 1) * frameRate));
          let newLength = clipFrames;
          let newStart = targetFrameStart;
          if (newStart === null) {
            newStart = 0;
            this.timeline.motionSegments.sort((a, b) => a.start - b.start);
            for (let i = 0; i < this.timeline.motionSegments.length; i++) {
              let s = this.timeline.motionSegments[i];
              if (newStart + newLength <= s.start) break;
              newStart = Math.max(newStart, s.start + s.length);
            }
          }
          const currentDuration = this.getVisualDurationFrames();
          if (targetFrameStart !== null) {
            let tempId = "TEMP_" + Date.now();
            this.timeline.motionSegments.push({ id: tempId, start: newStart, length: newLength, type: "temp" });
            let result = this._applyCenterDragPhysics(this.timeline.motionSegments, tempId, newStart, newStart + newLength / 2, currentDuration, currentDuration, 1);
            for (let shiftedSeg of result) {
              let original = this.timeline.motionSegments.find(s => s.id === shiftedSeg.id);
              if (original) original.start = shiftedSeg.resolvedStart !== undefined ? shiftedSeg.resolvedStart : shiftedSeg.start;
            }
            let tempSeg = this.timeline.motionSegments.find(s => s.id === tempId);
            newStart = tempSeg.start;
            this.timeline.motionSegments = this.timeline.motionSegments.filter(s => s.id !== tempId);
          }

          const seg = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
            type: "motion_video",
            start: newStart,
            length: newLength,
            trimStart: 0,
            videoDurationFrames: clipFrames,
            videoFile,
            fileName,
            videoStrength: 1.0,
            videoAttentionStrength: 0.65,
            resampleMode: "nearest",
            previewThumbs: [],
            previewThumbSourceFrames: clipFrames,
            videoEl: vid,
            _uploading: false,
            fileSize: 0,
          };

          let finished = false;
          const finishAdd = () => {
            if (finished) return;
            finished = true;
            try {
              const canvas = document.createElement("canvas");
              canvas.width = Math.min(vid.videoWidth || 512, 512);
              canvas.height = Math.round(((vid.videoHeight || 288) / (vid.videoWidth || 512)) * canvas.width) || 288;
              const ctx = canvas.getContext("2d");
              if (vid.videoWidth) ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
              seg.imageB64 = canvas.toDataURL("image/jpeg");
              const imgObj = new Image();
              imgObj.onload = () => { seg.imgObj = imgObj; this.render(); };
              imgObj.src = seg.imageB64;
            } catch (_) { /* ignore */ }

            this.timeline.motionSegments.push(seg);
            this.timeline.motionSegments.sort((a, b) => a.start - b.start);
            if (!this.retakeMode) {
              this.growTimelineIfNeeded(seg.start + seg.length);
            }
            this.selectionType = "motion";
            this.selectedIndex = this.timeline.motionSegments.findIndex(s => s.id === seg.id);
            this.updateUIFromSelection();
            this.commitChanges(true);
            this._ensureThumbnails(seg);
            if (this.getOverrideAudioEnabled()) {
              this._preloadMotionAudioSegment(seg);
            }
            resolve(newStart + newLength);
          };
          vid.onseeked = () => {
            vid.onseeked = null;
            finishAdd();
          };
          try { vid.currentTime = 0.01; } catch (_) { finishAdd(); }
          setTimeout(finishAdd, 600);
        };
        vid.src = vidUrl;
      } catch (err) {
        console.error("[WanRemixDirector] 资产运动视频添加失败", err);
        resolve(targetFrameStart);
      }
    });
  }

  async _addAudioByPath(ref, targetFrameStart = null) {
    const frameRate = this.getFrameRate();
    const audioFile = ref.imageFile;
    const audioUrl = this._mediaViewUrl(ref);

    return await new Promise(async (resolve) => {
      try {
        const resp = await fetch(audioUrl);
        if (!resp.ok) {
          console.error("[WanRemixDirector] 资产音频拉取失败", audioFile);
          resolve(targetFrameStart);
          return;
        }
        const arrayBuffer = await resp.arrayBuffer();
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        const clipFrames = Math.max(1, Math.ceil(audioBuffer.duration * frameRate));
        const channelData = audioBuffer.getChannelData(0);
        const peaks = [];
        const numPeaks = 200;
        const step = Math.max(1, Math.floor(channelData.length / numPeaks));
        for (let i = 0; i < numPeaks; i++) {
          let max = 0;
          for (let j = 0; j < step; j++) {
            const val = Math.abs(channelData[i * step + j] || 0);
            if (val > max) max = val;
          }
          peaks.push(max);
        }

        let newLength = clipFrames;
        let newStart = targetFrameStart;
        if (newStart === null) {
          newStart = 0;
          this.timeline.audioSegments.sort((a, b) => a.start - b.start);
          for (let i = 0; i < this.timeline.audioSegments.length; i++) {
            let seg = this.timeline.audioSegments[i];
            if (newStart + newLength <= seg.start) break;
            newStart = Math.max(newStart, seg.start + seg.length);
          }
        }

        // 与 handleAudioUpload 一致：有落点时做物理推挤
        const currentDuration = this.getVisualDurationFrames();
        if (targetFrameStart !== null) {
          let tempId = "TEMP_" + Date.now();
          this.timeline.audioSegments.push({ id: tempId, start: newStart, length: newLength, type: "temp" });
          let result = this._applyCenterDragPhysics(this.timeline.audioSegments, tempId, newStart, newStart + newLength / 2, currentDuration, currentDuration, 1);
          let siblingPhysics = (this.timeline.segments || []).map(s => ({ ...s }));
          this._resolveGlobalPhysics(siblingPhysics, result, currentDuration, this.timeline.segments, this.timeline.audioSegments);
          for (let shiftedSeg of result) {
            let original = this.timeline.audioSegments.find(s => s.id === shiftedSeg.id);
            if (original) original.start = shiftedSeg.resolvedStart !== undefined ? shiftedSeg.resolvedStart : shiftedSeg.start;
          }
          for (let shiftedSib of siblingPhysics) {
            let originalSib = this.timeline.segments.find(s => s.id === shiftedSib.id);
            if (originalSib) originalSib.start = shiftedSib.start;
          }
          let tempSeg = this.timeline.audioSegments.find(s => s.id === tempId);
          newStart = tempSeg ? tempSeg.start : newStart;
          this.timeline.audioSegments = this.timeline.audioSegments.filter(s => s.id !== tempId);
        }

        const seg = {
          id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
          type: "audio",
          start: newStart,
          length: newLength,
          trimStart: 0,
          audioDurationFrames: clipFrames,
          audioFile,
          fileName: ref.filename || audioFile.split("/").pop(),
          waveformPeaks: peaks,
          _uploading: false,
          _decoding: false,
        };
        this.timeline.audioSegments.push(seg);
        this.timeline.audioSegments.sort((a, b) => a.start - b.start);
        if (!this.retakeMode) {
          this.growTimelineIfNeeded(seg.start + seg.length);
        }
        this.selectionType = "audio";
        this.selectedIndex = this.timeline.audioSegments.findIndex(s => s.id === seg.id);
        this._preloadAudioSegment(seg);
        this.updateUIFromSelection();
        this.commitChanges(true);
        this.render();
        resolve(newStart + newLength);
      } catch (err) {
        console.error("[WanRemixDirector] 资产音频添加失败", err);
        resolve(targetFrameStart);
      }
    });
  }

  async handleImageUpload(files, targetFrameStart = null, explicitLength = null) {
    const frameRate = this.getFrameRate();
    const durationFrames = this.getDurationFrames();
    const newLength = explicitLength !== null ? explicitLength : frameRate * 1; // Default to 1 second long

    for (let file of files) {
      if (!file.type.startsWith("image/") && !/\.(png|jpe?g|webp|gif|bmp|tiff?|avif)$/i.test(file.name || "")) continue;

      await new Promise(async (resolve) => {
        try {
          const body = new FormData();
          body.append("image", file);
          body.append("subfolder", "whatdreamscost");
          const resp = await api.fetchApi("/upload/image", { method: "POST", body });
          if (resp.status !== 200) { resolve(); return; }

          const data = await resp.json();
          const filename = data.name;
          const subfolder = data.subfolder || "";
          const imageFile = subfolder ? subfolder + "/" + filename : filename;
          const imgUrl = api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);

          const img = new Image();
          img.onload = () => {

            let newStart = targetFrameStart;
            if (newStart === null) {
              // Fallback: find the first free slot, or append past the end
              newStart = 0;
              this.timeline.segments.sort((a, b) => a.start - b.start);
              for (let i = 0; i < this.timeline.segments.length; i++) {
                let seg = this.timeline.segments[i];
                if (newStart + newLength <= seg.start) break;
                newStart = Math.max(newStart, seg.start + seg.length);
              }
            }

            // Use the visual timeline as the physics bound so segments can
            // land anywhere in the padded visual area without touching duration_frames.
            const currentDuration = this.getVisualDurationFrames();

            if (targetFrameStart !== null) {
              // Resolve physics to push existing segments
              let tempId = "TEMP_" + Date.now();
              this.timeline.segments.push({ id: tempId, start: newStart, length: newLength, type: "temp" });
              let physicsCenter = newStart + this.getFrameRate() / 2;
              let result = this._applyCenterDragPhysics(this.timeline.segments, tempId, newStart, physicsCenter, currentDuration, currentDuration, 1);

              let siblingPhysics = (this.timeline.audioSegments || []).map(s => ({ ...s }));

              this._resolveGlobalPhysics(result, siblingPhysics, currentDuration, this.timeline.segments, this.timeline.audioSegments);

              // Update original segments with resolved physics to preserve imgObj
              for (let shiftedSeg of result) {
                let original = this.timeline.segments.find(s => s.id === shiftedSeg.id);
                if (original) {
                  original.start = shiftedSeg.resolvedStart !== undefined ? shiftedSeg.resolvedStart : shiftedSeg.start;
                }
              }

              for (let shiftedSib of siblingPhysics) {
                let originalSib = this.timeline.audioSegments.find(s => s.id === shiftedSib.id);
                if (originalSib) {
                  originalSib.start = shiftedSib.start;
                }
              }

              let tempSeg = this.timeline.segments.find(s => s.id === tempId);
              newStart = tempSeg.start;
              this.timeline.segments = this.timeline.segments.filter(s => s.id !== tempId);
              targetFrameStart = newStart + newLength; // For the next file in batch
            }

            // Use the full intended length — the timeline has already been grown to fit.
            let constrainedLength = newLength;

            const seg = {
              id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
              start: newStart,
              length: constrainedLength,
              prompt: "",
              type: "image",
              imageFile: imageFile,
              imageB64: imgUrl,
              // 与下一张衔接：flf=⇄首尾帧  cut=✕硬切（可在时间线点按切换）
              transitionToNext: "flf",
            };

            const displayImg = new Image();
            displayImg.onload = () => {
              seg.imgObj = displayImg;
              this.render();
              resolve(); // Resolve promise letting next image process
            };
            displayImg.src = imgUrl;

            this.timeline.segments.push(seg);
            this.timeline.segments.sort((a, b) => a.start - b.start);
            this.selectionType = "image";
            this.selectedIndex = this.timeline.segments.findIndex(s => s.id === seg.id);

            if (!this.retakeMode) {
              this.growTimelineIfNeeded(seg.start + seg.length);
            }

            this.updateUIFromSelection();
            this.commitChanges(true);
          };
          img.src = imgUrl;
        } catch (err) {
          console.error("[PromptRelay] Image upload failed", err);
          resolve();
        }
      });
    }
    this.fileInput.value = "";
  }

  // Shared chunked upload helper for all video types in the LTX Director.
  // Files <= 50 MB go through ComfyUI's standard /upload/image endpoint;
  // larger files are split into 50 MB chunks and sent to the LTX Director's
  // own /wan_remix_director_upload_chunk endpoint to bypass the 413 size limit.
  async _uploadVideoFile(file) {
    const CHUNK_SIZE = 50 * 1024 * 1024; // 50 MB
    const safeFileName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');

    // First check if the file already exists on the server to de-duplicate
    try {
      const checkResp = await api.fetchApi(`/wan_remix_director_check_file?filename=${encodeURIComponent(safeFileName)}&size=${file.size}`);
      if (checkResp.status === 200) {
        const checkResult = await checkResp.json();
        if (checkResult.exists) {
          console.log(`[WanRemixDirector] File already exists: ${checkResult.name}. Reusing existing file.`);
          return checkResult.name;
        }
      }
    } catch (e) {
      console.warn("[WanRemixDirector] Failed to check for existing file, proceeding with upload", e);
    }

    if (file.size > CHUNK_SIZE) {
      // --- Chunked path ---
      const safeName = Date.now() + "_" + safeFileName;
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      for (let i = 0; i < totalChunks; i++) {
        const chunk = file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        const formData = new FormData();
        formData.append("file", chunk);
        formData.append("filename", safeName);
        formData.append("chunk_index", i);
        formData.append("total_chunks", totalChunks);
        const resp = await api.fetchApi("/wan_remix_director_upload_chunk", { method: "POST", body: formData });
        if (resp.status !== 200) throw new Error("LTX Director video chunk upload failed");
      }
      return safeName; // filename (no subfolder) in the input dir
    } else {
      // --- Single-shot path (small file) ---
      const body = new FormData();
      body.append("image", file);
      body.append("subfolder", "whatdreamscost");
      const resp = await api.fetchApi("/upload/image", { method: "POST", body });
      if (resp.status !== 200) throw new Error(`LTX Director video upload failed: ${resp.statusText}`);
      const data = await resp.json();
      const subfolder = data.subfolder || "";
      return subfolder ? subfolder + "/" + data.name : data.name;
    }
  }

  async handleVideoUpload(files, targetFrameStart = null) {
    const frameRate = this.getFrameRate();

    if (this.retakeMode) {
      const file = files[0];
      if (!file || !file.type.startsWith("video/")) return;

      // Clean up previous retake video if one exists
      if (this.timeline.retakeVideo) {
        const oldVid = this.timeline.retakeVideo;
        if (oldVid.videoEl) {
          oldVid.videoEl.pause();
          oldVid.videoEl.src = "";
          oldVid.videoEl.load();
        }
        if (oldVid._blobUrl) {
          URL.revokeObjectURL(oldVid._blobUrl);
        }
      }

      const blobUrl = URL.createObjectURL(file);
      const vid = document.createElement('video');
      vid.crossOrigin = "Anonymous";
      vid.preload = 'auto';
      vid.muted = true;

      await new Promise((resolve) => {
        vid.onloadeddata = async () => {
          vid.onloadeddata = null;
          const clipDurationSecs = vid.duration || 1;
          const clipFrames = Math.max(1, Math.ceil(clipDurationSecs * frameRate));

          this.timeline.retakeVideo = {
            fileName: file.name,
            imageFile: "",
            videoDurationFrames: clipFrames,
            _blobUrl: blobUrl,
            fileSize: file.size,
            videoEl: vid,
            _uploading: true
          };

          // Initialize retake region to the middle 50% of the clip (25%–75%)
          const retakeLen = Math.max(1, Math.round(clipFrames * 0.5));
          const retakeStartFrame = Math.round((clipFrames - retakeLen) / 2);
          this.timeline.retakeStart = retakeStartFrame;
          this.timeline.retakeLength = retakeLen;
          if (this.timeline.retakePrompt === undefined) this.timeline.retakePrompt = "";
          if (this.timeline.retakeStrength === undefined) this.timeline.retakeStrength = 1.0;

          // Start background upload
          this._uploadVideoFile(file).then(filePath => {
            if (this.timeline.retakeVideo) {
              this.timeline.retakeVideo.imageFile = filePath;
              this.timeline.retakeVideo._uploading = false;
            }
            this.commitChanges(true);
            this.render();
          }).catch(e => {
            console.error(e);
            if (this.timeline.retakeVideo) {
              this.timeline.retakeVideo._uploading = false;
            }
            this.commitChanges(true);
            this.render();
          });

          this._ensureThumbnails(this.timeline.retakeVideo);

          this.syncWidgetsToRetakeDuration(clipFrames);
          this.commitChanges(true);
          this.render();
          resolve();
        };
        vid.src = blobUrl;
      });
      return;
    }

    const skipAudioPair = this._h3SkipVideoAudioPair();
    for (let file of files) {
      if (!file.type.startsWith("video/")) continue;

      await new Promise(async (resolve) => {
        try {
          // Use a local blob URL so the video element loads instantly from disk —
          // no waiting for the server upload before the segment appears.
          const blobUrl = URL.createObjectURL(file);

          const vid = document.createElement('video');
          vid.crossOrigin = "Anonymous";
          vid.preload = 'auto';
          vid.muted = true;

          vid.onloadeddata = async () => {
            vid.onloadeddata = null; // prevent re-firing if src changes or browser buffers more data
            const clipDurationSecs = vid.duration || 1;
            const clipFrames = Math.max(1, Math.ceil(clipDurationSecs * frameRate));
            let newLength = clipFrames;
            let newStart = targetFrameStart;

            if (newStart === null) {
              newStart = 0;
              this.timeline.segments.sort((a, b) => a.start - b.start);
              for (let i = 0; i < this.timeline.segments.length; i++) {
                let seg = this.timeline.segments[i];
                if (newStart + newLength <= seg.start) break;
                newStart = Math.max(newStart, seg.start + seg.length);
              }
            }

            const currentDuration = this.getVisualDurationFrames();

            if (targetFrameStart !== null) {
              let tempId = "TEMP_" + Date.now();
              let tempVidId = tempId + "_v";
              let tempAudId = tempId + "_a";

              this.timeline.segments.push({ id: tempVidId, start: newStart, length: newLength, type: "temp" });
              if (!skipAudioPair) {
                this.timeline.audioSegments.push({ id: tempAudId, start: newStart, length: newLength, type: "temp" });
              }

              let physicsCenter = newStart + this.getFrameRate() / 2;

              let resultSegments = this._applyCenterDragPhysics(this.timeline.segments, tempVidId, newStart, physicsCenter, currentDuration, currentDuration, 1);
              if (!skipAudioPair) {
                let resultAudioSegments = this._applyCenterDragPhysics(this.timeline.audioSegments, tempAudId, newStart, physicsCenter, currentDuration, currentDuration, 1);
                this._resolveGlobalPhysics(resultSegments, resultAudioSegments, currentDuration, this.timeline.segments, this.timeline.audioSegments);
                for (let shiftedSib of resultAudioSegments) {
                  let originalSib = this.timeline.audioSegments.find(s => s.id === shiftedSib.id);
                  if (originalSib) originalSib.start = shiftedSib.resolvedStart !== undefined ? shiftedSib.resolvedStart : shiftedSib.start;
                }
                this.timeline.audioSegments = this.timeline.audioSegments.filter(s => s.id !== tempAudId);
              }

              for (let shiftedSeg of resultSegments) {
                let original = this.timeline.segments.find(s => s.id === shiftedSeg.id);
                if (original) original.start = shiftedSeg.resolvedStart !== undefined ? shiftedSeg.resolvedStart : shiftedSeg.start;
              }

              let tempVidSeg = resultSegments.find(s => s.id === tempVidId);
              newStart = tempVidSeg.start;
              this.timeline.segments = this.timeline.segments.filter(s => s.id !== tempVidId);
              targetFrameStart = newStart + newLength;
            }

            const sharedId = Date.now().toString() + Math.random().toString(36).substr(2, 5);

            const vidSeg = {
              id: sharedId + "_v",
              type: "video",
              start: newStart,
              length: newLength,
              trimStart: 0,
              videoDurationFrames: clipFrames,
              imageFile: "",  // filled in once background upload completes
              fileName: file.name,
              prompt: "",
              videoEl: vid,
              _uploading: true,
              _blobUrl: blobUrl,
              fileSize: file.size
            };

            const audSeg = {
              id: sharedId + "_a",
              type: "audio",
              start: newStart,
              length: newLength,
              trimStart: 0,
              audioDurationFrames: clipFrames,
              audioFile: "",  // filled in once background upload completes
              fileName: file.name,
              waveformPeaks: [],
              _uploading: true,
              _decoding: true,
              _blobUrl: blobUrl,
              fileSize: file.size
            };

            // Extract first-frame thumbnail from local blob — instant
            vid.currentTime = 0.01;
            vid.onseeked = () => {
              vid.onseeked = null;
              const canvas = document.createElement('canvas');
              canvas.width = Math.min(vid.videoWidth, 512);
              canvas.height = Math.round((vid.videoHeight / vid.videoWidth) * canvas.width);
              const ctx = canvas.getContext('2d');
              ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
              vidSeg.imageB64 = canvas.toDataURL('image/jpeg');

              const imgObj = new Image();
              imgObj.onload = () => { vidSeg.imgObj = imgObj; this.render(); };
              imgObj.src = vidSeg.imageB64;

              // Add to timeline immediately
              this.timeline.segments.push(vidSeg);
              if (!skipAudioPair) {
                this.timeline.audioSegments.push(audSeg);
                this.timeline.audioSegments.sort((a, b) => a.start - b.start);
              }
              this.timeline.segments.sort((a, b) => a.start - b.start);

              if (!this.retakeMode) {
                this.growTimelineIfNeeded(vidSeg.start + vidSeg.length);
              }

              this.selectionType = "image";
              this.selectedIndex = this.timeline.segments.findIndex(s => s.id === vidSeg.id);
              this.updateUIFromSelection();
              this.commitChanges(true);
              resolve(); // resolve immediately — don't block on upload
              this._ensureThumbnails(vidSeg);

              // Background audio extraction (waveform peaks) — runs while user can already work
              const IS_LARGE_FILE = file.size > 100 * 1024 * 1024;
              if (!skipAudioPair) {
                if (IS_LARGE_FILE) {
                  console.log(`[WanRemixDirector] Large file detected (${(file.size / 1024 / 1024).toFixed(1)} MB). Offloading audio extraction to server.`);
                } else {
                  this._extractAudioOnClient(file, audSeg.id, blobUrl);
                }
              }

              // Background upload — runs while the user can already work.
              // We intentionally do NOT change vid.src after upload — the blob URL
              // works perfectly for local playback. Only imageFile/audioFile
              // need updating so Python can find the file at generation time.
              this._uploadVideoFile(file).then(filePath => {
                for (let s of this.timeline.segments) {
                  if (s._blobUrl === blobUrl || s.id === vidSeg.id) {
                    s.imageFile = filePath;
                    s._uploading = false;
                  }
                }
                if (!skipAudioPair) {
                  for (let s of this.timeline.audioSegments) {
                    if (s._blobUrl === blobUrl || s.id === audSeg.id) {
                      s.audioFile = filePath;
                      s._uploading = false;
                    }
                  }
                }
                if (blobUrl && filePath) {
                  this._thumbnailCache = this._thumbnailCache || new Map();
                  this._thumbnailPromises = this._thumbnailPromises || new Map();
                  if (this._thumbnailCache.has(blobUrl)) {
                    this._thumbnailCache.set(filePath, this._thumbnailCache.get(blobUrl));
                  }
                  if (this._thumbnailPromises.has(blobUrl)) {
                    this._thumbnailPromises.set(filePath, this._thumbnailPromises.get(blobUrl));
                  }
                }

                // Query server for extracted WAV audio file and waveform peaks
                if (filePath && !skipAudioPair) {
                  api.fetchApi(`/wan_remix_director_get_audio?filename=${encodeURIComponent(filePath)}`)
                    .then(r => r.json())
                    .then(res => {
                      if (res.audio_file && res.peaks) {
                        for (let s of this.timeline.audioSegments) {
                          if (s.audioFile === filePath || s._blobUrl === blobUrl) {
                            s.audioFile = res.audio_file;
                            s.waveformPeaks = res.peaks;
                            s._decoding = false;
                            this._preloadAudioSegment(s);
                          }
                        }
                      } else {
                        // Fallback
                        if (IS_LARGE_FILE) {
                          console.warn("[WanRemixDirector] Server audio extraction failed for large file, skipping.");
                          for (let s of this.timeline.audioSegments) {
                            if (s.audioFile === filePath || s._blobUrl === blobUrl) {
                              s._decoding = false;
                            }
                          }
                        } else {
                          this._extractAudioOnClient(file, audSeg.id, blobUrl);
                        }
                      }
                      this.commitChanges(true);
                      this.render();
                    })
                    .catch(err => {
                      console.error("[WanRemixDirector] Server audio extraction query failed:", err);
                      for (let s of this.timeline.audioSegments) {
                        if (s.audioFile === filePath || s._blobUrl === blobUrl) {
                          s._decoding = false;
                        }
                      }
                      this.render();
                    });
                } else {
                  this.commitChanges(true);
                  this.render();
                }
              }).catch(err => {
                console.error("[WanRemixDirector] Background video upload failed", err);
                const currentVidSeg = this.timeline.segments.find(s => s.id === vidSeg.id);
                if (currentVidSeg) currentVidSeg._uploading = false;
                const currentAudSeg = this.timeline.audioSegments.find(s => s.id === audSeg.id);
                if (currentAudSeg) currentAudSeg._uploading = false;
                this.render();
              });
            };
          };

          vid.onerror = (e) => {
            console.error("Video load error", e);
            URL.revokeObjectURL(blobUrl);
            resolve();
          };

          vid.src = blobUrl;

        } catch (err) {
          console.error("Video upload failed", err);
          resolve();
        }
      });
    }

    if (this.videoFileInput) {
      this.videoFileInput.value = "";
    }
  }

  async generateVideoPreviewThumbs(file, count = 18) {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.src = url;
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("preview metadata failed"));
    });
    const duration = Math.max(0.001, video.duration || 0.001);
    const canvas = document.createElement("canvas");
    const maxW = 160, maxH = 90;
    const scale = Math.min(maxW / Math.max(1, video.videoWidth || maxW), maxH / Math.max(1, video.videoHeight || maxH));
    canvas.width = Math.max(1, Math.round((video.videoWidth || maxW) * scale));
    canvas.height = Math.max(1, Math.round((video.videoHeight || maxH) * scale));
    const ctx = canvas.getContext("2d");
    const thumbs = [];
    const seekTo = (t) => new Promise((resolve) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        try {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          thumbs.push(canvas.toDataURL("image/jpeg", 0.78));
        } catch (_) { }
        resolve();
      };
      video.onseeked = done;
      video.currentTime = Math.min(duration - 0.001, Math.max(0, t));
      setTimeout(done, 700);
    });
    for (let i = 0; i < count; i++) {
      const t = (duration * (i + 0.5)) / count;
      await seekTo(t);
    }
    URL.revokeObjectURL(url);
    return thumbs.filter(Boolean);
  }

  // --- Async Motion Video Upload Logic ---
  async handleMotionUpload(files, targetFrameStart = null) {
    const frameRate = this.getFrameRate();

    for (let file of files) {
      if (!(file.type.startsWith("video/") || file.name.toLowerCase().match(/\.(mp4|webm|mkv|avi|mov|m4v|flv|wmv)$/))) continue;

      await new Promise(async (resolve) => {
        try {
          // Load from local blob immediately — no waiting for server upload
          const blobUrl = URL.createObjectURL(file);

          const vid = document.createElement('video');
          vid.crossOrigin = "Anonymous";
          vid.preload = 'auto';
          vid.muted = true;
          vid.onerror = (e) => { console.error("Motion video load error", e); URL.revokeObjectURL(blobUrl); resolve(); };

          vid.onloadeddata = () => {
            vid.onloadeddata = null; // prevent re-firing if src changes or browser buffers more data
            const clipDurationSecs = vid.duration || 1;
            const clipFrames = Math.max(1, Math.ceil(clipDurationSecs * frameRate));
            let newLength = clipFrames;
            let newStart = targetFrameStart;

            if (newStart === null) {
              newStart = 0;
              this.timeline.motionSegments.sort((a, b) => a.start - b.start);
              for (let i = 0; i < this.timeline.motionSegments.length; i++) {
                let s = this.timeline.motionSegments[i];
                if (newStart + newLength <= s.start) break;
                newStart = Math.max(newStart, s.start + s.length);
              }
            }

            const currentDuration = this.getVisualDurationFrames();
            if (targetFrameStart !== null) {
              let tempId = "TEMP_" + Date.now();
              this.timeline.motionSegments.push({ id: tempId, start: newStart, length: newLength, type: "temp" });
              let result = this._applyCenterDragPhysics(this.timeline.motionSegments, tempId, newStart, newStart + newLength / 2, currentDuration, currentDuration, 1);
              for (let shiftedSeg of result) {
                let original = this.timeline.motionSegments.find(s => s.id === shiftedSeg.id);
                if (original) original.start = shiftedSeg.resolvedStart !== undefined ? shiftedSeg.resolvedStart : shiftedSeg.start;
              }
              let tempSeg = this.timeline.motionSegments.find(s => s.id === tempId);
              newStart = tempSeg.start;
              this.timeline.motionSegments = this.timeline.motionSegments.filter(s => s.id !== tempId);
              targetFrameStart = newStart + newLength;
            }

            const seg = {
              id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
              type: "motion_video",
              start: newStart,
              length: newLength,
              trimStart: 0,
              videoDurationFrames: clipFrames,
              videoFile: "",  // filled in once background upload completes
              fileName: file.name,
              videoStrength: 1.0,
              videoAttentionStrength: 0.65,
              resampleMode: "nearest",
              previewThumbs: [],
              previewThumbSourceFrames: clipFrames,
              videoEl: vid,
              _uploading: true,
              _blobUrl: blobUrl,
              fileSize: file.size
            };

            vid.currentTime = 0.01;
            vid.onseeked = () => {
              vid.onseeked = null;
              const canvas = document.createElement('canvas');
              canvas.width = Math.min(vid.videoWidth, 512);
              canvas.height = Math.round((vid.videoHeight / vid.videoWidth) * canvas.width);
              const ctx = canvas.getContext('2d');
              ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
              seg.imageB64 = canvas.toDataURL('image/jpeg');

              const imgObj = new Image();
              imgObj.onload = () => { seg.imgObj = imgObj; this.render(); };
              imgObj.src = seg.imageB64;

              // Add to timeline immediately
              this.timeline.motionSegments.push(seg);
              this.timeline.motionSegments.sort((a, b) => a.start - b.start);

              if (!this.retakeMode) {
                this.growTimelineIfNeeded(seg.start + seg.length);
              }

              this.selectionType = "motion";
              this.selectedIndex = this.timeline.motionSegments.findIndex(s => s.id === seg.id);
              this.updateUIFromSelection();
              this.commitChanges(true);
              resolve(); // resolve immediately — don't block on upload
              this._ensureThumbnails(seg);

              // Background upload — runs while the user can already work.
              // We intentionally do NOT change vid.src after upload — the blob URL
              // works perfectly for local playback. Only videoFile needs updating
              // so Python can find the file at generation time.
              this._uploadVideoFile(file).then(filePath => {
                for (let s of this.timeline.motionSegments) {
                  if (s._blobUrl === blobUrl || s.id === seg.id) {
                    s.videoFile = filePath;
                    s._uploading = false;
                  }
                }
                if (blobUrl && filePath) {
                  this._thumbnailCache = this._thumbnailCache || new Map();
                  this._thumbnailPromises = this._thumbnailPromises || new Map();
                  if (this._thumbnailCache.has(blobUrl)) {
                    this._thumbnailCache.set(filePath, this._thumbnailCache.get(blobUrl));
                  }
                  if (this._thumbnailPromises.has(blobUrl)) {
                    this._thumbnailPromises.set(filePath, this._thumbnailPromises.get(blobUrl));
                  }
                }
                const isOverrideAudio = this.getOverrideAudioEnabled();
                if (isOverrideAudio) {
                  const s = this.timeline.motionSegments.find(s => s.id === seg.id);
                  if (s) {
                    this._preloadMotionAudioSegment(s);
                  }
                }
                this.commitChanges(true);
                this.render();
              }).catch(err => {
                console.error("[WanRemixDirector] Background motion video upload failed", err);
                const currentSeg = this.timeline.motionSegments.find(s => s.id === seg.id);
                if (currentSeg) currentSeg._uploading = false;
                this.render();
              });
            };
          };

          vid.src = blobUrl;

        } catch (err) {
          console.error("[WanRemixDirector] Motion video processing failed", err);
          resolve();
        }
      });
    }
  }


  // --- Async Audio Upload Logic ---
  async handleAudioUpload(files, targetFrameStart = null) {
    const frameRate = this.getFrameRate();
    const durationFrames = this.getDurationFrames();

    for (let file of files) {
      if (!file.type.startsWith("audio/")) continue;

      await new Promise(async (resolve) => {
        try {
          const body = new FormData();
          body.append("image", file);
          body.append("subfolder", "whatdreamscost");
          const resp = await api.fetchApi("/upload/image", { method: "POST", body });
          if (resp.status !== 200) { resolve(); return; }

          const data = await resp.json();
          const filename = data.name;
          const subfolder = data.subfolder || "";
          const audioFile = subfolder ? subfolder + "/" + filename : filename;

          const arrayBuffer = await file.arrayBuffer();
          const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
          const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
          const clipDurationSecs = audioBuffer.duration;
          const clipFrames = Math.max(1, Math.ceil(clipDurationSecs * frameRate));

          const channelData = audioBuffer.getChannelData(0);
          const peaks = [];
          const numPeaks = 200;
          const step = Math.floor(channelData.length / numPeaks);
          for (let i = 0; i < numPeaks; i++) {
            let max = 0;
            for (let j = 0; j < step; j++) {
              const val = Math.abs(channelData[i * step + j]);
              if (val > max) max = val;
            }
            peaks.push(max);
          }

          let newLength = clipFrames;
          let newStart = targetFrameStart;

          if (newStart === null) {
            // Find the first free slot, or place past the end of all existing audio
            newStart = 0;
            this.timeline.audioSegments.sort((a, b) => a.start - b.start);
            for (let i = 0; i < this.timeline.audioSegments.length; i++) {
              let seg = this.timeline.audioSegments[i];
              if (newStart + newLength <= seg.start) break;
              newStart = Math.max(newStart, seg.start + seg.length);
            }
          }

          // Use the visual timeline as the physics bound so segments can
          // land anywhere in the padded visual area without touching duration_frames.
          const currentDuration = this.getVisualDurationFrames();

          if (targetFrameStart !== null) {
            let tempId = "TEMP_" + Date.now();
            this.timeline.audioSegments.push({ id: tempId, start: newStart, length: newLength, type: "temp" });
            let physicsCenter = newStart + this.getFrameRate() / 2;
            let result = this._applyCenterDragPhysics(this.timeline.audioSegments, tempId, newStart, physicsCenter, currentDuration, currentDuration, 1);

            let siblingPhysics = (this.timeline.segments || []).map(s => ({ ...s }));

            this._resolveGlobalPhysics(siblingPhysics, result, currentDuration, this.timeline.segments, this.timeline.audioSegments);

            for (let shiftedSeg of result) {
              let original = this.timeline.audioSegments.find(s => s.id === shiftedSeg.id);
              if (original) original.start = shiftedSeg.resolvedStart !== undefined ? shiftedSeg.resolvedStart : shiftedSeg.start;
            }

            for (let shiftedSib of siblingPhysics) {
              let originalSib = this.timeline.segments.find(s => s.id === shiftedSib.id);
              if (originalSib) {
                originalSib.start = shiftedSib.start;
              }
            }

            let tempSeg = this.timeline.audioSegments.find(s => s.id === tempId);
            newStart = tempSeg.start;
            this.timeline.audioSegments = this.timeline.audioSegments.filter(s => s.id !== tempId);
            targetFrameStart = newStart + newLength;
          }

          // Use the full clip length — timeline has already grown to fit.
          let constrainedLength = newLength;

          const seg = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
            type: "audio",
            start: newStart,
            length: constrainedLength,
            trimStart: 0,
            audioDurationFrames: clipFrames,
            audioFile: audioFile,
            fileName: file.name,
            waveformPeaks: peaks,
            _audioBuffer: audioBuffer
          };

          this.timeline.audioSegments.push(seg);
          this.timeline.audioSegments.sort((a, b) => a.start - b.start);

          if (!this.retakeMode) {
            this.growTimelineIfNeeded(seg.start + seg.length);
          }

          this.selectionType = "audio";
          this.selectedIndex = this.timeline.audioSegments.findIndex(s => s.id === seg.id);

          this.updateUIFromSelection();
          this.commitChanges(true);
          this.render();
          resolve();
        } catch (err) {
          console.error("[PromptRelay] Audio processing failed", err);
          resolve();
        }
      });
    }
    this.audioFileInput.value = "";
  }

  markSegment(seg) {
    if (!seg) return;
    const newStart = Math.round(seg.start);
    const newEnd = Math.max(newStart + 1, Math.round(seg.start + seg.length));

    const currentStart = this.getStartFrames();
    const currentEnd = this.endFramesWidget ? parseInt(this.endFramesWidget.value, 10) : (currentStart + this.getDurationFrames());

    let targetStart = newStart;
    let targetEnd = newEnd;

    if (currentStart === newStart && currentEnd === newEnd) {
      const allSegs = [
        ...(this.timeline.segments || []),
        ...(this.timeline.motionSegments || []),
        ...(this.timeline.audioSegments || [])
      ];
      let lastSegmentEnd = 0;
      for (const s of allSegs) {
        if (s.start + s.length > lastSegmentEnd) {
          lastSegmentEnd = s.start + s.length;
        }
      }
      if (lastSegmentEnd <= 0) {
        lastSegmentEnd = this.getDurationFrames();
      }
      targetStart = 0;
      targetEnd = Math.max(1, Math.round(lastSegmentEnd));
    }

    if (this.startFramesWidget && this.endFramesWidget) {
      this.startFramesWidget.value = targetStart;
      this.endFramesWidget.value = targetEnd;
      if (this.startFramesWidget.callback) {
        this.startFramesWidget.callback(targetStart);
      }
      if (this.endFramesWidget.callback) {
        this.endFramesWidget.callback(targetEnd);
      }
      this.commitChanges();
      this.render();
    }
  }

  markCurrentSelection() {
    if (this.retakeMode) {
      if (this.timeline.retakeVideo) {
        const baseVideoDur = this.timeline.retakeVideo.videoDurationFrames || 24;
        const targetStart = 0;
        const targetEnd = baseVideoDur;

        if (this.startFramesWidget && this.endFramesWidget) {
          this.startFramesWidget.value = targetStart;
          this.endFramesWidget.value = targetEnd;
          if (this.startFramesWidget.callback) {
            this.startFramesWidget.callback(targetStart);
          }
          if (this.endFramesWidget.callback) {
            this.endFramesWidget.callback(targetEnd);
          }
          this.commitChanges();
          this.render();
        }
      }
      return;
    }

    const allSegs = [
      ...(this.timeline.segments || []),
      ...(this.timeline.motionSegments || []),
      ...(this.timeline.audioSegments || [])
    ];
    let targetSegs = [];

    if (this.selectedSegmentIds && this.selectedSegmentIds.length > 0) {
      targetSegs = allSegs.filter(s => this.selectedSegmentIds.includes(s.id));
    }

    if (targetSegs.length === 0 && this.selectedIndex >= 0 && this.selectionType) {
      const arr = this.getSegmentArray(this.selectionType);
      if (arr && arr[this.selectedIndex]) {
        targetSegs = [arr[this.selectedIndex]];
      }
    }

    if (targetSegs.length === 0) return;

    let minStart = Infinity;
    let maxEnd = -Infinity;
    for (const s of targetSegs) {
      if (s.start < minStart) {
        minStart = s.start;
      }
      if (s.start + s.length > maxEnd) {
        maxEnd = s.start + s.length;
      }
    }

    if (minStart !== Infinity && maxEnd !== -Infinity) {
      const newStart = Math.round(minStart);
      const newEnd = Math.max(newStart + 1, Math.round(maxEnd));

      const currentStart = this.getStartFrames();
      const currentEnd = this.endFramesWidget ? parseInt(this.endFramesWidget.value, 10) : (currentStart + this.getDurationFrames());

      let targetStart = newStart;
      let targetEnd = newEnd;

      if (currentStart === newStart && currentEnd === newEnd) {
        let lastSegmentEnd = 0;
        for (const s of allSegs) {
          if (s.start + s.length > lastSegmentEnd) {
            lastSegmentEnd = s.start + s.length;
          }
        }
        if (lastSegmentEnd <= 0) {
          lastSegmentEnd = this.getDurationFrames();
        }
        targetStart = 0;
        targetEnd = Math.max(1, Math.round(lastSegmentEnd));
      }

      if (this.startFramesWidget && this.endFramesWidget) {
        this.startFramesWidget.value = targetStart;
        this.endFramesWidget.value = targetEnd;
        if (this.startFramesWidget.callback) {
          this.startFramesWidget.callback(targetStart);
        }
        if (this.endFramesWidget.callback) {
          this.endFramesWidget.callback(targetEnd);
        }
        this.commitChanges();
        this.render();
      }
    }
  }

  deleteSelectedSegment() {
    // 先删框选的多参参考图
    if (this.selectedH3RefIndexes && this.selectedH3RefIndexes.length) {
      const idxs = [...this.selectedH3RefIndexes].sort((a, b) => b - a);
      for (const i of idxs) this.h3RemoveRefImage?.(i);
      this.selectedH3RefIndexes = [];
    }

    // 选中的驱动音频段（可整轨清空）
    const driveSegs = (this.timeline?.audioSegments || []).filter((s) => s?.isH3Drive);
    const selectedIds = new Set(this.selectedSegmentIds || []);
    // 单选时补上当前 selectedIndex
    if (this.selectionType === "audio" && this.selectedIndex >= 0) {
      const cur = this.timeline.audioSegments?.[this.selectedIndex];
      if (cur?.id) selectedIds.add(cur.id);
    }
    const driveSelected = driveSegs.filter((s) => selectedIds.has(s.id));
    if (driveSelected.length) {
      const delIds = new Set(driveSelected.map((s) => s.id));
      this.timeline.audioSegments = (this.timeline.audioSegments || []).filter(
        (s) => !delIds.has(s.id)
      );
      const remainDrive = (this.timeline.audioSegments || []).some((s) => s?.isH3Drive);
      if (!remainDrive) {
        this.h3RemoveDriveAudio();
        return;
      }
      this._h3RefreshDriveMetaFromSegments?.();
      this.selectedSegmentIds = (this.selectedSegmentIds || []).filter((id) => !delIds.has(id));
      this.selectedIndex = -1;
      if (!this.manualOutputRange) this.syncDurationToTimelineSegments?.();
      this.updateUIFromSelection();
      this.commitChanges();
      this.render();
      // 若还选了主轨等，继续删；否则结束
      if (!(this.selectedSegmentIds && this.selectedSegmentIds.length)) return;
    }

    if (this.selectedSegmentIds && this.selectedSegmentIds.length > 1) {
      const idsToDelete = new Set(this.selectedSegmentIds);
      for (const id of this.selectedSegmentIds) {
        if (id.endsWith("_v")) idsToDelete.add(id.slice(0, -2) + "_a");
        else if (id.endsWith("_a")) idsToDelete.add(id.slice(0, -2) + "_v");
      }

      this.timeline.segments = this.timeline.segments.filter(s => !idsToDelete.has(s.id));
      this.timeline.motionSegments = this.timeline.motionSegments.filter(s => !idsToDelete.has(s.id));
      this.timeline.audioSegments = this.timeline.audioSegments.filter(s => !idsToDelete.has(s.id));

      // 驱动音频删光则彻底清空（禁止自动重建）
      if (!(this.timeline.audioSegments || []).some((s) => s?.isH3Drive)) {
        this.h3RemoveDriveAudio();
        return;
      }

      this.selectedSegmentIds = [];
      this.selectedIndex = -1;
    } else if (this.selectedSegmentIds?.length === 1 || this.selectedIndex !== -1) {
      const delSibling = (seg) => {
        if (!seg || !seg.id) return;
        const isVid = seg.id.endsWith("_v");
        const isAud = seg.id.endsWith("_a");
        if (!isVid && !isAud) return;

        const siblingId = isVid ? seg.id.slice(0, -2) + "_a" : seg.id.slice(0, -2) + "_v";
        const siblingArray = isVid ? this.timeline.audioSegments : this.timeline.segments;
        const sIdx = siblingArray.findIndex(s => s.id === siblingId);
        if (sIdx !== -1) siblingArray.splice(sIdx, 1);
      };

      // 单选：优先用 selectedSegmentIds[0]
      if (this.selectedSegmentIds?.length === 1) {
        const id = this.selectedSegmentIds[0];
        for (const track of ["image", "audio", "motion"]) {
          const arr = this.getSegmentArray(track);
          const idx = arr.findIndex((s) => s.id === id);
          if (idx !== -1) {
            this.selectionType = track;
            this.selectedIndex = idx;
            break;
          }
        }
      }

      if (this.selectionType === "audio") {
        if (this.timeline.audioSegments.length === 0 || this.selectedIndex === -1) {
          this.updateUIFromSelection();
          this.commitChanges();
          this.render();
          return;
        }
        const doomed = this.timeline.audioSegments[this.selectedIndex];
        delSibling(doomed);
        this.timeline.audioSegments.splice(this.selectedIndex, 1);
        if (doomed?.isH3Drive && !(this.timeline.audioSegments || []).some((s) => s?.isH3Drive)) {
          this.h3RemoveDriveAudio();
          return;
        }
        if (doomed?.isH3Drive) this._h3RefreshDriveMetaFromSegments?.();
        this.selectedIndex = Math.max(-1, this.selectedIndex - 1);
      } else if (this.selectionType === "motion") {
        if (this.timeline.motionSegments.length === 0 || this.selectedIndex === -1) return;
        delSibling(this.timeline.motionSegments[this.selectedIndex]);
        this.timeline.motionSegments.splice(this.selectedIndex, 1);
        this.selectedIndex = Math.max(-1, this.selectedIndex - 1);
      } else {
        if (this.timeline.segments.length === 0 || this.selectedIndex === -1) {
          this.updateUIFromSelection();
          this.commitChanges();
          this.render();
          return;
        }
        delSibling(this.timeline.segments[this.selectedIndex]);
        this.timeline.segments.splice(this.selectedIndex, 1);
        this.selectedIndex = Math.max(-1, this.selectedIndex - 1);
      }
      this.selectedSegmentIds = [];
    }
    if (!this.manualOutputRange) this.syncDurationToTimelineSegments?.();
    this.updateUIFromSelection();
    this.commitChanges();
    this.render();
  }

  getCanonicalTrack(track) {
    if (track === "image" || track === "video" || track === "text") return "image";
    if (track === "audio") return "audio";
    if (track === "motion" || track === "motion_video") return "motion";
    return track;
  }

  pasteCopiedSegment() {
    if (!window._ltxCopiedSegment || !window._ltxCopiedSegmentType) return;
    const trackType = window._ltxCopiedSegmentType;
    const startFrame = Math.round(this.currentFrame);
    this.pasteSegmentAtFrame(window._ltxCopiedSegment.main, trackType, window._ltxCopiedSegment.sibling, startFrame);
  }

  pasteSegmentAtFrame(copiedSegData, copiedTrack, siblingSegData, startFrame) {
    const isAudio = copiedTrack === "audio";
    if (this._h3SkipVideoAudioPair() && copiedTrack !== "audio") {
      siblingSegData = null;
    }

    const randId = () => Date.now().toString() + Math.random().toString(36).substr(2, 5);
    const baseId = randId();

    let mainSeg = { ...copiedSegData };
    let sibSeg = siblingSegData ? { ...siblingSegData } : null;

    if (sibSeg) {
      mainSeg.id = baseId + (isAudio ? "_a" : "_v");
      sibSeg.id = baseId + (isAudio ? "_v" : "_a");
    } else {
      if (mainSeg.id && (mainSeg.id.endsWith("_v") || mainSeg.id.endsWith("_a"))) {
        mainSeg.id = mainSeg.id.slice(0, -2);
      } else {
        mainSeg.id = baseId;
      }
    }

    if (mainSeg.thumbnails) mainSeg.thumbnails = [...mainSeg.thumbnails];
    if (sibSeg && sibSeg.thumbnails) sibSeg.thumbnails = [...sibSeg.thumbnails];

    mainSeg.start = startFrame;
    if (sibSeg) sibSeg.start = startFrame;

    const mainArr = isAudio ? [...this.timeline.audioSegments] : (copiedTrack === "motion" ? [...this.timeline.motionSegments] : [...this.timeline.segments]);
    mainArr.push(mainSeg);
    mainArr.sort((a, b) => a.start - b.start);

    const sibArr = isAudio ? [...this.timeline.segments] : [...this.timeline.audioSegments];
    if (sibSeg) {
      sibArr.push(sibSeg);
      sibArr.sort((a, b) => a.start - b.start);
    }

    const durationFrames = this.getDurationFrames();
    const totalFrames = this.getVisualDurationFrames();
    const width = this.canvas.offsetWidth || this._lastWidth;

    const mainInit = mainArr.map(s => ({ ...s }));
    const sibInit = sibSeg ? sibArr.map(s => ({ ...s })) : null;

    let finalMain, finalSib;
    finalMain = this._applyCenterDragPhysics(mainInit, mainSeg.id, startFrame, startFrame + mainSeg.length / 2, durationFrames, totalFrames, width, true);
    if (sibSeg) {
      finalSib = this._applyCenterDragPhysics(sibInit, sibSeg.id, startFrame, startFrame + sibSeg.length / 2, durationFrames, totalFrames, width, true);
    }

    if (sibSeg) {
      const activeTimeline = isAudio ? finalMain : finalSib;
      const siblingTimeline = isAudio ? finalSib : finalMain;
      this._resolveGlobalPhysics(activeTimeline, siblingTimeline, durationFrames, mainInit, sibInit);
    }

    const restoreDOM = (outArr, refArr) => {
      for (let ps of outArr) {
        const orig = refArr.find(s => s.id === ps.id);
        if (orig) {
          ps.videoEl = orig.videoEl;
          ps.imgObj = orig.imgObj;
          if (orig.thumbnails) ps.thumbnails = orig.thumbnails;
        }
      }
    };

    restoreDOM(finalMain, mainArr);
    if (sibSeg) restoreDOM(finalSib, sibArr);

    if (copiedTrack === "audio") {
      this.timeline.audioSegments = finalMain;
      if (sibSeg) this.timeline.segments = finalSib;
    } else if (copiedTrack === "motion") {
      this.timeline.motionSegments = finalMain;
    } else {
      this.timeline.segments = finalMain;
      if (sibSeg) this.timeline.audioSegments = finalSib;
    }

    this.selectionType = copiedTrack;
    this.selectedIndex = this.getSegmentArray(copiedTrack).findIndex(s => s.id === mainSeg.id);

    if (!this.retakeMode) {
      this.growTimelineIfNeeded(mainSeg.start + mainSeg.length);
    }

    this.updateUIFromSelection();
    this.commitChanges();
    this.render();
  }

  splitSegmentAtPlayhead(seg, trackType) {
    if (this.isPlaying) {
      this.pauseAudio();
    }

    const splitFrame = Math.round(this.currentFrame);
    if (splitFrame <= seg.start || splitFrame >= seg.start + seg.length) {
      return;
    }

    const isVidLink = (trackType === "image" || trackType === "video") && seg.id.endsWith("_v");
    const isAudLink = trackType === "audio" && seg.id.endsWith("_a");
    let sibling = null;
    if (isVidLink) {
      sibling = this.timeline.audioSegments.find(s => s.id === seg.id.slice(0, -2) + "_a");
    } else if (isAudLink) {
      sibling = this.timeline.segments.find(s => s.id === seg.id.slice(0, -2) + "_v");
    }

    const randId = () => Date.now().toString() + Math.random().toString(36).substr(2, 5);
    const leftBase = randId();
    const rightBase = randId();

    const leftLen = splitFrame - seg.start;
    const rightLen = seg.start + seg.length - splitFrame;

    if (sibling) {
      const videoSeg = isVidLink ? seg : sibling;
      const audioSeg = isVidLink ? sibling : seg;

      const leftVid = {
        ...videoSeg,
        id: leftBase + "_v",
        length: leftLen,
        videoEl: null,
        _blobUrl: videoSeg._blobUrl || (videoSeg.videoEl ? videoSeg.videoEl.src : null),
        thumbnails: videoSeg.thumbnails ? [...videoSeg.thumbnails] : null
      };
      const leftAud = {
        ...audioSeg,
        id: leftBase + "_a",
        length: leftLen,
        _blobUrl: videoSeg._blobUrl || (videoSeg.videoEl ? videoSeg.videoEl.src : null)
      };

      let rightImageB64 = videoSeg.imageB64;
      let rightImgObj = videoSeg.imgObj;
      if (videoSeg.thumbnails && videoSeg.thumbnails.length > 0) {
        const targetTime = ((videoSeg.trimStart || 0) + leftLen) / this.getFrameRate();
        let nearest = videoSeg.thumbnails[0];
        let minDiff = Infinity;
        for (const t of videoSeg.thumbnails) {
          const diff = Math.abs(t.time - targetTime);
          if (diff < minDiff) {
            minDiff = diff;
            nearest = t;
          }
        }
        if (nearest && nearest.img) {
          rightImageB64 = nearest.img.src;
          rightImgObj = nearest.img;
        }
      }

      const rightVid = {
        ...videoSeg,
        id: rightBase + "_v",
        start: splitFrame,
        length: rightLen,
        trimStart: (videoSeg.trimStart || 0) + leftLen,
        videoEl: null,
        imageB64: rightImageB64,
        imgObj: rightImgObj,
        _blobUrl: videoSeg._blobUrl || (videoSeg.videoEl ? videoSeg.videoEl.src : null),
        thumbnails: videoSeg.thumbnails ? [...videoSeg.thumbnails] : null
      };
      const rightAud = {
        ...audioSeg,
        id: rightBase + "_a",
        start: splitFrame,
        length: rightLen,
        trimStart: (audioSeg.trimStart || 0) + leftLen,
        _blobUrl: videoSeg._blobUrl || (videoSeg.videoEl ? videoSeg.videoEl.src : null)
      };

      this.timeline.segments = this.timeline.segments.filter(s => s.id !== videoSeg.id);
      this.timeline.audioSegments = this.timeline.audioSegments.filter(s => s.id !== audioSeg.id);

      this.timeline.segments.push(leftVid, rightVid);
      this.timeline.audioSegments.push(leftAud, rightAud);

      this.timeline.segments.sort((a, b) => a.start - b.start);
      this.timeline.audioSegments.sort((a, b) => a.start - b.start);

      this.selectionType = trackType;
      const targetId = trackType === "audio" ? leftAud.id : leftVid.id;
      const targetArray = this.getSegmentArray(trackType);
      this.selectedIndex = targetArray.findIndex(s => s.id === targetId);

    } else {
      const targetArray = this.getSegmentArray(trackType);

      const leftSeg = {
        ...seg,
        id: leftBase,
        length: leftLen
      };
      if (seg.type === "video" || seg.type === "motion_video") {
        leftSeg.videoEl = null;
        leftSeg._blobUrl = seg._blobUrl || (seg.videoEl ? seg.videoEl.src : null);
        leftSeg.thumbnails = seg.thumbnails ? [...seg.thumbnails] : null;
      }

      let rightImageB64 = seg.imageB64;
      let rightImgObj = seg.imgObj;
      if (seg.thumbnails && seg.thumbnails.length > 0) {
        const targetTime = ((seg.trimStart || 0) + leftLen) / this.getFrameRate();
        let nearest = seg.thumbnails[0];
        let minDiff = Infinity;
        for (const t of seg.thumbnails) {
          const diff = Math.abs(t.time - targetTime);
          if (diff < minDiff) {
            minDiff = diff;
            nearest = t;
          }
        }
        if (nearest && nearest.img) {
          rightImageB64 = nearest.img.src;
          rightImgObj = nearest.img;
        }
      }

      const rightSeg = {
        ...seg,
        id: rightBase,
        start: splitFrame,
        length: rightLen,
        trimStart: (seg.trimStart || 0) + leftLen
      };
      if (seg.type === "video" || seg.type === "motion_video") {
        rightSeg.videoEl = null;
        rightSeg.imageB64 = rightImageB64;
        rightSeg.imgObj = rightImgObj;
        rightSeg._blobUrl = seg._blobUrl || (seg.videoEl ? seg.videoEl.src : null);
        rightSeg.thumbnails = seg.thumbnails ? [...seg.thumbnails] : null;
      }

      const idx = targetArray.findIndex(s => s.id === seg.id);
      if (idx !== -1) {
        targetArray.splice(idx, 1);
      }

      targetArray.push(leftSeg, rightSeg);
      targetArray.sort((a, b) => a.start - b.start);

      this.selectionType = trackType;
      this.selectedIndex = targetArray.findIndex(s => s.id === leftSeg.id);
    }

    this.loadMedia();
    this.updateUIFromSelection();
    this.commitChanges();
      this.render();
  }

  cutSelectedSegmentAtPlayhead() {
    if (this.retakeMode || this.isMultiSelectActive()) return;
    const arr = this.getSegmentArray(this.selectionType);
    const seg = arr?.[this.selectedIndex];
    if (!seg) return;
    const wasDrive = !!seg.isH3Drive;
    const srcFile = seg.audioFile || seg.fileName;
    const srcBlob = seg._blobUrl;
    const srcPeaks = seg.waveformPeaks;
    const srcDurFrames = seg.audioDurationFrames;
    this.splitSegmentAtPlayhead(seg, this.selectionType);
    // 剪刀切开：两段都保留驱动标记与同一源文件/波形
    if (wasDrive && this.timeline?.audioSegments) {
      for (const s of this.timeline.audioSegments) {
        if (!s) continue;
        const same =
          s.audioFile === srcFile ||
          s.fileName === srcFile ||
          (srcBlob && s._blobUrl === srcBlob) ||
          s.isH3Drive;
        if (!same && s.id !== seg.id) continue;
        // 只处理刚切开的同源段
        if (
          s.audioFile === srcFile ||
          s.fileName === srcFile ||
          (srcBlob && s._blobUrl === srcBlob)
        ) {
          s.isH3Drive = true;
          if (srcPeaks) s.waveformPeaks = srcPeaks;
          if (srcDurFrames) s.audioDurationFrames = srcDurFrames;
        }
      }
      this._h3RefreshDriveMetaFromSegments?.();
      if (!this.manualOutputRange) this.syncDurationToTimelineSegments?.();
    }
  }

  /** 剪辑/拖动后刷新 driveAudio 元数据（绝不写入参考音槽 d.audios） */
  _h3RefreshDriveMetaFromSegments() {
    const d = this.ensureH3MultiData?.();
    if (!d) return;
    const segs = (this.timeline?.audioSegments || []).filter((s) => s?.isH3Drive);
    if (!segs.length) {
      d.driveAudio = null;
      return;
    }
    this._h3DriveUserCleared = false;
    const first = segs[0];
    const maxEnd = segs.reduce((m, s) => Math.max(m, (s.start || 0) + (s.length || 0)), 0);
    const fps = this.getFrameRate();
    const meta = {
      id: first.id,
      name: first.name || d.driveAudio?.name || first.fileName,
      fileName: first.fileName || first.audioFile || d.driveAudio?.fileName,
      previewUrl: first._blobUrl || d.driveAudio?.previewUrl,
      duration: maxEnd / fps,
      waveformPeaks: first.waveformPeaks || d.driveAudio?.waveformPeaks,
      role: "drive",
      // 多段列表（后端可按 trim 拼接）
      pieces: segs.map((s) => ({
        id: s.id,
        start: s.start,
        length: s.length,
        trimStart: s.trimStart || 0,
        audioDurationFrames: s.audioDurationFrames || (s.trimStart || 0) + (s.length || 0),
        fileName: s.fileName || s.audioFile,
      })),
    };
    d.driveAudio = meta;
    // 顺带清掉历史上误写入参考音槽的驱动项
    if (Array.isArray(d.audios)) {
      d.audios = d.audios.map((x) =>
        x && (x.role === "drive" || x.pieces) ? null : x
      );
      while (d.audios.length > 0 && !d.audios[d.audios.length - 1]) d.audios.pop();
    }
  }

  updateManualOutputRangeToggle() {
    if (!this.manualOutputRangeBtn) return;
    const isOn = this.manualOutputRange === true;
    this.manualOutputRangeBtn.textContent = `手动范围: ${isOn ? "开" : "关"}`;
    this.manualOutputRangeBtn.classList.toggle("toggle-on", isOn);
    this.manualOutputRangeBtn.title = isOn
      ? "手动范围已开：总时长/起止不跟轨道自动变；点按钮可关"
      : this.isH3MultiMode && this.isH3MultiMode()
        ? "手动范围已关：总时长只跟随主轨文本段；点按钮可开"
        : "手动范围已关：总时长跟随主轨/音频/参考视频轨；点按钮可开";
  }

  setManualOutputRange(enabled, commit = true) {
    this.manualOutputRange = enabled === true;
    this.timeline.manualOutputRange = this.manualOutputRange;
    this.updateManualOutputRangeToggle();
    if (commit) {
      // 关手动范围：多参先清旧轨残留，再只按主轨重算时长
      if (!this.manualOutputRange) {
        if (this.isH3MultiMode && this.isH3MultiMode()) {
          this.clearLegacyMultiTimelineMedia();
        }
        this.syncDurationToTimelineSegments();
      }
      this.commitChanges();
      this.render();
    }
  }

  /**
   * 多参模式：清掉旧时间轴音/视频段残留（槽位参考不走这些数组）
   * @param {{ stopPlayback?: boolean }} opts stopPlayback 默认 true；播放中清数组时请传 false
   */
  clearLegacyMultiTimelineMedia(opts = {}) {
    if (!this.timeline) return false;
    const stopPlayback = opts.stopPlayback !== false;
    let changed = false;
    if (stopPlayback) {
      try {
        if (Array.isArray(this.activeAudioNodes)) {
          for (const node of this.activeAudioNodes) {
            try { node.stop(); } catch (_) {}
            try { node.disconnect(); } catch (_) {}
          }
          this.activeAudioNodes = [];
        }
      } catch (_) {}
      try {
        this.pauseAudio?.(true);
      } catch (_) {}
      this.h3StopMediaPreview?.();
    }

    if (Array.isArray(this.timeline.audioSegments) && this.timeline.audioSegments.length) {
      const keepDrive = [];
      for (const seg of this.timeline.audioSegments) {
        if (seg?.isH3Drive) {
          keepDrive.push(seg);
          continue;
        }
        try {
          if (seg?._blobUrl) URL.revokeObjectURL(seg._blobUrl);
        } catch (_) {}
        if (seg) {
          seg._audioBuffer = null;
          seg._blobUrl = null;
        }
        changed = true;
      }
      this.timeline.audioSegments = keepDrive;
    }
    if (Array.isArray(this.timeline.motionSegments) && this.timeline.motionSegments.length) {
      for (const seg of this.timeline.motionSegments) {
        try {
          if (seg?.videoEl && !seg.videoEl.paused) seg.videoEl.pause();
          if (seg?._blobUrl) URL.revokeObjectURL(seg._blobUrl);
        } catch (_) {}
        if (seg) {
          seg.videoEl = null;
          seg._blobUrl = null;
        }
      }
      this.timeline.motionSegments = [];
      changed = true;
    }
    return changed;
  }

  /** 删除参考音/视频后，清掉对应解码缓存，避免红线播放仍出声 */
  _purgeAudioBufferCache(removed) {
    if (!removed || !this._audioBufferCache) return;
    const keys = [
      removed.fileName,
      removed.name,
      removed.videoFile,
      removed.audioFile,
      removed.previewUrl,
    ].filter(Boolean);
    for (const k of keys) {
      try {
        this._audioBufferCache.delete(k);
      } catch (_) {}
    }
    // 文件名可能带 subfolder，整表扫一遍后缀匹配
    try {
      for (const cacheKey of [...this._audioBufferCache.keys()]) {
        const base = String(cacheKey).split(/[/\\]/).pop();
        if (keys.some((k) => k === cacheKey || k === base || String(k).endsWith(base))) {
          this._audioBufferCache.delete(cacheKey);
        }
      }
    } catch (_) {}
  }

  updateICVideoSizeToggle() {
    if (!this.icVideoSizeBtn) return;
    const isOn = this.useICVideoSize === true;
    this.icVideoSizeBtn.textContent = `参考尺寸: ${isOn ? "开" : "关"}`;
    this.icVideoSizeBtn.classList.toggle("toggle-on", isOn);
    this.icVideoSizeBtn.title = isOn
      ? "输出尺寸跟随首个参考视频"
      : "输出尺寸使用导演台宽高设置";
  }

  setICVideoSize(enabled, commit = true) {
    this.useICVideoSize = enabled === true;
    this.timeline.useICVideoSize = this.useICVideoSize;
    const widget = this.node.widgets?.find(w => w.name === "use_ic_video_size");
    if (widget) widget.value = this.useICVideoSize;
    if (this.node.properties) this.node.properties.use_ic_video_size = this.useICVideoSize;
    this.updateICVideoSizeToggle();
    if (commit) this.commitChanges();
  }

  getSelectedTimelineSegments() {
    const ids = new Set(this.selectedSegmentIds || []);
    if (ids.size === 0) return [];
    return [
      ...(this.timeline.segments || []),
      ...(this.timeline.motionSegments || []),
      ...(this.timeline.audioSegments || []),
    ].filter(s => ids.has(s.id));
  }

  getRangeSourceSegments(seg) {
    if (seg && this.isMultiSelectActive() && this.selectedSegmentIds.includes(seg.id)) {
      return this.getSelectedTimelineSegments();
    }
    return seg ? [seg] : [];
  }

  setOutputRangeFrames(start, end) {
    start = Math.max(0, Math.round(Number(start) || 0));
    end = Math.max(start + 1, Math.round(Number(end) || start + 1));
    const duration = end - start;
    const fps = this.getFrameRate();

    if (this.startFramesWidget) this.startFramesWidget.value = start;
    if (this.startSecondsWidget) this.startSecondsWidget.value = parseFloat((start / fps).toFixed(3));
    if (this.endFramesWidget) this.endFramesWidget.value = end;
    if (this.endSecondsWidget) this.endSecondsWidget.value = parseFloat((end / fps).toFixed(3));
    if (this.durationFramesWidget) this.durationFramesWidget.value = duration;
    if (this.durationSecondsWidget) this.durationSecondsWidget.value = parseFloat((duration / fps).toFixed(3));

    this.timeline.normalStartFrame = start;
    this.timeline.normalDurationFrames = duration;
    this.setManualOutputRange(true, false);
    this.commitChanges();
    this.render();
  }

  setStartAtPlayhead() {
    const currentEnd = this.endFramesWidget?.value ?? (this.getStartFrames() + this.getDurationFrames());
    this.setOutputRangeFrames(this.currentFrame, currentEnd);
  }

  setEndAtPlayhead() {
    this.setOutputRangeFrames(this.getStartFrames(), this.currentFrame);
  }

  setOutputRangeFromSegments(segments) {
    const range = calculateSegmentRange(segments);
    if (!range) return;
    this.setOutputRangeFrames(range.start, range.end);
  }

  setDurationToSegmentsEnd(segments) {
    const range = calculateSegmentRange(segments);
    if (!range) return;
    const start = this.getStartFrames();
    this.setOutputRangeFrames(start, Math.max(start + 1, range.end));
  }

  setSelectedDurationSeconds(value) {
    if (this.retakeMode) {
      const seconds = parseFloat(value);
      if (!Number.isFinite(seconds)) return;
      this.timeline.retakeLength = Math.max(1, Math.round(seconds * this.getFrameRate()));
      this.updateUIFromSelection();
      this.commitChanges();
      this.render();
      return;
    }

    const arr = this.getSegmentArray(this.selectionType);
    const seg = arr?.[this.selectedIndex];
    if (!seg) return;

    const seconds = parseFloat(value);
    if (!Number.isFinite(seconds)) {
      if (this.durationValue) this.durationValue.value = (seg.length / this.getFrameRate()).toFixed(2);
      return;
    }

    const segId = seg.id;
    const siblingId = String(seg.id || "").endsWith("_v")
      ? String(seg.id).slice(0, -2) + "_a"
      : String(seg.id || "").endsWith("_a")
        ? String(seg.id).slice(0, -2) + "_v"
        : null;
    let sibling = null;
    let siblingArray = null;
    if (siblingId) {
      siblingArray = siblingId.endsWith("_a") ? this.timeline.audioSegments : this.timeline.segments;
      sibling = siblingArray?.find(s => s.id === siblingId);
    }

    const oldEnd = seg.start + seg.length;
    let newLength = Math.max(MIN_SEGMENT_LENGTH, Math.round(seconds * this.getFrameRate()));
    if (seg.videoDurationFrames || seg.audioDurationFrames) {
      newLength = clampSegmentLengthToSource({ ...seg, length: newLength });
    }
    const keepAudioTail = this.selectionType === "audio" && !sibling && newLength < seg.length;
    let tailSeg = null;
    if (keepAudioTail) {
      const tailId = Date.now().toString() + Math.random().toString(36).substr(2, 5);
      tailSeg = splitSegmentTailAfterShrink(seg, newLength, tailId);
      if (tailSeg) arr.push(tailSeg);
    } else {
      seg.length = newLength;
    }
    const newEnd = seg.start + seg.length;
    if (sibling) sibling.length = seg.length;

    if (!tailSeg) pullSegmentsAfterShrink(arr, oldEnd, newEnd, segId);
    pushOverlappingSegmentsForward(arr, segId);
    if (sibling && siblingArray) {
      pullSegmentsAfterShrink(siblingArray, oldEnd, newEnd, sibling.id);
      pushOverlappingSegmentsForward(siblingArray, sibling.id);
    }
    this.selectedIndex = arr.findIndex(s => s.id === segId);

    this.syncDurationToTimelineSegmentsIfAuto();
    this.updateUIFromSelection();
    this.commitChanges();
    this.render();
  }

  rangesOverlap(a, b) {
    return Math.min(a.start + a.length, b.start + b.length) > Math.max(a.start, b.start);
  }

  getOverlappingAudioSegment(seg) {
    if (!seg) return null;
    return (this.timeline.audioSegments || []).find(audioSeg => this.rangesOverlap(seg, audioSeg)) || null;
  }

  getOverlappingVisualSegment(seg) {
    if (!seg) return null;
    const visualSegments = [
      ...(this.timeline.motionSegments || []),
      ...(this.timeline.segments || []).filter(s => s.id !== seg.id && s.type !== "text"),
    ];
    return visualSegments.find(target => this.rangesOverlap(seg, target)) || null;
  }

  alignSegmentToTarget(seg, targetSeg) {
    if (!seg || !targetSeg) return false;
    seg.start = targetSeg.start;
    seg.length = targetSeg.length;
    return true;
  }

  fitSegmentsToTarget(targetSeg, segments) {
    const list = (segments || []).filter(Boolean).sort((a, b) => a.start - b.start);
    if (!targetSeg || list.length === 0) return 0;
    if (list.length === 1) return this.alignSegmentToTarget(list[0], targetSeg) ? 1 : 0;

    const sourceLength = Math.max(1, list.reduce((sum, seg) => sum + Math.max(MIN_SEGMENT_LENGTH, seg.length), 0));
    const targetEnd = targetSeg.start + targetSeg.length;
    let cursor = targetSeg.start;

    for (let i = 0; i < list.length; i++) {
      const seg = list[i];
      const remainingReserve = (list.length - i - 1) * MIN_SEGMENT_LENGTH;
      const maxLength = Math.max(MIN_SEGMENT_LENGTH, targetEnd - cursor - remainingReserve);
      const ratioLength = Math.max(MIN_SEGMENT_LENGTH, Math.round((Math.max(MIN_SEGMENT_LENGTH, seg.length) / sourceLength) * targetSeg.length));
      const newLength = i === list.length - 1 ? Math.max(MIN_SEGMENT_LENGTH, targetEnd - cursor) : clamp(ratioLength, MIN_SEGMENT_LENGTH, maxLength);
      seg.start = cursor;
      seg.length = newLength;
      cursor += newLength;
    }
    return list.length;
  }

  alignSelectedImageToTarget(seg, targetSeg) {
    if (!targetSeg) return false;
    this.fitSegmentsToTarget(targetSeg, [seg]);
    const arr = this.getSegmentArray("image");
    pushOverlappingSegmentsForward(arr, seg.id);
    arr.sort((a, b) => a.start - b.start);
    this.selectionType = "image";
    this.selectedIndex = arr.findIndex(s => s.id === seg.id);
    this.syncDurationToTimelineSegmentsIfAuto();
    this.commitChanges();
    this.updateUIFromSelection();
    this.render();
    return true;
  }

  /** 兼容中文「帧/秒」和旧英文 frames/seconds */
  _isSecondsMode() {
    const v = this.displayModeWidget ? this.displayModeWidget.value : "秒";
    return v === "seconds" || v === "秒" || v === true;
  }

  _isFramesMode() {
    return !this._isSecondsMode();
  }

  _toggleDisplayModeValue(val) {
    if (val === "帧") return "秒";
    if (val === "秒") return "帧";
    if (val === "frames") return "seconds";
    if (val === "seconds") return "frames";
    // 默认按中文选项切换
    return this._isSecondsMode() ? "帧" : "秒";
  }

  formatTime(frames, dropSuffix = false) {
    if (this._isSecondsMode()) {
      const secs = Math.round(frames) / this.getFrameRate();
      return dropSuffix ? secs.toFixed(2) : secs.toFixed(2) + "s";
    }
    return dropSuffix ? Math.round(frames).toString() : Math.round(frames) + " 帧";
  }

  updateWidgetVisibility() {
    const isSeconds = this._isSecondsMode();

    const isLiteGraph = !window.LiteGraph || !window.LiteGraph.vueNodesMode;

    if (isSeconds) {
      if (this.startFramesWidget) hideWidget(this.startFramesWidget);
      if (this.endFramesWidget) hideWidget(this.endFramesWidget);
      if (this.durationFramesWidget) hideWidget(this.durationFramesWidget);
      if (this.startSecondsWidget) showWidget(this.startSecondsWidget);
      if (this.endSecondsWidget) showWidget(this.endSecondsWidget);
      if (this.durationSecondsWidget) showWidget(this.durationSecondsWidget);

      // LiteGraph: remove frame input slots, restore second input slots
      if (isLiteGraph && this.node.inputs) {
        for (const name of ["start_frame", "end_frame", "duration_frames"]) {
          const idx = this.node.inputs.findIndex(i => i.name === name);
          if (idx !== -1 && this.node.inputs[idx].link == null) {
            this.node.removeInput(idx);
          }
        }
        for (const [name, type] of [["start_second", "FLOAT"], ["end_second", "FLOAT"], ["duration_seconds", "FLOAT"]]) {
          if (!this.node.inputs.find(i => i.name === name)) {
            const w = this.node.widgets?.find(w => w.name === name);
            const slot = this.node.addInput(name, type);
            // keep the slot linked to its widget
            if (w && slot != null) {
              const inp = this.node.inputs[this.node.inputs.length - 1];
              if (inp) inp.widget = { name };
            }
          }
        }
      }
    } else {
      if (this.startSecondsWidget) hideWidget(this.startSecondsWidget);
      if (this.endSecondsWidget) hideWidget(this.endSecondsWidget);
      if (this.durationSecondsWidget) hideWidget(this.durationSecondsWidget);
      if (this.startFramesWidget) showWidget(this.startFramesWidget);
      if (this.endFramesWidget) showWidget(this.endFramesWidget);
      if (this.durationFramesWidget) showWidget(this.durationFramesWidget);

      // LiteGraph: remove second input slots, restore frame input slots
      if (isLiteGraph && this.node.inputs) {
        for (const name of ["start_second", "end_second", "duration_seconds"]) {
          const idx = this.node.inputs.findIndex(i => i.name === name);
          if (idx !== -1 && this.node.inputs[idx].link == null) {
            this.node.removeInput(idx);
          }
        }
        for (const [name, type] of [["start_frame", "INT"], ["end_frame", "INT"], ["duration_frames", "INT"]]) {
          if (!this.node.inputs.find(i => i.name === name)) {
            const slot = this.node.addInput(name, type);
            if (slot != null) {
              const inp = this.node.inputs[this.node.inputs.length - 1];
              if (inp) inp.widget = { name };
            }
          }
        }
      }
    }

    // Force node resize and redraw deferred to next tick
    setTimeout(() => {
      if (this.node && this.node.computeSize) {
        const sz = this.node.computeSize();
        this.node.size[1] = sz[1];
        if (window.app && window.app.graph) {
          window.app.graph.setDirtyCanvas(true, true);
        }
      }
    }, 0);
  }

  getGlobalPrompt() {
    if (this.globalPromptInput) {
      return this.globalPromptInput.value || "";
    }
    let val = "";
    if (this.node) {
      const globalInput = this.node.inputs?.find(i => i.name === "global_prompt");
      if (globalInput && globalInput.link !== null && globalInput.link !== undefined) {
        const link = window.app.graph?.links?.[globalInput.link];
        if (link) {
          const originNode = window.app.graph.getNodeById(link.origin_id);
          if (originNode && originNode.widgets && originNode.widgets.length > 0) {
            val = originNode.widgets[0].value || "";
          }
        }
      } else {
        const w = this.node.widgets?.find(x => x.name === "global_prompt");
        if (w) {
          val = w.value || "";
        } else {
          val = this.node.properties?.global_prompt || "";
        }
      }
    }
    return val;
  }

  syncGlobalPrompt(val) {
    if (this.node.properties) {
      this.node.properties.global_prompt = val;
    }
    if (this.retakeMode) {
      this.timeline.retake_global_prompt = val;
    } else {
      this.timeline.global_prompt = val;
    }
    const globalInput = this.node.inputs?.find(i => i.name === "global_prompt");
    let synced = false;
    if (globalInput && globalInput.link !== null && globalInput.link !== undefined) {
      const link = window.app.graph?.links?.[globalInput.link];
      if (link) {
        const originNode = window.app.graph.getNodeById(link.origin_id);
        if (originNode && originNode.widgets && originNode.widgets.length > 0) {
          const w = originNode.widgets[0];
          const oldVal = w.value;
          w.value = val;
          if (originNode.onWidgetChanged) {
            originNode.onWidgetChanged(w.name, val, oldVal, w);
          }
          if (w.callback) {
            try {
              originNode.widgets[0].callback(val);
            } catch (err) { }
          }
          synced = true;
        }
      }
    }
    if (!synced) {
      const w = this.node.widgets?.find(x => x.name === "global_prompt");
      if (w) {
        const oldVal = w.value;
        w.value = val;
        if (this.node.onWidgetChanged) {
          this.node.onWidgetChanged(w.name, val, oldVal, w);
        }
        if (w.callback) {
          try {
            w.callback(val);
          } catch (err) { }
        }
      }
    }
    if (this.globalPromptInput && this.globalPromptInput.value !== val) {
      this.globalPromptInput.value = val;
    }
    if (this.node) {
      this.node.setDirtyCanvas(true, false);
    }
    if (window.app?.graph) {
      if (window.app.graph.change) window.app.graph.change();
      if (window.app.graph.onNodeChanged) window.app.graph.onNodeChanged(this.node);
      if (window.app.graph.onStateChanged) window.app.graph.onStateChanged();
    }
  }

  updateUIFromSelection() {
    if (this.selectedSegmentIds && this.isMultiSelectActive()) {
      if (this.globalPromptInput) {
        this.globalPromptInput.disabled = true;
        this.globalPromptInput.style.opacity = "0.35";
      }
      if (this.promptWrapper) this.promptWrapper.style.display = "block";
      if (this.promptInput) {
        this.promptInput.value = "";
        this.promptInput.placeholder = "（已选多个片段）";
        this.promptInput.disabled = true;
        this.promptInput.style.opacity = "0.35";
      }

      if (this.segmentPromptLabel) {
        this.segmentPromptLabel.style.display = "block";
        this.segmentPromptLabel.textContent = "分段提示词";
      }

      if (this.strengthRow) this.strengthRow.style.display = "flex";
      if (this.strengthLabel) this.strengthLabel.style.display = "inline";
      if (this.strengthValue) {
        this.strengthValue.style.display = "inline-block";
        this.strengthValue.value = "";
        this.strengthValue.placeholder = "（多项）";
        this.strengthValue.disabled = true;
        this.strengthValue.style.opacity = "0.35";
      }

      if (this.vidStrLabel) this.vidStrLabel.style.display = "none";
      if (this.vidStrValue) {
        this.vidStrValue.style.display = "none";
        this.vidStrValue.disabled = true;
        this.vidStrValue.style.opacity = "0.35";
      }
      if (this.vidAttnLabel) this.vidAttnLabel.style.display = "none";
      if (this.vidAttnValue) {
        this.vidAttnValue.style.display = "none";
        this.vidAttnValue.disabled = true;
        this.vidAttnValue.style.opacity = "0.35";
      }

      if (this.audioInfoArea) this.audioInfoArea.style.display = "none";
      if (this.motionInfoArea) this.motionInfoArea.style.display = "none";
      if (this.durationValue) {
        this.durationValue.value = "";
        this.durationValue.disabled = true;
        this.durationValue.style.opacity = "0.35";
      }
      if (this.cropCutBtn) this.cropCutBtn.style.display = "none";

      if (this.segmentBoundsDisplay) {
        this.segmentBoundsDisplay.textContent = "已选多个片段";
      }
      return;
    }

    let seg = null;
    if (this.selectedIndex >= 0) {
      if (this.selectionType === "audio") {
        const origSeg = this.timeline.audioSegments[this.selectedIndex];
        if (origSeg) {
          const previewIsAudio = this._ghostTrack === 'audio' || (this._previewSegments && this._ghostTrack === null && this.selectionType === 'audio');
          const arr = (this._previewSegments && previewIsAudio) ? this._previewSegments : this.timeline.audioSegments;
          seg = arr.find(s => s.id === origSeg.id) || origSeg;
        }
      } else if (this.selectionType === "motion") {
        const origSeg = this.timeline.motionSegments[this.selectedIndex];
        if (origSeg) {
          const previewIsMotion = this._ghostTrack === 'motion' || (this._previewSegments && this._ghostTrack === null && this.selectionType === 'motion');
          const arr = (this._previewSegments && previewIsMotion) ? this._previewSegments : this.timeline.motionSegments;
          seg = arr.find(s => s.id === origSeg.id) || origSeg;
        }
      } else {
        const origSeg = this.timeline.segments[this.selectedIndex];
        if (origSeg) {
          const previewIsImage = this._ghostTrack === 'image' || (this._previewSegments && this._ghostTrack === null && this.selectionType === 'image');
          const arr = (this._previewSegments && previewIsImage) ? this._previewSegments : this.timeline.segments;
          seg = arr.find(s => s.id === origSeg.id) || origSeg;
        }
      }
    }

    // Reset default disabled/opacity values
    if (this.vidStrValue) {
      this.vidStrValue.disabled = false;
      this.vidStrValue.style.opacity = "";
    }
    if (this.vidAttnValue) {
      this.vidAttnValue.disabled = false;
      this.vidAttnValue.style.opacity = "";
    }
    if (this.strengthValue) {
      this.strengthValue.style.opacity = "";
      this.strengthValue.placeholder = "";
    }
    if (this.promptInput) {
      this.promptInput.placeholder = "";
      this.promptInput.style.opacity = "";
    }
    if (this.durationValue) {
      this.durationValue.disabled = false;
      this.durationValue.style.opacity = "";
    }
    if (this.cropCutBtn) {
      const canShowCut = !!seg && !this.retakeMode;
      this.cropCutBtn.style.display = canShowCut ? "inline-flex" : "none";
      this.cropCutBtn.disabled = false;
      this.cropCutBtn.style.opacity = "";
    }

    if (this.retakeMode) {
      if (this.promptWrapper) this.promptWrapper.style.display = "block";
      this.promptInput.disabled = false;
      this.promptInput.style.opacity = "1.0";
      this.promptInput.placeholder = "输入重拍区域提示词...";
      this.promptInput.value = this.timeline.retakePrompt || "";

      this.strengthRow.style.display = "flex";
      this.strengthLabel.style.display = "inline";
      this.strengthLabel.textContent = "引导强度:";
      this.strengthValue.style.display = "inline-block";
      this.strengthValue.disabled = true;
      this.strengthValue.style.opacity = "0.35";
      this.strengthValue.value = (this.timeline.retakeStrength ?? 1.0).toFixed(2);

      this.vidStrLabel.style.display = "none";
      this.vidStrValue.style.display = "none";
      this.vidAttnLabel.style.display = "none";
      this.vidAttnValue.style.display = "none";

      this.audioInfoArea.style.display = "none";
      this.motionInfoArea.style.display = "none";
      if (this.durationValue) this.durationValue.value = (this.timeline.retakeLength / this.getFrameRate()).toFixed(2);

      if (this.segmentBoundsDisplay) {
        const startStr = this.formatTime(this.timeline.retakeStart, true);
        const endStr = this.formatTime(this.timeline.retakeStart + this.timeline.retakeLength, true);
        const lengthStr = this.formatTime(this.timeline.retakeLength, true);
        this.segmentBoundsDisplay.textContent = `开始: ${startStr} | 结束: ${endStr} | 长度: ${lengthStr}`;
      }
    } else if (this.selectionType === "audio" && seg) {
      if (this.globalPromptInput) {
        this.globalPromptInput.disabled = false;
        this.globalPromptInput.style.opacity = "1.0";
      }
      if (this.promptWrapper) this.promptWrapper.style.display = "none";
      this.strengthRow.style.display = "flex";
      this.strengthLabel.style.display = "inline";
      this.strengthLabel.textContent = "引导强度:";
      this.strengthValue.style.display = "inline-block";
      this.vidStrLabel.style.display = "none";
      this.vidStrValue.style.display = "none";
      this.vidAttnLabel.style.display = "none";
      this.vidAttnValue.style.display = "none";
      this.audioInfoArea.style.display = "block";
      this.motionInfoArea.style.display = "none";
      this.audioInfoArea.innerHTML = `
        File: <span>${seg.fileName || "Unknown"}</span><br>
        Length: <span>${this.formatTime(seg.audioDurationFrames)}</span> Output Length: <span>${this.formatTime(seg.length)}</span><br>
        Trim-in: <span>${this.formatTime(Math.round(seg.trimStart))}</span> Trim-Out: <span>${this.formatTime(Math.round(seg.audioDurationFrames - (seg.trimStart + seg.length)))}</span>
      `;
      this.strengthValue.value = "1.00";
      this.strengthValue.disabled = true;
      if (this.durationValue) this.durationValue.value = (seg.length / this.getFrameRate()).toFixed(2);
    } else if (this.selectionType === "motion" && seg) {
      if (this.globalPromptInput) {
        this.globalPromptInput.disabled = true;
        this.globalPromptInput.style.opacity = "0.4";
      }
      if (this.promptWrapper) this.promptWrapper.style.display = "block";
      this.promptInput.disabled = false;
      this.promptInput.style.opacity = "1.0";
      this.promptInput.placeholder = "全局提示词（同步到所有参考视频段）...";
      this.promptInput.value = this.getGlobalPrompt();
      if (this.segmentPromptLabel) {
        this.segmentPromptLabel.style.display = "block";
        this.segmentPromptLabel.textContent = "全局提示词（参考视频）";
      }

      this.strengthRow.style.display = "flex";
      this.strengthLabel.style.display = "none";
      this.strengthValue.style.display = "none";
      this.vidStrLabel.style.display = "inline";
      this.vidStrValue.style.display = "inline-block";
      this.vidAttnLabel.style.display = "inline";
      this.vidAttnValue.style.display = "inline-block";

      this.vidStrValue.value = (seg.videoStrength ?? 1.0).toFixed(2);
      this.vidAttnValue.value = (seg.videoAttentionStrength ?? 0.65).toFixed(2);
      if (this.durationValue) this.durationValue.value = (seg.length / this.getFrameRate()).toFixed(2);

      this.audioInfoArea.style.display = "none";
      this.motionInfoArea.style.display = "none";
    } else {
      if (this.segmentPromptLabel) {
        this.segmentPromptLabel.style.display = "block";
        this.segmentPromptLabel.textContent = "分段提示词";
      }
      if (this.globalPromptInput) {
        this.globalPromptInput.disabled = false;
        this.globalPromptInput.style.opacity = "1.0";
      }
      this.audioInfoArea.style.display = "none";
      this.motionInfoArea.style.display = "none";
      if (this.promptWrapper) this.promptWrapper.style.display = "block";
      this.strengthRow.style.display = "flex";
      this.strengthLabel.style.display = "inline";
      this.strengthLabel.textContent = "引导强度:";
      this.strengthValue.style.display = "inline-block";
      this.vidStrLabel.style.display = "none";
      this.vidStrValue.style.display = "none";
      this.vidAttnLabel.style.display = "none";
      this.vidAttnValue.style.display = "none";
      if (seg) {
        if (this.selectionType !== "motion") {
          this.promptInput.value = seg.prompt || "";
          this.promptInput.placeholder = "输入选中片段的提示词...";
        }
        this.promptInput.disabled = false;
        this.promptInput.style.opacity = "1.0";

        const isImage = (this.selectionType === "image") && (seg.type === "image" || seg.type === "video");
        const strength = isImage ? (seg.guideStrength ?? 1.0) : 1.0;
        this.strengthValue.value = strength.toFixed(2);
        this.strengthValue.disabled = !isImage;
        this.strengthValue.style.opacity = isImage ? "1.0" : "0.35";
        if (this.durationValue) this.durationValue.value = (seg.length / this.getFrameRate()).toFixed(2);
      } else {
        this.promptInput.value = "";
        this.promptInput.placeholder = "未选中片段";
        this.promptInput.disabled = true;
        this.promptInput.style.opacity = "0.4";
        this.strengthValue.value = "1.00";
        this.strengthValue.disabled = true;
        this.strengthValue.style.opacity = "0.35";
        if (this.durationValue) {
          this.durationValue.value = "";
          this.durationValue.disabled = true;
          this.durationValue.style.opacity = "0.35";
        }
        if (this.cropCutBtn) this.cropCutBtn.style.display = "none";
      }
    }

    if (this.segmentBoundsDisplay && !this.retakeMode) {
      if (seg) {
        const startStr = this.formatTime(seg.start, true);
        const endStr = this.formatTime(seg.start + seg.length, true);
        const lengthStr = this.formatTime(seg.length, true);
        this.segmentBoundsDisplay.textContent = `开始: ${startStr} | 结束: ${endStr} | 长度: ${lengthStr}`;
      } else {
        this.segmentBoundsDisplay.textContent = "开始: - | 结束: - | 长度: -";
      }
    }
  }


  updateRetakeUIState() {
    // 重拍模式已移除：固定为普通主轨模式
    this.retakeMode = false;
    if (this.timeline) this.timeline.retakeMode = false;

    if (this.globalPromptInput) {
      const p = this.timeline.global_prompt || "";
      if (this.globalPromptInput.value !== p) {
        this.globalPromptInput.value = p;
        this.syncGlobalPrompt(p);
      }
    }

    this.blockHeight = this._oldBlockHeight ?? BLOCK_HEIGHT;
    // H3 多参：保留三轨布局，不要清零音频/参考视频高度
    const keepH3Multi =
      this.isH3Director &&
      (this.h3WorkspaceMode === "多参" ||
        this.node?.widgets?.find((w) => w.name === "workspace_mode")?.value === "多参" ||
        this.node?.properties?.workspace_mode === "多参");
    if (keepH3Multi) {
      this.applyH3TrackLayout(true);
      this.updateUIFromSelection();
      return;
    }

    this.refTrackHeight = 0;
    this.audioTrackHeight = 0;
    this.motionTrackHeight = 0;
    if (this.uploadVideoBtn) {
      this.uploadVideoBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg> 添加视频`;
    }
    if (this.mainTrackLabel) {
      const textSpan = this.mainTrackLabel.querySelector("span");
      if (textSpan) textSpan.textContent = "主轨";
      if (this.mainTrackLabel._eyeBtn) this.mainTrackLabel._eyeBtn.style.display = "inline-flex";
      this.mainTrackLabel.style.backgroundColor = "#1e1e1e";
    }
    if (this.refTrackLabel) {
      this.refTrackLabel.style.display = "none";
      this.refTrackLabel.style.height = "0px";
    }
    if (this.audioTrackLabel) this.audioTrackLabel.style.display = "none";
    if (this.motionTrackLabel) this.motionTrackLabel.style.display = "none";
    if (this.sidebar) this.sidebar.style.backgroundColor = "#1e1e1e";
    if (this.rulerSpacer) this.rulerSpacer.style.backgroundColor = "#1e1e1e";

    this.canvasHeight =
      RULER_HEIGHT + this.blockHeight + this.audioTrackHeight + this.motionTrackHeight;
    if (this.canvas) this.canvas.style.height = `${this.canvasHeight}px`;
    if (this.viewport) {
      this.viewport.style.height = `${this.canvasHeight}px`;
      this.viewport.style.minHeight = `${this.canvasHeight}px`;
    }
    this.updateSidebarHeights();

    if (this.uploadBtn) this.uploadBtn.style.display = "";
    if (this.addTextBtn) this.addTextBtn.style.display = "";
    if (this.uploadAudioBtn) this.uploadAudioBtn.style.display = "none";
    if (this.uploadMotionBtn) this.uploadMotionBtn.style.display = "none";
    if (this.deleteBtn) this.deleteBtn.style.display = "";
    if (this.deleteRetakeBtn) this.deleteRetakeBtn.style.display = "none";

    if (this.segmentPromptLabel) {
      this.segmentPromptLabel.textContent = "分段提示词";
    }

    this.updateUIFromSelection();
  }

  updateSidebarHeights() {
    if (this.refTrackLabel) {
      const rh = this.refTrackHeight || 0;
      this.refTrackLabel.style.height = `${rh}px`;
      this.refTrackLabel.style.display = rh > 0 ? "flex" : "none";
    }
    if (this.mainTrackLabel) {
      this.mainTrackLabel.style.height = `${this.blockHeight}px`;
    }
    if (this.refAudioTrackLabel) {
      const rah = this.refAudioTrackHeight || 0;
      this.refAudioTrackLabel.style.height = `${rah}px`;
      this.refAudioTrackLabel.style.display = rah > 0 ? "flex" : "none";
    }
    if (this.audioTrackLabel) {
      this.audioTrackLabel.style.height = `${this.audioTrackHeight}px`;
    }
    if (this.motionTrackLabel) {
      this.motionTrackLabel.style.height = `${this.motionTrackHeight}px`;
    }
  }

  // --- Rendering logic ---
  render() {
    if (!this.canvas) return;
    const width = this.canvas.offsetWidth || this._lastWidth;
    const height = this.canvasHeight;
    const totalFrames = this.getVisualDurationFrames();

    if (!width || width <= 0) return;

    this.ctx.clearRect(0, 0, width, height);

    // Lazy load active video/motion segments
    const targetFrame = this.currentFrame;
    if (this.retakeMode && this.timeline.retakeVideo) {
      this._ensureVideoEl(this.timeline.retakeVideo);
    } else {
      const activeSeg = this.timeline.segments.find(s => s.type === "video" && targetFrame >= s.start && targetFrame < s.start + s.length);
      if (activeSeg) this._ensureVideoEl(activeSeg);

      if (this.timeline.motionSegments) {
        const activeMotionSeg = this.timeline.motionSegments.find(s => s.type === "motion_video" && targetFrame >= s.start && targetFrame < s.start + s.length);
        if (activeMotionSeg) this._ensureVideoEl(activeMotionSeg);
      }
    }

    if (this.selectedIndex !== -1) {
      const selSeg = this.getSegmentArray(this.selectionType)[this.selectedIndex];
      if (selSeg && (selSeg.type === "video" || selSeg.type === "motion_video")) {
        this._ensureVideoEl(selSeg);
      }
    }

    if (this._isDragging && this._dragTargetId) {
      const dragSeg = this.timeline.segments.find(s => s.id === this._dragTargetId) ||
        (this.timeline.motionSegments && this.timeline.motionSegments.find(s => s.id === this._dragTargetId));
      if (dragSeg && (dragSeg.type === "video" || dragSeg.type === "motion_video")) {
        this._ensureVideoEl(dragSeg);
      }
    }

    // 多参图轨：黑底 + 缩略图（与下边三轨同风格）
    const refH = this.getRefTrackHeight();
    if (refH > 0) {
      this.drawH3RefTrack(width);
    }
    // 主轨/音频/参考视频 在多参时整体下移 refH
    this.ctx.save();
    if (refH > 0) this.ctx.translate(0, refH);

    // Render Track Backgrounds
    this.ctx.fillStyle = "#121212"; // Image track bg
    this.ctx.fillRect(0, RULER_HEIGHT, width, this.blockHeight);

    this.ctx.fillStyle = "#141414"; // Audio track bg
    this.ctx.fillRect(0, RULER_HEIGHT + this.blockHeight, width, this.audioTrackHeight);

    this.ctx.fillStyle = "#121212"; // Motion track bg
    this.ctx.fillRect(0, RULER_HEIGHT + this.blockHeight + this.audioTrackHeight, width, this.motionTrackHeight);



    // Determine which track the preview belongs to.
    // _ghostTrack is set during HTML file drag-and-drop.
    // During canvas mouse drags, _ghostTrack is null, so fall back to selectionType.
    const previewIsAudio = this._ghostTrack === 'audio' ||
      (this._previewSegments && this._ghostTrack === null && this.selectionType === 'audio');
    const previewIsMotion = this._ghostTrack === 'motion' ||
      (this._previewSegments && this._ghostTrack === null && this.selectionType === 'motion');
    const previewIsImage = !previewIsAudio && !previewIsMotion;

    let renderSegments = this.timeline.segments;
    let renderAudioSegments = this.timeline.audioSegments;
    let renderMotionSegments = this.timeline.motionSegments;

    if (this._isDragging && this._multiDragPreviewTimelines) {
      if (this._multiDragPreviewTimelines.image) renderSegments = this._multiDragPreviewTimelines.image;
      if (this._multiDragPreviewTimelines.motion) renderMotionSegments = this._multiDragPreviewTimelines.motion;
      if (this._multiDragPreviewTimelines.audio) renderAudioSegments = this._multiDragPreviewTimelines.audio;
    } else {
      const previewIsAudio = this._ghostTrack === 'audio' ||
        (this._previewSegments && this._ghostTrack === null && this.selectionType === 'audio');
      const previewIsMotion = this._ghostTrack === 'motion' ||
        (this._previewSegments && this._ghostTrack === null && this.selectionType === 'motion');
      const previewIsImage = !previewIsAudio && !previewIsMotion;

      if (this._previewSegments && previewIsImage) renderSegments = this._previewSegments;
      else if (this._previewSiblingSegments && previewIsAudio) renderSegments = this._previewSiblingSegments;

      if (this._previewSegments && previewIsAudio) renderAudioSegments = this._previewSegments;
      else if (this._previewSiblingSegments && previewIsImage) renderAudioSegments = this._previewSiblingSegments;

      if (this._previewSegments && previewIsMotion) renderMotionSegments = this._previewSegments;
    }

    const sortedSegments = [...renderSegments].sort((a, b) => {
      const aSel = this.selectedSegmentIds.includes(a.id) ? 1 : 0;
      const bSel = this.selectedSegmentIds.includes(b.id) ? 1 : 0;
      return aSel - bSel;
    });

    const sortedMotionSegments = [...renderMotionSegments].sort((a, b) => {
      const aSel = this.selectedSegmentIds.includes(a.id) ? 1 : 0;
      const bSel = this.selectedSegmentIds.includes(b.id) ? 1 : 0;
      return aSel - bSel;
    });

    const sortedAudioSegments = [...renderAudioSegments].sort((a, b) => {
      const aSel = this.selectedSegmentIds.includes(a.id) ? 1 : 0;
      const bSel = this.selectedSegmentIds.includes(b.id) ? 1 : 0;
      return aSel - bSel;
    });

    if (this.retakeMode) {
      // Draw Retake Mode Filmstrip and Overlay
      const retakeVid = this.timeline.retakeVideo;
      const frameRate = this.getFrameRate();
      if (retakeVid) {
        const showLivePreview = this.isPlaying || (this._isDragging && (this._dragType === "playhead" || this._dragType === "retake_left" || this._dragType === "retake_right" || this._dragType === "retake_center"));

        // Calculate the actual visual width of the base video block
        const baseVideoDur = retakeVid.videoDurationFrames || 0;
        const videoWidthPx = totalFrames > 0 ? (baseVideoDur / totalFrames) * width : width;

        if (showLivePreview) {
          let targetTime = this.currentFrame / frameRate;
          if (this._isDragging) {
            if (this._dragType === "retake_left") {
              targetTime = (this.timeline.retakeStart ?? 0) / frameRate;
            } else if (this._dragType === "retake_right") {
              targetTime = ((this.timeline.retakeStart ?? 0) + (this.timeline.retakeLength ?? baseVideoDur)) / frameRate;
            } else if (this._dragType === "retake_center") {
              targetTime = (this.timeline.retakeStart ?? 0) / frameRate;
            }
          }

          let drawSource = null;
          const useLiveVideo = this.isPlaying || (this._isDragging ? this._dragType !== "playhead" : true);
          if (useLiveVideo && retakeVid.videoEl && retakeVid.videoEl.readyState >= 2 && !retakeVid.videoEl.seeking) {
            drawSource = retakeVid.videoEl;
          } else if (retakeVid.thumbnails && retakeVid.thumbnails.length > 0) {
            let nearestImg = retakeVid.thumbnails[0].img;
            let minDiff = Infinity;
            for (const t of retakeVid.thumbnails) {
              const diff = Math.abs(t.time - targetTime);
              if (diff < minDiff) {
                minDiff = diff;
                nearestImg = t.img;
              }
            }
            drawSource = nearestImg;
          } else {
            drawSource = retakeVid.videoEl || (retakeVid.imgObj && retakeVid.imgObj.complete ? retakeVid.imgObj : null);
          }

          this.ctx.fillStyle = "#000";
          this.ctx.fillRect(0, RULER_HEIGHT + 1, videoWidthPx, this.blockHeight - 2);

          if (drawSource) {
            const isVid = !!drawSource.videoWidth;
            const natW = isVid ? drawSource.videoWidth : drawSource.naturalWidth;
            const natH = isVid ? drawSource.videoHeight : drawSource.naturalHeight;

            if (natW > 0) {
              const imgRatio = natW / natH;
              const trackRatio = videoWidthPx / this.blockHeight;
              let drawW, drawH, drawX, drawY;

              if (imgRatio > trackRatio) {
                drawW = videoWidthPx;
                drawH = videoWidthPx / imgRatio;
                drawX = 0;
                drawY = RULER_HEIGHT + (this.blockHeight - drawH) / 2;

                this.ctx.save();
                this.ctx.beginPath();
                this.ctx.rect(0, RULER_HEIGHT + 1, videoWidthPx, this.blockHeight - 2);
                this.ctx.clip();
                this.ctx.drawImage(drawSource, drawX, drawY, drawW, drawH);
                this.ctx.restore();
              } else {
                drawH = this.blockHeight;
                drawW = this.blockHeight * imgRatio;
                drawY = RULER_HEIGHT;
                drawX = (videoWidthPx - drawW) / 2;

                this.ctx.save();
                this.ctx.beginPath();
                this.ctx.rect(0, RULER_HEIGHT + 1, videoWidthPx, this.blockHeight - 2);
                this.ctx.clip();

                // Draw centered preview frame
                this.ctx.drawImage(drawSource, drawX, drawY, drawW, drawH);

                // Tile to the left
                let leftX = drawX - drawW;
                while (leftX + drawW > 0) {
                  this.ctx.drawImage(drawSource, leftX, drawY, drawW, drawH);
                  leftX -= drawW;
                }

                // Tile to the right
                let rightX = drawX + drawW;
                while (rightX < videoWidthPx) {
                  this.ctx.drawImage(drawSource, rightX, drawY, drawW, drawH);
                  rightX += drawW;
                }

                this.ctx.restore();
              }
            }
          }
        } else {
          // Static state: pick the midpoint thumbnail and tile it at its natural aspect ratio,
          // matching the visual appearance of the live-preview path.
          const durationSecs = baseVideoDur / frameRate;
          const midTime = durationSecs / 2;

          let drawSource = null;
          if (retakeVid.thumbnails && retakeVid.thumbnails.length > 0) {
            let nearestImg = retakeVid.thumbnails[0].img;
            let minDiff = Infinity;
            for (const t of retakeVid.thumbnails) {
              const diff = Math.abs(t.time - midTime);
              if (diff < minDiff) {
                minDiff = diff;
                nearestImg = t.img;
              }
            }
            drawSource = nearestImg;
          } else {
            drawSource = retakeVid.imgObj && retakeVid.imgObj.complete ? retakeVid.imgObj : null;
          }

          this.ctx.fillStyle = "#000";
          this.ctx.fillRect(0, RULER_HEIGHT + 1, videoWidthPx, this.blockHeight - 2);

          if (drawSource) {
            const isVid = !!drawSource.videoWidth;
            const natW = isVid ? drawSource.videoWidth : drawSource.naturalWidth;
            const natH = isVid ? drawSource.videoHeight : drawSource.naturalHeight;

            if (natW > 0) {
              const imgRatio = natW / natH;
              const trackRatio = videoWidthPx / this.blockHeight;

              this.ctx.save();
              this.ctx.beginPath();
              this.ctx.rect(0, RULER_HEIGHT + 1, videoWidthPx, this.blockHeight - 2);
              this.ctx.clip();

              if (imgRatio > trackRatio) {
                // Video is wider than the track: fill width, letterbox top/bottom
                const drawW = videoWidthPx;
                const drawH = videoWidthPx / imgRatio;
                const drawY = RULER_HEIGHT + (this.blockHeight - drawH) / 2;
                this.ctx.drawImage(drawSource, 0, drawY, drawW, drawH);
              } else {
                // Video is taller/square: fill height and tile left+right at natural AR
                const drawH = this.blockHeight;
                const drawW = drawH * imgRatio;
                const drawX = (videoWidthPx - drawW) / 2;
                const drawY = RULER_HEIGHT;
                // Draw centered tile
                this.ctx.drawImage(drawSource, drawX, drawY, drawW, drawH);
                // Tile to the left
                let leftX = drawX - drawW;
                while (leftX + drawW > 0) {
                  this.ctx.drawImage(drawSource, leftX, drawY, drawW, drawH);
                  leftX -= drawW;
                }
                // Tile to the right
                let rightX = drawX + drawW;
                while (rightX < videoWidthPx) {
                  this.ctx.drawImage(drawSource, rightX, drawY, drawW, drawH);
                  rightX += drawW;
                }
              }

              this.ctx.restore();
            }
          }
        }


        if (retakeVid._uploading || retakeVid._extractingThumbs) {
          this.ctx.save();
          this.ctx.fillStyle = "rgba(0, 14, 37, 0.8)";
          const upText = retakeVid._extractingThumbs ? "Extracting frames..." : "Uploading base video...";
          this.ctx.font = "bold 11px sans-serif";
          const upW = this.ctx.measureText(upText).width + 20;
          this.ctx.fillRect(10, RULER_HEIGHT + 35, upW, 24);
          this.ctx.fillStyle = "#fff";
          this.ctx.textBaseline = "middle";
          this.ctx.textAlign = "center";
          this.ctx.fillText(upText, 10 + upW / 2, RULER_HEIGHT + 47);
          this.ctx.restore();
        }

      } else {
        // No video loaded: Render a placeholder box with upload instructions centered on active timeline
        this.ctx.fillStyle = "#121212";
        this.ctx.fillRect(0, RULER_HEIGHT + 1, width, this.blockHeight - 2);

        // In retake mode, center the placeholder across the visible viewport
        const activeStart = this.viewport ? this.viewport.scrollLeft : 0;
        let activeWidth = this.viewport ? this.viewport.clientWidth : width;
        // The right ~9% of the DOM is clipped, so squish the box to visually center it in the unclipped area
        activeWidth = activeWidth * 0.91;

        this.ctx.strokeStyle = "#555";
        this.ctx.lineWidth = 2;
        this.ctx.setLineDash([6, 6]);
        this.ctx.strokeRect(activeStart + 12, RULER_HEIGHT + 12, Math.max(10, activeWidth - 24), this.blockHeight - 24);
        this.ctx.setLineDash([]);

        this.ctx.fillStyle = "#888";
        this.ctx.textAlign = "center";
        this.ctx.textBaseline = "middle";
        this.ctx.font = "14px sans-serif";
        this.ctx.fillText("Drag & Drop or Click to Add a Video", activeStart + activeWidth / 2, RULER_HEIGHT + this.blockHeight / 2);
      }

      // Only draw the retake region overlay, borders, handles, and label if a video is loaded
      if (this.timeline.retakeVideo) {
        // Draw the white outline retake region overlay box bounded by retakeStart and retakeLength.
        // Tint outside the box (locked/preserved regions) with a dark blue-grey tint overlay (rgba(3, 5, 12, 0.75)).
        const retakeStart = this.timeline.retakeStart ?? 0;
        const retakeLength = this.timeline.retakeLength ?? totalFrames;

        const baseVideoDur = this.timeline.retakeVideo.videoDurationFrames || 0;
        const videoWidthPx = totalFrames > 0 ? (baseVideoDur / totalFrames) * width : width;

        const rX1 = (retakeStart / totalFrames) * width;
        const rX2 = ((retakeStart + retakeLength) / totalFrames) * width;

        // Tint preserved left region
        if (rX1 > 0) {
          this.ctx.fillStyle = "rgba(0, 0, 0, 0.70)";
          this.ctx.fillRect(0, RULER_HEIGHT + 1, rX1, this.blockHeight - 2);
        }

        // Tint preserved right region (only up to videoWidthPx, not the padding zone)
        if (rX2 < videoWidthPx) {
          this.ctx.fillStyle = "rgba(0, 0, 0, 0.70)";
          this.ctx.fillRect(rX2, RULER_HEIGHT + 1, videoWidthPx - rX2, this.blockHeight - 2);
        }

        // Draw the Retake Overlay Box
        const boxW = rX2 - rX1;

        // White border
        this.ctx.strokeStyle = "#ffffff";
        this.ctx.lineWidth = 2.5;
        this.ctx.strokeRect(rX1, RULER_HEIGHT + 1, boxW, this.blockHeight - 2);

        // Draw handles on the left and right edges
        this.ctx.fillStyle = "#ffffff";
        this.ctx.beginPath();
        this.ctx.roundRect(rX1 - 3, RULER_HEIGHT + this.blockHeight / 2 - 20, 6, 40, 3);
        this.ctx.fill();

        this.ctx.beginPath();
        this.ctx.roundRect(rX2 - 3, RULER_HEIGHT + this.blockHeight / 2 - 20, 6, 40, 3);
        this.ctx.fill();

        // Draw "RETAKE REGION" centered label inside the retake box
        {
          const labelPadX = 14;
          const labelPadY = 7;
          const labelFontSize = 15;
          const labelText = "RETAKE REGION";
          const labelY = RULER_HEIGHT + this.blockHeight - labelFontSize - labelPadY * 2 - 4;
          const labelCenterX = rX1 + boxW / 2;

          this.ctx.save();
          // Clip to retake region so text/bg never bleeds outside
          this.ctx.beginPath();
          this.ctx.rect(rX1, RULER_HEIGHT, boxW, this.blockHeight);
          this.ctx.clip();

          this.ctx.font = `bold ${labelFontSize}px sans-serif`;
          this.ctx.textAlign = "center";
          this.ctx.textBaseline = "middle";

          // Truncate if too narrow
          let displayText = labelText;
          const maxTextW = Math.max(0, boxW - labelPadX * 2 - 8);
          if (this.ctx.measureText(displayText).width > maxTextW) {
            while (displayText.length > 0 && this.ctx.measureText(displayText + "…").width > maxTextW) {
              displayText = displayText.slice(0, -1);
            }
            displayText = displayText.length > 0 ? displayText + "…" : "";
          }

          if (displayText.length > 0) {
            const textW = this.ctx.measureText(displayText).width;
            const bgW = textW + labelPadX * 2;
            const bgH = labelFontSize + labelPadY * 2;
            const bgX = labelCenterX - bgW / 2;
            const bgY = labelY - bgH / 2;

            // Background pill
            this.ctx.fillStyle = "rgba(0, 0, 0, 0.62)";
            this.ctx.beginPath();
            this.ctx.roundRect(bgX, bgY, bgW, bgH, 3);
            this.ctx.fill();

            // Label text
            this.ctx.fillStyle = "#ffffff";
            this.ctx.fillText(displayText, labelCenterX, labelY);
          }
          this.ctx.restore();
        }

        // Show video info badge / filename (styled exactly like a regular video segment, drawn on top of overlays)
        this.ctx.save();
        this.ctx.beginPath();
        this.ctx.rect(0, RULER_HEIGHT, videoWidthPx, this.blockHeight);
        this.ctx.clip();

        // 1. Draw the "VIDEO" label badge
        this.ctx.fillStyle = "rgba(0, 0, 0, 0.60)";
        this.ctx.fillRect(0, RULER_HEIGHT + 1, 42, 16);
        this.ctx.fillStyle = "#fff";
        this.ctx.font = "bold 10px sans-serif";
        this.ctx.textAlign = "center";
        this.ctx.textBaseline = "middle";
        this.ctx.fillText("视频", 21, RULER_HEIGHT + 9);

        // 2. Draw the filename badge
        if (this.node.properties.showFilenames && videoWidthPx > 46) {
          let rawPath = retakeVid.imageFile || retakeVid.fileName || "";
          let fname = rawPath.split(/[/\\]/).pop() || "";
          this.ctx.font = "9px sans-serif";
          this.ctx.textAlign = "left";
          this.ctx.textBaseline = "middle";
          const maxFileTextW = videoWidthPx - 42 - 10;
          if (this.ctx.measureText(fname).width > maxFileTextW) {
            while (fname.length > 0 && this.ctx.measureText(fname + "…").width > maxFileTextW) {
              fname = fname.slice(0, -1);
            }
            fname += "…";
          }
          const textW = this.ctx.measureText(fname).width;
          this.ctx.fillStyle = "rgba(0, 0, 0, 0.50)";
          this.ctx.fillRect(43, RULER_HEIGHT + 1, textW + 8, 16);
          this.ctx.fillStyle = "#fff";
          this.ctx.fillText(fname, 47, RULER_HEIGHT + 9);
        }
        this.ctx.restore();

      }
    } else {
      // 主轨文字段：从左到右 1、2、3…，移动或删除后按当前位置重排
      const h3PromptNo = new Map();
      if (this.isH3Director) {
        const textSegs = [...renderSegments]
          .filter((s) => s && s.type === "text")
          .sort((a, b) => (a.start - b.start) || String(a.id).localeCompare(String(b.id)));
        textSegs.forEach((s, idx) => h3PromptNo.set(s.id, idx + 1));
      }
      // --- Draw Image/Text Segments ---
      for (let i = 0; i < sortedSegments.length; i++) {
        const seg = sortedSegments[i];
        const rawStartX = (seg.start / totalFrames) * width;
        const rawEndX = ((seg.start + seg.length) / totalFrames) * width;
        const startX = Math.floor(rawStartX);
        const pxWidth = Math.max(1, Math.floor(rawEndX) - startX);
        const isSelected = this.selectedSegmentIds.includes(seg.id);

        const originalSeg = this.timeline.segments.find(s => s.id === seg.id);
        const imgObj = originalSeg ? originalSeg.imgObj : seg.imgObj;
        const videoEl = originalSeg ? originalSeg.videoEl : seg.videoEl;

        const isPlayheadOverSeg = (this.currentFrame >= seg.start && this.currentFrame < seg.start + seg.length);
        const isScrubbingThis = this._isDragging && (this._dragTargetId === seg.id || this._dragTargetIdRight === seg.id);
        const isLiveActive = this.isPlaying && isPlayheadOverSeg;

        if ((this._isDragging && this.selectionType === "image" && seg.id === this._dragTargetId) || (this._ghostSegmentId && seg.id === this._ghostSegmentId)) {
          this.ctx.globalAlpha = 0.65;
        } else {
          this.ctx.globalAlpha = 1.0;
        }

        if (seg.type === "ghost") {
          this.ctx.fillStyle = "#2a2a2a";
          this.ctx.fillRect(startX, RULER_HEIGHT, pxWidth, this.blockHeight);

          this.ctx.strokeStyle = "#777";
          this.ctx.lineWidth = 2;
          this.ctx.setLineDash([5, 5]);
          this.ctx.strokeRect(startX, RULER_HEIGHT + 1, pxWidth, this.blockHeight - 2);
          this.ctx.setLineDash([]);

          this.ctx.fillStyle = "#aaa";
          this.ctx.textAlign = "center";
          this.ctx.textBaseline = "middle";
          this.ctx.font = "bold 12px sans-serif";
          this.ctx.fillText("Drop to Place", startX + pxWidth / 2, RULER_HEIGHT + this.blockHeight / 2);
        } else {
          this.ctx.fillStyle = seg.type === "text" ? "#000b12" : "#000";
          this.ctx.fillRect(startX, RULER_HEIGHT + 1, pxWidth, this.blockHeight - 2);
        }

        let drawSource = null;
        if (isLiveActive && videoEl && videoEl.readyState >= 2) {
          drawSource = videoEl;
        } else {
          if (seg.type === "video" && seg.thumbnails && seg.thumbnails.length > 0) {
            const targetTime = seg._scrubTargetSec !== undefined
              ? seg._scrubTargetSec
              : (isPlayheadOverSeg ? (this.currentFrame - seg.start + seg.trimStart) / this.getFrameRate() : seg.trimStart / this.getFrameRate());
            let nearestImg = seg.thumbnails[0].img;
            let minDiff = Infinity;
            for (const t of seg.thumbnails) {
              const diff = Math.abs(t.time - targetTime);
              if (diff < minDiff) {
                minDiff = diff;
                nearestImg = t.img;
              }
            }
            drawSource = nearestImg;
          } else {
            drawSource = imgObj && imgObj.complete ? imgObj : null;
          }
        }

        if (drawSource && seg.type !== "ghost") {
          const isVid = !!drawSource.videoWidth;
          const natW = isVid ? drawSource.videoWidth : drawSource.naturalWidth;
          const natH = isVid ? drawSource.videoHeight : drawSource.naturalHeight;

          if (natW > 0) {
            const imgRatio = natW / natH;
            const boxRatio = pxWidth / this.blockHeight;
            let drawW, drawH, drawX, drawY;
            if (imgRatio > boxRatio) {
              drawW = pxWidth; drawH = pxWidth / imgRatio;
              drawX = startX; drawY = RULER_HEIGHT + (this.blockHeight - drawH) / 2;
            } else {
              drawH = this.blockHeight; drawW = this.blockHeight * imgRatio;
              drawY = RULER_HEIGHT; drawX = startX + (pxWidth - drawW) / 2;
            }

            // Clip to segment bounds so tiled images don't bleed into adjacent segments
            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.rect(startX, RULER_HEIGHT + 1, pxWidth, this.blockHeight - 2);
            this.ctx.clip();

            if (imgRatio > boxRatio) {
              // Fits width, vertical letterboxing (black bars top/bottom) — keep as is
              this.ctx.drawImage(drawSource, drawX, drawY, drawW, drawH);
            } else {
              // Fits height, horizontal letterboxing (black bars left/right)
              this.ctx.drawImage(drawSource, drawX, drawY, drawW, drawH);

              // Tile left
              let leftX = drawX - drawW;
              while (leftX + drawW > startX) {
                this.ctx.drawImage(drawSource, leftX, drawY, drawW, drawH);
                leftX -= drawW;
              }
              // Tile right
              let rightX = drawX + drawW;
              while (rightX < startX + pxWidth) {
                this.ctx.drawImage(drawSource, rightX, drawY, drawW, drawH);
                rightX += drawW;
              }
            }
            this.ctx.restore();
          }
        }

        if ((seg.type === "video" || drawSource) && seg.type !== "ghost") {
          if (seg.type === "video" && pxWidth > 0) {
            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.rect(startX, RULER_HEIGHT, pxWidth, this.blockHeight);
            this.ctx.clip();
            this.ctx.fillStyle = "rgba(0, 0, 0, 0.60)";
            this.ctx.fillRect(startX, RULER_HEIGHT + 1, 42, 16);
            this.ctx.fillStyle = "#fff";
            this.ctx.font = "bold 10px sans-serif";
            this.ctx.textAlign = "center";
            this.ctx.textBaseline = "middle";
            this.ctx.fillText("视频", startX + 21, RULER_HEIGHT + 9);
            this.ctx.restore();

            // Uploading / Loading indicator badge (bottom-left corner)
            if ((seg._uploading || seg._extractingThumbs) && pxWidth > 60) {
              this.ctx.save();
              this.ctx.beginPath();
              this.ctx.rect(startX, RULER_HEIGHT, pxWidth, this.blockHeight);
              this.ctx.clip();
              this.ctx.font = "bold 9px sans-serif";
              const upText = seg._extractingThumbs ? "Loading..." : "Uploading...";
              const upW = this.ctx.measureText(upText).width + 10;
              this.ctx.fillStyle = "rgba(0, 14, 37, 0.7)";
              this.ctx.fillRect(startX + 1, RULER_HEIGHT + this.blockHeight - 17, upW, 16);
              this.ctx.fillStyle = "#fff";
              this.ctx.textAlign = "center";
              this.ctx.textBaseline = "middle";
              this.ctx.fillText(upText, startX + 1 + upW / 2, RULER_HEIGHT + this.blockHeight - 9);
              this.ctx.restore();
            }

            // Filename next to 视频 tag
            if (this.node.properties.showFilenames && pxWidth > 46) {
              this.ctx.save();
              this.ctx.beginPath();
              this.ctx.rect(startX, RULER_HEIGHT, pxWidth, this.blockHeight);
              this.ctx.clip();
              let rawPath = seg.imageFile || "";
              let fname = rawPath.split(/[/\\]/).pop() || "";
              this.ctx.font = "9px sans-serif";
              this.ctx.textAlign = "left";
              this.ctx.textBaseline = "middle";
              const maxFileTextW = pxWidth - 42 - 10;
              if (this.ctx.measureText(fname).width > maxFileTextW) {
                while (fname.length > 0 && this.ctx.measureText(fname + "…").width > maxFileTextW) {
                  fname = fname.slice(0, -1);
                }
                fname += "…";
              }
              const textW = this.ctx.measureText(fname).width;
              this.ctx.fillStyle = "rgba(0, 0, 0, 0.50)";
              this.ctx.fillRect(startX + 43, RULER_HEIGHT + 1, textW + 8, 16);
              this.ctx.fillStyle = "#fff";
              this.ctx.fillText(fname, startX + 47, RULER_HEIGHT + 9);
              this.ctx.restore();
            }
          } else if (seg.type === "image" && pxWidth > 0) {
            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.rect(startX, RULER_HEIGHT, pxWidth, this.blockHeight);
            this.ctx.clip();
            this.ctx.fillStyle = "rgba(0, 0, 0, 0.60)";
            this.ctx.fillRect(startX, RULER_HEIGHT + 1, 42, 16);
            this.ctx.fillStyle = "#fff";
            this.ctx.font = "bold 10px sans-serif";
            this.ctx.textAlign = "center";
            this.ctx.textBaseline = "middle";
            this.ctx.fillText("IMAGE", startX + 21, RULER_HEIGHT + 9);
            this.ctx.restore();

            // Filename next to IMAGE tag
            if (this.node.properties.showFilenames && pxWidth > 46) {
              this.ctx.save();
              this.ctx.beginPath();
              this.ctx.rect(startX, RULER_HEIGHT, pxWidth, this.blockHeight);
              this.ctx.clip();
              let rawPath = seg.imageFile || "";
              let fname = rawPath.split(/[/\\]/).pop() || "";
              this.ctx.font = "9px sans-serif";
              this.ctx.textAlign = "left";
              this.ctx.textBaseline = "middle";
              const maxFileTextW = pxWidth - 42 - 10;
              if (this.ctx.measureText(fname).width > maxFileTextW) {
                while (fname.length > 0 && this.ctx.measureText(fname + "…").width > maxFileTextW) {
                  fname = fname.slice(0, -1);
                }
                fname += "…";
              }
              const textW = this.ctx.measureText(fname).width;
              this.ctx.fillStyle = "rgba(0, 0, 0, 0.50)";
              this.ctx.fillRect(startX + 43, RULER_HEIGHT + 1, textW + 8, 16);
              this.ctx.fillStyle = "#fff";
              this.ctx.fillText(fname, startX + 47, RULER_HEIGHT + 9);
              this.ctx.restore();
            }
          }

          if (seg.type === "image" && seg.isEndFrame && pxWidth > 0) {
            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.rect(startX, RULER_HEIGHT, pxWidth, this.blockHeight);
            this.ctx.clip();

            this.ctx.font = "bold 9px sans-serif";
            const badgeText = "END FRAME";
            const badgeTextW = this.ctx.measureText(badgeText).width;
            const badgeW = badgeTextW + 10;
            const badgeH = 16;
            const badgeX = startX + pxWidth - badgeW;
            const badgeY = RULER_HEIGHT + 1;

            this.ctx.fillStyle = "rgba(0, 0, 0, 0.60)";
            this.ctx.fillRect(badgeX, badgeY, badgeW, badgeH);

            this.ctx.fillStyle = "#fff";
            this.ctx.textAlign = "center";
            this.ctx.textBaseline = "middle";
            this.ctx.fillText(badgeText, badgeX + badgeW / 2, badgeY + badgeH / 2);
            this.ctx.restore();
          }

          // --- 与下一段衔接图标：⇄ / ✕（含文字段）由 drawTransitionHandles 统一绘制 ---

          // --- Prompt subtitle overlay ---
          if (seg.prompt && seg.type !== "ghost" && pxWidth > 24) {
            const overlayH = Math.round(this.blockHeight * 0.20);
            const overlayY = RULER_HEIGHT + this.blockHeight - overlayH;

            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.rect(startX, overlayY, pxWidth, overlayH);
            this.ctx.clip();

            // Translucent background
            this.ctx.fillStyle = "rgba(0, 0, 0, 0.60)";
            this.ctx.fillRect(startX, overlayY, pxWidth, overlayH);

            // Text
            const fontSize = Math.min(11, overlayH * 0.58);
            this.ctx.font = `${fontSize}px sans-serif`;
            this.ctx.fillStyle = "#e0e3ed";
            this.ctx.textAlign = "center";
            this.ctx.textBaseline = "middle";

            // Measure and truncate to single line
            const maxTextW = pxWidth - 10;
            let label = seg.prompt;
            if (this.ctx.measureText(label).width > maxTextW) {
              while (label.length > 0 && this.ctx.measureText(label + "…").width > maxTextW) {
                label = label.slice(0, -1);
              }
              label += "…";
            }

            this.ctx.fillText(label, startX + pxWidth / 2, overlayY + overlayH / 2);
            this.ctx.restore();
          }
        } else if (seg.type === "text") {
          const pad = 8;
          const promptNo = h3PromptNo.get(seg.id) || 0;
          const numH = promptNo ? 16 : 0;
          if (promptNo && pxWidth > 16) {
            const badge = String(promptNo);
            this.ctx.save();
            this.ctx.font = "bold 11px sans-serif";
            const tw = this.ctx.measureText(badge).width;
            const bw = Math.max(16, tw + 8);
            const bx = startX + Math.max(2, (pxWidth - bw) / 2);
            const by = RULER_HEIGHT + 3;
            this.ctx.fillStyle = "rgba(0,0,0,0.72)";
            this.ctx.fillRect(bx, by, bw, 14);
            this.ctx.fillStyle = "#9cf";
            this.ctx.textAlign = "center";
            this.ctx.textBaseline = "middle";
            this.ctx.fillText(badge, bx + bw / 2, by + 7);
            this.ctx.restore();
          }
          const boxW = pxWidth - pad * 2;
          if (boxW > 12) {
            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.rect(startX + pad, RULER_HEIGHT + pad + numH, boxW, this.blockHeight - pad * 2 - numH);
            this.ctx.clip();
            this.ctx.fillStyle = "#e0e3ed";
            this.ctx.font = "11px sans-serif";
            this.ctx.textAlign = "center";
            this.ctx.textBaseline = "top";
            const label = seg.prompt || "(no prompt)";
            const words = label.split(" ");
            const lineH = 15;
            let line = "";
            let lines = [];
            for (const word of words) {
              const test = line ? line + " " + word : word;
              if (this.ctx.measureText(test).width > boxW && line) {
                lines.push(line);
                line = word;
              } else {
                line = test;
              }
            }
            if (line) lines.push(line);

            const maxLines = Math.max(1, Math.floor((this.blockHeight - pad * 2 - numH) / lineH));
            if (lines.length > maxLines) {
              lines = lines.slice(0, maxLines);
              lines[lines.length - 1] += "…";
            }

            const totalTextHeight = lines.length * lineH;
            const textTop = RULER_HEIGHT + numH;
            const textArea = Math.max(lineH, this.blockHeight - numH);
            let ty = textTop + (textArea - totalTextHeight) / 2 + 2;

            for (const l of lines) {
              this.ctx.fillText(l, startX + pxWidth / 2, ty);
              ty += lineH;
            }
            this.ctx.restore();
          }
        }

        if (isSelected) {
          const outlineColor = "#fff";
          this.ctx.strokeStyle = outlineColor;
          this.ctx.lineWidth = 2;
          this.ctx.strokeRect(startX, RULER_HEIGHT + 1, pxWidth, this.blockHeight - 2);
          if (!this.isMultiSelectActive()) {
            this.ctx.fillStyle = outlineColor;
            this.ctx.beginPath();
            this.ctx.roundRect(startX, RULER_HEIGHT + this.blockHeight / 2 - 12, 4, 24, 2);
            this.ctx.fill();
            this.ctx.beginPath();
            this.ctx.roundRect(startX + pxWidth - 4, RULER_HEIGHT + this.blockHeight / 2 - 12, 4, 24, 2);
            this.ctx.fill();
          }
        } else {
          this.ctx.strokeStyle = "#000";
          this.ctx.lineWidth = 1.5;
          this.ctx.strokeRect(startX, RULER_HEIGHT + 1, pxWidth, this.blockHeight - 2);
        }
        this.ctx.globalAlpha = 1.0;
      }

      // --- Draw Motion Segments（多参模式改画槽位，见 restore 后）---
      if (this.isH3MultiMode && this.isH3MultiMode()) {
        // skip time-based motion segments
      } else for (let i = 0; i < sortedMotionSegments.length; i++) {
        const seg = sortedMotionSegments[i];
        const startX = Math.floor((seg.start / totalFrames) * width);
        const rawEndX = ((seg.start + seg.length) / totalFrames) * width;
        const pxWidth = Math.max(1, Math.floor(rawEndX) - startX);
        const isSelected = this.selectedSegmentIds.includes(seg.id);
        const trackY = RULER_HEIGHT + this.blockHeight + this.audioTrackHeight;

        if ((this._isDragging && this.selectionType === "motion" && seg.id === this._dragTargetId) || (this._ghostSegmentId && seg.id === this._ghostSegmentId)) {
          this.ctx.globalAlpha = 0.65;
        } else {
          this.ctx.globalAlpha = 1.0;
        }

        if (seg.type === "ghost") {
          this.ctx.fillStyle = "#1a1a1a";
          this.ctx.fillRect(startX, trackY, pxWidth, this.motionTrackHeight);
          this.ctx.strokeStyle = "#555";
          this.ctx.lineWidth = 2;
          this.ctx.setLineDash([5, 5]);
          this.ctx.strokeRect(startX, trackY, pxWidth, this.motionTrackHeight);
          this.ctx.setLineDash([]);
          this.ctx.fillStyle = "#888";
          this.ctx.textAlign = "center";
          this.ctx.textBaseline = "middle";
          this.ctx.font = "bold 12px sans-serif";
          this.ctx.fillText("Drop Motion", startX + pxWidth / 2, trackY + this.motionTrackHeight / 2);
        } else {
          this.ctx.fillStyle = "#000";
          this.ctx.fillRect(startX, trackY + 1, pxWidth, this.motionTrackHeight - 2);

          const originalSeg = this.timeline.motionSegments.find(s => s.id === seg.id);
          const imgObj = originalSeg ? originalSeg.imgObj : seg.imgObj;
          const videoEl = originalSeg ? originalSeg.videoEl : seg.videoEl;

          const isPlayheadOverSeg = (this.currentFrame >= seg.start && this.currentFrame < seg.start + seg.length);
          const isScrubbingThis = this._isDragging && (this._dragTargetId === seg.id || this._dragTargetIdRight === seg.id);
          const isLiveActive = this.isPlaying && isPlayheadOverSeg;

          let drawSource = null;
          if (isLiveActive && videoEl && videoEl.readyState >= 2) {
            drawSource = videoEl;
          } else {
            if (seg.type === "motion_video" && seg.thumbnails && seg.thumbnails.length > 0) {
              const targetTime = seg._scrubTargetSec !== undefined
                ? seg._scrubTargetSec
                : (isPlayheadOverSeg ? (this.currentFrame - seg.start + seg.trimStart) / this.getFrameRate() : seg.trimStart / this.getFrameRate());
              let nearestImg = seg.thumbnails[0].img;
              let minDiff = Infinity;
              for (const t of seg.thumbnails) {
                const diff = Math.abs(t.time - targetTime);
                if (diff < minDiff) {
                  minDiff = diff;
                  nearestImg = t.img;
                }
              }
              drawSource = nearestImg;
            } else {
              drawSource = imgObj && imgObj.complete ? imgObj : null;
            }
          }

          if (drawSource && seg.type !== "ghost") {
            const natW = drawSource.videoWidth || drawSource.naturalWidth;
            const natH = drawSource.videoHeight || drawSource.naturalHeight;

            if (natW > 0) {
              const imgRatio = natW / natH;
              const boxRatio = pxWidth / this.motionTrackHeight;
              let drawW, drawH, drawX, drawY;
              if (imgRatio > boxRatio) {
                drawW = pxWidth; drawH = pxWidth / imgRatio;
                drawX = startX; drawY = trackY + (this.motionTrackHeight - drawH) / 2;
              } else {
                drawH = this.motionTrackHeight; drawW = this.motionTrackHeight * imgRatio;
                drawY = trackY; drawX = startX + (pxWidth - drawW) / 2;
              }

              this.ctx.save();
              this.ctx.beginPath();
              this.ctx.rect(startX, trackY + 1, pxWidth, this.motionTrackHeight - 2);
              this.ctx.clip();

              if (imgRatio > boxRatio) {
                this.ctx.drawImage(drawSource, drawX, drawY, drawW, drawH);
              } else {
                this.ctx.drawImage(drawSource, drawX, drawY, drawW, drawH);
                let leftX = drawX - drawW;
                while (leftX + drawW > startX) {
                  this.ctx.drawImage(drawSource, leftX, drawY, drawW, drawH);
                  leftX -= drawW;
                }
                let rightX = drawX + drawW;
                while (rightX < startX + pxWidth) {
                  this.ctx.drawImage(drawSource, rightX, drawY, drawW, drawH);
                  rightX += drawW;
                }
              }
              this.ctx.restore();
            }
          }

          if (pxWidth > 0 && seg.type !== "ghost") {
            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.rect(startX, trackY, pxWidth, this.motionTrackHeight);
            this.ctx.clip();
            this.ctx.fillStyle = "rgba(0, 0, 0, 0.60)";
            this.ctx.fillRect(startX, trackY + 1, 75, 16);
            this.ctx.fillStyle = "#fff";
            this.ctx.font = "bold 10px sans-serif";
            this.ctx.textAlign = "center";
            this.ctx.textBaseline = "middle";
            this.ctx.fillText("IC-LoRA Video", startX + 37, trackY + 9);
            this.ctx.restore();

            // Uploading / Loading indicator badge (bottom-left corner)
            if ((seg._uploading || seg._extractingThumbs) && pxWidth > 60) {
              this.ctx.save();
              this.ctx.beginPath();
              this.ctx.rect(startX, trackY, pxWidth, this.motionTrackHeight);
              this.ctx.clip();
              this.ctx.font = "bold 9px sans-serif";
              const upText = seg._extractingThumbs ? "Loading..." : "Uploading...";
              const upW = this.ctx.measureText(upText).width + 10;
              this.ctx.fillStyle = "rgba(0, 14, 37, 0.7)";
              this.ctx.fillRect(startX + 1, trackY + this.motionTrackHeight - 17, upW, 16);
              this.ctx.fillStyle = "#fff";
              this.ctx.textAlign = "center";
              this.ctx.textBaseline = "middle";
              this.ctx.fillText(upText, startX + 1 + upW / 2, trackY + this.motionTrackHeight - 9);
              this.ctx.restore();
            }

            // Filename next to IC-LoRA Video tag
            if (this.node.properties.showFilenames && pxWidth > 80) {
              this.ctx.save();
              this.ctx.beginPath();
              this.ctx.rect(startX, trackY, pxWidth, this.motionTrackHeight);
              this.ctx.clip();
              let rawPath = seg.videoFile || "";
              let fname = rawPath.split(/[/\\]/).pop() || "";
              this.ctx.font = "9px sans-serif";
              this.ctx.textAlign = "left";
              this.ctx.textBaseline = "middle";
              const maxFileTextW = pxWidth - 75 - 10;
              if (this.ctx.measureText(fname).width > maxFileTextW) {
                while (fname.length > 0 && this.ctx.measureText(fname + "…").width > maxFileTextW) {
                  fname = fname.slice(0, -1);
                }
                fname += "…";
              }
              const textW = this.ctx.measureText(fname).width;
              this.ctx.fillStyle = "rgba(0, 0, 0, 0.50)";
              this.ctx.fillRect(startX + 76, trackY + 1, textW + 8, 16);
              this.ctx.fillStyle = "#fff";
              this.ctx.fillText(fname, startX + 80, trackY + 9);
              this.ctx.restore();
            }
          }

          // --- 全局提示词 subtitle overlay ---
          const globalPromptStr = this.getGlobalPrompt();
          if (globalPromptStr && seg.type !== "ghost" && pxWidth > 24) {
            const overlayH = Math.round(this.motionTrackHeight * 0.25);
            const overlayY = trackY + this.motionTrackHeight - overlayH;

            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.rect(startX, overlayY, pxWidth, overlayH);
            this.ctx.clip();

            // Translucent background
            this.ctx.fillStyle = "rgba(0, 0, 0, 0.60)";
            this.ctx.fillRect(startX, overlayY, pxWidth, overlayH);

            // Text
            const fontSize = Math.min(11, overlayH * 0.58);
            this.ctx.font = `${fontSize}px sans-serif`;
            this.ctx.fillStyle = "#e0e3ed";
            this.ctx.textAlign = "center";
            this.ctx.textBaseline = "middle";

            // Measure and truncate to single line
            const maxTextW = pxWidth - 10;
            let label = globalPromptStr;
            if (this.ctx.measureText(label).width > maxTextW) {
              while (label.length > 0 && this.ctx.measureText(label + "…").width > maxTextW) {
                label = label.slice(0, -1);
              }
              label += "…";
            }

            this.ctx.fillText(label, startX + pxWidth / 2, overlayY + overlayH / 2);
            this.ctx.restore();
          }

          if (isSelected) {
            this.ctx.strokeStyle = "#fff";
            this.ctx.lineWidth = 2;
            this.ctx.strokeRect(startX, trackY + 1, pxWidth, this.motionTrackHeight - 2);
            if (!this.isMultiSelectActive()) {
              this.ctx.fillStyle = "#fff";
              this.ctx.beginPath();
              this.ctx.roundRect(startX, trackY + this.motionTrackHeight / 2 - 12, 4, 24, 2);
              this.ctx.fill();
              this.ctx.beginPath();
              this.ctx.roundRect(startX + pxWidth - 4, trackY + this.motionTrackHeight / 2 - 12, 4, 24, 2);
              this.ctx.fill();
            }
          } else {
            this.ctx.strokeStyle = "#000";
            this.ctx.lineWidth = 1.5;
            this.ctx.strokeRect(startX, trackY + 1, pxWidth, this.motionTrackHeight - 2);
          }
        }
        this.ctx.globalAlpha = 1.0;
      }

      // --- Draw 音频段s（多参模式改画槽位）---
      if (this.isH3MultiMode && this.isH3MultiMode()) {
        // skip
      } else for (let i = 0; i < sortedAudioSegments.length; i++) {
        const seg = sortedAudioSegments[i];
        const rawStartX = (seg.start / totalFrames) * width;
        const rawEndX = ((seg.start + seg.length) / totalFrames) * width;
        const startX = Math.floor(rawStartX);
        const pxWidth = Math.max(1, Math.floor(rawEndX) - startX);
        const isSelected = this.selectedSegmentIds.includes(seg.id);
        const trackY = RULER_HEIGHT + this.blockHeight;

        if ((this._isDragging && this.selectionType === "audio" && seg.id === this._dragTargetId) || (this._ghostSegmentId && seg.id === this._ghostSegmentId)) {
          this.ctx.globalAlpha = 0.65;
        } else {
          this.ctx.globalAlpha = 1.0;
        }

        if (seg.type === "ghost") {
          this.ctx.fillStyle = "#1a1a1a";
          this.ctx.fillRect(startX, trackY, pxWidth, this.audioTrackHeight);
          this.ctx.strokeStyle = "#555";
          this.ctx.lineWidth = 2;
          this.ctx.setLineDash([5, 5]);
          this.ctx.strokeRect(startX, trackY, pxWidth, this.audioTrackHeight);
          this.ctx.setLineDash([]);
          this.ctx.fillStyle = "#888";
          this.ctx.textAlign = "center";
          this.ctx.textBaseline = "middle";
          this.ctx.font = "bold 12px sans-serif";
          this.ctx.fillText("Drop Audio", startX + pxWidth / 2, trackY + this.audioTrackHeight / 2);
        } else {
          const showHandles = !this.isMultiSelectActive();
          const outlineColor = isSelected ? "#fff" : null;
          this.drawAudioSegmentVisuals(this.ctx, seg, isSelected, trackY, this.audioTrackHeight, startX, pxWidth, outlineColor, showHandles);
        }
        this.ctx.globalAlpha = 1.0;
      }


      // --- Dim Disabled Tracks ---
      this.ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
      if (!this.mainTrackEnabled) {
        this.ctx.fillRect(0, RULER_HEIGHT, width, this.blockHeight);
      }
      if (!this.audioTrackEnabled) {
        this.ctx.fillRect(0, RULER_HEIGHT + this.blockHeight, width, this.audioTrackHeight);
      }
      if (!this.motionTrackEnabled) {
        this.ctx.fillRect(0, RULER_HEIGHT + this.blockHeight + this.audioTrackHeight, width, this.motionTrackHeight);
      }
    }

    // 结束主轨区平移，标尺画在原始坐标
    this.ctx.restore();

    // H3：多参画参考音+参考视频+驱动；分镜只画驱动
    if (this.isH3Director) {
      const aTop = this.getAudioTrackTop();
      if (this.isH3MultiMode && this.isH3MultiMode()) {
        const raTop = this.getRefAudioTrackTop();
        const vTop = this.getMotionTrackTop();
        this.drawH3MultiRefAudioTrack(width, raTop, this.refAudioTrackHeight || 0);
        this.drawH3MultiVideoTrack(width, vTop, this.motionTrackHeight || 0);
      }
      if (this.audioTrackHeight > 0) {
        this.drawH3DriveAudioTrack(width, aTop, this.audioTrackHeight || 0);
      }
    }

    // --- Draw Ruler & Divider AFTER segments to prevent overlap ---
    // Ruler Background
    this.ctx.fillStyle = "#1e1e1e";
    this.ctx.fillRect(0, 0, width, RULER_HEIGHT);

    // Crisp Ruler Text
    this.ctx.fillStyle = "#aaa";
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";
    this.ctx.font = "10px sans-serif";

    const frameRate = this.getFrameRate();
    const modeIsSeconds = this._isSecondsMode();

    // Define logical steps for both modes
    let steps;
    if (modeIsSeconds) {
      steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    } else {
      steps = [1, 2, 5, 10, 24, 48, 120, 240, 480, 960, 1920];
    }

    const minSpacingPx = 60;
    let majorStep = steps[steps.length - 1];
    for (let i = 0; i < steps.length; i++) {
      const stepFrames = modeIsSeconds ? steps[i] * frameRate : steps[i];
      const spacingPx = (stepFrames / totalFrames) * width;
      if (spacingPx >= minSpacingPx) {
        majorStep = steps[i];
        break;
      }
    }

    const majorStepFrames = modeIsSeconds ? majorStep * frameRate : majorStep;

    let minorStep;
    if (modeIsSeconds) {
      if (majorStep <= 0.2) minorStep = majorStep / 2;
      else if (majorStep <= 1) minorStep = majorStep / 5;
      else if (majorStep <= 5) minorStep = 1;
      else if (majorStep <= 15) minorStep = 5;
      else if (majorStep <= 30) minorStep = 10;
      else if (majorStep <= 60) minorStep = 10;
      else minorStep = majorStep / 5;
    } else {
      if (majorStep <= 5) minorStep = 1;
      else if (majorStep <= 10) minorStep = 2;
      else if (majorStep <= 24) minorStep = 6;
      else if (majorStep <= 48) minorStep = 12;
      else minorStep = majorStep / 5;
    }
    const minorStepFrames = modeIsSeconds ? minorStep * frameRate : minorStep;

    this.ctx.fillStyle = "#444";
    const totalMinorTicks = Math.floor(totalFrames / minorStepFrames);
    for (let i = 0; i <= totalMinorTicks; i++) {
      const frameVal = i * minorStepFrames;
      if (Math.abs(frameVal % majorStepFrames) < 0.1) continue;

      const x = (frameVal / totalFrames) * width;
      this.ctx.fillRect(Math.floor(x), RULER_HEIGHT - 3, 1, 3);
    }

    this.ctx.fillStyle = "#aaa";
    const totalMajorTicks = Math.floor(totalFrames / majorStepFrames);
    for (let i = 0; i <= totalMajorTicks; i++) {
      const frameVal = i * majorStepFrames;
      const x = (frameVal / totalFrames) * width;

      this.ctx.fillStyle = "#aaa";
      this.ctx.fillRect(Math.floor(x), RULER_HEIGHT - 6, 1, 6);

      if (frameVal > 0 && frameVal < totalFrames) {
        this.ctx.textAlign = "center";
        this.ctx.fillText(this.formatTime(frameVal, true), x, RULER_HEIGHT / 2);
      }
    }

    this.ctx.textAlign = "left";
    const zeroLabel = modeIsSeconds ? "0" : this.formatTime(0, true);
    this.ctx.fillText(zeroLabel, 4, RULER_HEIGHT / 2);

    // Divider（含多参图轨偏移）
    const mainTop = this.getMainTrackTop();
    this.ctx.fillStyle = "#111";
    this.ctx.fillRect(0, RULER_HEIGHT - 1, width, 1);
    if (refH > 0) {
      this.ctx.fillRect(0, RULER_HEIGHT + refH - 1, width, 1);
    }
    this.ctx.fillRect(0, mainTop + this.blockHeight - 1, width, 1);
    this.ctx.fillRect(0, mainTop + this.blockHeight + this.audioTrackHeight - 1, width, 1);

    // Draw gap "+" buttons
    if (!this._isDragging && !this.retakeMode) {
      const BTN_R = 12;
      const gapRegions = this.getGapRegions();
      for (let i = 0; i < gapRegions.length; i++) {
        const gap = gapRegions[i];
        if (gap.widthPx < BTN_R * 2 + 8) continue;
        const hov = this._hoveredGapIdx === i;
        const BTN_W = 18;
        const BTN_H = 18;
        this.ctx.beginPath();
        this.ctx.roundRect(gap.centerX - BTN_W / 2, gap.centerY - BTN_H / 2, BTN_W, BTN_H, 4);
        this.ctx.fillStyle = hov ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.05)";
        this.ctx.fill();
        this.ctx.fillStyle = hov ? "#fff" : "#888";
        this.ctx.font = "14px sans-serif";
        this.ctx.textAlign = "center";
        this.ctx.textBaseline = "middle";
        this.ctx.fillText("+", gap.centerX, gap.centerY + 1);
      }
    }

    // --- Out-of-duration shadow overlay ---
    // Skip in retake mode — the retake region has its own overlay and the
    // start/end frame widgets are locked, so this overlay would be misleading.
    if (!this.retakeMode) {
      const startFrames = this.getStartFrames();
      const durationFrames = this.getDurationFrames();
      const outputFrames = startFrames + durationFrames;

      const tracksH =
        this.getRefTrackHeight() +
        this.blockHeight +
        this.motionTrackHeight +
        this.audioTrackHeight;
      if (startFrames > 0) {
        const startX = (startFrames / totalFrames) * width;
        this.ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
        this.ctx.fillRect(0, RULER_HEIGHT, startX, tracksH);
        this.ctx.fillStyle = "rgba(0, 0, 0, 0.25)";
        this.ctx.fillRect(0, 0, startX, RULER_HEIGHT);
      }

      if (outputFrames < totalFrames) {
        const cutoffX = (outputFrames / totalFrames) * width;
        this.ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
        this.ctx.fillRect(cutoffX, RULER_HEIGHT, width - cutoffX, tracksH);
        this.ctx.fillStyle = "rgba(0, 0, 0, 0.25)";
        this.ctx.fillRect(cutoffX, 0, width - cutoffX, RULER_HEIGHT);
      }
    }

    // --- Draw Playhead ---
    const playheadX = (this.currentFrame / totalFrames) * width;

    // Playhead Line
    this.ctx.beginPath();
    this.ctx.moveTo(playheadX, 14);
    this.ctx.lineTo(playheadX, this.canvasHeight);
    this.ctx.strokeStyle = "#ff4444";
    this.ctx.lineWidth = 1.5;
    this.ctx.stroke();

    // Playhead Handle (Polygon above numbers)
    this.ctx.fillStyle = "#ff4444";
    this.ctx.beginPath();
    this.ctx.moveTo(playheadX - 6, 0);
    this.ctx.lineTo(playheadX + 6, 0);
    this.ctx.lineTo(playheadX + 6, 8);
    this.ctx.lineTo(playheadX, 14);
    this.ctx.lineTo(playheadX - 6, 8);
    this.ctx.fill();

    // Draw vertical grab bar on the right edge of viewport for resizing width
    const grabBarW = 4;
    const grabBarH = 50;
    const grabBarX = this.viewport.scrollLeft + this.viewport.clientWidth - grabBarW - 3;
    const grabBarY =
      RULER_HEIGHT +
      (this.getRefTrackHeight() + this.blockHeight + this.motionTrackHeight + this.audioTrackHeight - grabBarH) / 2;

    this.ctx.fillStyle = "rgba(40, 40, 40, 0.6)";
    this.ctx.beginPath();
    this.ctx.roundRect(grabBarX, grabBarY, grabBarW, grabBarH, 2);
    this.ctx.fill();

    // Draw horizontal grab bar at the bottom of viewport for resizing height
    const hBarW = 50;
    const hBarH = 4;
    const hBarX = this.viewport.scrollLeft + (this.viewport.clientWidth - hBarW) / 2;
    const visibleBottom = Math.min(this.canvasHeight, this.viewport.scrollTop + this.viewport.clientHeight);
    const hBarY = visibleBottom - hBarH - 3; // 3px from the visible bottom edge

    this.ctx.fillStyle = "rgba(20, 20, 20, 0.8)";
    this.ctx.beginPath();
    this.ctx.roundRect(hBarX, hBarY, hBarW, hBarH, 2);
    this.ctx.fill();

    // --- Draw Selection Box Overlay ---
    if (this._isSelectingBox && this._selectBoxStart && this._selectBoxCurrent) {
      const sx = this._selectBoxStart.x;
      const sy = this._selectBoxStart.y;
      const cx = this._selectBoxCurrent.x;
      const cy = this._selectBoxCurrent.y;

      const left = Math.min(sx, cx);
      const top = Math.min(sy, cy);
      const rectWidth = Math.abs(cx - sx);
      const rectHeight = Math.abs(cy - sy);

      this.ctx.save();
      this.ctx.fillStyle = "rgba(59, 130, 246, 0.2)";
      this.ctx.fillRect(left, top, rectWidth, rectHeight);

      this.ctx.strokeStyle = "rgba(29, 78, 216, 0.9)";
      this.ctx.lineWidth = 1.5;
      this.ctx.setLineDash([4, 4]);
      this.ctx.strokeRect(left, top, rectWidth, rectHeight);
      this.ctx.setLineDash([]);
      this.ctx.restore();
    }

    // 图片段之间的衔接开关（⇄ 首尾帧 / ✕ 硬切）
    try {
      this.drawTransitionHandles();
    } catch (err) {
      console.warn("[导演台] 绘制衔接图标失败", err);
    }

    this.updatePlayerUI();
  }



  drawAudioSegmentVisuals(ctx, seg, isSelected, yOffset, trackHeight, startX, pxWidth, outlineColor = null, showHandles = true) {
    ctx.fillStyle = isSelected ? "#2a4a3a" : "#1a2a1a";
    ctx.fillRect(startX, yOffset + 2, pxWidth, trackHeight - 3);

    if (seg.waveformPeaks && pxWidth > 0) {
      ctx.fillStyle = isSelected ? "rgba(100, 255, 100, 0.6)" : "rgba(100, 255, 100, 0.3)";
      const startRatio = seg.trimStart / seg.audioDurationFrames;
      const endRatio = (seg.trimStart + seg.length) / seg.audioDurationFrames;
      const peakCount = seg.waveformPeaks.length;
      const centerY = yOffset + trackHeight / 2;

      ctx.beginPath();
      for (let i = 0; i < pxWidth; i++) {
        const pixelRatio = i / pxWidth;
        const globalRatio = startRatio + pixelRatio * (endRatio - startRatio);
        const peakIdx = Math.floor(globalRatio * peakCount);

        if (peakIdx >= 0 && peakIdx < peakCount) {
          const val = seg.waveformPeaks[peakIdx];
          const amp = (val * (trackHeight - 12) / 2) * 0.9;
          ctx.fillRect(startX + i, centerY - amp, 1, amp * 2);
        }
      }
    }

    const strokeColor = outlineColor || (isSelected ? "#4fff8f" : "#000");
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = isSelected || outlineColor ? 2 : 1.5;
    ctx.strokeRect(startX, yOffset + 2, pxWidth, trackHeight - 3);

    if ((isSelected || outlineColor) && showHandles) {
      ctx.fillStyle = strokeColor;
      ctx.beginPath();
      ctx.roundRect(startX, yOffset + trackHeight / 2 - 12, 4, 24, 2);
      ctx.fill();
      ctx.beginPath();
      ctx.roundRect(startX + pxWidth - 4, yOffset + trackHeight / 2 - 12, 4, 24, 2);
      ctx.fill();
    }

    ctx.fillStyle = "#ccc";
    ctx.font = "11px sans-serif";
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.save();
    ctx.beginPath();
    ctx.rect(startX, yOffset + 2, pxWidth, trackHeight - 3);
    ctx.clip();

    let text = seg.fileName || "Audio Track";
    const maxWidth = pxWidth - 12;
    if (ctx.measureText(text).width > maxWidth && maxWidth > 0) {
      while (text.length > 0 && ctx.measureText(text + "...").width > maxWidth) {
        text = text.slice(0, -1);
      }
      text = text + "...";
    }

    ctx.fillText(text, startX + 6, yOffset + 8);
    ctx.restore();

    // Show Uploading or Decoding badge in bottom-left if applicable
    if ((seg._uploading || seg._decoding) && pxWidth > 60) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(startX, yOffset + 2, pxWidth, trackHeight - 3);
      ctx.clip();
      ctx.font = "bold 9px sans-serif";
      const upText = seg._decoding ? "Decoding..." : "Uploading...";
      const upW = ctx.measureText(upText).width + 10;
      ctx.fillStyle = "rgba(0, 14, 37, 0.7)";
      ctx.fillRect(startX + 1, yOffset + trackHeight - 17, upW, 14);
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(upText, startX + 1 + upW / 2, yOffset + trackHeight - 10);
      ctx.restore();
    }
  }


  // --- Interaction Logic ---
  getHitTest(mouseX, mouseY) {
    const width = this.canvas.offsetWidth;
    const totalFrames = this.getVisualDurationFrames();

    // Check Playhead Handle first
    const playheadX = (this.currentFrame / totalFrames) * width;
    if (mouseY <= 24 && Math.abs(mouseX - playheadX) <= 12) {
      return { type: "playhead" };
    }

    if (mouseY <= RULER_HEIGHT) {
      return { type: "ruler" };
    }

    if (mouseY < RULER_HEIGHT || mouseY > this.canvasHeight) return null;

    const trackType = this.getTrackFromY(mouseY);
    // 多参图轨由 DOM 处理，画布不命中片段
    if (trackType === "ref") return null;
    const trackSegments = this.getSegmentArray(trackType);

    if (!trackSegments || trackSegments.length === 0) return null;

    // Helper to check if a segment (or its sibling video/audio counterpart) is uploading/decoding
    const isSegmentProcessing = (s) => {
      if (!s) return false;
      if (s._uploading || s._decoding) return true;
      const isVid = s.id?.endsWith("_v");
      const isAud = s.id?.endsWith("_a");
      if (isVid || isAud) {
        const siblingId = isVid ? s.id.slice(0, -2) + "_a" : s.id.slice(0, -2) + "_v";
        const siblingArray = isVid ? this.timeline.audioSegments : this.timeline.segments;
        const sibling = siblingArray.find(x => x.id === siblingId);
        if (sibling && (sibling._uploading || sibling._decoding)) {
          return true;
        }
      }
      return false;
    };

    // The variables width and totalFrames are already declared above.

    let sortedSegments = [...trackSegments]
      .map((s, i) => ({ ...s, originalIndex: i }))
      .sort((a, b) => a.start - b.start);

    const HANDLE_CORE = 4;

    for (let i = 0; i < sortedSegments.length; i++) {
      const seg = sortedSegments[i];
      const startX = (seg.start / totalFrames) * width;
      const pxWidth = (seg.length / totalFrames) * width;
      const endX = startX + pxWidth;

      const prevSeg = sortedSegments[i - 1];
      const nextSeg = sortedSegments[i + 1];

      const isLeftJoint = prevSeg && prevSeg.start + prevSeg.length === seg.start;
      if (!isLeftJoint) {
        if (Math.abs(mouseX - startX) <= HANDLE_HIT_PX) {
          if (!isSegmentProcessing(seg)) {
            return { type: "edge", index: seg.originalIndex, dir: "left", track: trackType };
          }
        }
      }

      const isRightJoint = nextSeg && nextSeg.start === seg.start + seg.length;
      if (isRightJoint) {
        const dx = mouseX - endX;
        if (Math.abs(dx) <= HANDLE_HIT_PX) {
          if (dx < -HANDLE_CORE) {
            if (!isSegmentProcessing(seg)) {
              return { type: "edge", index: seg.originalIndex, dir: "right", track: trackType };
            }
          } else if (dx > HANDLE_CORE) {
            if (!isSegmentProcessing(nextSeg)) {
              return { type: "edge", index: nextSeg.originalIndex, dir: "left", track: trackType };
            }
          } else {
            if (!isSegmentProcessing(seg) && !isSegmentProcessing(nextSeg)) {
              return { type: "joint", leftIndex: seg.originalIndex, rightIndex: nextSeg.originalIndex, track: trackType };
            }
          }
        }
      } else {
        if (Math.abs(mouseX - endX) <= HANDLE_HIT_PX) {
          if (!isSegmentProcessing(seg)) {
            return { type: "edge", index: seg.originalIndex, dir: "right", track: trackType };
          }
        }
      }
    }

    for (let i = 0; i < sortedSegments.length; i++) {
      const seg = sortedSegments[i];
      const startX = (seg.start / totalFrames) * width;
      const pxWidth = (seg.length / totalFrames) * width;
      const endX = startX + pxWidth;

      if (mouseX >= startX && mouseX < endX) {
        return { type: "center", index: seg.originalIndex, track: trackType };
      }
    }

    return null;
  }

  /** 在相邻段之间绘制衔接开关：⇄=首尾帧  ✕=硬切（含 图↔文、文↔图） */
  drawTransitionHandles() {
    if (this.retakeMode) return;
    // 图片 / 视频 / 文字段都参与，否则「图+文+图」中间文字两侧缺图标
    const segs = (this.timeline.segments || [])
      .filter(s => s && s.type !== "ghost" && (s.type === "image" || s.type === "video" || s.type === "text" || !s.type))
      .slice()
      .sort((a, b) => a.start - b.start);
    if (segs.length < 2) return;

    const logicalWidth = this.canvas.offsetWidth;
    const totalFrames = Math.max(1, this.getVisualDurationFrames());
    const r = 11;
    this._transitionHitZones = [];

    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i];
      // 旧时间线文字段可能没有该字段：默认首尾帧
      if (seg.transitionToNext !== "cut" && seg.transitionToNext !== "flf") {
        seg.transitionToNext = "flf";
      }
      const endFrame = seg.start + seg.length;
      const x = (endFrame / totalFrames) * logicalWidth;
      const y = this.getMainTrackTop() + this.blockHeight / 2;
      const mode = (seg.transitionToNext === "cut") ? "cut" : "flf";

      this.ctx.save();
      this.ctx.beginPath();
      this.ctx.arc(x, y, r, 0, Math.PI * 2);
      this.ctx.fillStyle = mode === "flf" ? "rgba(60, 120, 220, 0.92)" : "rgba(180, 70, 70, 0.92)";
      this.ctx.fill();
      this.ctx.strokeStyle = "#fff";
      this.ctx.lineWidth = 1.5;
      this.ctx.stroke();

      this.ctx.fillStyle = "#fff";
      this.ctx.font = "bold 12px sans-serif";
      this.ctx.textAlign = "center";
      this.ctx.textBaseline = "middle";
      // ⇄ 首尾帧  /  ✕ 硬切
      this.ctx.fillText(mode === "flf" ? "⇄" : "✕", x, y + 0.5);
      this.ctx.restore();

      this._transitionHitZones.push({
        segId: seg.id,
        mode,
        x, y, r: r + 4,
      });
    }
  }

  hitTransitionHandle(mx, my) {
    const zones = this._transitionHitZones || [];
    for (const z of zones) {
      const dx = mx - z.x;
      const dy = my - z.y;
      if (dx * dx + dy * dy <= z.r * z.r) return z;
    }
    return null;
  }

  toggleTransitionForSegmentId(segId) {
    const seg = (this.timeline.segments || []).find(s => s.id === segId);
    if (!seg) return;
    // 图片 / 视频 / 文字段均可切换
    if (seg.type === "audio" || seg.type === "ghost") return;
    const cur = seg.transitionToNext === "cut" ? "cut" : "flf";
    seg.transitionToNext = (cur === "flf") ? "cut" : "flf";
    this.commitChanges(true);
    this.render();
  }

  onMouseDown(e) {
    if (e.button === 2 && this.retakeMode) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.button !== 0) return;
    const { x, y } = this.getMousePos(e);

    // 优先：点击段间衔接图标（⇄ / ✕）
    if (!this.retakeMode) {
      const hit = this.hitTransitionHandle(x, y);
      if (hit) {
        this.toggleTransitionForSegmentId(hit.segId);
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }

    // 框选：Shift+拖 或 空白处拖（非 retake）
    if (!this.retakeMode && e.shiftKey) {
      this._startBoxSelect(x, y, e);
      return;
    }

    // Canvas height and width resizing apply in both modes.
    const visibleBottom = Math.min(this.canvasHeight, this.viewport.scrollTop + this.viewport.clientHeight);
    const isAtBottom = Math.abs(y - visibleBottom) <= 15;
    if (isAtBottom) {
      this._isDragging = true;
      this._dragType = "height_resize";
      this._startBlockHeight = this.blockHeight;
      this._startY = y;
      document.body.style.userSelect = "none";
      return;
    }

    const viewRect = this.viewport.getBoundingClientRect();
    const isAtRightEdge = Math.abs(e.clientX - viewRect.right) <= 20;
    if (isAtRightEdge) {
      this._isDragging = true;
      this._dragType = "width_resize";
      this._startNodeWidth = this.node.size[0];
      this._startX = e.clientX;
      document.body.style.userSelect = "none";
      return;
    }

    // Track height dividers only apply in normal timeline mode.
    if (!this.retakeMode) {
      const refH = this.getRefTrackHeight();
      const mainTopY = this.getMainTrackTop();
      const isOverRefDivider = refH > 0 && Math.abs(y - (RULER_HEIGHT + refH)) <= 8;
      const isOverDivider = Math.abs(y - (mainTopY + this.blockHeight)) <= 8;
      const isOverAudioDivider = Math.abs(y - (mainTopY + this.blockHeight + this.audioTrackHeight)) <= 8;
      if (isOverRefDivider) {
        this._isDragging = true;
        this._dragType = "ref_divider";
        this._startRefTrackHeight = this.refTrackHeight;
        this._startY = y;
        return;
      } else if (isOverDivider) {
        this._isDragging = true;
        this._dragType = "divider";
        this._startBlockHeight = this.blockHeight;
        this._startAudioTrackHeight = this.audioTrackHeight;
        this._startY = y;
        return;
      } else if (isOverAudioDivider) {
        this._isDragging = true;
        this._dragType = "audio_divider";
        this._startMotionTrackHeight = this.motionTrackHeight;
        this._startAudioTrackHeight = this.audioTrackHeight;
        this._startY = y;
        return;
      }
    }

    // 多参图 / 音频槽 / 视频槽 交互
    if (this.isH3MultiMode && this.isH3MultiMode()) {
      const refHit = this.hitH3RefTrack(x, y);
      if (refHit) {
        if (refHit.type === "x") {
          this.h3RemoveRefImage(refHit.index);
          return;
        }
        if (refHit.type === "plus") {
          this.promptAddH3RefImage(refHit.index);
          return;
        }
        if (refHit.type === "track") {
          this._startBoxSelect(x, y, e);
          return;
        }
        if (refHit.type === "img") {
          const isCtrl = e.ctrlKey || e.metaKey;
          const idx = refHit.index;
          if (isCtrl) {
            const set = new Set(this.selectedH3RefIndexes || []);
            if (set.has(idx)) set.delete(idx);
            else set.add(idx);
            this.selectedH3RefIndexes = Array.from(set).sort((a, b) => a - b);
          } else {
            this.selectedH3RefIndexes = [idx];
            this.selectedSegmentIds = [];
            this.selectedIndex = -1;
            this._h3RefDrag = {
              from: idx,
              startX: x,
              startY: y,
              x,
              y,
              over: idx,
              active: false,
            };
          }
          this.updateUIFromSelection?.();
          this.render?.();
          return;
        }
      }
      // 参考音频 3 槽
      const raHit = this.hitH3MultiMediaSlots(x, y, this._h3RefAudioLayout);
      if (raHit) {
        if (raHit.type === "x") {
          this.h3RemoveRefAudio(raHit.index);
          return;
        }
        if (raHit.type === "play") {
          this.h3TogglePlayAudio(raHit.index, "ref");
          return;
        }
        if (raHit.type === "add" || raHit.type === "track") {
          this.promptAddH3RefAudio(raHit.type === "add" ? raHit.index : undefined);
          return;
        }
      }
      const vHit = this.hitH3MultiMediaSlots(x, y, this._h3VideoLayout);
      if (vHit) {
        if (vHit.type === "x") {
          this.h3RemoveRefVideo(vHit.index);
          return;
        }
        if (vHit.type === "play") {
          this.h3TogglePlayVideo(vHit.index);
          return;
        }
        if (vHit.type === "add" || vHit.type === "track") {
          this.promptAddH3RefVideo(vHit.type === "add" ? vHit.index : undefined);
          return;
        }
      }
    }

    // 驱动音频：分镜/多参共用；有段时交给后面 getHitTest，空轨点此添加
    if (this.isH3Director && this.audioTrackHeight > 0) {
      const hasDrive = (this.timeline.audioSegments || []).some((s) => s?.isH3Drive);
      if (!hasDrive) {
        const aTop = this.getAudioTrackTop();
        const aH = this.audioTrackHeight || 0;
        if (y >= aTop && y <= aTop + aH) {
          this.promptAddH3DriveAudio();
          return;
        }
      }
    }

    if (this.getRefTrackHeight() > 0) {
      const refHit = this.hitH3RefTrack(x, y);
      if (refHit) {
        if (refHit.type === "x") {
          this.h3RemoveRefImage(refHit.index);
          return;
        }
        if (refHit.type === "plus" || refHit.type === "track") {
          this.promptAddH3RefImage(refHit.type === "plus" ? refHit.index : undefined);
          return;
        }
        if (refHit.type === "img") return;
      }
    }

    if (this.retakeMode) {
      // If no video is loaded on the retake timeline, clicking in the timeline opens the file explorer
      if (y >= RULER_HEIGHT && y <= RULER_HEIGHT + this.blockHeight) {
        if (!this.timeline.retakeVideo) {
          if (this.videoFileInput) {
            this.videoFileInput.click();
          }
          return;
        }
      }

      if (y < RULER_HEIGHT) {
        this._isDragging = true;
        this._dragType = "playhead";
        const logicalWidth = this.canvas.offsetWidth;
        const totalFrames = this.getVisualDurationFrames();
        let mouseFrameX = x * (totalFrames / logicalWidth);
        mouseFrameX = this.getSnappedPlayhead(mouseFrameX, logicalWidth);
        const clampMax = this.timeline.retakeVideo ? (this.timeline.retakeVideo.videoDurationFrames || totalFrames) : totalFrames;
        this.currentFrame = clamp(mouseFrameX, 0, clampMax);
        // Pause only the RAF playback loop so we can seek the video directly during scrub.
        // The video element itself keeps playing; we'll resume the loop on mouseup.
        this._retakeScrubWasPlaying = this.isPlaying;
        if (this.isPlaying) {
          this.isPlaying = false;
          this._currentPlayId = null;
        }
        if (this.timeline.retakeVideo && this.timeline.retakeVideo.videoEl) {
          this.timeline.retakeVideo.videoEl.currentTime = this.currentFrame / this.getFrameRate();
        }
        this.render();
        return;
      }

      if (y >= RULER_HEIGHT && y <= RULER_HEIGHT + this.blockHeight) {
        const logicalWidth = this.canvas.offsetWidth;
        const totalFrames = this.getVisualDurationFrames();
        const retakeStart = this.timeline.retakeStart ?? 0;
        const baseVideoDur = this.timeline.retakeVideo?.videoDurationFrames ?? totalFrames;
        const retakeLength = this.timeline.retakeLength ?? baseVideoDur;

        const x1 = (retakeStart / totalFrames) * logicalWidth;
        const x2 = ((retakeStart + retakeLength) / totalFrames) * logicalWidth;
        const threshold = HANDLE_HIT_PX;

        if (this.timeline.retakeVideo && Math.abs(x - x1) <= threshold) {
          this._isDragging = true;
          this._dragType = "retake_left";
          this._dragStartX = x;
          this._dragStartRetakeStart = retakeStart;
          this._dragStartRetakeLength = retakeLength;
          return;
        } else if (this.timeline.retakeVideo && Math.abs(x - x2) <= threshold) {
          this._isDragging = true;
          this._dragType = "retake_right";
          this._dragStartX = x;
          this._dragStartRetakeStart = retakeStart;
          this._dragStartRetakeLength = retakeLength;
          return;
        } else if (this.timeline.retakeVideo && x > x1 && x < x2) {
          this._isDragging = true;
          this._dragType = "retake_center";
          this._dragStartX = x;
          this._dragStartRetakeStart = retakeStart;
          this._dragStartRetakeLength = retakeLength;
          return;
        } else {
          this._isDragging = true;
          this._dragType = "playhead";
          let mouseFrameX = x * (totalFrames / logicalWidth);
          mouseFrameX = this.getSnappedPlayhead(mouseFrameX, logicalWidth);
          const clampMax = this.timeline.retakeVideo ? (this.timeline.retakeVideo.videoDurationFrames || totalFrames) : totalFrames;
          this.currentFrame = clamp(mouseFrameX, 0, clampMax);
          // Pause only the RAF playback loop so we can seek the video directly during scrub.
          this._retakeScrubWasPlaying = this.isPlaying;
          if (this.isPlaying) {
            this.isPlaying = false;
            this._currentPlayId = null;
          }
          if (this.timeline.retakeVideo && this.timeline.retakeVideo.videoEl) {
            this.timeline.retakeVideo.videoEl.currentTime = this.currentFrame / this.getFrameRate();
          }
          this.render();
          return;
        }
      }
      // Retake mode consumed the interaction — do NOT fall through to normal timeline
      return;
    }

    if (y >= RULER_HEIGHT && y <= this.canvasHeight) {
      const BTN_R = 12;
      const gapRegions = this.getGapRegions();
      for (let i = 0; i < gapRegions.length; i++) {
        const gap = gapRegions[i];
        if (gap.widthPx < BTN_R * 2 + 8) continue;
        const dx = x - gap.centerX, dy2 = y - gap.centerY;
        if (dx * dx + dy2 * dy2 <= BTN_R * BTN_R) {
          const currentTrack = gap.track;
          const hasCopied = this._copiedSegment || window._ltxCopiedSegment;
          const copiedTrack = this._copiedSegmentTrack || window._ltxCopiedSegmentType;
          const isCompatible = hasCopied && this.getCanonicalTrack(copiedTrack) === currentTrack;

          if (currentTrack === "ref") {
            this.promptAddH3RefImage();
          } else if (currentTrack === "motion" && !isCompatible) {
            this.promptAddMotionInGap(gap.frameStart, gap.frameEnd);
          } else if (currentTrack === "audio" && !isCompatible) {
            this.promptAddAudioInGap(gap.frameStart, gap.frameEnd);
          } else {
            this.showGapMenu(e.clientX, e.clientY, gap);
          }
          return;
        }
      }
    }

    const isCtrl = e.ctrlKey || e.metaKey;
    const hit = this.getHitTest(x, y);
    if (!hit) {
      // 空白处拖拽 = 框选（主轨提示词 / 驱动音频 / 参考图）
      if (y >= RULER_HEIGHT) {
        this._startBoxSelect(x, y, e);
        return;
      }
      if (!isCtrl) {
        this.selectedSegmentIds = [];
        this.selectedIndex = -1;
        this.selectedH3RefIndexes = [];
        this.updateUIFromSelection();
      }
      this.render();
      return;
    }

    if (hit.type === "playhead" || hit.type === "ruler") {
      this._isDragging = true;
      this._dragType = "playhead";
      const logicalWidth = this.canvas.offsetWidth;
      const totalFrames = this.getVisualDurationFrames();
      const playbackFrames = this.getPlaybackDurationFrames();
      let mouseFrameX = x * (totalFrames / logicalWidth);
      mouseFrameX = this.getSnappedPlayhead(mouseFrameX, logicalWidth);
      this.currentFrame = clamp(mouseFrameX, 0, playbackFrames);
      this._liveScrubPlayhead();
      this.render();
      if (this.isPlaying) {
        this.playAudio();
      }
      return;
    }

    const clickedTrack = hit.track;
    const targetArray = this.getSegmentArray(clickedTrack);
    let clickedId = null;
    let clickedIdx = -1;
    if (hit.type === "joint") {
      clickedIdx = hit.leftIndex;
    } else {
      clickedIdx = hit.index;
    }
    if (clickedIdx !== -1 && targetArray[clickedIdx]) {
      clickedId = targetArray[clickedIdx].id;
    }

    if (clickedId) {
      this.selectedH3RefIndexes = [];
      if (isCtrl) {
        const sibId = clickedId.endsWith("_v") ? clickedId.slice(0, -2) + "_a" : (clickedId.endsWith("_a") ? clickedId.slice(0, -2) + "_v" : null);
        const isSelected = this.selectedSegmentIds.includes(clickedId);
        if (isSelected) {
          this.selectedSegmentIds = this.selectedSegmentIds.filter(id => id !== clickedId && id !== sibId);
        } else {
          if (!this.selectedSegmentIds.includes(clickedId)) this.selectedSegmentIds.push(clickedId);
          if (sibId && !this.selectedSegmentIds.includes(sibId)) this.selectedSegmentIds.push(sibId);
        }

        if (this.selectedSegmentIds.length > 0) {
          this.selectionType = clickedTrack;
          this.selectedIndex = clickedIdx;
        } else {
          this.selectedIndex = -1;
        }
        this._multiDragClickPendingDeselect = null;
      } else {
        if (this.selectedSegmentIds.includes(clickedId)) {
          this._multiDragClickPendingDeselect = clickedId;
        } else {
          this.selectedSegmentIds = [clickedId];
          const sibId = clickedId.endsWith("_v") ? clickedId.slice(0, -2) + "_a" : (clickedId.endsWith("_a") ? clickedId.slice(0, -2) + "_v" : null);
          if (sibId && !this.selectedSegmentIds.includes(sibId)) this.selectedSegmentIds.push(sibId);
          this.selectionType = clickedTrack;
          this.selectedIndex = clickedIdx;
          this._multiDragClickPendingDeselect = null;
        }
      }
    } else if (y >= RULER_HEIGHT) {
      // 点在轨道空白：框选多段
      this._startBoxSelect(x, y, e);
      return;
    }

    this.updateUIFromSelection();

    if (this.isMultiSelectActive()) {
      this._isDragging = true;
      this._dragType = "center";
      this._dragStartX = x;
      this._isMultiDraggingAndMoved = false;
      this._multiDragInitialSegments = {
        image: this.timeline.segments.map(s => ({ ...s })),
        motion: this.timeline.motionSegments.map(s => ({ ...s })),
        audio: this.timeline.audioSegments.map(s => ({ ...s }))
      };
      this._multiDragPreviewTimelines = null;
    } else {
      this.selectionType = hit.track;
      if (hit.type === "joint") {
        this.selectedIndex = hit.leftIndex;
        this._dragType = "joint";
        this._dragTargetId = targetArray[hit.leftIndex].id;
        this._dragTargetIdRight = targetArray[hit.rightIndex].id;
      } else if (hit.type === "center") {
        this.selectedIndex = hit.index;
        this._dragType = "center";
      } else {
        if (this.selectedIndex !== hit.index) {
          this.selectedIndex = hit.index;
        }
        this._dragType = hit.dir;
      }

      this._isDragging = true;
      this._previewSegments = null;
      this._previewSiblingSegments = null;
      this._dragStartX = x;
      this._dragInitialTimeline = targetArray.map(s => ({ ...s }));
      this._dragInitialSiblingTimeline = this.selectionType === "motion" ? null : (this.selectionType === "audio" ? this.timeline.segments : this.timeline.audioSegments).map(s => ({ ...s }));

      if (hit.type !== "joint") {
        this._dragTargetId = targetArray[hit.index].id;
      }
    }

    if (this.isPlaying) {
      this.pauseAudio();
    }

    this.render();
  }

  onMouseMove(e) {
    const { x: mouseX, y: mouseY } = this.getMousePos(e);

    if (this._h3RefDrag) {
      const drag = this._h3RefDrag;
      const dx = mouseX - drag.startX;
      const dy = mouseY - drag.startY;
      if (!drag.active && dx * dx + dy * dy < 16) return;
      drag.active = true;
      drag.x = mouseX;
      drag.y = mouseY;
      drag.over = this.h3RefInsertIndex(mouseX);
      this._isDragging = true;
      this._dragType = "h3_ref_sort";
      this.canvas.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
      this.render();
      return;
    }

    if (this._isSelectingBox && this._dragType === "box_select") {
      this.canvas.style.cursor = "crosshair";
      this._selectBoxCurrent = { x: mouseX, y: mouseY };
      this.updateSelectionFromBox();
      this.render();
      return;
    }

    if (this.retakeMode && !this._isDragging) {
      const visibleBottom = Math.min(this.canvasHeight, this.viewport.scrollTop + this.viewport.clientHeight);
      const isAtBottom = Math.abs(mouseY - visibleBottom) <= 15;
      const viewRect = this.viewport.getBoundingClientRect();
      const isAtRightEdge = Math.abs(e.clientX - viewRect.right) <= 20;

      if (isAtBottom) {
        this.canvas.style.cursor = "ns-resize";
        return;
      } else if (isAtRightEdge) {
        this.canvas.style.cursor = "ew-resize";
        return;
      }

      if (mouseY >= RULER_HEIGHT && mouseY <= RULER_HEIGHT + this.blockHeight) {
        const logicalWidth = this.canvas.offsetWidth;
        const totalFrames = this.getVisualDurationFrames();
        const retakeStart = this.timeline.retakeStart ?? 0;
        const baseVideoDur = this.timeline.retakeVideo?.videoDurationFrames ?? totalFrames;
        const retakeLength = this.timeline.retakeLength ?? baseVideoDur;

        const x1 = (retakeStart / totalFrames) * logicalWidth;
        const x2 = ((retakeStart + retakeLength) / totalFrames) * logicalWidth;
        const threshold = HANDLE_HIT_PX;

        if (Math.abs(mouseX - x1) <= threshold || Math.abs(mouseX - x2) <= threshold) {
          this.canvas.style.cursor = "ew-resize";
        } else if (mouseX > x1 && mouseX < x2) {
          this.canvas.style.cursor = "move";
        } else {
          this.canvas.style.cursor = "default";
        }
      } else if (mouseY < RULER_HEIGHT) {
        this.canvas.style.cursor = "ew-resize";
      } else {
        this.canvas.style.cursor = "default";
      }
      return;
    }

    if (!this._isDragging) {
      let newHoveredGapIdx = -1;
      const BTN_R = 12;
      const gapRegions = this.getGapRegions();
      for (let i = 0; i < gapRegions.length; i++) {
        const gap = gapRegions[i];
        if (gap.widthPx < BTN_R * 2 + 8) continue;
        const dx = mouseX - gap.centerX, dy2 = mouseY - gap.centerY;
        if (dx * dx + dy2 * dy2 <= BTN_R * BTN_R) { newHoveredGapIdx = i; break; }
      }
      if (this._hoveredGapIdx !== newHoveredGapIdx) {
        this._hoveredGapIdx = newHoveredGapIdx;
        this.render();
      }

      const refH = this.getRefTrackHeight();
      const mainTopY = this.getMainTrackTop();
      const isOverRefDivider = refH > 0 && Math.abs(mouseY - (RULER_HEIGHT + refH)) <= 8;
      const isOverDivider = Math.abs(mouseY - (mainTopY + this.blockHeight)) <= 8;
      const isOverAudioDivider = Math.abs(mouseY - (mainTopY + this.blockHeight + this.audioTrackHeight)) <= 8;
      const visibleBottom = Math.min(this.canvasHeight, this.viewport.scrollTop + this.viewport.clientHeight);
      const isAtBottom = Math.abs(mouseY - visibleBottom) <= 15;
      const viewRect = this.viewport.getBoundingClientRect();
      const isAtRightEdge = Math.abs(e.clientX - viewRect.right) <= 20;
      const hit = this.getHitTest(mouseX, mouseY);
      // 统一四轨光标：空白 default；可点/可控制 pointer；缩放保留 resize
      const refHit = refH > 0 ? this.hitH3RefTrack(mouseX, mouseY) : null;
      const multiAudHit =
        this.isH3MultiMode && this.isH3MultiMode()
          ? this.hitH3MultiMediaSlots(mouseX, mouseY, this._h3AudioLayout)
          : null;
      const multiVidHit =
        this.isH3MultiMode && this.isH3MultiMode()
          ? this.hitH3MultiMediaSlots(mouseX, mouseY, this._h3VideoLayout)
          : null;
      const isInteractiveSlot = (h) =>
        h && (h.type === "plus" || h.type === "x" || h.type === "img" || h.type === "add" || h.type === "play");
      // track 空白点可添加也算可控制
      const isMultiTrackClickable = (h) => h && (isInteractiveSlot(h) || h.type === "track");

      if (isOverRefDivider || isOverDivider || isOverAudioDivider || isAtBottom) {
        this.canvas.style.cursor = "ns-resize";
      } else if (isAtRightEdge) {
        this.canvas.style.cursor = "ew-resize";
      } else if (hit?.type === "edge" || hit?.type === "playhead") {
        this.canvas.style.cursor = "ew-resize";
      } else if (hit?.type === "joint") {
        this.canvas.style.cursor = "ew-resize";
      } else if (refHit?.type === "img") {
        this.canvas.style.cursor = "grab";
      } else if (
        newHoveredGapIdx >= 0 ||
        isInteractiveSlot(refHit) ||
        isMultiTrackClickable(refHit) ||
        isMultiTrackClickable(multiAudHit) ||
        isMultiTrackClickable(multiVidHit) ||
        hit?.type === "center" ||
        hit?.type === "ruler"
      ) {
        // 空隙+、多参槽、片段、标尺等可操作处：手指
        this.canvas.style.cursor = "pointer";
      } else {
        // 四轨空白：箭头
        this.canvas.style.cursor = "default";
      }
      return;
    }

    if (this.retakeMode && this._isDragging) {
      const totalFrames = this.getVisualDurationFrames();
      const logicalWidth = this.canvas.offsetWidth;
      const deltaX = mouseX - this._dragStartX;
      const deltaFrames = Math.round(deltaX * (totalFrames / logicalWidth));

      const frameRate = this.getFrameRate();

      // Handle playhead drag in retakeMode — the RAF loop is paused, so seek directly
      if (this._dragType === "playhead") {
        this.canvas.style.cursor = "ew-resize";
        let mouseFrameX = mouseX * (totalFrames / logicalWidth);
        mouseFrameX = this.getSnappedPlayhead(mouseFrameX, logicalWidth);
        const clampMax = this.timeline.retakeVideo ? (this.timeline.retakeVideo.videoDurationFrames || totalFrames) : totalFrames;
        this.currentFrame = clamp(mouseFrameX, 0, clampMax);
        if (this.timeline.retakeVideo && this.timeline.retakeVideo.videoEl) {
          this.timeline.retakeVideo.videoEl.currentTime = this.currentFrame / frameRate;
        }
        this.render();
        return;
      }

      if (this._dragType === "retake_left") {
        this.canvas.style.cursor = "ew-resize";
        let newStart = this._dragStartRetakeStart + deltaFrames;
        let newLength = this._dragStartRetakeLength - deltaFrames;

        if (this.isSnapping) {
          const thresholdFrames = (15 / logicalWidth) * totalFrames;
          const baseVideoDur = this.timeline.retakeVideo?.videoDurationFrames ?? totalFrames;
          const candidates = [0, this.currentFrame, baseVideoDur];
          let bestStart = newStart;
          let minDiff = thresholdFrames;
          for (const c of candidates) {
            const diff = Math.abs(newStart - c);
            if (diff < minDiff) {
              minDiff = diff;
              bestStart = c;
            }
          }
          if (bestStart !== newStart) {
            newStart = bestStart;
            newLength = this._dragStartRetakeStart + this._dragStartRetakeLength - newStart;
          }
        }

        if (newStart < 0) {
          newStart = 0;
          newLength = this._dragStartRetakeStart + this._dragStartRetakeLength;
        }
        if (newLength < MIN_SEGMENT_LENGTH) {
          newLength = MIN_SEGMENT_LENGTH;
          newStart = this._dragStartRetakeStart + this._dragStartRetakeLength - MIN_SEGMENT_LENGTH;
        }

        this.timeline.retakeStart = newStart;
        this.timeline.retakeLength = newLength;

        if (this.timeline.retakeVideo && this.timeline.retakeVideo.videoEl) {
          this.timeline.retakeVideo.videoEl.currentTime = newStart / frameRate;
        }

        this.render();
        this.updateUIFromSelection();
        return;
      }

      if (this._dragType === "retake_right") {
        this.canvas.style.cursor = "ew-resize";
        let newLength = this._dragStartRetakeLength + deltaFrames;

        const baseVideoDur = this.timeline.retakeVideo?.videoDurationFrames ?? totalFrames;
        let newEnd = this._dragStartRetakeStart + newLength;

        if (this.isSnapping) {
          const thresholdFrames = (15 / logicalWidth) * totalFrames;
          const candidates = [0, this.currentFrame, baseVideoDur];
          let bestEnd = newEnd;
          let minDiff = thresholdFrames;
          for (const c of candidates) {
            const diff = Math.abs(newEnd - c);
            if (diff < minDiff) {
              minDiff = diff;
              bestEnd = c;
            }
          }
          if (bestEnd !== newEnd) {
            newEnd = bestEnd;
            newLength = newEnd - this._dragStartRetakeStart;
          }
        }

        if (this._dragStartRetakeStart + newLength > baseVideoDur) {
          newLength = baseVideoDur - this._dragStartRetakeStart;
        }
        if (newLength < MIN_SEGMENT_LENGTH) {
          newLength = MIN_SEGMENT_LENGTH;
        }

        this.timeline.retakeLength = newLength;

        if (this.timeline.retakeVideo && this.timeline.retakeVideo.videoEl) {
          this.timeline.retakeVideo.videoEl.currentTime = (this.timeline.retakeStart + newLength) / frameRate;
        }

        this.render();
        this.updateUIFromSelection();
        return;
      }

      if (this._dragType === "retake_center") {
        this.canvas.style.cursor = "grabbing";
        let newStart = this._dragStartRetakeStart + deltaFrames;

        if (this.isSnapping) {
          const thresholdFrames = (15 / logicalWidth) * totalFrames;
          const baseVideoDur = this.timeline.retakeVideo?.videoDurationFrames ?? totalFrames;
          const candidates = [0, this.currentFrame, baseVideoDur];
          let bestStart = newStart;
          let minDiff = thresholdFrames;

          for (const c of candidates) {
            const diffLeft = Math.abs(newStart - c);
            if (diffLeft < minDiff) {
              minDiff = diffLeft;
              bestStart = c;
            }
            const diffRight = Math.abs((newStart + this._dragStartRetakeLength) - c);
            if (diffRight < minDiff) {
              minDiff = diffRight;
              bestStart = c - this._dragStartRetakeLength;
            }
          }
          newStart = bestStart;
        }

        if (newStart < 0) {
          newStart = 0;
        }
        const baseVideoDur = this.timeline.retakeVideo?.videoDurationFrames ?? totalFrames;
        if (newStart + this._dragStartRetakeLength > baseVideoDur) {
          newStart = baseVideoDur - this._dragStartRetakeLength;
        }

        this.timeline.retakeStart = newStart;

        if (this.timeline.retakeVideo && this.timeline.retakeVideo.videoEl) {
          this.timeline.retakeVideo.videoEl.currentTime = newStart / frameRate;
        }

        this.render();
        this.updateUIFromSelection();
        return;
      }
    }

    if (this._dragType === "ref_divider") {
      this.canvas.style.cursor = "ns-resize";
      const deltaY = mouseY - this._startY;
      let newRefH = Math.max(50, Math.min(280, (this._startRefTrackHeight || 96) + deltaY));
      this.refTrackHeight = newRefH;
      this.canvasHeight =
        RULER_HEIGHT +
        this.refTrackHeight +
        this.blockHeight +
        (this.audioTrackHeight || 0) +
        (this.motionTrackHeight || 0);
      if (this.canvas) this.canvas.style.height = `${this.canvasHeight}px`;
      if (this.viewport) {
        this.viewport.style.height = `${this.canvasHeight}px`;
        this.viewport.style.minHeight = `${this.canvasHeight}px`;
      }
      this.updateSidebarHeights();
      this.resizeCanvas?.(this.canvas.offsetWidth);
      this.render();
      return;
    }

    if (this._dragType === "divider") {
      this.canvas.style.cursor = "ns-resize";
      const deltaY = mouseY - this._startY;

      const minBlockH = 50;
      const minAudioH = 50;

      let newBlockHeight = this._startBlockHeight + deltaY;
      let newAudioTrackHeight = this._startAudioTrackHeight - deltaY;

      if (newBlockHeight < minBlockH) {
        newBlockHeight = minBlockH;
        newAudioTrackHeight = this._startBlockHeight + this._startAudioTrackHeight - minBlockH;
      }
      if (newAudioTrackHeight < minAudioH) {
        newAudioTrackHeight = minAudioH;
        newBlockHeight = this._startBlockHeight + this._startAudioTrackHeight - minAudioH;
      }

      this.blockHeight = newBlockHeight;
      this.audioTrackHeight = newAudioTrackHeight;

      this.updateSidebarHeights();
      this.render();
      return;
    }

    if (this._dragType === "audio_divider") {
      this.canvas.style.cursor = "ns-resize";
      const deltaY = mouseY - this._startY;

      const minMotionH = 50;
      const minAudioH = 50;

      // Divider moves down: audio gets bigger, motion gets smaller
      let newAudioTrackHeight = this._startAudioTrackHeight + deltaY;
      let newMotionTrackHeight = this._startMotionTrackHeight - deltaY;

      if (newAudioTrackHeight < minAudioH) {
        newAudioTrackHeight = minAudioH;
        newMotionTrackHeight = this._startAudioTrackHeight + this._startMotionTrackHeight - minAudioH;
      }
      if (newMotionTrackHeight < minMotionH) {
        newMotionTrackHeight = minMotionH;
        newAudioTrackHeight = this._startAudioTrackHeight + this._startMotionTrackHeight - minMotionH;
      }

      this.motionTrackHeight = newMotionTrackHeight;
      this.audioTrackHeight = newAudioTrackHeight;

      this.updateSidebarHeights();
      this.render();
      return;
    }

    if (this._dragType === "height_resize") {
      this.canvas.style.cursor = "ns-resize";
      const deltaY = mouseY - this._startY;

      this.blockHeight = Math.max(100, this._startBlockHeight + deltaY);
      this.canvasHeight =
        this.rulerHeight +
        (this.refTrackHeight || 0) +
        this.blockHeight +
        this.motionTrackHeight +
        this.audioTrackHeight;

      this.canvas.style.height = `${this.canvasHeight}px`;

      this.resizeCanvas(this.canvas.offsetWidth);
      this.updateSidebarHeights();
      this.render();

      if (this.node && this.node.computeSize) {
        const sz = this.node.computeSize();
        this.node.size[1] = sz[1];
        if (window.app && window.app.graph) {
          window.app.graph.setDirtyCanvas(true, true);
        }
      }
      return;
    }

    if (this._dragType === "width_resize") {
      this.canvas.style.cursor = "ew-resize";
      const deltaX = e.clientX - this._startX;

      this.node.size[0] = Math.max(300, this._startNodeWidth + deltaX);

      if (window.app && window.app.graph) {
        window.app.graph.setDirtyCanvas(true, true);
      }
      return;
    }

    if (this._dragType === "playhead") {
      this.canvas.style.cursor = "ew-resize";
      const logicalWidth = this.canvas.offsetWidth;
      const totalFrames = this.getVisualDurationFrames();
      const playbackFrames = this.getPlaybackDurationFrames();
      let mouseFrameX = mouseX * (totalFrames / logicalWidth);
      mouseFrameX = this.getSnappedPlayhead(mouseFrameX, logicalWidth);
      this.currentFrame = clamp(mouseFrameX, 0, playbackFrames);
      this._liveScrubPlayhead();
      this.render();
      if (this.isPlaying) {
        this.playAudio(); // Scrub (restart from new position)
      }
      return;
    }

    if (this._multiDragInitialSegments) {
      this.canvas.style.cursor = "grabbing";
      this._isMultiDraggingAndMoved = true;

      const logicalWidth = this.canvas.offsetWidth;
      const totalFrames = this.getVisualDurationFrames();
      const durationFrames = totalFrames;
      let dragDelta = Math.round((mouseX - this._dragStartX) * (totalFrames / logicalWidth));

      const selectedIds = this.selectedSegmentIds;

      // Group Blocking Physics Calculation
      let maxLeftShift = Infinity;
      let maxRightShift = Infinity;

      for (const track of ["image", "motion", "audio"]) {
        const allTrackSegs = this._multiDragInitialSegments[track];
        if (!allTrackSegs) continue;
        const selectedOnTrack = allTrackSegs.filter(s => selectedIds.includes(s.id));
        const nonSelectedOnTrack = allTrackSegs.filter(s => !selectedIds.includes(s.id));

        if (selectedOnTrack.length === 0) continue;

        for (const S of selectedOnTrack) {
          // Find closest non-selected segment to the left on the same track
          let closestLeftEnd = 0;
          for (const L of nonSelectedOnTrack) {
            if (L.start + L.length <= S.start) {
              closestLeftEnd = Math.max(closestLeftEnd, L.start + L.length);
            }
          }
          const spaceLeft = S.start - closestLeftEnd;
          maxLeftShift = Math.min(maxLeftShift, spaceLeft);

          // Find closest non-selected segment to the right on the same track
          let closestRightStart = durationFrames;
          for (const R of nonSelectedOnTrack) {
            if (R.start >= S.start + S.length) {
              closestRightStart = Math.min(closestRightStart, R.start);
            }
          }
          const spaceRight = closestRightStart - (S.start + S.length);
          maxRightShift = Math.min(maxRightShift, spaceRight);
        }
      }

      // Clamp drag delta
      let clampedDragDelta = clamp(dragDelta, -maxLeftShift, maxRightShift);

      // Apply snapping if active
      if (this.isSnapping) {
        const thresholdFrames = (15 / logicalWidth) * totalFrames;
        let bestAdjustment = null;
        let minDiff = thresholdFrames;

        // Collect snap candidates
        const snapCandidates = [0, this.getDurationFrames(), this.getStartFrames(), this.currentFrame];
        if (this.endFramesWidget && this.endFramesWidget.value !== undefined) {
          snapCandidates.push(parseInt(this.endFramesWidget.value, 10));
        }

        for (const track of ["image", "motion", "audio"]) {
          const allTrackSegs = this._multiDragInitialSegments[track];
          if (!allTrackSegs) continue;
          const nonSelectedOnTrack = allTrackSegs.filter(s => !selectedIds.includes(s.id));
          for (const L of nonSelectedOnTrack) {
            snapCandidates.push(L.start);
            snapCandidates.push(L.start + L.length);
          }
        }

        // Test all selected segments against candidates
        for (const track of ["image", "motion", "audio"]) {
          const allTrackSegs = this._multiDragInitialSegments[track];
          if (!allTrackSegs) continue;
          const selectedOnTrack = allTrackSegs.filter(s => selectedIds.includes(s.id));
          for (const S of selectedOnTrack) {
            const targetStart = S.start + clampedDragDelta;
            const targetEnd = S.start + S.length + clampedDragDelta;

            for (const cand of snapCandidates) {
              // Check start edge
              const diffStart = cand - targetStart;
              if (Math.abs(diffStart) < minDiff) {
                minDiff = Math.abs(diffStart);
                bestAdjustment = diffStart;
              }
              // Check end edge
              const diffEnd = cand - targetEnd;
              if (Math.abs(diffEnd) < minDiff) {
                minDiff = Math.abs(diffEnd);
                bestAdjustment = diffEnd;
              }
            }
          }
        }

        if (bestAdjustment !== null) {
          const adjustedDelta = clampedDragDelta + bestAdjustment;
          if (adjustedDelta >= -maxLeftShift && adjustedDelta <= maxRightShift) {
            clampedDragDelta = adjustedDelta;
          }
        }
      }

      // Compute previews
      this._multiDragPreviewTimelines = {
        image: this._multiDragInitialSegments.image.map(s => {
          if (selectedIds.includes(s.id)) {
            return { ...s, start: s.start + clampedDragDelta };
          }
          return s;
        }),
        motion: this._multiDragInitialSegments.motion.map(s => {
          if (selectedIds.includes(s.id)) {
            return { ...s, start: s.start + clampedDragDelta };
          }
          return s;
        }),
        audio: this._multiDragInitialSegments.audio.map(s => {
          if (selectedIds.includes(s.id)) {
            return { ...s, start: s.start + clampedDragDelta };
          }
          return s;
        })
      };

      // Scrub support for video segments being moved
      for (const track of ["image", "motion"]) {
        const prevSegs = this._multiDragPreviewTimelines[track];
        for (const s of prevSegs) {
          if (selectedIds.includes(s.id) && (s.type === "video" || s.type === "motion_video")) {
            this._liveScrubVideo(s, "start");
          }
        }
      }

      this.render();
      return;
    }

    this.canvas.style.cursor = this._dragType === "center" ? "grabbing" :
      this._dragType === "joint" ? "col-resize" : "ew-resize";

    const logicalWidth = this.canvas.offsetWidth;
    const totalFrames = this.getVisualDurationFrames();
    const durationFrames = totalFrames;
    let dragDelta = Math.round((mouseX - this._dragStartX) * (totalFrames / logicalWidth));

    let t = this._dragInitialTimeline.map(s => ({ ...s }));

    // --- Rolling Edit (Slide Edit) ---
    if (this._dragType === "joint") {
      let leftIdx = t.findIndex(s => s.id === this._dragTargetId);
      let rightIdx = t.findIndex(s => s.id === this._dragTargetIdRight);

      if (leftIdx >= 0 && rightIdx >= 0) {
        let origLeft = this._dragInitialTimeline.find(s => s.id === this._dragTargetId);
        let origRight = this._dragInitialTimeline.find(s => s.id === this._dragTargetIdRight);

        let maxDeltaRight = origRight.length - MIN_SEGMENT_LENGTH;
        let maxDeltaLeft = origLeft.length - MIN_SEGMENT_LENGTH;

        if (this.selectionType === "audio" || origRight.type === "video") {
          // Drag LEFT: right clip extends left by un-trimming its head.
          // Can only un-trim as much as the right clip has been trimmed (trimStart >= 0).
          maxDeltaLeft = Math.min(maxDeltaLeft, origRight.trimStart || 0);
        }
        if (this.selectionType === "audio" || origLeft.type === "video") {
          // Drag RIGHT: left clip extends right by consuming its remaining tail audio.
          // Can only extend as far as the left clip's unplayed tail allows.
          let origDur = origLeft.audioDurationFrames || origLeft.videoDurationFrames || origLeft.length;
          let availLeftTail = origDur - ((origLeft.trimStart || 0) + origLeft.length);
          maxDeltaRight = Math.min(maxDeltaRight, availLeftTail);
        }

        // Apply snapping to the shared boundary position
        if (this.isSnapping) {
          const thresholdFrames = (15 / logicalWidth) * totalFrames;
          const jointPos = origLeft.start + origLeft.length + dragDelta;
          let bestJoint = jointPos;
          let minDiff = thresholdFrames;

          const snapCandidates = [0, this.getDurationFrames(), this.currentFrame];
          snapCandidates.push(this.getStartFrames());
          if (this.endFramesWidget && this.endFramesWidget.value !== undefined) {
            snapCandidates.push(parseInt(this.endFramesWidget.value, 10));
          }
          const allTracks = [
            this.timeline.segments || [],
            this.timeline.motionSegments || [],
            this.timeline.audioSegments || []
          ];
          const ignoreIds = [String(this._dragTargetId), String(this._dragTargetIdRight)];
          for (const track of allTracks) {
            for (const seg of track) {
              if (ignoreIds.includes(String(seg.id))) continue;
              snapCandidates.push(seg.start);
              snapCandidates.push(seg.start + seg.length);
            }
          }

          for (const candidate of snapCandidates) {
            const diff = Math.abs(jointPos - candidate);
            if (diff < minDiff) {
              minDiff = diff;
              bestJoint = candidate;
            }
          }
          dragDelta = bestJoint - (origLeft.start + origLeft.length);
        }

        let safeDelta = clamp(dragDelta, -maxDeltaLeft, maxDeltaRight);

        t[leftIdx].length = origLeft.length + safeDelta;
        t[rightIdx].start = origRight.start + safeDelta;
        t[rightIdx].length = origRight.length - safeDelta;

        if (this.selectionType === "audio" || t[rightIdx].type === "video") {
          t[rightIdx].trimStart = origRight.trimStart + safeDelta;
        }
      }
    }
    // --- Edge & Center Drags ---
    else {
      const targetIdx = t.findIndex((s) => s.id === this._dragTargetId);
      if (targetIdx < 0) return;

      if (this._dragType === "right") {
        let newLen = t[targetIdx].length + dragDelta;
        if (this.isSnapping) {
          const thresholdFrames = (15 / logicalWidth) * totalFrames;
          const targetEnd = t[targetIdx].start + newLen;
          let bestEnd = targetEnd;
          let minDiff = thresholdFrames;

          const snapCandidates = [0, this.getDurationFrames(), this.currentFrame];
          // Add start and end frames of active generation range
          snapCandidates.push(this.getStartFrames());
          if (this.endFramesWidget && this.endFramesWidget.value !== undefined) {
            snapCandidates.push(parseInt(this.endFramesWidget.value, 10));
          }
          const allTracks = [
            this.timeline.segments || [],
            this.timeline.motionSegments || [],
            this.timeline.audioSegments || []
          ];
          const ignoreSegmentIds = [String(this._dragTargetId)];
          const isVid = String(this._dragTargetId).endsWith("_v");
          const isAud = String(this._dragTargetId).endsWith("_a");
          if (isVid || isAud) {
            const siblingId = isVid ? String(this._dragTargetId).slice(0, -2) + "_a" : String(this._dragTargetId).slice(0, -2) + "_v";
            ignoreSegmentIds.push(siblingId);
          }

          for (const track of allTracks) {
            for (const seg of track) {
              if (ignoreSegmentIds.includes(String(seg.id))) continue;
              snapCandidates.push(seg.start);
              snapCandidates.push(seg.start + seg.length);
            }
          }

          for (const candidate of snapCandidates) {
            const diff = Math.abs(targetEnd - candidate);
            if (diff < minDiff) {
              minDiff = diff;
              bestEnd = candidate;
            }
          }
          newLen = bestEnd - t[targetIdx].start;
          dragDelta = newLen - t[targetIdx].length;
        }
        let maxPossibleLength = totalFrames - t[targetIdx].start;
        let nextSeg = t.find(s => s.start >= t[targetIdx].start + t[targetIdx].length && s.id !== t[targetIdx].id);
        if (nextSeg) {
          maxPossibleLength = nextSeg.start - t[targetIdx].start;
        }

        // Check sibling track obstacles if linked
        const isVid = String(this._dragTargetId).endsWith("_v");
        const isAud = String(this._dragTargetId).endsWith("_a");
        const siblingId = (isVid || isAud) ? (isVid ? String(this._dragTargetId).slice(0, -2) + "_a" : String(this._dragTargetId).slice(0, -2) + "_v") : null;
        if (siblingId && this._dragInitialSiblingTimeline) {
          let nextSibSeg = this._dragInitialSiblingTimeline.find(s => s.start >= t[targetIdx].start + t[targetIdx].length && s.id !== siblingId);
          if (nextSibSeg) {
            let sibMaxPossible = nextSibSeg.start - t[targetIdx].start;
            maxPossibleLength = Math.min(maxPossibleLength, sibMaxPossible);
          }
        }

        if (this.selectionType === "audio" || t[targetIdx].type === "video" || t[targetIdx].type === "motion_video") {
          const origDur = t[targetIdx].audioDurationFrames || t[targetIdx].videoDurationFrames || t[targetIdx].length;
          maxPossibleLength = Math.min(maxPossibleLength, origDur - (t[targetIdx].trimStart || 0));
        }

        t[targetIdx].length = Math.max(MIN_SEGMENT_LENGTH, Math.min(newLen, maxPossibleLength));

      } else if (this._dragType === "left") {
        let newStart = t[targetIdx].start + dragDelta;
        if (this.isSnapping) {
          const thresholdFrames = (15 / logicalWidth) * totalFrames;
          let bestStart = newStart;
          let minDiff = thresholdFrames;

          const snapCandidates = [0, this.getDurationFrames(), this.currentFrame];
          // Add start and end frames of active generation range
          snapCandidates.push(this.getStartFrames());
          if (this.endFramesWidget && this.endFramesWidget.value !== undefined) {
            snapCandidates.push(parseInt(this.endFramesWidget.value, 10));
          }
          const allTracks = [
            this.timeline.segments || [],
            this.timeline.motionSegments || [],
            this.timeline.audioSegments || []
          ];
          const ignoreSegmentIds = [String(this._dragTargetId)];
          const isVid = String(this._dragTargetId).endsWith("_v");
          const isAud = String(this._dragTargetId).endsWith("_a");
          if (isVid || isAud) {
            const siblingId = isVid ? String(this._dragTargetId).slice(0, -2) + "_a" : String(this._dragTargetId).slice(0, -2) + "_v";
            ignoreSegmentIds.push(siblingId);
          }

          for (const track of allTracks) {
            for (const seg of track) {
              if (ignoreSegmentIds.includes(String(seg.id))) continue;
              snapCandidates.push(seg.start);
              snapCandidates.push(seg.start + seg.length);
            }
          }

          for (const candidate of snapCandidates) {
            const diff = Math.abs(newStart - candidate);
            if (diff < minDiff) {
              minDiff = diff;
              bestStart = candidate;
            }
          }
          newStart = bestStart;
          dragDelta = newStart - t[targetIdx].start;
        }
        let minPossibleStart = 0;
        let prevSeg = t.slice().reverse().find(s => s.start + s.length <= t[targetIdx].start && s.id !== t[targetIdx].id);
        if (prevSeg) {
          minPossibleStart = prevSeg.start + prevSeg.length;
        }

        // Check sibling track obstacles if linked
        const isVid = String(this._dragTargetId).endsWith("_v");
        const isAud = String(this._dragTargetId).endsWith("_a");
        const siblingId = (isVid || isAud) ? (isVid ? String(this._dragTargetId).slice(0, -2) + "_a" : String(this._dragTargetId).slice(0, -2) + "_v") : null;
        if (siblingId && this._dragInitialSiblingTimeline) {
          let prevSibSeg = this._dragInitialSiblingTimeline.slice().reverse().find(s => s.start + s.length <= t[targetIdx].start && s.id !== siblingId);
          if (prevSibSeg) {
            let sibMinPossible = prevSibSeg.start + prevSibSeg.length;
            minPossibleStart = Math.max(minPossibleStart, sibMinPossible);
          }
        }

        if (this.selectionType === "audio" || t[targetIdx].type === "video" || t[targetIdx].type === "motion_video") {
          minPossibleStart = Math.max(minPossibleStart, t[targetIdx].start - (t[targetIdx].trimStart || 0));
        }

        let maxStart = t[targetIdx].start + t[targetIdx].length - MIN_SEGMENT_LENGTH;
        newStart = Math.max(minPossibleStart, Math.min(newStart, maxStart));

        let diff = newStart - t[targetIdx].start;
        t[targetIdx].start = newStart;
        t[targetIdx].length -= diff;
        if (this.selectionType === "audio" || t[targetIdx].type === "video" || t[targetIdx].type === "motion_video") {
          t[targetIdx].trimStart += diff;
        }

      } else if (this._dragType === "center") {
        let initT = this._dragInitialTimeline;
        let dIdx = initT.findIndex(s => s.id === this._dragTargetId);
        if (dIdx < 0) return;
        let D = { ...initT[dIdx] };

        let D_mouse_start = D.start + dragDelta;
        let mouseFrameX = mouseX * (totalFrames / logicalWidth);

        if (this.isSnapping) {
          const thresholdFrames = (15 / logicalWidth) * totalFrames;
          let bestStart = D_mouse_start;
          let minDiff = thresholdFrames;

          const snapCandidates = [0, this.getDurationFrames(), this.currentFrame];
          // Add start and end frames of active generation range
          snapCandidates.push(this.getStartFrames());
          if (this.endFramesWidget && this.endFramesWidget.value !== undefined) {
            snapCandidates.push(parseInt(this.endFramesWidget.value, 10));
          }
          const allTracks = [
            this.timeline.segments || [],
            this.timeline.motionSegments || [],
            this.timeline.audioSegments || []
          ];
          const ignoreSegmentIds = [String(this._dragTargetId)];
          const isVid = String(this._dragTargetId).endsWith("_v");
          const isAud = String(this._dragTargetId).endsWith("_a");
          if (isVid || isAud) {
            const siblingId = isVid ? String(this._dragTargetId).slice(0, -2) + "_a" : String(this._dragTargetId).slice(0, -2) + "_v";
            ignoreSegmentIds.push(siblingId);
          }

          for (const track of allTracks) {
            for (const seg of track) {
              if (ignoreSegmentIds.includes(String(seg.id))) continue;
              snapCandidates.push(seg.start);
              snapCandidates.push(seg.start + seg.length);
            }
          }

          for (const candidate of snapCandidates) {
            // Check start snap
            const diffStart = Math.abs(D_mouse_start - candidate);
            if (diffStart < minDiff) {
              minDiff = diffStart;
              bestStart = candidate;
            }
            // Check end snap
            const diffEnd = Math.abs((D_mouse_start + D.length) - candidate);
            if (diffEnd < minDiff) {
              minDiff = diffEnd;
              bestStart = candidate - D.length;
            }
          }
          const rawStart = D_mouse_start;
          D_mouse_start = bestStart;
          const snapOffset = D_mouse_start - rawStart;
          dragDelta = D_mouse_start - D.start;
          mouseFrameX += snapOffset;
        }

        t = this._applyCenterDragPhysics(initT, D.id, D_mouse_start, mouseFrameX, durationFrames, totalFrames, logicalWidth);

        if (this._dragInitialSiblingTimeline) {
          let siblingPhysics = null;

          if (this._dragTargetId.endsWith("_v") || this._dragTargetId.endsWith("_a")) {
            const isVid = this._dragTargetId.endsWith("_v");
            const siblingId = isVid ? this._dragTargetId.slice(0, -2) + "_a" : this._dragTargetId.slice(0, -2) + "_v";
            siblingPhysics = this._applyCenterDragPhysics(this._dragInitialSiblingTimeline, siblingId, D_mouse_start, mouseFrameX, durationFrames, totalFrames, logicalWidth);

            // Ensure initial sync for the dragged segment so the solver starts from a good state
            const activeFinal = t.find(s => s.id === this._dragTargetId);
            const siblingFinal = siblingPhysics.find(s => s.id === siblingId);

            if (activeFinal && siblingFinal && activeFinal.start !== siblingFinal.start) {
              const origStart = D.start;
              const activeDelta = Math.abs(activeFinal.start - origStart);
              const siblingDelta = Math.abs(siblingFinal.start - origStart);
              const finalStart = activeDelta < siblingDelta ? activeFinal.start : siblingFinal.start;

              const finalMouseX = finalStart + D.length / 2;
              t = this._applyCenterDragPhysics(initT, D.id, finalStart, finalMouseX, durationFrames, totalFrames, logicalWidth, true);
              siblingPhysics = this._applyCenterDragPhysics(this._dragInitialSiblingTimeline, siblingId, finalStart, finalMouseX, durationFrames, totalFrames, logicalWidth, true);
            }
          } else {
            siblingPhysics = this._dragInitialSiblingTimeline.map(s => ({ ...s }));
          }

          // Resolve all secondary pushes to keep linked clips together
          this._resolveGlobalPhysics(t, siblingPhysics, durationFrames, initT, this._dragInitialSiblingTimeline);
          this._previewSiblingSegments = siblingPhysics;
        }
      }
    }

    const targetArray = this.getSegmentArray(this.selectionType);
    this._restoreTransientProperties(t, targetArray);

    if (this._dragType === "left") {
      this._liveScrubVideo(t.find(s => s.id === this._dragTargetId), "start");
    } else if (this._dragType === "right") {
      this._liveScrubVideo(t.find(s => s.id === this._dragTargetId), "end");
    } else if (this._dragType === "joint") {
      this._liveScrubVideo(t.find(s => s.id === this._dragTargetId), "end");
      this._liveScrubVideo(t.find(s => s.id === this._dragTargetIdRight), "start");
    }

    const syncSibling = (targetId, activeArray) => {
      if (!targetId || this._dragType === "center") return; // Center drag handles physics separately above
      const isVid = targetId.endsWith("_v");
      const isAud = targetId.endsWith("_a");
      if (!isVid && !isAud) return;

      const siblingId = isVid ? targetId.slice(0, -2) + "_a" : targetId.slice(0, -2) + "_v";
      if (!this._previewSiblingSegments) {
        this._previewSiblingSegments = this._dragInitialSiblingTimeline.map(s => ({ ...s }));
      }
      const sibling = this._previewSiblingSegments.find(s => s.id === siblingId);
      const active = activeArray.find(s => s.id === targetId);

      if (sibling && active) {
        sibling.start = active.start;
        sibling.length = active.length;
        if (active.trimStart !== undefined) sibling.trimStart = active.trimStart;
      }
    };

    syncSibling(this._dragTargetId, t);
    if (this._dragType === "joint") syncSibling(this._dragTargetIdRight, t);

    this._previewSegments = t;

    if (this._previewSiblingSegments) {
      let siblingArray = null;
      if (this.selectionType === "audio") siblingArray = this.timeline.segments;
      else if (this.selectionType === "image") siblingArray = this.timeline.audioSegments;
      if (siblingArray) {
        this._restoreTransientProperties(this._previewSiblingSegments, siblingArray);
      }
    }

    this.updateUIFromSelection(); // Live update of trim values
    this.render();
  }

  _applyCenterDragPhysics(initT, D_id, D_mouse_start, mouseFrameX, durationFrames, totalFrames, logicalWidth, forceStart = false) {
    let t_copy = initT.map(s => ({ ...s }));
    let dIdx = t_copy.findIndex(s => s.id === D_id);
    if (dIdx < 0) return t_copy;

    let D = t_copy[dIdx];
    let D_clamped_start = clamp(D_mouse_start, 0, durationFrames - D.length);

    let baseSegments = t_copy.filter(s => s.id !== D.id);

    let insertIdx = baseSegments.length;
    for (let i = 0; i < baseSegments.length; i++) {
      let centerBase = baseSegments[i].start + baseSegments[i].length / 2;
      if (mouseFrameX < centerBase) {
        insertIdx = i;
        break;
      }
    }

    if (!forceStart) {
      let leftBound = insertIdx > 0 ? baseSegments[insertIdx - 1].start + baseSegments[insertIdx - 1].length : 0;
      let rightBound = insertIdx < baseSegments.length ? baseSegments[insertIdx].start : durationFrames;

      if (rightBound - leftBound >= D.length) {
        D_clamped_start = clamp(D_clamped_start, leftBound, rightBound - D.length);
      } else {
        let gapCenter = (leftBound + rightBound) / 2;
        D_clamped_start = gapCenter - D.length / 2;
      }
    }

    let t_test = [];
    for (let i = 0; i < insertIdx; i++) {
      t_test.push({ ...baseSegments[i], original_start: baseSegments[i].start });
    }
    t_test.push({ ...D, start: D_clamped_start, original_start: D_clamped_start });
    let D_index = insertIdx;

    for (let i = insertIdx; i < baseSegments.length; i++) {
      t_test.push({ ...baseSegments[i], original_start: baseSegments[i].start });
    }

    for (let i = D_index + 1; i < t_test.length; i++) {
      let prev = t_test[i - 1];
      t_test[i].start = Math.max(t_test[i].original_start, prev.start + prev.length);
    }

    for (let i = D_index - 1; i >= 0; i--) {
      let next = t_test[i + 1];
      t_test[i].start = Math.min(t_test[i].original_start, next.start - t_test[i].length);
    }

    let rightCursor = durationFrames;
    for (let i = t_test.length - 1; i >= 0; i--) {
      if (t_test[i].start + t_test[i].length > rightCursor) {
        t_test[i].start = rightCursor - t_test[i].length;
      }
      rightCursor = t_test[i].start;
    }
    let leftCursor = 0;
    for (let i = 0; i < t_test.length; i++) {
      if (t_test[i].start < leftCursor) {
        t_test[i].start = leftCursor;
      }
      leftCursor = t_test[i].start + t_test[i].length;
    }

    let result = t_test.map(s => {
      let clean = { ...s };
      delete clean.original_start;
      return clean;
    });

    let draggedPreview = result.find(s => s.id === D.id);
    if (draggedPreview) {
      draggedPreview.resolvedStart = draggedPreview.start;
    }

    return result;
  }

  _resolveGlobalPhysics(activeTimeline, siblingTimeline, durationFrames, activeInitial, siblingInitial) {
    if (!siblingTimeline) return;

    let changed = true;
    let iters = 0;
    while (changed && iters < 10) {
      changed = false;
      iters++;

      let syncedActiveIndices = [];
      let syncedSiblingIndices = [];

      // 1. Sync linked clips
      for (let i = 0; i < activeTimeline.length; i++) {
        let seg = activeTimeline[i];
        if (seg.id.endsWith("_v") || seg.id.endsWith("_a")) {
          const isVid = seg.id.endsWith("_v");
          const sibId = isVid ? seg.id.slice(0, -2) + "_a" : seg.id.slice(0, -2) + "_v";
          let sibIndex = siblingTimeline.findIndex(s => s.id === sibId);

          if (sibIndex >= 0) {
            let sib = siblingTimeline[sibIndex];
            if (sib.start !== seg.start) {
              let origStart = seg.start;
              if (activeInitial) {
                const origSeg = activeInitial.find(s => s.id === seg.id);
                if (origSeg) origStart = origSeg.start;
              }

              let sibOrigStart = sib.start;
              if (siblingInitial) {
                const origSib = siblingInitial.find(s => s.id === sib.id);
                if (origSib) sibOrigStart = origSib.start;
              }

              const dSeg = Math.abs(seg.start - origStart);
              const dSib = Math.abs(sib.start - sibOrigStart);

              // The segment that was pushed furthest dictates the new position
              const targetStart = dSeg > dSib ? seg.start : sib.start;

              if (seg.start !== targetStart) {
                seg.start = targetStart;
                changed = true;
                syncedActiveIndices.push(i);
              }
              if (sib.start !== targetStart) {
                sib.start = targetStart;
                changed = true;
                syncedSiblingIndices.push(sibIndex);
              }
            }
          }
        }
      }

      // 2. Resolve overlaps on both tracks by pushing outward from epicenters
      if (changed) {
        const sweepTrack = (track, epicenterIndices) => {
          let didChange = false;

          for (let epIndex of epicenterIndices) {
            // Push elements to the right of the epicenter
            for (let i = epIndex + 1; i < track.length; i++) {
              let prev = track[i - 1];
              let targetStart = prev.start + prev.length;
              if (track[i].start < targetStart) {
                track[i].start = targetStart;
                didChange = true;
              }
            }
            // Push elements to the left of the epicenter
            for (let i = epIndex - 1; i >= 0; i--) {
              let next = track[i + 1];
              let targetStart = next.start - track[i].length;
              if (track[i].start > targetStart) {
                track[i].start = targetStart;
                didChange = true;
              }
            }
          }

          // Boundary clamping to ensure nothing falls off the edges
          let rightCursor = durationFrames;
          for (let i = track.length - 1; i >= 0; i--) {
            if (track[i].start + track[i].length > rightCursor) {
              let newStart = rightCursor - track[i].length;
              if (track[i].start !== newStart) { track[i].start = newStart; didChange = true; }
            }
            rightCursor = track[i].start;
          }

          let leftCursor = 0;
          for (let i = 0; i < track.length; i++) {
            if (track[i].start < leftCursor) {
              let newStart = leftCursor;
              if (track[i].start !== newStart) { track[i].start = newStart; didChange = true; }
            }
            leftCursor = track[i].start + track[i].length;
          }
          return didChange;
        };

        sweepTrack(activeTimeline, syncedActiveIndices);
        sweepTrack(siblingTimeline, syncedSiblingIndices);
      }
    }
  }

  _restoreTransientProperties(copiedSegs, originalSegs) {
    if (!copiedSegs || !originalSegs) return;
    for (let ps of copiedSegs) {
      const orig = originalSegs.find(s => s.id === ps.id);
      if (orig) {
        if (orig._uploading !== undefined) ps._uploading = orig._uploading;
        if (orig._decoding !== undefined) ps._decoding = orig._decoding;
        if (orig._blobUrl !== undefined) ps._blobUrl = orig._blobUrl;
        if (orig._audioBuffer !== undefined) ps._audioBuffer = orig._audioBuffer;
        if (orig.imgObj !== undefined) ps.imgObj = orig.imgObj;
        if (orig.videoEl !== undefined) ps.videoEl = orig.videoEl;
        if (orig.thumbnails !== undefined) ps.thumbnails = orig.thumbnails;
        if (orig._extractingThumbs !== undefined) ps._extractingThumbs = orig._extractingThumbs;
      }
    }
  }

  onMouseUp(e) {
    document.body.style.userSelect = "";
    document.body.style.cursor = "";

    if (this._h3RefDrag) {
      const drag = this._h3RefDrag;
      this._h3RefDrag = null;
      this._isDragging = false;
      this._dragType = null;
      if (this.canvas) this.canvas.style.cursor = "default";
      if (drag.active) this.h3MoveRefImage(drag.from, drag.over);
      else this.render?.();
      return;
    }

    if (e.button === 2 && this.retakeMode) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (this.retakeMode) {
      if (this._isDragging) {
        const wasPlayheadDrag = this._dragType === "playhead";
        const wasPlaying = this._retakeScrubWasPlaying;
        this._retakeScrubWasPlaying = false;
        if (this.timeline.retakeVideo && this.timeline.retakeVideo._scrubTargetSec !== undefined) {
          if (this.timeline.retakeVideo.videoEl) {
            this.timeline.retakeVideo.videoEl.currentTime = this.timeline.retakeVideo._scrubTargetSec;
          }
          delete this.timeline.retakeVideo._scrubTargetSec;
        }
        this._isDragging = false;
        this._dragType = null;
        this.canvas.style.cursor = "default";
        this.commitChanges();
        // If playback was active before the scrub, resume from the new scrub position
        if (wasPlayheadDrag && wasPlaying) {
          this.playAudio();
        } else {
          this.render();
        }
      }
      return;
    }

    // Commit scrub target to actual video element so it's ready for playback
    const commitScrub = (segs) => {
      if (!segs) return;
      for (const seg of segs) {
        if (seg._scrubTargetSec !== undefined) {
          if (seg.videoEl) seg.videoEl.currentTime = seg._scrubTargetSec;
          delete seg._scrubTargetSec;
        }
      }
    };

    commitScrub(this.timeline.segments);
    commitScrub(this.timeline.motionSegments);
    commitScrub(this._previewSegments);
    commitScrub(this._previewSiblingSegments);
    if (this._multiDragPreviewTimelines) {
      commitScrub(this._multiDragPreviewTimelines.image);
      commitScrub(this._multiDragPreviewTimelines.motion);
    }

    if (this._isDragging) {
      if (this._dragType === "box_select") {
        this._isSelectingBox = false;
        this._selectBoxStart = null;
        this._selectBoxCurrent = null;
        this._selectBoxInitialSelectedIds = null;
        this._isDragging = false;
        this.canvas.style.cursor = "default";
        this.updateUIFromSelection();
        this.render();
        this.commitChanges();
        return;
      }

      if (this._multiDragPreviewTimelines) {
        if (this._multiDragPreviewTimelines.image) {
          this.timeline.segments = this._multiDragPreviewTimelines.image.map(ps => {
            const orig = this.timeline.segments.find(s => s.id === ps.id);
            if (orig) {
              if (orig.imgObj) ps.imgObj = orig.imgObj;
              if (orig.videoEl) ps.videoEl = orig.videoEl;
              if (orig.thumbnails) ps.thumbnails = orig.thumbnails;
              if (orig._extractingThumbs !== undefined) ps._extractingThumbs = orig._extractingThumbs;
              if (orig._uploading !== undefined) ps._uploading = orig._uploading;
              if (orig._decoding !== undefined) ps._decoding = orig._decoding;
              if (orig._blobUrl !== undefined) ps._blobUrl = orig._blobUrl;
              if (orig._audioBuffer !== undefined) ps._audioBuffer = orig._audioBuffer;
            }
            return ps;
          });
        }
        if (this._multiDragPreviewTimelines.motion) {
          this.timeline.motionSegments = this._multiDragPreviewTimelines.motion.map(ps => {
            const orig = this.timeline.motionSegments.find(s => s.id === ps.id);
            if (orig) {
              if (orig.imgObj) ps.imgObj = orig.imgObj;
              if (orig.videoEl) ps.videoEl = orig.videoEl;
              if (orig.thumbnails) ps.thumbnails = orig.thumbnails;
              if (orig._extractingThumbs !== undefined) ps._extractingThumbs = orig._extractingThumbs;
              if (orig._uploading !== undefined) ps._uploading = orig._uploading;
              if (orig._decoding !== undefined) ps._decoding = orig._decoding;
              if (orig._blobUrl !== undefined) ps._blobUrl = orig._blobUrl;
              if (orig._audioBuffer !== undefined) ps._audioBuffer = orig._audioBuffer;
            }
            return ps;
          });
        }
        if (this._multiDragPreviewTimelines.audio) {
          this.timeline.audioSegments = this._multiDragPreviewTimelines.audio.map(ps => {
            const orig = this.timeline.audioSegments.find(s => s.id === ps.id);
            if (orig) {
              if (orig.imgObj) ps.imgObj = orig.imgObj;
              if (orig.videoEl) ps.videoEl = orig.videoEl;
              if (orig.thumbnails) ps.thumbnails = orig.thumbnails;
              if (orig._extractingThumbs !== undefined) ps._extractingThumbs = orig._extractingThumbs;
              if (orig._uploading !== undefined) ps._uploading = orig._uploading;
              if (orig._decoding !== undefined) ps._decoding = orig._decoding;
              if (orig._blobUrl !== undefined) ps._blobUrl = orig._blobUrl;
              if (orig._audioBuffer !== undefined) ps._audioBuffer = orig._audioBuffer;
              if (orig.isH3Drive) ps.isH3Drive = true;
              if (orig.waveformPeaks) ps.waveformPeaks = orig.waveformPeaks;
              if (orig.audioDurationFrames) ps.audioDurationFrames = orig.audioDurationFrames;
              if (orig.audioFile) ps.audioFile = orig.audioFile;
              if (orig.fileName) ps.fileName = orig.fileName;
            }
            return ps;
          });
        }
        this._multiDragPreviewTimelines = null;
        this._h3RefreshDriveMetaFromSegments?.();
      } else if (this._previewSegments) {
        const targetArray = this.getSegmentArray(this.selectionType);

        const mappedArray = this._previewSegments.map(ps => {
          const orig = targetArray.find(s => s.id === ps.id);
          let finalStart = ps.resolvedStart !== undefined ? ps.resolvedStart : ps.start;
          let newPs = { ...ps, start: finalStart };
          if (orig) {
            if (orig.imgObj) newPs.imgObj = orig.imgObj;
            if (orig.videoEl) newPs.videoEl = orig.videoEl;
            if (orig.thumbnails) newPs.thumbnails = orig.thumbnails;
            if (orig._extractingThumbs !== undefined) newPs._extractingThumbs = orig._extractingThumbs;
            if (orig._uploading !== undefined) newPs._uploading = orig._uploading;
            if (orig._decoding !== undefined) newPs._decoding = orig._decoding;
            if (orig._blobUrl !== undefined) newPs._blobUrl = orig._blobUrl;
            if (orig._audioBuffer !== undefined) newPs._audioBuffer = orig._audioBuffer;
            if (orig.isH3Drive) newPs.isH3Drive = true;
            if (orig.waveformPeaks) newPs.waveformPeaks = orig.waveformPeaks;
            if (orig.audioDurationFrames) newPs.audioDurationFrames = orig.audioDurationFrames;
            if (orig.audioFile) newPs.audioFile = orig.audioFile;
            if (orig.fileName) newPs.fileName = orig.fileName;
          }
          delete newPs.resolvedStart;
          return newPs;
        });

        if (this.selectionType === "audio") {
          this.timeline.audioSegments = mappedArray;
          if (this._dragTargetId) this.selectedIndex = this.timeline.audioSegments.findIndex(s => s.id === this._dragTargetId);
          this._h3RefreshDriveMetaFromSegments?.();
        } else if (this.selectionType === "motion") {
          this.timeline.motionSegments = mappedArray;
          if (this._dragTargetId) this.selectedIndex = this.timeline.motionSegments.findIndex(s => s.id === this._dragTargetId);
        } else {
          this.timeline.segments = mappedArray;
          if (this._dragTargetId) this.selectedIndex = this.timeline.segments.findIndex(s => s.id === this._dragTargetId);
        }
      }

      if (this._previewSiblingSegments) {
        let siblingArray = null;
        if (this.selectionType === "audio") siblingArray = this.timeline.segments;
        else if (this.selectionType === "image") siblingArray = this.timeline.audioSegments;

        if (siblingArray) {
          const mappedSibling = this._previewSiblingSegments.map(ps => {
            const orig = siblingArray.find(s => s.id === ps.id);
            let finalStart = ps.resolvedStart !== undefined ? ps.resolvedStart : ps.start;
            let newPs = { ...ps, start: finalStart };
            if (orig) {
              if (orig.imgObj) newPs.imgObj = orig.imgObj;
              if (orig.videoEl) newPs.videoEl = orig.videoEl;
              if (orig.thumbnails) newPs.thumbnails = orig.thumbnails;
              if (orig._extractingThumbs !== undefined) newPs._extractingThumbs = orig._extractingThumbs;
              if (orig._uploading !== undefined) newPs._uploading = orig._uploading;
              if (orig._decoding !== undefined) newPs._decoding = orig._decoding;
              if (orig._blobUrl !== undefined) newPs._blobUrl = orig._blobUrl;
              if (orig._audioBuffer !== undefined) newPs._audioBuffer = orig._audioBuffer;
            }
            delete newPs.resolvedStart;
            return newPs;
          });

          if (this.selectionType === "audio") this.timeline.segments = mappedSibling;
          else if (this.selectionType === "image") this.timeline.audioSegments = mappedSibling;
        }
      }

      if (this._multiDragClickPendingDeselect && !this._isMultiDraggingAndMoved) {
        const clickedId = this._multiDragClickPendingDeselect;
        this.selectedSegmentIds = [clickedId];
        const sibId = clickedId.endsWith("_v") ? clickedId.slice(0, -2) + "_a" : (clickedId.endsWith("_a") ? clickedId.slice(0, -2) + "_v" : null);
        if (sibId && !this.selectedSegmentIds.includes(sibId)) this.selectedSegmentIds.push(sibId);

        let foundIdx = -1;
        let foundTrack = "image";
        for (const track of ["image", "motion", "audio"]) {
          const arr = this.getSegmentArray(track);
          const idx = arr.findIndex(s => s.id === clickedId);
          if (idx !== -1) {
            foundIdx = idx;
            foundTrack = track;
            break;
          }
        }
        if (foundIdx !== -1) {
          this.selectionType = foundTrack;
          this.selectedIndex = foundIdx;
        }
        this.updateUIFromSelection();
      }

      this._isDragging = false;
      this._previewSegments = null;
      this._previewSiblingSegments = null;
      this._ghostTrack = null;
      this._isMultiDraggingAndMoved = false;
      this._multiDragClickPendingDeselect = null;
      this._multiDragInitialSegments = null;
      this._multiDragPreviewTimelines = null;
      this.canvas.style.cursor = "default";
      this.commitChanges();
    }
  }

  // --- Backend Data Sync ---
  commitChanges(skipRender = false) {
    if (this._suppressCommit) return;
    // Deduplicate segments by ID to clean up any duplicates created by the previous onseeked bug
    this.timeline.segments = this.timeline.segments.filter((seg, index, self) => index === self.findIndex((s) => s.id === seg.id));
    // 多参：清掉旧 motion；驱动音频多段（isH3Drive）必须保留
    if (this.isH3MultiMode && this.isH3MultiMode()) {
      this.timeline.motionSegments = [];
      if (this.timeline.audioSegments) {
        this.timeline.audioSegments = this.timeline.audioSegments
          .filter((s) => s?.isH3Drive)
          .filter((seg, index, self) => index === self.findIndex((s) => s.id === seg.id));
      }
      this._h3RefreshDriveMetaFromSegments?.();
    } else {
      if (this.timeline.audioSegments) {
        this.timeline.audioSegments = this.timeline.audioSegments.filter((seg, index, self) => index === self.findIndex((s) => s.id === seg.id));
      }
      if (this.timeline.motionSegments) {
        this.timeline.motionSegments = this.timeline.motionSegments.filter((seg, index, self) => index === self.findIndex((s) => s.id === seg.id));
      }
      // 分镜也要刷新驱动音 pieces/trimStart，否则后端仍用文件开头
      if (this.isH3Director) this._h3RefreshDriveMetaFromSegments?.();
    }

    const shouldSyncDuration = shouldAutoSyncDuration(this.manualOutputRange);
    const multi = this.isH3MultiMode && this.isH3MultiMode();
    // 多参：即使主轨为空也要重算（避免删参考音后时长仍停在旧音频长度）
    const hasContent = multi
      ? true
      : [
          ...(this.timeline.segments || []),
          ...(this.timeline.audioSegments || []),
          ...(this.timeline.motionSegments || []),
        ].length > 0;
    if (shouldSyncDuration && !this.retakeMode && hasContent) {
      this.syncDurationToTimelineSegments();
    }

    let sortedSegments = [...this.timeline.segments].sort((a, b) => a.start - b.start);
    let contiguousLengths = [];
    let contiguousPrompts = [];
    let imgStrengths = [];

    const startFrames = this.getStartFrames();
    const durationFrames = this.getDurationFrames();
    if (!this.retakeMode) {
      this.timeline.normalStartFrame = startFrames;
      this.timeline.normalDurationFrames = durationFrames;
    }
    const endFrames = startFrames + durationFrames;
    let currentCursor = startFrames;

    if (this.retakeMode) {
      const totalFrames = this.getVisualDurationFrames();
      const retakeStart = this.timeline.retakeStart ?? 0;
      const retakeLength = this.timeline.retakeLength ?? totalFrames;
      const retakeEnd = retakeStart + retakeLength;
      const retakePrompt = this.timeline.retakePrompt || "";
      const retakeStrength = this.timeline.retakeStrength ?? 1.0;
      const globalPrompt = this.globalPromptInput ? this.globalPromptInput.value : (this.node.properties?.global_prompt || "");

      // 1. Preserved before
      const pBeforeStart = startFrames;
      const pBeforeEnd = Math.min(endFrames, retakeStart);
      const pBeforeLen = pBeforeEnd - pBeforeStart;
      if (pBeforeLen > 0) {
        contiguousLengths.push(pBeforeLen);
        contiguousPrompts.push(globalPrompt || "video");
        imgStrengths.push("0.00");
      }

      // 2. Retake region
      const rStart = Math.max(startFrames, retakeStart);
      const rEnd = Math.min(endFrames, retakeEnd);
      const rLen = rEnd - rStart;
      if (rLen > 0) {
        contiguousLengths.push(rLen);
        contiguousPrompts.push(retakePrompt || "video");
        imgStrengths.push(retakeStrength.toFixed(2));
      }

      // 3. Preserved after
      const pAfterStart = Math.max(startFrames, retakeEnd);
      const pAfterEnd = endFrames;
      const pAfterLen = pAfterEnd - pAfterStart;
      if (pAfterLen > 0) {
        contiguousLengths.push(pAfterLen);
        contiguousPrompts.push(globalPrompt || "video");
        imgStrengths.push("0.00");
      }
    } else {
      // Build segment lengths clipped at the duration cutoff.
      // - Gaps before the first segment, or between segments, are absorbed into the adjacent
      //   segment's length (same as before), but are also clipped at endFrames.
      // - Segments completely before startFrames or after endFrames are excluded entirely.
      // - Segments that cross the boundaries are trimmed.
      let pendingGap = 0;
      for (let seg of sortedSegments) {
        if (seg.start + seg.length <= startFrames) continue;
        if (seg.start >= endFrames) break;

        const effectiveStart = Math.max(seg.start, startFrames);

        if (effectiveStart > currentCursor) {
          const gapLength = Math.min(effectiveStart, endFrames) - currentCursor;
          if (contiguousLengths.length > 0) {
            contiguousLengths[contiguousLengths.length - 1] += gapLength;
          } else {
            pendingGap += gapLength;
          }
        }

        const clippedEnd = Math.min(seg.start + seg.length, endFrames);
        const clippedLength = clippedEnd - effectiveStart;

        contiguousLengths.push(clippedLength + pendingGap);
        contiguousPrompts.push(seg.prompt || "");
        pendingGap = 0;
        currentCursor = Math.max(currentCursor, seg.start + seg.length);
      }

      const clampedCursor = Math.min(currentCursor, endFrames);
      if (contiguousLengths.length > 0 && clampedCursor < endFrames) {
        contiguousLengths[contiguousLengths.length - 1] += endFrames - clampedCursor;
      }
    }

    const toSave = {
      mainTrackEnabled: this.mainTrackEnabled,
      audioTrackEnabled: this.audioTrackEnabled,
      motionTrackEnabled: this.motionTrackEnabled,
      propHeight: this.propHeight,
      globalPropHeight: this.globalPropHeight,
      showFilenames: !!this.node.properties.showFilenames,
      manualOutputRange: this.manualOutputRange === true,
      useICVideoSize: this.useICVideoSize === true,
      overrideAudio: this.getOverrideAudioEnabled(),
      inpaint_audio: !!(this.node.widgets?.find(w => w.name === "inpaint_audio")?.value),
      global_prompt: this.retakeMode ? (this.timeline.global_prompt || "") : (this.globalPromptInput ? this.globalPromptInput.value : ""),
      retake_global_prompt: this.retakeMode ? (this.globalPromptInput ? this.globalPromptInput.value : "") : (this.timeline.retake_global_prompt || ""),
      retakeMode: this.retakeMode,
      retakeStart: this.timeline.retakeStart,
      retakeLength: this.timeline.retakeLength,
      retakePrompt: this.timeline.retakePrompt,
      retakeStrength: this.timeline.retakeStrength,
      retakeVideo: this.timeline.retakeVideo ? {
        fileName: this.timeline.retakeVideo.fileName,
        imageFile: this.timeline.retakeVideo.imageFile,
        videoDurationFrames: this.timeline.retakeVideo.videoDurationFrames,
        fileSize: this.timeline.retakeVideo.fileSize,
      } : null,
      normalStartFrame: this.timeline.normalStartFrame,
      normalDurationFrames: this.timeline.normalDurationFrames,
      segments: sortedSegments.map(s => {
        const { imgObj, videoEl, _isSeeking, thumbnails, _extractingThumbs, _sSecs, _lSecs, _tSecs, _dSecs, _uploading, _blobUrl, ...rest } = s;
        return rest;
      }),
      motionSegments: (this.timeline.motionSegments || []).map(s => {
        const { imgObj, videoEl, _isSeeking, thumbnails, _extractingThumbs, _sSecs, _lSecs, _tSecs, _dSecs, _uploading, _blobUrl, ...rest } = s;
        return rest;
      }),
      audioSegments: (this.timeline.audioSegments || []).map(s => {
        const { _sSecs, _lSecs, _tSecs, _dSecs, _uploading, _decoding, _blobUrl, _audioBuffer, ...rest } = s;
        return rest;
      }),
      // H3 多参（图/音/视频；blob 预览不落盘）
      h3MultiRef: this.timeline.h3MultiRef
        ? {
            images: (this.timeline.h3MultiRef.images || []).map((img) => {
              if (!img) return null;
              return {
                id: img.id,
                name: img.name,
                fileName: img.fileName || img.name,
                imageFile: img.fileName || img.name,
              };
            }),
            // 参考音频 3 槽（与 driveAudio 独立；驱动音只走 driveAudio）
            audios: this._h3SerializeRefAudios ? this._h3SerializeRefAudios() : [],
            refAudios: this._h3SerializeRefAudios ? this._h3SerializeRefAudios() : [],
            driveAudio: (() => {
              const segs = (this.timeline.audioSegments || []).filter((s) => s?.isH3Drive);
              const drive = this.timeline.h3MultiRef.driveAudio;
              if (!segs.length && !drive) return null;
              const first = segs[0] || drive;
              const maxEnd = segs.length
                ? segs.reduce((m, s) => Math.max(m, (s.start || 0) + (s.length || 0)), 0)
                : 0;
              const fps = Math.max(1e-6, this.getFrameRate());
              return {
                id: first.id,
                name: first.name || first.fileName || drive?.name,
                fileName: first.fileName || first.audioFile || drive?.fileName,
                duration: maxEnd > 0 ? maxEnd / fps : drive?.duration || 0,
                role: "drive",
                waveformPeaks: Array.isArray(first.waveformPeaks)
                  ? first.waveformPeaks.slice(0, 800)
                  : Array.isArray(drive?.waveformPeaks)
                    ? drive.waveformPeaks.slice(0, 800)
                    : undefined,
                pieces: segs.map((s) => ({
                  id: s.id,
                  start: s.start,
                  length: s.length,
                  trimStart: s.trimStart || 0,
                  fileName: s.fileName || s.audioFile,
                })),
              };
            })(),
            videos: (this.timeline.h3MultiRef.videos || []).map((v) => {
              if (!v) return null;
              return {
                id: v.id,
                name: v.name,
                fileName: v.fileName || v.videoFile || v.name,
                videoFile: v.videoFile || v.fileName || v.name,
                duration: v.duration || 0,
                // thumb 可能较大，只存短 dataURL 或省略
                thumbUrl: (v.thumbUrl && v.thumbUrl.length < 200000) ? v.thumbUrl : "",
              };
            }),
          }
        : undefined,
      // 工作台模式写入时间线，后端可双保险读取
      workspace_mode: this.isH3Director
        ? (this.h3WorkspaceMode || this.node?.properties?.workspace_mode || "分镜")
        : undefined,
      // H3 分镜/多参主轨分库（互不覆盖）
      h3Tracks: this.isH3Director
        ? (() => {
            try {
              this._h3EnsureTrackBanks?.();
              const mode =
                this.h3WorkspaceMode === "多参" ? "多参" : "分镜";
              // 提交前把当前主轨写回对应分库
              this._h3SaveMainTrack?.(mode);
              return {
                "分镜": {
                  segments: this._h3CloneMainSegments(
                    this.timeline.h3Tracks?.["分镜"]?.segments || []
                  ),
                },
                "多参": {
                  segments: this._h3CloneMainSegments(
                    this.timeline.h3Tracks?.["多参"]?.segments || []
                  ),
                },
              };
            } catch (_) {
              return this.timeline.h3Tracks;
            }
          })()
        : undefined,
    };

    const jsonStr = JSON.stringify(toSave);

    const updateWidgetValue = (w, val) => {
      if (!w) return;
      const oldVal = w.value;
      w.value = val;
      if (this.node) {
        if (this.node.properties) {
          this.node.properties[w.name] = val;
        }
        if (this.node.onWidgetChanged) {
          this.node.onWidgetChanged(w.name, val, oldVal, w);
        }
      }
      if (w.callback) {
        try {
          w.callback(val);
        } catch (e) {
          // ignore
        }
      }
    };

    if (this.timelineDataWidget) {
      updateWidgetValue(this.timelineDataWidget, jsonStr);
    }

    if (this.node.properties) {
      this.node.properties.mainTrackEnabled = this.mainTrackEnabled;
      this.node.properties.audioTrackEnabled = this.audioTrackEnabled;
      this.node.properties.motionTrackEnabled = this.motionTrackEnabled;
      this.node.properties.audioTrackWasEnabledBeforeOverride = !!this._audioTrackWasEnabledBeforeOverride;

      if (this.node.widgets) {
        for (const w of this.node.widgets) {
          if (w.name && w.value !== undefined) {
            this.node.properties[w.name] = w.value;
          }
        }
      }
      const overrideWidget = this.node.widgets?.find(w => w.name === "override_audio");
      if (overrideWidget) {
        this.node.properties.overrideAudio = !!overrideWidget.value;
      }
    }

    const overrideWidget = this.node.widgets?.find(w => w.name === "override_audio");
    if (overrideWidget) {
      updateWidgetValue(overrideWidget, !!this.node.properties.overrideAudio);
    }
    const icSizeWidget = this.node.widgets?.find(w => w.name === "use_ic_video_size");
    if (icSizeWidget) {
      updateWidgetValue(icSizeWidget, this.useICVideoSize === true);
    }
    const customAudioWidget = this.node.widgets?.find(w => w.name === "use_custom_audio");
    if (customAudioWidget) {
      const hasAudioSegments = (this.timeline.audioSegments || []).some(s => s.audioFile || s.audioB64);
      updateWidgetValue(customAudioWidget, this.audioTrackEnabled && !this.retakeMode && hasAudioSegments);
    }

    if (this.localPromptsWidget) {
      updateWidgetValue(this.localPromptsWidget, contiguousPrompts.join(" | "));
    }
    if (this.segmentLengthsWidget) {
      updateWidgetValue(this.segmentLengthsWidget, contiguousLengths.join(","));
    }
    if (this.guideStrengthWidget) {
      let val = "";
      if (this.retakeMode) {
        val = imgStrengths.join(",");
      } else {
        const strList = sortedSegments
          .filter(s => s.type !== "text")
          .filter(s => s.start + s.length > startFrames && s.start < endFrames)
          .map(s => (s.guideStrength !== undefined ? s.guideStrength : 1.0).toFixed(2));
        val = strList.join(",");
      }
      updateWidgetValue(this.guideStrengthWidget, val);
    }

    // Keep zoom slider max in sync with the current timeline duration.
    this.updateZoomSliderMax();

    setTimeout(() => {
      if (this.node && this.node.computeSize) {
        const sz = this.node.computeSize();
        this.node.size[1] = sz[1];
        if (app.graph) {
          app.graph.setDirtyCanvas(true, true);
          if (app.graph.change) app.graph.change();
          if (app.graph.onNodeChanged) app.graph.onNodeChanged(this.node);
          if (app.graph.onStateChanged) app.graph.onStateChanged();
        }
      }
      try {
        const canvasEl = app.canvasEl || app.canvas?.canvas;
        if (canvasEl) {
          canvasEl.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
        }
        if (app.canvas && app.canvas.checkState) app.canvas.checkState();
        if (app.canvas && app.canvas.captureCanvasState) app.canvas.captureCanvasState();
      } catch (_) { }
    }, 100);

    // Stamp exact seconds on every live segment so FPS changes can recompute
    // frame values without cumulative rounding error.
    this._stampSegmentSeconds();

    if (this.isPlaying) {
      this.playAudio(); // Resync audio engine with new timeline data
    }

    if (!skipRender) this.render();
  }

  // Stamp _sSecs / _lSecs / _tSecs / _dSecs on every live segment
  // using the current frame rate. Call this whenever segments change
  // through normal timeline interactions (not FPS changes).
  _stampSegmentSeconds() {
    const fps = this.getFrameRate();
    if (fps <= 0) return;
    for (const seg of this.timeline.segments) {
      seg._sSecs = seg.start / fps;
      seg._lSecs = seg.length / fps;
      if (seg.trimStart !== undefined) seg._tSecs = seg.trimStart / fps;
      if (seg.videoDurationFrames !== undefined) seg._dSecs = seg.videoDurationFrames / fps;
    }
    for (const seg of this.timeline.audioSegments) {
      seg._sSecs = seg.start / fps;
      seg._lSecs = seg.length / fps;
      if (seg.trimStart !== undefined) seg._tSecs = seg.trimStart / fps;
      if (seg.audioDurationFrames !== undefined) seg._dSecs = seg.audioDurationFrames / fps;
    }
  }

  // Recompute all segment frame values from their seconds snapshots at `newFPS`.
  // If a segment has no snapshot yet (e.g. freshly added), fall back to scaling
  // from the previous FPS so it still moves correctly.
  _rebaseSegmentsToFPS(newFPS) {
    if (newFPS <= 0) return;
    const oldFPS = this._prevFrameRate || newFPS;
    const fallbackRatio = oldFPS > 0 ? newFPS / oldFPS : 1;
    for (const seg of this.timeline.segments) {
      if (seg._sSecs !== undefined) {
        seg.start = Math.round(seg._sSecs * newFPS);
        seg.length = Math.max(1, Math.round(seg._lSecs * newFPS));
        if (seg._tSecs !== undefined) seg.trimStart = Math.round(seg._tSecs * newFPS);
        if (seg._dSecs !== undefined) seg.videoDurationFrames = Math.round(seg._dSecs * newFPS);
      } else {
        seg.start = Math.round(seg.start * fallbackRatio);
        seg.length = Math.max(1, Math.round(seg.length * fallbackRatio));
        if (seg.trimStart !== undefined) seg.trimStart = Math.round(seg.trimStart * fallbackRatio);
        if (seg.videoDurationFrames !== undefined) seg.videoDurationFrames = Math.round(seg.videoDurationFrames * fallbackRatio);
      }
    }
    for (const seg of this.timeline.audioSegments) {
      if (seg._sSecs !== undefined) {
        seg.start = Math.round(seg._sSecs * newFPS);
        seg.length = Math.max(1, Math.round(seg._lSecs * newFPS));
        if (seg._tSecs !== undefined) seg.trimStart = Math.round(seg._tSecs * newFPS);
        if (seg._dSecs !== undefined) seg.audioDurationFrames = Math.round(seg._dSecs * newFPS);
      } else {
        seg.start = Math.round(seg.start * fallbackRatio);
        seg.length = Math.max(1, Math.round(seg.length * fallbackRatio));
        if (seg.trimStart !== undefined) seg.trimStart = Math.round(seg.trimStart * fallbackRatio);
        if (seg.audioDurationFrames !== undefined) seg.audioDurationFrames = Math.round(seg.audioDurationFrames * fallbackRatio);
      }
    }
  }

  // --- Gap Region Calculation ---
  getGapRegions() {
    const totalFrames = this.getVisualDurationFrames();
    const outputFrames = this.getStartFrames() + this.getDurationFrames();
    const width = this.canvas.offsetWidth || this._lastWidth || 0;
    const gaps = [];
    if (!width || totalFrames <= 0) return gaps;

    const pushGapsForTrack = (segments, track, trackTop, trackHeight) => {
      if (!trackHeight || trackHeight <= 0) return;
      let cursor = 0;
      const sorted = [...(segments || [])].sort((a, b) => a.start - b.start);
      for (const seg of sorted) {
        if (seg.start > cursor) {
          const x0 = (cursor / totalFrames) * width;
          const x1 = (seg.start / totalFrames) * width;
          gaps.push({
            track,
            frameStart: cursor,
            frameEnd: seg.start,
            centerX: (x0 + x1) / 2,
            centerY: trackTop + trackHeight / 2,
            widthPx: x1 - x0,
          });
        }
        cursor = Math.max(cursor, seg.start + seg.length);
      }
      if (cursor < outputFrames) {
        const x0 = (cursor / totalFrames) * width;
        const x1 = (outputFrames / totalFrames) * width;
        gaps.push({
          track,
          frameStart: cursor,
          frameEnd: outputFrames,
          centerX: (x0 + x1) / 2,
          centerY: trackTop + trackHeight / 2,
          widthPx: x1 - x0,
        });
      }
    };

    // 多参图轨：整段空隙中央 +（与主轨空轨一致）
    const refH = this.getRefTrackHeight();
    if (refH > 0) {
      const d = this.ensureH3MultiData();
      const filled = (d.images || []).filter(Boolean).length;
      if (filled < 9) {
        const viewLeft = this.viewport?.scrollLeft || 0;
        const viewW = this.viewport?.clientWidth || width;
        const centerX = viewLeft + Math.max(40, viewW * 0.5);
        gaps.push({
          track: "ref",
          frameStart: 0,
          frameEnd: outputFrames,
          centerX,
          centerY: RULER_HEIGHT + refH / 2,
          widthPx: Math.max(80, viewW * 0.9),
        });
      }
    }

    // 主轨（多参：文字/视频；视频跳过一采）
    const mainTop = this.getMainTrackTop();
    pushGapsForTrack(this.timeline.segments, "image", mainTop, this.blockHeight);

    // 多参：音频/视频是槽位，不用时间轴空隙 +
    if (this.isH3MultiMode && this.isH3MultiMode()) {
      return gaps;
    }

    const audioH = this.audioTrackHeight || 0;
    const motionH = this.motionTrackHeight || 0;
    if (audioH > 0) {
      pushGapsForTrack(this.timeline.audioSegments, "audio", mainTop + this.blockHeight, audioH);
    }
    if (motionH > 0) {
      pushGapsForTrack(
        this.timeline.motionSegments,
        "motion",
        mainTop + this.blockHeight + audioH,
        motionH
      );
    }

    return gaps;
  }

  promptAddAudioInGap(frameStart, frameEnd) {
    const fi = document.createElement("input");
    fi.type = "file";
    fi.accept = "audio/*";
    fi.addEventListener("change", (ev) => {
      if (ev.target.files?.[0]) this.handleAudioUpload([ev.target.files[0]], frameStart);
    });
    fi.click();
  }

  promptAddMotionInGap(frameStart, frameEnd) {
    const fi = document.createElement("input");
    fi.type = "file";
    fi.accept = "video/*";
    fi.addEventListener("change", (ev) => {
      if (ev.target.files?.[0]) this.handleMotionUpload([ev.target.files[0]], frameStart);
    });
    fi.click();
  }

  fitContextMenuToViewport(menu) {
    const pad = 8;
    const rect = menu.getBoundingClientRect();
    const maxLeft = Math.max(pad, window.innerWidth - rect.width - pad);
    const maxTop = Math.max(pad, window.innerHeight - rect.height - pad);
    const left = Math.min(Math.max(pad, rect.left), maxLeft);
    const top = Math.min(Math.max(pad, rect.top), maxTop);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  // --- Context Menu ---
  onContextMenu(e) {
    e.preventDefault();
    e.stopPropagation();

    // 重拍模式已移除

    const { x: mouseX, y: mouseY } = this.getMousePos(e);

    const trackHeight = this.blockHeight;
    const audioH = this.audioTrackHeight || 0;
    const motionH = this.motionTrackHeight || 0;
    const refH = this.getRefTrackHeight();
    const mainTop = RULER_HEIGHT + refH;
    const imgBottom = mainTop + trackHeight;
    const audioBottom = imgBottom + audioH;
    const isRefTrack = refH > 0 && mouseY >= RULER_HEIGHT && mouseY < mainTop;
    const isImageTrack = mouseY >= mainTop && mouseY < imgBottom;
    const isAudioTrack = audioH > 0 && mouseY >= imgBottom && mouseY < audioBottom;
    const isMotionTrack = motionH > 0 && mouseY >= audioBottom && mouseY < audioBottom + motionH;
    if (isRefTrack) {
      this.showGapMenu(e.clientX, e.clientY, { track: "ref", frameStart: 0, frameEnd: 1 });
      return;
    }

    const logicalWidth = this.canvas.offsetWidth || 1;
    const totalFrames = this.getVisualDurationFrames();
    const cursor = mouseX * (totalFrames / logicalWidth);

    if (mouseY <= RULER_HEIGHT) {
      this.showPlayheadContextMenu(e.clientX, e.clientY);
      return;
    }

    let clickedSeg = null;
    let trackType = "";

    if (isMotionTrack) {
      clickedSeg = this.timeline.motionSegments.find(s => cursor >= s.start && cursor <= s.start + s.length);
      trackType = "motion";
    } else if (isAudioTrack) {
      clickedSeg = this.timeline.audioSegments.find(s => cursor >= s.start && cursor <= s.start + s.length);
      trackType = "audio";
    } else if (isImageTrack) {
      clickedSeg = this.timeline.segments.find(s => cursor >= s.start && cursor <= s.start + s.length);
      trackType = clickedSeg ? clickedSeg.type : "";
    }

    if (clickedSeg) {
      this.showContextMenu(e.clientX, e.clientY, clickedSeg, trackType);
    } else if (isMotionTrack || isImageTrack || isAudioTrack) {
      const gapRegions = this.getGapRegions();
      const currentTrack = isMotionTrack ? "motion" : (isAudioTrack ? "audio" : "image");
      let gap = gapRegions.find(g => cursor >= g.frameStart && cursor <= g.frameEnd && g.track === currentTrack);

      if (!gap) {
        const startFrame = Math.round(cursor);
        gap = {
          track: currentTrack,
          frameStart: startFrame,
          frameEnd: startFrame + Math.max(1, this.getFrameRate())
        };
      }
      gap.clickedFrame = cursor;

      this.showGapContextMenu(e.clientX, e.clientY, gap);
    }
  }

  showPlayheadContextMenu(clientX, clientY) {
    this.dismissContextMenu();
    const menu = document.createElement("div");
    menu.className = "pr-gap-menu";
    menu.style.left = `${clientX + 6}px`;
    menu.style.top = `${clientY - 10}px`;

    const startBtn = document.createElement("button");
    startBtn.className = "pr-gap-menu-btn";
    startBtn.innerHTML = `将播放头设为起始`;
    startBtn.onclick = () => {
      this.setStartAtPlayhead();
      this.dismissContextMenu();
    };
    menu.appendChild(startBtn);

    const endBtn = document.createElement("button");
    endBtn.className = "pr-gap-menu-btn";
    endBtn.innerHTML = `将播放头设为结束`;
    endBtn.onclick = () => {
      this.setEndAtPlayhead();
      this.dismissContextMenu();
    };
    menu.appendChild(endBtn);

    document.body.appendChild(menu);
    this.fitContextMenuToViewport(menu);
    this._contextMenu = menu;
    setTimeout(() => {
      this._contextMenuDismisser = (ev) => { if (!menu.contains(ev.target)) this.dismissContextMenu(); };
      document.addEventListener("pointerdown", this._contextMenuDismisser, true);
      document.addEventListener("wheel", this._contextMenuDismisser, true);
    }, 0);
  }

  _deleteRetakeVideo() {
    if (!this.timeline.retakeVideo) return;
    // Clean up the video element
    const vid = this.timeline.retakeVideo;
    if (vid.videoEl) {
      vid.videoEl.pause();
      vid.videoEl.src = "";
      vid.videoEl.load();
    }
    if (vid._blobUrl) {
      URL.revokeObjectURL(vid._blobUrl);
    }
    this.timeline.retakeVideo = null;
    this.timeline.retakeStart = 0;
    this.timeline.retakeLength = this.getDurationFrames();
    this.commitChanges();
    this.render();
  }

  _showRetakeContextMenu(clientX, clientY) {
    this.dismissContextMenu();

    const menu = document.createElement("div");
    menu.className = "pr-gap-menu";
    menu.style.left = `${clientX + 6}px`;
    menu.style.top = `${clientY - 10}px`;

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "pr-gap-menu-btn";
    deleteBtn.innerHTML = `${ICONS.trash} Delete`;
    deleteBtn.style.color = "#ffaaaa";
    deleteBtn.onclick = () => {
      this.dismissContextMenu();
      this._deleteRetakeVideo();
    };
    menu.appendChild(deleteBtn);

    document.body.appendChild(menu);
    this.fitContextMenuToViewport(menu);
    this._contextMenu = menu;
    setTimeout(() => {
      this._contextMenuDismisser = (ev) => { if (!menu.contains(ev.target)) this.dismissContextMenu(); };
      document.addEventListener("pointerdown", this._contextMenuDismisser, true);
      document.addEventListener("wheel", this._contextMenuDismisser, true);
    }, 0);
  }

  async _checkClipboardForImage(btn) {
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const status = await navigator.permissions.query({ name: "clipboard-read" });
        if (status.state === "granted") {
          const items = await navigator.clipboard.read();
          let hasImg = false;
          for (const item of items) {
            if (item.types.some(t => t.startsWith("image/"))) {
              hasImg = true;
              break;
            }
          }
          if (!hasImg) {
            btn.disabled = true;
            btn.style.display = "none";
            btn.style.opacity = "0.4";
            btn.style.cursor = "not-allowed";
            btn.title = "剪贴板中没有图片";
          }
        } else if (status.state === "denied") {
          btn.disabled = true;
          btn.style.display = "none";
          btn.style.opacity = "0.4";
          btn.style.cursor = "not-allowed";
          btn.title = "无法访问剪贴板权限";
        }
      }
    } catch (e) {
      console.warn("Clipboard read permission query failed:", e);
    }
  }

  async _checkClipboardForText(btn) {
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const status = await navigator.permissions.query({ name: "clipboard-read" });
        if (status.state === "granted") {
          const text = await navigator.clipboard.readText();
          if (!text || text.trim() === "") {
            btn.disabled = true;
            btn.style.display = "none";
            btn.style.opacity = "0.4";
            btn.style.cursor = "not-allowed";
            btn.title = "剪贴板中没有文字";
          }
        } else if (status.state === "denied") {
          btn.disabled = true;
          btn.style.display = "none";
          btn.style.opacity = "0.4";
          btn.style.cursor = "not-allowed";
          btn.title = "无法访问剪贴板权限";
        }
      }
    } catch (e) {
      console.warn("Clipboard read text permission query failed:", e);
    }
  }

  showContextMenu(clientX, clientY, seg, trackType) {
    this.dismissContextMenu();
    const menu = document.createElement("div");
    menu.className = "pr-gap-menu";
    menu.style.left = `${clientX + 6}px`;
    menu.style.top = `${clientY - 10}px`;

    const isImage = trackType === "image" && seg.imageB64;

    const makeDivider = () => {
      const d = document.createElement("div");
      d.className = "pr-settings-divider";
      return d;
    };

    // ==========================================
    // 1. Define Segment options (Copy, Paste, 替换片段, Split)
    // ==========================================
    const copySegBtn = document.createElement("button");
    copySegBtn.className = "pr-gap-menu-btn";
    copySegBtn.innerHTML = `复制时间线片段`;
    copySegBtn.onclick = () => {
      this._copiedSegment = { ...seg, id: Date.now().toString() + Math.random().toString(36).substr(2, 5) };
      this._copiedSegmentTrack = trackType;
      window._ltxCopiedSegment = { main: { ...seg }, sibling: null };
      window._ltxCopiedSegmentType = this.getCanonicalTrack(trackType);
      if (seg.imgObj) window._ltxCopiedSegment.main.imgObj = seg.imgObj;
      if (seg.videoEl) window._ltxCopiedSegment.main.videoEl = seg.videoEl;

      if (seg.id && (seg.id.endsWith("_v") || seg.id.endsWith("_a"))) {
        const isVid = seg.id.endsWith("_v");
        const sibId = isVid ? seg.id.slice(0, -2) + "_a" : seg.id.slice(0, -2) + "_v";
        const sibArr = isVid ? this.timeline.audioSegments : this.timeline.segments;
        const sib = sibArr.find(s => s.id === sibId);
        if (sib) {
          window._ltxCopiedSegment.sibling = { ...sib };
          if (sib.imgObj) window._ltxCopiedSegment.sibling.imgObj = sib.imgObj;
          if (sib.videoEl) window._ltxCopiedSegment.sibling.videoEl = sib.videoEl;
        }
      }
      this.dismissContextMenu();
    };

    const hasCopied = this._copiedSegment || window._ltxCopiedSegment;
    const copiedTrack = this._copiedSegmentTrack || window._ltxCopiedSegmentType;
    const copiedSegData = this._copiedSegment || (window._ltxCopiedSegment ? window._ltxCopiedSegment.main : null);
    const copiedSibData = window._ltxCopiedSegment ? window._ltxCopiedSegment.sibling : null;

    const canPaste = hasCopied && this.getCanonicalTrack(copiedTrack) === this.getCanonicalTrack(trackType) && copiedSegData;
    const pasteSegBtn = document.createElement("button");
    pasteSegBtn.className = "pr-gap-menu-btn";
    pasteSegBtn.innerHTML = `粘贴片段`;
    if (canPaste) {
      pasteSegBtn.onclick = () => {
        const startFrame = Math.round(this.currentFrame);
        this.pasteSegmentAtFrame(copiedSegData, this.getCanonicalTrack(copiedTrack), copiedSibData, startFrame);
        this.dismissContextMenu();
      };
    }

    const currentTrack = trackType;
    const canReplace = hasCopied && this.getCanonicalTrack(copiedTrack) === this.getCanonicalTrack(currentTrack) && copiedSegData;
    const pasteReplaceBtn = document.createElement("button");
    pasteReplaceBtn.className = "pr-gap-menu-btn";
    pasteReplaceBtn.innerHTML = `替换片段`;
    if (canReplace) {
      pasteReplaceBtn.onclick = () => {
        const newSeg = {
          ...copiedSegData,
          id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
          start: seg.start,
          length: copiedSegData.length
        };
        const targetArray = this.getSegmentArray(this.getCanonicalTrack(currentTrack));
        const idx = targetArray.findIndex(s => s.id === seg.id);
        if (idx >= 0) targetArray[idx] = newSeg;
        this.commitChanges();
        this.dismissContextMenu();
      };
    }

    // ==========================================
    // 2. Define Prompt options (if not audio)
    // ==========================================
    let copyPromptBtn = null;
    let pastePromptBtn = null;
    if (trackType !== "audio") {
      copyPromptBtn = document.createElement("button");
      copyPromptBtn.className = "pr-gap-menu-btn";
      copyPromptBtn.innerHTML = `复制提示词`;
      copyPromptBtn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(seg.prompt || "");
        } catch (err) {
          console.error("Failed to copy prompt", err);
        }
        this.dismissContextMenu();
      };

      pastePromptBtn = document.createElement("button");
      pastePromptBtn.className = "pr-gap-menu-btn";
      pastePromptBtn.innerHTML = `粘贴提示词`;
      this._checkClipboardForText(pastePromptBtn);
      pastePromptBtn.onclick = async () => {
        try {
          const text = await navigator.clipboard.readText();
          if (text) {
            seg.prompt = text;
            this.commitChanges();
            this.render();
            if (this.selectedIndex === this.timeline.segments.findIndex(s => s.id === seg.id)) {
              this.updateUIFromSelection();
            }
          }
        } catch (err) {
          console.error("Failed to paste prompt", err);
        }
        this.dismissContextMenu();
      };
    }

    // ==========================================
    // 3. Define Image options (if isImage)
    // ==========================================
    let copyImgBtn = null;
    let saveImgBtn = null;
    let openImgBtn = null;
    let replaceImgBtn = null;
    let replaceWithFileBtn = null;

    if (isImage) {
      copyImgBtn = document.createElement("button");
      copyImgBtn.className = "pr-gap-menu-btn";
      copyImgBtn.innerHTML = `复制图片到剪贴板`;
      copyImgBtn.onclick = async () => {
        try {
          const img = new Image();
          img.crossOrigin = "Anonymous";
          img.src = seg.imageB64;
          await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
          });
          const canvas = document.createElement("canvas");
          canvas.width = img.width;
          canvas.height = img.height;
          canvas.getContext("2d").drawImage(img, 0, 0);
          const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        } catch (err) {
          console.error("Failed to copy image", err);
        }
        this.dismissContextMenu();
      };

      saveImgBtn = document.createElement("button");
      saveImgBtn.className = "pr-gap-menu-btn";
      saveImgBtn.innerHTML = `保存图片`;
      saveImgBtn.onclick = () => {
        const a = document.createElement("a");
        a.href = seg.imageB64;
        a.download = "timeline_image.jpg";
        a.click();
        this.dismissContextMenu();
      };

      openImgBtn = document.createElement("button");
      openImgBtn.className = "pr-gap-menu-btn";
      openImgBtn.innerHTML = `在新标签页打开图片`;
      openImgBtn.onclick = () => {
        const win = window.open();
        if (win) {
          win.document.write(`<body style="margin:0;display:flex;justify-content:center;align-items:center;background:#0e0e0e;height:100vh;"><img style="max-width:100%;max-height:100%;" src="${seg.imageB64}" /></body>`);
          win.document.close();
        }
        this.dismissContextMenu();
      };

      replaceImgBtn = document.createElement("button");
      replaceImgBtn.className = "pr-gap-menu-btn";
      replaceImgBtn.innerHTML = `用已复制图片替换`;
      this._checkClipboardForImage(replaceImgBtn);
      replaceImgBtn.onclick = async () => {
        try {
          const items = await navigator.clipboard.read();
          for (const item of items) {
            const imageTypes = item.types.filter(type => type.startsWith("image/"));
            if (imageTypes.length > 0) {
              const blob = await item.getType(imageTypes[0]);
              const file = new File([blob], "clipboard.png", { type: blob.type });

              const body = new FormData();
              body.append("image", file);
              body.append("subfolder", "whatdreamscost");
              const resp = await api.fetchApi("/upload/image", { method: "POST", body });
              if (resp.status === 200) {
                const data = await resp.json();
                const filename = data.name;
                const subfolder = data.subfolder || "";
                const imageFile = subfolder ? subfolder + "/" + filename : filename;
                const imgUrl = api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);

                const img = new Image();
                img.onload = () => {
                  seg.imageFile = imageFile;
                  seg.imageB64 = imgUrl;
                  seg.imgObj = img;
                  this.commitChanges();
                  this.render();
                  if (this.selectedIndex === this.timeline.segments.findIndex(s => s.id === seg.id)) {
                    this.updateUIFromSelection();
                  }
                };
                img.src = imgUrl;
              }
              break;
            }
          }
        } catch (err) {
          console.error("Failed to read image from clipboard", err);
        }
        this.dismissContextMenu();
      };

      replaceWithFileBtn = document.createElement("button");
      replaceWithFileBtn.className = "pr-gap-menu-btn";
      replaceWithFileBtn.innerHTML = `替换为...`;
      replaceWithFileBtn.onclick = () => {
        this.dismissContextMenu();
        const fi = document.createElement("input");
        fi.type = "file";
        fi.accept = "image/*";
        fi.addEventListener("change", async (ev) => {
          const file = ev.target.files?.[0];
          if (!file) return;
          try {
            const body = new FormData();
            body.append("image", file);
            body.append("subfolder", "whatdreamscost");
            const resp = await api.fetchApi("/upload/image", { method: "POST", body });
            if (resp.status === 200) {
              const data = await resp.json();
              const filename = data.name;
              const subfolder = data.subfolder || "";
              const imageFile = subfolder ? subfolder + "/" + filename : filename;
              const imgUrl = api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);

              const img = new Image();
              img.onload = () => {
                seg.imageFile = imageFile;
                seg.imageB64 = imgUrl;
                seg.imgObj = img;
                this.commitChanges();
                this.render();
                if (this.selectedIndex === this.timeline.segments.findIndex(s => s.id === seg.id)) {
                  this.updateUIFromSelection();
                }
              };
              img.src = imgUrl;
            }
          } catch (err) {
            console.error("Failed to upload replacement image", err);
          }
        });
        fi.click();
      };
    }

    // ==========================================
    // 4. Define 转为结束帧 options (only image segment with type === "image")
    // ==========================================
    let toggleEndFrameBtn = null;
    if (trackType === "image" && seg.type === "image") {
      toggleEndFrameBtn = document.createElement("button");
      toggleEndFrameBtn.className = "pr-gap-menu-btn";
      if (seg.isEndFrame) {
        toggleEndFrameBtn.innerHTML = `转为起始帧`;
        toggleEndFrameBtn.onclick = () => {
          seg.isEndFrame = false;
          this.commitChanges();
          this.render();
          this.dismissContextMenu();
        };
      } else {
        toggleEndFrameBtn.innerHTML = `转为结束帧`;
        toggleEndFrameBtn.onclick = () => {
          seg.isEndFrame = true;
          this.commitChanges();
          this.render();
          this.dismissContextMenu();
        };
      }
    }

    // ==========================================
    // 5. Define 取消媒体关联 & 标记选区 options
    // ==========================================
    const isVidLink = trackType === "video" && seg.id.endsWith("_v");
    const isAudLink = trackType === "audio" && seg.id.endsWith("_a");
    let siblingForUnlink = null;

    if (isVidLink) {
      siblingForUnlink = this.timeline.audioSegments.find(s => s.id === seg.id.slice(0, -2) + "_a");
    } else if (isAudLink) {
      siblingForUnlink = this.timeline.segments.find(s => s.id === seg.id.slice(0, -2) + "_v");
    }

    let unlinkBtn = null;
    if (siblingForUnlink) {
      unlinkBtn = document.createElement("button");
      unlinkBtn.className = "pr-gap-menu-btn";
      unlinkBtn.innerHTML = `取消媒体关联`;
      unlinkBtn.onclick = () => {
        seg.id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
        siblingForUnlink.id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
        this.commitChanges();
        this.render();
        this.dismissContextMenu();
      };
    }

    let fitToAudioBtn = null;
    let fitToVisualBtn = null;
    let setOutputRangeBtn = null;
    let setDurationEndBtn = null;
    const canonicalTrack = this.getCanonicalTrack(trackType);
    if (canonicalTrack === "image") {
      const segLabel = seg.type === "text" ? "文字" : "图片";
      const overlappingAudio = this.getOverlappingAudioSegment(seg);
      if (overlappingAudio) {
        fitToAudioBtn = document.createElement("button");
        fitToAudioBtn.className = "pr-gap-menu-btn";
        fitToAudioBtn.innerHTML = `将 ${segLabel} 对齐音频`;
        fitToAudioBtn.onclick = () => {
          this.alignSelectedImageToTarget(seg, overlappingAudio);
          this.dismissContextMenu();
        };
      }
      const overlappingVisual = this.getOverlappingVisualSegment(seg);
      if (overlappingVisual) {
        fitToVisualBtn = document.createElement("button");
        fitToVisualBtn.className = "pr-gap-menu-btn";
        fitToVisualBtn.innerHTML = `将 ${segLabel} 对齐画面`;
        fitToVisualBtn.onclick = () => {
          this.alignSelectedImageToTarget(seg, overlappingVisual);
          this.dismissContextMenu();
        };
      }
    }
    const rangeSourceSegments = this.getRangeSourceSegments(seg);
    if (rangeSourceSegments.length > 0) {
      const rangeLabel = rangeSourceSegments.length > 1 ? "Selection" : "Segment";
      setOutputRangeBtn = document.createElement("button");
      setOutputRangeBtn.className = "pr-gap-menu-btn";
      setOutputRangeBtn.innerHTML = `从 ${rangeLabel} 设置输出范围`;
      setOutputRangeBtn.onclick = () => {
        this.setOutputRangeFromSegments(rangeSourceSegments);
        this.dismissContextMenu();
      };

      setDurationEndBtn = document.createElement("button");
      setDurationEndBtn.className = "pr-gap-menu-btn";
      setDurationEndBtn.innerHTML = `将时长设到 ${rangeLabel} 结束`;
      setDurationEndBtn.onclick = () => {
        this.setDurationToSegmentsEnd(rangeSourceSegments);
        this.dismissContextMenu();
      };
    }

    const markSelectionBtn = document.createElement("button");
    markSelectionBtn.className = "pr-gap-menu-btn";
    markSelectionBtn.innerHTML = `标记选区`;
    markSelectionBtn.onclick = () => {
      if (this.selectedSegmentIds && this.selectedSegmentIds.includes(seg.id)) {
        this.markCurrentSelection();
      } else {
        this.markSegment(seg);
      }
      this.dismissContextMenu();
    };

    // ==========================================
    // 6. Define Delete Option
    // ==========================================
    const delBtn = document.createElement("button");
    delBtn.className = "pr-gap-menu-btn";
    delBtn.innerHTML = `Delete`;
    delBtn.style.color = "#ff4444";
    delBtn.onclick = () => {
      this.selectionType = trackType;
      const list = this.getSegmentArray(trackType);
      this.selectedIndex = list.findIndex(s => s.id === seg.id);
      this.deleteSelectedSegment();
      this.dismissContextMenu();
    };

    // Group 1: Segment Options (Always present)
    menu.appendChild(copySegBtn);
    if (canPaste) menu.appendChild(pasteSegBtn);
    if (canReplace) menu.appendChild(pasteReplaceBtn);
    menu.appendChild(makeDivider());

    // Group 2: Prompt Options (Only if not audio)
    if (copyPromptBtn && pastePromptBtn) {
      menu.appendChild(copyPromptBtn);
      menu.appendChild(pastePromptBtn);
      menu.appendChild(makeDivider());
    }

    if (fitToAudioBtn || fitToVisualBtn) {
      if (fitToAudioBtn) menu.appendChild(fitToAudioBtn);
      if (fitToVisualBtn) menu.appendChild(fitToVisualBtn);
      menu.appendChild(makeDivider());
    }
    if (setOutputRangeBtn || setDurationEndBtn) {
      if (setOutputRangeBtn) menu.appendChild(setOutputRangeBtn);
      if (setDurationEndBtn) menu.appendChild(setDurationEndBtn);
      menu.appendChild(makeDivider());
    }
    menu.appendChild(markSelectionBtn);
    menu.appendChild(makeDivider());

    // Group 3: Image utility options (Only if isImage)
    if (isImage) {
      menu.appendChild(replaceWithFileBtn);
      menu.appendChild(copyImgBtn);
      menu.appendChild(saveImgBtn);
      menu.appendChild(openImgBtn);
      menu.appendChild(replaceImgBtn);
      menu.appendChild(makeDivider());
    }

    // Group 4: 转为结束帧 (Only if toggleEndFrameBtn is defined)
    if (toggleEndFrameBtn) {
      menu.appendChild(toggleEndFrameBtn);
      menu.appendChild(makeDivider());
    }

    // Group 5: 取消媒体关联
    if (unlinkBtn) {
      menu.appendChild(unlinkBtn);
      menu.appendChild(makeDivider());
    }

    // Group 6: Delete Option
    menu.appendChild(delBtn);

    document.body.appendChild(menu);
    this.fitContextMenuToViewport(menu);
    this._contextMenu = menu;

    setTimeout(() => {
      this._contextMenuDismisser = (ev) => { if (!menu.contains(ev.target)) this.dismissContextMenu(); };
      document.addEventListener("pointerdown", this._contextMenuDismisser, true);
    }, 0);
  }

  showGapContextMenu(clientX, clientY, gap) {
    this.dismissContextMenu();
    const menu = document.createElement("div");
    menu.className = "pr-gap-menu";
    menu.style.left = `${clientX + 6}px`;
    menu.style.top = `${clientY - 10}px`;

    const currentTrack = gap.track;

    const hasCopied = this._copiedSegment || window._ltxCopiedSegment;
    const copiedTrack = this._copiedSegmentTrack || window._ltxCopiedSegmentType;
    const copiedSegData = this._copiedSegment || (window._ltxCopiedSegment ? window._ltxCopiedSegment.main : null);
    const copiedSibData = window._ltxCopiedSegment ? window._ltxCopiedSegment.sibling : null;

    const canPaste = hasCopied && this.getCanonicalTrack(copiedTrack) === this.getCanonicalTrack(currentTrack) && copiedSegData;
    // 多参主轨可粘贴文本 / 视频
    const multiMainPaste =
      this.isH3MultiMode && this.isH3MultiMode() && currentTrack === "image";
    const pasteOk =
      canPaste &&
      !(multiMainPaste && copiedSegData?.type && copiedSegData.type !== "text" && copiedSegData.type !== "video");
    const pasteBtn = document.createElement("button");
    pasteBtn.className = "pr-gap-menu-btn";
    pasteBtn.innerHTML = `粘贴片段`;
    if (pasteOk) {
      pasteBtn.onclick = () => {
        const startFrame = Math.round(gap.clickedFrame !== undefined ? gap.clickedFrame : gap.frameStart);
        this.pasteSegmentAtFrame(copiedSegData, this.getCanonicalTrack(copiedTrack), copiedSibData, startFrame);
        this.dismissContextMenu();
      };
      menu.appendChild(pasteBtn);
    }

    if (currentTrack === "image") {
      // 多参主轨：文本 + 视频（视频跳过一采）；图片走多参图轨
      const multiMain = this.isH3MultiMode && this.isH3MultiMode();
      const textBtn = document.createElement("button");
      textBtn.className = "pr-gap-menu-btn";
      textBtn.innerHTML = multiMain ? `${ICONS.text} 添加文本` : `${ICONS.text} 文字段`;
      textBtn.title = multiMain ? "主轨添加文本提示词" : "添加文字段";
      textBtn.onclick = () => {
        this.addSegmentInGap(gap.frameStart, gap.frameEnd, "text");
        this.dismissContextMenu();
      };
      menu.appendChild(textBtn);

      const vidBtn = document.createElement("button");
      vidBtn.className = "pr-gap-menu-btn";
      vidBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg> 视频段`;
      vidBtn.title = multiMain ? "主轨添加视频" : "添加视频段";
      vidBtn.onclick = () => {
        this.dismissContextMenu();
        const fi = document.createElement("input");
        fi.type = "file"; fi.accept = "video/*";
        fi.addEventListener("change", (ev) => {
          if (ev.target.files?.[0]) this.handleVideoUpload([ev.target.files[0]], gap.frameStart);
        });
        fi.click();
      };
      menu.appendChild(vidBtn);

      if (!multiMain) {
        const imgBtn = document.createElement("button");
        imgBtn.className = "pr-gap-menu-btn";
        imgBtn.innerHTML = `${ICONS.upload} 图片段`;
        imgBtn.onclick = () => {
          this.dismissContextMenu();
          const fi = document.createElement("input");
          fi.type = "file"; fi.accept = "image/*";
          fi.addEventListener("change", (ev) => {
            if (ev.target.files?.[0]) {
              const gapLength = gap.frameEnd - gap.frameStart;
              this.handleImageUpload([ev.target.files[0]], gap.frameStart, gapLength);
            }
          });
          fi.click();
        };
        menu.appendChild(imgBtn);

        const pasteImageBtn = document.createElement("button");
        pasteImageBtn.className = "pr-gap-menu-btn";
        pasteImageBtn.innerHTML = `${ICONS.upload} 粘贴图片`;
        this._checkClipboardForImage(pasteImageBtn);
        pasteImageBtn.onclick = async () => {
          this.dismissContextMenu();
          try {
            const items = await navigator.clipboard.read();
            for (const item of items) {
              const imageTypes = item.types.filter(type => type.startsWith("image/"));
              if (imageTypes.length > 0) {
                const blob = await item.getType(imageTypes[0]);
                const file = new File([blob], "clipboard.png", { type: blob.type });
                const startFrame = Math.round(gap.clickedFrame !== undefined ? gap.clickedFrame : gap.frameStart);
                const gapLength = gap.frameEnd - startFrame;

                await this.handleImageUpload([file], startFrame, gapLength);
                break;
              }
            }
          } catch (err) {
            console.error("Failed to paste image from clipboard", err);
          }
        };

        menu.appendChild(pasteImageBtn);
      }
    } else if (currentTrack === "motion") {
      const vidBtn = document.createElement("button");
      vidBtn.className = "pr-gap-menu-btn";
      vidBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg> 视频段`;
      vidBtn.onclick = () => {
        this.dismissContextMenu();
        this.promptAddMotionInGap(gap.frameStart, gap.frameEnd);
      };
      menu.appendChild(vidBtn);
    } else if (currentTrack === "audio") {
      const audBtn = document.createElement("button");
      audBtn.className = "pr-gap-menu-btn";
      audBtn.innerHTML = `${ICONS.audio} 音频段`;
      audBtn.onclick = () => {
        this.dismissContextMenu();
        this.promptAddAudioInGap(gap.frameStart, gap.frameEnd);
      };
      menu.appendChild(audBtn);
    } else if (currentTrack === "ref") {
      const imgBtn = document.createElement("button");
      imgBtn.className = "pr-gap-menu-btn";
      imgBtn.innerHTML = `${ICONS.upload} 添加图片`;
      imgBtn.onclick = () => {
        this.dismissContextMenu();
        this.promptAddH3RefImage();
      };
      menu.appendChild(imgBtn);
    }

    document.body.appendChild(menu);
    this.fitContextMenuToViewport(menu);
    this._contextMenu = menu;
    setTimeout(() => {
      this._contextMenuDismisser = (ev) => { if (!menu.contains(ev.target)) this.dismissContextMenu(); };
      document.addEventListener("pointerdown", this._contextMenuDismisser, true);
      document.addEventListener("wheel", this._contextMenuDismisser, true);
    }, 0);
  }
  dismissContextMenu() {
    if (this._contextMenu) { this._contextMenu.remove(); this._contextMenu = null; }
    if (this._contextMenuDismisser) {
      document.removeEventListener("pointerdown", this._contextMenuDismisser, true);
      document.removeEventListener("wheel", this._contextMenuDismisser, true);
      this._contextMenuDismisser = null;
    }
  }

  // --- Gap Popup Menu ---
  showGapMenu(clientX, clientY, gap) {
    this.dismissGapMenu();
    const menu = document.createElement("div");
    menu.className = "pr-gap-menu";
    menu.style.left = `${clientX + 6}px`;
    menu.style.top = `${clientY - 10}px`;

    const currentTrack = gap.track;

    if (currentTrack === "ref") {
      const imgBtn = document.createElement("button");
      imgBtn.className = "pr-gap-menu-btn";
      imgBtn.innerHTML = `${ICONS.upload} 添加图片`;
      imgBtn.addEventListener("click", () => {
        this.dismissGapMenu();
        this.promptAddH3RefImage();
      });
      menu.appendChild(imgBtn);
      document.body.appendChild(menu);
      this.fitContextMenuToViewport(menu);
      this._gapMenu = menu;
      setTimeout(() => {
        this._gapMenuDismisser = (ev) => {
          if (!menu.contains(ev.target)) this.dismissGapMenu();
        };
        document.addEventListener("pointerdown", this._gapMenuDismisser, true);
      }, 0);
      return;
    }

    if (currentTrack === "image") {
      // 多参主轨「+」：文本 + 视频；图片走多参图轨
      const multiMain = this.isH3MultiMode && this.isH3MultiMode();
      const textBtn = document.createElement("button");
      textBtn.className = "pr-gap-menu-btn";
      textBtn.innerHTML = multiMain ? `${ICONS.text} 添加文本` : `${ICONS.text} 文字段`;
      textBtn.title = multiMain ? "主轨添加文本提示词" : "添加文字段";
      textBtn.addEventListener("click", () => {
        this.addSegmentInGap(gap.frameStart, gap.frameEnd, "text");
        this.dismissGapMenu();
      });
      menu.appendChild(textBtn);

      const vidBtn = document.createElement("button");
      vidBtn.className = "pr-gap-menu-btn";
      vidBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg> 视频段`;
      vidBtn.title = multiMain ? "主轨添加视频" : "添加视频段";
      vidBtn.addEventListener("click", () => {
        this.dismissGapMenu();
        const fi = document.createElement("input");
        fi.type = "file"; fi.accept = "video/*";
        fi.addEventListener("change", (ev) => {
          if (ev.target.files?.[0]) {
            this.handleVideoUpload([ev.target.files[0]], gap.frameStart);
          }
        });
        fi.click();
      });
      menu.appendChild(vidBtn);

      if (!multiMain) {
        const imgBtn = document.createElement("button");
        imgBtn.className = "pr-gap-menu-btn";
        imgBtn.innerHTML = `${ICONS.upload} 图片段`;
        imgBtn.addEventListener("click", () => {
          this.dismissGapMenu();
          const fi = document.createElement("input");
          fi.type = "file"; fi.accept = "image/*";
          fi.addEventListener("change", (ev) => {
            if (ev.target.files?.[0]) {
              const gapLength = gap.frameEnd - gap.frameStart;
              this.handleImageUpload([ev.target.files[0]], gap.frameStart, gapLength);
            }
          });
          fi.click();
        });

        const pasteImageBtn = document.createElement("button");
        pasteImageBtn.className = "pr-gap-menu-btn";
        pasteImageBtn.innerHTML = `${ICONS.upload} 粘贴图片`;
        this._checkClipboardForImage(pasteImageBtn);
        pasteImageBtn.addEventListener("click", async () => {
          this.dismissGapMenu();
          try {
            const items = await navigator.clipboard.read();
            for (const item of items) {
              const imageTypes = item.types.filter(type => type.startsWith("image/"));
              if (imageTypes.length > 0) {
                const blob = await item.getType(imageTypes[0]);
                const file = new File([blob], "clipboard.png", { type: blob.type });
                const gapLength = gap.frameEnd - gap.frameStart;
                await this.handleImageUpload([file], gap.frameStart, gapLength);
                break;
              }
            }
          } catch (err) {
            console.error("Failed to paste image from clipboard", err);
          }
        });

        menu.appendChild(imgBtn);
        menu.appendChild(pasteImageBtn);
      }
    } else if (currentTrack === "motion") {
      const vidBtn = document.createElement("button");
      vidBtn.className = "pr-gap-menu-btn";
      vidBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg> 视频段`;
      vidBtn.addEventListener("click", () => {
        this.dismissGapMenu();
        this.promptAddMotionInGap(gap.frameStart, gap.frameEnd);
      });
      menu.appendChild(vidBtn);
    } else if (currentTrack === "audio") {
      const audBtn = document.createElement("button");
      audBtn.className = "pr-gap-menu-btn";
      audBtn.innerHTML = `${ICONS.audio} 音频段`;
      audBtn.addEventListener("click", () => {
        this.dismissGapMenu();
        this.promptAddAudioInGap(gap.frameStart, gap.frameEnd);
      });
      menu.appendChild(audBtn);
    }

    const hasCopied = this._copiedSegment || window._ltxCopiedSegment;
    const copiedTrack = this._copiedSegmentTrack || window._ltxCopiedSegmentType;
    const copiedSegData = this._copiedSegment || (window._ltxCopiedSegment ? window._ltxCopiedSegment.main : null);
    const copiedSibData = window._ltxCopiedSegment ? window._ltxCopiedSegment.sibling : null;

    const canPaste = hasCopied && this.getCanonicalTrack(copiedTrack) === this.getCanonicalTrack(currentTrack) && copiedSegData;
    // 多参主轨可粘贴文本 / 视频
    const multiMainPaste =
      this.isH3MultiMode && this.isH3MultiMode() && currentTrack === "image";
    const pasteOk =
      canPaste &&
      !(multiMainPaste && copiedSegData?.type && copiedSegData.type !== "text" && copiedSegData.type !== "video");
    const pasteBtn = document.createElement("button");
    pasteBtn.className = "pr-gap-menu-btn";
    pasteBtn.innerHTML = `粘贴片段`;
    if (pasteOk) {
      pasteBtn.onclick = () => {
        const startFrame = Math.round(gap.frameStart);
        this.pasteSegmentAtFrame(copiedSegData, this.getCanonicalTrack(copiedTrack), copiedSibData, startFrame);
        this.dismissGapMenu();
      };
      menu.appendChild(pasteBtn);
    }

    document.body.appendChild(menu);
    this.fitContextMenuToViewport(menu);
    this._gapMenu = menu;
    setTimeout(() => {
      this._gapMenuDismisser = (ev) => { if (!menu.contains(ev.target)) this.dismissGapMenu(); };
      document.addEventListener("pointerdown", this._gapMenuDismisser, true);
      document.addEventListener("wheel", this._gapMenuDismisser, true);
    }, 0);
  }

  dismissGapMenu() {
    if (this._gapMenu) { this._gapMenu.remove(); this._gapMenu = null; }
    if (this._gapMenuDismisser) {
      document.removeEventListener("pointerdown", this._gapMenuDismisser, true);
      document.removeEventListener("wheel", this._gapMenuDismisser, true);
      this._gapMenuDismisser = null;
    }
  }

  // --- Settings Menu ---
  // Widgets that are managed by the settings menu (hidden from node by default).
  get _settingsWidgetNames() {
    return ["display_mode", "epsilon", "divisible_by", "img_compression"];
  }

  persistVisibility(name, visible) {
    if (!this.node.properties) this.node.properties = {};
    this.node.properties[name] = !!visible;
    if (app.graph) app.graph.setDirtyCanvas(true, true);
  }

  restoreSettingsWidgetsVisibility() {
    if (this.node.properties?.[SETTINGS_WIDGETS_VISIBLE_PROPERTY] === true) {
      this.showSettingsWidgets(false);
    } else {
      this.hideSettingsWidgets(false);
    }
  }

  restoreGlobalPromptVisibility() {
    this.setGlobalPromptVisibility(this.node.properties?.[GLOBAL_PROMPT_VISIBLE_PROPERTY] === true, false);
  }

  setGlobalPromptVisibility(visible, persist = true) {
    const w = this.node.widgets?.find(w => w.name === "global_prompt");
    if (!w) return;
    if (visible) {
      showWidget(w);
    } else {
      hideWidget(w);
    }
    if (persist) this.persistVisibility(GLOBAL_PROMPT_VISIBLE_PROPERTY, visible);
  }

  // Hide all settings widgets on the node (called on init).
  hideSettingsWidgets(persist = true) {
    if (persist) this.persistVisibility(SETTINGS_WIDGETS_VISIBLE_PROPERTY, false);
    const isLiteGraph = !window.LiteGraph || !window.LiteGraph.vueNodesMode;
    // If any settings widgets have active connections, show settings widgets instead
    let hasActiveSettings = false;
    for (const name of this._settingsWidgetNames) {
      const hasInput = this.node.inputs?.find(i => i.name === name);
      if (hasInput && hasInput.link != null) {
        hasActiveSettings = true;
        break;
      }
    }

    if (hasActiveSettings) {
      this.showSettingsWidgets(persist);
      return;
    }

    for (const name of this._settingsWidgetNames) {
      const w = this.node.widgets?.find(w => w.name === name);
      if (w) {
        hideWidget(w);
        // If it was converted to an input slot but is unconnected, remove the input slot
        if (isLiteGraph && this.node.inputs) {
          const idx = this.node.inputs.findIndex(i => i.name === name);
          if (idx !== -1 && this.node.inputs[idx].link == null) {
            this.node.removeInput(idx);
          }
        }
      }
    }
    this.updateWidgetVisibility();

    // Workaround: toggle display mode to force ComfyUI to refresh the node
    if (this.displayModeWidget) {
      const origVal = this.displayModeWidget.value;
      const otherVal = this._toggleDisplayModeValue(origVal);

      this.displayModeWidget.value = otherVal;
      if (this.displayModeWidget.callback) this.displayModeWidget.callback(otherVal);

      this.displayModeWidget.value = origVal;
      if (this.displayModeWidget.callback) this.displayModeWidget.callback(origVal);
    }
  }

  // Restore all settings widgets on the node.
  showSettingsWidgets(persist = true) {
    if (persist) this.persistVisibility(SETTINGS_WIDGETS_VISIBLE_PROPERTY, true);
    const isLiteGraph = !window.LiteGraph || !window.LiteGraph.vueNodesMode;
    for (const name of this._settingsWidgetNames) {
      const w = this.node.widgets?.find(w => w.name === name);
      if (!w) continue;
      showWidget(w);

      // If the widget is a converted-widget but the input slot is missing, add it back!
      if (isLiteGraph && w.type === "converted-widget" && this.node.inputs) {
        if (!this.node.inputs.find(i => i.name === name)) {
          let type = "FLOAT";
          if (name === "divisible_by" || name === "img_compression") {
            type = "INT";
          } else if (name === "display_mode") {
            type = "COMBO";
          }
          const slot = this.node.addInput(name, type);
          if (slot != null) {
            const inp = this.node.inputs[this.node.inputs.length - 1];
            if (inp) inp.widget = { name };
          }
        }
      }
    }
    this.updateWidgetVisibility();

    // Workaround: toggle display mode to force ComfyUI to refresh the node
    if (this.displayModeWidget) {
      const origVal = this.displayModeWidget.value;
      const otherVal = this._toggleDisplayModeValue(origVal);

      this.displayModeWidget.value = otherVal;
      if (this.displayModeWidget.callback) this.displayModeWidget.callback(otherVal);

      this.displayModeWidget.value = origVal;
      if (this.displayModeWidget.callback) this.displayModeWidget.callback(origVal);
    }
  }

  // --- Save / Load Handlers ---
  async handleLoadTimeline() {
    try {
      if (window.showOpenFilePicker) {
        const [fileHandle] = await window.showOpenFilePicker({
          types: [{ description: 'Timeline JSON', accept: { 'application/json': ['.json'] } }],
          multiple: false
        });
        const file = await fileHandle.getFile();
        const content = await file.text();
        this._applyLoadedTimeline(content, fileHandle);
      } else {
        // Fallback for browsers without showOpenFilePicker (e.g. Firefox)
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json";
        input.onchange = e => {
          const file = e.target.files[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = evt => this._applyLoadedTimeline(evt.target.result, null);
          reader.readAsText(file);
        };
        input.click();
      }
    } catch (e) {
      if (e.name !== "AbortError") {
        console.error("Failed to load timeline:", e);
        alert("Failed to load timeline. See console for details.");
      }
    }
  }

  _applyLoadedTimeline(jsonStr, fileHandle) {
    try {
      const data = JSON.parse(jsonStr);

      // Load settings if present
      if (data.global_prompt !== undefined) {
        if (data.retake_global_prompt !== undefined) {
          this.timeline.global_prompt = data.global_prompt;
          this.timeline.retake_global_prompt = data.retake_global_prompt;
        } else {
          this.syncGlobalPrompt(data.global_prompt);
        }
      }
      if (data.settings) {
        for (const [key, value] of Object.entries(data.settings)) {
          // Handle legacy keys for backward compatibility
          if (key === "startFrames" && this.startFramesWidget) {
            this.startFramesWidget.value = value;
            if (this.startFramesWidget.callback) this.startFramesWidget.callback(value);
            continue;
          }
          if (key === "durationFrames" && this.durationFramesWidget) {
            this.durationFramesWidget.value = value;
            if (this.durationFramesWidget.callback) this.durationFramesWidget.callback(value);
            continue;
          }
          if (key === "frameRate" && this.frameRateWidget) {
            this.frameRateWidget.value = value;
            if (this.frameRateWidget.callback) this.frameRateWidget.callback(value);
            continue;
          }

          const w = this.node.widgets?.find(x => x.name === key);
          if (w) {
            w.value = value;
            if (w.callback) w.callback(w.value);
          }
        }
      }

      if (this.timelineDataWidget) this.timelineDataWidget.value = JSON.stringify(data.timeline || data);
      this.timeline = parseInitial(this.timelineDataWidget.value);
      this.mainTrackEnabled = this.timeline.mainTrackEnabled !== false;
      this.audioTrackEnabled = this.timeline.audioTrackEnabled !== false;
      this.motionTrackEnabled = this.timeline.motionTrackEnabled !== false;
      this.manualOutputRange = this.timeline.manualOutputRange === true;
      this.updateManualOutputRangeToggle();
      if (this.timeline.showFilenames !== undefined) {
        this.node.properties.showFilenames = this.timeline.showFilenames;
      }
      if (this.timeline.overrideAudio !== undefined) {
        this.node.properties.overrideAudio = this.timeline.overrideAudio;
      }
      if (this.timeline.inpaint_audio !== undefined) {
        this.node.properties.inpaint_audio = this.timeline.inpaint_audio;
      }
      if (this.timeline.propHeight !== undefined) {
        this.node.properties.propHeight = this.timeline.propHeight;
        this.propHeight = this.timeline.propHeight;
        if (this.propContainer) {
          this.propContainer.style.height = `${this.propHeight}px`;
        }
      }
      if (this.timeline.globalPropHeight !== undefined) {
        this.node.properties.globalPropHeight = this.timeline.globalPropHeight;
        this.globalPropHeight = this.timeline.globalPropHeight;
        if (this.globalPropContainer) {
          this.globalPropContainer.style.height = `${this.globalPropHeight}px`;
        }
      }
      this.currentFileHandle = fileHandle;
      this.retakeMode = this.timeline.retakeMode === true;

      this.loadMedia();

      if (!this.retakeMode) {
        this._suppressCommit = true;
        if (this.timeline.normalStartFrame !== undefined && this.startFramesWidget) {
          this.startFramesWidget.value = this.timeline.normalStartFrame;
          if (this.startFramesWidget.callback) {
            try { this.startFramesWidget.callback(this.timeline.normalStartFrame); } catch (_) {}
          }
        }
        if (this.timeline.normalDurationFrames !== undefined && this.durationFramesWidget) {
          this.durationFramesWidget.value = this.timeline.normalDurationFrames;
          if (this.durationFramesWidget.callback) {
            try { this.durationFramesWidget.callback(this.timeline.normalDurationFrames); } catch (_) {}
          }
        }
        this._suppressCommit = false;
      }

      this.updateRetakeUIState();
      this.updateUIFromSelection();
      this.syncWidgetsAndUI();
      this.commitChanges(true); // forces sync to UI and other widgets


      if (this.updateInpaintToggleStyle) {
        const inpaintWidget = this.node.widgets?.find(w => w.name === "inpaint_audio");
        if (inpaintWidget) this.updateInpaintToggleStyle(inpaintWidget.value);
      }

      this.render();
      this.dismissSettingsMenu();

      // Trigger ComfyUI's change-detection pipeline the same way a real user
      // interaction does: by dispatching a pointerup on the canvas. This fires
      // LiteGraph's onAfterChange → ChangeTracker.captureCanvasState() →
      // workflowDraftStore.saveDraft() → localStorage. This is what the user
      // experiences when they "move something" and it persists correctly.
      setTimeout(() => {
        try {
          const canvasEl = app.canvasEl || app.canvas?.canvas;
          if (canvasEl) {
            canvasEl.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
          }
          // Also try the direct ChangeTracker API as a backup for both frontend versions
          if (app.canvas && app.canvas.checkState) app.canvas.checkState();
          if (app.canvas && app.canvas.captureCanvasState) app.canvas.captureCanvasState();
        } catch (_) { }
      }, 100);
    } catch (e) {
      console.error("Invalid timeline JSON:", e);
      alert("Invalid timeline file.");
    }
  }

  _getTimelineSavePayload() {
    const allSettings = {};
    const skipWidgets = ["timeline_data", "local_prompts", "segment_lengths", "transition_smoothness", "guide_strength", "timeline_ui", "global_prompt", "use_ic_video_size"];

    for (const w of this.node.widgets || []) {
      if (!skipWidgets.includes(w.name) && w.value !== undefined) {
        allSettings[w.name] = w.value;
      }
    }

    const normPrompt = this.retakeMode ? (this.timeline.global_prompt || "") : (this.globalPromptInput ? this.globalPromptInput.value : "");
    const retPrompt = this.retakeMode ? (this.globalPromptInput ? this.globalPromptInput.value : "") : (this.timeline.retake_global_prompt || "");

    return JSON.stringify({
      version: 1,
      settings: allSettings,
      global_prompt: normPrompt,
      retake_global_prompt: retPrompt,
      timeline: {
        mainTrackEnabled: this.mainTrackEnabled,
        audioTrackEnabled: this.audioTrackEnabled,
        motionTrackEnabled: this.motionTrackEnabled,
        showFilenames: !!this.node.properties.showFilenames,
        manualOutputRange: this.manualOutputRange === true,
        overrideAudio: this.getOverrideAudioEnabled(),
        inpaint_audio: !!(this.node.widgets?.find(w => w.name === "inpaint_audio")?.value),
        propHeight: this.propHeight,
        globalPropHeight: this.globalPropHeight,
        global_prompt: normPrompt,
        retake_global_prompt: retPrompt,
        retakeMode: this.retakeMode,
        retakeStart: this.timeline.retakeStart,
        retakeLength: this.timeline.retakeLength,
        retakePrompt: this.timeline.retakePrompt,
        retakeStrength: this.timeline.retakeStrength,
        retakeVideo: this.timeline.retakeVideo ? {
          fileName: this.timeline.retakeVideo.fileName,
          imageFile: this.timeline.retakeVideo.imageFile,
          videoDurationFrames: this.timeline.retakeVideo.videoDurationFrames,
          fileSize: this.timeline.retakeVideo.fileSize,
        } : null,
        normalStartFrame: this.timeline.normalStartFrame,
        normalDurationFrames: this.timeline.normalDurationFrames,
        segments: (this.timeline.segments || []).map(s => {
          const { imgObj, videoEl, _isSeeking, thumbnails, _extractingThumbs, _sSecs, _lSecs, _tSecs, _dSecs, _uploading, _blobUrl, ...rest } = s;
          return rest;
        }),
        motionSegments: (this.timeline.motionSegments || []).map(s => {
          const { imgObj, videoEl, _isSeeking, thumbnails, _extractingThumbs, _sSecs, _lSecs, _tSecs, _dSecs, _uploading, _blobUrl, ...rest } = s;
          return rest;
        }),
        audioSegments: (this.timeline.audioSegments || []).map(s => {
          const { _sSecs, _lSecs, _tSecs, _dSecs, _uploading, _decoding, _blobUrl, _audioBuffer, ...rest } = s;
          return rest;
        })
      }
    }, null, 2);
  }

  async handleSaveTimeline() {
    if (!this.currentFileHandle) {
      return this.handleSaveTimelineAs();
    }

    try {
      const payload = this._getTimelineSavePayload();
      const writable = await this.currentFileHandle.createWritable();
      await writable.write(payload);
      await writable.close();
      this.dismissSettingsMenu();
    } catch (e) {
      console.error("Failed to save timeline:", e);
      alert("Failed to save. You may need to use Save As.");
    }
  }

  async handleSaveTimelineAs() {
    const payload = this._getTimelineSavePayload();

    try {
      if (window.showSaveFilePicker) {
        const fileHandle = await window.showSaveFilePicker({
          suggestedName: "timeline_export.json",
          types: [{ description: 'Timeline JSON', accept: { 'application/json': ['.json'] } }]
        });
        const writable = await fileHandle.createWritable();
        await writable.write(payload);
        await writable.close();
        this.currentFileHandle = fileHandle;
      } else {
        // Fallback for Firefox
        const blob = new Blob([payload], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "timeline_export.json";
        a.click();
        URL.revokeObjectURL(url);
        // Can't track file handle via download fallback
        this.currentFileHandle = null;
      }
      this.dismissSettingsMenu();
    } catch (e) {
      if (e.name !== "AbortError") {
        console.error("Failed to save timeline as:", e);
      }
    }
  }

  _makeSettingRow(label, inputEl) {
    const row = document.createElement("div");
    row.className = "pr-settings-row";
    const lbl = document.createElement("span");
    lbl.className = "pr-settings-label";
    lbl.textContent = label;
    row.appendChild(lbl);
    row.appendChild(inputEl);
    return row;
  }

  showSettingsMenu(anchorEl) {
    this.dismissSettingsMenu();
    const menu = document.createElement("div");
    menu.className = "pr-settings-menu";

    // Title & Close Button Container
    const titleContainer = document.createElement("div");
    titleContainer.className = "pr-settings-title";
    titleContainer.style.display = "flex";
    titleContainer.style.justifyContent = "space-between";
    titleContainer.style.alignItems = "center";

    const titleText = document.createElement("span");
    titleText.textContent = "时间线设置";
    titleContainer.appendChild(titleText);

    const closeBtn = document.createElement("button");
    closeBtn.className = "pr-settings-close-btn";
    closeBtn.innerHTML = ICONS.close;
    closeBtn.title = "关闭设置";
    closeBtn.addEventListener("click", () => this.dismissSettingsMenu());
    titleContainer.appendChild(closeBtn);

    menu.appendChild(titleContainer);

    // --- Save / Load / Show Widgets Grid (2x2) ---
    const gridContainer = document.createElement("div");
    gridContainer.style.display = "grid";
    gridContainer.style.gridTemplateColumns = "repeat(2, 1fr)";
    gridContainer.style.gap = "6px";
    gridContainer.style.marginBottom = "4px";

    const btnSave = document.createElement("button");
    btnSave.className = "pr-settings-toggle-btn";
    btnSave.textContent = "保存时间线";
    btnSave.addEventListener("click", () => this.handleSaveTimeline());
    gridContainer.appendChild(btnSave);

    const btnSaveAs = document.createElement("button");
    btnSaveAs.className = "pr-settings-toggle-btn";
    btnSaveAs.textContent = "时间线另存为";
    btnSaveAs.addEventListener("click", () => this.handleSaveTimelineAs());
    gridContainer.appendChild(btnSaveAs);

    const btnLoad = document.createElement("button");
    btnLoad.className = "pr-settings-toggle-btn";
    btnLoad.textContent = "加载时间线";
    btnLoad.addEventListener("click", () => this.handleLoadTimeline());
    gridContainer.appendChild(btnLoad);

    // --- Show/Hide on Node Toggle ---
    const toggleBtn = document.createElement("button");
    toggleBtn.className = "pr-settings-toggle-btn";
    const widgetsVisible = !!(this.node.widgets?.find(w => w.name === "display_mode" && !(w.options && w.options.hidden)));
    toggleBtn.textContent = widgetsVisible ? "隐藏控件" : "显示控件";
    toggleBtn.addEventListener("click", () => {
      const nowVisible = !!(this.node.widgets?.find(w => w.name === "display_mode" && !(w.options && w.options.hidden)));
      if (nowVisible) {
        this.hideSettingsWidgets();
        const stillVisible = !!(this.node.widgets?.find(w => w.name === "display_mode" && !(w.options && w.options.hidden)));
        toggleBtn.textContent = stillVisible ? "隐藏控件" : "显示控件";
      } else {
        this.showSettingsWidgets();
        toggleBtn.textContent = "隐藏控件";
      }
    });
    gridContainer.appendChild(toggleBtn);

    menu.appendChild(gridContainer);

    const div2 = document.createElement("hr");
    div2.className = "pr-settings-divider";
    menu.appendChild(div2);

    // Helper: fire a widget's callback safely
    const fireCallback = (w, val) => {
      w.value = val;
      if (w.callback) {
        try { w.callback(val, app.canvas, this.node, null, null); } catch (e) { }
      }
      if (window.app && window.app.graph) window.app.graph.setDirtyCanvas(true, true);
    };

    // --- Display Mode ---
    const dmWidget = this.node.widgets?.find(w => w.name === "display_mode");
    if (dmWidget) {
      const ctrl = document.createElement("div");
      ctrl.className = "pr-segmented-control";

      const framesSeg = document.createElement("div");
      framesSeg.className = "pr-segment";
      framesSeg.textContent = "帧";

      const secondsSeg = document.createElement("div");
      secondsSeg.className = "pr-segment";
      secondsSeg.textContent = "秒";

      const updateActive = (val) => {
        const isFrames = (val === "frames" || val === "帧");
        if (isFrames) {
          framesSeg.classList.add("active");
          secondsSeg.classList.remove("active");
        } else {
          secondsSeg.classList.add("active");
          framesSeg.classList.remove("active");
        }
      };

      updateActive(dmWidget.value);

      const onSegClick = (val) => {
        fireCallback(dmWidget, val);
        updateActive(val);
        // Update ruler/timecode immediately
        if (this.updateWidgetVisibility) this.updateWidgetVisibility();
        if (this.updateUIFromSelection) this.updateUIFromSelection();
        this.render();
      };

      // 与节点 COMBO 选项一致（英文 frames/seconds，界面按钮仍显示中文）
      framesSeg.addEventListener("click", () => onSegClick("frames"));
      secondsSeg.addEventListener("click", () => onSegClick("seconds"));

      ctrl.appendChild(secondsSeg);
      ctrl.appendChild(framesSeg);

      menu.appendChild(this._makeSettingRow("时间显示", ctrl));
    }



    // --- Show Filenames Toggle ---
    const showFnameCtrl = document.createElement("div");
    showFnameCtrl.className = "pr-segmented-control";

    const offSeg = document.createElement("div");
    offSeg.className = "pr-segment";
    offSeg.textContent = "关";

    const onSeg = document.createElement("div");
    onSeg.className = "pr-segment";
    onSeg.textContent = "开";

    const updateFnameActive = (isEnabled) => {
      if (isEnabled) {
        onSeg.classList.add("active");
        offSeg.classList.remove("active");
      } else {
        offSeg.classList.add("active");
        onSeg.classList.remove("active");
      }
    };

    updateFnameActive(!!this.node.properties.showFilenames);

    const onFnameSegClick = (isEnabled) => {
      this.node.properties.showFilenames = isEnabled;
      updateFnameActive(isEnabled);
      this.render();
      this.commitChanges(true);
    };

    offSeg.addEventListener("click", () => onFnameSegClick(false));
    onSeg.addEventListener("click", () => onFnameSegClick(true));

    showFnameCtrl.appendChild(onSeg);
    showFnameCtrl.appendChild(offSeg);

    menu.appendChild(this._makeSettingRow("显示文件名", showFnameCtrl));

    const divider2 = document.createElement("div");
    divider2.className = "pr-settings-divider";
    menu.appendChild(divider2);

    // Helper to create scrubbable number control with horizontal buttons
    const createScrubbableNumberControl = (w, step, min, max, isFloat = false) => {
      const container = document.createElement("div");
      container.className = "pr-number-control";

      const decBtn = document.createElement("button");
      decBtn.className = "pr-number-btn";
      decBtn.textContent = "-";

      const inp = document.createElement("input");
      inp.type = "number";
      inp.className = "pr-settings-input";
      inp.value = w.value;
      inp.step = step.toString();
      inp.min = min.toString();
      inp.max = max.toString();

      const incBtn = document.createElement("button");
      incBtn.className = "pr-number-btn";
      incBtn.textContent = "+";

      decBtn.addEventListener("click", () => {
        let val = parseFloat(inp.value) - step;
        if (val < min) val = min;
        inp.value = isFloat ? val.toFixed(4) : Math.round(val);
        fireCallback(w, parseFloat(inp.value));
      });

      incBtn.addEventListener("click", () => {
        let val = parseFloat(inp.value) + step;
        if (val > max) val = max;
        inp.value = isFloat ? val.toFixed(4) : Math.round(val);
        fireCallback(w, parseFloat(inp.value));
      });

      inp.addEventListener("change", () => {
        let val = parseFloat(inp.value);
        if (isNaN(val)) val = w.value;
        if (val < min) val = min;
        if (val > max) val = max;
        inp.value = isFloat ? val.toFixed(4) : Math.round(val);
        fireCallback(w, parseFloat(inp.value));
      });

      // Dragging logic
      let isDragging = false;
      let startX = 0;
      let startVal = 0;
      let hasMoved = false;

      inp.style.cursor = "ew-resize";

      inp.addEventListener("mousedown", (e) => {
        startX = e.clientX;
        startVal = parseFloat(inp.value);
        hasMoved = false;

        const onMouseMove = (moveEvent) => {
          const deltaX = moveEvent.clientX - startX;
          if (Math.abs(deltaX) > 3) {
            hasMoved = true;
            isDragging = true;
          }

          if (isDragging) {
            moveEvent.preventDefault();
            const sensitivity = isFloat ? 0.001 : 0.5;
            let newVal = startVal + deltaX * sensitivity;

            if (newVal < min) newVal = min;
            if (newVal > max) newVal = max;

            inp.value = isFloat ? newVal.toFixed(4) : Math.round(newVal);
            fireCallback(w, parseFloat(inp.value));
          }
        };

        const onMouseUp = () => {
          document.removeEventListener("mousemove", onMouseMove);
          document.removeEventListener("mouseup", onMouseUp);

          if (!hasMoved) {
            inp.focus();
            inp.select();
          }
          isDragging = false;
        };

        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
      });

      container.appendChild(decBtn);
      container.appendChild(inp);
      container.appendChild(incBtn);

      return container;
    };

    // --- 生成尺寸：宽度 / 高度 / 总帧数 / 帧率 ---
    const widthWidget = this.node.widgets?.find(w => w.name === "custom_width");
    if (widthWidget) {
      menu.appendChild(this._makeSettingRow("宽度", createScrubbableNumberControl(widthWidget, 16, 0, 8192, false)));
    }
    const heightWidget = this.node.widgets?.find(w => w.name === "custom_height");
    if (heightWidget) {
      menu.appendChild(this._makeSettingRow("高度", createScrubbableNumberControl(heightWidget, 16, 0, 8192, false)));
    }
    const durFramesWidget = this.node.widgets?.find(w => w.name === "duration_frames");
    if (durFramesWidget) {
      menu.appendChild(this._makeSettingRow("总帧数", createScrubbableNumberControl(durFramesWidget, 1, 1, 10000, false)));
    }
    const fpsWidget = this.node.widgets?.find(w => w.name === "frame_rate");
    if (fpsWidget) {
      menu.appendChild(this._makeSettingRow("帧率", createScrubbableNumberControl(fpsWidget, 1, 1, 240, false)));
    }
    const overlapWidget = this.node.widgets?.find(w => w.name === "overlap_frames");
    if (overlapWidget) {
      menu.appendChild(this._makeSettingRow(
        "重叠帧数",
        createScrubbableNumberControl(overlapWidget, 1, 1, 64, false)
      ));
      // 通用说明
      const ovHint = menu.lastChild;
      if (ovHint) {
        ovHint.title = "段间运动重叠：1=仅用上一段最后一帧；更大则多帧重叠生成后裁掉重叠，更连贯也更耗资源";
      }
    }

    const sizeDivider = document.createElement("div");
    sizeDivider.className = "pr-settings-divider";
    menu.appendChild(sizeDivider);

    // --- Epsilon ---
    const epsWidget = this.node.widgets?.find(w => w.name === "epsilon");
    if (epsWidget) {
      menu.appendChild(this._makeSettingRow("过渡参数", createScrubbableNumberControl(epsWidget, 0.0001, 0.0001, 0.99, true)));
    }

    // --- Divisible By ---
    const divByWidget = this.node.widgets?.find(w => w.name === "divisible_by");
    if (divByWidget) {
      menu.appendChild(this._makeSettingRow("对齐倍数", createScrubbableNumberControl(divByWidget, 1, 1, 1024, false)));
    }

    // --- Img Compression ---
    const compWidget = this.node.widgets?.find(w => w.name === "img_compression");
    if (compWidget) {
      menu.appendChild(this._makeSettingRow("关键帧压缩", createScrubbableNumberControl(compWidget, 1, 0, 100, false)));
    }

    // --- Divider ---
    const folderDivider = document.createElement("div");
    folderDivider.className = "pr-settings-divider";
    menu.appendChild(folderDivider);

    // --- Workspace Folder Button ---
    const btnOpenFolder = document.createElement("button");
    btnOpenFolder.className = "pr-settings-toggle-btn";
    btnOpenFolder.textContent = "打开";
    btnOpenFolder.style.width = "98px";
    btnOpenFolder.style.margin = "0";
    btnOpenFolder.addEventListener("click", async () => {
      try {
        const response = await api.fetchApi("/wan_remix_director_open_folder");
        const data = await response.json();
        if (!data.success) {
          console.error("Failed to open workspace folder:", data.error || "Unknown error");
          alert("Could not open workspace folder. This option is only supported when running ComfyUI locally.");
        }
      } catch (err) {
        console.error("Error opening workspace folder:", err);
        alert("Error opening workspace folder: " + err.message);
      }
    });

    menu.appendChild(this._makeSettingRow("工作区文件夹", btnOpenFolder));







    // Position the menu below the anchor button (pop down)
    document.body.appendChild(menu);
    const rect = anchorEl.getBoundingClientRect();
    const menuW = menu.offsetWidth || 230;
    const menuH = menu.offsetHeight || 350;
    let left = rect.right - menuW;
    let top = rect.bottom + 6;
    if (left < 4) left = 4;
    // Fallback to top if it overflows the bottom of the screen
    if (top + menuH > window.innerHeight - 4) {
      top = rect.top - menuH - 6;
    }
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    this._settingsMenu = menu;
    setTimeout(() => {
      this._settingsDismisser = (ev) => {
        if (!menu.contains(ev.target) && !anchorEl.contains(ev.target)) this.dismissSettingsMenu();
      };
      document.addEventListener("pointerdown", this._settingsDismisser, true);
      document.addEventListener("wheel", this._settingsDismisser, true);
    }, 0);
  }

  dismissSettingsMenu() {
    if (this._settingsMenu) { this._settingsMenu.remove(); this._settingsMenu = null; }
    if (this._settingsDismisser) {
      document.removeEventListener("pointerdown", this._settingsDismisser, true);
      document.removeEventListener("wheel", this._settingsDismisser, true);
      this._settingsDismisser = null;
    }
  }

  /** 「说明」按钮：按导演台类型弹出对应说明（Wan / H3 分开） */
  getLazyHelpMeta() {
    if (this.isH3Director) {
      return {
        title: "Lazy · MinimaxH3 导演台 使用说明",
        filename: "Lazy_MinimaxH3_导演台_使用说明.txt",
      };
    }
    return {
      title: "Lazy · Wan 导演台 使用说明",
      filename: "Lazy_Wan_导演台_使用说明.txt",
    };
  }

  getLazyHelpText() {
    if (this.isH3Director) {
      return [
        "══════════════════════════════════════",
        "  Lazy · MinimaxH3 导演台 使用说明",
        "══════════════════════════════════════",
        "",
        "作者：Lazy不学习",
        "B站主页：https://space.bilibili.com/3706970246744888",
        "",
        "──────────────────────────────────────",
        "一、这是干什么的",
        "──────────────────────────────────────",
        "  Lazy MinimaxH3 导演台只服务 MiniMax H3 视频：",
        "  在时间线上排分镜 / 多参参考，再交给",
        "  「Lazy H3 逐段生成」采样出片。",
        "  不要按 Wan 的双噪声流程来接。",
        "",
        "──────────────────────────────────────",
        "二、推荐接线",
        "──────────────────────────────────────",
        "  Lazy H3 模型加载",
        "    ├─分镜模型──► 导演台「分镜模型」──► 逐段「分镜模型」",
        "    └─多参模型──► 导演台「多参模型」──► 逐段「多参模型」",
        "  CLIP（type=minimax）──► 导演台 + 逐段",
        "  视频 VAE / 音频 VAE ──► 逐段",
        "  导演台「H3分镜数据」──► 逐段 ──► Lazy H3 段拼合 ──► 导出",
        "",
        "──────────────────────────────────────",
        "三、工作台逻辑",
        "──────────────────────────────────────",
        "  · 分镜：fl2va，时间线放文/图/首尾/续写（默认）",
        "  · 多参：ref2va，用多参轨挂参考图/视频/音频",
        "  · 顶栏可在「分镜 / 多参」之间切换",
        "  · 多参主轨可加视频：不走一采，直接超分/二采修脸/补帧（哪个开着跑哪个）",
        "  · 主轨文本排故事；多参素材走多参轨，不要和 Wan 混用",
        "",
        "──────────────────────────────────────",
        "四、时间线用法",
        "──────────────────────────────────────",
        "  · 拖入图片/文字段，拖动调整时长与顺序",
        "  · ⇄ 首尾衔接 / ✕ 硬切：控制段与段怎么接",
        "  · 运动续接：在对应开关下按 H3 帧网格续写",
        "  · 时长会按 H3 的 17k+5 网格对齐，面板会显示设计秒与对齐后秒",
        "",
        "──────────────────────────────────────",
        "五、常用优化",
        "──────────────────────────────────────",
        "  · 负向提示：导演台或逐段里填写，会真正进采样",
        "  · 调度偏移：默认开（视频约 12 / 音频约 3）",
        "  · 重叠帧：默认 0；有尾帧时自动忽略重叠",
        "  · 尾帧裁末秒：默认约 0.35，减轻刹停感",
        "",
        "──────────────────────────────────────",
        "六、注意",
        "──────────────────────────────────────",
        "  · CLIP 必须是 minimax；VAE 用 H3 对应视频/音频 VAE",
        "  · 改完节点后重启 ComfyUI，并 Ctrl+F5 强刷页面",
        "  · 本说明仅针对 Lazy MinimaxH3 导演台，不含 Wan / Krea2",
        "",
        "如有问题欢迎通过 B 站私信作者 Lazy不学习。",
        "",
      ].join("\n");
    }

    return [
      "══════════════════════════════════════",
      "  Lazy · Wan 导演台 使用说明",
      "══════════════════════════════════════",
      "",
      "作者：Lazy不学习",
      "B站主页：https://space.bilibili.com/3706970246744888",
      "",
      "──────────────────────────────────────",
      "一、这是干什么的",
      "──────────────────────────────────────",
      "  Lazy Wan 导演台只服务 Wan2.2 Remix：",
      "  时间线排图/文/视频 → 逐段 high/low 采样 → 段拼合出片。",
      "  不要按 H3 / Krea2 的接法来用。",
      "",
      "──────────────────────────────────────",
      "二、推荐接线",
      "──────────────────────────────────────",
      "  高噪声 UNET ─┐",
      "  低噪声 UNET ─┼─► Lazy 导演台 ─► Lazy 逐段生成 ─► Lazy 视频段拼合 ─► 导出",
      "  CLIP(type=wan)┘         │              ▲",
      "  VAE(wan_2.1) ───────────┴──────────────┘",
      "",
      "  · 每段单独 high→low，显存只吃单段长度",
      "  · 全部段生成完再拼成长视频",
      "",
      "──────────────────────────────────────",
      "三、时间线逻辑",
      "──────────────────────────────────────",
      "  · 主轨：添加图片 / 文字 / 视频，拖动调时长",
      "  · 分段提示词、全局提示词分开填",
      "  · ⇄（蓝）首尾帧：本段接到下一段/下一张图",
      "  · ✕（红）硬切：本段只做首帧图生，不锁尾帧",
      "  · 文字段：前面有段则续上一段末帧；最前无前段则纯文生",
      "  · 宽度/高度按需要设置即可",
      "",
      "──────────────────────────────────────",
      "四、采样建议",
      "──────────────────────────────────────",
      "  · 高/低噪声步数常用 4+4（可按机器加）",
      "  · CFG = 1，采样器 euler，调度器 simple，Shift = 8",
      "  · 帧长建议符合 Wan 习惯（如 4n+1）",
      "",
      "──────────────────────────────────────",
      "五、模型",
      "──────────────────────────────────────",
      "  · 两个 UNET：high_lighting / low_lighting",
      "  · CLIP type = wan",
      "  · VAE：wan_2.1_vae",
      "",
      "  改完节点后请重启 ComfyUI，并 Ctrl+F5 强刷页面。",
      "  本说明仅针对 Lazy Wan 导演台，不含 H3 / Krea2。",
      "",
      "如有问题欢迎通过 B 站私信作者 Lazy不学习。",
      "",
    ].join("\n");
  }

  showLazyHelpDialog() {
    // 关闭已有弹层
    if (this._helpOverlay) {
      this._helpOverlay.remove();
      this._helpOverlay = null;
    }

    const meta = this.getLazyHelpMeta();
    const text = this.getLazyHelpText();
    const overlay = document.createElement("div");
    overlay.className = "pr-help-overlay";
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      background: "rgba(0,0,0,0.55)",
      zIndex: "100000",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "24px",
      boxSizing: "border-box",
    });

    const panel = document.createElement("div");
    Object.assign(panel.style, {
      width: "min(720px, 96vw)",
      maxHeight: "min(80vh, 720px)",
      background: "#1e1e1e",
      color: "#e8e8e8",
      border: "1px solid #444",
      borderRadius: "10px",
      boxShadow: "0 12px 40px rgba(0,0,0,0.45)",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
    });

    const header = document.createElement("div");
    Object.assign(header.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "12px 16px",
      borderBottom: "1px solid #333",
      fontWeight: "600",
      fontSize: "14px",
    });
    header.textContent = meta.title;

    const closeX = document.createElement("button");
    closeX.textContent = "×";
    Object.assign(closeX.style, {
      background: "transparent",
      border: "none",
      color: "#ccc",
      fontSize: "22px",
      cursor: "pointer",
      lineHeight: "1",
      padding: "0 4px",
    });
    header.appendChild(closeX);

    const pre = document.createElement("pre");
    Object.assign(pre.style, {
      margin: "0",
      padding: "14px 16px",
      overflow: "auto",
      flex: "1",
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
      fontFamily: "ui-monospace, Consolas, monospace",
      fontSize: "12px",
      lineHeight: "1.55",
      background: "#161616",
    });
    pre.textContent = text;

    const footer = document.createElement("div");
    Object.assign(footer.style, {
      display: "flex",
      gap: "8px",
      justifyContent: "flex-end",
      padding: "10px 16px",
      borderTop: "1px solid #333",
    });

    const mkBtn = (label, primary = false) => {
      const b = document.createElement("button");
      b.textContent = label;
      Object.assign(b.style, {
        padding: "6px 12px",
        borderRadius: "6px",
        border: primary ? "1px solid #3a7bd5" : "1px solid #555",
        background: primary ? "#2a5a9a" : "#2a2a2a",
        color: "#fff",
        cursor: "pointer",
        fontSize: "12px",
      });
      return b;
    };

    const dlBtn = mkBtn("下载说明.txt", true);
    const copyBtn = mkBtn("复制全文");
    const closeBtn = mkBtn("关闭");

    const close = () => {
      overlay.remove();
      this._helpOverlay = null;
    };

    dlBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = meta.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    copyBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = "已复制";
        setTimeout(() => { copyBtn.textContent = "复制全文"; }, 1200);
      } catch (_) {
        // fallback
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        copyBtn.textContent = "已复制";
        setTimeout(() => { copyBtn.textContent = "复制全文"; }, 1200);
      }
    });

    closeBtn.addEventListener("click", (e) => { e.stopPropagation(); close(); });
    closeX.addEventListener("click", (e) => { e.stopPropagation(); close(); });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });

    footer.appendChild(dlBtn);
    footer.appendChild(copyBtn);
    footer.appendChild(closeBtn);
    panel.appendChild(header);
    panel.appendChild(pre);
    panel.appendChild(footer);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    this._helpOverlay = overlay;
  }


  addSegmentInGap(frameStart, frameEnd, type = "text") {
    const seg = {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
      start: frameStart, length: frameEnd - frameStart,
      prompt: "", type,
      transitionToNext: "flf",
    };
    this.timeline.segments.push(seg);
    this.timeline.segments.sort((a, b) => a.start - b.start);

    if (!this.retakeMode) {
      this.growTimelineIfNeeded(seg.start + seg.length);
    }

    this.selectionType = "image";
    this.selectedIndex = this.timeline.segments.findIndex(s => s.id === seg.id);
    this.updateUIFromSelection();
    this.commitChanges();
  }

  addTextSegmentFreeSpace() {
    const frameRate = this.getFrameRate();
    const newLength = Math.max(1, frameRate); // 1 second default
    const sorted = [...this.timeline.segments].sort((a, b) => a.start - b.start);
    let newStart = 0;
    for (const seg of sorted) {
      if (newStart + newLength <= seg.start) break;
      newStart = Math.max(newStart, seg.start + seg.length);
    }
    // Place the segment at the first free slot in the visual timeline (no output duration change).
    const durationFrames = this.getVisualDurationFrames();
    const seg = {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
      start: newStart, length: Math.min(newLength, Math.max(newLength, durationFrames - newStart)),
      prompt: "", type: "text",
      transitionToNext: "flf",
    };
    this.timeline.segments.push(seg);
    this.timeline.segments.sort((a, b) => a.start - b.start);

    if (!this.retakeMode) {
      this.growTimelineIfNeeded(seg.start + seg.length);
    }

    this.selectionType = "image";
    this.selectedIndex = this.timeline.segments.findIndex(s => s.id === seg.id);
    this.updateUIFromSelection();
    this.commitChanges();
  }

  updateSeekBarBackground() {
    if (!this.seekBar) return;
    const max = parseFloat(this.seekBar.max) || 1;
    const val = parseFloat(this.seekBar.value) || 0;
    const pct = (val / max) * 100;
    this.seekBar.style.background = `linear-gradient(to right, #ff4444 0%, #ff4444 ${pct}%, #444 ${pct}%, #444 100%)`;
  }

  // --- Audio Player Engine ---
  updatePlayerUI() {
    if (!this.playBtn || !this.loopBtn) return;
    this.playBtn.innerHTML = this.isPlaying ? ICONS.pause : ICONS.play;
    if (this.isLooping) {
      this.loopBtn.classList.add("active");
    } else {
      this.loopBtn.classList.remove("active");
    }
    if (this.seekBar) {
      this.seekBar.max = this.getPlaybackDurationFrames();
      if (this.currentFrame > this.getPlaybackDurationFrames()) this.currentFrame = this.getPlaybackDurationFrames();
      this.seekBar.value = this.currentFrame;
      this.updateSeekBarBackground();
    }
    if (this.timeCodeDisplay) {
      this.timeCodeDisplay.textContent = this.formatTime(this.currentFrame);
    }
  }

  togglePlay() {
    if (this.isPlaying) {
      this.pauseAudio();
    } else {
      const playMax = this.getPlaybackDurationFrames();
      if (this.currentFrame >= playMax) {
        this.currentFrame = 0;
      }
      this.playAudio();
    }
  }

  toggleLoop() {
    this.isLooping = !this.isLooping;
    this.updatePlayerUI();
  }

  async playAudio() {
    this.pauseAudio(true); // clear any existing playback, but don't suspend context if scrubbing
    // 红线播放前先停掉多参槽位预览，避免删了参考音还在响
    try { this.h3StopMediaPreview?.(); } catch (_) {}

    this._playCounter = (this._playCounter || 0) + 1;
    const playId = this._playCounter;
    this._currentPlayId = playId;
    this.isPlaying = true;

    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.audioContext.state !== 'running') {
      try { await this.audioContext.resume(); } catch (e) { }
    }
    if (this._currentPlayId !== playId || !this.isPlaying) return;

    this.updatePlayerUI();

    const frameRate = this.getFrameRate();
    this.playbackStartFrame = this.currentFrame;
    this.playbackStartTime = this.audioContext.currentTime;

    // Build the list of active segments to play
    const segmentsToPlay = [];

    // 多参：不播旧 motion；驱动音频段（isH3Drive）跟红色播放头走
    const multiMode = this.isH3MultiMode && this.isH3MultiMode();
    if (multiMode && this.timeline) {
      this.timeline.motionSegments = [];
    }

    // 1. 音频段：普通模式播全部；多参只播驱动音频段
    if (this.audioTrackEnabled && !this.retakeMode && this.timeline.audioSegments) {
      for (let seg of this.timeline.audioSegments) {
        if (multiMode && !seg.isH3Drive) continue;
        if (!multiMode && seg.isH3Drive) continue;
        segmentsToPlay.push({
          type: "audio",
          originalSeg: seg,
          start: seg.start,
          length: seg.length,
          trimStart: seg.trimStart || 0,
          audioFile: seg.audioFile || seg.fileName,
          audioB64: seg.audioB64,
          _blobUrl: seg._blobUrl,
          fileSize: seg.fileSize,
        });
      }
    }

    // 2. Motion 视频段s (only if overrideAudio toggle is ON and NOT in retake mode)
    const isOverrideAudio = this.getOverrideAudioEnabled();
    if (isOverrideAudio && !this.retakeMode && !multiMode) {
      if (this.timeline.motionSegments) {
        for (let seg of this.timeline.motionSegments) {
          if (seg.videoFile || seg._blobUrl) {
            segmentsToPlay.push({
              type: 'motion',
              originalSeg: seg,
              start: seg.start,
              length: seg.length,
              trimStart: seg.trimStart || 0,
              audioFile: seg.videoFile || seg.fileName,
              audioB64: null,
              _blobUrl: seg._blobUrl,
              fileSize: seg.fileSize
            });
          }
        }
      }
    }

    // Decode and schedule all scheduled segments that happen AT or AFTER currentFrame in the background
    for (let item of segmentsToPlay) {
      const segStartFrame = item.start;
      const segEndFrame = item.start + item.length;

      if (segEndFrame <= this.currentFrame) continue;

      (async () => {
        try {
          // Build mock seg object for helper compatibility
          const mockSeg = {
            audioFile: item.audioFile,
            audioB64: item.audioB64,
            _blobUrl: item._blobUrl,
            fileSize: item.fileSize,
            waveformPeaks: item.originalSeg.waveformPeaks
          };

          await this._getOrExtractAudio(mockSeg);

          if (this._currentPlayId !== playId || !this.isPlaying) return;

          if (mockSeg.waveformPeaks && !item.originalSeg.waveformPeaks) {
            item.originalSeg.waveformPeaks = mockSeg.waveformPeaks;
            this.render();
          }

          if (!this._isAudioDecodingAllowed(mockSeg)) {
            return;
          }

          // Build audio buffer
          let audioBuffer = item.originalSeg._audioBuffer;
          if (!audioBuffer) {
            if (mockSeg.audioFile || mockSeg._blobUrl) {
              const parts = (mockSeg.audioFile || "").split(/[/\\\\]/);
              const filename = parts.pop() || '';
              const subfolder = parts.join('/');
              const audioUrl = mockSeg._blobUrl || api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);

              this._audioBufferCache = this._audioBufferCache || new Map();
              this._audioBufferPromises = this._audioBufferPromises || new Map();
              const cacheKey = mockSeg.audioFile || audioUrl;

              if (this._audioBufferCache.has(cacheKey)) {
                audioBuffer = this._audioBufferCache.get(cacheKey);
              } else if (this._audioBufferPromises.has(cacheKey)) {
                audioBuffer = await this._audioBufferPromises.get(cacheKey);
              } else {
                const decodePromise = (async () => {
                  const resp = await fetch(audioUrl);
                  const arrayBuffer = await resp.arrayBuffer();
                  return await this.audioContext.decodeAudioData(arrayBuffer);
                })();
                this._audioBufferPromises.set(cacheKey, decodePromise);
                try {
                  audioBuffer = await decodePromise;
                  this._audioBufferCache.set(cacheKey, audioBuffer);
                } finally {
                  this._audioBufferPromises.delete(cacheKey);
                }
              }
              item.originalSeg._audioBuffer = audioBuffer;
            } else if (mockSeg.audioB64) {
              const binaryString = window.atob(mockSeg.audioB64);
              const len = binaryString.length;
              const bytes = new Uint8Array(len);
              for (let i = 0; i < len; i++) {
                bytes[i] = binaryString.charCodeAt(i);
              }
              audioBuffer = await this.audioContext.decodeAudioData(bytes.buffer);
              item.originalSeg._audioBuffer = audioBuffer;
            } else {
              return;
            }
          }

          if (this._currentPlayId !== playId || !this.isPlaying) return;

          // Determine current playback position dynamically in Web Audio time
          const currentPlayTime = this.audioContext.currentTime;
          const elapsedSecSincePlayStart = currentPlayTime - this.playbackStartTime;
          const currentFrameCalculated = this.playbackStartFrame + elapsedSecSincePlayStart * frameRate;

          // If playback has already moved beyond the segment end, skip playing it
          if (currentFrameCalculated >= segEndFrame) return;

          let startTime, fileOffsetSec, playDurationSec;

          if (currentFrameCalculated < segStartFrame) {
            // Segment starts in the future relative to current playback position
            const waitFrames = segStartFrame - currentFrameCalculated;
            const waitTimeSec = waitFrames / frameRate;
            startTime = currentPlayTime + waitTimeSec;
            fileOffsetSec = item.trimStart / frameRate;
            playDurationSec = item.length / frameRate;
          } else {
            // Segment is already playing. Start immediately, but offset into the audio buffer
            startTime = currentPlayTime;
            const framesToSkip = currentFrameCalculated - segStartFrame;
            fileOffsetSec = (item.trimStart + framesToSkip) / frameRate;
            playDurationSec = (item.length - framesToSkip) / frameRate;
          }

          if (playDurationSec <= 0) return;

          const bufferNode = this.audioContext.createBufferSource();
          bufferNode.buffer = audioBuffer;
          bufferNode["connect"](this.audioContext.destination);
          bufferNode.start(startTime, fileOffsetSec, playDurationSec);

          this.activeAudioNodes.push(bufferNode);
        } catch (err) {
          console.error("Playback decode error for segment:", err);
        }
      })();
    }

    if (this._currentPlayId !== playId || !this.isPlaying) return;

    const loop = () => {
      if (!this.isPlaying || this._currentPlayId !== playId) return;

      const elapsedSec = this.audioContext.currentTime - this.playbackStartTime;
      const elapsedFrames = elapsedSec * frameRate;

      this.currentFrame = this.playbackStartFrame + elapsedFrames;

      const loopBound = this.getPlaybackDurationFrames();
      const stopBound = loopBound;

      if (this.isLooping) {
        if (this.currentFrame >= loopBound) {
          this.currentFrame = 0;
          this.playAudio(); // Restart playback
          return;
        }
      } else {
        if (this.currentFrame >= stopBound) {
          this.currentFrame = stopBound;
          this.pauseAudio();
          this.render();
          return;
        }
      }

      // Sync video playback
      if (this.retakeMode) {
        if (this.timeline.retakeVideo) {
          const retakeVid = this.timeline.retakeVideo;
          this._ensureVideoEl(retakeVid);
          if (retakeVid.videoEl) {
            const expectedSec = this.currentFrame / frameRate;
            if (retakeVid.videoEl.paused && !retakeVid.videoEl.seeking) {
              retakeVid.videoEl.currentTime = expectedSec;
              retakeVid.videoEl.muted = false;
              retakeVid.videoEl.play().catch(e => console.warn("Retake video play prevented", e));
            } else if (!retakeVid.videoEl.paused && Math.abs(retakeVid.videoEl.currentTime - expectedSec) > 0.5) {
              retakeVid.videoEl.currentTime = expectedSec;
            }
          }
        }
        // Pause all other video elements
        const allSegments = [...(this.timeline.segments || []), ...(this.timeline.motionSegments || [])];
        for (const seg of allSegments) {
          if (seg.videoEl && !seg.videoEl.paused) {
            seg.videoEl.pause();
          }
        }
      } else {
        const activeSegments = (this._isDragging && this._previewSegments && this.selectionType !== "audio") ? this._previewSegments : this.timeline.segments;
        const activeSeg = activeSegments.find(s => s.type === "video" && this.currentFrame >= s.start && this.currentFrame < s.start + s.length);
        const activeVideoEl = activeSeg ? activeSeg.videoEl : null;

        for (const seg of activeSegments) {
          if (seg.type === "video" && seg.videoEl) {
            if (seg === activeSeg) {
              const expectedSec = (seg.trimStart + (this.currentFrame - seg.start)) / frameRate;
              // 多参主轨预览静音，避免旧素材音干扰
              if (multiMode) seg.videoEl.muted = true;
              if (seg.videoEl.paused && !seg.videoEl.seeking) {
                // Not playing and no seek in flight — start a fresh seek+play
                seg.videoEl.currentTime = expectedSec;
                seg.videoEl.play().catch(e => console.warn("Video play prevented", e));
              } else if (!seg.videoEl.paused && Math.abs(seg.videoEl.currentTime - expectedSec) > 0.5) {
                // Already playing but drifted — resync
                seg.videoEl.currentTime = expectedSec;
              }
              // If paused && seeking: a seek+play is already in flight, let it finish
            } else {
              // Only pause if this segment's video element is NOT shared with the currently active segment
              if (seg.videoEl !== activeVideoEl && !seg.videoEl.paused) {
                seg.videoEl.pause();
              }
            }
          }
        }
      }

      // Sync motion playback（多参不走旧 motion 段，只用槽位）
      if (!this.retakeMode && !multiMode) {
        const activeMotionSegments = (this._isDragging && this._previewSegments && this.selectionType === "motion") ? this._previewSegments : this.timeline.motionSegments;
        const activeMotionSeg = activeMotionSegments.find(s => s.type === "motion_video" && this.currentFrame >= s.start && this.currentFrame < s.start + s.length);
        const activeMotionVideoEl = activeMotionSeg ? activeMotionSeg.videoEl : null;

        for (const seg of activeMotionSegments) {
          if (seg.type === "motion_video" && seg.videoEl) {
            if (seg === activeMotionSeg) {
              const expectedSec = (seg.trimStart + (this.currentFrame - seg.start)) / frameRate;
              if (seg.videoEl.paused && !seg.videoEl.seeking) {
                // Not playing and no seek in flight — start a fresh seek+play
                seg.videoEl.currentTime = expectedSec;
                seg.videoEl.play().catch(e => console.warn("Video play prevented", e));
              } else if (!seg.videoEl.paused && Math.abs(seg.videoEl.currentTime - expectedSec) > 0.5) {
                // Already playing but drifted — resync
                seg.videoEl.currentTime = expectedSec;
              }
              // If paused && seeking: a seek+play is already in flight, let it finish
            } else {
              // Only pause if this segment's video element is NOT shared with the currently active motion segment
              if (seg.videoEl !== activeMotionVideoEl && !seg.videoEl.paused) {
                seg.videoEl.pause();
              }
            }
          }
        }
      } else if (multiMode && Array.isArray(this.timeline.motionSegments)) {
        for (const seg of this.timeline.motionSegments) {
          if (seg?.videoEl && !seg.videoEl.paused) {
            try { seg.videoEl.pause(); } catch (_) {}
          }
        }
      }

      this.render();
      this._playLoopId = requestAnimationFrame(loop);
    };

    this._playLoopId = requestAnimationFrame(loop);
  }

  pauseAudio(isScrubbing = false) {
    this.isPlaying = false;
    this._currentPlayId = null;
    // 同步停掉多参槽位预览（删参考后红线停播时一并清）
    try { this.h3StopMediaPreview?.(); } catch (_) {}

    if (!isScrubbing && this.audioContext && this.audioContext.state === 'running') {
      try { this.audioContext.suspend(); } catch (e) { }
    }

    if (this.retakeMode && this.timeline.retakeVideo) {
      const retakeVid = this.timeline.retakeVideo;
      if (retakeVid.videoEl) {
        if (!retakeVid.videoEl.paused) {
          retakeVid.videoEl.pause();
        }
        retakeVid.videoEl.muted = true; // Mute again on pause/stop to prevent transient audio bursts
        retakeVid.videoEl.currentTime = this.currentFrame / this.getFrameRate();
      }
    } else {
      // Sync video segments on pause
      for (const seg of this.timeline.segments) {
        if (seg.type === "video" && seg.videoEl) {
          if (!seg.videoEl.paused) {
            seg.videoEl.pause();
          }
          if (this.currentFrame >= seg.start && this.currentFrame < seg.start + seg.length) {
            seg.videoEl.currentTime = (seg.trimStart + (this.currentFrame - seg.start)) / this.getFrameRate();
          }
        }
      }

      // Sync motion segments on pause
      for (const seg of this.timeline.motionSegments) {
        if (seg.type === "motion_video" && seg.videoEl) {
          if (!seg.videoEl.paused) {
            seg.videoEl.pause();
          }
          if (this.currentFrame >= seg.start && this.currentFrame < seg.start + seg.length) {
            seg.videoEl.currentTime = (seg.trimStart + (this.currentFrame - seg.start)) / this.getFrameRate();
          }
        }
      }
    }

    for (let node of this.activeAudioNodes) {
      try { node.stop(); } catch (e) { }
      try { node.disconnect(); } catch (e) { }
    }
    this.activeAudioNodes = [];

    if (this._playLoopId) {
      cancelAnimationFrame(this._playLoopId);
      this._playLoopId = null;
    }
    this.updatePlayerUI();
  }
}

// --- Node Registration Hooks ---
const APPENDED_WIDGET_DEFAULTS = [
  ["timeline_data", "{}"],
  ["local_prompts", ""],
  ["segment_lengths", ""],
  ["transition_smoothness", ""],
];

/**
 * H3 导演台：模型口只保留 model_fl / model_ref。
 * 旧工作流会残留 model，导致接口看起来乱七八糟。
 */
function fixH3DirectorModelInputs(node) {
  if (!node || !Array.isArray(node.inputs)) return;
  const graph = node.graph || app?.graph;
  const links = graph?.links;

  const findIn = (name) => node.inputs.findIndex((i) => i && i.name === name);

  // 1) 旧 model 有线且 model_fl 没线 → 迁到 model_fl
  const oldIdx = findIn("model");
  const flIdx = findIn("model_fl");
  if (oldIdx !== -1) {
    const oldIn = node.inputs[oldIdx];
    if (oldIn.link != null && links) {
      const link = links[oldIn.link];
      if (link && flIdx !== -1) {
        const flIn = node.inputs[flIdx];
        if (flIn.link == null) {
          try {
            // 断旧连、接到 model_fl
            const originId = link.origin_id;
            const originSlot = link.origin_slot;
            node.disconnectInput(oldIdx);
            const origin = graph.getNodeById(originId);
            if (origin) origin.connect(originSlot, node, flIdx);
          } catch (e) {
            console.warn("[LazyH3] migrate model→model_fl failed:", e);
          }
        } else {
          try {
            node.disconnectInput(oldIdx);
          } catch (_) {}
        }
      } else {
        try {
          node.disconnectInput(oldIdx);
        } catch (_) {}
      }
    }
    // 2) 删掉幽灵 model 口（只删 name===model，不动 model_fl/model_ref）
    const again = findIn("model");
    if (again !== -1) {
      try {
        node.removeInput(again);
      } catch (e) {
        // 某些前端禁止删 schema 口：至少改名/隐藏
        try {
          const ghost = node.inputs[again];
          if (ghost) {
            ghost.name = "_deprecated_model";
            ghost.type = -1;
            ghost.color_on = "#333";
            ghost.color_off = "#333";
          }
        } catch (_) {}
      }
    }
  }

  // 3) 校正 label，避免显示成中文/旧名混杂
  for (const inp of node.inputs) {
    if (!inp) continue;
    if (inp.name === "model_fl") {
      inp.label = "model_fl";
      inp.localized_name = "model_fl";
      if (inp.type !== "MODEL") inp.type = "MODEL";
    }
    if (inp.name === "model_ref") {
      inp.label = "model_ref";
      inp.localized_name = "model_ref";
      if (inp.type !== "MODEL") inp.type = "MODEL";
    }
  }

  // 4) 若缺 model_fl（极旧图只剩 model 已删）：补回
  if (findIn("model_fl") === -1) {
    try {
      node.addInput("model_fl", "MODEL");
    } catch (_) {}
  }
  if (findIn("model_ref") === -1) {
    try {
      node.addInput("model_ref", "MODEL");
    } catch (_) {}
  }

  node.setDirtyCanvas?.(true, true);
}

function markYusuNode(node) {
  if (!node.properties) node.properties = {};
  node.properties.cnr_id = "ceshi-WanRemixDirector";
  node.properties.aux_id = "ceshi/WanRemixDirector";
}

/** 把控件值纠正到合法范围，避免 “Value not in list” / “Value 0 smaller than min of 1” */
function sanitizeDirectorWidgets(node) {
  if (!node?.widgets) return;

  const resizeMap = {
    "保持宽高比": "maintain aspect ratio",
    "拉伸填充": "stretch to fit",
    "填充黑边": "pad",
    "填充绿边": "pad green",
    "裁剪": "crop",
  };
  const resizeOk = new Set([
    "maintain aspect ratio", "stretch to fit", "pad", "pad green", "crop",
  ]);
  const modeMap = { "帧": "frames", "秒": "seconds" };
  const modeOk = new Set(["frames", "seconds"]);

  const setNum = (name, minVal, fallback) => {
    const w = node.widgets.find(x => x.name === name);
    if (!w) return;
    let v = Number(w.value);
    if (!Number.isFinite(v) || v < minVal) {
      w.value = fallback;
    }
  };

  // COMBO：缩放方式
  const rw = node.widgets.find(x => x.name === "resize_method");
  if (rw) {
    if (resizeMap[rw.value]) rw.value = resizeMap[rw.value];
    if (!resizeOk.has(rw.value)) rw.value = "maintain aspect ratio";
  }

  // COMBO：时间显示
  const dw = node.widgets.find(x => x.name === "display_mode");
  if (dw) {
    if (modeMap[dw.value]) dw.value = modeMap[dw.value];
    if (!modeOk.has(dw.value)) dw.value = "seconds";
  }

  // 数值纠错：总帧数非法时用 1，不再把 0 强行改成 81
  setNum("duration_frames", 1, 1);
  setNum("end_frame", 0, 1);
  setNum("frame_rate", 1, 16);
  setNum("overlap_frames", 1, 1);
  setNum("divisible_by", 1, 16);
  setNum("duration_seconds", 0, 0.01);
  setNum("epsilon", 0, 0.001);
  setNum("custom_width", 0, 832);
  setNum("custom_height", 0, 480);
  setNum("start_frame", 0, 0);

  // 结束帧至少比起始帧大 1
  const sf = node.widgets.find(x => x.name === "start_frame");
  const ef = node.widgets.find(x => x.name === "end_frame");
  const df = node.widgets.find(x => x.name === "duration_frames");
  if (sf && ef && Number(ef.value) <= Number(sf.value)) {
    const dur = df && Number(df.value) >= 1 ? Number(df.value) : 1;
    ef.value = Number(sf.value) + dur;
  }
}

app.registerExtension({
  name: "WanRemixDirector",
  async beforeRegisterNodeDef(nodeType, nodeData, app) {
    // LazyH3Director：H3 单模型导演台，复用同一套时间线 UI（不改 Wan 逻辑）
    if (nodeData.name === "WanRemixDirector" || nodeData.name === "LazyH3Director") {

      const onNodeCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function () {
        if (onNodeCreated) onNodeCreated.apply(this, arguments);

        if (!this.properties) this.properties = {};
        markYusuNode(this);
        const DEFAULTS = {
          global_prompt: "",
          mainTrackEnabled: true,
          audioTrackEnabled: true,
          motionTrackEnabled: true,
          audioTrackWasEnabledBeforeOverride: false,
          inpaint_audio: true,
          override_audio: false,
          overrideAudio: false,
          use_ic_video_size: false,
          showFilenames: true,
          use_custom_audio: false,
          use_custom_motion: true,
          frame_rate: 16,
          display_mode: "seconds",
          custom_width: 832,
          custom_height: 480,
          resize_method: "maintain aspect ratio",
          divisible_by: 16,
          img_compression: 0,
          guide_strength: "",
          transition_smoothness: "",
          local_prompts: "",
          segment_lengths: "",
          timeline_data: "{}",
          epsilon: 0.001,
          start_second: 0.0,
          end_second: 5.0625,
          duration_seconds: 5.0625,
          start_frame: 0,
          end_frame: 81,
          duration_frames: 81,
          overlap_frames: 1,
        };
        for (const [key, val] of Object.entries(DEFAULTS)) {
          if (this.properties[key] === undefined) {
            this.properties[key] = val;
          }
        }

        for (const [name, def] of APPENDED_WIDGET_DEFAULTS) {
          if (!this.widgets?.find(w => w.name === name)) {
            this.addWidget("string", name, def, () => { });
          }
        }
        const isLiteGraph = !window.LiteGraph || !window.LiteGraph.vueNodesMode;
        const isH3Node = nodeData.name === "LazyH3Director";
        for (const w of this.widgets) {
          // H3：工作台由工具栏「分镜|多参」切换，隐藏下拉避免重复
          const hideExtra = isH3Node && (w.name === "workspace_mode");
          if (HIDDEN_WIDGET_NAMES.includes(w.name) || hideExtra) {
            hideWidget(w);
            if (isLiteGraph && this.inputs) {
              const idx = this.inputs.findIndex(i => i.name === w.name);
              if (idx !== -1 && this.inputs[idx].link == null) {
                this.removeInput(idx);
              }
            }
          }
        }

        // H3：清掉旧 model 幽灵口，统一 model_fl / model_ref
        if (isH3Node) {
          try {
            fixH3DirectorModelInputs(this);
          } catch (e) {
            console.warn("[LazyH3] fix model inputs:", e);
          }
          // 延后一帧再清一次（工作流反序列化后可能又塞回旧口）
          requestAnimationFrame(() => {
            try {
              fixH3DirectorModelInputs(this);
            } catch (_) {}
          });
        }

        // Set default width to be wider on creation (approx 2.5x default ~220px)
        this.size[0] = 1375;

        // 纠正非法 COMBO / 数值（工作流错位或旧默认值时）
        sanitizeDirectorWidgets(this);

        const self = this;
        this._syncGlobalPromptFromLink = function () {
          const globalInput = self.inputs?.find(i => i.name === "global_prompt");
          if (globalInput && globalInput.link !== null && globalInput.link !== undefined) {
            const link = app.graph.links[globalInput.link];
            if (link) {
              const originNode = app.graph.getNodeById(link.origin_id);
              if (originNode) {
                // Usually string values are in widgets[0] for primitives
                if (originNode.widgets && originNode.widgets.length > 0) {
                  const val = originNode.widgets[0].value;
                  if (self._timelineEditor && self._timelineEditor.globalPromptInput) {
                    const isRetake = self._timelineEditor.retakeMode;
                    const currentValInEditor = isRetake ? (self._timelineEditor.timeline.retake_global_prompt || "") : (self._timelineEditor.timeline.global_prompt || "");
                    if (val !== currentValInEditor) {
                      if (isRetake) {
                        self._timelineEditor.timeline.retake_global_prompt = val;
                      } else {
                        self._timelineEditor.timeline.global_prompt = val;
                      }
                      self._timelineEditor.globalPromptInput.value = val;
                      if (self._timelineEditor.selectionType === "motion") {
                        self._timelineEditor.promptInput.value = val;
                      }
                      if (self.properties) {
                        self.properties.global_prompt = val;
                      }
                    } else if (self._timelineEditor.globalPromptInput.value !== val) {
                      self._timelineEditor.globalPromptInput.value = val;
                    }
                  }
                }
              }
            }
          } else {
            if (self.properties && self._timelineEditor && self._timelineEditor.globalPromptInput) {
              const val = self.properties.global_prompt || "";
              const isRetake = self._timelineEditor.retakeMode;
              const currentValInEditor = isRetake ? (self._timelineEditor.timeline.retake_global_prompt || "") : (self._timelineEditor.timeline.global_prompt || "");
              if (val !== currentValInEditor) {
                if (isRetake) {
                  self._timelineEditor.timeline.retake_global_prompt = val;
                } else {
                  self._timelineEditor.timeline.global_prompt = val;
                }
                self._timelineEditor.globalPromptInput.value = val;
                if (self._timelineEditor.selectionType === "motion") {
                  self._timelineEditor.promptInput.value = val;
                }
              } else if (self._timelineEditor.globalPromptInput.value !== val) {
                self._timelineEditor.globalPromptInput.value = val;
              }
            }
          }
        };

        const origOnConnectionsChange = this.onConnectionsChange;
        this.onConnectionsChange = function (type, index, connected, link_info) {
          if (origOnConnectionsChange) {
            origOnConnectionsChange.apply(this, arguments);
          }
          self._syncGlobalPromptFromLink();
        };

        const origOnDrawForeground = this.onDrawForeground;
        this.onDrawForeground = function (ctx) {
          if (origOnDrawForeground) {
            origOnDrawForeground.apply(this, arguments);
          }
          self._syncGlobalPromptFromLink();
        };

        const container = document.createElement("div");

        container.style.boxSizing = "border-box";
        const widget = this.addDOMWidget("timeline_ui", "timeline_ui", container, {
          getValue: () => "",
          setValue: () => { },
        });

        widget.computeSize = function (width) {
          const ed = self._timelineEditor;
          const canvasH = ed ? ed.canvasHeight : CANVAS_HEIGHT;
          const propH = ed ? (ed.propHeight || 90) : 90;
          const globalPropH = ed ? (ed.globalPropHeight || 60) : 60;
          const nodeWidth = self.size?.[0] || width || 1375;
          // 工具栏 + 播放条 + 间距；多参图已并入 canvasH 第 1 轨
          const chromeH = 190;
          return [Math.max(10, nodeWidth - 30), canvasH + propH + globalPropH + chromeH];
        };

        setTimeout(() => {
          try {
            self._timelineEditor = new TimelineEditor(self, container, widget);
          } catch (err) {
            console.error("[PromptRelay] timeline editor init failed:", err);
          }
        }, 0);
      };

      const onResize = nodeType.prototype.onResize;
      nodeType.prototype.onResize = function (size) {
        const out = onResize?.apply(this, arguments);
        if (this._timelineEditor) {
          requestAnimationFrame(() => this._timelineEditor?.syncLayoutToNode());
        }
        return out;
      };

      const onRemoved = nodeType.prototype.onRemoved;
      nodeType.prototype.onRemoved = function () {
        this._timelineEditor?.destroy();
        return onRemoved?.apply(this, arguments);
      };

      const onConfigure = nodeType.prototype.onConfigure;
      nodeType.prototype.onConfigure = function (info) {
        // 1. Call parent/original onConfigure first, with info.widgets_values intact
        const out = onConfigure ? onConfigure.apply(this, arguments) : undefined;

        if (info.properties) {
          this.properties = { ...this.properties, ...info.properties };
        }
        markYusuNode(this);

        // H3：工作流加载后清理旧 model 幽灵口
        if (nodeData.name === "LazyH3Director") {
          try {
            fixH3DirectorModelInputs(this);
          } catch (e) {
            console.warn("[LazyH3] configure fix model inputs:", e);
          }
          requestAnimationFrame(() => {
            try {
              fixH3DirectorModelInputs(this);
            } catch (_) {}
          });
        }

        // Helper to set widget value, sync DOM element, and trigger callbacks safely
        const setWidgetValue = (w, val) => {
          if (!w) return;
          w.value = val;
          if (w.element) {
            if (w.element.type === "checkbox") {
              w.element.checked = !!val;
            } else {
              w.element.value = val;
            }
          }
          if (w.callback) {
            try {
              w.callback(val);
            } catch (e) {
              // ignore
            }
          }
        };

        // 2. Check if we have serialized properties. If so, restore widgets from properties!
        if (info.properties && info.properties.has_serialized_properties) {
          if (this.widgets) {
            for (const w of this.widgets) {
              if (w.name && this.properties[w.name] !== undefined) {
                setWidgetValue(w, this.properties[w.name]);
              }
            }
          }
        } else if (info.widgets_values) {
          // 按「字段名」把 widgets_values 填回去。
          // 当前 schema 已去掉音频/参考视频 5 个布尔控件（约 20 项）。
          // 长度>=24 仍兼容旧 SCHEMA_WAN_25（含音频开关字段，映射时会自动跳过不存在的控件）。
          // 新顺序：起始 → 结束 → 总长（帧/秒成对），再宽高帧率
          // 末尾追加 overlap_frames，旧工作流长度不够时走默认值 1
          const SCHEMA_WAN_20 = [
            "start_frame", "end_frame", "duration_frames",
            "start_second", "end_second", "duration_seconds",
            "epsilon", "timeline_data", "local_prompts", "segment_lengths", "guide_strength",
            "custom_width", "custom_height", "frame_rate",
            "negative_prompt", "resize_method", "divisible_by", "img_compression",
            "display_mode", "transition_smoothness",
            "overlap_frames",
          ];
          // 兼容旧工作流：总帧数在前
          const SCHEMA_WAN_20_LEGACY = [
            "duration_frames", "start_frame", "end_frame",
            "start_second", "end_second", "duration_seconds",
            "epsilon", "timeline_data", "local_prompts", "segment_lengths", "guide_strength",
            "custom_width", "custom_height", "frame_rate",
            "negative_prompt", "resize_method", "divisible_by", "img_compression",
            "display_mode", "transition_smoothness",
            "overlap_frames",
          ];
          const SCHEMA_WAN_25 = [
            "start_frame", "end_frame", "duration_frames",
            "start_second", "end_second", "duration_seconds",
            "epsilon", "timeline_data", "local_prompts", "segment_lengths", "guide_strength",
            "custom_width", "custom_height", "frame_rate",
            "negative_prompt", "resize_method", "divisible_by", "img_compression",
            "display_mode", "transition_smoothness",
            "use_custom_audio", "use_custom_motion", "inpaint_audio", "override_audio", "use_ic_video_size",
            "overlap_frames",
          ];
          const SCHEMA_WAN_25_LEGACY = [
            "duration_frames", "start_frame", "end_frame",
            "start_second", "end_second", "duration_seconds",
            "epsilon", "timeline_data", "local_prompts", "segment_lengths", "guide_strength",
            "custom_width", "custom_height", "frame_rate",
            "negative_prompt", "resize_method", "divisible_by", "img_compression",
            "display_mode", "transition_smoothness",
            "use_custom_audio", "use_custom_motion", "inpaint_audio", "override_audio", "use_ic_video_size",
            "overlap_frames",
          ];
          const SCHEMA_19 = [
            "start_frame", "end_frame", "duration_frames",
            "timeline_data", "use_custom_audio", "use_custom_motion", "inpaint_audio", "local_prompts", "segment_lengths",
            "epsilon", "frame_rate", "display_mode", "guide_strength", "custom_width", "custom_height",
            "resize_method", "divisible_by", "img_compression", "timeline_ui"
          ];
          const SCHEMA_21_NO_INPAINT = [
            "start_second", "end_second", "duration_seconds", "start_frame", "end_frame", "duration_frames",
            "timeline_data", "local_prompts", "segment_lengths", "epsilon", "guide_strength",
            "use_custom_audio", "use_custom_motion", "frame_rate", "display_mode", "custom_width", "custom_height",
            "resize_method", "divisible_by", "img_compression", "timeline_ui"
          ];
          const SCHEMA_22_NO_INPAINT = [
            "start_second", "end_second", "duration_seconds", "start_frame", "end_frame", "duration_frames",
            "timeline_data", "local_prompts", "segment_lengths", "epsilon", "guide_strength",
            "use_custom_audio", "use_custom_motion", "frame_rate", "display_mode", "custom_width", "custom_height",
            "resize_method", "divisible_by", "img_compression", "override_audio", "timeline_ui"
          ];
          const SCHEMA_22_WITH_INPAINT = [
            "start_second", "end_second", "duration_seconds", "start_frame", "end_frame", "duration_frames",
            "timeline_data", "use_custom_audio", "use_custom_motion", "inpaint_audio", "local_prompts", "segment_lengths",
            "epsilon", "frame_rate", "display_mode", "guide_strength", "custom_width", "custom_height",
            "resize_method", "divisible_by", "img_compression", "timeline_ui"
          ];
          const SCHEMA_23 = [
            "start_second", "end_second", "duration_seconds", "start_frame", "end_frame", "duration_frames",
            "timeline_data", "use_custom_audio", "use_custom_motion", "inpaint_audio", "local_prompts", "segment_lengths",
            "epsilon", "frame_rate", "display_mode", "guide_strength", "custom_width", "custom_height",
            "resize_method", "divisible_by", "img_compression", "override_audio", "timeline_ui"
          ];

          const ALL_WIDGET_DEFAULTS = {
            inpaint_audio: true,
            override_audio: false,
            use_ic_video_size: false,
            use_custom_audio: false,
            use_custom_motion: true,
            frame_rate: 16,
            display_mode: "seconds",
            custom_width: 832,
            custom_height: 480,
            resize_method: "maintain aspect ratio",
            divisible_by: 16,
            img_compression: 0,
            guide_strength: "",
            transition_smoothness: "",
            local_prompts: "",
            segment_lengths: "",
            timeline_data: "{}",
            epsilon: 0.001,
            start_second: 0.0,
            end_second: 5.0625,
            duration_seconds: 5.0625,
            start_frame: 0,
            end_frame: 81,
            duration_frames: 81,
            negative_prompt: "",
            overlap_frames: 1,
          };

          // 识别「总帧数在前」的旧序列 vs「起始帧在前」的新序列
          const pickStartEndDurationOrder = (vals, modern, legacy) => {
            const a = Number(vals[0]);
            const b = Number(vals[1]);
            const c = Number(vals[2]);
            if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return modern;
            // 新：start + duration ≈ end
            if (Math.abs((a + c) - b) <= 1 && b >= Math.max(a, c)) return modern;
            // 旧：duration + start ≈ end
            if (Math.abs((a + b) - c) <= 1 && c >= Math.max(a, b)) return legacy;
            // start 常为 0 的旧格式：duration 在前
            if (b === 0 && a > 0) return legacy;
            // start 常为 0 的新格式：start 在前
            if (a === 0 && c > 0) return modern;
            return modern;
          };

          let names = SCHEMA_WAN_20;
          const len = info.widgets_values.length;
          if (len >= 24) {
            names = pickStartEndDurationOrder(info.widgets_values, SCHEMA_WAN_25, SCHEMA_WAN_25_LEGACY);
          } else if (len >= 20) {
            names = pickStartEndDurationOrder(info.widgets_values, SCHEMA_WAN_20, SCHEMA_WAN_20_LEGACY);
          } else if (len <= 19) {
            names = SCHEMA_19;
          } else if (len === 21) {
            names = SCHEMA_21_NO_INPAINT;
          } else if (len === 22) {
            if (typeof info.widgets_values[13] === "number") {
              names = SCHEMA_22_NO_INPAINT;
            } else {
              names = SCHEMA_22_WITH_INPAINT;
            }
          } else if (len === 23) {
            names = SCHEMA_23;
          }

          if (this.widgets) {
            for (const w of this.widgets) {
              const schemaIdx = names.indexOf(w.name);
              if (schemaIdx !== -1 && schemaIdx < len) {
                setWidgetValue(w, info.widgets_values[schemaIdx]);
              } else if (ALL_WIDGET_DEFAULTS.hasOwnProperty(w.name)) {
                // 仅当当前值明显非法时才回落到默认
                // （避免覆盖 Comfy 已经按顺序填好的合法值）
              }
            }
          }

          // 强制纠正 COMBO / 最小值
          sanitizeDirectorWidgets(this);

          // Populate properties with these restored values
          if (this.widgets) {
            for (const w of this.widgets) {
              if (w.name && w.value !== undefined) {
                this.properties[w.name] = w.value;
              }
            }
          }
          this.properties.has_serialized_properties = true;
        }

        // 无论从哪条路径加载，最后都纠一次
        sanitizeDirectorWidgets(this);

        for (const [name, def] of APPENDED_WIDGET_DEFAULTS) {
          const w = this.widgets.find(x => x.name === name);
          if (w && (w.value == null || w.value === "")) w.value = def;
        }

        setTimeout(() => {
          if (this._timelineEditor) {
            const tl = parseInitial(this._timelineEditor.timelineDataWidget?.value);
            this._timelineEditor.timeline = tl;

            // Sync editor states from the parsed timeline object (the absolute source of truth)
            this._timelineEditor.mainTrackEnabled = tl.mainTrackEnabled !== false;
            this._timelineEditor.audioTrackEnabled = tl.audioTrackEnabled !== false;
            this._timelineEditor.motionTrackEnabled = tl.motionTrackEnabled !== false;
            this._timelineEditor.manualOutputRange = tl.manualOutputRange === true;
            this._timelineEditor.updateManualOutputRangeToggle();
            this._timelineEditor.useICVideoSize = tl.useICVideoSize !== undefined
              ? tl.useICVideoSize === true
              : this.properties.use_ic_video_size === true;
            this._timelineEditor.updateICVideoSizeToggle();
            this._timelineEditor.retakeMode = tl.retakeMode === true;
            this._timelineEditor._audioTrackWasEnabledBeforeOverride = !!this.properties.audioTrackWasEnabledBeforeOverride;

            // Sync properties to match
            this.properties.mainTrackEnabled = this._timelineEditor.mainTrackEnabled;
            this.properties.audioTrackEnabled = this._timelineEditor.audioTrackEnabled;
            this.properties.motionTrackEnabled = this._timelineEditor.motionTrackEnabled;
            this.properties.use_ic_video_size = this._timelineEditor.useICVideoSize;
            this.properties.retakeMode = this._timelineEditor.retakeMode;
            if (tl.showFilenames !== undefined) {
              this.properties.showFilenames = tl.showFilenames;
            }
            const overrideWidget = this.widgets?.find(w => w.name === "override_audio");
            if (tl._hasOverrideAudio) {
              this.properties.overrideAudio = tl.overrideAudio;
            } else if (overrideWidget) {
              tl.overrideAudio = !!overrideWidget.value;
              this.properties.overrideAudio = !!overrideWidget.value;
            }
            if (tl.inpaint_audio !== undefined) {
              this.properties.inpaint_audio = tl.inpaint_audio;
            }

            // Sync widgets to match the timeline data
            const inpaintWidget = this.widgets?.find(w => w.name === "inpaint_audio");
            if (inpaintWidget && tl.inpaint_audio !== undefined) {
              inpaintWidget.value = tl.inpaint_audio;
            }
            if (overrideWidget && tl._hasOverrideAudio) {
              overrideWidget.value = tl.overrideAudio;
            }
            const icSizeWidget = this.widgets?.find(w => w.name === "use_ic_video_size");
            if (icSizeWidget) {
              icSizeWidget.value = this._timelineEditor.useICVideoSize;
            }

            this._timelineEditor.loadMedia();
            this._timelineEditor.selectionType = "image";
            this._timelineEditor.selectedIndex = clamp(
              this._timelineEditor.selectedIndex, -1,
              Math.max(-1, this._timelineEditor.timeline.segments.length - 1)
            );
            this._timelineEditor.updateRetakeUIState();
            this._timelineEditor.updateUIFromSelection();
            this._timelineEditor.restoreSettingsWidgetsVisibility();
            this._timelineEditor.restoreGlobalPromptVisibility();
            this._timelineEditor.syncWidgetsAndUI();
            this._timelineEditor.syncLayoutToNode();
            this._timelineEditor.render();
          }
        }, 0);

        return out;
      };

      const onSerialize = nodeType.prototype.onSerialize;
      nodeType.prototype.onSerialize = function (info) {
        if (onSerialize) {
          onSerialize.apply(this, arguments);
        }

        // Sync all current widgets to properties
        if (this.widgets) {
          for (const w of this.widgets) {
            if (w.name && w.value !== undefined) {
              this.properties[w.name] = w.value;
            }
          }
        }

        // Sync timeline editor state if it exists
        if (this._timelineEditor) {
          this.properties.mainTrackEnabled = this._timelineEditor.mainTrackEnabled !== false;
          this.properties.audioTrackEnabled = this._timelineEditor.audioTrackEnabled !== false;
          this.properties.motionTrackEnabled = this._timelineEditor.motionTrackEnabled !== false;
          this.properties.audioTrackWasEnabledBeforeOverride = !!this._timelineEditor._audioTrackWasEnabledBeforeOverride;
        }

        // Mark that properties have been serialized
        this.properties.has_serialized_properties = true;

        // Ensure info.properties is populated with all our properties
        info.properties = { ...this.properties };
      };
    }
  },
});
