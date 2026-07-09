#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);

function resolveTypeScriptCompiler() {
  try {
    const packageJsonPath = require.resolve("typescript/package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const compiler = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.tsc;
    return typeof compiler === "string" ? resolve(dirname(packageJsonPath), compiler) : undefined;
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
