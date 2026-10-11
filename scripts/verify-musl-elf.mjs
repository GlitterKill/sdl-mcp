import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Inspect ELF metadata, not arbitrary strings in parser tables or debug data.
export function validateMuslElf(metadata) {
  assert.match(metadata, /Class:\s+ELF64\b/, "musl addon must be ELF64");
  assert.match(metadata, /Type:\s+DYN\b/, "musl addon must be a shared object");
  assert.match(metadata, /Machine:\s+Advanced Micro Devices X86-64\b/, "musl addon must be x86-64");
  assert.doesNotMatch(metadata, /\bINTERP\b|Requesting program interpreter/, "addon must not request an executable interpreter");
  assert.doesNotMatch(metadata, /GLIBC_|\bld-linux[^\s\]]*/, "musl addon must not depend on glibc");
  assert.doesNotMatch(metadata, /\((?:RPATH|RUNPATH)\)/, "musl addon must not use a build-host library search path");
  const needed = [...metadata.matchAll(/\(NEEDED\)\s+Shared library: \[([^\]]+)\]/g)].map(match => match[1]);
  assert.ok(needed.includes("libc.musl-x86_64.so.1"), "musl addon must dynamically link musl libc");
  const allowed = new Set(["libc.musl-x86_64.so.1", "libgcc_s.so.1", "libstdc++.so.6"]);
  for (const library of needed) assert.ok(allowed.has(library), `incompatible musl dependency: ${library}`);
  return { machine: "x86_64", libc: "musl", needed };
}

export function verifyMuslElf(binary) {
  const result = spawnSync("readelf", ["--wide", "--file-header", "--program-headers", "--dynamic", "--version-info", binary], {
    encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, windowsHide: true,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `readelf failed: ${result.stderr}`);
  assert.equal(result.stderr.trim(), "", `invalid ELF metadata: ${result.stderr}`);
  return validateMuslElf(result.stdout);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv[2], "requires a musl .node binary path");
  console.log(JSON.stringify(verifyMuslElf(resolve(process.argv[2]))));
}
