import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerCodeModeTools } from "../../dist/code-mode/index.js";
import { invalidateConfigCache } from "../../dist/config/loadConfig.js";
import { AgentContextRequestSchema } from "../../dist/mcp/tools.js";

describe("code-mode tool validation", () => {
  it("maps sdl.context budget.maxEstimatedTokens to maxTokens", () => {
    const parsed = AgentContextRequestSchema.parse({
      repoId: "demo-repo",
      taskType: "explain",
      taskText: "explain handleSymbolSearch",
      budget: { maxEstimatedTokens: 1234 },
    });

    assert.deepEqual(parsed.budget, { maxTokens: 1234 });
  });

  it("rejects sdl.context budget.maxCards instead of silently ignoring it", () => {
    assert.throws(
      () =>
        AgentContextRequestSchema.parse({
          repoId: "demo-repo",
          taskType: "explain",
          taskText: "explain handleSymbolSearch",
          budget: { maxCards: 5 },
        }),
      /sdl\.context budget does not support maxCards/,
    );
  });

  it("rejects unknown sdl.context budget fields", () => {
    const result = AgentContextRequestSchema.safeParse({
      repoId: "demo-repo",
      taskType: "explain",
      taskText: "explain handleSymbolSearch",
      budget: { maxTotalTokens: 1234 },
    });

    assert.equal(result.success, false);
    if (result.success) return;
    const issue = result.error.issues[0];
    assert.equal(issue?.code, "unrecognized_keys");
    assert.deepEqual(issue?.path, ["budget"]);
    assert.deepEqual(
      "keys" in issue ? issue.keys : undefined,
      ["maxTotalTokens"],
    );
  });

  it("accepts sdl.context evidenceOptimization budgeted option", () => {
    const parsed = AgentContextRequestSchema.parse({
      repoId: "demo-repo",
      taskType: "explain",
      taskText: "explain handleSymbolSearch",
      options: { evidenceOptimization: "budgeted" },
    });

    assert.equal(parsed.options?.evidenceOptimization, "budgeted");
  });
  it("accepts sdl.context cardDetail full option", () => {
    const parsed = AgentContextRequestSchema.parse({
      repoId: "demo-repo",
      taskType: "implement",
      taskText: "explain handleSymbolSearch",
      options: { cardDetail: "full" },
    });

    assert.equal(parsed.options?.cardDetail, "full");
  });

  it("accepts sdl.context evidenceOptimization global option", () => {
    const parsed = AgentContextRequestSchema.parse({
      repoId: "demo-repo",
      taskType: "explain",
      taskText: "explain handleSymbolSearch",
      options: { contextMode: "broad", evidenceOptimization: "global" },
    });

    assert.equal(parsed.options?.evidenceOptimization, "global");
  });

  it("rejects invalid sdl.context evidenceOptimization options", () => {
    assert.throws(
      () =>
        AgentContextRequestSchema.parse({
          repoId: "demo-repo",
          taskType: "explain",
          taskText: "explain handleSymbolSearch",
          options: { evidenceOptimization: "knapsack" },
        }),
      (error: unknown) => {
        const issue = (error as { issues?: Array<{ path?: unknown[]; values?: unknown[] }> })
          .issues?.[0];
        assert.deepEqual(issue?.path, ["options", "evidenceOptimization"]);
        assert.deepEqual(issue?.values, ["off", "dedupe", "budgeted", "global"]);
        return true;
      },
    );
  });

  it("advertises plan-bound file window operations in sdl.file wire schema", () => {
    let fileWireSchema: { properties?: Record<string, unknown> } | null = null;
    const fakeServer = {
      registerTool(
        name: string,
        _description: string,
        _schema: unknown,
        _handler: (args: unknown) => Promise<unknown>,
        wireSchema?: unknown,
      ) {
        if (name === "sdl.file") {
          fileWireSchema = wireSchema as { properties?: Record<string, unknown> };
        }
      },
    };

    registerCodeModeTools(
      fakeServer as any,
      { liveIndex: undefined } as any,
      {
        enabled: true,
        exclusive: false,
        maxWorkflowSteps: 20,
        maxWorkflowTokens: 50_000,
        maxWorkflowDurationMs: 30_000,
        ladderValidation: "warn",
        etagCaching: true,
      },
    );

    const properties = fileWireSchema?.properties as
      | Record<string, { enum?: string[] } | unknown>
      | undefined;
    assert.ok(properties);
    assert.deepEqual((properties.op as { enum: string[] }).enum, [
      "read",
      "write",
      "searchEditPreview",
      "searchEditApply",
      "symbolEditPreview",
      "symbolEditApply",
      "symbolEditApplyNow",
      "previewWindow",
      "sourceWindow",
    ]);
    for (const field of [
      "symbolId",
      "symbolRef",
      "operation",
      "expectedAstFingerprint",
      "expectedRange",
      "reason",
      "expectedLines",
      "identifiersToFind",
      "granularity",
      "maxTokens",
      "sliceContext",
      "cursor",
      "ifNoneMatch",
    ]) {
      assert.ok(field in properties, `missing ${field}`);
    }
  });

  it("includes plan-bound file window operations in sdl.manual schema output", async () => {
    let manualHandler: ((args: unknown) => Promise<unknown>) | null = null;
    const fakeServer = {
      registerTool(
        name: string,
        _description: string,
        _schema: unknown,
        handler: (args: unknown) => Promise<unknown>,
      ) {
        if (name === "sdl.manual") {
          manualHandler = handler;
        }
      },
    };

    registerCodeModeTools(
      fakeServer as any,
      { liveIndex: undefined } as any,
      {
        enabled: true,
        exclusive: false,
        maxWorkflowSteps: 20,
        maxWorkflowTokens: 50_000,
        maxWorkflowDurationMs: 30_000,
        ladderValidation: "warn",
        etagCaching: true,
      },
    );

    assert.ok(manualHandler);
    const response = (await manualHandler({
      format: "json",
      actions: ["file"],
      includeSchemas: true,
      includeExamples: true,
    })) as {
      actions: Array<{
        action: string;
        example?: Record<string, unknown>;
        schemaSummary?: { fields: Array<{ name: string; enumValues?: string[] }> };
      }>;
    };

    const fileAction = response.actions.find((action) => action.action === "file");
    assert.ok(fileAction);
    assert.equal(fileAction.example?.op, "previewWindow");
    const opField = fileAction.schemaSummary?.fields.find(
      (field) => field.name === "op",
    );
    assert.deepEqual(opField?.enumValues, [
      "read",
      "write",
      "searchEditPreview",
      "searchEditApply",
      "symbolEditPreview",
      "symbolEditApply",
      "symbolEditApplyNow",
      "previewWindow",
      "sourceWindow",
    ]);
  });

  it("routes plan-bound file window operations through the sdl.file handler", async () => {
    let fileHandler: ((args: unknown) => Promise<unknown>) | null = null;
    const fakeServer = {
      registerTool(
        name: string,
        _description: string,
        _schema: unknown,
        handler: (args: unknown) => Promise<unknown>,
      ) {
        if (name === "sdl.file") {
          fileHandler = handler;
        }
      },
    };

    registerCodeModeTools(
      fakeServer as any,
      { liveIndex: undefined } as any,
      {
        enabled: true,
        exclusive: false,
        maxWorkflowSteps: 20,
        maxWorkflowTokens: 50_000,
        maxWorkflowDurationMs: 30_000,
        ladderValidation: "warn",
        etagCaching: true,
      },
    );

    assert.ok(fileHandler);
    const handler = fileHandler;
    for (const op of ["previewWindow", "sourceWindow"] as const) {
      await assert.rejects(
        () =>
          handler({
            op,
            repoId: "demo-repo",
            planHandle: "missing-plan",
            symbolId: "deadbeef",
            reason: "Inspect planned source edit",
            expectedLines: 12,
            identifiersToFind: ["targetFunction"],
          }),
        (error: unknown) => {
          const notFound = error as { name?: string; message?: string };
          assert.equal(notFound.name, "NotFoundError");
          assert.match(
            notFound.message ?? "",
            /Edit plan not found or expired: missing-plan/,
          );
          return true;
        },
      );
    }
  });

  it("throws a validation error for semantically invalid sdl.workflow requests", async () => {
    let workflowHandler: ((args: unknown) => Promise<unknown>) | null = null;
    const fakeServer = {
      registerTool(
        name: string,
        _description: string,
        _schema: unknown,
        handler: (args: unknown) => Promise<unknown>,
      ) {
        if (name === "sdl.workflow") {
          workflowHandler = handler;
        }
      },
    };

    registerCodeModeTools(
      fakeServer as any,
      { liveIndex: undefined } as any,
      {
        enabled: true,
        exclusive: false,
        maxWorkflowSteps: 20,
        maxWorkflowTokens: 50_000,
        maxWorkflowDurationMs: 30_000,
        ladderValidation: "warn",
        etagCaching: true,
      },
    );

    assert.ok(workflowHandler);
    await assert.rejects(
      () =>
        workflowHandler?.({
          repoId: "demo-repo",
          onError: "stop",
          steps: [{ fn: "notARealFunction", args: {} }],
        }),
      (error: unknown) => {
        const validationError = error as {
          code?: string;
          details?: string[];
          message?: string;
        };
        assert.strictEqual(validationError.code, "VALIDATION_ERROR");
        assert.ok(
          validationError.message?.includes("Invalid sdl.workflow request"),
        );
        assert.ok(
          validationError.details?.some((detail) =>
            detail.includes("unknown function 'notARealFunction'"),
          ),
        );
        return true;
      },
    );
  });

  it("omits disabled memory tools from sdl.manual catalog output", async () => {
    let manualHandler: ((args: unknown) => Promise<unknown>) | null = null;
    const fakeServer = {
      registerTool(
        name: string,
        _description: string,
        _schema: unknown,
        handler: (args: unknown) => Promise<unknown>,
      ) {
        if (name === "sdl.manual") {
          manualHandler = handler;
        }
      },
    };

    const originalSdlConfig = process.env.SDL_CONFIG;
    const tmpDir = mkdtempSync(join(tmpdir(), "sdl-manual-disabled-"));
    try {
      const configPath = join(tmpDir, "config.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          repos: [
            { repoId: "test", rootPath: tmpDir, memory: { enabled: false } },
          ],
          policy: {},
        }),
      );
      process.env.SDL_CONFIG = configPath;
      invalidateConfigCache();

      registerCodeModeTools(
        fakeServer as any,
        { liveIndex: undefined } as any,
        {
          enabled: true,
          exclusive: false,
          maxWorkflowSteps: 20,
          maxWorkflowTokens: 50_000,
          maxWorkflowDurationMs: 30_000,
          ladderValidation: "warn",
          etagCaching: true,
        },
      );

      assert.ok(manualHandler);
      const response = (await manualHandler({
        format: "json",
        includeSchemas: false,
        includeExamples: false,
      })) as { actions: Array<{ action: string; disabled?: boolean }> };

      assert.equal(
        response.actions.some((action) => action.disabled),
        false,
      );
      assert.equal(
        response.actions.some((action) => action.action.startsWith("memory.")),
        false,
      );
    } finally {
      if (originalSdlConfig !== undefined) {
        process.env.SDL_CONFIG = originalSdlConfig;
      } else {
        delete process.env.SDL_CONFIG;
      }
      invalidateConfigCache();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
