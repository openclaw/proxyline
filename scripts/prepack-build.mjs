#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function resolveTypeScriptCompiler() {
  try {
    return require.resolve("typescript/bin/tsc");
  } catch {
    return undefined;
  }
}

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const tscBin = resolveTypeScriptCompiler();

if (!tscBin) {
  console.error("TypeScript compiler is unavailable. Run `pnpm install --frozen-lockfile` before packing.");
  process.exit(1);
}

run(process.execPath, [tscBin, "-p", "tsconfig.build.json"]);
