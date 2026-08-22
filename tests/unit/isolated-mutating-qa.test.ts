import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function loadRunner() {
  return import("../../scripts/run-isolated-mutating-qa.mjs");
}

describe("isolated mutating QA runner", () => {
  it("reports structured child tool failures without undefined fields", async () => {
    const { assertToolSucceeded } = await loadRunner();

    assert.throws(
      () =>
        assertToolSucceeded("sdl.file", {
          isError: true,
          content: [
            { type: "text", text: "" },
            { type: "text", text: "Invalid tool arguments" },
            { type: "text", text: "ignored" },
          ],
          structuredContent: {
            error: {
              code: "VALIDATION_ERROR",
            },
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /QA tool failed: sdl\.file/);
        assert.match(error.message, /isError=true/);
        assert.match(error.message, /code=VALIDATION_ERROR/);
        assert.match(error.message, /classification=invalid_input/);
        assert.doesNotMatch(error.message, /Invalid tool arguments/);
        assert.doesNotMatch(error.message, /ignored/);
        return true;
      },
    );

    assert.throws(
      () =>
        assertToolSucceeded("sdl.file", {
          content: [],
          structuredContent: { error: {} },
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "QA tool failed: sdl.file");
        assert.doesNotMatch(error.message, /undefined/);
        return true;
      },
    );
  });

  it("bounds failure diagnostics and omits arbitrary tool text", async () => {
    const {
      assertToolSucceeded,
      QA_TOOL_FAILURE_MESSAGE_MAX_CHARS,
    } = await loadRunner();
    const sentinel = "SENTINEL_SECRET_MUST_NOT_LEAK";
    const arbitraryText = `${"x".repeat(5_000)}${sentinel}`;

    assert.throws(
      () =>
        assertToolSucceeded("sdl.workflow", {
          isError: true,
          content: [{ type: "text", text: arbitraryText }],
          structuredContent: {
            results: [
              {
                stepIndex: 0,
                fn: "fileWrite",
                status: "error",
                error: "child exploded",
              },
            ],
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.length <= 2_000);
        assert.doesNotMatch(error.message, new RegExp(sentinel));
        assert.match(error.message, /QA tool failed: sdl\.workflow/);
        assert.match(error.message, /isError=true/);
        assert.match(error.message, /structured=/);
        assert.match(error.message, /"fn":"fileWrite"/);
        assert.match(error.message, /child exploded/);
        assert.equal(QA_TOOL_FAILURE_MESSAGE_MAX_CHARS, 2_000);
        return true;
      },
    );

    assert.throws(
      () =>
        assertToolSucceeded("sdl.file", {
          isError: true,
          content: [{ type: "text", text: arbitraryText }],
          structuredContent: {
            error: {
              message: "safe structured failure",
              code: "VALIDATION_ERROR",
              classification: "invalid_input",
              details: { field: "content" },
            },
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(
          error.message.length <= QA_TOOL_FAILURE_MESSAGE_MAX_CHARS,
        );
        assert.doesNotMatch(error.message, new RegExp(sentinel));
        assert.match(error.message, /QA tool failed: sdl\.file/);
        assert.match(error.message, /isError=true/);
        assert.match(error.message, /structured=/);
        assert.match(error.message, /safe structured failure/);
        assert.match(error.message, /"details":\{"field":"content"\}/);
        return true;
      },
    );
  });

  it("preflights only top-level scenario tools and explains missing Code Mode", async () => {
    const { assertScenarioToolsAvailable } = await loadRunner();

    assert.doesNotThrow(() =>
      assertScenarioToolsAvailable(
        { tools: [{ name: "sdl.info" }, { name: "sdl.workflow" }] },
        [
          {
            tool: "sdl.workflow",
            arguments: {
              repoId: "qa",
              steps: [{ fn: "fileRead", args: {} }],
            },
          },
        ],
      ),
    );

    assert.throws(
      () =>
        assertScenarioToolsAvailable(
          { tools: [{ name: "sdl.info" }] },
          [
            { tool: "sdl.file", arguments: {} },
            { tool: "sdl.retrieve", arguments: {} },
            { tool: "sdl.workflow", arguments: {} },
          ],
        ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /sdl\.file/);
        assert.match(error.message, /sdl\.retrieve/);
        assert.match(error.message, /sdl\.workflow/);
        assert.match(error.message, /Code Mode is unavailable/);
        assert.doesNotMatch(error.message, /fileRead/);
        return true;
      },
    );
  });

  it("rejects any QA database path in an active database family", async () => {
    const { assertDistinctDatabaseFamilies } = await loadRunner();
    const root = mkdtempSync(join(tmpdir(), "sdl-qa-family-"));
    tempRoots.push(root);
    const activePath = join(root, "active.lbug");

    assert.throws(
      () =>
        assertDistinctDatabaseFamilies(
          `${activePath}.wal.checkpoint`,
          [activePath],
        ),
      /database family/i,
    );
    assert.doesNotThrow(() =>
      assertDistinctDatabaseFamilies(join(root, "qa.lbug"), [activePath]),
    );
  });

  it("retains the QA fixture when any database-family sidecar remains", async () => {
    const { assertNoDatabaseSidecars } = await loadRunner();
    const root = mkdtempSync(join(tmpdir(), "sdl-qa-sidecar-"));
    tempRoots.push(root);
    const qaPath = join(root, "qa.lbug");
    writeFileSync(qaPath, "database");
    writeFileSync(`${qaPath}.wal.quarantine-1`, "unexpected-sidecar");

    assert.throws(() => assertNoDatabaseSidecars(qaPath), /retained sidecars/i);
  });

  it("passes only one LadybugDB path override to the owned child", async () => {
    const { buildIsolatedChildEnv } = await loadRunner();
    const qaPath = resolve("qa.lbug");

    const env = buildIsolatedChildEnv(
      {
        PATH: "kept",
        SDL_GRAPH_DB_PATH: "active",
        SDL_GRAPH_DB_DIR: "active-dir",
        SDL_DB_PATH: "legacy-active",
      },
      qaPath,
    );

    assert.equal(env.PATH, "kept");
    assert.equal(env.SDL_GRAPH_DB_PATH, qaPath);
    assert.equal("SDL_GRAPH_DB_DIR" in env, false);
    assert.equal("SDL_DB_PATH" in env, false);
  });

  it("requires every configured or scenario repository root to stay in the fixture", async () => {
    const { assertQaInputsContained } = await loadRunner();
    const root = mkdtempSync(join(tmpdir(), "sdl-qa-contained-"));
    tempRoots.push(root);
    const fixtureRoot = join(root, "fixture");
    const repoRoot = join(fixtureRoot, "repo");
    const outsideRoot = join(root, "outside");
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(outsideRoot, { recursive: true });

    assert.doesNotThrow(() =>
      assertQaInputsContained(
        { repos: [{ repoId: "qa", rootPath: repoRoot }] },
        [
          {
            tool: "sdl.repo.register",
            arguments: { repoId: "qa", rootPath: repoRoot },
          },
        ],
        fixtureRoot,
      ),
    );
    assert.throws(
      () =>
        assertQaInputsContained(
          { repos: [{ repoId: "outside", rootPath: outsideRoot }] },
          [],
          fixtureRoot,
        ),
      /fixture root/i,
    );
  });

  it("rejects arbitrary runtime execution and external endpoints", async () => {
    const { validateScenario } = await loadRunner();

    assert.throws(
      () =>
        validateScenario([
          {
            tool: "sdl.workflow",
            arguments: {
              repoId: "qa",
              steps: [{ fn: "runtimeExecute", args: { runtime: "node" } }],
            },
          },
        ]),
      /runtime/i,
    );
    assert.throws(
      () =>
        validateScenario([
          {
            tool: "sdl.file",
            arguments: { endpoint: "https://example.test" },
          },
        ]),
      /endpoint/i,
    );
    assert.deepEqual(
      validateScenario([
        {
          tool: "sdl.repo.register",
          arguments: { repoId: "qa", rootPath: resolve("fixture") },
        },
        {
          tool: "sdl.index.refresh",
          arguments: { repoId: "qa", mode: "full" },
        },
      ]),
      [
        {
          tool: "sdl.repo.register",
          arguments: { repoId: "qa", rootPath: resolve("fixture") },
        },
        {
          tool: "sdl.index.refresh",
          arguments: { repoId: "qa", mode: "full" },
        },
      ],
    );
  });
  it("exposes the isolated QA command through npm", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };

    assert.equal(
      pkg.scripts?.["qa:isolated"],
      "npm run build && node scripts/run-isolated-mutating-qa.mjs",
    );
  });
});
