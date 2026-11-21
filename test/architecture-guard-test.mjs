/**
 * Architecture & boundary guard suite (47th test suite).
 * Ensures ARCHITECTURE.md stays in sync with lib/, lib/core/, and lib/tools/,
 * verifies client build boundaries, and checks core/domain barrel parity.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DOMAIN_SUBMODULES = [
  "stores.js",
  "lexicon.js",
  "rules.js",
  "baseline.js",
  "analysis-cache.js",
  "creation.js",
];

let tempStateRoot = null;
let prevStateEnv;
let prevHomeEnv;

test.before(() => {
  prevStateEnv = process.env.DSH_NOVEL_WRITER_STATE;
  prevHomeEnv = process.env.DSH_HOME;
  tempStateRoot = mkdtempSync(join(tmpdir(), "dsh-novel-writer-arch-"));
  process.env.DSH_NOVEL_WRITER_STATE = join(tempStateRoot, "state.json");
  process.env.DSH_HOME = join(tempStateRoot, "dsh-home");
});

test.after(() => {
  if (prevStateEnv === undefined) delete process.env.DSH_NOVEL_WRITER_STATE;
  else process.env.DSH_NOVEL_WRITER_STATE = prevStateEnv;

  if (prevHomeEnv === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = prevHomeEnv;

  if (tempStateRoot && existsSync(tempStateRoot)) {
    rmSync(tempStateRoot, { recursive: true, force: true });
  }
});

function countLines(filePath) {
  return readFileSync(filePath, "utf8").split(/\r?\n/).length;
}

function walkFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full));
    } else {
      results.push({ name: entry.name, path: full });
    }
  }
  return results;
}

test("1. ARCHITECTURE.md exists and documents every lib/, lib/core/, and lib/tools/ JS module", () => {
  const archPath = join(ROOT, "ARCHITECTURE.md");
  assert.equal(existsSync(archPath), true, "ARCHITECTURE.md must exist");
  const arch = readFileSync(archPath, "utf8");

  const libFiles = readdirSync(join(ROOT, "lib")).filter((name) => name.endsWith(".js"));
  assert.ok(libFiles.length > 0, "expected top-level lib/*.js files");
  for (const file of libFiles) {
    assert.ok(arch.includes(`lib/${file}`), `ARCHITECTURE.md must mention lib/${file}`);
  }

  const coreFiles = readdirSync(join(ROOT, "lib/core")).filter((name) => name.endsWith(".js"));
  assert.ok(coreFiles.length > 0, "expected lib/core/*.js files");
  for (const file of coreFiles) {
    assert.ok(arch.includes(`lib/core/${file}`), `ARCHITECTURE.md must mention lib/core/${file}`);
  }

  const toolFiles = readdirSync(join(ROOT, "lib/tools")).filter((name) => name.endsWith(".js"));
  assert.ok(toolFiles.length > 0, "expected lib/tools/*.js files");
  for (const file of toolFiles) {
    assert.ok(arch.includes(`lib/tools/${file}`), `ARCHITECTURE.md must mention lib/tools/${file}`);
  }
});

test("2. lib/client.js line 1 declares AUTO-GENERATED from client/ via tools/build-client.mjs", () => {
  const clientPath = join(ROOT, "lib/client.js");
  assert.equal(existsSync(clientPath), true, "lib/client.js must exist");
  const firstLine = readFileSync(clientPath, "utf8").split(/\r?\n/, 1)[0] ?? "";

  assert.ok(firstLine.includes("AUTO-GENERATED"), "line 1 must contain AUTO-GENERATED");
  assert.ok(firstLine.includes("client/"), "line 1 must reference client/");
  assert.ok(firstLine.includes("tools/build-client.mjs"), "line 1 must reference tools/build-client.mjs");
});

test("3. Legacy tools/client-src is absent and client/ contains no V6- prefixed files", () => {
  assert.equal(existsSync(join(ROOT, "tools/client-src")), false, "tools/client-src must not exist");

  const clientDir = join(ROOT, "client");
  assert.equal(existsSync(clientDir), true, "client/ directory must exist");
  const v6Files = walkFiles(clientDir)
    .filter((entry) => entry.name.startsWith("V6-"))
    .map((entry) => entry.path);
  assert.deepEqual(v6Files, [], `client/ must contain zero V6- prefixed files, found: ${v6Files.join(", ")}`);
});

test("4. lib/core/domain.js thin barrel & 6 domain sub-modules size limits and dynamic import symbol parity", async () => {
  const domainPath = join(ROOT, "lib/core/domain.js");
  const domainLines = countLines(domainPath);
  assert.ok(domainLines < 40, `lib/core/domain.js must be < 40 lines, got ${domainLines}`);

  for (const sub of DOMAIN_SUBMODULES) {
    const subLines = countLines(join(ROOT, "lib/core", sub));
    assert.ok(subLines < 650, `lib/core/${sub} must be < 650 lines, got ${subLines}`);
  }

  assert.ok(
    process.env.DSH_NOVEL_WRITER_STATE?.startsWith(tmpdir()),
    "DSH_NOVEL_WRITER_STATE must be redirected to os.tmpdir() before dynamic import"
  );
  assert.ok(
    process.env.DSH_HOME?.startsWith(tmpdir()),
    "DSH_HOME must be redirected to os.tmpdir() before dynamic import"
  );

  const [domainMod, coreMod, ...subMods] = await Promise.all([
    import("../lib/core/domain.js"),
    import("../lib/core.js"),
    ...DOMAIN_SUBMODULES.map((sub) => import(`../lib/core/${sub}`)),
  ]);

  const domainKeys = Object.keys(domainMod);
  assert.ok(domainKeys.length > 0, "lib/core/domain.js must export domain symbols");

  const expectedFromSubmodules = new Set();
  for (let i = 0; i < DOMAIN_SUBMODULES.length; i += 1) {
    const subName = DOMAIN_SUBMODULES[i];
    const subMod = subMods[i];
    const subKeys = Object.keys(subMod);
    assert.ok(subKeys.length > 0, `lib/core/${subName} must export at least one symbol`);
    for (const sym of subKeys) {
      assert.equal(expectedFromSubmodules.has(sym), false, `duplicate domain export across submodules: ${sym}`);
      expectedFromSubmodules.add(sym);
      assert.equal(Object.hasOwn(domainMod, sym), true, `domain.js missing export ${sym} from ${subName}`);
      assert.equal(domainMod[sym], subMod[sym], `domain.js export ${sym} must match ${subName}`);
    }
  }

  assert.equal(domainKeys.length, expectedFromSubmodules.size, "domain.js exports must match union of 6 submodules");

  for (const sym of domainKeys) {
    assert.notEqual(domainMod[sym], undefined, `domain export ${sym} must be initialized (no circular TDZ)`);
    assert.equal(Object.hasOwn(coreMod, sym), true, `lib/core.js missing domain export ${sym}`);
    assert.equal(coreMod[sym], domainMod[sym], `lib/core.js export ${sym} must match lib/core/domain.js`);
  }
});
