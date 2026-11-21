#!/usr/bin/env node
/**
 * Install the dsh-novel-writer Antigravity Sidecar UI plugin bundle.
 *
 * Dry-run by default. Pass `--apply` to copy files into:
 *   <GEMINI_CONFIG_DIR || ~/.gemini/config>/plugins/dsh-novel-writer-ui
 *
 * Never modifies ~/.gemini/config/config.json.
 *
 * Usage:
 *   node tools/install-antigravity-ui.mjs [--apply] [--root <library-root>]
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const SRC_ROOT = join(REPO, "antigravity");

const BUNDLE_FILES = [
  ["plugin.json", "plugin.json"],
  [join("assets", "logo.svg"), join("assets", "logo.svg")],
  [join("sidecars", "panel", "sidecar.json"), join("sidecars", "panel", "sidecar.json")],
  [join("sidecars", "panel", "main.mjs"), join("sidecars", "panel", "main.mjs")]
];

function parseArgs(argv) {
  let apply = false;
  let help = false;
  let root = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--root") {
      const next = argv[i + 1];
      if (typeof next !== "string" || next.trim() === "" || next.trim().startsWith("-")) {
        throw new Error("--root requires a directory path");
      }
      root = resolve(next.trim());
      i += 1;
    } else if (arg.startsWith("--root=")) {
      const val = arg.slice("--root=".length).trim();
      if (!val || val.startsWith("-")) {
        throw new Error("--root= requires a directory path");
      }
      root = resolve(val);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { apply, help, root };
}

function resolvePluginDestDir() {
  const configBase = process.env.GEMINI_CONFIG_DIR?.trim()
    ? resolve(process.env.GEMINI_CONFIG_DIR.trim())
    : join(homedir(), ".gemini", "config");
  return join(configBase, "plugins", "dsh-novel-writer-ui");
}

function printHelp() {
  console.log([
    "Install dsh-novel-writer Antigravity Sidecar UI plugin bundle",
    "",
    "Usage:",
    "  node tools/install-antigravity-ui.mjs [--apply] [--root <dir>]",
    "",
    "Options:",
    "  --apply       Write files to <GEMINI_CONFIG_DIR || ~/.gemini/config>/plugins/dsh-novel-writer-ui",
    "  --root <dir>  Optional default library root recorded in sidecars/panel/config.json",
    "  -h, --help    Show this help message"
  ].join("\n"));
}

async function readExistingPanelConfig(configPath) {
  if (!existsSync(configPath)) return {};
  try {
    const raw = (await readFile(configPath, "utf8")).replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function main() {
  const { apply, help, root } = parseArgs(process.argv.slice(2));
  if (help) {
    printHelp();
    return;
  }

  for (const [relSrc] of BUNDLE_FILES) {
    const absSrc = join(SRC_ROOT, relSrc);
    if (!existsSync(absSrc)) {
      throw new Error(`Missing source bundle file: ${absSrc}`);
    }
  }

  const destDir = resolvePluginDestDir();
  const panelConfigPath = join(destDir, "sidecars", "panel", "config.json");
  const existingConfig = await readExistingPanelConfig(panelConfigPath);
  const panelConfig = {
    ...existingConfig,
    pluginDir: REPO,
    ...(root ? { root } : {})
  };

  if (!apply) {
    console.log("[dry-run] No files written. Pass --apply to install.");
    console.log(`Target directory: ${destDir}`);
    console.log("Planned files:");
    for (const [relSrc, relDest] of BUNDLE_FILES) {
      console.log(`  copy  ${join(SRC_ROOT, relSrc)} -> ${join(destDir, relDest)}`);
    }
    console.log(`  write ${panelConfigPath}`);
    console.log(`Config payload: ${JSON.stringify(panelConfig)}`);
    console.log("");
    console.log("Note: ~/.gemini/config/config.json will NOT be modified.");
    return;
  }

  for (const [relSrc, relDest] of BUNDLE_FILES) {
    const srcPath = join(SRC_ROOT, relSrc);
    const destPath = join(destDir, relDest);
    await mkdir(dirname(destPath), { recursive: true });
    await copyFile(srcPath, destPath);
  }

  await mkdir(dirname(panelConfigPath), { recursive: true });
  await writeFile(panelConfigPath, JSON.stringify(panelConfig, null, 2) + "\n", "utf8");

  const effectiveRoot = typeof panelConfig.root === "string" && panelConfig.root.trim() !== "" ? panelConfig.root.trim() : "";
  console.log(`Installed Antigravity Sidecar UI bundle to: ${destDir}`);
  console.log(`Recorded pluginDir=${REPO}${effectiveRoot ? `, root=${effectiveRoot}` : " (runtime root via DSH_NOVEL_WRITER_ROOT or state.lastRoot)"}`);
  console.log("");
  console.log("Next steps:");
  console.log("  1. Open Antigravity Customizations and enable [Novel Writer Studio](customization://dsh-novel-writer-ui).");
  console.log("  2. Open the Novel Writer side pane (Aux Pane) or restart Antigravity if the plugin list needs refreshing.");
}

main().catch((err) => {
  console.error(`[install-antigravity-ui] Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
