#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const tests = [
  "test/index.test.ts",
  "test/e2e.test.ts",
  "test/package.test.ts",
];

const coverageArgs = [
  "--experimental-test-coverage",
  "--test-coverage-include=src/**/*.ts",
  "--test-coverage-lines=85",
  "--test-coverage-branches=80",
  "--test-coverage-functions=80",
];

const help = spawnSync(process.execPath, ["--test", "--help"], {
  encoding: "utf8",
});
const testHelp = `${help.stdout ?? ""}\n${help.stderr ?? ""}`;

function supportsFlag(flag) {
  const name = flag.split("=")[0];
  return testHelp.includes(name);
}

const supportedCoverageArgs = coverageArgs.filter(supportsFlag);
const skippedCoverageArgs = coverageArgs.filter((arg) => !supportsFlag(arg));

if (skippedCoverageArgs.length > 0) {
  console.warn(
    `Native coverage thresholds are unavailable on ${process.version}; running compatibility coverage without ${skippedCoverageArgs.join(", ")}.`,
  );
}

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...supportedCoverageArgs, ...tests],
  { stdio: "inherit" },
);

process.exit(result.status ?? 1);
