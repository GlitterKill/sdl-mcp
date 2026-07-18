import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "fs";
import { join } from "path";
import { createHash } from "node:crypto";
import { tmpdir } from "os";
import { rmSync } from "fs";
import {
  generateArtifactId,
  getArtifactBaseDir,
  applyRedaction,
  writeArtifact,
  queryArtifactContent,
  sweepExpiredArtifacts,
  readArtifactManifest,
} from "../../dist/runtime/artifacts.js";

// ============================================================================
// Temp directory lifecycle
// ============================================================================

let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sdl-test-artifacts-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
  tempDirs = [];
});

// ============================================================================
// generateArtifactId
// ============================================================================

describe("generateArtifactId", () => {
  it("should produce unique IDs", () => {
    const id1 = generateArtifactId("repo-a");
    const id2 = generateArtifactId("repo-a");
    assert.notStrictEqual(id1, id2);
  });

  it("should include repoId in the output", () => {
    const id = generateArtifactId("my-repo");
    assert.ok(id.includes("my-repo"), `Expected "${id}" to contain "my-repo"`);
  });

  it("should start with runtime- prefix", () => {
    const id = generateArtifactId("test");
    assert.ok(
      id.startsWith("runtime-"),
      `Expected "${id}" to start with "runtime-"`,
    );
  });
});

// ============================================================================
// getArtifactBaseDir
// ============================================================================

describe("getArtifactBaseDir", () => {
  it("should use config path when provided", () => {
    const dir = getArtifactBaseDir("/custom/path");
    assert.strictEqual(dir, "/custom/path");
  });

  it("should fall back to tmpdir when not provided", () => {
    const dir = getArtifactBaseDir(null);
    assert.ok(
      dir.includes("sdl-runtime"),
      `Expected "${dir}" to contain "sdl-runtime"`,
    );
  });

  it("should fall back to tmpdir for empty string", () => {
    const dir = getArtifactBaseDir("");
    assert.ok(dir.includes("sdl-runtime"));
  });

  it("should fall back to tmpdir for whitespace-only", () => {
    const dir = getArtifactBaseDir("   ");
    assert.ok(dir.includes("sdl-runtime"));
  });
});

// ============================================================================
// applyRedaction
// ============================================================================

describe("applyRedaction", () => {
  it("should return content as-is when redaction is disabled", () => {
    const content = "AKIAIOSFODNN7EXAMPLE password=secret123";
    const result = applyRedaction(content, {
      enabled: false,
      includeDefaults: true,
      patterns: [],
    });
    assert.strictEqual(result, content);
  });

  it("should return content as-is when no redaction config", () => {
    const content = "AKIAIOSFODNN7EXAMPLE";
    const result = applyRedaction(content, undefined);
    assert.strictEqual(result, content);
  });

  it("should redact AWS key patterns", () => {
    const content = "key=AKIAIOSFODNN7EXAMPLE";
    const result = applyRedaction(content, {
      enabled: true,
      includeDefaults: true,
      patterns: [],
    });
    assert.ok(
      result.includes("[REDACTED:aws-key]"),
      `Expected redaction, got: ${result}`,
    );
    assert.ok(!result.includes("AKIAIOSFODNN7EXAMPLE"));
  });

  it("should redact GitHub token patterns", () => {
    // Use a context where the ghp_ token is standalone (not preceded by token=)
    // to avoid the generic secret pattern matching first
    const content = "auth ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij end";
    const result = applyRedaction(content, {
      enabled: true,
      includeDefaults: true,
      patterns: [],
    });
    assert.ok(
      result.includes("[REDACTED:github-token]"),
      `Expected redaction, got: ${result}`,
    );
    assert.ok(!result.includes("ghp_"), "Expected ghp_ token to be removed");
  });

  it("should redact generic secret patterns", () => {
    const content = "password=my_super_secret_value";
    const result = applyRedaction(content, {
      enabled: true,
      includeDefaults: true,
      patterns: [],
    });
    assert.ok(
      result.includes("[REDACTED:secret]"),
      `Expected redaction, got: ${result}`,
    );
  });

  it("should apply custom patterns", () => {
    const content = "CUSTOM-SECRET-12345";
    const result = applyRedaction(content, {
      enabled: true,
      includeDefaults: false,
      patterns: [{ pattern: "CUSTOM-SECRET-\\d+", name: "custom-secret" }],
    });
    assert.ok(
      result.includes("[REDACTED:custom-secret]"),
      `Expected redaction, got: ${result}`,
    );
    assert.ok(!result.includes("CUSTOM-SECRET-12345"));
  });

  it("should skip invalid custom regex patterns gracefully", () => {
    const content = "some text";
    // Invalid regex: unclosed group
    const result = applyRedaction(content, {
      enabled: true,
      includeDefaults: false,
      patterns: [{ pattern: "(unclosed" }],
    });
    // Should not throw, should return content (possibly unchanged)
    assert.ok(typeof result === "string");
  });
});

// ============================================================================
// writeArtifact
// ============================================================================

describe("writeArtifact", () => {
  it("should create manifest.json, stdout.gz, stderr.gz", async () => {
    const baseDir = makeTempDir();

    const result = await writeArtifact({
      repoId: "test-repo",
      runtime: "node",
      argsHash: "abc123",
      exitCode: 0,
      signal: null,
      durationMs: 100,
      stdout: Buffer.from("hello stdout"),
      stderr: Buffer.from("hello stderr"),
      policyAuditHash: "audit-hash-123",
      artifactTtlHours: 24,
      maxArtifactBytes: 10 * 1024 * 1024,
      artifactBaseDir: baseDir,
    });

    assert.ok(result.artifactHandle, "Expected artifactHandle");
    assert.ok(result.artifactDir, "Expected non-empty artifactDir");

    // Verify files were created
    assert.ok(existsSync(join(result.artifactDir, "manifest.json")));
    assert.ok(existsSync(join(result.artifactDir, "stdout.gz")));
    assert.ok(existsSync(join(result.artifactDir, "stderr.gz")));

    // Verify manifest contents
    assert.strictEqual(result.manifest.repoId, "test-repo");
    assert.strictEqual(result.manifest.runtime, "node");
    assert.strictEqual(result.manifest.exitCode, 0);
    assert.ok(result.manifest.stdoutSha256, "Expected non-empty stdoutSha256");
    assert.ok(result.manifest.stderrSha256, "Expected non-empty stderrSha256");
    assert.ok(result.manifest.createdAt, "Expected createdAt");
    assert.ok(result.manifest.expiresAt, "Expected expiresAt");
  });

  it("should return handle but skip write when size exceeds maxArtifactBytes", async () => {
    const baseDir = makeTempDir();

    const result = await writeArtifact({
      repoId: "test-repo",
      runtime: "node",
      argsHash: "abc",
      exitCode: 0,
      signal: null,
      durationMs: 50,
      stdout: Buffer.from("A".repeat(500)),
      stderr: Buffer.from("B".repeat(500)),
      policyAuditHash: "audit",
      artifactTtlHours: 24,
      maxArtifactBytes: 100, // total output is 1000, exceeds limit
      artifactBaseDir: baseDir,
    });

    assert.ok(
      result.artifactHandle,
      "Expected artifactHandle even when skipped",
    );
    assert.strictEqual(
      result.artifactDir,
      "",
      "Expected empty artifactDir when skipped",
    );
  });
});

// ============================================================================
// sweepExpiredArtifacts
// ============================================================================

describe("sweepExpiredArtifacts", () => {
  it("should return {deleted:0, errors:0} for non-existent directory", async () => {
    const result = await sweepExpiredArtifacts(
      "/nonexistent/path/sdl-test-" + Date.now(),
    );
    assert.strictEqual(result.deleted, 0);
    assert.strictEqual(result.errors, 0);
  });

  it("should delete expired artifacts", async () => {
    const baseDir = makeTempDir();
    const artifactDir = join(baseDir, "runtime-test-expired");
    mkdirSync(artifactDir, { recursive: true });

    // Create a manifest that expired 1 hour ago
    const manifest = {
      artifactId: "runtime-test-expired",
      repoId: "test",
      runtime: "node",
      argsHash: "x",
      exitCode: 0,
      signal: null,
      durationMs: 10,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutSha256: "abc",
      stderrSha256: "def",
      policyAuditHash: "aud",
      createdAt: new Date(Date.now() - 7200_000).toISOString(),
      expiresAt: new Date(Date.now() - 3600_000).toISOString(),
    };
    writeFileSync(join(artifactDir, "manifest.json"), JSON.stringify(manifest));

    const result = await sweepExpiredArtifacts(baseDir);

    assert.strictEqual(result.deleted, 1);
    assert.strictEqual(result.errors, 0);
    assert.ok(
      !existsSync(artifactDir),
      "Expected expired artifact directory to be deleted",
    );
  });

  it("should not delete non-expired artifacts", async () => {
    const baseDir = makeTempDir();
    const artifactDir = join(baseDir, "runtime-test-valid");
    mkdirSync(artifactDir, { recursive: true });

    // Manifest that expires in 1 hour
    const manifest = {
      artifactId: "runtime-test-valid",
      repoId: "test",
      runtime: "node",
      argsHash: "x",
      exitCode: 0,
      signal: null,
      durationMs: 10,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutSha256: "abc",
      stderrSha256: "def",
      policyAuditHash: "aud",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    };
    writeFileSync(join(artifactDir, "manifest.json"), JSON.stringify(manifest));

    const result = await sweepExpiredArtifacts(baseDir);

    assert.strictEqual(result.deleted, 0);
    assert.ok(
      existsSync(artifactDir),
      "Expected valid artifact directory to remain",
    );
  });
});

// ============================================================================
// readArtifactManifest
// ============================================================================

describe("readArtifactManifest", () => {
  it("should return null for non-existent handle", async () => {
    const result = await readArtifactManifest(
      "nonexistent-handle-" + Date.now(),
      "/tmp",
    );
    assert.strictEqual(result, null);
  });

  it("should read manifest for existing artifact", async () => {
    const baseDir = makeTempDir();
    const handle = "test-artifact-read";
    const artifactDir = join(baseDir, handle);
    mkdirSync(artifactDir, { recursive: true });

    const manifest = {
      artifactId: handle,
      repoId: "test",
      runtime: "node",
      argsHash: "x",
      exitCode: 0,
      signal: null,
      durationMs: 10,
      stdoutBytes: 5,
      stderrBytes: 3,
      stdoutSha256: "aaa",
      stderrSha256: "bbb",
      policyAuditHash: "aud",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-02T00:00:00.000Z",
    };
    writeFileSync(join(artifactDir, "manifest.json"), JSON.stringify(manifest));

    const result = await readArtifactManifest(handle, baseDir);

    assert.ok(result, "Expected non-null manifest");
    assert.strictEqual(result.artifactId, handle);
    assert.strictEqual(result.repoId, "test");
    assert.strictEqual(result.exitCode, 0);
  });
});

describe("queryArtifactContent trust metadata", () => {
  async function writeSearchArtifact(stdout: string, stderr = "") {
    const baseDir = makeTempDir();
    const artifact = await writeArtifact({
      repoId: "search-repo",
      runtime: "node",
      argsHash: "args",
      exitCode: 1,
      signal: null,
      durationMs: 10,
      stdout: Buffer.from(stdout, "utf8"),
      stderr: Buffer.from(stderr, "utf8"),
      policyAuditHash: "audit",
      artifactTtlHours: 1,
      maxArtifactBytes: 1024 * 1024,
      artifactBaseDir: baseDir,
    });
    return { baseDir, handle: artifact.artifactHandle };
  }

  it("queryArtifactContent reports match metadata", async () => {
    const { baseDir, handle } = await writeSearchArtifact(
      "alpha\nneedle one\nmiddle\nneedle two\nomega",
    );

    const result = await queryArtifactContent(handle, ["needle"], {
      baseDir,
      stream: "stdout",
      maxExcerpts: 1,
      contextLines: 0,
    });

    assert.strictEqual(result.matchStatus, "matched");
    assert.strictEqual(result.matchCount, 2);
    assert.deepStrictEqual(result.nextCursor, { stream: "stdout", afterLine: 2 });
    assert.strictEqual(result.excerpts.length, 1);
  });

  it("queryArtifactContent labels fallback excerpts when no terms match", async () => {
    const { baseDir, handle } = await writeSearchArtifact("alpha\nbeta\ngamma");

    const result = await queryArtifactContent(handle, ["missing"], {
      baseDir,
      stream: "stdout",
      maxExcerpts: 2,
      contextLines: 0,
    });

    assert.strictEqual(result.matchStatus, "noMatchFallback");
    assert.strictEqual(result.matchCount, 0);
    assert.strictEqual(result.excerpts[0]?.content, "alpha\nbeta");
  });

  it("queryArtifactContent can read an exact line range without query terms", async () => {
    const { baseDir, handle } = await writeSearchArtifact("one\ntwo\nthree\nfour");

    const result = await queryArtifactContent(handle, [], {
      baseDir,
      lineRange: { stream: "stdout", startLine: 2, endLine: 3 },
    });

    assert.strictEqual(result.matchStatus, "lineRange");
    assert.strictEqual(result.matchCount, 0);
    assert.strictEqual(result.excerpts[0]?.content, "two\nthree");
  });
});


  it("returns manifest projection metadata without mutating persisted gzip bytes or hashes", async () => {
    const baseDir = makeTempDir();
    const artifact = await writeArtifact({
      repoId: "projection-repo",
      runtime: "node",
      argsHash: "args",
      commandSummary: "node --test [argCount=1]",
      exitCode: 1,
      signal: null,
      durationMs: 10,
      stdout: Buffer.from("prompt\nnot ok 1 - failure (12.34ms)\n", "utf8"),
      stderr: Buffer.from("", "utf8"),
      policyAuditHash: "audit",
      artifactTtlHours: 1,
      maxArtifactBytes: 1024 * 1024,
      artifactBaseDir: baseDir,
    });
    const stdoutPath = join(artifact.artifactDir, "stdout.gz");
    const beforeBytes = readFileSync(stdoutPath);
    const beforeHash = createHash("sha256").update(beforeBytes).digest("hex");
    const beforeManifest = await readArtifactManifest(
      artifact.artifactHandle,
      baseDir,
    );

    const result = await queryArtifactContent(
      artifact.artifactHandle,
      ["not ok"],
      { baseDir, stream: "stdout", contextLines: 1 },
    );

    const afterBytes = readFileSync(stdoutPath);
    const afterHash = createHash("sha256").update(afterBytes).digest("hex");
    const afterManifest = await readArtifactManifest(
      artifact.artifactHandle,
      baseDir,
    );

    assert.strictEqual(result.runtime, "node");
    assert.strictEqual(result.commandSummary, "node --test [argCount=1]");
    assert.deepStrictEqual(afterBytes, beforeBytes);
    assert.strictEqual(afterHash, beforeHash);
    assert.strictEqual(afterManifest?.stdoutSha256, beforeManifest?.stdoutSha256);
  });