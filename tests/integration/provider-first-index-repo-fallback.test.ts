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
    assert.equal(derivedState?.clustersDirty, false);
    assert.equal(derivedState?.processesDirty, false);
    assert.equal(derivedState?.algorithmsDirty, false);
    assert.equal(derivedState?.lastError, null);
  });

  it("defers provider-first semantic embeddings until semantic readiness", async () => {
    const repoId = await initIndexedRepo("providerFirst", {
      scipFixture: "complete",
      semanticProvider: "mock",
    });

    const result = await indexRepo(repoId, "full", undefined, undefined, {
      includeTimings: true,
    });

    assert.equal(result.providerFirst?.selectedPipeline, "providerFirst");
    assert.equal(result.providerFirstExecution?.status, "executed");
    assert.equal(result.semanticDeferred, true);
    assert.equal(result.summaryStats, undefined);
    assert.equal(result.timings?.phases["finalizeIndexing.semanticSummaries"], undefined);
    assert.equal(
      result.timings?.phases["finalizeIndexing.semanticEmbeddings:jina-embeddings-v2-base-code"],
      undefined,
    );
    assert.equal(
      result.timings?.phases["finalizeIndexing.fileSummaryEmbeddings:nomic-embed-text-v1.5"],
      undefined,
    );

    const conn = await getLadybugConn();
    const derivedState = await ladybugDb.querySingle<{
      summariesDirty: boolean;
      embeddingsDirty: boolean;
    }>(
      conn,
      `MATCH (d:DerivedState {repoId: $repoId})
       RETURN d.summariesDirty AS summariesDirty,
              d.embeddingsDirty AS embeddingsDirty`,
      { repoId },
    );
    assert.equal(derivedState?.summariesDirty, false);
    assert.equal(derivedState?.embeddingsDirty, true);
  });

  it("marks deferred summaries dirty only when summaries are configured", async () => {
    const repoId = await initIndexedRepo("providerFirst", {
      scipFixture: "complete",
      semanticProvider: "mock",
      generateSummaries: true,
    });

    const result = await indexRepo(repoId, "full");

    assert.equal(result.semanticDeferred, true);
    const conn = await getLadybugConn();
    const derivedState = await ladybugDb.querySingle<{
      summariesDirty: boolean;
      embeddingsDirty: boolean;
    }>(
      conn,
      `MATCH (d:DerivedState {repoId: $repoId})
       RETURN d.summariesDirty AS summariesDirty,
              d.embeddingsDirty AS embeddingsDirty`,
      { repoId },
    );
    assert.equal(derivedState?.summariesDirty, true);
    assert.equal(derivedState?.embeddingsDirty, true);
  });

  it("uses legacy fallback for explicit providerFirst incremental refreshes", async () => {
    const repoId = await initIndexedRepo("providerFirst", {
      scipFixture: "complete",
    });

    await indexRepo(repoId, "full");
    const result = await indexRepo(repoId, "incremental");

    assert.equal(result.providerFirst?.selectedPipeline, "providerFirst");
    assert.equal(result.providerFirstExecution?.status, "fallback");
    assert.match(
      result.providerFirstExecution?.reasons.join(" ") ?? "",
      /full refreshes only/i,
    );
  });

  it("uses legacy only for uncovered files when auto SCIP coverage is incomplete", async () => {
    const repoId = await initIndexedRepo("auto", {
      scipFixture: "complete",
      extraScannedFile: true,
    });

    const result = await indexRepo(repoId, "full");

    assert.equal(result.providerFirst?.selectedPipeline, "providerFirst");
    assert.equal(result.providerFirstExecution?.status, "executed");
    assert.match(
      result.providerFirstExecution?.reasons.join(" ") ?? "",
      /legacy fallback indexed 1 uncovered or provider-unusable file/i,
    );
    assert.equal(result.filesProcessed, 2);
    assert.ok(result.symbolsIndexed > 0);

    const conn = await getLadybugConn();
    const extraFile = await ladybugDb.getFileByRepoPath(
      conn,
      repoId,
      "src/extra.ts",
    );
    assert.ok(extraFile);
  });

  it("uses legacy only for uncovered files when explicit providerFirst SCIP coverage is incomplete", async () => {
    const repoId = await initIndexedRepo("providerFirst", {
      scipFixture: "complete",
      extraScannedFile: true,
    });

    const result = await indexRepo(repoId, "full");

    assert.equal(result.providerFirst?.selectedPipeline, "providerFirst");
    assert.equal(result.providerFirstExecution?.status, "executed");
    assert.match(
      result.providerFirstExecution?.reasons.join(" ") ?? "",
      /legacy fallback indexed 1 uncovered or provider-unusable file/i,
    );
    assert.equal(result.filesProcessed, 2);

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
    assert.ok(
      symbols.some(
        (symbol) =>
          symbol.name === "main" &&
          symbol.source === "scip" &&
          symbol.external === false,
      ),
    );
    assert.ok(
      symbols.some(
        (symbol) =>
          symbol.name === "extra" &&
          symbol.source !== "scip" &&
          symbol.external === false,
      ),
    );
  });

  it("defers semantic embeddings when provider-first uses legacy fallback", async () => {
    const repoId = await initIndexedRepo("providerFirst", {
      scipFixture: "complete",
      extraScannedFile: true,
      semanticProvider: "mock",
    });

    const result = await indexRepo(repoId, "full", undefined, undefined, {
      includeTimings: true,
    });

    assert.equal(result.providerFirstExecution?.status, "executed");
    assert.equal(result.providerFirstExecution?.coverage?.fallbackFiles, 1);
    assert.equal(result.semanticDeferred, true);
    assert.equal(
      result.timings?.phases["finalizeIndexing.semanticEmbeddings:jina-embeddings-v2-base-code"],
      undefined,
    );
    assert.equal(
      result.timings?.phases["finalizeIndexing.fileSummaryEmbeddings:nomic-embed-text-v1.5"],
      undefined,
    );

    const conn = await getLadybugConn();
    const derivedState = await ladybugDb.querySingle<{
      embeddingsDirty: boolean;
    }>(
      conn,
      `MATCH (d:DerivedState {repoId: $repoId})
       RETURN d.embeddingsDirty AS embeddingsDirty`,
      { repoId },
    );
    assert.equal(derivedState?.embeddingsDirty, true);
  });

  it("materializes SCIP rows for partial reference coverage without legacy reparsing", async () => {
    const repoId = await initIndexedRepo("providerFirst", {
      scipFixture: "complete",
      partialProviderReference: true,
    });

    const result = await indexRepo(repoId, "full");

    assert.equal(result.providerFirst?.selectedPipeline, "providerFirst");
    assert.equal(result.providerFirstExecution?.status, "executed");
    assert.match(
      result.providerFirstExecution?.reasons.join(" ") ?? "",
      /references were partial/i,
    );
    assert.doesNotMatch(
      result.providerFirstExecution?.reasons.join(" ") ?? "",
      /legacy fallback indexed/i,
    );
    assert.equal(result.filesProcessed, 1);
    assert.equal(result.providerFirstExecution?.filesProcessed, 1);
    assert.equal(result.providerFirstExecution?.symbolsIndexed, 3);
    assert.equal(result.providerFirstExecution?.edgesCreated, 3);
    assert.equal(result.providerFirstExecution?.externalSymbolsIndexed, 1);
    assert.deepEqual(result.providerFirstExecution?.coverage, {
      scannedFiles: 1,
      providerFiles: 1,
      providerPrimaryFiles: 1,
      fullyCoveredFiles: 0,
      partialFiles: 1,
      callProofIncompleteFiles: 0,
      fullFallbackFiles: 0,
      uncoveredFiles: 0,
      fallbackFiles: 0,
    });

    const conn = await getLadybugConn();
    const mainSymbols = await ladybugDb.queryAll<{
      source: string | null;
      count: unknown;
    }>(
      conn,
      `MATCH (s:Symbol)-[:SYMBOL_IN_REPO]->(:Repo {repoId: $repoId})
       WHERE s.name = 'main' AND coalesce(s.external, false) = false
       RETURN s.source AS source,
              count(s) AS count`,
      { repoId },
    );
    assert.equal(mainSymbols.length, 1);
    assert.equal(ladybugDb.toNumber(mainSymbols[0]?.count), 1);
    assert.equal(mainSymbols[0]?.source, "scip");

    const scipInternalCount = await ladybugDb.querySingle<{ count: unknown }>(
      conn,
      `MATCH (s:Symbol)-[:SYMBOL_IN_REPO]->(:Repo {repoId: $repoId})
       WHERE s.source = 'scip' AND coalesce(s.external, false) = false
       RETURN count(s) AS count`,
      { repoId },
    );
    assert.equal(ladybugDb.toNumber(scipInternalCount?.count), 2);
  });

  it("keeps derived graph state dirty when provider call proof cannot validate source text", async () => {
    const repoId = await initIndexedRepo("providerFirst", {
      scipFixture: "complete",
      staleProviderReferenceText: true,
    });

    const result = await indexRepo(repoId, "full");

    assert.equal(result.providerFirstExecution?.status, "executed");
    assert.match(
      result.providerFirstExecution?.reasons.join(" ") ?? "",
      /call proof was unavailable/i,
    );
    assert.equal(
      result.providerFirstExecution?.coverage?.callProofIncompleteFiles,
      1,
    );
    assert.equal(result.clustersComputed, 0);
    assert.equal(result.processesTraced, 0);

    const conn = await getLadybugConn();
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
    assert.match(derivedState?.lastError ?? "", /call proof unavailable/i);
  });

  it("prunes stale SCIP externals when provider rows are unusable and filtered to legacy fallback", async () => {
    const repoId = await initIndexedRepo("providerFirst", {
      scipFixture: "complete",
    });
    await indexRepo(repoId, "full");
    const firstConn = await getLadybugConn();
    const initialExternalRows = await ladybugDb.queryAll<{ name: string }>(
      firstConn,
      `MATCH (s:Symbol)-[:SYMBOL_IN_REPO]->(:Repo {repoId: $repoId})
       WHERE s.external = true AND s.source = 'scip'
       RETURN s.name AS name
       ORDER BY name`,
      { repoId },
    );
    assert.deepEqual(initialExternalRows, [{ name: "api" }]);

    await writeTestScipIndex(join(repoDir, "index.scip"), {
      metadata: {
        toolName: "scip-typescript",
        toolVersion: "1.0.0",
      },
      documents: [
        {
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
              symbol: "local 1",
              symbolRoles: 1,
            },
          ],
          symbols: [
            {
              symbol: "local 1",
              kind: 12,
              displayName: "main",
            },
          ],
        },
      ],
    });

    const result = await indexRepo(repoId, "full");

    assert.equal(result.providerFirstExecution?.status, "executed");
    assert.match(
      result.providerFirstExecution?.reasons.join(" ") ?? "",
      /legacy fallback indexed 1 uncovered or provider-unusable file/i,
    );

    const conn = await getLadybugConn();
    const externalRows = await ladybugDb.queryAll<{ name: string }>(
      conn,
      `MATCH (s:Symbol)-[:SYMBOL_IN_REPO]->(:Repo {repoId: $repoId})
       WHERE s.external = true AND s.source = 'scip'
       RETURN s.name AS name
       ORDER BY name`,
      { repoId },
    );
    assert.deepEqual(externalRows, []);
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

  it("deletes removed graph rows when explicit providerFirst uses uncovered-file fallback", async () => {
    const repoId = await initIndexedRepo("providerFirst", {
      scipFixture: "complete",
      extraScannedFile: true,
      seedRemovedFile: true,
    });

    const result = await indexRepo(repoId, "full");

    assert.equal(result.providerFirstExecution?.status, "executed");
    assert.equal(result.removedFiles, 1);

    const conn = await getLadybugConn();
    const removedFile = await ladybugDb.getFileByRepoPath(
      conn,
      repoId,
      "src/removed.ts",
    );
    assert.equal(removedFile, null);
    const removedSymbol = await ladybugDb.querySingle<{ count: unknown }>(
      conn,
      `MATCH (s:Symbol {symbolId: $symbolId})-[:SYMBOL_IN_REPO]->(:Repo {repoId: $repoId})
       RETURN count(s) AS count`,
      {
        repoId,
        symbolId: `${repoId}:removed-symbol`,
      },
    );
    assert.equal(ladybugDb.toNumber(removedSymbol?.count), 0);
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

  it("fails auto providerFirst before writing duplicate SCIP documents", async () => {
    const repoId = await initIndexedRepo("auto", {
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

  it("fails explicit providerFirst before writing cross-document duplicate SCIP symbols", async () => {
    const repoId = await initIndexedRepo("providerFirst", {
      scipFixture: "complete",
      duplicateProviderSymbolDocument: true,
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

  it("executes explicit providerFirst when SCIP covers an empty document", async () => {
    const repoId = await initIndexedRepo("providerFirst", {
      scipFixture: "complete",
      emptyProviderDocument: true,
    });

    const result = await indexRepo(repoId, "full");

    assert.equal(result.providerFirstExecution?.status, "executed");
    assert.equal(result.filesProcessed, 2);

    const conn = await getLadybugConn();
    const emptyFile = await ladybugDb.getFileByRepoPath(
      conn,
      repoId,
      "src/empty.ts",
    );
    assert.ok(emptyFile);
  });

  async function initIndexedRepo(
    pipeline: "auto" | "providerFirst",
    options: {
      scipFixture?: "missing" | "complete";
      seedStaleSymbol?: boolean;
      extraScannedFile?: boolean;
      duplicateProviderDoc?: boolean;
      duplicateProviderSymbol?: boolean;
      duplicateProviderSymbolDocument?: boolean;
      partialProviderReference?: boolean;
      staleProviderReferenceText?: boolean;
      emptyProviderDocument?: boolean;
      includeMissingScipIndex?: boolean;
      seedRemovedFile?: boolean;
      semanticProvider?: "api" | "local" | "mock";
      generateSummaries?: boolean;
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
        options.staleProviderReferenceText
          ? "  return renamed();"
          : "  return helper();",
        "  return api();",
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
    if (options.duplicateProviderSymbolDocument) {
      writeFileSync(
        join(repoDir, "src", "dupe.ts"),
        ["export function dupe() {", "  return 3;", "}"].join("\n"),
        "utf8",
      );
    }
    if (options.emptyProviderDocument) {
      writeFileSync(join(repoDir, "src", "empty.ts"), "", "utf8");
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
            ...(options.semanticProvider
              ? { provider: options.semanticProvider }
              : {}),
            generateSummaries: options.generateSummaries ?? false,
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
            enclosingRange: [0, 0, 3, 1] as [
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
          ...(options.partialProviderReference
            ? [
                {
                  range: [1, 2, 8] as [number, number, number],
                  symbol:
                    "scip-typescript npm missing 1.0.0 missing/index.ts/missing().",
                  symbolRoles: 8,
                },
              ]
            : []),
          {
            range: [5, 16, 22] as [number, number, number],
            enclosingRange: [5, 0, 7, 1] as [
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
        documents: [
          mainDocument,
          ...(options.duplicateProviderDoc ? [mainDocument] : []),
          ...(options.duplicateProviderSymbolDocument
            ? [
                {
                  language: "typescript",
                  relativePath: "src/dupe.ts",
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
                  ],
                  symbols: [
                    {
                      symbol:
                        "scip-typescript npm fixture 1.0.0 src/index.ts/main().",
                      kind: 12,
                      displayName: "main",
                    },
                  ],
                },
              ]
            : []),
          ...(options.emptyProviderDocument
            ? [
                {
                  language: "typescript",
                  relativePath: "src/empty.ts",
                  occurrences: [],
                  symbols: [],
                },
              ]
            : []),
        ],
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
