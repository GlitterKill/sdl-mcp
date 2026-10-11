import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
    assert.match(qualifyJob, /apk add --no-cache libstdc\+\+/);
    assert.match(qualifyJob, /docker run[\s\S]*GITHUB_WORKSPACE[\s\S]*RUNNER_TEMP/);
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

    const publishNeeds = jobNeeds(publishJob);
    assert.match(publishNeeds, /\bbuild\b/);
    assert.match(
      publishNeeds,
      /\bqualify\b/,
      "publishing should wait for every platform qualification",
    );
  });
});
