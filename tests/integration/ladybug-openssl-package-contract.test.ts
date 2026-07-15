import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { it } from "node:test";

const repoRoot = resolve(".");
const contractRoot = join(repoRoot, "ladybug-openssl");
const packageRoot = join(contractRoot, "npm", "win32-x64");
const source = JSON.parse(readFileSync(join(contractRoot, "source.json"), "utf8"));
const fts = JSON.parse(
  readFileSync(join(contractRoot, "ladybug-fts-0.18.1.json"), "utf8"),
);
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const provenancePath = join(packageRoot, "provenance.json");
const allowedFiles = new Set(packageJson.files);
const expectedDlls = ["bin/libcrypto-3-x64.dll", "bin/libssl-3-x64.dll"];
const expectedLicenseSha256 = "7d5450cb2d142651b8afa315b5f238efc805dad827d91ba367d8516bc9d49e7a";

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function listFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const child of listFiles(path)) files.push(child);
    } else {
      files.push(path);
    }
  }
  return files;
}

function packageRelative(filePath: string): string {
  return relative(packageRoot, filePath).replaceAll("\\", "/");
}

function readPe(filePath: string): { machine: number; optionalMagic: number } {
  const buffer = readFileSync(filePath);
  assert.equal(buffer.toString("ascii", 0, 2), "MZ", filePath + " is not a PE file");
  const peOffset = buffer.readUInt32LE(0x3c);
  assert.equal(buffer.toString("ascii", peOffset, peOffset + 4), "PE\0\0");
  return {
    machine: buffer.readUInt16LE(peOffset + 4),
    optionalMagic: buffer.readUInt16LE(peOffset + 24),
  };
}

it("defines the pinned OpenSSL and Ladybug FTS source artifacts", () => {
  assert.deepEqual(source, {
    opensslVersion: "3.5.7",
    packageVersion: "3.5.7-sdl.1",
    sourceUrl:
      "https://github.com/openssl/openssl/releases/download/openssl-3.5.7/openssl-3.5.7.tar.gz",
    signatureUrl:
      "https://github.com/openssl/openssl/releases/download/openssl-3.5.7/openssl-3.5.7.tar.gz.asc",
    sourceSha256:
      "a8c0d28a529ca480f9f36cf5792e2cd21984552a3c8e4aa11a24aa31aeac98e8",
    releaseSignerFingerprint: "B146647E45A7B33947AB226B2A2C87D161692D40",
    configureTarget: "VC-WIN64A",
  });
  assert.deepEqual(fts, {
    ladybugVersion: "0.18.1",
    extension: "fts",
    platform: "win_amd64",
    artifactUrl:
      "https://extension.ladybugdb.com/v0.18.1/win_amd64/fts/libfts.lbug_extension",
    artifactSha256:
      "ee7a2f506f5c9ac45ead24a25760fe3361e19aeca0505a9356a91c906e75434c",
    artifactSize: 14577664,
    installedPath: ".lbdb/extension/0.18.1/win_amd64/fts/libfts.lbug_extension",
    requiredImports: ["libcrypto-3-x64.dll", "libssl-3-x64.dll"],
  });
  const releaseKey = readFileSync(
    join(contractRoot, "keys", "openssl-release.asc"),
    "utf8",
  );
  assert.match(releaseKey, /BEGIN PGP PUBLIC KEY BLOCK/u);
});

it("defines the data-only Windows x64 npm package contract", () => {
  assert.equal(packageJson.name, "@sdl-mcp/ladybug-openssl-win32-x64");
  assert.equal(packageJson.version, source.packageVersion);
  assert.equal(packageJson.description, "SDL-MCP temporary OpenSSL runtime for LadybugDB FTS on Windows x64");
  assert.equal(packageJson.license, "Apache-2.0");
  assert.deepEqual(packageJson.repository, {
    type: "git",
    url: "https://github.com/GlitterKill/sdl-mcp",
  });
  assert.deepEqual(packageJson.os, ["win32"]);
  assert.deepEqual(packageJson.cpu, ["x64"]);
  assert.deepEqual(packageJson.files, [
    "bin/libcrypto-3-x64.dll",
    "bin/libssl-3-x64.dll",
    "OPENSSL-LICENSE.txt",
    "README.md",
    "provenance.json",
    "sbom.spdx.json",
  ]);
  assert.deepEqual(packageJson.exports, {
    "./package.json": "./package.json",
    "./provenance.json": "./provenance.json",
  });
  assert.deepEqual(packageJson.publishConfig, { access: "public", provenance: true });
  assert.equal(packageJson.main, undefined);
  assert.equal(packageJson.module, undefined);
  assert.equal(packageJson.bin, undefined);
});

it("stages only the reviewed runtime files", () => {
  const disallowed = listFiles(packageRoot)
    .map(packageRelative)
    .filter((file) => {
      if (allowedFiles.has(file)) return false;
      if (/^bin\/lib(?:crypto|ssl)-3-x64\.dll$/u.test(file)) return false;
      return /(?:\.dll|\.exe|\.pdb|\.h|\.hpp|\.lib|\.a|openssl\.cnf)$/iu.test(file);
    });
  assert.deepEqual(disallowed, []);
  for (const dll of expectedDlls) {
    assert.ok(existsSync(join(packageRoot, dll)), dll + " is missing from staged package");
  }
  assert.ok(existsSync(join(packageRoot, "sbom.spdx.json")), "sbom.spdx.json is missing");
});

it("tracks the official Apache-2.0 license text", () => {
  assert.equal(sha256(join(packageRoot, "OPENSSL-LICENSE.txt")), expectedLicenseSha256);
});

it("records generated provenance for source, build, DLL hashes, and PE architecture", () => {
  assert.ok(existsSync(provenancePath), "provenance.json is missing");
  const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
  assert.equal(provenance.packageName, packageJson.name);
  assert.equal(provenance.packageVersion, source.packageVersion);
  assert.equal(provenance.opensslVersion, source.opensslVersion);
  assert.equal(provenance.source.sha256, source.sourceSha256);
  assert.equal(provenance.source.releaseSignerFingerprint, source.releaseSignerFingerprint);
  assert.equal(provenance.build.configureTarget, source.configureTarget);
  assert.equal(
    typeof provenance.build.msvcToolchainVersion,
    "string",
    "MSVC toolchain version must be generated",
  );
  assert.match(provenance.build.msvcToolchainVersion, /^\d+\.\d+/u);
  assert.equal(
    typeof provenance.build.configureCommand,
    "string",
    "OpenSSL configure command must be generated",
  );
  assert.match(provenance.build.configureCommand, /perl Configure VC-WIN64A/u);
  assert.equal(
    typeof provenance.build.buildCommand,
    "string",
    "OpenSSL build command must be generated",
  );
  assert.match(provenance.build.buildCommand, /nmake/u);
  for (const dll of expectedDlls) {
    const filePath = join(packageRoot, dll);
    const pe = readPe(filePath);
    assert.equal(pe.machine, 0x8664, dll + " must be x86-64");
    assert.equal(pe.optionalMagic, 0x20b, dll + " must be PE32+");
    assert.equal(provenance.artifacts[dll].sha256, sha256(filePath));
    assert.deepEqual(provenance.artifacts[dll].pe, {
      format: "PE32+",
      machine: "x86-64",
    });
  }
});

it("npm pack dry-run contains only the allowlisted files", () => {
  const npmArgs = ["pack", "--dry-run", "--json"];
  const fallbackNpmExecPath = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const npmExecPath = process.env.npm_execpath && existsSync(process.env.npm_execpath)
    ? process.env.npm_execpath
    : existsSync(fallbackNpmExecPath)
      ? fallbackNpmExecPath
      : undefined;
  const result = npmExecPath
    ? spawnSync(process.execPath, [npmExecPath, ...npmArgs], { cwd: packageRoot, encoding: "utf8" })
    : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", npmArgs, { cwd: packageRoot, encoding: "utf8" });

  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const packed = JSON.parse(result.stdout)[0].files.map((file: { path: string }) => file.path).sort();
  assert.deepEqual(packed, [...allowedFiles, "package.json"].sort());
});
