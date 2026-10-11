import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const workflowPath = ".github/workflows/publish-native.yml";
const workflow = readFileSync(workflowPath, "utf8");
const qualifierScript = readFileSync("scripts/qualify-native-package.mjs", "utf8");

function jobSection(name: string): string {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start < 0) return "";
  let end = lines.findIndex(
    (line, index) => index > start && /^  [a-z0-9-]+:$/.test(line),
  );
  if (end < 0) end = lines.length;
  return lines.slice(start, end).join("\n");
}

function jobNeeds(job: string): string {
  return job.match(/^    needs:([\s\S]*?)(?=^    [a-z][\w-]*:)/m)?.[1] ?? "";
}

const expectedTargets = [
  { target: "x86_64-pc-windows-msvc", runner: "windows-latest", platform: "win32-x64-msvc" },
  { target: "x86_64-apple-darwin", runner: "macos-15-intel", platform: "darwin-x64" },
  { target: "aarch64-apple-darwin", runner: "macos-15", platform: "darwin-arm64" },
  { target: "x86_64-unknown-linux-gnu", runner: "ubuntu-24.04", platform: "linux-x64-gnu" },
  { target: "x86_64-unknown-linux-musl", runner: "ubuntu-24.04", platform: "linux-x64-musl" },
  { target: "aarch64-unknown-linux-gnu", runner: "ubuntu-24.04-arm", platform: "linux-arm64-gnu" },
];

describe("native platform qualification workflow", () => {
  it("validates and normalizes both npm dry-run formats without relaxing package identity", () => {
    const step = workflow.split("- name: Validate exact qualified tarballs")[1].split("- name:")[0];
    const script = step.match(/PACKAGE_NAME="\$package" node --input-type=module -e '([\s\S]*?)'/)?.[1];
    assert.ok(script);
    const dir = mkdtempSync(join(tmpdir(), "sdl-native-dry-run-"));
    const name = "sdl-mcp-native", version = "0.13.8";
    const bytes = Buffer.from("qualified tarball fixture");
    const info = { name, version, integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64") };
    try {
      mkdirSync(join(dir, "native/release-pack"), { recursive: true });
      writeFileSync(join(dir, `native/release-pack/${name}-${version}.tgz`), bytes);
      const metadataPath = join(dir, `native/release-pack/${name}.json`);
      for (const keyed of [false, true]) {
        for (const change of [{}, { name: "other" }, { version: "0.0.0" }, { integrity: "sha512-wrong" }]) {
          const metadata = { ...info, ...change };
          writeFileSync(metadataPath, JSON.stringify(keyed ? { [name]: metadata } : metadata));
          const child = spawnSync(process.execPath, ["--input-type=module"], {
            input: script, cwd: dir, encoding: "utf8",
            env: { ...process.env, PACKAGE_NAME: name, NATIVE_VERSION: version },
          });
          if (Object.keys(change).length === 0) {
            assert.equal(child.status, 0, child.stderr);
            assert.deepEqual(JSON.parse(readFileSync(metadataPath, "utf8")), info);
          } else {
            assert.notEqual(child.status, 0, "mismatched package metadata must fail");
          }
        }
      }
      writeFileSync(metadataPath, JSON.stringify({ [name]: info, unexpected: info }));
      const ambiguous = spawnSync(process.execPath, ["--input-type=module"], {
        input: script, cwd: dir, encoding: "utf8",
        env: { ...process.env, PACKAGE_NAME: name, NATIVE_VERSION: version },
      });
      assert.notEqual(ambiguous.status, 0, "multiple package results must fail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("builds each supported target on its matching runner", () => {
    const buildJob = jobSection("build");
    assert.ok(buildJob, "build job should exist");

    for (const { target, runner } of expectedTargets) {
      assert.match(
        buildJob,
        new RegExp(`- target: ${target}\\s+os: ${runner}`),
        `${target} should build on ${runner}`,
      );
    }

    const muslBuild = buildJob.match(/- name: Build musl addon with Alpine toolchain([\s\S]*?)(?=\n      - name:|$)/)?.[1] ?? "";
    assert.match(muslBuild, /docker run --rm[\s\S]*--volume "\$GITHUB_WORKSPACE:\/workspace"[\s\S]*rust:alpine/);
    assert.match(muslBuild, /CARGO_TARGET_DIR=\/workspace\/native\/target\/alpine-musl/);
    assert.match(muslBuild, /CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=cc/);
    assert.match(muslBuild, /npx --no-install napi build[\s\S]*--target x86_64-unknown-linux-musl/);

    const elfCheck = muslBuild.indexOf("node scripts/verify-musl-elf.mjs native/sdl-mcp-native.node");
    const artifactUpload = buildJob.indexOf("- name: Upload artifact");
    assert.ok(elfCheck >= 0, "Alpine musl build should inspect the linked ELF metadata");
    assert.ok(artifactUpload > elfCheck, "ELF checks must pass before uploading the native binary");
  });

  it("qualifies all six packed targets before publish", () => {
    const qualifyJob = jobSection("qualify");
    const publishJob = jobSection("publish");
    assert.ok(qualifyJob, "qualify job should exist");
    const qualifyNeeds = jobNeeds(qualifyJob);
    assert.match(qualifyNeeds, /\bbuild\b/);
    assert.match(qualifyJob, /runs-on:\s*\$\{\{\s*matrix\.os\s*\}\}/);
    assert.match(qualifyJob, /actions\/download-artifact@/);
    assert.match(qualifyJob, /name:\s*bindings-\$\{\{\s*matrix\.target\s*\}\}/);
    assert.match(
      qualifyJob,
      /path:\s*\$\{\{\s*runner\.temp\s*\}\}\/bindings\/\$\{\{\s*matrix\.target\s*\}\}/,
      "each matrix job should download only its own binding into a fresh runner-temp directory",
    );

    const matrix = qualifyJob.match(/matrix:\s*\n\s+include:\s*\n([\s\S]*?)\n\s+steps:/)?.[1] ?? "";
    assert.equal(
      (matrix.match(/^\s+- target:/gm) ?? []).length,
      expectedTargets.length,
      "qualification matrix should contain exactly the six supported targets",
    );
    for (const { target, runner, platform } of expectedTargets) {
      assert.match(
        matrix,
        new RegExp(`- target: ${target}\\s+os: ${runner}\\s+platform: ${platform}`),
        `${target} should qualify on ${runner} as ${platform}`,
      );
    }

    assert.match(qualifyJob, /exactly one \.node/);
    assert.match(qualifyJob, /scripts\/qualify-native-package\.mjs/);
    assert.match(qualifyJob, /node:24-alpine/);
    const muslQualification = qualifyJob.match(/- name: Qualify musl package in Alpine([\s\S]*?)(?=\n      - name:|$)/)?.[1] ?? "";
    const alpinePackages = muslQualification.match(/apk add --no-cache([^'\n]*)/)?.[1] ?? "";
    assert.match(alpinePackages, /\blibstdc\+\+/);
    assert.match(alpinePackages, /\bbinutils\b/);
    assert.match(qualifyJob, /docker run[\s\S]*GITHUB_WORKSPACE[\s\S]*RUNNER_TEMP/);
    assert.match(muslQualification, /node scripts\/qualify-native-package\.mjs/);
    assert.match(
      qualifyJob,
      /name:\s*native-qualified-\$\{\{\s*github\.sha\s*\}\}-\$\{\{\s*matrix\.target\s*\}\}/,
      "qualification evidence should be uniquely named by commit and target",
    );
    assert.match(
      qualifyJob,
      /path:\s*\|\s*\n\s+\$\{\{\s*runner\.temp\s*\}\}\/native-qualification\/pack\/\*\.tgz\s*\n\s+\$\{\{\s*runner\.temp\s*\}\}\/native-qualification\/contract\.json\s*\n\s+\$\{\{\s*runner\.temp\s*\}\}\/native-qualification\/install\.log/,
      "qualification artifacts should contain only pack tarballs and the install evidence",
    );
    assert.match(qualifierScript, /join\(output, "pack"\)/);
    assert.match(qualifierScript, /join\(output, "install\.log"\)/);
    assert.match(qualifierScript, /join\(output, "contract\.json"\)/);
    assert.match(qualifierScript, /const platformDirectory = resolve\(root, "native\/npm", values\.target\)/);
    assert.match(qualifierScript, /createHash\("sha256"\)\.update\(readFileSync\(resolve\(values\.binary\)\)\)\.digest\("hex"\)/);
    assert.match(qualifierScript, /assert\.equal\(contract\.binarySha256, binarySha256, "installed binary must match the input artifact"\)/);
    assert.match(qualifierScript, /assert\.equal\(contract\.platformPackage, platform\.name, "consumer must select the requested platform package"\)/);
    const elfValidation = qualifierScript.indexOf("verifyMuslElf(resolve(values.binary))");
    const packageStaging = qualifierScript.indexOf("for (const dir of [wrapperStage, platformStage])");
    assert.ok(elfValidation >= 0 && packageStaging > elfValidation,
      "musl ELF validation must run before package staging and packing",
    );

    const publishNeeds = jobNeeds(publishJob);
    assert.match(publishNeeds, /\bbuild\b/);
    assert.match(
      publishNeeds,
      /\bqualify\b/,
      "publishing should wait for every platform qualification",
    );
  });
});
