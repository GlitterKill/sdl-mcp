#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const contractRoot = join(repoRoot, "ladybug-openssl");
const packageRoot = join(contractRoot, "npm", "win32-x64");
const binRoot = join(packageRoot, "bin");
const buildRecordPath = join(contractRoot, "build-record.json");
const source = readJson(join(contractRoot, "source.json"));
const fts = readJson(join(contractRoot, "ladybug-fts-0.18.1.json"));
const packageJson = readJson(join(packageRoot, "package.json"));
const require = createRequire(import.meta.url);

const expectedDlls = ["bin/libcrypto-3-x64.dll", "bin/libssl-3-x64.dll"];
const expectedDllNames = new Set(expectedDlls.map((dll) => basename(dll).toLowerCase()));
const allowedPackageFiles = new Set([...packageJson.files, "package.json"]);
const debugRuntimeDlls = [/^ucrtbased\.dll$/iu, /^vcruntime\d+d\.dll$/iu, /^msvcp\d+d\.dll$/iu, /^msvcr\d+d\.dll$/iu];
const debugArtifactNames = [/\.pdb$/iu, /\.ilk$/iu, /\.idb$/iu, /\.exp$/iu, /\.lib$/iu];

// The allowlist is intentionally narrow: OpenSSL may depend on Windows, UCRT,
// and MSVC runtime DLLs, but the staged runtime must not pull arbitrary third
// party libraries into the Ladybug extension load boundary.
const allowedImportDlls = new Set(
  [
    "advapi32.dll",
    "bcrypt.dll",
    "crypt32.dll",
    "kernel32.dll",
    "ncrypt.dll",
    "sechost.dll",
    "user32.dll",
    "ws2_32.dll",
    "vcruntime140.dll",
    "vcruntime140_1.dll",
    "msvcp140.dll",
    "concrt140.dll",
    "ucrtbase.dll",
    "api-ms-win-crt-conio-l1-1-0.dll",
    "api-ms-win-crt-convert-l1-1-0.dll",
    "api-ms-win-crt-environment-l1-1-0.dll",
    "api-ms-win-crt-filesystem-l1-1-0.dll",
    "api-ms-win-crt-heap-l1-1-0.dll",
    "api-ms-win-crt-locale-l1-1-0.dll",
    "api-ms-win-crt-math-l1-1-0.dll",
    "api-ms-win-crt-multibyte-l1-1-0.dll",
    "api-ms-win-crt-private-l1-1-0.dll",
    "api-ms-win-crt-process-l1-1-0.dll",
    "api-ms-win-crt-runtime-l1-1-0.dll",
    "api-ms-win-crt-stdio-l1-1-0.dll",
    "api-ms-win-crt-string-l1-1-0.dll",
    "api-ms-win-crt-time-l1-1-0.dll",
    "api-ms-win-crt-utility-l1-1-0.dll",
    "api-ms-win-core-console-l1-1-0.dll",
    "api-ms-win-core-datetime-l1-1-0.dll",
    "api-ms-win-core-debug-l1-1-0.dll",
    "api-ms-win-core-errorhandling-l1-1-0.dll",
    "api-ms-win-core-fibers-l1-1-0.dll",
    "api-ms-win-core-file-l1-1-0.dll",
    "api-ms-win-core-file-l1-2-0.dll",
    "api-ms-win-core-handle-l1-1-0.dll",
    "api-ms-win-core-heap-l1-1-0.dll",
    "api-ms-win-core-interlocked-l1-1-0.dll",
    "api-ms-win-core-libraryloader-l1-1-0.dll",
    "api-ms-win-core-localization-l1-2-0.dll",
    "api-ms-win-core-memory-l1-1-0.dll",
    "api-ms-win-core-namedpipe-l1-1-0.dll",
    "api-ms-win-core-processenvironment-l1-1-0.dll",
    "api-ms-win-core-processthreads-l1-1-0.dll",
    "api-ms-win-core-profile-l1-1-0.dll",
    "api-ms-win-core-rtlsupport-l1-1-0.dll",
    "api-ms-win-core-string-l1-1-0.dll",
    "api-ms-win-core-synch-l1-1-0.dll",
    "api-ms-win-core-synch-l1-2-0.dll",
    "api-ms-win-core-sysinfo-l1-1-0.dll",
    "api-ms-win-core-timezone-l1-1-0.dll",
    "api-ms-win-core-util-l1-1-0.dll",
  ].map((dll) => dll.toLowerCase()),
);

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/u, ""));
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function packageRelative(filePath) {
  return relative(packageRoot, filePath).replaceAll("\\", "/");
}

function assertExists(filePath, label = filePath) {
  assert.ok(existsSync(filePath), label + " does not exist");
}

function sorted(value) {
  if (Array.isArray(value)) return value.map((item) => sorted(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted(value[key])]),
    );
  }
  return value;
}

function writeCanonicalJson(filePath, value) {
  writeFileSync(filePath, JSON.stringify(sorted(value), null, 2) + "\n", "utf8");
}

function listFiles(root) {
  const out = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        out.push(fullPath);
      }
    }
  }
  walk(root);
  return out;
}

function readCString(buffer, offset) {
  let end = offset;
  while (end < buffer.length && buffer[end] !== 0) end += 1;
  return buffer.toString("utf8", offset, end);
}

function assertRange(buffer, offset, size, label) {
  assert.ok(offset >= 0 && offset + size <= buffer.length, label + " is outside the PE buffer");
}

function parsePe(filePath) {
  const buffer = readFileSync(filePath);
  assertRange(buffer, 0, 0x40, filePath);
  assert.equal(buffer.readUInt16LE(0), 0x5a4d, filePath + " must have an MZ header");
  const peOffset = buffer.readUInt32LE(0x3c);
  assertRange(buffer, peOffset, 24, filePath + " PE header");
  assert.equal(buffer.toString("ascii", peOffset, peOffset + 4), "PE\u0000\u0000", filePath + " must have a PE signature");

  const machine = buffer.readUInt16LE(peOffset + 4);
  const numberOfSections = buffer.readUInt16LE(peOffset + 6);
  const characteristics = buffer.readUInt16LE(peOffset + 22);
  const optionalHeaderSize = buffer.readUInt16LE(peOffset + 20);
  const optionalOffset = peOffset + 24;
  assertRange(buffer, optionalOffset, optionalHeaderSize, filePath + " optional header");
  const optionalMagic = buffer.readUInt16LE(optionalOffset);
  const isPe32Plus = optionalMagic === 0x20b;
  assert.ok(isPe32Plus || optionalMagic === 0x10b, filePath + " must be PE32 or PE32+");
  const sizeOfHeaders = buffer.readUInt32LE(optionalOffset + 60);
  const dataDirectoryOffset = optionalOffset + (isPe32Plus ? 112 : 96);

  function dataDirectory(index) {
    const offset = dataDirectoryOffset + index * 8;
    assertRange(buffer, offset, 8, filePath + " data directory " + index);
    return { rva: buffer.readUInt32LE(offset), size: buffer.readUInt32LE(offset + 4) };
  }

  const sectionOffset = optionalOffset + optionalHeaderSize;
  const sections = [];
  for (let index = 0; index < numberOfSections; index += 1) {
    const offset = sectionOffset + index * 40;
    assertRange(buffer, offset, 40, filePath + " section " + index);
    sections.push({
      name: readCString(buffer, offset).replaceAll("\u0000", ""),
      virtualSize: buffer.readUInt32LE(offset + 8),
      virtualAddress: buffer.readUInt32LE(offset + 12),
      sizeOfRawData: buffer.readUInt32LE(offset + 16),
      pointerToRawData: buffer.readUInt32LE(offset + 20),
    });
  }

  function rvaToOffset(rva, label) {
    if (rva === 0) return 0;
    if (rva < sizeOfHeaders) return rva;
    const section = sections.find((candidate) => {
      const span = Math.max(candidate.virtualSize, candidate.sizeOfRawData);
      return rva >= candidate.virtualAddress && rva < candidate.virtualAddress + span;
    });
    assert.ok(section, filePath + " cannot map RVA 0x" + rva.toString(16) + " for " + label);
    const offset = section.pointerToRawData + (rva - section.virtualAddress);
    assertRange(buffer, offset, 1, label);
    return offset;
  }

  function parseImports() {
    const imports = [];
    const importDirectory = dataDirectory(1);
    if (importDirectory.rva === 0 || importDirectory.size === 0) return imports;
    let descriptorOffset = rvaToOffset(importDirectory.rva, "import directory");
    while (true) {
      assertRange(buffer, descriptorOffset, 20, filePath + " import descriptor");
      const originalFirstThunk = buffer.readUInt32LE(descriptorOffset);
      const timeDateStamp = buffer.readUInt32LE(descriptorOffset + 4);
      const forwarderChain = buffer.readUInt32LE(descriptorOffset + 8);
      const nameRva = buffer.readUInt32LE(descriptorOffset + 12);
      const firstThunk = buffer.readUInt32LE(descriptorOffset + 16);
      if (originalFirstThunk === 0 && timeDateStamp === 0 && forwarderChain === 0 && nameRva === 0 && firstThunk === 0) break;

      const dll = readCString(buffer, rvaToOffset(nameRva, "import DLL name"));
      const symbols = [];
      const ordinals = [];
      let thunkOffset = rvaToOffset(originalFirstThunk || firstThunk, "import thunk for " + dll);
      while (true) {
        assertRange(buffer, thunkOffset, isPe32Plus ? 8 : 4, filePath + " import thunk");
        if (isPe32Plus) {
          const thunk = buffer.readBigUInt64LE(thunkOffset);
          if (thunk === 0n) break;
          if ((thunk & 0x8000000000000000n) !== 0n) {
            ordinals.push(Number(thunk & 0xffffn));
          } else {
            const nameOffset = rvaToOffset(Number(thunk), "import symbol for " + dll);
            symbols.push(readCString(buffer, nameOffset + 2));
          }
          thunkOffset += 8;
        } else {
          const thunk = buffer.readUInt32LE(thunkOffset);
          if (thunk === 0) break;
          if ((thunk & 0x80000000) !== 0) {
            ordinals.push(thunk & 0xffff);
          } else {
            const nameOffset = rvaToOffset(thunk, "import symbol for " + dll);
            symbols.push(readCString(buffer, nameOffset + 2));
          }
          thunkOffset += 4;
        }
      }
      imports.push({ dll, symbols: [...new Set(symbols)].sort(), ordinals: [...new Set(ordinals)].sort((a, b) => a - b) });
      descriptorOffset += 20;
    }
    return imports.sort((a, b) => a.dll.localeCompare(b.dll));
  }

  function parseExports() {
    const exports = [];
    const exportDirectory = dataDirectory(0);
    if (exportDirectory.rva === 0 || exportDirectory.size === 0) return exports;
    const exportOffset = rvaToOffset(exportDirectory.rva, "export directory");
    assertRange(buffer, exportOffset, 40, filePath + " export directory");
    const numberOfNames = buffer.readUInt32LE(exportOffset + 24);
    const namesRva = buffer.readUInt32LE(exportOffset + 32);
    const namesOffset = rvaToOffset(namesRva, "export names");
    for (let index = 0; index < numberOfNames; index += 1) {
      const nameRva = buffer.readUInt32LE(namesOffset + index * 4);
      exports.push(readCString(buffer, rvaToOffset(nameRva, "export name")));
    }
    return [...new Set(exports)].sort();
  }

  return {
    characteristics,
    debugDirectorySize: dataDirectory(6).size,
    exports: parseExports(),
    format: optionalMagic === 0x20b ? "PE32+" : "PE32",
    imports: parseImports(),
    machine,
    machineName: machine === 0x8664 ? "x86-64" : "0x" + machine.toString(16),
    optionalMagic,
    sections: sections.map((section) => section.name),
  };
}

function assertNoDebugBuild(relativeDll, pe) {
  assert.ok(!pe.imports.some((entry) => debugRuntimeDlls.some((pattern) => pattern.test(entry.dll))), relativeDll + " imports a debug runtime");
  assert.ok(!pe.sections.some((section) => section.toLowerCase() === ".debug"), relativeDll + " contains a .debug section");
}

function assertAllowedImports(relativeDll, pe) {
  const unexpected = pe.imports
    .map((entry) => entry.dll.toLowerCase())
    .filter((dll) => !allowedImportDlls.has(dll) && !expectedDllNames.has(dll))
    .sort();
  assert.deepEqual(unexpected, [], relativeDll + " imports non-allowlisted DLLs");
}

function extractVersion(...values) {
  for (const value of values) {
    const text = String(value ?? "");
    const match = /\b(\d+\.\d+(?:\.\d+)?(?:\.\d+)?)\b/u.exec(text);
    if (match) return match[1];
  }
  return undefined;
}

function packageVersion(name) {
  try {
    // Package exports can intentionally hide package.json, so resolve the
    // package entrypoint and walk back to the nearest package manifest.
    let current = dirname(require.resolve(name));
    while (current !== dirname(current)) {
      const packagePath = join(current, "package.json");
      if (existsSync(packagePath)) return readJson(packagePath).version;
      current = dirname(current);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function downloadFts(tempRoot) {
  const response = await fetch(fts.artifactUrl);
  assert.ok(response.ok, "failed to download FTS extension: " + response.status + " " + response.statusText);
  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(sha256Buffer(body), fts.artifactSha256, "FTS artifact hash mismatch");
  assert.equal(body.length, fts.artifactSize, "FTS artifact size mismatch");
  const filePath = join(tempRoot, "libfts.lbug_extension");
  writeFileSync(filePath, body);
  return filePath;
}

function assertPackageAllowlist() {
  const actual = listFiles(packageRoot).map(packageRelative).sort();
  const unexpected = actual.filter((file) => !allowedPackageFiles.has(file));
  const missing = [...allowedPackageFiles].filter((file) => !actual.includes(file));
  assert.deepEqual(unexpected, [], "package contains files outside package.json files allowlist plus implicit package.json");
  assert.deepEqual(missing, [], "package is missing allowlisted files");

  const stagedDlls = readdirSync(binRoot)
    .filter((name) => !name.startsWith("."))
    .sort();
  assert.deepEqual(stagedDlls, expectedDlls.map((dll) => basename(dll)).sort(), "bin directory must contain exactly the two OpenSSL runtime DLLs");
  for (const file of actual) {
    assert.ok(!debugArtifactNames.some((pattern) => pattern.test(file)), "debug/build artifact is not allowed in package: " + file);
  }
}

function verifyBuildRecord() {
  assertExists(buildRecordPath, "ladybug-openssl/build-record.json");
  const record = readJson(buildRecordPath);
  assert.equal(record.sourceSha256, source.sourceSha256, "build record source hash must match source.json");
  assert.equal(record.signatureVerified, true, "build record must prove detached signature verification");
  assert.match(String(record.configureCommand ?? ""), /perl Configure VC-WIN64A/u);
  assert.match(String(record.buildCommand ?? ""), /nmake/u);
  assert.ok(extractVersion(record.nasm), "build record must include NASM version");
  assert.ok(extractVersion(record.perl), "build record must include Perl version");
  assert.ok(extractVersion(record.link, record.msvcToolsetVersion), "build record must include linker/MSVC version");
  assert.ok(String(record.windowsSdkVersion ?? "").length > 0, "build record must include Windows SDK version");
  assert.ok(String(record.opensslVersion ?? "").includes(source.opensslVersion), "build record must include built OpenSSL version");
  return record;
}

function verifyDlls() {
  const artifacts = {};
  const exportsByDll = new Map();
  for (const relativeDll of expectedDlls) {
    const filePath = join(packageRoot, relativeDll);
    assertExists(filePath, relativeDll);
    const pe = parsePe(filePath);
    assert.equal(pe.machine, 0x8664, relativeDll + " must be x86-64");
    assert.equal(pe.optionalMagic, 0x20b, relativeDll + " must be PE32+");
    assertNoDebugBuild(relativeDll, pe);
    assertAllowedImports(relativeDll, pe);
    exportsByDll.set(basename(relativeDll).toLowerCase(), new Set(pe.exports));
    artifacts[relativeDll] = {
      imports: pe.imports.map((entry) => entry.dll).sort(),
      pe: { format: pe.format, machine: pe.machineName },
      sha256: sha256(filePath),
    };
  }
  return { artifacts, exportsByDll };
}

function verifyFtsImports(ftsPath, exportsByDll) {
  const pe = parsePe(ftsPath);
  const importsByDll = new Map(pe.imports.map((entry) => [entry.dll.toLowerCase(), entry]));
  for (const dll of expectedDllNames) {
    assert.ok(importsByDll.has(dll), "official FTS extension must import " + dll);
    const entry = importsByDll.get(dll);
    assert.deepEqual(entry.ordinals, [], "cannot verify ordinal imports for " + dll);
    const stagedExports = exportsByDll.get(dll);
    const missing = entry.symbols.filter((symbol) => !stagedExports.has(symbol));
    assert.deepEqual(missing, [], "official FTS imports missing from staged " + dll);
  }
  return Object.fromEntries(
    [...importsByDll.entries()]
      .filter(([dll]) => expectedDllNames.has(dll))
      .map(([dll, entry]) => [dll, entry.symbols]),
  );
}

function writeSpdxSbom(provenance) {
  const files = [...allowedPackageFiles]
    .filter((file) => file !== "sbom.spdx.json")
    .sort();
  const documentHash = createHash("sha256")
    .update(packageJson.name + "@" + packageJson.version + ":" + source.sourceSha256)
    .digest("hex");
  const lines = [
    "SPDXVersion: SPDX-2.3",
    "DataLicense: CC0-1.0",
    "SPDXID: SPDXRef-DOCUMENT",
    "DocumentName: " + packageJson.name + "-" + packageJson.version,
    "DocumentNamespace: https://sdl-mcp.local/spdx/" + encodeURIComponent(packageJson.name) + "/" + packageJson.version + "/" + documentHash,
    "Creator: Tool: sdl-mcp-ladybug-openssl-verify",
    "PackageName: " + packageJson.name,
    "SPDXID: SPDXRef-Package-ladybug-openssl-win32-x64",
    "PackageVersion: " + packageJson.version,
    "PackageDownloadLocation: NOASSERTION",
    "FilesAnalyzed: true",
    "PackageLicenseConcluded: Apache-2.0 AND OpenSSL",
    "PackageLicenseDeclared: Apache-2.0 AND OpenSSL",
    "PackageCopyrightText: NOASSERTION",
  ];

  for (const file of files) {
    const filePath = join(packageRoot, file);
    assertExists(filePath, file);
    lines.push("FileName: ./" + file);
    lines.push("SPDXID: SPDXRef-File-" + file.replace(/[^A-Za-z0-9.-]+/gu, "-"));
    lines.push("FileChecksum: SHA256: " + sha256(filePath));
    lines.push("LicenseConcluded: NOASSERTION");
  }

  lines.push("ExternalRef: SECURITY cpe23Type cpe:2.3:a:openssl:openssl:" + provenance.opensslVersion + ":*:*:*:*:*:*:*");
  writeFileSync(join(packageRoot, "sbom.spdx.json"), lines.join("\n") + "\n", "utf8");
}

function runCleanLadybugChild() {
  if (process.platform !== "win32") {
    throw new Error("clean-environment Ladybug FTS verification must run on Windows");
  }
  assert.equal(packageVersion("kuzu"), "0.18.1", "clean-env proof requires kuzu@npm:@ladybugdb/core@0.18.1");

  const tempHome = mkdtempSync(join(tmpdir(), "sdl-ladybug-clean-home-"));
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const childCode = [
    "import assert from 'node:assert/strict';",
    "import { join } from 'node:path';",
    "const kuzu = await import('kuzu');",
    "async function execute(conn, query, rows = false) {",
    "  const result = await conn.query(query);",
    "  const results = Array.isArray(result) ? result : [result];",
    "  try { return rows ? await results[0].getAll() : undefined; }",
    "  finally { for (const item of results) item.close(); }",
    "}",
    "assert.equal(process.env.USERPROFILE, process.env.HOME);",
    "const db = new kuzu.Database(join(process.env.USERPROFILE, 'runtime-proof.lbug'));",
    "const conn = new kuzu.Connection(db);",
    "try {",
    "  await execute(conn, 'INSTALL fts');",
    "  await execute(conn, 'LOAD fts');",
    "  await execute(conn, 'CREATE NODE TABLE A(id INT64, name STRING, PRIMARY KEY(id))');",
    "  await execute(conn, \"CALL CREATE_FTS_INDEX('A', 'a_idx', ['name'], stemmer := 'none')\");",
    "  for (let index = 0; index < 5; index += 1) {",
    "    await execute(conn, \"CREATE (:A {id: \" + index + \", name: 'before_\" + index + \"'})\");",
    "    await execute(conn, \"MATCH (a:A) WHERE a.id = \" + index + \" SET a.name = 'after_\" + index + \"'\");",
    "    const rows = await execute(conn, 'MATCH (a:A) WHERE a.id = ' + index + ' RETURN a.name AS name', true);",
    "    assert.equal(rows[0]?.name, 'after_' + index);",
    "    await execute(conn, 'MATCH (a:A) WHERE a.id = ' + index + ' DELETE a');",
    "  }",
    "  console.log(JSON.stringify({ mode: 'clean-env-ladybug-fts', iterations: 5 }));",
    "} finally {",
    "  await conn.close();",
    "  await db.close();",
    "}",
  ].join("\n");

  try {
    const env = {
      ComSpec: join(systemRoot, "System32", "cmd.exe"),
      HOME: tempHome,
      PATH: [binRoot, join(systemRoot, "System32")].join(delimiter),
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      SystemRoot: systemRoot,
      TEMP: tempHome,
      TMP: tempHome,
      USERPROFILE: tempHome,
    };
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
      cwd: repoRoot,
      encoding: "utf8",
      env,
      timeout: 60000,
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
}

function runPackageContractTest() {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--test", "tests/integration/ladybug-openssl-package-contract.test.ts"],
    { cwd: repoRoot, encoding: "utf8", timeout: 120000, windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
}

async function main() {
  assert.equal(packageJson.name, "@sdl-mcp/ladybug-openssl-win32-x64");
  assert.equal(packageJson.version, source.packageVersion);
  for (const relativeDll of expectedDlls) assertExists(join(packageRoot, relativeDll), relativeDll);

  const buildRecord = verifyBuildRecord();
  const { artifacts, exportsByDll } = verifyDlls();
  const tempRoot = mkdtempSync(join(tmpdir(), "sdl-ladybug-fts-"));
  let ftsImports;
  try {
    const ftsPath = await downloadFts(tempRoot);
    ftsImports = verifyFtsImports(ftsPath, exportsByDll);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }

  const msvcVersion = extractVersion(buildRecord.msvcToolsetVersion, buildRecord.link);
  const provenance = {
    artifacts,
    build: {
      buildCommand: buildRecord.buildCommand,
      configureCommand: buildRecord.configureCommand,
      configureTarget: source.configureTarget,
      linkerVersion: buildRecord.link,
      msvcToolchainVersion: msvcVersion,
      nasmVersion: buildRecord.nasm,
      opensslVersion: buildRecord.opensslVersion,
      perlVersion: buildRecord.perl,
      windowsSdkVersion: buildRecord.windowsSdkVersion,
    },
    fts: {
      artifactUrl: fts.artifactUrl,
      imports: ftsImports,
      sha256: fts.sha256,
      size: fts.size,
      version: fts.ladybugVersion,
    },
    opensslVersion: source.opensslVersion,
    packageName: packageJson.name,
    packageVersion: source.packageVersion,
    source: {
      releaseSignerFingerprint: source.releaseSignerFingerprint,
      sha256: source.sourceSha256,
      signatureUrl: source.signatureUrl,
      signatureVerified: buildRecord.signatureVerified,
      sourceUrl: source.sourceUrl,
    },
  };

  writeCanonicalJson(join(packageRoot, "provenance.json"), provenance);
  writeSpdxSbom(provenance);
  assertPackageAllowlist();
  runCleanLadybugChild();
  runPackageContractTest();
  console.log("Verified staged OpenSSL runtime package for Ladybug FTS");
}

await main();
