import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeWorkflow } from "../../dist/code-mode/workflow-executor.js";
import { WorkflowRequestSchema } from "../../dist/code-mode/types.js";
import type { ParsedWorkflowRequest } from "../../dist/code-mode/workflow-parser.js";
import { invalidateConfigCache } from "../../dist/config/loadConfig.js";
import { ContextEngineV2 } from "../../dist/context/engine.js";
import type { ContextPayload } from "../../dist/context/types.js";
import { createActionMap } from "../../dist/gateway/router.js";
import {
  projectExclusiveCodeModeRecovery,
} from "../../dist/code-mode/action-reference-projection.js";
import { projectToolResultForModelContent } from "../../dist/mcp/context-response-projection.js";
import { handleAgentContext } from "../../dist/mcp/tools/context.js";
import {
  _setResponseRepoExistsForTesting,
  handleResponseGet,
} from "../../dist/mcp/tools/response.js";
import { maybeStoreLargeResponse } from "../../dist/runtime/response-artifacts.js";

const originalSdlConfig = process.env.SDL_CONFIG;
const originalBuildContext = ContextEngineV2.prototype.buildContext;
let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sdl-context-response-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  _setResponseRepoExistsForTesting();
  ContextEngineV2.prototype.buildContext = originalBuildContext;
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
  it("stores the same canonical context payload returned inline", async () => {
    _setResponseRepoExistsForTesting(async () => true);
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

    const payload: ContextPayload = {
      status: "complete",
      taskType: "explain",
      retrieval: {
        level: "lexical",
        lanes: [{ id: "symbolFts", available: true }],
      },
      evidence: [
        {
          rung: "card",
          symbolId: "sym-a",
          path: "src/a.ts",
          rank: 1,
          tier: 0,
          lanes: ["symbolFts"],
          content: { name: "symbolA", summary: "A".repeat(2048) },
        },
      ],
      edges: [],
      omitted: {
        total: 0,
        byReason: { budget: 0 },
        highestRanked: [],
      },
      nextActions: [],
    };
    ContextEngineV2.prototype.buildContext = async () =>
      structuredClone(payload);

    const request = {
      repoId: "repo-a",
      taskType: "explain" as const,
      taskText: "explain the large response",
      budget: { maxTokens: 8192 },
      refsMode: "off" as const,
      wireFormat: "json" as const,
    };
    const inline = (await handleAgentContext({
      ...request,
      responseMode: "inline",
    })) as Record<string, unknown>;
    const response = (await handleAgentContext({
      ...request,
      responseMode: "handle",
    })) as Record<string, unknown>;

    assert.equal(response.responseMode, "handle");
    assert.equal(response.kind, "responseArtifact");
    assert.equal(response.action, "response.get");
    assert.equal((response.metadata as Record<string, unknown>).toolName, "sdl.context");
    assert.equal(response._rawContext, undefined);

    const full = await handleResponseGet({
      repoId: "repo-a",
      handle: response.handle,
      full: true,
    }) as Record<string, unknown>;
    const content = full.content as Record<string, unknown>;
    assert.equal(content._rawContext, undefined);
    assert.deepEqual(content, inline);
    assert.equal("taskId" in content, false);
    assert.equal("truncation" in content, false);
  });

  it("materializes response.get recovery through workflow projection", async () => {
    _setResponseRepoExistsForTesting(async () => true);
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
      toolName: "sdl.context",
      payload: {
        status: "complete",
        taskType: "explain",
        retrieval: {
          level: "lexical",
          lanes: [{ id: "symbolFts", available: true }],
        },
        evidence: [{ rung: "card", symbolId: "target" }],
        edges: [],
        omitted: {
          total: 0,
          byReason: { budget: 0 },
          highestRanked: [],
        },
        nextActions: [],
      },
      responseMode: "handle",
      artifactBaseDir: baseDir,
      entropy: () => "fedcbafedcbafedc",
    });
    assert.equal(stored.responseMode, "handle");
    const handle = stored.payload.handle;
    const actionMap = createActionMap(undefined, { memoryTools: false });
    const workflowConfig = {
      enabled: true,
      exclusive: false,
      maxWorkflowSteps: 20,
      maxWorkflowTokens: 50_000,
      maxWorkflowDurationMs: 60_000,
      ladderValidation: "warn" as const,
      etagCaching: true,
    };
    const invalidRequest: ParsedWorkflowRequest = {
      repoId: "repo-a",
      steps: [{
        fn: "responseGet",
        action: "response.get",
        args: { handle, jsonPath: "missing.path" },
      }],
      onError: "continueAll",
    };

    const rawFailure = await executeWorkflow(
      invalidRequest,
      actionMap,
      workflowConfig,
    );
    assert.deepEqual(rawFailure.results[0].failureTrace?.details?.details, [
      "Available top-level keys: edges, evidence, nextActions, omitted, retrieval, status, taskType",
    ]);
    const projectedFailure = projectToolResultForModelContent(
      "sdl.workflow",
      projectExclusiveCodeModeRecovery(
        rawFailure as unknown as Record<string, unknown>,
        "repo-a",
      ) as Record<string, unknown>,
      { repoId: "repo-a", steps: invalidRequest.steps },
    ) as {
      results: Array<{
        failureTrace?: unknown;
        nextAction?: { action: string; args: unknown };
      }>;
    };
    const projectedStep = projectedFailure.results[0];
    const nextAction = projectedStep.nextAction;
    assert.equal(projectedStep.failureTrace, undefined);
    assert.deepEqual(nextAction, {
      action: "sdl.workflow",
      args: {
        includeTelemetry: false,
        onError: "continue",
        repoId: "repo-a",
        steps: [{
          args: {
            full: false,
            handle,
            jsonPath: "evidence",
            limit: 5,
            maxBytes: 8192,
            offset: 0,
            offsetBytes: 0,
            raw: false,
          },
          fn: "responseGet",
        }],
      },
    });
    assert.equal(WorkflowRequestSchema.safeParse(nextAction?.args).success, true);
    assert.equal(
      (JSON.stringify(projectedStep).match(/"nextAction"/g) ?? []).length,
      1,
    );

    const retryRequest: ParsedWorkflowRequest = {
      ...invalidRequest,
      steps: [{
        fn: "responseGet",
        action: "response.get",
        args: { handle, jsonPath: "evidence", offset: 0, limit: 5 },
      }],
    };
    const retry = await executeWorkflow(retryRequest, actionMap, workflowConfig);
    assert.equal(retry.results[0].status, "ok");
    assert.equal((retry.results[0].result as Record<string, unknown>).handle, handle);

    const atomicRequest: ParsedWorkflowRequest = {
      ...invalidRequest,
      steps: [{
        fn: "responseGet",
        action: "response.get",
        args: { handle, jsonPath: "evidence[0]" },
      }],
    };
    const atomic = await executeWorkflow(atomicRequest, actionMap, workflowConfig);
    const projectedAtomic = projectToolResultForModelContent(
      "sdl.workflow",
      atomic,
      { repoId: "repo-a", steps: atomicRequest.steps },
    ) as { results: Array<{ result: { range?: unknown } }> };
    assert.ok(projectedAtomic.results[0].result.range);

    const boundedFailure = await executeWorkflow(
      {
        ...invalidRequest,
        steps: [{
          fn: "responseGet",
          action: "response.get",
          args: { handle, jsonPath: "taskType", maxBytes: 2 },
        }],
      },
      actionMap,
      workflowConfig,
    );
    const trace = boundedFailure.results[0].failureTrace;
    assert.equal(boundedFailure.results[0].status, "error");
    assert.equal(trace?.kind, "gateway");
    assert.match(
      trace?.message ?? "",
      /JSON path string exceeds the requested bound/,
    );
    assert.match(
      trace?.message ?? "",
      /increase maxBytes and\/or maxTokens/,
    );
    assert.match(trace?.message ?? "", /omit jsonPath and use raw:true/);
    assert.match(trace?.message ?? "", /artifact byte excerpt/);
    assert.doesNotMatch(trace?.message ?? "", /internal error/i);
  });
});
