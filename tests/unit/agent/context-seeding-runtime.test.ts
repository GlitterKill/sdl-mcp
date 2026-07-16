import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type { AgentTask, ContextSeedResult } from "../../../dist/agent/types.js";

const REPO_ID = "context-seeding-runtime-repo";
const DB_PATH = join(
  tmpdir(),
  `.lbug-context-seeding-runtime-${process.pid}.lbug`,
);
const CONFIG_PATH = join(
  tmpdir(),
  `sdl-context-seeding-runtime-${process.pid}.json`,
);

let buildSeedContext: (task: AgentTask) => Promise<ContextSeedResult>;
let closeLadybugDb: () => Promise<void>;

const previousConfig = process.env.SDL_CONFIG;
const previousConfigPath = process.env.SDL_CONFIG_PATH;
const previousNativeDisabled = process.env.SDL_MCP_DISABLE_NATIVE_ADDON;

function removeTestFile(path: string): void {
  if (existsSync(path)) rmSync(path, { force: true });
}

function task(semantic: boolean | undefined): AgentTask {
  return {
    repoId: REPO_ID,
    taskType: "explain",
    taskText: "Explain quasar theta propagation",
    options: {
      contextMode: "broad",
      includeRetrievalEvidence: true,
      ...(semantic === undefined ? {} : { semantic }),
    },
  };
}

describe("context seeding runtime lanes", () => {
  before(async () => {
    removeTestFile(DB_PATH);
    removeTestFile(`${DB_PATH}.wal`);
    removeTestFile(CONFIG_PATH);

    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        repos: [],
        policy: {},
        semantic: {
          enabled: false,
          retrieval: {
            mode: "hybrid",
            fts: {
              enabled: true,
              indexName: "symbol_search_text_v1",
              topK: 16,
              conjunctive: false,
            },
            vector: { enabled: false },
          },
        },
        liveIndex: { enabled: false },
      }),
      "utf8",
    );
    process.env.SDL_CONFIG = CONFIG_PATH;
    delete process.env.SDL_CONFIG_PATH;
    // Windows FTS runtime loading uses the native addon's verified DLL
    // preloader even though retrieval itself remains TypeScript.
    if (process.platform === "win32") {
      delete process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
    }

    const [ladybug, queries, lifecycle, seeding] = await Promise.all([
      import("../../../dist/db/ladybug.js"),
      import("../../../dist/db/ladybug-queries.js"),
      import("../../../dist/retrieval/index-lifecycle.js"),
      import("../../../dist/agent/context-seeding.js"),
    ]);
    closeLadybugDb = ladybug.closeLadybugDb;
    buildSeedContext = seeding.buildSeedContext;

    await closeLadybugDb();
    await ladybug.initLadybugDb(DB_PATH);
    const conn = await ladybug.getLadybugConn();
    const now = "2026-07-16T00:00:00.000Z";

    await queries.upsertRepo(conn, {
      repoId: REPO_ID,
      rootPath: "C:/tmp/context-seeding-runtime-repo",
      configJson: "{}",
      createdAt: now,
    });
    await queries.upsertFile(conn, {
      fileId: "file-quasar",
      repoId: REPO_ID,
      relPath: "src/quasar.ts",
      contentHash: "quasar-hash",
      language: "ts",
      byteSize: 1,
      lastIndexedAt: now,
    });

    for (let index = 0; index < 4; index++) {
      await queries.upsertSymbol(conn, {
        symbolId: `symbol-quasar-${index}`,
        repoId: REPO_ID,
        fileId: "file-quasar",
        kind: "function",
        name: `quasarThetaPropagation${index}`,
        exported: true,
        visibility: "public",
        language: "typescript",
        rangeStartLine: index + 1,
        rangeStartCol: 0,
        rangeEndLine: index + 1,
        rangeEndCol: 1,
        astFingerprint: `quasar-${index}`,
        signatureJson: null,
        summary: `Quasar theta propagation candidate ${index}`,
        searchText: `quasar theta propagation candidate ${index}`,
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: now,
      });
    }

    let ftsReady = false;
    // The full suite creates FTS fixtures in parallel worker processes. Retry
    // the extension/index bootstrap so a transient native-loader race does not
    // turn this lane contract test into a setup failure.
    for (let attempt = 0; attempt < 5; attempt++) {
      const ensured = await lifecycle.ensureFtsIndexForNonEmptyTable(
        conn,
        "Symbol",
        "symbol_search_text_v1",
      );
      if (ensured.status === "created" || ensured.status === "exists") {
        ftsReady = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
    assert.equal(
      ftsReady,
      true,
      "runtime lane fixture requires a healthy symbol FTS index",
    );
  });

  after(async () => {
    await closeLadybugDb?.();
    removeTestFile(DB_PATH);
    removeTestFile(`${DB_PATH}.wal`);
    removeTestFile(CONFIG_PATH);

    if (previousConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = previousConfig;
    if (previousConfigPath === undefined) delete process.env.SDL_CONFIG_PATH;
    else process.env.SDL_CONFIG_PATH = previousConfigPath;
    if (previousNativeDisabled === undefined) {
      delete process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
    } else {
      process.env.SDL_MCP_DISABLE_NATIVE_ADDON = previousNativeDisabled;
    }
  });

  it("keeps bounded lexical fallback in forced semantic mode", async () => {
    const result = await buildSeedContext(task(true));

    assert.ok(
      result.sources.semantic >= 4,
      `fixture must fill semantic diversity reserve: ${JSON.stringify({ sources: result.sources, evidence: result.evidence })}`,
    );
    assert.ok(result.diagnosticTimings?.["seed.semanticEntitySearch"] !== undefined);
    assert.ok(result.diagnosticTimings?.["seed.lexicalFallback"] !== undefined);
  });

  it("preserves broad default semantic and lexical lanes", async () => {
    const result = await buildSeedContext(task(undefined));

    assert.ok(result.diagnosticTimings?.["seed.semanticEntitySearch"] !== undefined);
    assert.ok(result.diagnosticTimings?.["seed.lexicalFallback"] !== undefined);
  });

  it("preserves semantic false as lexical-only", async () => {
    const result = await buildSeedContext(task(false));

    assert.equal(result.diagnosticTimings?.["seed.semanticEntitySearch"], undefined);
    assert.ok(result.diagnosticTimings?.["seed.lexicalFallback"] !== undefined);
  });
});
