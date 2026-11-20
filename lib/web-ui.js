#!/usr/bin/env node
/**
 * dsh-novel-writer — Standalone Web UI server & Antigravity sidecar adapter
 *
 * Serves the official client panel (lib/client.js) without cordis/DSH host runtime,
 * providing:
 *   - /assets/theme.css      Light & Dark (--dsw-*) design token theme + shell styles
 *   - /assets/react-shim.js  Zero-dep React 18 compatible reconciler + hooks shim
 *   - /assets/bootstrap.js   __ModuleLoader__ / standalone ctx / theme & locale controls
 *   - /assets/client.js      Live stream of lib/client.js
 *   - /api/dsh-novel-writer/* Dispatched to lib/tools/system.js buildUiRoutes(config)
 */

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildUiRoutes } from "./tools/system.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(HERE, "..");
const CLIENT_JS_PATH = join(PLUGIN_DIR, "lib", "client.js");
const PKG_JSON_PATH = join(PLUGIN_DIR, "package.json");

function readPluginVersion() {
  try {
    const pkg = JSON.parse(readFileSync(PKG_JSON_PATH, "utf8"));
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const PLUGIN_VERSION = readPluginVersion();

const THEME_CSS = `/* dsh-novel-writer standalone & sidecar theme tokens */
:root {
  color-scheme: light;

  /* Surfaces */
  --dsw-alias-bg-base: #f2f4f7;
  --dsw-alias-bg-layer-1: #fbfcfd;
  --dsw-alias-bg-layer-2: #ffffff;
  --dsw-alias-bg-layer-3: #edf0f5;
  --dsw-alias-bg-layer-4: #d6dce6;
  --dsw-alias-bg-mask-1: rgba(15, 23, 42, 0.36);

  /* Borders */
  --dsw-alias-border-l1: rgba(15, 23, 42, 0.06);
  --dsw-alias-border-l2: rgba(15, 23, 42, 0.11);
  --dsw-alias-border-l3: rgba(15, 23, 42, 0.18);
  --dsw-alias-border-l4: rgba(15, 23, 42, 0.24);
  --dsw-alias-separator-primary: rgba(15, 23, 42, 0.10);

  /* Labels */
  --dsw-alias-label-primary: #111827;
  --dsw-alias-label-secondary: #4b5563;
  --dsw-alias-label-tertiary: #6b7280;
  --dsw-alias-label-dimmed: #9ca3af;
  --dsw-alias-label-primary-foreground: #ffffff;
  --dsw-alias-label-error: #c82333;
  --dsw-alias-label-danger: #c82333;
  --dsw-alias-text-danger: #c82333;

  /* Brand & interactive */
  --dsw-alias-brand-primary: #3b66f5;
  --dsw-alias-button-primary-fill: #3b66f5;
  --dsw-alias-button-primary-hover: #2f57db;
  --dsw-alias-button-elevated-fill: #ffffff;
  --dsw-alias-button-ghost-active-border: rgba(59, 102, 245, 0.45);
  --dsw-alias-interactive-bg-hover: rgba(15, 23, 42, 0.045);
  --dsw-alias-interactive-bg-active: rgba(59, 102, 245, 0.10);
  --dsw-alias-interactive-bg-hover-danger: rgba(220, 38, 38, 0.14);
  --dsw-alias-switch-thumb: #ffffff;
  --dsw-specific-sidebar-nav-item-hover: rgba(15, 23, 42, 0.05);
  --dsw-specific-sidebar-nav-item-active: rgba(59, 102, 245, 0.10);

  /* States */
  --dsw-alias-state-business-primary: #3b66f5;
  --dsw-alias-state-business-tertiary: rgba(59, 102, 245, 0.10);
  --dsw-alias-state-success-primary: #15803d;
  --dsw-alias-state-success-tertiary: rgba(22, 163, 74, 0.11);
  --dsw-alias-state-warn-label: #b45309;
  --dsw-alias-state-warn-primary: #d97706;
  --dsw-alias-state-warn-tertiary: rgba(217, 119, 6, 0.12);
  --dsw-alias-state-error-primary: #dc2626;
  --dsw-alias-state-error-secondary: rgba(220, 38, 38, 0.14);
  --dsw-alias-state-error-tertiary: rgba(220, 38, 38, 0.10);
  --dsw-alias-state-danger-tertiary: rgba(220, 38, 38, 0.10);

  /* Radii, elevation & focus */
  --dsw-radius-xs: 4px;
  --dsw-radius-sm: 6px;
  --dsw-radius-md: 8px;
  --dsw-radius-lg: 10px;
  --dsw-radius-xl: 12px;
  --dsw-radius-panel: 14px;
  --dsw-radius-2xl: 16px;
  --dsw-elevation-soft: 0 1px 2px rgba(15, 23, 42, 0.05), 0 1px 3px rgba(15, 23, 42, 0.04);
  --dsw-elevation-panel: 0 4px 14px rgba(15, 23, 42, 0.08), 0 1px 3px rgba(15, 23, 42, 0.05);
  --dsw-elevation-prominent: 0 12px 32px rgba(15, 23, 42, 0.14), 0 2px 6px rgba(15, 23, 42, 0.08);
  --dsw-focus-ring-color: rgba(59, 102, 245, 0.28);
  --dsw-focus-ring-width: 2px;

  /* Typography scale */
  --dsw-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  --dsw-font-size-xs: 11px;
  --dsw-font-size-sm: 12px;
  --dsw-font-size-md: 13px;
  --dsw-font-size-lg: 15px;
}

:root[data-theme="dark"] {
  color-scheme: dark;

  /* Surfaces */
  --dsw-alias-bg-base: #111318;
  --dsw-alias-bg-layer-1: #181b22;
  --dsw-alias-bg-layer-2: #1f232c;
  --dsw-alias-bg-layer-3: #282d38;
  --dsw-alias-bg-layer-4: #363c4a;
  --dsw-alias-bg-mask-1: rgba(0, 0, 0, 0.56);

  /* Borders */
  --dsw-alias-border-l1: rgba(255, 255, 255, 0.06);
  --dsw-alias-border-l2: rgba(255, 255, 255, 0.11);
  --dsw-alias-border-l3: rgba(255, 255, 255, 0.18);
  --dsw-alias-border-l4: rgba(255, 255, 255, 0.24);
  --dsw-alias-separator-primary: rgba(255, 255, 255, 0.10);

  /* Labels */
  --dsw-alias-label-primary: #eef1f7;
  --dsw-alias-label-secondary: #b4bccb;
  --dsw-alias-label-tertiary: #848d9e;
  --dsw-alias-label-dimmed: #5f6777;
  --dsw-alias-label-primary-foreground: #ffffff;
  --dsw-alias-label-error: #f87171;
  --dsw-alias-label-danger: #f87171;
  --dsw-alias-text-danger: #f87171;

  /* Brand & interactive */
  --dsw-alias-brand-primary: #5882f7;
  --dsw-alias-button-primary-fill: #5882f7;
  --dsw-alias-button-primary-hover: #6c92fb;
  --dsw-alias-button-elevated-fill: #252a35;
  --dsw-alias-button-ghost-active-border: rgba(107, 147, 255, 0.50);
  --dsw-alias-interactive-bg-hover: rgba(255, 255, 255, 0.06);
  --dsw-alias-interactive-bg-active: rgba(107, 147, 255, 0.16);
  --dsw-alias-interactive-bg-hover-danger: rgba(248, 113, 113, 0.18);
  --dsw-alias-switch-thumb: #f8fafc;
  --dsw-specific-sidebar-nav-item-hover: rgba(255, 255, 255, 0.06);
  --dsw-specific-sidebar-nav-item-active: rgba(107, 147, 255, 0.16);

  /* States */
  --dsw-alias-state-business-primary: #5882f7;
  --dsw-alias-state-business-tertiary: rgba(88, 130, 247, 0.15);
  --dsw-alias-state-success-primary: #4ade80;
  --dsw-alias-state-success-tertiary: rgba(74, 222, 128, 0.14);
  --dsw-alias-state-warn-label: #fbbf24;
  --dsw-alias-state-warn-primary: #f59e0b;
  --dsw-alias-state-warn-tertiary: rgba(245, 158, 11, 0.14);
  --dsw-alias-state-error-primary: #f87171;
  --dsw-alias-state-error-secondary: rgba(248, 113, 113, 0.18);
  --dsw-alias-state-error-tertiary: rgba(248, 113, 113, 0.14);
  --dsw-alias-state-danger-tertiary: rgba(248, 113, 113, 0.14);

  /* Elevation & focus */
  --dsw-elevation-soft: 0 1px 2px rgba(0, 0, 0, 0.35), 0 1px 3px rgba(0, 0, 0, 0.25);
  --dsw-elevation-panel: 0 6px 18px rgba(0, 0, 0, 0.42), 0 2px 6px rgba(0, 0, 0, 0.28);
  --dsw-elevation-prominent: 0 14px 36px rgba(0, 0, 0, 0.55), 0 4px 12px rgba(0, 0, 0, 0.35);
  --dsw-focus-ring-color: rgba(107, 147, 255, 0.36);
}

*, *::before, *::after {
  box-sizing: border-box;
}

html, body {
  margin: 0;
  padding: 0;
  min-height: 100%;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family);
  font-size: var(--dsw-font-size-md);
  -webkit-font-smoothing: antialiased;
}

.nwStandaloneShell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-base);
}

.nwStandaloneBar {
  position: sticky;
  top: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 16px;
  background: var(--dsw-alias-bg-layer-1);
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  backdrop-filter: blur(8px);
}

.nwStandaloneBrand {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 13px;
  line-height: 20px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}

.nwStandaloneMeta {
  font-size: 12px;
  line-height: 18px;
  font-weight: 400;
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 240px;
}

.nwStandaloneControls {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}

.nwStandaloneBtn {
  appearance: none;
  height: 28px;
  padding: 0 10px;
  border-radius: var(--dsw-radius-sm);
  border: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}

.nwStandaloneBtn:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-border-l3);
}

.nwStandaloneBtn:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);
  outline-offset: 1px;
}

.nwStandaloneRoot {
  flex: 1;
  min-height: 0;
}

@media (max-width: 480px) {
  .nwStandaloneBar {
    padding: 8px 12px;
    gap: 8px;
  }
  .nwStandaloneMeta {
    max-width: 130px;
  }
}
`;

const REACT_SHIM_JS = `/* dsh-novel-writer lightweight React 18 compatible shim */
(function (global) {
  "use strict";

  var REACT_ELEMENT_TYPE = Symbol.for("react.element");
  var FRAGMENT_TYPE = Symbol.for("react.fragment");
  var SVG_NS = "http://www.w3.org/2000/svg";
  var SVG_ATTR_MAP = {
    strokeWidth: "stroke-width",
    strokeLinecap: "stroke-linecap",
    strokeLinejoin: "stroke-linejoin",
    fillRule: "fill-rule",
    clipRule: "clip-rule",
    stopColor: "stop-color",
    stopOpacity: "stop-opacity",
    textAnchor: "text-anchor",
    dominantBaseline: "dominant-baseline"
  };
  var UNITLESS_CSS = new Set([
    "animationIterationCount", "columnCount", "fillOpacity", "flex", "flexGrow",
    "flexShrink", "fontWeight", "lineClamp", "lineHeight", "opacity", "order",
    "orphans", "strokeOpacity", "tabSize", "widows", "zIndex", "zoom"
  ]);
  var BOOL_PROPS = new Set(["disabled", "readOnly", "required", "multiple", "hidden", "open", "checked", "selected"]);

  var globalIdSeq = 0;
  var currentInst = null;

  function flattenChildren(input, out) {
    if (input === null || input === undefined || typeof input === "boolean") return out;
    if (Array.isArray(input)) {
      for (var i = 0; i < input.length; i += 1) flattenChildren(input[i], out);
      return out;
    }
    out.push(input);
    return out;
  }

  function isValidElement(obj) {
    return Boolean(obj && typeof obj === "object" && obj.$$typeof === REACT_ELEMENT_TYPE);
  }

  function createElement(type, props) {
    var finalProps = {};
    var key = null;
    var ref = null;
    if (props && typeof props === "object") {
      for (var k in props) {
        if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
        if (k === "key") {
          if (props.key !== undefined && props.key !== null) key = String(props.key);
        } else if (k === "ref") {
          ref = props.ref;
        } else if (k !== "children") {
          finalProps[k] = props[k];
        }
      }
    }
    var flat = [];
    if (arguments.length > 2) {
      for (var i = 2; i < arguments.length; i += 1) flattenChildren(arguments[i], flat);
    } else if (props && Object.prototype.hasOwnProperty.call(props, "children")) {
      flattenChildren(props.children, flat);
    }
    if (flat.length === 1) finalProps.children = flat[0];
    else if (flat.length > 1) finalProps.children = flat;
    return {
      $$typeof: REACT_ELEMENT_TYPE,
      type: type,
      key: key,
      ref: ref,
      props: finalProps
    };
  }

  function cloneElement(el, extraProps) {
    if (!isValidElement(el)) return el;
    var merged = {};
    if (el.props) {
      for (var k in el.props) {
        if (Object.prototype.hasOwnProperty.call(el.props, k)) merged[k] = el.props[k];
      }
    }
    var key = el.key;
    var ref = el.ref;
    if (extraProps && typeof extraProps === "object") {
      if (extraProps.key !== undefined && extraProps.key !== null) key = String(extraProps.key);
      if (Object.prototype.hasOwnProperty.call(extraProps, "ref")) ref = extraProps.ref;
      for (var ek in extraProps) {
        if (!Object.prototype.hasOwnProperty.call(extraProps, ek)) continue;
        if (ek === "key" || ek === "ref" || ek === "children") continue;
        merged[ek] = extraProps[ek];
      }
    }
    var flat = [];
    var hasExplicitChildren = false;
    if (arguments.length > 2) {
      hasExplicitChildren = true;
      for (var i = 2; i < arguments.length; i += 1) flattenChildren(arguments[i], flat);
    } else if (extraProps && Object.prototype.hasOwnProperty.call(extraProps, "children")) {
      hasExplicitChildren = true;
      flattenChildren(extraProps.children, flat);
    }
    if (hasExplicitChildren) {
      if (flat.length === 0) delete merged.children;
      else if (flat.length === 1) merged.children = flat[0];
      else merged.children = flat;
    }
    return {
      $$typeof: REACT_ELEMENT_TYPE,
      type: el.type,
      key: key,
      ref: ref,
      props: merged
    };
  }

  function requireActiveInst(hookName) {
    if (!currentInst) throw new Error(hookName + " must be called inside a function component");
    return currentInst;
  }

  function useState(initial) {
    var inst = requireActiveInst("useState");
    var idx = inst.hookIndex++;
    if (idx >= inst.hooks.length) {
      var val = typeof initial === "function" ? initial() : initial;
      var hook = {
        value: val,
        setState: function (next) {
          if (inst.unmounted) return;
          var computed = typeof next === "function" ? next(hook.value) : next;
          if (!Object.is(computed, hook.value)) {
            hook.value = computed;
            inst.root.dirtyInsts.add(inst);
            scheduleRootFlush(inst.root);
          }
        }
      };
      inst.hooks[idx] = hook;
    }
    var slot = inst.hooks[idx];
    return [slot.value, slot.setState];
  }

  function useRef(initial) {
    var inst = requireActiveInst("useRef");
    var idx = inst.hookIndex++;
    if (idx >= inst.hooks.length) {
      inst.hooks[idx] = { current: initial };
    }
    return inst.hooks[idx];
  }

  function useId() {
    var inst = requireActiveInst("useId");
    var idx = inst.hookIndex++;
    if (idx >= inst.hooks.length) {
      globalIdSeq += 1;
      inst.hooks[idx] = ":nw" + globalIdSeq + ":";
    }
    return inst.hooks[idx];
  }

  function depsChanged(prevDeps, nextDeps) {
    if (nextDeps === undefined) return true;
    if (prevDeps === undefined || !Array.isArray(nextDeps) || prevDeps.length !== nextDeps.length) return true;
    for (var i = 0; i < nextDeps.length; i += 1) {
      if (!Object.is(prevDeps[i], nextDeps[i])) return true;
    }
    return false;
  }

  function useEffect(fn, deps) {
    var inst = requireActiveInst("useEffect");
    var idx = inst.hookIndex++;
    if (idx >= inst.hooks.length) {
      inst.hooks[idx] = { deps: undefined, cleanup: null };
      inst.root.pendingEffects.push({ inst: inst, hookIdx: idx, fn: fn, deps: deps });
    } else {
      var prev = inst.hooks[idx];
      if (depsChanged(prev.deps, deps)) {
        inst.root.pendingEffects.push({ inst: inst, hookIdx: idx, fn: fn, deps: deps });
      }
    }
  }

  function isTextLikeInput(tag, props) {
    if (tag === "textarea") return true;
    if (tag !== "input") return false;
    var t = String((props && props.type) || "text").toLowerCase();
    return t !== "checkbox" && t !== "radio" && t !== "file" && t !== "select";
  }

  function setDomHandler(dom, domEvent, fn) {
    if (!dom.__nwHandlers) dom.__nwHandlers = Object.create(null);
    var rec = dom.__nwHandlers[domEvent];
    if (typeof fn !== "function") {
      if (rec) {
        dom.removeEventListener(domEvent, rec.wrapper);
        delete dom.__nwHandlers[domEvent];
      }
      return;
    }
    if (rec) {
      rec.fn = fn;
      return;
    }
    var entry = {
      fn: fn,
      wrapper: function (ev) {
        if (typeof entry.fn === "function") return entry.fn(ev);
      }
    };
    dom.__nwHandlers[domEvent] = entry;
    dom.addEventListener(domEvent, entry.wrapper);
  }

  function applyStyle(dom, prevStyle, nextStyle) {
    var style = dom.style;
    if (!style) return;
    if (prevStyle && typeof prevStyle === "object") {
      for (var pk in prevStyle) {
        if (!Object.prototype.hasOwnProperty.call(prevStyle, pk)) continue;
        if (!nextStyle || !(pk in nextStyle)) {
          if (pk.indexOf("--") === 0) style.removeProperty(pk);
          else style[pk] = "";
        }
      }
    }
    if (nextStyle && typeof nextStyle === "object") {
      for (var nk in nextStyle) {
        if (!Object.prototype.hasOwnProperty.call(nextStyle, nk)) continue;
        var val = nextStyle[nk];
        if (val === null || val === undefined || val === false) {
          if (nk.indexOf("--") === 0) style.removeProperty(nk);
          else style[nk] = "";
          continue;
        }
        var cssVal = (typeof val === "number" && val !== 0 && !UNITLESS_CSS.has(nk)) ? (val + "px") : String(val);
        if (nk.indexOf("--") === 0) style.setProperty(nk, cssVal);
        else style[nk] = cssVal;
      }
    }
  }

  function attrNameOf(propName, isSvg) {
    if (propName === "htmlFor") return "for";
    if (isSvg && SVG_ATTR_MAP[propName]) return SVG_ATTR_MAP[propName];
    return propName;
  }

  function applyDomProps(dom, tag, prevProps, nextProps, isSvg, isInitial) {
    var prev = prevProps || {};
    var next = nextProps || {};

    // Ensure input type is assigned before checked/value on initial mount.
    if (tag === "input" && Object.prototype.hasOwnProperty.call(next, "type") && next.type !== prev.type) {
      if (next.type == null) dom.removeAttribute("type");
      else dom.setAttribute("type", String(next.type));
    }

    var nextEvents = Object.create(null);
    for (var k in next) {
      if (!Object.prototype.hasOwnProperty.call(next, k)) continue;
      if (k === "children" || k === "key" || k === "ref" || k === "style" || k === "dangerouslySetInnerHTML") continue;
      if (k === "value" || k === "defaultValue" || k === "checked" || k === "defaultChecked") continue;
      if (tag === "input" && k === "type") continue;
      var val = next[k];
      if (k.length > 2 && k.charCodeAt(0) === 111 && k.charCodeAt(1) === 110 && k[2] >= "A" && k[2] <= "Z") {
        if (typeof val === "function") {
          if (k === "onInput" || k === "onChange") nextEvents[k] = val;
          else nextEvents[k.slice(2).toLowerCase()] = val;
        }
        continue;
      }
      if (k === "className") {
        var cls = val == null ? "" : String(val);
        if (isSvg) {
          if (dom.getAttribute("class") !== cls) dom.setAttribute("class", cls);
        } else if (dom.className !== cls) {
          dom.className = cls;
        }
        continue;
      }
      if (k === "tabIndex") {
        if (val === null || val === undefined || val === false) dom.removeAttribute("tabindex");
        else dom.tabIndex = Number(val);
        continue;
      }
      if (BOOL_PROPS.has(k)) {
        var b = Boolean(val);
        if (dom[k] !== b) dom[k] = b;
        if (k === "open") {
          if (b) dom.setAttribute("open", "");
          else dom.removeAttribute("open");
        }
        continue;
      }
      var attr = attrNameOf(k, isSvg);
      if (k.indexOf("aria-") === 0) {
        if (val === undefined || val === null) dom.removeAttribute(attr);
        else {
          var sAria = String(val);
          if (dom.getAttribute(attr) !== sAria) dom.setAttribute(attr, sAria);
        }
        continue;
      }
      if (val === undefined || val === null || val === false) {
        dom.removeAttribute(attr);
      } else {
        var sVal = val === true ? "" : String(val);
        if (dom.getAttribute(attr) !== sVal) dom.setAttribute(attr, sVal);
      }
    }

    // Remove stale non-event attributes
    for (var pk in prev) {
      if (!Object.prototype.hasOwnProperty.call(prev, pk)) continue;
      if (pk in next) continue;
      if (pk === "children" || pk === "key" || pk === "ref" || pk === "style" || pk === "dangerouslySetInnerHTML") continue;
      if (pk === "value" || pk === "defaultValue" || pk === "checked" || pk === "defaultChecked") continue;
      if (pk.length > 2 && pk.charCodeAt(0) === 111 && pk.charCodeAt(1) === 110 && pk[2] >= "A" && pk[2] <= "Z") continue;
      if (pk === "className") {
        if (isSvg) dom.removeAttribute("class");
        else dom.className = "";
      } else if (pk === "tabIndex") {
        dom.removeAttribute("tabindex");
      } else if (BOOL_PROPS.has(pk)) {
        dom[pk] = false;
        if (pk === "open") dom.removeAttribute("open");
      } else {
        dom.removeAttribute(attrNameOf(pk, isSvg));
      }
    }

    // Style updates
    if (prev.style || next.style) {
      applyStyle(dom, prev.style, next.style);
    }

    // Input / textarea / select change vs input bridging
    var resolvedDomEvents = Object.create(null);
    for (var evKey in nextEvents) {
      if (evKey !== "onInput" && evKey !== "onChange") resolvedDomEvents[evKey] = nextEvents[evKey];
    }
    if (isTextLikeInput(tag, next)) {
      if (nextEvents.onInput && nextEvents.onChange) {
        resolvedDomEvents.input = nextEvents.onInput;
        resolvedDomEvents.change = nextEvents.onChange;
      } else if (nextEvents.onChange) {
        resolvedDomEvents.input = nextEvents.onChange;
      } else if (nextEvents.onInput) {
        resolvedDomEvents.input = nextEvents.onInput;
      }
    } else {
      if (nextEvents.onInput) resolvedDomEvents.input = nextEvents.onInput;
      if (nextEvents.onChange) resolvedDomEvents.change = nextEvents.onChange;
    }

    // Sync event listeners (attach/update active, detach removed)
    if (dom.__nwHandlers) {
      for (var existingEv in dom.__nwHandlers) {
        if (!(existingEv in resolvedDomEvents)) setDomHandler(dom, existingEv, null);
      }
    }
    for (var activeEv in resolvedDomEvents) {
      setDomHandler(dom, activeEv, resolvedDomEvents[activeEv]);
    }

    // dangerouslySetInnerHTML
    var nextHtml = next.dangerouslySetInnerHTML && typeof next.dangerouslySetInnerHTML === "object"
      ? String(next.dangerouslySetInnerHTML.__html || "") : null;
    var prevHtml = prev.dangerouslySetInnerHTML && typeof prev.dangerouslySetInnerHTML === "object"
      ? String(prev.dangerouslySetInnerHTML.__html || "") : null;
    if (nextHtml !== null) {
      if (nextHtml !== prevHtml) dom.innerHTML = nextHtml;
    } else if (prevHtml !== null) {
      dom.innerHTML = "";
    }

    // Controlled / default checked & value (value synced without clobbering cursor)
    if (Object.prototype.hasOwnProperty.call(next, "checked")) {
      var nextChecked = Boolean(next.checked);
      if (dom.checked !== nextChecked) dom.checked = nextChecked;
    } else if (isInitial && Object.prototype.hasOwnProperty.call(next, "defaultChecked")) {
      dom.checked = Boolean(next.defaultChecked);
    }
    if (Object.prototype.hasOwnProperty.call(next, "value") && next.value !== undefined) {
      var nextVal = next.value === null ? "" : String(next.value);
      if (dom.value !== nextVal) dom.value = nextVal;
    } else if (isInitial && Object.prototype.hasOwnProperty.call(next, "defaultValue") && next.defaultValue !== undefined) {
      dom.value = next.defaultValue === null ? "" : String(next.defaultValue);
    }
  }

  function assignRef(ref, value) {
    if (!ref) return;
    if (typeof ref === "function") {
      try { ref(value); } catch { /* ignore */ }
    } else if (typeof ref === "object") {
      ref.current = value;
    }
  }

  function getHostNodes(inst, out) {
    if (!out) out = [];
    if (!inst) return out;
    if (inst.kind === "text" || inst.kind === "host") {
      if (inst.dom) out.push(inst.dom);
    } else if (inst.kind === "component") {
      if (inst.child) getHostNodes(inst.child, out);
    } else if (inst.kind === "fragment") {
      for (var i = 0; i < inst.children.length; i += 1) {
        getHostNodes(inst.children[i], out);
      }
    }
    return out;
  }

  function firstHostDom(inst) {
    if (!inst) return null;
    if (inst.kind === "text" || inst.kind === "host") return inst.dom || null;
    if (inst.kind === "component") return firstHostDom(inst.child);
    if (inst.kind === "fragment") {
      for (var i = 0; i < inst.children.length; i += 1) {
        var d = firstHostDom(inst.children[i]);
        if (d) return d;
      }
    }
    return null;
  }

  function findNextSiblingDom(inst) {
    var cur = inst;
    while (cur && cur.parent) {
      var parent = cur.parent;
      if (parent.kind === "host" || parent.kind === "fragment") {
        var list = parent.children;
        var idx = list.indexOf(cur);
        for (var i = idx + 1; i < list.length; i += 1) {
          var dom = firstHostDom(list[i]);
          if (dom) return dom;
        }
        if (parent.kind === "host") return null;
      }
      cur = parent;
    }
    return null;
  }

  function placeInstances(parentDom, instances, afterAnchor) {
    var anchor = afterAnchor || null;
    for (var i = instances.length - 1; i >= 0; i -= 1) {
      var doms = getHostNodes(instances[i]);
      for (var j = doms.length - 1; j >= 0; j -= 1) {
        var dom = doms[j];
        var expectedPrev = anchor ? anchor.previousSibling : parentDom.lastChild;
        if (dom.parentNode !== parentDom || dom !== expectedPrev) {
          parentDom.insertBefore(dom, anchor);
        }
        anchor = dom;
      }
    }
  }

  function unmountInst(inst) {
    if (!inst) return;
    inst.unmounted = true;
    if (inst.kind === "component") {
      if (inst.child) unmountInst(inst.child);
      for (var i = 0; i < inst.hooks.length; i += 1) {
        var h = inst.hooks[i];
        if (h && typeof h.cleanup === "function") {
          try { h.cleanup(); } catch { /* ignore */ }
          h.cleanup = null;
        }
      }
      inst.child = null;
    } else if (inst.kind === "fragment") {
      for (var fi = 0; fi < inst.children.length; fi += 1) {
        unmountInst(inst.children[fi]);
      }
      inst.children = [];
    } else if (inst.kind === "host") {
      for (var hi = 0; hi < inst.children.length; hi += 1) {
        unmountInst(inst.children[hi]);
      }
      inst.children = [];
      assignRef(inst.ref, null);
      if (inst.dom && inst.dom.parentNode) inst.dom.parentNode.removeChild(inst.dom);
    } else if (inst.kind === "text") {
      if (inst.dom && inst.dom.parentNode) inst.dom.parentNode.removeChild(inst.dom);
    }
  }

  function canReuse(prevInst, nextVNode) {
    if (!prevInst || nextVNode === null || nextVNode === undefined || typeof nextVNode === "boolean") return false;
    if (typeof nextVNode === "string" || typeof nextVNode === "number") {
      return prevInst.kind === "text";
    }
    if (!isValidElement(nextVNode)) return false;
    if (nextVNode.type === FRAGMENT_TYPE) return prevInst.kind === "fragment";
    if (typeof nextVNode.type === "function") return prevInst.kind === "component" && prevInst.type === nextVNode.type;
    if (typeof nextVNode.type === "string") return prevInst.kind === "host" && prevInst.type === nextVNode.type;
    return false;
  }

  function normalizeChildList(rawChildren) {
    var list = [];
    flattenChildren(rawChildren, list);
    return list;
  }

  function matchKeyOfVNode(vnode, unkeyedCounter) {
    if (isValidElement(vnode) && vnode.key !== null && vnode.key !== undefined) {
      return { token: "k:" + vnode.key, nextUnkeyed: unkeyedCounter };
    }
    return { token: "u:" + unkeyedCounter, nextUnkeyed: unkeyedCounter + 1 };
  }

  function reconcileChildren(parentDom, parentInst, prevChildren, nextRawChildren, root, isSvg, afterAnchor) {
    var nextList = normalizeChildList(nextRawChildren);
    var oldMap = new Map();
    var oldUnkeyed = 0;
    for (var i = 0; i < prevChildren.length; i += 1) {
      var prev = prevChildren[i];
      var tok;
      if (prev.key !== null && prev.key !== undefined) {
        tok = "k:" + prev.key;
      } else {
        tok = "u:" + oldUnkeyed;
        oldUnkeyed += 1;
      }
      if (!oldMap.has(tok)) oldMap.set(tok, prev);
    }

    var used = new Set();
    var nextChildren = [];
    var newUnkeyed = 0;
    for (var j = 0; j < nextList.length; j += 1) {
      var vnode = nextList[j];
      var info = matchKeyOfVNode(vnode, newUnkeyed);
      newUnkeyed = info.nextUnkeyed;
      var matched = oldMap.get(info.token);
      var childInst;
      if (matched && canReuse(matched, vnode)) {
        used.add(matched);
        childInst = updateInst(parentDom, parentInst, matched, vnode, root, isSvg);
      } else {
        childInst = mountVNode(parentDom, parentInst, vnode, root, isSvg);
      }
      if (childInst) nextChildren.push(childInst);
    }

    for (var k = 0; k < prevChildren.length; k += 1) {
      if (!used.has(prevChildren[k])) unmountInst(prevChildren[k]);
    }

    placeInstances(parentDom, nextChildren, afterAnchor);
    return nextChildren;
  }

  function renderComponentOutput(inst) {
    var prevActive = currentInst;
    currentInst = inst;
    inst.hookIndex = 0;
    try {
      return inst.type(inst.props);
    } catch (err) {
      var message = err && err.message ? err.message : String(err);
      return createElement("div", { className: "nwNote nwNoteWarn", role: "alert" }, "UI render error: " + message);
    } finally {
      currentInst = prevActive;
    }
  }

  function mountVNode(parentDom, parentInst, vnode, root, isSvg) {
    if (vnode === null || vnode === undefined || typeof vnode === "boolean") return null;
    if (typeof vnode === "string" || typeof vnode === "number") {
      var text = String(vnode);
      return {
        kind: "text",
        key: null,
        parent: parentInst,
        parentDom: parentDom,
        text: text,
        dom: document.createTextNode(text)
      };
    }
    if (!isValidElement(vnode)) {
      var fallback = String(vnode);
      return {
        kind: "text",
        key: null,
        parent: parentInst,
        parentDom: parentDom,
        text: fallback,
        dom: document.createTextNode(fallback)
      };
    }
    if (vnode.type === FRAGMENT_TYPE) {
      var frag = {
        kind: "fragment",
        key: vnode.key,
        parent: parentInst,
        parentDom: parentDom,
        children: []
      };
      var fragList = normalizeChildList(vnode.props ? vnode.props.children : null);
      for (var fi = 0; fi < fragList.length; fi += 1) {
        var fc = mountVNode(parentDom, frag, fragList[fi], root, isSvg);
        if (fc) frag.children.push(fc);
      }
      return frag;
    }
    if (typeof vnode.type === "function") {
      var comp = {
        kind: "component",
        type: vnode.type,
        key: vnode.key,
        props: vnode.props || {},
        parent: parentInst,
        parentDom: parentDom,
        root: root,
        hooks: [],
        hookIndex: 0,
        child: null,
        unmounted: false,
        lastEpoch: root.epoch
      };
      var rendered = renderComponentOutput(comp);
      comp.child = mountVNode(parentDom, comp, rendered, root, isSvg);
      return comp;
    }
    if (typeof vnode.type === "string") {
      var childSvg = isSvg || vnode.type === "svg";
      var dom = childSvg ? document.createElementNS(SVG_NS, vnode.type) : document.createElement(vnode.type);
      var hostInst = {
        kind: "host",
        type: vnode.type,
        key: vnode.key,
        props: vnode.props || {},
        ref: vnode.ref || null,
        parent: parentInst,
        parentDom: parentDom,
        isSvg: childSvg,
        dom: dom,
        children: []
      };
      var hasRawHtml = hostInst.props.dangerouslySetInnerHTML && typeof hostInst.props.dangerouslySetInnerHTML === "object";
      if (!hasRawHtml && hostInst.props.children !== undefined) {
        var childList = normalizeChildList(hostInst.props.children);
        for (var ci = 0; ci < childList.length; ci += 1) {
          var childInst = mountVNode(dom, hostInst, childList[ci], root, childSvg);
          if (childInst) {
            hostInst.children.push(childInst);
            var nodes = getHostNodes(childInst);
            for (var ni = 0; ni < nodes.length; ni += 1) dom.appendChild(nodes[ni]);
          }
        }
      }
      // Apply props after children so <select value=...> selects the matching <option>.
      applyDomProps(dom, vnode.type, null, hostInst.props, childSvg, true);
      assignRef(hostInst.ref, dom);
      return hostInst;
    }
    return null;
  }

  function updateInst(parentDom, parentInst, inst, vnode, root, isSvg) {
    inst.parent = parentInst;
    inst.parentDom = parentDom;
    if (inst.kind === "text") {
      var nextText = String(vnode);
      if (inst.text !== nextText) {
        inst.text = nextText;
        inst.dom.nodeValue = nextText;
      }
      return inst;
    }
    if (inst.kind === "fragment") {
      inst.key = vnode.key;
      inst.children = reconcileChildren(parentDom, inst, inst.children, vnode.props ? vnode.props.children : null, root, isSvg, findNextSiblingDom(inst));
      return inst;
    }
    if (inst.kind === "component") {
      inst.key = vnode.key;
      inst.props = vnode.props || {};
      inst.lastEpoch = root.epoch;
      var nextOut = renderComponentOutput(inst);
      var anchor = findNextSiblingDom(inst);
      if (inst.child && canReuse(inst.child, nextOut)) {
        inst.child = updateInst(parentDom, inst, inst.child, nextOut, root, isSvg);
        placeInstances(parentDom, [inst.child], anchor);
      } else {
        if (inst.child) unmountInst(inst.child);
        inst.child = mountVNode(parentDom, inst, nextOut, root, isSvg);
        if (inst.child) placeInstances(parentDom, [inst.child], anchor);
      }
      return inst;
    }
    if (inst.kind === "host") {
      var prevProps = inst.props;
      var nextProps = vnode.props || {};
      inst.key = vnode.key;
      inst.props = nextProps;
      if (inst.ref !== vnode.ref) {
        assignRef(inst.ref, null);
        inst.ref = vnode.ref || null;
        assignRef(inst.ref, inst.dom);
      }
      var hasRawHtml = nextProps.dangerouslySetInnerHTML && typeof nextProps.dangerouslySetInnerHTML === "object";
      if (hasRawHtml) {
        for (var i = 0; i < inst.children.length; i += 1) unmountInst(inst.children[i]);
        inst.children = [];
      } else {
        inst.children = reconcileChildren(inst.dom, inst, inst.children, nextProps.children, root, inst.isSvg, null);
      }
      applyDomProps(inst.dom, inst.type, prevProps, nextProps, inst.isSvg, false);
      return inst;
    }
    return inst;
  }

  function flushEffects(root) {
    var queue = root.pendingEffects.splice(0, root.pendingEffects.length);
    for (var i = 0; i < queue.length; i += 1) {
      var item = queue[i];
      if (!item || !item.inst || item.inst.unmounted) continue;
      var slot = item.inst.hooks[item.hookIdx];
      if (!slot) continue;
      if (typeof slot.cleanup === "function") {
        try { slot.cleanup(); } catch { /* ignore */ }
        slot.cleanup = null;
      }
      slot.deps = item.deps;
      try {
        var ret = item.fn();
        slot.cleanup = typeof ret === "function" ? ret : null;
      } catch {
        slot.cleanup = null;
      }
    }
  }

  function hasDirtyAncestor(inst, dirtySet) {
    var cur = inst.parent;
    while (cur) {
      if (cur.kind === "component" && dirtySet.has(cur)) return true;
      cur = cur.parent;
    }
    return false;
  }

  function flushDirtyRoot(root) {
    if (root.unmounted) return;
    root.rendering = true;
    root.epoch += 1;
    try {
      var dirty = Array.from(root.dirtyInsts);
      var dirtySet = new Set(dirty);
      root.dirtyInsts.clear();
      for (var i = 0; i < dirty.length; i += 1) {
        var inst = dirty[i];
        if (!inst || inst.unmounted || inst.lastEpoch === root.epoch) continue;
        if (hasDirtyAncestor(inst, dirtySet)) continue;
        inst.lastEpoch = root.epoch;
        var nextOut = renderComponentOutput(inst);
        var anchor = findNextSiblingDom(inst);
        if (inst.child && canReuse(inst.child, nextOut)) {
          inst.child = updateInst(inst.parentDom, inst, inst.child, nextOut, root, false);
          placeInstances(inst.parentDom, [inst.child], anchor);
        } else {
          if (inst.child) unmountInst(inst.child);
          inst.child = mountVNode(inst.parentDom, inst, nextOut, root, false);
          if (inst.child) placeInstances(inst.parentDom, [inst.child], anchor);
        }
      }
    } finally {
      root.rendering = false;
    }
    flushEffects(root);
  }

  function scheduleRootFlush(root) {
    if (root.unmounted || root.scheduled) return;
    root.scheduled = true;
    var enqueue = typeof queueMicrotask === "function"
      ? queueMicrotask
      : function (fn) { Promise.resolve().then(fn); };
    enqueue(function () {
      root.scheduled = false;
      var guard = 0;
      while (!root.unmounted && root.dirtyInsts.size > 0 && guard < 50) {
        guard += 1;
        flushDirtyRoot(root);
      }
    });
  }

  function createRoot(container) {
    if (!container) throw new Error("createRoot requires a valid DOM container");
    var root = {
      container: container,
      rootInst: null,
      currentVNode: null,
      dirtyInsts: new Set(),
      pendingEffects: [],
      scheduled: false,
      rendering: false,
      unmounted: false,
      epoch: 0
    };
    return {
      render: function (vnode) {
        if (root.unmounted) return;
        root.currentVNode = vnode;
        root.dirtyInsts.clear();
        root.rendering = true;
        root.epoch += 1;
        try {
          if (root.rootInst && canReuse(root.rootInst, vnode)) {
            root.rootInst = updateInst(container, null, root.rootInst, vnode, root, false);
            placeInstances(container, [root.rootInst], null);
          } else {
            if (root.rootInst) unmountInst(root.rootInst);
            container.textContent = "";
            root.rootInst = mountVNode(container, null, vnode, root, false);
            if (root.rootInst) placeInstances(container, [root.rootInst], null);
          }
        } catch (err) {
          var fallback = document.createElement("div");
          fallback.className = "nwNote nwNoteWarn";
          fallback.textContent = "UI mount error: " + (err && err.message ? err.message : String(err));
          container.textContent = "";
          container.appendChild(fallback);
        } finally {
          root.rendering = false;
        }
        flushEffects(root);
      },
      unmount: function () {
        if (root.unmounted) return;
        root.unmounted = true;
        root.dirtyInsts.clear();
        root.pendingEffects = [];
        if (root.rootInst) {
          unmountInst(root.rootInst);
          root.rootInst = null;
        }
        container.textContent = "";
      }
    };
  }

  global.__NW_REACT__ = {
    Fragment: FRAGMENT_TYPE,
    createElement: createElement,
    cloneElement: cloneElement,
    isValidElement: isValidElement,
    useState: useState,
    useEffect: useEffect,
    useRef: useRef,
    useId: useId
  };

  global.__NW_REACT_DOM_CLIENT__ = {
    createRoot: createRoot
  };
})(typeof window !== "undefined" ? window : globalThis);
`;

const BOOTSTRAP_JS = `/* dsh-novel-writer standalone & sidecar bootstrap */
(function (global) {
  "use strict";

  var THEME_KEY = "dsh.novelWriter.standaloneTheme";
  var LANG_KEY = "dsh.novelWriter.standaloneLang";

  function readStorage(key) {
    try { return global.localStorage ? global.localStorage.getItem(key) : null; } catch { return null; }
  }
  function writeStorage(key, val) {
    try { if (global.localStorage) global.localStorage.setItem(key, val); } catch { /* ignore */ }
  }

  var savedTheme = readStorage(THEME_KEY);
  var currentTheme = (savedTheme === "dark" || savedTheme === "light")
    ? savedTheme
    : (global.matchMedia && global.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

  var savedLang = readStorage(LANG_KEY);
  var currentLang = (savedLang === "en-US" || savedLang === "zh-CN")
    ? savedLang
    : (String(global.navigator && global.navigator.language || "").toLowerCase().indexOf("en") === 0 ? "en-US" : "zh-CN");

  function syncDocumentAttributes() {
    if (typeof document === "undefined" || !document.documentElement) return;
    document.documentElement.dataset.theme = currentTheme;
    document.documentElement.lang = currentLang === "en-US" ? "en" : "zh";
  }
  syncDocumentAttributes();

  // Route relative API calls through window.sidecar.fetch when running inside Antigravity webview.
  if (global.sidecar && typeof global.sidecar.fetch === "function" && typeof global.fetch === "function") {
    var nativeFetch = global.fetch.bind(global);
    var sidecarFetch = global.sidecar.fetch.bind(global.sidecar);
    global.fetch = function (input, init) {
      if (typeof input === "string" && input.indexOf("/api/dsh-novel-writer/") === 0) {
        return sidecarFetch(input, init);
      }
      return nativeFetch(input, init);
    };
  }

  var capturedModule = null;
  var mainSlot = null;
  var localeListeners = new Set();
  var effectDisposers = [];
  var reactRoot = null;
  var mounted = false;

  function requireShim(name) {
    if (name === "react") return global.__NW_REACT__;
    if (name === "react-dom/client") return global.__NW_REACT_DOM_CLIENT__;
    throw new Error("module not found: " + name);
  }

  var standaloneCtx = {
    slots: {
      specDynamic: function (name) {
        if (name === "sidebar.panellist" || name === "main") return {};
        return undefined;
      },
      inject: function (_name, fn) {
        return typeof fn === "function" ? fn() : undefined;
      },
      register: function (opts, comp) {
        if (opts && opts.name === "main" && typeof comp === "function") {
          mainSlot = { opts: opts, comp: comp };
        }
        return function () {};
      },
      subscribe: function () {
        return function () {};
      }
    },
    locale: {
      getSnapshot: function () {
        return { active: currentLang };
      },
      subscribe: function (cb) {
        if (typeof cb === "function") localeListeners.add(cb);
        return function () {
          localeListeners.delete(cb);
        };
      }
    },
    layout: {
      selectPanel: function () {}
    },
    effect: function (fn) {
      var disposer = typeof fn === "function" ? fn() : null;
      if (typeof disposer === "function") effectDisposers.push(disposer);
      return disposer;
    }
  };

  function updateToolbarLabels() {
    if (typeof document === "undefined") return;
    var isEn = currentLang === "en-US";
    var brand = document.getElementById("nw-brand-title");
    if (brand) brand.textContent = isEn ? "Novel Writer" : "写作助手";
    var langBtn = document.getElementById("nw-lang-btn");
    if (langBtn) {
      langBtn.textContent = isEn ? "中文" : "EN";
      langBtn.title = isEn ? "切换到中文" : "Switch to English";
    }
    var themeBtn = document.getElementById("nw-theme-btn");
    if (themeBtn) {
      if (currentTheme === "dark") {
        themeBtn.textContent = isEn ? "Light" : "浅色";
        themeBtn.title = isEn ? "Switch to light theme" : "切换到浅色主题";
      } else {
        themeBtn.textContent = isEn ? "Dark" : "深色";
        themeBtn.title = isEn ? "Switch to dark theme" : "切换到深色主题";
      }
    }
  }

  function wireControls() {
    if (typeof document === "undefined") return;
    updateToolbarLabels();
    var themeBtn = document.getElementById("nw-theme-btn");
    if (themeBtn && !themeBtn.__nwWired) {
      themeBtn.__nwWired = true;
      themeBtn.addEventListener("click", function () {
        currentTheme = currentTheme === "dark" ? "light" : "dark";
        writeStorage(THEME_KEY, currentTheme);
        syncDocumentAttributes();
        updateToolbarLabels();
      });
    }
    var langBtn = document.getElementById("nw-lang-btn");
    if (langBtn && !langBtn.__nwWired) {
      langBtn.__nwWired = true;
      langBtn.addEventListener("click", function () {
        currentLang = currentLang === "en-US" ? "zh-CN" : "en-US";
        writeStorage(LANG_KEY, currentLang);
        syncDocumentAttributes();
        updateToolbarLabels();
        localeListeners.forEach(function (cb) {
          try { cb(); } catch { /* ignore */ }
        });
      });
    }
  }

  function mountStandalone() {
    if (mounted || !capturedModule || typeof capturedModule.apply !== "function") return;
    if (typeof document === "undefined") return;
    var rootEl = document.getElementById("nw-standalone-root");
    if (!rootEl) return;
    mounted = true;
    syncDocumentAttributes();
    wireControls();
    try {
      capturedModule.apply(standaloneCtx);
      if (mainSlot && typeof mainSlot.comp === "function") {
        var injectedProps = (mainSlot.opts && typeof mainSlot.opts.inject === "function")
          ? mainSlot.opts.inject()
          : {};
        reactRoot = global.__NW_REACT_DOM_CLIENT__.createRoot(rootEl);
        reactRoot.render(global.__NW_REACT__.createElement(mainSlot.comp, injectedProps || {}));
      } else {
        rootEl.textContent = "Novel Writer panel failed to register main view.";
      }
    } catch (err) {
      var note = document.createElement("div");
      note.className = "nwNote nwNoteWarn";
      note.textContent = "Failed to initialize Novel Writer UI: " + (err && err.message ? err.message : String(err));
      rootEl.textContent = "";
      rootEl.appendChild(note);
    }
  }

  global.__ModuleLoader__ = {
    load: function (spec) {
      if (!spec || typeof spec.factory !== "function") return null;
      var mod = spec.factory(requireShim);
      if (spec.id === "dsh-novel-writer" || !capturedModule) {
        capturedModule = mod;
      }
      if (typeof document !== "undefined" && document.readyState !== "loading") {
        mountStandalone();
      }
      return mod;
    }
  };

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", mountStandalone);
    } else {
      mountStandalone();
    }
  }

  if (typeof global.addEventListener === "function") {
    global.addEventListener("beforeunload", function () {
      for (var i = 0; i < effectDisposers.length; i += 1) {
        try { effectDisposers[i](); } catch { /* ignore */ }
      }
      effectDisposers = [];
      if (reactRoot && typeof reactRoot.unmount === "function") {
        try { reactRoot.unmount(); } catch { /* ignore */ }
        reactRoot = null;
      }
    });
  }
})(typeof window !== "undefined" ? window : globalThis);
`;

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatRootBadge(root) {
  const raw = typeof root === "string" ? root.trim() : "";
  if (!raw) return `v${PLUGIN_VERSION}`;
  const label = basename(resolve(raw)) || raw.replace(/[\\/]+$/, "") || "workspace";
  return `${label} · v${PLUGIN_VERSION}`;
}

function renderIndexHtml(config) {
  const rootLabel = escapeHtml(formatRootBadge(config?.root));
  return `<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Novel Writer Studio — dsh-novel-writer</title>
  <link rel="stylesheet" href="/assets/theme.css">
  <script src="/preload.js"></script>
</head>
<body>
  <div class="nwStandaloneShell">
    <header class="nwStandaloneBar">
      <div class="nwStandaloneBrand">
        <span id="nw-brand-title">写作助手</span>
        <span id="nw-root-label" class="nwStandaloneMeta" title="${rootLabel}">${rootLabel}</span>
      </div>
      <div class="nwStandaloneControls">
        <button id="nw-lang-btn" type="button" class="nwStandaloneBtn">EN</button>
        <button id="nw-theme-btn" type="button" class="nwStandaloneBtn">深色</button>
      </div>
    </header>
    <main id="nw-standalone-root" class="nwStandaloneRoot"></main>
  </div>
  <script src="/assets/react-shim.js"></script>
  <script src="/assets/bootstrap.js"></script>
  <script src="/assets/client.js"></script>
</body>
</html>
`;
}

function isAllowedHostRequest(req, allowLan) {
  const addr = req.socket?.remoteAddress;
  if (!allowLan && addr !== undefined && addr !== "127.0.0.1" && addr !== "::1" && addr !== "::ffff:127.0.0.1") {
    return false;
  }
  const hostHeader = req.headers?.host;
  if (typeof hostHeader !== "string" || hostHeader.trim() === "") return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${hostHeader}`);
  } catch {
    return false;
  }
  if (!allowLan) {
    const h = hostUrl.hostname;
    if (h !== "127.0.0.1" && h !== "localhost" && h !== "[::1]") return false;
  }
  if (req.headers?.["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers?.origin;
  if (origin !== undefined) {
    try {
      if (new URL(origin).host !== hostUrl.host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function sendResponse(res, status, contentType, body, method = "GET") {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(method === "HEAD" ? "" : body);
}

/**
 * Invoke a `{ kind, path, handler }` UI route in memory without opening a socket.
 * Used by Antigravity SidecarApp adapters where requests arrive as parsed objects.
 * @param {{ path?: string, handler: Function }} route
 * @param {{ method?: string, url?: string, body?: unknown, headers?: Record<string, string> }} [options]
 * @returns {Promise<{ status: number, headers: Record<string, string>, body: string, buffer: Buffer, json: unknown }>}
 */
export async function invokeRouteInMemory(route, { method = "GET", url, body, headers = {} } = {}) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  const normalizedUrl = String(url || route?.path || "/");
  const reqHeaders = { host: "127.0.0.1" };
  for (const [k, v] of Object.entries(headers || {})) {
    if (v !== undefined) reqHeaders[String(k).toLowerCase()] = String(v);
  }
  let bodyBuf = null;
  if (body !== undefined) {
    bodyBuf = Buffer.isBuffer(body)
      ? body
      : Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
    if (!reqHeaders["content-type"]) reqHeaders["content-type"] = "application/json; charset=utf-8";
  }

  const req = {
    method: normalizedMethod,
    url: normalizedUrl,
    headers: reqHeaders,
    socket: { remoteAddress: "127.0.0.1" },
    [Symbol.asyncIterator]() {
      let sent = false;
      return {
        async next() {
          if (!sent && bodyBuf !== null) {
            sent = true;
            return { value: bodyBuf, done: false };
          }
          return { value: undefined, done: true };
        }
      };
    }
  };

  const headerMap = new Map();
  const chunks = [];
  const res = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    setHeader(name, value) {
      headerMap.set(String(name).toLowerCase(), String(value));
    },
    getHeader(name) {
      return headerMap.get(String(name).toLowerCase());
    },
    removeHeader(name) {
      headerMap.delete(String(name).toLowerCase());
    },
    getHeaders() {
      return Object.fromEntries(headerMap.entries());
    },
    writeHead(status, reasonOrHeaders, maybeHeaders) {
      this.statusCode = Number(status) || 200;
      const hdrs = (reasonOrHeaders && typeof reasonOrHeaders === "object")
        ? reasonOrHeaders
        : (maybeHeaders && typeof maybeHeaders === "object" ? maybeHeaders : null);
      if (hdrs) {
        for (const [k, v] of Object.entries(hdrs)) {
          if (v !== undefined) headerMap.set(String(k).toLowerCase(), String(v));
        }
      }
      this.headersSent = true;
      return this;
    },
    write(chunk, encoding) {
      if (chunk !== undefined && chunk !== null) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === "string" ? encoding : "utf8"));
      }
      this.headersSent = true;
      return true;
    },
    end(chunk, encoding, cb) {
      if (typeof chunk === "function") {
        cb = chunk;
        chunk = undefined;
      } else if (typeof encoding === "function") {
        cb = encoding;
        encoding = undefined;
      }
      if (chunk !== undefined && chunk !== null) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === "string" ? encoding : "utf8"));
      }
      this.headersSent = true;
      this.writableEnded = true;
      if (typeof cb === "function") cb();
      return this;
    }
  };

  await route.handler(req, res);

  const buffer = Buffer.concat(chunks);
  const text = buffer.toString("utf8");
  const outHeaders = Object.fromEntries(headerMap.entries());
  let json = null;
  if ((outHeaders["content-type"] || "").includes("application/json") && text.length > 0) {
    try { json = JSON.parse(text); } catch { json = null; }
  }
  return {
    status: res.statusCode,
    headers: outHeaders,
    body: text,
    buffer,
    json
  };
}

/**
 * Create a Node HTTP request handler `(req, res)` serving the standalone Web UI
 * assets and `/api/dsh-novel-writer/*` routes from `buildUiRoutes`.
 * @param {{ root?: string, allowLan?: boolean }} [config]
 */
export function createWebUiRequestHandler(config = {}) {
  const allowLan = config?.allowLan === true;
  const routes = buildUiRoutes({ ...config, allowLanState: allowLan });
  const routeMap = new Map();
  for (const r of routes) {
    if (r && r.kind === "exact" && typeof r.path === "string" && typeof r.handler === "function") {
      routeMap.set(r.path, r);
    }
  }

  return async function webUiRequestHandler(req, res) {
    if (!isAllowedHostRequest(req, allowLan)) {
      return sendResponse(res, 403, "application/json; charset=utf-8", JSON.stringify({ error: "forbidden: loopback-only" }));
    }
    const method = String(req.method || "GET").toUpperCase();
    let pathname = "/";
    try {
      pathname = new URL(String(req.url || "/"), "http://127.0.0.1").pathname;
    } catch {
      return sendResponse(res, 400, "application/json; charset=utf-8", JSON.stringify({ error: "invalid URL" }));
    }

    const matchedRoute = routeMap.get(pathname);
    if (matchedRoute) {
      res.setHeader("cache-control", "no-store");
      res.setHeader("x-content-type-options", "nosniff");
      try {
        await matchedRoute.handler(req, res);
      } catch (err) {
        if (!res.headersSent) {
          sendResponse(res, 500, "application/json; charset=utf-8", JSON.stringify({ error: String(err?.message ?? err).slice(0, 200) }));
        } else if (!res.writableEnded) {
          res.end();
        }
      }
      return;
    }

    if (method !== "GET" && method !== "HEAD") {
      return sendResponse(res, 405, "application/json; charset=utf-8", JSON.stringify({ error: `method not allowed: ${method}` }));
    }

    switch (pathname) {
      case "/":
        return sendResponse(res, 200, "text/html; charset=utf-8", renderIndexHtml(config), method);
      case "/healthz":
        return sendResponse(
          res,
          200,
          "application/json; charset=utf-8",
          JSON.stringify({ ok: true, service: "dsh-novel-writer-ui", version: PLUGIN_VERSION }),
          method
        );
      case "/assets/theme.css":
        return sendResponse(res, 200, "text/css; charset=utf-8", THEME_CSS, method);
      case "/assets/react-shim.js":
        return sendResponse(res, 200, "application/javascript; charset=utf-8", REACT_SHIM_JS, method);
      case "/assets/bootstrap.js":
        return sendResponse(res, 200, "application/javascript; charset=utf-8", BOOTSTRAP_JS, method);
      case "/preload.js":
        return sendResponse(res, 200, "application/javascript; charset=utf-8", "// standalone: no host bridge\n", method);
      case "/assets/client.js": {
        try {
          const clientJs = await readFile(CLIENT_JS_PATH, "utf8");
          return sendResponse(res, 200, "application/javascript; charset=utf-8", clientJs, method);
        } catch (err) {
          return sendResponse(
            res,
            500,
            "application/json; charset=utf-8",
            JSON.stringify({ error: "failed to load client.js: " + String(err?.message ?? err).slice(0, 120) }),
            method
          );
        }
      }
      default:
        return sendResponse(res, 404, "application/json; charset=utf-8", JSON.stringify({ error: "not found" }), method);
    }
  };
}

/**
 * Start the standalone Web UI HTTP server.
 * @param {{ root?: string, port?: number, host?: string, allowLan?: boolean }} [options]
 * @returns {Promise<{ server: import("node:http").Server, port: number, host: string, url: string, close: () => Promise<void> }>}
 */
export function startWebUiServer({ root, port = 0, host = "127.0.0.1", allowLan = false } = {}) {
  const parsedPort = Number(port);
  if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
    return Promise.reject(new RangeError(`Invalid port: ${port} (expected integer 0..65535)`));
  }
  const handler = createWebUiRequestHandler({ root, allowLan });
  const server = createServer(handler);

  return new Promise((resolveStart, rejectStart) => {
    const onError = (err) => rejectStart(err);
    server.once("error", onError);
    server.listen(parsedPort, host, () => {
      server.off("error", onError);
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : parsedPort;
      const boundHost = typeof addr === "object" && addr && addr.address ? addr.address : host;
      const displayHost = boundHost.includes(":") ? `[${boundHost}]` : boundHost;
      const url = `http://${displayHost}:${boundPort}`;
      let closed = false;
      const close = () => {
        if (closed) return Promise.resolve();
        closed = true;
        return new Promise((resolveClose) => {
          server.close(() => resolveClose());
          // Browser keep-alive sockets would otherwise keep the event loop alive on shutdown.
          server.closeAllConnections?.();
        });
      };
      resolveStart({ server, port: boundPort, host: boundHost, url, close });
    });
  });
}

function parseCliArgs(argv) {
  let cliRoot = null;
  let cliPort = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      const next = argv[i + 1];
      if (typeof next !== "string" || next.trim() === "" || next.trim().startsWith("-")) {
        throw new Error("--root requires a directory path");
      }
      cliRoot = next.trim();
      i += 1;
    } else if (arg.startsWith("--root=")) {
      const val = arg.slice("--root=".length).trim();
      if (!val || val.startsWith("-")) throw new Error("--root= requires a directory path");
      cliRoot = val;
    } else if (arg === "--port") {
      const next = argv[i + 1];
      if (typeof next !== "string" || next.trim() === "") throw new Error("--port requires an integer (0..65535)");
      cliPort = next.trim();
      i += 1;
    } else if (arg.startsWith("--port=")) {
      const val = arg.slice("--port=".length).trim();
      if (!val) throw new Error("--port= requires an integer (0..65535)");
      cliPort = val;
    }
  }

  const root = resolve(
    cliRoot
    || (process.env.DSH_NOVEL_WRITER_ROOT && process.env.DSH_NOVEL_WRITER_ROOT.trim() !== ""
      ? process.env.DSH_NOVEL_WRITER_ROOT.trim()
      : process.cwd())
  );

  let port = 3847;
  const rawPort = cliPort ?? (process.env.DSH_NOVEL_WRITER_UI_PORT?.trim() || null);
  if (rawPort !== null) {
    if (!/^\d+$/.test(rawPort)) {
      throw new Error(`Invalid port "${rawPort}": expected integer 0..65535`);
    }
    port = Number(rawPort);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`Invalid port "${rawPort}": expected integer 0..65535`);
    }
  }
  return { root, port };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const { root, port } = parseCliArgs(process.argv.slice(2));
    const srv = await startWebUiServer({ root, port, host: "127.0.0.1" });
    console.log(`[dsh-novel-writer-ui] Web UI ready at ${srv.url}`);
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      srv.close().then(() => process.exit(0), () => process.exit(1));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (err) {
    console.error(`[dsh-novel-writer-ui] Failed to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
