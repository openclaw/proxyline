import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function createDocsFixture(): string {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "proxyline-docs-"));
  fs.cpSync(path.join(repoRoot, "scripts"), path.join(fixture, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(fixture, "docs"));
  return fixture;
}

function runDocsBuild(cwd: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ["scripts/build-docs-site.mjs"], {
    cwd,
    encoding: "utf8",
  });
}

test("docs builder preserves query ampersands in markdown link hrefs", () => {
  const fixture = createDocsFixture();
  fs.writeFileSync(
    path.join(fixture, "docs", "README.md"),
    [
      "---",
      "title: Home",
      "permalink: /",
      "---",
      "",
      "# Home",
      "",
      "[`query`](https://example.test/search?a=1&b=2)",
      "[`a*b*`](https://example.test/code)",
      "[**bold**](https://example.test/bold)",
      "[a\\|b](https://example.test/pipe)",
      "[line<br>break](https://example.test/break)",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(fixture, "docs", "getting-started.md"), "# Getting Started\n");

  const result = runDocsBuild(fixture);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const html = fs.readFileSync(path.join(fixture, "dist", "docs-site", "index.html"), "utf8");
  assert.match(html, /<a href="https:\/\/example\.test\/search\?a=1&amp;b=2"><code>query<\/code><\/a>/);
  assert.match(html, /<a href="https:\/\/example\.test\/code"><code>a\*b\*<\/code><\/a>/);
  assert.match(html, /<a href="https:\/\/example\.test\/bold"><strong>bold<\/strong><\/a>/);
  assert.match(html, /<a href="https:\/\/example\.test\/pipe">a\|b<\/a>/);
  assert.match(html, /<a href="https:\/\/example\.test\/break">line<br>break<\/a>/);
  assert.doesNotMatch(html, /amp;amp/);
  assert.doesNotMatch(html, /@@CODE/);
});

test("docs builder rejects duplicate output paths", () => {
  const fixture = createDocsFixture();
  fs.writeFileSync(
    path.join(fixture, "docs", "README.md"),
    "---\ntitle: Home\npermalink: /\n---\n\n# Home\n",
  );
  fs.writeFileSync(
    path.join(fixture, "docs", "api-reference.md"),
    "---\ntitle: API\npermalink: /\n---\n\n# API\n",
  );

  const result = runDocsBuild(fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Duplicate docs output path "index\.html"/);
});

test("prepack build does not install or rewrite dependencies", () => {
  const script = fs.readFileSync(path.join(repoRoot, "scripts", "prepack-build.mjs"), "utf8");

  assert.doesNotMatch(script, /pnpm"\s*,\s*\[[\s\S]*"add"/);
  assert.doesNotMatch(script, /lockfile=false/);
});
