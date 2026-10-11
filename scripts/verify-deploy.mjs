#!/usr/bin/env node
/**
 * Pre-deploy verification gate. Fails CLOSED: any miss blocks the deploy.
 * Run: node scripts/verify-deploy.mjs [--skip-build]
 *
 * 1. Unfiltered typecheck on ui + shared + desktop (no grep filters — the
 *    2026-10-11 settings crash shipped because errors were grepped away).
 * 2. Shared dist freshness: every new field in src/platform.ts must exist
 *    in dist/platform.d.ts (project refs resolve dist, not src).
 * 3. Bundle markers: required strings physically present in out/ bundles.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAILURES = [];

function check(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
  } catch (error) {
    console.log(`  FAIL ${name}: ${error.message.split("\n")[0]}`);
    FAILURES.push(name);
  }
}

function tsc(projectDir) {
  execFileSync("cmd.exe", ["/c", "npx tsc --noEmit -p ."], {
    cwd: join(ROOT, projectDir),
    encoding: "utf8",
    timeout: 570000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

console.log("[gate] 1. unfiltered typecheck (ui, shared, desktop)");
for (const pkg of ["packages/shared", "packages/ui", "packages/desktop"]) {
  check(`tsc ${pkg}`, () => tsc(pkg));
}

console.log("[gate] 2. shared dist freshness");
check("dist has passwords+history+scopes", () => {
  const platform = readFileSync(join(ROOT, "packages/shared/dist/platform.d.ts"), "utf8");
  for (const marker of ["passwords", "history", "scopes"]) {
    if (!platform.includes(marker)) throw new Error(`dist/platform.d.ts missing '${marker}' — rebuild shared`);
  }
  const protocol = readFileSync(join(ROOT, "packages/shared/dist/protocol.d.ts"), "utf8");
  if (!protocol.includes("diagnosticsEvaluateEnabled"))
    throw new Error("dist/protocol.d.ts missing 'diagnosticsEvaluateEnabled' — rebuild shared");
});

console.log("[gate] 3. bundle markers in out/");
const MARKERS = [
  ["packages/desktop/out/host/index.js", "conversationRowsV4", "scope fix in host"],
  ["packages/desktop/out/main/index.js", "diagnostics", "diagnostics channel in main"],
];
for (const [rel, marker, label] of MARKERS) {
  check(label, () => {
    const path = join(ROOT, rel);
    if (!existsSync(path)) throw new Error(`${rel} missing — rebuild desktop`);
    if (!readFileSync(path, "utf8").includes(marker)) throw new Error(`${rel} missing '${marker}'`);
  });
}
check("dialog in renderer", () => {
  const assets = join(ROOT, "packages/desktop/out/renderer/assets");
  const files = readdirSync(assets).filter((name) => name.endsWith(".js"));
  const hit = files.some((name) =>
    readFileSync(join(assets, name), "utf8").includes("data-import-scope"),
  );
  if (!hit) throw new Error("renderer missing data-import-scope — rebuild desktop");
});

if (FAILURES.length > 0) {
  console.log(`\n[gate] BLOCKED — ${FAILURES.length} failure(s): ${FAILURES.join(", ")}`);
  process.exit(1);
}
console.log("\n[gate] ALL GREEN — safe to pack");
