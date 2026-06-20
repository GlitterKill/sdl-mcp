import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  generateResponseArtifactHandle,
  getResponseArtifactBaseDir,
  isValidResponseArtifactHandle,
  maybeStoreLargeResponse,
  readResponseArtifact,
} from "../../dist/runtime/response-artifacts.js";
import { handleResponseGet } from "../../dist/mcp/tools/response.js";
import { ResponseGetRequestSchema } from "../../dist/mcp/tools.js";
import { invalidateConfigCache } from "../../dist/config/loadConfig.js";

const originalSdlConfig = process.env.SDL_CONFIG;
let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sdl-response-artifacts-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  if (originalSdlConfig !== undefined) {
    process.env.SDL_CONFIG = originalSdlConfig;
  } else {
    delete process.env.SDL_CONFIG;
  }
  invalidateConfigCache();

  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("response artifact storage", () => {
  it("preserves compatibility by returning inline payloads by default", async () => {
    const baseDir = makeTempDir();
    const payload = { ok: true, values: [1, 2, 3] };

    const result = await maybeStoreLargeResponse({
      repoId: "repo-a",
      toolName: "test.tool",
      payload,
      artifactBaseDir: baseDir,
    });

    assert.strictEqual(result.responseMode, "inline");
    assert.deepStrictEqual(result.payload, payload);
    assert.strictEqual(result.metadata.contentKind, "json");
    assert.ok(!existsSync(getResponseArtifactBaseDir(baseDir)));
  });

  it("stores handle responses with metadata and savings when requested", async () => {
    const baseDir = makeTempDir();
    const now = new Date("2026-05-08T10:00:00.000Z");
    const payload = { message: "A".repeat(5000), count: 3 };

    const result = await maybeStoreLargeResponse({
      repoId: "repo-a",
      toolName: "symbol.search",
      payload,
      responseMode: "handle",
      artifactBaseDir: baseDir,
      artifactTtlHours: 2,
      now: () => now,
      entropy: () => "0123456789abcdef",
    });

    assert.strictEqual(result.responseMode, "handle");
    assert.strictEqual(
      result.payload.handle,
      "response-repo-a-1778234400000-0123456789abcdef",
    );
    assert.strictEqual(result.metadata.toolName, "symbol.search");
    assert.strictEqual(result.metadata.contentKind, "json");
    assert.ok(result.metadata.estimatedOriginalTokens > 0);
    assert.ok(result.metadata.storedBytes > 0);
    assert.ok(result.metadata.sha256);
    assert.strictEqual(result.metadata.etag, result.metadata.sha256);
    assert.ok(result.payload.savings.savedBytes > 0);

    const read = await readResponseArtifact({
      repoId: "repo-a",
      handle: result.payload.handle,
      full: true,
      artifactBaseDir: baseDir,
      now: () => new Date("2026-05-08T10:30:00.000Z"),
    });

    assert.strictEqual(read.full, true);
    assert.strictEqual(read.truncated, false);
    assert.deepStrictEqual(read.content, payload);
  });

  it("extracts JSON paths without returning an invalid partial JSON string", async () => {
    const baseDir = makeTempDir();
    const payload = {
      finalEvidence: [
        { reference: "symbol:alpha", summary: "alpha" },
        { reference: "symbol:target", summary: "target" },
      ],
      padding: "x".repeat(5000),
    };

    const stored = await maybeStoreLargeResponse({
      repoId: "repo-a",
      toolName: "sdl.context",
      payload,
      responseMode: "handle",
      artifactBaseDir: baseDir,
      entropy: () => "abcdefabcdefabcd",
    });

    assert.strictEqual(stored.responseMode, "handle");
    assert.equal(
      ResponseGetRequestSchema.parse({
        repoId: "repo-a",
        handle: stored.payload.handle,
        jsonPath: "finalEvidence.1",
      }).jsonPath,
      "finalEvidence.1",
    );

    const read = await readResponseArtifact({
      repoId: "repo-a",
      handle: stored.payload.handle,
      artifactBaseDir: baseDir,
      jsonPath: "finalEvidence.1",
      maxBytes: 12,
    });

    assert.deepStrictEqual(read.content, {
      reference: "symbol:target",
      summary: "target",
    });
    assert.equal(read.full, false);
    assert.equal(read.truncated, false);
  });

  it("stores automatically only when the estimated token threshold is exceeded", async () => {
    const baseDir = makeTempDir();

    const inline = await maybeStoreLargeResponse({
      repoId: "repo-a",
      toolName: "test.tool",
      payload: "short",
      responseMode: "auto",
      threshold: 10,
      artifactBaseDir: baseDir,
    });

    const handled = await maybeStoreLargeResponse({
      repoId: "repo-a",
      toolName: "test.tool",
      payload: "A".repeat(100),
      responseMode: "auto",
      threshold: 10,
      artifactBaseDir: baseDir,
      entropy: () => "1111111111111111",
    });

    assert.strictEqual(inline.responseMode, "inline");
    assert.strictEqual(handled.responseMode, "handle");
    assert.ok(isValidResponseArtifactHandle(handled.payload.handle));
  });

  it("rejects response artifacts that exceed the configured artifact byte cap", async () => {
    await assert.rejects(
      () =>
        maybeStoreLargeResponse({
          repoId: "repo-a",
          toolName: "test.tool",
          payload: "A".repeat(2048),
          responseMode: "handle",
          contentKind: "text",
          artifactBaseDir: makeTempDir(),
          maxArtifactBytes: 1024,
        }),
      /exceeds maxArtifactBytes/,
    );
  });

  it("returns bounded excerpts with byte and token savings metadata", async () => {
    const baseDir = makeTempDir();
    const stored = await maybeStoreLargeResponse({
      repoId: "repo-a",
      toolName: "delta.get",
      payload: "0123456789abcdefghijklmnopqrstuvwxyz",
      responseMode: "handle",
      contentKind: "text",
      artifactBaseDir: baseDir,
      entropy: () => "2222222222222222",
    });
    assert.strictEqual(stored.responseMode, "handle");

    const read = await readResponseArtifact({
      repoId: "repo-a",
      handle: stored.payload.handle,
      maxBytes: 6,
      offsetBytes: 10,
      artifactBaseDir: baseDir,
    });

    assert.strictEqual(read.content, "abcdef");
    assert.strictEqual(read.full, false);
    assert.strictEqual(read.truncated, true);
    assert.strictEqual(read.range.offsetBytes, 10);
    assert.strictEqual(read.range.returnedBytes, 6);
    assert.ok(read.savings.savedTokens > 0);
    assert.ok(read.savings.savedBytes > 0);
  });

  it("enforces same-session bindings for handled tool responses", async () => {
    const baseDir = makeTempDir();
    const stored = await maybeStoreLargeResponse({
      repoId: "repo-a",
      toolName: "sdl.code.needWindow",
      payload: { code: "secret raw window" },
      responseMode: "handle",
      artifactBaseDir: baseDir,
      sessionId: "session-a",
      requiresSameSession: true,
      entropy: () => "aaaaaaaaaaaaaaaa",
    });
    assert.strictEqual(stored.responseMode, "handle");

    await assert.rejects(
      () =>
        readResponseArtifact({
          repoId: "repo-a",
          handle: stored.payload.handle,
          full: true,
          artifactBaseDir: baseDir,
          sessionId: "session-b",
        }),
      /not available in this session/,
    );

    const sameSession = await readResponseArtifact({
      repoId: "repo-a",
      handle: stored.payload.handle,
      full: true,
      artifactBaseDir: baseDir,
      sessionId: "session-a",
    });
    assert.deepStrictEqual(sameSession.content, { code: "secret raw window" });
  });

  it("rejects traversal handles before reaching the filesystem", async () => {
    assert.strictEqual(isValidResponseArtifactHandle("../bad"), false);
    assert.throws(
      () =>
        ResponseGetRequestSchema.parse({
          repoId: "repo-a",
          handle: "../bad",
        }),
      /handle must contain only alphanumerics/,
    );

    await assert.rejects(
      () =>
        readResponseArtifact({
          repoId: "repo-a",
          handle: "../bad",
          artifactBaseDir: makeTempDir(),
        }),
      /Invalid response artifact handle/,
    );
  });

  it("expires artifacts deterministically and removes the stored directory", async () => {
    const baseDir = makeTempDir();
    const stored = await maybeStoreLargeResponse({
      repoId: "repo-a",
      toolName: "repo.overview",
      payload: "expired payload",
      responseMode: "handle",
      contentKind: "text",
      artifactBaseDir: baseDir,
      artifactTtlHours: 1,
      now: () => new Date("2026-05-08T10:00:00.000Z"),
      entropy: () => "3333333333333333",
    });
    assert.strictEqual(stored.responseMode, "handle");
    const artifactDir = join(
      getResponseArtifactBaseDir(baseDir),
      stored.payload.handle,
    );
    assert.ok(existsSync(artifactDir));

    await assert.rejects(
      () =>
        readResponseArtifact({
          repoId: "repo-a",
          handle: stored.payload.handle,
          artifactBaseDir: baseDir,
          now: () => new Date("2026-05-08T11:00:01.000Z"),
        }),
      /Response artifact expired/,
    );
    assert.ok(!existsSync(artifactDir));
  });

  it("sweeps expired response artifacts before writing new ones", async () => {
    const baseDir = makeTempDir();
    const expired = await maybeStoreLargeResponse({
      repoId: "repo-a",
      toolName: "repo.overview",
      payload: "old payload",
      responseMode: "handle",
      contentKind: "text",
      artifactBaseDir: baseDir,
      artifactTtlHours: 1,
      now: () => new Date("2026-05-08T10:00:00.000Z"),
      entropy: () => "6666666666666666",
    });
    assert.strictEqual(expired.responseMode, "handle");
    const expiredDir = join(
      getResponseArtifactBaseDir(baseDir),
      expired.payload.handle,
    );
    assert.ok(existsSync(expiredDir));

    const fresh = await maybeStoreLargeResponse({
      repoId: "repo-a",
      toolName: "repo.overview",
      payload: "new payload",
      responseMode: "handle",
      contentKind: "text",
      artifactBaseDir: baseDir,
      now: () => new Date("2026-05-08T11:00:01.000Z"),
      entropy: () => "7777777777777777",
    });
    assert.strictEqual(fresh.responseMode, "handle");
    assert.ok(!existsSync(expiredDir));
  });

  it("serializes concurrent writes before enforcing per-repo quotas", async () => {
    const baseDir = makeTempDir();

    const writes = Array.from({ length: 8 }, (_, index) =>
      maybeStoreLargeResponse({
        repoId: "repo-a",
        toolName: "repo.overview",
        payload: `payload ${index}`,
        responseMode: "handle" as const,
        contentKind: "text" as const,
        artifactBaseDir: baseDir,
        maxArtifactsPerRepo: 1,
        entropy: () => `${index}`.repeat(16).slice(0, 16),
      }),
    );
    await Promise.all(writes);

    const artifactDirs = readdirSync(getResponseArtifactBaseDir(baseDir), {
      withFileTypes: true,
    }).filter((entry) => entry.isDirectory());
    assert.equal(artifactDirs.length, 1);
  });

  it("enforces a global stored-byte quota across repositories", async () => {
    const baseDir = makeTempDir();
    const first = await maybeStoreLargeResponse({
      repoId: "repo-a",
      toolName: "repo.overview",
      payload: "repo-a-" + Array.from({ length: 128 }, (_, i) => `a${i}`).join("|"),
      responseMode: "handle",
      contentKind: "text",
      artifactBaseDir: baseDir,
      entropy: () => "bbbbbbbbbbbbbbbb",
    });
    assert.strictEqual(first.responseMode, "handle");

    const second = await maybeStoreLargeResponse({
      repoId: "repo-b",
      toolName: "repo.overview",
      payload: "repo-b-" + Array.from({ length: 128 }, (_, i) => `b${i}`).join("|"),
      responseMode: "handle",
      contentKind: "text",
      artifactBaseDir: baseDir,
      maxStoredBytesTotal: first.metadata.storedBytes + 8,
      entropy: () => "cccccccccccccccc",
    });
    assert.strictEqual(second.responseMode, "handle");

    const artifactDirs = readdirSync(getResponseArtifactBaseDir(baseDir), {
      withFileTypes: true,
    }).filter((entry) => entry.isDirectory());
    assert.equal(artifactDirs.length, 1);
    assert.equal(artifactDirs[0]?.name, second.payload.handle);
  });

  it("enforces a global artifact-count quota across repositories", async () => {
    const baseDir = makeTempDir();
    const first = await maybeStoreLargeResponse({
      repoId: "repo-a",
      toolName: "repo.overview",
      payload: "one",
      responseMode: "handle",
      contentKind: "text",
      artifactBaseDir: baseDir,
      entropy: () => "dddddddddddddddd",
    });
    assert.strictEqual(first.responseMode, "handle");

    const second = await maybeStoreLargeResponse({
      repoId: "repo-b",
      toolName: "repo.overview",
      payload: "two",
      responseMode: "handle",
      contentKind: "text",
      artifactBaseDir: baseDir,
      maxArtifactsTotal: 1,
      entropy: () => "eeeeeeeeeeeeeeee",
    });
    assert.strictEqual(second.responseMode, "handle");

    const artifactDirs = readdirSync(getResponseArtifactBaseDir(baseDir), {
      withFileTypes: true,
    }).filter((entry) => entry.isDirectory());
    assert.equal(artifactDirs.length, 1);
    assert.equal(artifactDirs[0]?.name, second.payload.handle);
  });

  it("enforces a hard full-read decompressed byte cap", async () => {
    const baseDir = makeTempDir();
    const stored = await maybeStoreLargeResponse({
      repoId: "repo-a",
      toolName: "repo.overview",
      payload: "A".repeat(2048),
      responseMode: "handle",
      contentKind: "text",
      artifactBaseDir: baseDir,
      maxArtifactBytes: 4096,
      entropy: () => "8888888888888888",
    });
    assert.strictEqual(stored.responseMode, "handle");

    await assert.rejects(
      () =>
        readResponseArtifact({
          repoId: "repo-a",
          handle: stored.payload.handle,
          full: true,
          artifactBaseDir: baseDir,
          maxFullBytes: 1024,
        }),
      /exceeds retrieval size limit/,
    );
  });

  it("retrieves through response.get using the configured runtime artifact directory", async () => {
    const baseDir = makeTempDir();
    const configPath = join(baseDir, "sdlmcp.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        repos: [{ repoId: "repo-a", rootPath: baseDir }],
        policy: {},
        runtime: { artifactBaseDir: baseDir },
      }),
      "utf-8",
    );
    process.env.SDL_CONFIG = configPath;
    invalidateConfigCache();

    const stored = await maybeStoreLargeResponse({
      repoId: "repo-a",
      toolName: "symbol.search",
      payload: "large response text",
      responseMode: "handle",
      contentKind: "text",
      artifactBaseDir: baseDir,
      entropy: () => "4444444444444444",
    });
    assert.strictEqual(stored.responseMode, "handle");

    const response = await handleResponseGet({
      repoId: "repo-a",
      handle: stored.payload.handle,
      maxBytes: 5,
    });

    assert.strictEqual(response.handle, stored.payload.handle);
    assert.strictEqual(response.content, "large");
    assert.strictEqual(response.truncated, true);
    assert.strictEqual(response.metadata.toolName, "symbol.search");
  });
});

describe("generateResponseArtifactHandle", () => {
  it("sanitizes repo ids and produces path-safe handles", () => {
    const handle = generateResponseArtifactHandle(
      "repo/with\\slashes",
      new Date("2026-05-08T10:00:00.000Z"),
      "5555555555555555",
    );

    assert.strictEqual(
      handle,
      "response-repo_with_slashes-1778234400000-5555555555555555",
    );
    assert.strictEqual(isValidResponseArtifactHandle(handle), true);
  });
});
