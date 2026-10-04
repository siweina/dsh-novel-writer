#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const tests = readdirSync(new URL('./', import.meta.url)).filter(name => name.endsWith('-test.mjs')).sort();
for (const test of tests) {
  console.log(`\n=== ${test} ===`);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(test, import.meta.url))], { cwd: root, stdio: 'inherit', timeout: 180_000 });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`\nAll ${tests.length} test suites passed.`);
