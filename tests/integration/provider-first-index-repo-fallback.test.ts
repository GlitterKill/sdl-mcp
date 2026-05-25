import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { invalidateConfigCache } from "../../dist/config/loadConfig.js";
import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import {
  getGraphSnapshotStats,
  setGraphSnapshot,
} from "../../dist/graph/graphSnapshotCache.js";
import {
  getSliceCacheKey,
  getSliceCacheStats,
  setCachedSlice,
} from "../../dist/graph/sliceCache.js";
import { indexRepo } from "../../dist/indexer/indexer.js";
import { generateFileId } from "../../dist/util/hashing.js";
import { writeTestScipIndex } from "../fixtures/scip/builder.ts";

describe("provider-first indexRepo fallback", () => {
  const previousConfig = process.env.SDL_CONFIG;
  const previousConfigPath = process.env.SDL_CONFIG_PATH;
  let graphDbPath = "";
  let repoDir = "";
  let configPath = "";

  afterEach(async () => {
    await closeLadybugDb();
    invalidateConfigCache();
    if (previousConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = previousConfig;
    if (previousConfigPath === undefined) delete process.env.SDL_CONFIG_PATH;
    else process.env.SDL_CONFIG_PATH = previousConfigPath;
    for (const path of [graphDbPath, repoDir, configPath]) {
      if (path && existsSync(path)) {
        rmSync(path, { recursive: true, force: true });
      }
    }
    graphDbPath = "";
    repoDir = "";
    configPath = "";
  });

  it("uses legacy fallback in auto mode when SCIP provider execution fails", async () => {
    const repoId = await initIndexedRepo("auto");

    const result = await indexRepo(repoId, "full");

    assert.equal(result.providerFirst?.selectedPipeline, "providerFirst");
    assert.equal(result.providerFirstExecution?.status, "fallback");
    assert.match(
      result.providerFirstExecution?.reasons.join(" ") ?? "",
      /no file facts/i,
    );
    assert.ok(result.symbolsIndexed > 0);

    const conn = await getLadybugConn();
    const file = await ladybugDb.getFileByRepoPath(conn, repoId, "src/index.ts");
    assert.ok(file);
  });

  it("executes explicit providerFirst for a full SCIP-covered repository", async () => {
    const repoId = await initIndexedRepo("providerFirst", {
      scipFixture: "complete",
      seedStaleSymbol: true,
    });
    setGraphSnapshot(repoId, {
      symbols: new Map(),
      edges: [],
      clusters: new Map(),
    });
    setCachedSlice(
      getSliceCacheKey({
        repoId,
        versionId: "stale-version",
        taskText: "provider-first stale cache",
      }),
      {},
    );

    const result = await indexRepo(repoId, "full");

    assert.equal(result.providerFirst?.selectedPipeline, "providerFirst");
    assert.equal(result.providerFirstExecution?.status, "executed");
    assert.equal(result.filesProcessed, 1);
    assert.ok(result.symbolsIndexed >= 3);
    assert.equal(
      getGraphSnapshotStats().entries.some((entry) => entry.repoId === repoId),
      false,
    );
    assert.equal(getSliceCacheStats().currentSize, 0);

    const conn = await getLadybugConn();
    const symbols = await ladybugDb.queryAll<{
      name: string;
      source: string;
      external: boolean;
    }>(
      conn,
      `MATCH (s:Symbol)-[:SYMBOL_IN_REPO]->(:Repo {repoId: $repoId})
       RETURN s.name AS name,
              s.source AS source,
              s.external AS external
       ORDER BY name`,
      { repoId },
    );
    assert.deepEqual(symbols, [
      { name: "api", source: "scip", external: true },
      { name: "helper", source: "scip", external: false },
      { name: "main", source: "scip", external: false },
    ]);

    const staleCounts = await ladybugDb.querySingle<{
      symbols: unknown;
      metrics: unknown;
      embeddings: unknown;
      summaries: unknown;
      references: unknown;
      versions: unknown;
    }>(
      conn,
      `MATCH (s:Symbol)
       WHERE s.symbolId = $staleSymbolId
       WITH count(s) AS symbols
       MATCH (m:Metrics)
       WHERE m.symbolId = $staleSymbolId
       WITH symbols, count(m) AS metrics
       MATCH (e:SymbolEmbedding)
       WHERE e.symbolId = $staleSymbolId
       WITH symbols, metrics, count(e) AS embeddings
       MATCH (sc:SummaryCache)
       WHERE sc.symbolId = $staleSymbolId
       WITH symbols, metrics, embeddings, count(sc) AS summaries
       MATCH (sr:SymbolReference)
       WHERE sr.fileId = $fileId
       WITH symbols, metrics, embeddings, summaries, count(sr) AS references
       MATCH (sv:SymbolVersion)
       WHERE sv.symbolId = $staleSymbolId
       RETURN symbols,
              metrics,
              embeddings,
              summaries,
              references,
              count(sv) AS versions`,
      {
        staleSymbolId: `${repoId}:stale-symbol`,
        fileId: generateFileId(repoId, "src/index.ts"),
      },
    );
    assert.equal(ladybugDb.toNumber(staleCounts?.symbols), 0);
    assert.equal(ladybugDb.toNumber(staleCounts?.metrics), 0);
    assert.equal(ladybugDb.toNumber(staleCounts?.embeddings), 0);
    assert.equal(ladybugDb.toNumber(staleCounts?.summaries), 0);
    assert.equal(ladybugDb.toNumber(staleCounts?.references), 0);
    assert.equal(ladybugDb.toNumber(staleCounts?.versions), 0);

    const versionRow = await ladybugDb.querySingle<{ count: unknown }>(
      conn,
      `MATCH (sv:SymbolVersion {versionId: $versionId})
       RETURN count(sv) AS count`,
      { versionId: result.versionId },
    );
    assert.equal(ladybugDb.toNumber(versionRow?.count), 2);

    const repoRelRows = await ladybugDb.queryAll<{
      name: string;
      relCount: unknown;
    }>(
      conn,
      `MATCH (s:Symbol)-[r:SYMBOL_IN_REPO]->(:Repo {repoId: $repoId})
       WHERE s.external = false
       RETURN s.name AS name,
              count(r) AS relCount
       ORDER BY name`,
      { repoId },
    );
    assert.deepEqual(
      repoRelRows.map((row) => ({
        name: row.name,
        relCount: ladybugDb.toNumber(row.relCount),
      })),
      [
        { name: "helper", relCount: 1 },
        { name: "main", relCount: 1 },
      ],
    );

    const metricsRow = await ladybugDb.querySingle<{ count: unknown }>(
      conn,
      `MATCH (:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
       WHERE coalesce(s.symbolStatus, 'real') = 'real'
       MATCH (m:Metrics)
       WHERE m.symbolId = s.symbolId
       RETURN count(m) AS count`,
      { repoId },
    );
    assert.equal(ladybugDb.toNumber(metricsRow?.count), 2);

    const derivedState = await ladybugDb.querySingle<{
      clustersDirty: boolean;
      processesDirty: boolean;
      algorithmsDirty: boolean;
      lastError: string | null;
    }>(
      conn,
      `MATCH (d:DerivedState {repoId: $repoId})
       RETURN d.clustersDirty AS clustersDirty,
              d.processesDirty AS processesDirty,
              d.algorithmsDirty AS algorithmsDirty,
              d.lastError AS lastError`,
      { repoId },
    );
    assert.equal(derivedState?.clustersDirty, true);
    assert.equal(derivedState?.processesDirty, true);
    assert.equal(derivedState?.algorithmsDirty, true);
    assert.match(derivedState?.lastError ?? "", /call-edge proof is pending/i);
  });

  it("uses legacy fallback in auto mode when SCIP coverage is incomplete", async () => {
    const repoId = await initIndexedRepo("auto", {
      scipFixture: "complete",
      extraScannedFile: true,
    });

    const result = await indexRepo(repoId, "full");

    assert.equal(result.providerFirst?.selectedPipeline, "providerFirst");
    assert.equal(result.providerFirstExecution?.status, "fallback");
    assert.match(
      result.providerFirstExecution?.reasons.join(" ") ?? "",
      /did not cover 1 scanned file/i,
    );
    assert.ok(result.symbolsIndexed > 0);

    const conn = await getLadybugConn();
    const extraFile = await ladybugDb.getFileByRepoPath(
      conn,
      repoId,
      "src/extra.ts",
    );
    assert.ok(extraFile);
  });

  it("fails explicit providerFirst when SCIP coverage is incomplete", async () => {
    const repoId = await initIndexedRepo("providerFirst", {
      scipFixture: "complete",
      extraScannedFile: true,
    });

    await assert.rejects(
      () => indexRepo(repoId, "full"),
      /did not cover 1 scanned file/i,
    );
  });

  it("uses legacy fallback in auto mode when SCIP reports non-fatal failures", async () => {
    const repoId = await initIndexedRepo("auto", {
      scipFixture: "complete",
      includeMissingScipIndex: true,
    });

    const result = await indexRepo(repoId, "full");

    assert.equal(result.providerFirst?.selectedPipeline, "providerFirst");
    assert.equal(result.providerFirstExecution?.status, "fallback");
    assert.match(
      result.providerFirstExecution?.reasons.join(" ") ?? "",
      /SCIP index file not found/i,
    );
    assert.ok(result.symbolsIndexed > 0);
  });

  it("fails explicit providerFirst before writing when SCIP reports non-fatal failures", async () => {
    const repoId = await initIndexedRepo("providerFirst", {
      scipFixture: "complete",
      includeMissingScipIndex: true,
    });

    await assert.rejects(
      () => indexRepo(repoId, "full"),
      /SCIP index file not found/i,
    );

    const conn = await getLadybugConn();
    const symbolCount = await ladybugDb.querySingle<{ count: unknown }>(
      conn,
      `MATCH (s:Symbol)-[:SYMBOL_IN_REPO]->(:Repo {repoId: $repoId})
       WHERE s.source = 'scip'
       RETURN count(s) AS count`,
      { repoId },
    );
    assert.equal(ladybugDb.toNumber(symbolCount?.count), 0);
  });

  it("leaves old graph rows untouched when explicit providerFirst rejects coverage", async () => {
    const repoId = await initIndexedRepo("providerFirst", {
      scipFixture: "complete",
      extraScannedFile: true,
      seedRemovedFile: true,
    });

    await assert.rejects(
      () => indexRepo(repoId, "full"),
      /did not cover 1 scanned file/i,
    );

    const conn = await getLadybugConn();
    const removedFile = await ladybugDb.getFileByRepoPath(
      conn,
      repoId,
      "src/removed.ts",
    );
    assert.ok(removedFile);
    const removedSymbol = await ladybugDb.querySingle<{ count: unknown }>(
      conn,
      `MATCH (s:Symbol {symbolId: $symbolId})-[:SYMBOL_IN_REPO]->(:Repo {repoId: $repoId})
       RETURN count(s) AS count`,
      {
        repoId,
        symbolId: `${repoId}:removed-symbol`,
      },
    );
    assert.equal(ladybugDb.toNumber(removedSymbol?.count), 1);
  });

  it("fails explicit providerFirst before writing duplicate SCIP documents", async () => {
    const repoId = await initIndexedRepo("providerFirst", {
      scipFixture: "complete",
      duplicateProviderDoc: true,
    });

    await assert.rejects(
      () => indexRepo(repoId, "full"),
      /duplicate document facts/i,
    );

    const conn = await getLadybugConn();
    const symbolCount = await ladybugDb.querySingle<{ count: unknown }>(
      conn,
      `MATCH (s:Symbol)-[:SYMBOL_IN_REPO]->(:Repo {repoId: $repoId})
       WHERE s.source = 'scip'
       RETURN count(s) AS count`,
      { repoId },
    );
    assert.equal(ladybugDb.toNumber(symbolCount?.count), 0);
  });

  it("fails explicit providerFirst before writing duplicate SCIP symbols", async () => {
    const repoId = await initIndexedRepo("providerFirst", {
      scipFixture: "complete",
      duplicateProviderSymbol: true,
    });

    await assert.rejects(
      () => indexRepo(repoId, "full"),
      /duplicate symbols/i,
    );

    const conn = await getLadybugConn();
    const symbolCount = await ladybugDb.querySingle<{ count: unknown }>(
      conn,
      `MATCH (s:Symbol)-[:SYMBOL_IN_REPO]->(:Repo {repoId: $repoId})
       WHERE s.source = 'scip'
       RETURN count(s) AS count`,
      { repoId },
    );
    assert.equal(ladybugDb.toNumber(symbolCount?.count), 0);
  });

  async function initIndexedRepo(
    pipeline: "auto" | "providerFirst",
    options: {
      scipFixture?: "missing" | "complete";
      seedStaleSymbol?: boolean;
      extraScannedFile?: boolean;
      duplicateProviderDoc?: boolean;
      duplicateProviderSymbol?: boolean;
      includeMissingScipIndex?: boolean;
      seedRemovedFile?: boolean;
    } = {},
  ): Promise<string> {
    graphDbPath = mkdtempSync(join(tmpdir(), "sdl-provider-first-index-db-"));
    repoDir = mkdtempSync(join(tmpdir(), "sdl-provider-first-index-repo-"));
    configPath = join(
      tmpdir(),
      `sdl-provider-first-index-${pipeline}-${Date.now()}.json`,
    );
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(
      join(repoDir, "src", "index.ts"),
      [
        "export function main() {",
        "  return helper();",
        "}",
        "",
        "export function helper() {",
        "  return 1;",
        "}",
      ].join("\n"),
      "utf8",
    );
    if (options.extraScannedFile) {
      writeFileSync(
        join(repoDir, "src", "extra.ts"),
        ["export function extra() {", "  return 2;", "}"].join("\n"),
        "utf8",
      );
    }
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          repos: [],
          policy: {},
          indexing: {
            pipeline,
            engine: "typescript",
            enableFileWatching: false,
          },
          semantic: {
            generateSummaries: false,
          },
          scip: {
            enabled: true,
            indexes: [
              {
                path:
                  options.scipFixture === "complete"
                    ? "index.scip"
                    : "missing.scip",
              },
              ...(options.includeMissingScipIndex
                ? [{ path: "missing-extra.scip" }]
                : []),
            ],
            generator: {
              enabled: false,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    process.env.SDL_CONFIG = configPath;
    delete process.env.SDL_CONFIG_PATH;
    invalidateConfigCache();

    await initLadybugDb(graphDbPath);
    const repoId = `provider-first-${pipeline}`;
    await withWriteConn(async (conn) => {
      await ladybugDb.upsertRepo(conn, {
        repoId,
        rootPath: repoDir,
        configJson: JSON.stringify({
          repoId,
          rootPath: repoDir,
          ignore: [],
          languages: ["ts"],
          maxFileBytes: 2_000_000,
          includeNodeModulesTypes: true,
        }),
        createdAt: "2026-05-25T12:00:00.000Z",
      });
      if (options.seedStaleSymbol) {
        const fileId = generateFileId(repoId, "src/index.ts");
        const staleSymbolId = `${repoId}:stale-symbol`;
        await ladybugDb.upsertFile(conn, {
          fileId,
          repoId,
          relPath: "src/index.ts",
          contentHash: "stale",
          language: "typescript",
          byteSize: 1,
          lastIndexedAt: "2026-05-25T12:00:00.000Z",
        });
        await ladybugDb.upsertSymbol(conn, {
          symbolId: staleSymbolId,
          repoId,
          fileId,
          kind: "function",
          name: "staleLegacy",
          exported: true,
          visibility: "public",
          language: "typescript",
          rangeStartLine: 1,
          rangeStartCol: 0,
          rangeEndLine: 1,
          rangeEndCol: 1,
          astFingerprint: "stale",
          signatureJson: "{}",
          summary: null,
          invariantsJson: null,
          sideEffectsJson: null,
          updatedAt: "2026-05-25T12:00:00.000Z",
        });
        await ladybugDb.exec(
          conn,
          `CREATE (:Metrics {
             symbolId: $symbolId,
             fanIn: 1,
             fanOut: 1,
             churn30d: 0,
             testRefsJson: '[]',
             canonicalTestJson: null,
             updatedAt: '2026-05-25T12:00:00.000Z'
           })`,
          { symbolId: staleSymbolId },
        );
        await ladybugDb.exec(
          conn,
          `CREATE (:SymbolEmbedding {
             symbolId: $symbolId,
             model: 'test',
             embeddingVector: '[]',
             version: 'v0',
             cardHash: 'stale',
             createdAt: '2026-05-25T12:00:00.000Z',
             updatedAt: '2026-05-25T12:00:00.000Z'
           })`,
          { symbolId: staleSymbolId },
        );
        await ladybugDb.exec(
          conn,
          `CREATE (:SummaryCache {
             symbolId: $symbolId,
             summary: 'stale',
             provider: 'test',
             model: 'test',
             cardHash: 'stale',
             costUsd: 0.0,
             createdAt: '2026-05-25T12:00:00.000Z',
             updatedAt: '2026-05-25T12:00:00.000Z'
           })`,
          { symbolId: staleSymbolId },
        );
        await ladybugDb.exec(
          conn,
          `CREATE (:SymbolReference {
             refId: $refId,
             repoId: $repoId,
             symbolName: 'staleLegacy',
             fileId: $fileId,
             lineNumber: 1,
             createdAt: '2026-05-25T12:00:00.000Z'
           })`,
          {
            refId: `${repoId}:stale-ref`,
            repoId,
            fileId,
          },
        );
      }
      if (options.seedRemovedFile) {
        const fileId = generateFileId(repoId, "src/removed.ts");
        await ladybugDb.upsertFile(conn, {
          fileId,
          repoId,
          relPath: "src/removed.ts",
          contentHash: "removed",
          language: "typescript",
          byteSize: 1,
          lastIndexedAt: "2026-05-25T12:00:00.000Z",
        });
        await ladybugDb.upsertSymbol(conn, {
          symbolId: `${repoId}:removed-symbol`,
          repoId,
          fileId,
          kind: "function",
          name: "removedLegacy",
          exported: true,
          visibility: "public",
          language: "typescript",
          rangeStartLine: 1,
          rangeStartCol: 0,
          rangeEndLine: 1,
          rangeEndCol: 1,
          astFingerprint: "removed",
          signatureJson: "{}",
          summary: null,
          invariantsJson: null,
          sideEffectsJson: null,
          updatedAt: "2026-05-25T12:00:00.000Z",
        });
      }
    });
    if (options.scipFixture === "complete") {
      const mainDocument = {
        language: "typescript",
        relativePath: "src/index.ts",
        occurrences: [
          {
            range: [0, 16, 20] as [number, number, number],
            enclosingRange: [0, 0, 2, 1] as [
              number,
              number,
              number,
              number,
            ],
            symbol:
              "scip-typescript npm fixture 1.0.0 src/index.ts/main().",
            symbolRoles: 1,
          },
          {
            range: [1, 9, 15] as [number, number, number],
            symbol:
              "scip-typescript npm fixture 1.0.0 src/index.ts/helper().",
            symbolRoles: 8,
          },
          {
            range: [2, 9, 12] as [number, number, number],
            symbol: "scip-typescript npm dep 1.0.0 dep/index.ts/api().",
            symbolRoles: 8,
          },
          {
            range: [4, 16, 22] as [number, number, number],
            enclosingRange: [4, 0, 6, 1] as [
              number,
              number,
              number,
              number,
            ],
            symbol:
              "scip-typescript npm fixture 1.0.0 src/index.ts/helper().",
            symbolRoles: 1,
          },
        ],
        symbols: [
          {
            symbol:
              "scip-typescript npm fixture 1.0.0 src/index.ts/main().",
            kind: 12,
            displayName: "main",
            relationships: [
              {
                symbol:
                  "scip-typescript npm dep 1.0.0 dep/index.ts/api().",
                isDefinition: true,
              },
            ],
          },
          ...(options.duplicateProviderSymbol
            ? [
                {
                  symbol:
                    "scip-typescript npm fixture 1.0.0 src/index.ts/main().",
                  kind: 12,
                  displayName: "main",
                },
              ]
            : []),
          {
            symbol:
              "scip-typescript npm fixture 1.0.0 src/index.ts/helper().",
            kind: 12,
            displayName: "helper",
          },
        ],
      };
      await writeTestScipIndex(join(repoDir, "index.scip"), {
        metadata: {
          toolName: "scip-typescript",
          toolVersion: "1.0.0",
        },
        documents: options.duplicateProviderDoc
          ? [mainDocument, mainDocument]
          : [mainDocument],
        externalSymbols: [
          {
            symbol: "scip-typescript npm dep 1.0.0 dep/index.ts/api().",
            kind: 12,
            displayName: "api",
          },
        ],
      });
    }
    return repoId;
  }
});
