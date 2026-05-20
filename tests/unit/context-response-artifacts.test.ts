import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { contextEngine } from "../../dist/agent/context-engine.js";
import type { ContextResult } from "../../dist/agent/types.js";
import { invalidateConfigCache } from "../../dist/config/loadConfig.js";
import {
  calculateContextRawEquivalentTokens,
  handleAgentContext,
} from "../../dist/mcp/tools/context.js";
import { handleResponseGet } from "../../dist/mcp/tools/response.js";

const originalSdlConfig = process.env.SDL_CONFIG;
const originalBuildContext = contextEngine.buildContext.bind(contextEngine);
let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sdl-context-response-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  contextEngine.buildContext = originalBuildContext;
  if (originalSdlConfig === undefined) {
    delete process.env.SDL_CONFIG;
  } else {
    process.env.SDL_CONFIG = originalSdlConfig;
  }
  invalidateConfigCache();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("sdl.context response artifacts", () => {
  it("stores context responses behind response.get without storing _rawContext", async () => {
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

    contextEngine.buildContext = async (): Promise<ContextResult> => ({
      taskId: "task-a",
      taskType: "explain",
      actionsTaken: [],
      path: {
        rungs: ["card"],
        estimatedTokens: 10,
        estimatedDurationMs: 1,
        reasoning: "test",
      },
      finalEvidence: [
        {
          type: "symbolCard",
          reference: "sym-a",
          summary: "A".repeat(2048),
          timestamp: Date.now(),
        },
      ],
      summary: "large context response",
      success: true,
      metrics: {
        totalDurationMs: 1,
        totalTokens: 6000,
        totalActions: 1,
        successfulActions: 1,
        failedActions: 0,
        cacheHits: 0,
      },
    });

    const response = await handleAgentContext({
      repoId: "repo-a",
      taskType: "explain",
      taskText: "explain the large response",
      responseMode: "handle",
      wireFormat: "json",
    }) as Record<string, unknown>;

    assert.equal(response.responseMode, "handle");
    assert.equal(response.kind, "responseArtifact");
    assert.equal(response.action, "response.get");
    assert.equal((response.metadata as Record<string, unknown>).toolName, "sdl.context");
    const expectedRawTokens = calculateContextRawEquivalentTokens({
      fileRawTokens: 0,
      evidenceCount: 1,
      resolvedEvidenceCount: 0,
    });

    assert.deepEqual((response as Record<string, unknown>)._rawContext, {
      rawTokens: expectedRawTokens,
    });

    const full = await handleResponseGet({
      repoId: "repo-a",
      handle: response.handle,
      full: true,
    }) as Record<string, unknown>;
    const content = full.content as Record<string, unknown>;
    assert.equal(content.taskId, "task-a");
    assert.equal(content._rawContext, undefined);
  });
});
