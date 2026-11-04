#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const git = (...args) => execFileSync("git", args, {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
}).trim();

try {
  const args = process.argv.slice(2);
  const [tag, expectedObject, expectedSource] = args;
  if (
    !tag || ![1, 3].includes(args.length)
    || (args.length === 3 && !args.slice(1).every((sha) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)))
  ) {
    throw new Error("Usage: verify-release-tag.mjs <tag> [<frozen-tag-object> <frozen-source-sha>]");
  }

  const source = git("rev-parse", "--verify", "HEAD^{commit}");
  const { version } = JSON.parse(git("show", `${source}:package.json`));
  if (tag !== `v${version}`) throw new Error(`Tag/version mismatch: expected v${version}, got ${tag}`);
  const ref = `refs/tags/${tag}`;
  git("check-ref-format", ref);
  const object = git("rev-parse", "--verify", ref);
  if (git("cat-file", "-t", object) !== "tag") throw new Error(`${tag} must be an annotated tag`);
  const target = git("rev-parse", "--verify", `${object}^{commit}`);
  if (target !== source) throw new Error(`${tag} does not target checked-out HEAD ${source}`);
  if (expectedObject && (object !== expectedObject || source !== expectedSource)) {
    throw new Error("Release tag object or source changed since validation");
  }

  const contents = git("cat-file", "tag", object);
  if (!contents.split("\n\n", 1)[0].split("\n").includes(`tag ${tag}`)) {
    throw new Error("Signed tag name does not match the release ref");
  }
  if (!/\n-----BEGIN SSH SIGNATURE-----\n(?:[A-Za-z0-9+/=]+\n)+-----END SSH SIGNATURE-----$/.test(contents)) {
    throw new Error(`${tag} must have an SSH signature`);
  }

  // Read policy from the frozen commit, so an uncommitted allowlist cannot grant trust.
  const scratch = mkdtempSync(join(tmpdir(), "release-tag-"));
  try {
    const signers = join(scratch, "allowed-signers");
    writeFileSync(signers, git("show", `${source}:.github/release-allowed-signers`) + "\n");
    git(
      "-c", "gpg.format=ssh",
      "-c", "gpg.ssh.program=ssh-keygen",
      "-c", "gpg.minTrustLevel=fully",
      "-c", `gpg.ssh.allowedSignersFile=${signers}`,
      "verify-tag", object,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  // A replacement signed tag can still target the same commit. Bind both identities.
  const remote = new Map(git("ls-remote", "--exit-code", "origin", ref, `${ref}^{}`)
    .split("\n").map((line) => line.split(/\s+/).reverse()));
  if (remote.get(ref) !== object || remote.get(`${ref}^{}`) !== source) {
    throw new Error("Remote release tag object or source differs from the validated tag");
  }

  const output = `tag_object=${object}\nsource_sha=${source}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
} catch (error) {
  console.error(`[release-tag] ${error.message}`);
  process.exitCode = 1;
}
