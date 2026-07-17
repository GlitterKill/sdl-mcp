import { describe, it, afterEach, beforeEach } from "node:test";
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
import { maybeCompressToolResponse } from "../../dist/mcp/response-compression.js";
import {
  _setResponseRepoExistsForTesting,
  handleResponseGet,
} from "../../dist/mcp/tools/response.js";
import { ResponseGetRequestSchema } from "../../dist/mcp/tools.js";
import { invalidateConfigCache } from "../../dist/config/loadConfig.js";
import { ValidationError } from "../../dist/domain/errors.js";

const originalSdlConfig = process.env.SDL_CONFIG;
let tempDirs: string[] = [];

interface InternalTokenUsage {
  sdlTokens: number;
  rawEquivalent: number;
}

function getHiddenTokenUsage(value: unknown): InternalTokenUsage {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(
    Object.prototype.propertyIsEnumerable.call(value, "_tokenUsage"),
    false,
  );
  const usage = (value as { _tokenUsage?: InternalTokenUsage })._tokenUsage;
  assert.ok(usage, "expected hidden token usage metadata");
  return usage;
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sdl-response-artifacts-"));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  _setResponseRepoExistsForTesting(async () => true);
});

afterEach(() => {
  _setResponseRepoExistsForTesting();
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
    assert.deepStrictEqual(Object.keys(result.payload).sort(), [
      "action",
      "handle",
      "kind",
      "metadata",
      "responseMode",
    ]);
    assert.equal(result.payload.metadata.handle, result.payload.handle);
    assert.equal(result.payload.metadata.etag, result.metadata.etag);
    assert.equal("estimatedOriginalTokens" in result.payload.metadata, false);
    assert.equal("savings" in result.payload, false);

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


  it("supports bracket JSON path array indexes", async () => {
    const baseDir = makeTempDir();
    const payload = {
      finalEvidence: [
        { reference: "symbol:alpha", summary: "alpha" },
        { reference: "symbol:target", summary: "target" },
      ],
    };

    const stored = await maybeStoreLargeResponse({
      repoId: "repo-a",
      toolName: "sdl.context",
      payload,
      responseMode: "handle",
      artifactBaseDir: baseDir,
      entropy: () => "3333333333333333",
    });
    assert.strictEqual(stored.responseMode, "handle");

    const first = await readResponseArtifact({
      repoId: "repo-a",
      handle: stored.payload.handle,
      artifactBaseDir: baseDir,
      jsonPath: "finalEvidence[0]",
    });
    const second = await readResponseArtifact({
      repoId: "repo-a",
      handle: stored.payload.handle,
      artifactBaseDir: baseDir,
      jsonPath: "$.finalEvidence[1]",
    });

    assert.deepStrictEqual(first.content, payload.finalEvidence[0]);
    assert.deepStrictEqual(second.content, payload.finalEvidence[1]);
  });

  it("rejects JSON paths that do not match", async () => {
    const baseDir = makeTempDir();
    const stored = await maybeStoreLargeResponse({
      repoId: "repo-a",
      toolName: "sdl.context",
      payload: { finalEvidence: [{ reference: "symbol:alpha" }] },
      responseMode: "handle",
      artifactBaseDir: baseDir,
      entropy: () => "4444444444444444",
    });
    assert.strictEqual(stored.responseMode, "handle");

    await assert.rejects(
      () =>
        readResponseArtifact({
          repoId: "repo-a",
          handle: stored.payload.handle,
          artifactBaseDir: baseDir,
          jsonPath: "finalEvidence[9]",
        }),
      /jsonPath not found: finalEvidence\[9\]/,
    );
  });

  it("rejects inherited JSON path properties", async () => {
    const baseDir = makeTempDir();
    const stored = await maybeStoreLargeResponse({
      repoId: "repo-a",
      toolName: "sdl.context",
      payload: { finalEvidence: [{ reference: "symbol:alpha" }] },
      responseMode: "handle",
      artifactBaseDir: baseDir,
      entropy: () => "4545454545454545",
    });
    assert.strictEqual(stored.responseMode, "handle");

    await assert.rejects(
      () =>
        readResponseArtifact({
          repoId: "repo-a",
          handle: stored.payload.handle,
          artifactBaseDir: baseDir,
          jsonPath: "toString",
        }),
      /jsonPath not found: toString/,
    );
  });

  it("paginates JSON path arrays before returning content", async () => {
    const baseDir = makeTempDir();
    const payload = {
      finalEvidence: [
        { reference: "symbol:alpha", summary: "alpha" },
        { reference: "symbol:target", summary: "target" },
        { reference: "symbol:omega", summary: "omega" },
      ],
    };

    const stored = await maybeStoreLargeResponse({
      repoId: "repo-a",
      toolName: "sdl.context",
      payload,
      responseMode: "handle",
      artifactBaseDir: baseDir,
      entropy: () => "5555555555555555",
    });
    assert.strictEqual(stored.responseMode, "handle");

    const page = await readResponseArtifact({
      repoId: "repo-a",
      handle: stored.payload.handle,
      artifactBaseDir: baseDir,
      jsonPath: "finalEvidence",
      offset: 1,
      limit: 1,
    });

    assert.deepStrictEqual(page.content, [payload.finalEvidence[1]]);
    assert.deepStrictEqual(page.pagination, {
      offset: 1,
      limit: 1,
      total: 3,
      returned: 1,
      hasMore: true,
      nextOffset: 2,
    });
    assert.equal(page.truncated, true);
  });

  it("rejects paged JSON path results that exceed requested byte bounds", async () => {
    const baseDir = makeTempDir();
    const payload = {
      finalEvidence: [
        { reference: "symbol:target", summary: "x".repeat(1000) },
      ],
    };

    const stored = await maybeStoreLargeResponse({
      repoId: "repo-a",
      toolName: "sdl.context",
      payload,
      responseMode: "handle",
      artifactBaseDir: baseDir,
      entropy: () => "5656565656565656",
    });
    assert.strictEqual(stored.responseMode, "handle");

    await assert.rejects(
      () =>
        readResponseArtifact({
          repoId: "repo-a",
          handle: stored.payload.handle,
          artifactBaseDir: baseDir,
          jsonPath: "finalEvidence",
          offset: 0,
          limit: 1,
          maxBytes: 10,
        }),
      /JSON path result exceeds requested byte\/token bound/,
    );
  });

  it("requires an explicit retrieval mode before slicing JSON artifacts", async () => {
    const baseDir = makeTempDir();
    const payload = {
      finalEvidence: [{ reference: "symbol:alpha" }],
      padding: "x".repeat(2000),
    };

    const stored = await maybeStoreLargeResponse({
      repoId: "repo-a",
      toolName: "sdl.context",
      payload,
      responseMode: "handle",
      artifactBaseDir: baseDir,
      entropy: () => "6666666666666666",
    });
    assert.strictEqual(stored.responseMode, "handle");

    await assert.rejects(
      () =>
        readResponseArtifact({
          repoId: "repo-a",
          handle: stored.payload.handle,
          artifactBaseDir: baseDir,
          maxBytes: 20,
        }),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.match(error.message, /full:true/);
        assert.match(error.message, /jsonPath/);
        assert.match(error.message, /raw:true/);
        assert.match(error.message, /syntactically incomplete JSON/);
        return true;
      },
    );

    const raw = await readResponseArtifact({
      repoId: "repo-a",
      handle: stored.payload.handle,
      artifactBaseDir: baseDir,
      maxBytes: 20,
      raw: true,
    });

    assert.equal(typeof raw.content, "string");
    assert.equal(raw.truncated, true);
  });

  it("rejects incompatible JSON retrieval option combinations", async () => {
    const baseDir = makeTempDir();
    const stored = await maybeStoreLargeResponse({
      repoId: "repo-a",
      toolName: "sdl.context",
      payload: { finalEvidence: [{ reference: "symbol:alpha" }] },
      responseMode: "handle",
      artifactBaseDir: baseDir,
      entropy: () => "6767676767676767",
    });
    assert.strictEqual(stored.responseMode, "handle");

    await assert.rejects(
      () =>
        readResponseArtifact({
          repoId: "repo-a",
          handle: stored.payload.handle,
          artifactBaseDir: baseDir,
          jsonPath: "finalEvidence",
          offsetBytes: 1,
        }),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.match(error.message, /offsetBytes.*raw:true/i);
        return true;
      },
    );

    await assert.rejects(
      () =>
        readResponseArtifact({
          repoId: "repo-a",
          handle: stored.payload.handle,
          artifactBaseDir: baseDir,
          full: true,
          offsetBytes: 1,
        }),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.match(error.message, /offsetBytes.*full:true/i);
        return true;
      },
    );

    await assert.rejects(
      () =>
        readResponseArtifact({
          repoId: "repo-a",
          handle: stored.payload.handle,
          artifactBaseDir: baseDir,
          full: true,
          raw: true,
        }),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.match(error.message, /exactly one JSON retrieval mode/i);
        return true;
      },
    );

    await assert.rejects(
      () =>
        readResponseArtifact({
          repoId: "repo-a",
          handle: stored.payload.handle,
          artifactBaseDir: baseDir,
          raw: true,
          offset: 1,
        }),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.match(error.message, /offset and limit.*jsonPath/i);
        return true;
      },
    );
  });

  it("omits token savings from response.get output", async () => {
    const baseDir = makeTempDir();
    const configPath = join(baseDir, "sdl.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ repos: [], policy: {}, runtime: { artifactBaseDir: baseDir } }),
    );
    process.env.SDL_CONFIG = configPath;
    invalidateConfigCache();
    const stored = await maybeStoreLargeResponse({
      repoId: "repo-a",
      toolName: "sdl.context",
      payload: { finalEvidence: [{ reference: "symbol:alpha" }] },
      responseMode: "handle",
      artifactBaseDir: baseDir,
      entropy: () => "4646464646464646",
    });
    assert.strictEqual(stored.responseMode, "handle");

    const response = await handleResponseGet({
      repoId: "repo-a",
      handle: stored.payload.handle,
      jsonPath: "finalEvidence[0]",
    });
    const serialized = JSON.stringify(response);
    const internalUsage = getHiddenTokenUsage(response);

    assert.ok(internalUsage.sdlTokens > 0);
    assert.ok(internalUsage.rawEquivalent > internalUsage.sdlTokens);
    assert.equal("estimatedOriginalTokens" in response.metadata, false);
    assert.equal("estimatedReturnedTokens" in response.range, false);
    assert.equal("_tokenUsage" in JSON.parse(serialized), false);
    assert.equal("savings" in response, false);
    assert.equal(serialized.includes("estimatedOriginalTokens"), false);
    assert.equal(serialized.includes("estimatedReturnedTokens"), false);
    assert.equal(serialized.includes("originalTokens"), false);
    assert.equal(serialized.includes("returnedTokens"), false);
    assert.equal(serialized.includes("savedTokens"), false);
  });

  it("uses a lower auto threshold for sdl.context responses", async () => {
    const baseDir = makeTempDir();
    const configPath = join(baseDir, "sdl.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ repos: [], policy: {}, runtime: { artifactBaseDir: baseDir } }),
    );
    process.env.SDL_CONFIG = configPath;
    invalidateConfigCache();

    const summary = Array.from({ length: 2200 }, (_, i) => `term${i}`).join(" ");
    const response = await maybeCompressToolResponse({
      repoId: "repo-a",
      toolName: "sdl.context",
      payload: {
        success: true,
        taskType: "review",
        summary,
        finalEvidence: [{ summary: "focused evidence" }],
      },
      responseMode: "auto",
    });

    if (!("handle" in response)) {
      assert.fail("expected response artifact handle");
    }
    assert.strictEqual(response.responseMode, "handle");
    assert.strictEqual(response.kind, "responseArtifact");
    assert.deepStrictEqual(Object.keys(response).sort(), [
      "action",
      "handle",
      "kind",
      "metadata",
      "responseMode",
    ]);
    assert.equal("estimatedOriginalTokens" in response.metadata, false);
    const internalUsage = getHiddenTokenUsage(response);
    assert.ok(internalUsage.rawEquivalent > internalUsage.sdlTokens);
    assert.ok(isValidResponseArtifactHandle(response.handle));
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

describe("response artifact maxTokens enforcement", () => {
  it("maxTokens bounds the estimated tokens of the returned content", async () => {
    const baseDir = makeTempDir();
    const payload = {
      rows: Array.from({ length: 400 }, (_, i) => ({
        id: `symbol-${i}`,
        score: i * 0.5,
        summary: `dense json payload row ${i}`,
      })),
    };

    const stored = await maybeStoreLargeResponse({
      repoId: "repo-a",
      toolName: "test.tool",
      payload,
      responseMode: "handle",
      artifactBaseDir: baseDir,
    });
    assert.strictEqual(stored.responseMode, "handle");
    if (stored.responseMode !== "handle") return;

    const { estimateTokens } = await import("../../dist/util/tokenize.js");
    const read = await readResponseArtifact({
      repoId: "repo-a",
      handle: stored.payload.handle,
      maxTokens: 100,
      raw: true,
      artifactBaseDir: baseDir,
    });

    assert.strictEqual(read.truncated, true);
    const text = String(read.content);
    const estimated = estimateTokens(text);
    assert.ok(
      estimated <= 100,
      `estimated tokens ${estimated} exceed requested maxTokens 100`,
    );
    assert.ok(text.length > 0, "content should not be emptied by the cap");
  });

  it("maxBytes remains an exact byte cap", async () => {
    const baseDir = makeTempDir();
    const payload = { message: "B".repeat(5000) };

    const stored = await maybeStoreLargeResponse({
      repoId: "repo-a",
      toolName: "test.tool",
      payload,
      responseMode: "handle",
      artifactBaseDir: baseDir,
    });
    assert.strictEqual(stored.responseMode, "handle");
    if (stored.responseMode !== "handle") return;

    const read = await readResponseArtifact({
      repoId: "repo-a",
      handle: stored.payload.handle,
      maxBytes: 1200,
      raw: true,
      artifactBaseDir: baseDir,
    });

    assert.strictEqual(read.range.returnedBytes, 1200);
  });
});
