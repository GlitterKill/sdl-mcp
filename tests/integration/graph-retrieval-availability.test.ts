import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { handleRetrieve } from "../../dist/code-mode/retrieve.js";
import { invalidateConfigCache } from "../../dist/config/loadConfig.js";
import {
  closeLadybugDb,
  initLadybugDb,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import { withTransaction } from "../../dist/db/ladybug-core.js";
import * as derivedState from "../../dist/db/ladybug-derived-state.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import type { ActionMap } from "../../dist/gateway/router.js";
import {
  createGraphIntegrityExpectationFromManifest,
  createGraphIntegrityFileState,
} from "../../dist/indexer/provider-first/persisted-graph-integrity.js";
import {
  handleSliceBuild,
} from "../../dist/mcp/tools/slice.js";
import {
  handleSymbolGetCard,
  handleSymbolSearch,
} from "../../dist/mcp/tools/symbol.js";
import { SymbolSearchRequestSchema } from "../../dist/mcp/tools.js";

describe("graph retrieval availability", { concurrency: 1 }, () => {
  const root = mkdtempSync(join(tmpdir(), "sdl-graph-retrieval-"));
  const dbPath = join(root, "graph.lbug");
  const configPath = join(root, "sdlmcp.config.json");
  const originalConfig = process.env.SDL_CONFIG;
  const originalDbPath = process.env.SDL_GRAPH_DB_PATH;

  async function seedRepo(
    repoId: string,
    state: "verified" | "verifying" | "failed" | "unknown",
  ): Promise<string> {
    const fileId = `${repoId}:src/alpha.ts`;
    const symbolId = `${repoId}:alpha`;
    const versionId = `${repoId}:v1`;
    const symbol = {
      symbolId,
      repoId,
      fileId,
      kind: "function",
      name: "alpha",
      exported: true,
      visibility: "public",
      language: "typescript",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 1,
      rangeEndCol: 27,
      astFingerprint: `${repoId}:fingerprint`,
      signatureJson: '{"name":"alpha"}',
      summary: "Returns one",
      invariantsJson: null,
      sideEffectsJson: null,
      source: "scip",
      scipSymbol: `scip-typescript npm fixture 1.0.0 ${repoId}/alpha().`,
      updatedAt: "2026-07-21T00:00:00.000Z",
    };
    const manifestFile = createGraphIntegrityFileState(
      repoId,
      fileId,
      "src/alpha.ts",
      [symbol],
      [],
    );
    const expectation = createGraphIntegrityExpectationFromManifest(
      [manifestFile],
      [],
    );

    await withWriteConn((conn) =>
      withTransaction(conn, async () => {
        await ladybugDb.upsertRepo(conn, {
          repoId,
          rootPath: root,
          configJson: JSON.stringify({
            repoId,
            rootPath: root,
            ignore: [],
            languages: ["ts"],
            maxFileBytes: 2_000_000,
          }),
          createdAt: "2026-07-21T00:00:00.000Z",
        });
        await ladybugDb.upsertFile(conn, {
          fileId,
          repoId,
          relPath: "src/alpha.ts",
          contentHash: "a".repeat(64),
          language: "typescript",
          byteSize: 27,
          lastIndexedAt: "2026-07-21T00:00:00.000Z",
        });
        await ladybugDb.upsertKnownFileSymbols(conn, [symbol]);
        await ladybugDb.createVersion(conn, {
          versionId,
          repoId,
          createdAt: "2026-07-21T00:00:00.000Z",
          reason: "test",
          prevVersionHash: null,
          versionHash: null,
        });
        if (state !== "unknown") {
          await ladybugDb.replaceGraphIntegrityManifestInTransaction(
            conn,
            repoId,
            { files: [manifestFile], fileless: [] },
          );
          await derivedState.beginGraphIntegrityVersion(
            conn,
            repoId,
            versionId,
            expectation.digest,
            true,
          );
          if (state !== "verified") {
            assert.equal(
              await derivedState.advanceGraphIntegrityRevisionInTransaction(
                conn,
                repoId,
                versionId,
                0,
              ),
              1,
            );
          }
        }
      }),
    );
    if (state === "failed") {
      await derivedState.markGraphIntegrityFailedIfVerifying(
        repoId,
        versionId,
        1,
        "test failure",
      );
    }
    return symbolId;
  }

  before(async () => {
    writeFileSync(
      join(root, "alpha.ts"),
      "export function alpha() { return 1; }\n",
      "utf8",
    );
    writeFileSync(
      configPath,
      JSON.stringify({ repos: [], policy: {}, semantic: { enabled: false } }),
      "utf8",
    );
    process.env.SDL_CONFIG = configPath;
    process.env.SDL_GRAPH_DB_PATH = dbPath;
    invalidateConfigCache();
    await closeLadybugDb();
    await initLadybugDb(dbPath);
    await seedRepo("verified", "verified");
    await seedRepo("verifying", "verifying");
    await seedRepo("failed", "failed");
    await seedRepo("unknown", "unknown");
  });

  after(async () => {
    await closeLadybugDb();
    if (originalConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = originalConfig;
    if (originalDbPath === undefined) delete process.env.SDL_GRAPH_DB_PATH;
    else process.env.SDL_GRAPH_DB_PATH = originalDbPath;
    invalidateConfigCache();
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it("keeps verified symbol-card responses byte-identical", async () => {
    const request = {
      repoId: "verified",
      symbolId: "verified:alpha",
      refsMode: "off" as const,
    };
    const first = await handleSymbolGetCard(request);
    const second = await handleSymbolGetCard(request);
    assert.equal(JSON.stringify(second), JSON.stringify(first));
    assert.doesNotMatch(JSON.stringify(first), /graphIntegrity/);
  });

  it("allows real symbol, slice, and retrieve handlers for current verifying and failed graphs", async () => {
    const actionMap = {
      "symbol.search": {
        schema: SymbolSearchRequestSchema,
        handler: handleSymbolSearch,
      },
    } as ActionMap;

    for (const repoId of ["verifying", "failed"]) {
      const search = await handleSymbolSearch({
        repoId,
        query: "alpha",
        semantic: false,
        limit: 5,
      });
      assert.ok(
        Array.isArray(search.results) &&
          search.results.some((match) => match.name === "alpha"),
        repoId,
      );

      const slice = await handleSliceBuild({
        repoId,
        entrySymbols: [`${repoId}:alpha`],
        budget: { maxCards: 4, maxEstimatedTokens: 2_000 },
      });
      assert.ok("sliceHandle" in slice, repoId);

      const retrieved = await handleRetrieve(
        {
          repoId,
          op: "symbolSearch",
          args: { query: "alpha", semantic: false, limit: 5 },
        },
        actionMap,
      );
      assert.match(JSON.stringify(retrieved), /alpha/);
    }
  });

  it("fails real symbol, slice, and retrieve handlers closed for unknown no-manifest state", async () => {
    const actionMap = {
      "symbol.search": {
        schema: SymbolSearchRequestSchema,
        handler: handleSymbolSearch,
      },
    } as ActionMap;
    const unavailable = (error: unknown): boolean => {
      const typed = error as { code?: string; message?: string };
      return (
        typed.code === "INDEX_ERROR" &&
        /mode:"full"/.test(typed.message ?? "") &&
        !/[A-Z]:\\|\.lbug|revision \d/i.test(typed.message ?? "")
      );
    };

    await assert.rejects(
      () =>
        handleSymbolSearch({
          repoId: "unknown",
          query: "alpha",
          semantic: false,
        }),
      unavailable,
    );
    await assert.rejects(
      () =>
        handleSliceBuild({
          repoId: "unknown",
          entrySymbols: ["unknown:alpha"],
          budget: { maxCards: 4, maxEstimatedTokens: 2_000 },
        }),
      unavailable,
    );
    await assert.rejects(
      () =>
        handleRetrieve(
          {
            repoId: "unknown",
            op: "symbolSearch",
            args: { query: "alpha", semantic: false },
          },
          actionMap,
        ),
      unavailable,
    );
  });
});
