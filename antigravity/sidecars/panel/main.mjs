/**
 * Antigravity Sidecar Panel entrypoint for dsh-novel-writer Web UI.
 *
 * Bridges Antigravity's SidecarApp API when `ANTIGRAVITY_SIDECAR_WEB_PORT` is set,
 * or launches the standalone loopback HTTP Web UI server otherwise.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Read optional sibling config.json written by tools/install-antigravity-ui.mjs. */
function readPanelConfig() {
  try {
    const raw = readFileSync(join(HERE, "config.json"), "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Load sidecar_sdk via ESM import with CJS NODE_PATH resolution fallback for Windows builds. */
async function loadSidecarSdk() {
  try {
    return await import("sidecar_sdk");
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    const file = createRequire(import.meta.url).resolve("sidecar_sdk");
    return import(pathToFileURL(file).href);
  }
}

/** Serialize non-empty scalar query parameters into `?k=v` for GET route invocations. */
function buildQueryUrl(path, data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      const str = String(value);
      if (str !== "") params.set(key, str);
    }
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

const panelConfig = readPanelConfig();
const pluginDir = resolve(
  process.env.DSH_NOVEL_WRITER_PLUGIN_DIR?.trim()
  || (typeof panelConfig.pluginDir === "string" && panelConfig.pluginDir.trim() !== "" ? panelConfig.pluginDir.trim() : "")
  || resolve(HERE, "../../..")
);
const rawRoot = process.env.DSH_NOVEL_WRITER_ROOT?.trim()
  || (typeof panelConfig.root === "string" && panelConfig.root.trim() !== "" ? panelConfig.root.trim() : "");
const root = rawRoot !== "" ? resolve(rawRoot) : "";

const { createWebUiRequestHandler, invokeRouteInMemory, startWebUiServer } = await import(
  pathToFileURL(join(pluginDir, "lib", "web-ui.js")).href
);
const { buildUiRoutes } = await import(
  pathToFileURL(join(pluginDir, "lib", "tools", "system.js")).href
);

if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
  const { SidecarApp, Response } = await loadSidecarSdk();
  const handler = createWebUiRequestHandler({ root });
  const routes = buildUiRoutes({ root });

  const toSidecarResponse = (result) => {
    let contentType = "application/octet-stream";
    const headers = {};
    if (result.headers && typeof result.headers === "object") {
      for (const [k, v] of Object.entries(result.headers)) {
        if (String(k).toLowerCase() === "content-type") {
          if (typeof v === "string" && v !== "") contentType = v;
          continue;
        }
        if (v !== undefined) headers[k] = v;
      }
    }
    return new Response(result.body, {
      status: result.status,
      contentType,
      headers
    });
  };

  const app = new SidecarApp();

  const staticPaths = [
    "/",
    "/healthz",
    "/assets/theme.css",
    "/assets/react-shim.js",
    "/assets/bootstrap.js",
    "/assets/client.js"
  ];
  for (const path of staticPaths) {
    app.api(path, async (data) => {
      const result = await invokeRouteInMemory({ path, handler }, {
        method: "GET",
        url: buildQueryUrl(path, data)
      });
      return toSidecarResponse(result);
    }, "GET");
  }

  for (const r of routes) {
    if (!r || typeof r.path !== "string" || typeof r.handler !== "function") continue;
    app.api(r.path, async (data) => {
      const result = await invokeRouteInMemory(r, {
        method: "GET",
        url: buildQueryUrl(r.path, data)
      });
      return toSidecarResponse(result);
    }, "GET");
    app.api(r.path, async (data) => {
      const result = await invokeRouteInMemory(r, {
        method: "POST",
        url: r.path,
        body: data === undefined ? {} : data
      });
      return toSidecarResponse(result);
    }, "POST");
  }

  app.run();

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    Promise.resolve(app.close?.() ?? app.stop?.()).catch(() => {}).finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} else {
  const srv = await startWebUiServer({ root, port: Number(process.env.DSH_NOVEL_WRITER_UI_PORT || 3847) });
  console.log(`[dsh-novel-writer-ui] Web UI ready at ${srv.url}`);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    srv.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
