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
