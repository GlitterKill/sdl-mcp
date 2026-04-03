import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  generateManual,
  invalidateManualCache,
} from "../../dist/code-mode/manual-generator.js";
import {
  registerActionSearchTool,
} from "../../dist/code-mode/index.js";
import { resolveRefs } from "../../dist/code-mode/ref-resolver.js";
import { invalidateConfigCache } from "../../dist/config/loadConfig.js";

const originalSdlConfig = process.env.SDL_CONFIG;

describe("code-mode regressions", () => {
  let tmpDir: string;

  before(() => {
    // Create a config with memory enabled so manual contains all signatures
    tmpDir = mkdtempSync(join(tmpdir(), "sdl-regressions-"));
    const configPath = join(tmpDir, "config.json");
    writeFileSync(configPath, JSON.stringify({
      repos: [{ repoId: "test", rootPath: tmpDir, memory: { enabled: true } }],
      policy: {},
    }));
    process.env.SDL_CONFIG = configPath;
    invalidateConfigCache();
  });

  after(() => {
    if (originalSdlConfig !== undefined) {
      process.env.SDL_CONFIG = originalSdlConfig;
    } else {
      delete process.env.SDL_CONFIG;
    }
    invalidateConfigCache();
    invalidateManualCache();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("hardcoded manual signatures match the live tool contracts", () => {
    invalidateManualCache();
    const manual = generateManual();

    assert.match(
      manual,
      /function contextSummary\(p: \{ symbolId\?: string; file\?: string; query\?: string; budget\?: number; format\?: "markdown"\|"json"\|"clipboard"; scope\?: "symbol"\|"file"\|"task"\|"repo"; ifNoneMatch\?: string \}\): \{ summary: string; tokens: number \} \| \{ notModified: true; etag: string \}/,
    );
    assert.match(
      manual,
      /function codeHotPath\(p: \{ symbolId: string; identifiersToFind: string\[]; contextLines\?: number; ifNoneMatch\?: string \}\): \{ excerpt: string; foundIdentifiers: string\[]; etag: string \} \| \{ notModified: true; etag: string \}/,
    );
    assert.match(
      manual,
      /function repoOverview\(p: \{ level\?: "stats" \| "directories" \| "full"; ifNoneMatch\?: string \}\): \{ overview: object; etag: string \} \| \{ notModified: true; etag: string \}/,
    );
    assert.match(
      manual,
      /function agentContext\(p: \{ taskType: "debug" \| "review" \| "implement" \| "explain"; taskText: string; budget\?: \{ maxTokens\?: number; maxActions\?: number; maxDurationMs\?: number \}; options\?: \{ focusSymbols\?: string\[]; focusPaths\?: string\[]; includeTests\?: boolean; requireDiagnostics\?: boolean; contextMode\?: "precise"\|"broad" \}; ifNoneMatch\?: string \}\): \{ evidence: object\[]; etag: string \} \| \{ notModified: true; etag: string \}/,
      );
    assert.match(
      manual,
      /function prRiskAnalyze\(p: \{ fromVersion: string; toVersion: string; riskThreshold\?: number \}\)/,
    );
    assert.match(
      manual,
      /function memoryStore\(p: \{ type: "decision"\|"bugfix"\|"task_context"\|"pattern"\|"convention"\|"architecture"\|"performance"\|"security"; title: string; content: string; tags\?: string\[]; symbolIds\?: string\[]; fileRelPaths\?: string\[] \}\)/,
    );
  });

  it("action.search supports offset-based pagination", async () => {
    let handler: ((args: unknown) => Promise<unknown>) | null = null;
    let inputSchema: Record<string, unknown> | null = null;

    const fakeServer = {
      registerTool(
        name: string,
        _description: string,
        _schema: unknown,
        toolHandler: (args: unknown) => Promise<unknown>,
        wireSchema: unknown,
      ) {
        if (name === "sdl.action.search") {
          handler = toolHandler;
          inputSchema = wireSchema as Record<string, unknown>;
        }
      },
    };

    registerActionSearchTool(fakeServer as never, { liveIndex: undefined } as never);
    assert.ok(handler);

    const firstPage = await handler({
      query: "*",
      limit: 2,
      offset: 0,
    }) as { actions: Array<{ action: string }>; total: number; hasMore: boolean };
    const secondPage = await handler({
      query: "*",
      limit: 2,
      offset: 1,
    }) as { actions: Array<{ action: string }>; total: number; hasMore: boolean };

    assert.equal(firstPage.actions.length, 2);
    assert.equal(secondPage.actions.length, 2);
    assert.equal(firstPage.total, secondPage.total);
    assert.equal(secondPage.hasMore, true);
    assert.notEqual(firstPage.actions[0]?.action, secondPage.actions[0]?.action);
    assert.equal(firstPage.actions[1]?.action, secondPage.actions[0]?.action);
    assert.equal(
      (inputSchema?.properties as Record<string, { maximum?: number }>).limit?.maximum,
      50,
    );
    assert.equal(
      (inputSchema?.properties as Record<string, { minimum?: number }>).offset?.minimum,
      0,
    );
  });

  it("optional workflow references resolve to undefined instead of throwing", () => {
    const resolved = resolveRefs(
      {
        symbolId: "$0.results[1]?.symbolId",
        fallback: "$0.results[0].symbolId",
      },
      [{ results: [{ symbolId: "sym-0" }] }],
    );

    assert.equal(resolved.symbolId, undefined);
    assert.equal(resolved.fallback, "sym-0");
  });
});
