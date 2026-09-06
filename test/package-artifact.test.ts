import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

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
    .map((entry) => entry.replaceAll("\\", "/").trim());

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

test("built runtime restores fetch globals in a relocated standalone bundle", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxyline-bundle-"));
  try {
    const output = path.join(root, "output", "runtime.mjs");
    await build({
      stdin: {
        contents: `
import assert from "node:assert/strict";
import { installGlobalProxy } from ${JSON.stringify(path.join(repoRoot, "dist/index.js"))};
const keys = ["fetch", "Headers", "Request", "Response", "FormData"];
const original = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
const proxy = installGlobalProxy({ mode: "managed", proxyUrl: "http://127.0.0.1:9" });
try {
  assert.notEqual(globalThis.Response, original.Response);
  assert.equal(await (await fetch("data:text/plain,bundled")).text(), "bundled");
} finally {
  proxy.stop();
}
for (const key of keys) assert.equal(globalThis[key], original[key]);
await new Promise(resolve => setImmediate(resolve));
console.log(JSON.stringify({ response: "bundled", restored: true }));
`,
        resolveDir: repoRoot,
        sourcefile: "bundle-fixture.mjs",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      outfile: output,
      banner: {
        js: 'import { createRequire as bundleRequire } from "node:module"; const require = bundleRequire(import.meta.url);',
      },
    });
    const relocatedRoot = path.join(root, "relocated");
    fs.mkdirSync(relocatedRoot);
    const relocated = path.join(relocatedRoot, "runtime.mjs");
    fs.renameSync(output, relocated);
    fs.rmSync(path.dirname(output), { recursive: true });
    const result = spawnSync(process.execPath, [relocated], {
      cwd: relocatedRoot,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: root,
        USERPROFILE: root,
        TMPDIR: root,
        TEMP: root,
        TMP: root,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), { response: "bundled", restored: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
