import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command: string, args: string[], cwd = repoRoot): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function packageManagerCommand(): { command: string; prefixArgs: string[]; supportsCache: boolean } {
  if (process.env.npm_execpath !== undefined) {
    const execPath = process.env.npm_execpath;
    const extension = path.extname(execPath).toLowerCase();
    const runsWithNode = extension === ".js" || extension === ".cjs" || extension === ".mjs";
    return {
      command: runsWithNode ? process.execPath : execPath,
      prefixArgs: runsWithNode ? [execPath] : [],
      supportsCache: path.basename(execPath).startsWith("npm"),
    };
  }
  return { command: process.platform === "win32" ? "pnpm.cmd" : "pnpm", prefixArgs: [], supportsCache: false };
}

test("packed package includes sources and product docs referenced by metadata", () => {
  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), "proxyline-pack-"));
  const cacheDir = path.join(packDir, "npm-cache");
  const packageManager = packageManagerCommand();
  run(packageManager.command, [
    ...packageManager.prefixArgs,
    "pack",
    "--pack-destination",
    packDir,
    ...(packageManager.supportsCache ? ["--cache", cacheDir] : []),
  ]);
  const tarball = fs.readdirSync(packDir).find((entry) => entry.endsWith(".tgz"));
  assert.ok(tarball);
  const tarballPath = path.join(packDir, tarball);
  const entries = run("tar", ["-tzf", tarballPath], packDir)
    .split("\n")
    .map((entry) => entry.replaceAll("\\", "/"));

  assert.ok(entries.includes("package/src/index.ts"));
  assert.ok(entries.includes("package/docs/README.md"));
  assert.ok(entries.includes("package/docs/security.md"));
  assert.ok(entries.includes("package/scripts/prepack-build.mjs"));
  assert.ok(entries.includes("package/tsconfig.build.json"));

  run("tar", ["-xzf", tarballPath, "-C", packDir], packDir);
  const packageRoot = path.join(packDir, "package");
  const mapFiles = fs.readdirSync(path.join(packageRoot, "dist"))
    .filter((entry) => entry.endsWith(".d.ts.map"));

  assert.notEqual(mapFiles.length, 0);
  for (const file of mapFiles) {
    const map = JSON.parse(fs.readFileSync(path.join(packageRoot, "dist", file), "utf8")) as {
      sources?: string[];
    };
    for (const source of map.sources ?? []) {
      assert.ok(
        fs.existsSync(path.normalize(path.join(packageRoot, "dist", source))),
        `${file} source is missing: ${source}`,
      );
    }
  }
});
