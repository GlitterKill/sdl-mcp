import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { registerCodeModeTools } from "../../dist/code-mode/index.js";

describe("code-mode tool validation", () => {
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
});
