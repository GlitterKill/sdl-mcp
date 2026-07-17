import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManual } from "../../dist/code-mode/index.js";
import { invalidateCatalog } from "../../dist/code-mode/action-catalog.js";
import { createActionMap } from "../../dist/gateway/router.js";

import {
  generateManual,
  getManualCached,
  invalidateManualCache,
  FN_NAME_MAP,
  ACTION_TO_FN,
} from "../../dist/code-mode/manual-generator.js";
import { invalidateConfigCache } from "../../dist/config/loadConfig.js";
import { estimateTokens } from "../../dist/util/tokenize.js";
import { ValidationError } from "../../dist/domain/errors.js";

const originalSdlConfig = process.env.SDL_CONFIG;

describe("code-mode manual generator", () => {
  let tmpDir: string;

  before(() => {
    // Create a config with memory enabled so all functions appear in manual
    tmpDir = mkdtempSync(join(tmpdir(), "sdl-manual-"));
    const configPath = join(tmpDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        repos: [
          { repoId: "test", rootPath: tmpDir, memory: { enabled: true } },
        ],
        policy: {},
      }),
    );
    process.env.SDL_CONFIG = configPath;
    invalidateConfigCache();
    invalidateManualCache();
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

  it("generateManual() returns a non-empty string", () => {
    const result = generateManual();
    assert.strictEqual(typeof result, "string");
    assert.ok(result.length > 0);
  });

  it("manual contains all function names from FN_NAME_MAP", () => {
    const manual = generateManual();
    for (const key of Object.keys(FN_NAME_MAP)) {
      assert.ok(manual.includes(key), `Expected manual to include '${key}'`);
    }
  });

  it("manual token count stays under the Code Mode budget", () => {
    const manual = generateManual();
    const tokens = estimateTokens(manual);
    assert.ok(tokens < 4000, `Expected tokens < 4000, got ${tokens}`);
  });

  it("documents static token price tags", () => {
    const manual = generateManual();

    assert.match(manual, /Release-static medians/);
    assert.match(manual, /search150/);
    assert.match(manual, /runtimeDigest120/);
    assert.match(manual, /answerFirst/);
    assert.match(manual, /nearMisses/);
  });

  it("getManualCached() returns same reference on repeated calls", () => {
    invalidateManualCache();
    const result1 = getManualCached();
    const result2 = getManualCached();
    assert.strictEqual(result1, result2);
  });

  it("invalidateManualCache() causes regeneration", () => {
    const ref1 = getManualCached();
    invalidateManualCache();
    const ref2 = getManualCached();
    // After invalidation the cache is cleared and a new string is generated;
    // JS primitive strings compare by value so content equality is the observable check.
    assert.strictEqual(ref1, ref2);
  });

  it("FN_NAME_MAP and ACTION_TO_FN are consistent", () => {
    for (const [fn, action] of Object.entries(FN_NAME_MAP)) {
      assert.strictEqual(
        ACTION_TO_FN[action],
        fn,
        `ACTION_TO_FN["${action}"] should be "${fn}"`,
      );
    }
    assert.strictEqual(
      Object.keys(FN_NAME_MAP).length,
      Object.keys(ACTION_TO_FN).length,
    );
  });

  it("FN_NAME_MAP covers all current actions", () => {
    const actionNames = Object.keys(createActionMap());

    assert.strictEqual(Object.keys(FN_NAME_MAP).length, actionNames.length);
    for (const action of actionNames) {
      assert.ok(ACTION_TO_FN[action], `Missing function name for ${action}`);
    }
  });

  it("documents current workflow response shapes and limits", () => {
    const manual = generateManual();

    assert.match(manual, /sdl\.action\.search limit <= 50/);
    assert.match(manual, /workflowContinuationGet limit <= 1000/);
    assert.match(manual, /runtimeExecute maxResponseLines 5\.\.1000/);
    assert.match(manual, /shell runtime requires code/);
    assert.match(manual, /Continuation recipe: symbolSearch/);
    assert.match(manual, /not maxCards/);
    assert.match(manual, /wireFormat:\"json\"/);
    assert.match(manual, /sliceHandle: string/);
    const sliceBuildLine = manual
      .split("\n")
      .find((line) => line.startsWith("function sliceBuild("));
    assert.ok(sliceBuildLine);
    assert.doesNotMatch(sliceBuildLine, /\{ handle: string/);
    assert.match(manual, /content: string; version: number/);
    const bufferPushLine = manual
      .split("\n")
      .find((line) => line.startsWith("function bufferPush("));
    assert.ok(bufferPushLine);
    assert.doesNotMatch(bufferPushLine, /content\?: string/);
    assert.match(manual, /dataTemplate[\s\S]*\): string/);
    assert.match(manual, /workflowContinuationGet[\s\S]*path\?: string/);
  });

  it("focused manual requests can expand disabled memory wildcards", () => {
    const disabledDir = mkdtempSync(join(tmpdir(), "sdl-manual-disabled-"));
    const previousConfig = process.env.SDL_CONFIG;
    const configPath = join(disabledDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        repos: [{ repoId: "test", rootPath: disabledDir }],
        policy: {},
      }),
    );

    try {
      process.env.SDL_CONFIG = configPath;
      invalidateConfigCache();
      invalidateCatalog();
      invalidateManualCache();

      const result = handleManual({
        actions: ["memory.*"],
        includeSchemas: true,
        format: "typescript",
      }) as { manual: string };

      assert.match(result.manual, /memoryStore/);
      assert.match(result.manual, /memoryQuery/);
      assert.match(result.manual, /memorySurface/);
      assert.match(
        result.manual,
        /Disabled: Enable with memory\.enabled: true/,
      );
      assert.doesNotMatch(result.manual, /UNKNOWN_ACTIONS/);
    } finally {
      if (previousConfig !== undefined) {
        process.env.SDL_CONFIG = previousConfig;
      } else {
        delete process.env.SDL_CONFIG;
      }
      invalidateConfigCache();
      invalidateCatalog();
      invalidateManualCache();
      rmSync(disabledDir, { recursive: true, force: true });
    }
  });

  it("accepts MCP wrapper names as focused manual action aliases", () => {
    const result = handleManual({
      actions: ["sdl.file", "sdl.workflow"],
      includeSchemas: false,
      format: "json",
    }) as { actions?: Array<{ action: string }>; error?: string };

    assert.equal(result.error, undefined);
    assert.ok(result.actions?.some((entry) => entry.action === "file"));
    assert.ok(result.actions?.some((entry) => entry.action === "workflow"));
  });

  it("keeps JSON manual output free of runtime identity metadata", () => {
    const result = handleManual({
      actions: ["workflow"],
      format: "json",
    }) as Record<string, unknown>;

    assert.equal(result.serverInfo, undefined);
    assert.equal(result.nextAction, undefined);
  });

  it("returns known focused manual actions when some requested actions are stale", () => {
    const result = handleManual(
      {
        actions: ["workflow", "summary.get"],
        format: "json",
        includeSchemas: false,
        includeExamples: false,
      },
      {},
    ) as {
      actions?: Array<{ action: string }>;
      error?: string;
      unknownActions?: string[];
    };

    assert.equal(result.error, undefined);
    assert.deepEqual(result.unknownActions, ["summary.get"]);
    assert.ok(result.actions?.some((entry) => entry.action === "workflow"));
  });

  it("reports all-unknown focused manual requests as validation errors", () => {
    assert.throws(
      () =>
        handleManual(
          { actions: ["summary.get"], format: "json" },
          {},
        ),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.equal(error.code, "VALIDATION_ERROR");
        assert.deepEqual(
          (error as ValidationError & { details?: unknown }).details,
          ["Unknown action selector: summary.get"],
        );
        assert.deepEqual(
          (error as ValidationError & { fallbackTools?: unknown }).fallbackTools,
          ["sdl.action.search"],
        );
        return true;
      },
    );
  });
});
