import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { registerCodeModeTools } from "../../src/code-mode/index.js";

describe("code-mode tool validation", () => {
  it("throws a validation error for semantically invalid sdl.chain requests", async () => {
    let chainHandler: ((args: unknown) => Promise<unknown>) | null = null;
    const fakeServer = {
      registerTool(
        name: string,
        _description: string,
        _schema: unknown,
        handler: (args: unknown) => Promise<unknown>,
      ) {
        if (name === "sdl.chain") {
          chainHandler = handler;
        }
      },
    };

    registerCodeModeTools(
      fakeServer as any,
      { liveIndex: undefined } as any,
      {
        enabled: true,
        exclusive: false,
        maxChainSteps: 20,
        maxChainTokens: 50_000,
        maxChainDurationMs: 30_000,
        ladderValidation: "warn",
        etagCaching: true,
      },
    );

    assert.ok(chainHandler);
    await assert.rejects(
      () =>
        chainHandler?.({
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
          validationError.message?.includes("Invalid sdl.chain request"),
        );
        assert.ok(
          validationError.details?.some((detail) =>
            detail.includes("Unknown function 'notARealFunction'"),
          ),
        );
        return true;
      },
    );
  });
});
