#!/usr/bin/env node
import { existsSync } from "node:fs";
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

let tscBin = resolveTypeScriptCompiler();

if (!tscBin || !existsSync(tscBin)) {
  run(
    "pnpm",
    [
      "add",
      "--save-dev",
      "typescript@^5.9.3",
      "@types/node@^20.19.25",
      "undici@^7.25.0",
      "--ignore-scripts",
      "--lockfile=false",
    ],
    {
      npm_config_lockfile_only: "false",
      PNPM_CONFIG_LOCKFILE_ONLY: "false",
    },
  );
  tscBin = resolveTypeScriptCompiler();
  if (!tscBin || !existsSync(tscBin)) {
    throw new Error("TypeScript compiler is unavailable after installing dev dependencies");
  }
}

run(process.execPath, [tscBin, "-p", "tsconfig.build.json"]);
