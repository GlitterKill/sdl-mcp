#!/usr/bin/env node

import { verifyExternalBenchmarkEvidence } from "../dist/benchmark/external-runner.js";

const OPTION_KEYS = new Map([
  ["--root", "root"],
  ["--repo-id", "repoId"],
  ["--source-ref", "sourceRef"],
  ["--source-commit", "sourceCommit"],
  ["--cache-mode", "cacheMode"],
  ["--repeats", "repeats"],
  ["--default-db-before", "defaultDbBefore"],
  ["--default-db-after", "defaultDbAfter"],
]);

try {
  const values = new Map();
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const key = OPTION_KEYS.get(flag);
    const value = args[index + 1];
    if (key === undefined) throw new Error("Unknown verifier option: " + flag);
    if (value === undefined || value.startsWith("--")) {
      throw new Error("Missing value for verifier option: " + flag);
    }
    if (values.has(key)) throw new Error("Duplicate verifier option: " + flag);
    values.set(key, value);
  }
  for (const key of OPTION_KEYS.values()) {
    if (!values.has(key)) throw new Error("Missing verifier option: " + key);
  }
  const repeats = Number(values.get("repeats"));
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) {
    throw new Error("--repeats must be an integer from 1 through 20");
  }
  const cacheMode = values.get("cacheMode");
  if (cacheMode !== "cold" && cacheMode !== "warm") {
    throw new Error("--cache-mode must be cold or warm");
  }

  process.exitCode = verifyExternalBenchmarkEvidence({
    root: values.get("root"),
    repoId: values.get("repoId"),
    sourceRef: values.get("sourceRef"),
    sourceCommit: values.get("sourceCommit"),
    cacheMode,
    repeats,
    defaultDbBefore: values.get("defaultDbBefore"),
    defaultDbAfter: values.get("defaultDbAfter"),
  });
  if (process.exitCode === 0) {
    console.log("External benchmark evidence verified");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
