import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const release = readFileSync(join(root, ".github/workflows/proxyline-npm-release.yml"), "utf8");
const tag = "v1.2.3";

function stepBody(workflow, name) {
  const step = workflow.split(`      - name: ${name}\n`)[1]?.split(/\n      - |\n  \S/)[0];
  const body = step?.split("        run: |\n")[1];
  assert.ok(body, `Missing workflow shell step: ${name}`);
  return body.split("\n").map((line) => line.replace(/^          /, "")).join("\n");
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "proxyline-release-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !key.startsWith("GIT_") && key !== "SSH_AUTH_SOCK" && key !== "GITHUB_OUTPUT"));
  const config = join(dir, "empty-git-config");
  writeFileSync(config, "");
  Object.assign(env, { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" });
  const repo = join(dir, "repo");
  const remote = join(dir, "remote.git");
  const run = (command, args, options = {}) => execFileSync(command, args, {
    cwd: repo, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...options,
  }).trim();
  mkdirSync(repo);
  run("git", ["-c", "init.templateDir=", "init", "--initial-branch=main"]);
  run("git", ["-c", "init.templateDir=", "init", "--bare", remote]);
  const git = (...args) => run("git", args);
  git("config", "user.name", "Release Fixture");
  git("config", "user.email", "release@example.invalid");
  for (const name of ["trusted", "unknown"]) {
    run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(dir, name)]);
  }
  mkdirSync(join(repo, ".github"));
  mkdirSync(join(repo, "scripts"));
  copyFileSync(join(root, "scripts/verify-release-tag.mjs"), join(repo, "scripts/verify-release-tag.mjs"));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "release-fixture", version: "1.2.3" }));
  writeFileSync(join(repo, ".github/release-allowed-signers"),
    `fixture namespaces="git" ${readFileSync(join(dir, "trusted.pub"), "utf8")}`);
  git("add", ".");
  git("commit", "-m", "fixture");
  git("remote", "add", "origin", remote);
  git("push", "origin", "HEAD:refs/heads/main");
  const source = git("rev-parse", "HEAD");
  const sign = (key = "trusted", target = "HEAD", message = "release") => {
    git("-c", "gpg.format=ssh", "-c", "gpg.ssh.program=ssh-keygen", "-c", `user.signingkey=${join(dir, key)}`,
      "tag", "-s", "-f", tag, target, "-m", message);
    git("push", "--force", "origin", `refs/tags/${tag}`);
    return git("rev-parse", `refs/tags/${tag}`);
  };
  const verify = (...args) => spawnSync(process.execPath, ["scripts/verify-release-tag.mjs", tag, ...args], {
    cwd: repo, env, encoding: "utf8",
  });
  const bin = join(dir, "bin");
  mkdirSync(bin);
  // Only external mutations are stubbed. Signature, ref and remote checks use real Git/SSH.
  writeFileSync(join(bin, "npm"), '#!/bin/sh\nif [ "$1" = view ]; then exit "${NPM_EXISTS:-1}"; fi\nprintf "npm %s\\n" "$*" >> "$MUTATION_LOG"\n', { mode: 0o755 });
  const mutations = join(dir, "mutations");
  const output = join(dir, "output");
  const shell = (body, variables = {}) => spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", body], {
    cwd: repo, encoding: "utf8", env: { ...env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`,
      MUTATION_LOG: mutations, GITHUB_OUTPUT: output, TAG_NAME: tag, RELEASE_TAG: "", DRY_RUN: "false", RUNNER_TEMP: dir, PACKAGE: "release-fixture@1.2.3", ...variables },
  });
  return { repo, remote, dir, git, run, source, sign, verify, shell, mutations, output };
}

// The workflow runs on Ubuntu; real Git/SSH verification also runs on Windows CI.
const bashOnly = { skip: process.platform === "win32" ? "Ubuntu workflow shell coverage runs on POSIX" : false };

test("allowed SSH release tag freezes the annotated object and source", (t) => {
  const f = fixture(t);
  const object = f.sign();
  const result = f.verify();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `tag_object=${object}\nsource_sha=${f.source}\n`);
  assert.equal(f.verify(object, f.source).status, 0);
  assert.notEqual(f.verify(object, "0".repeat(40)).status, 0);
});

test("manual branch and matching release event preserve publish and no-op paths", bashOnly, (t) => {
  const f = fixture(t);
  const object = f.sign();
  for (const releaseTag of ["", tag]) {
    const validation = f.shell(stepBody(release, "Verify release tag"), { RELEASE_TAG: releaseTag });
    assert.equal(validation.status, 0, validation.stderr);
  }
  assert.match(readFileSync(f.output, "utf8"), new RegExp(`tag_object=${object}\\nsource_sha=${f.source}`));
  const frozen = { TAG_OBJECT: object, SOURCE_SHA: f.source };
  const noOp = f.shell(stepBody(release, "Publish to npm"), { ...frozen, NPM_EXISTS: "0" });
  assert.equal(noOp.status, 0, noOp.stderr);
  assert.equal(existsSync(f.mutations), false);
  const publish = f.shell(stepBody(release, "Publish to npm"), frozen);
  assert.equal(publish.status, 0, publish.stderr);
  assert.match(readFileSync(f.mutations, "utf8"), /npm publish --access public --provenance/);
});

for (const kind of ["missing", "lightweight", "unsigned", "unknown", "tampered", "wrong-target"]) {
  test(`${kind} release tag fails before publish or already-published no-op`, (t) => {
    const f = fixture(t);
    if (kind === "lightweight") f.git("tag", tag);
    if (kind === "unsigned") f.git("tag", "-a", tag, "-m", "release");
    if (kind === "unknown") {
      f.sign("unknown");
      writeFileSync(join(f.repo, ".github/release-allowed-signers"),
        `fixture ${readFileSync(join(f.dir, "unknown.pub"), "utf8")}`);
    }
    if (kind === "tampered") {
      f.sign();
      const contents = f.git("cat-file", "tag", `refs/tags/${tag}`).replace("\nrelease\n", "\ntampered\n") + "\n";
      const object = f.run("git", ["hash-object", "-t", "tag", "-w", "--stdin"], { input: contents });
      f.git("update-ref", `refs/tags/${tag}`, object);
    }
    if (kind === "wrong-target") {
      f.git("commit", "--allow-empty", "-m", "new source");
      f.sign("trusted", f.source);
    }
    if (!["missing", "unknown", "wrong-target"].includes(kind)) {
      f.git("push", "--force", "origin", `refs/tags/${tag}`);
    }
    const object = kind === "missing" ? "0".repeat(40) : f.git("rev-parse", `refs/tags/${tag}`);
    const source = f.git("rev-parse", "HEAD");
    const result = f.verify(object, source);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /Usage: verify-release-tag/);
    if (process.platform !== "win32") {
      const validation = f.shell(stepBody(release, "Verify release tag"));
      assert.notEqual(validation.status, 0);
      for (const exists of ["0", "1"]) {
        const publish = f.shell(stepBody(release, "Publish to npm"), {
          TAG_OBJECT: object, SOURCE_SHA: source, NPM_EXISTS: exists,
        });
        assert.notEqual(publish.status, 0);
        assert.doesNotMatch(publish.stderr, /Usage: verify-release-tag/);
      }
    }
    assert.equal(existsSync(f.mutations), false);
  });
}

test("same-source replacement cannot reuse frozen release approval", (t) => {
  const f = fixture(t);
  const original = f.sign();
  const replacement = f.sign("trusted", "HEAD", "replacement");
  assert.notEqual(original, replacement);
  f.git("update-ref", `refs/tags/${tag}`, original);
  assert.match(f.verify(original, f.source).stderr, /Remote release tag object or source differs/);
  if (process.platform !== "win32") {
    for (const exists of ["0", "1"]) {
      const result = f.shell(stepBody(release, "Publish to npm"), {
        TAG_OBJECT: original, SOURCE_SHA: f.source, NPM_EXISTS: exists,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Remote release tag object or source differs/);
    }
  }
  assert.equal(existsSync(f.mutations), false);
  f.git("update-ref", `refs/tags/${tag}`, replacement);
  assert.match(f.verify(original, f.source).stderr, /changed since validation/);
});

test("failed-publish reconciliation rechecks the remote tag despite set +e", bashOnly, (t) => {
  const f = fixture(t);
  const original = f.sign();
  const replacement = f.sign("trusted", "HEAD", "replacement");
  f.git("update-ref", `refs/tags/${tag}`, original);
  f.git("--git-dir", f.remote, "update-ref", `refs/tags/${tag}`, original);
  writeFileSync(join(f.dir, "bin/npm"), [
    "#!/bin/sh",
    'if [ "$1" = view ]; then test -f "$MUTATION_LOG"; exit $?; fi',
    'echo publish >> "$MUTATION_LOG"',
    'git --git-dir "$REMOTE_REPO" update-ref "$TAG_REF" "$REPLACEMENT_OBJECT"',
    "exit 1",
  ].join("\n"), { mode: 0o755 });
  const result = f.shell(stepBody(release, "Publish to npm"), {
    TAG_OBJECT: original, SOURCE_SHA: f.source, REMOTE_REPO: f.remote,
    TAG_REF: `refs/tags/${tag}`, REPLACEMENT_OBJECT: replacement,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Remote release tag object or source differs/);
  assert.doesNotMatch(result.stdout, /is already published/);
});

test("branch dry run needs no tag; mismatched release event fails", bashOnly, (t) => {
  const f = fixture(t);
  const dryRun = f.shell(stepBody(release, "Verify release tag"), { DRY_RUN: "true" });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.doesNotMatch(readFileSync(f.output, "utf8"), /tag_object=/);
  assert.equal(f.git("tag", "--list"), "");
  assert.equal(existsSync(f.mutations), false);
  const mismatch = f.shell(stepBody(release, "Verify release tag"), { RELEASE_TAG: "v9.9.9" });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stdout, /Release tag\/version mismatch/);
  assert.match(release, /if: \$\{\{ !inputs\.dry_run \}\}/);
  assert.ok(release.indexOf("name: Verify release tag") < release.indexOf("name: Install dependencies"));
  assert.match(release, /environment: \$\{\{ !inputs\.dry_run && 'npm-release' \|\| '' \}\}/);
});

