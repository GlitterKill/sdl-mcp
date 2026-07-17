import { createHash } from "node:crypto";
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
  getExtensionCapabilities,
  getLadybugConn,
  getLadybugDbPath,
  initLadybugDb,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { execDdl } from "../../dist/db/ladybug-core.js";
import { getDerivedState } from "../../dist/db/ladybug-derived-state.js";
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
import { createProviderSymbolId } from "../../dist/indexer/provider-first/ids.js";
import {
  indexExistsForTable,
  showIndexes,
} from "../../dist/retrieval/index-lifecycle.js";
import { generateFileId, hashValue } from "../../dist/util/hashing.js";
import { writeTestScipIndex } from "../fixtures/scip/builder.ts";

const RELEASE_SCALE_SYMBOL_COUNT = 2_112;
const RELEASE_SCALE_PROVIDER_ID = "release-scale-scip";
const RELEASE_SCALE_REL_PATH = "src/index.ts";
const RELEASE_SCALE_NAME_COLUMN = 16;

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
    const integrity = await getDerivedState(repoId);
    assert.equal(integrity?.graphIntegrityState, "verified");
    assert.equal(integrity?.graphIntegrityVersionId, result.versionId);
    assert.match(integrity?.graphIntegrityDigest ?? "", /^[a-f0-9]{64}$/);
  });

  it("falls back cleanly when provenance fails before provider graph persistence", async () => {
    const repoId = await initIndexedRepo("auto", { scipFixture: "complete" });
    await withWriteConn((conn) =>
      execDdl(conn, "ALTER TABLE SemanticProviderRun DROP providerType"),
    );

    const result = await indexRepo(repoId, "full");

    assert.equal(result.providerFirstExecution?.status, "fallback");
    assert.match(
      result.providerFirstExecution?.reasons.join(" ") ?? "",
      /providerType/i,
    );
    assert.ok(result.symbolsIndexed > 0);
    const integrity = await getDerivedState(repoId);
    assert.equal(integrity?.graphIntegrityState, "verified");
    assert.equal(integrity?.graphIntegrityVersionId, result.versionId);
    assert.match(integrity?.graphIntegrityDigest ?? "", /^[a-f0-9]{64}$/);
    const providerExternals = await ladybugDb.querySingle<{ count: unknown }>(
      await getLadybugConn(),
      `MATCH (s:Symbol {repoId: $repoId})
       WHERE coalesce(s.external, false) = true
         AND coalesce(s.source, '') = 'scip'
       RETURN count(s) AS count`,
      { repoId },
    );
    assert.equal(ladybugDb.toNumber(providerExternals?.count ?? 0), 0);
  });

  it("executes explicit providerFirst for a full SCIP-covered repository", async (t) => {
    const previousNativeDisabled = process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
    delete process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
    t.after(() => {
      if (previousNativeDisabled === undefined) {
        delete process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
      } else {
        process.env.SDL_MCP_DISABLE_NATIVE_ADDON = previousNativeDisabled;
      }
    });
    const repoId = await initIndexedRepo("providerFirst", {
      scipFixture: "complete",
      seedStaleSymbol: true,
      semanticProvider: "mock",
      semanticRetrieval: true,
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
    assert.equal(result.semanticDeferred, true);
    assert.equal(result.providerFirstExecution?.shadowBuild?.status, "staged");
    assert.equal(result.providerFirstExecution.shadowBuild?.format, "csv");
    assert.equal(result.providerFirstExecution.shadowBuild?.counts.files, 1);
    assert.equal(
      result.providerFirstExecution.shadowBuild?.shadowDb?.status,
      "loaded",
    );
    assert.equal(
      result.providerFirstExecution.shadowBuild?.finalization?.status,
      "finalized",
    );
    assert.deepEqual(
      result.providerFirstExecution.shadowBuild?.finalization?.actualCounts,
      result.providerFirstExecution.shadowBuild?.finalization?.expectedCounts,
    );
    assert.equal(
      result.providerFirstExecution.shadowBuild?.activationResult?.status,
      "activated",
    );
    assert.equal(
      result.providerFirstExecution.shadowBuild?.activationResult?.activeDbPath,
      getLadybugDbPath(),
    );
    assert.equal(
      existsSync(result.providerFirstExecution.shadowBuild?.shadowDb?.path ?? ""),
      false,
    );
    assert.ok(result.providerFirstExecution.phaseTimings);
    assert.ok(
      (result.providerFirstExecution.phaseTimings?.totalMs ?? 0) >=
        (result.providerFirstExecution.phaseTimings?.phases.providerCollection ??
          0),
    );
    assert.ok(
      result.providerFirstExecution.phaseTimings?.phases.shadowActivate !==
        undefined,
    );
    assert.ok(
      result.providerFirstExecution.phaseTimings?.phases.postProviderGc !==
        undefined,
    );
    assert.ok(
      existsSync(result.providerFirstExecution.shadowBuild?.manifestPath ?? ""),
    );
    assert.equal(result.filesProcessed, 1);
    assert.ok(result.symbolsIndexed >= 3);
    assert.equal(
      getGraphSnapshotStats().entries.some((entry) => entry.repoId === repoId),
      false,
    );
    assert.equal(getSliceCacheStats().currentSize, 0);

    const integrity = await getDerivedState(repoId);
    assert.equal(integrity?.graphIntegrityState, "verified");
    assert.equal(integrity?.graphIntegrityVersionId, result.versionId);
    assert.match(integrity?.graphIntegrityDigest ?? "", /^[a-f0-9]{64}$/);

    const conn = await getLadybugConn();
    const indexes = await showIndexes(conn);
    const extensionCapabilities = getExtensionCapabilities();
    assert.equal(
      indexExistsForTable(
        indexes,
        "Symbol",
        "symbol_search_text_v1",
        "fts",
      ),
      true,
      `executed provider-first lifecycle should activate a DB with critical Symbol FTS: ${JSON.stringify({ extensionCapabilities, indexes })}`,
    );
    const symbols = await ladybugDb.queryAll<{
      name: string;
      source: string;
      external: boolean;
      scipSymbol: string;
      summarySource: string;
    }>(
      conn,
      `MATCH (s:Symbol)-[:SYMBOL_IN_REPO]->(:Repo {repoId: $repoId})
       RETURN s.name AS name,
              s.source AS source,
              s.external AS external,
              s.scipSymbol AS scipSymbol,
              s.summarySource AS summarySource
       ORDER BY name`,
      { repoId },
    );
    assert.deepEqual(symbols, [
      {
        name: "api",
        source: "scip",
        external: true,
        scipSymbol: "scip-typescript npm dep 1.0.0 dep/index.ts/api().",
        summarySource: "unknown",
      },
      {
        name: "helper",
        source: "scip",
        external: false,
        scipSymbol:
          "scip-typescript npm fixture 1.0.0 src/index.ts/helper().",
        summarySource: "provider:scip",
      },
      {
        name: "main",
        source: "scip",
        external: false,
        scipSymbol: "scip-typescript npm fixture 1.0.0 src/index.ts/main().",
        summarySource: "provider:scip",
      },
    ]);

    const providerEdges = await ladybugDb.queryAll<{
      fromName: string;
      toName: string;
      resolverId: string;
      provenance: string;
    }>(
      conn,
      `MATCH (from:Symbol)-[edge:DEPENDS_ON]->(to:Symbol)
       WHERE from.repoId = $repoId
       RETURN from.name AS fromName,
              to.name AS toName,
              edge.resolverId AS resolverId,
              edge.provenance AS provenance
       ORDER BY fromName, toName`,
      { repoId },
    );
    assert.equal(providerEdges.length, 1);
    assert.deepEqual(
      providerEdges.map((edge) => [edge.fromName, edge.toName]),
      [["main", "helper"]],
    );
    for (const edge of providerEdges) {
      assert.match(edge.resolverId, /^provider-first:/);
      assert.equal(
        typeof (JSON.parse(edge.provenance) as { dedupeKey?: unknown })
          .dedupeKey,
        "string",
      );
    }

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
      embeddingsDirty: boolean;
      lastError: string | null;
    }>(
      conn,
      `MATCH (d:DerivedState {repoId: $repoId})
       RETURN d.clustersDirty AS clustersDirty,
              d.processesDirty AS processesDirty,
              d.algorithmsDirty AS algorithmsDirty,
              d.embeddingsDirty AS embeddingsDirty,
              d.lastError AS lastError`,
      { repoId },
    );
    assert.equal(derivedState?.clustersDirty, false);
    assert.equal(derivedState?.processesDirty, false);
    assert.equal(derivedState?.algorithmsDirty, false);
    assert.equal(derivedState?.embeddingsDirty, true);
    assert.match(
      derivedState?.lastError ?? "",
      /FileSummary embedding refresh incomplete/,
    );
  });

  it(
    "rolls back shadow activation when required Windows FTS is unavailable",
    { skip: process.platform !== "win32" },
    async (t) => {
      const previousNativeDisabled = process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
      process.env.SDL_MCP_DISABLE_NATIVE_ADDON = "1";
      t.after(() => {
        if (previousNativeDisabled === undefined) {
          delete process.env.SDL_MCP_DISABLE_NATIVE_ADDON;
        } else {
          process.env.SDL_MCP_DISABLE_NATIVE_ADDON = previousNativeDisabled;
        }
      });
      const repoId = await initIndexedRepo("providerFirst", {
        scipFixture: "complete",
        semanticRetrieval: true,
      });

      const result = await indexRepo(repoId, "full");

      assert.equal(result.providerFirstExecution?.status, "executed");
      assert.equal(
        result.providerFirstExecution?.shadowBuild?.finalization?.status,
        "finalized",
      );
      const activation =
        result.providerFirstExecution?.shadowBuild?.activationResult;
      assert.equal(activation?.status, "failed");
      assert.equal(activation?.rollback, "restored");
      assert.match(
        activation?.reasons.join(" ") ?? "",
        /required Symbol FTS index symbol_search_text_v1 is absent after shadow handoff.*previous active DB was restored/,
      );
      assert.equal(getLadybugDbPath(), activation?.activeDbPath);

      const conn = await getLadybugConn();
      const indexes = await showIndexes(conn);
      assert.equal(
        indexExistsForTable(
          indexes,
          "Symbol",
          "symbol_search_text_v1",
          "fts",
        ),
        false,
      );
      const symbolCount = await ladybugDb.getSymbolCount(conn, repoId);
      assert.equal(symbolCount, 2);
    },
  );

  it("guards release-scale shadow finalization in the production indexRepo lifecycle", async () => {
    const repoId = await initIndexedRepo("providerFirst", {
      scipFixture: "complete",
      releaseScaleSymbolCount: RELEASE_SCALE_SYMBOL_COUNT,
      semanticEnabled: false,
    });
    const expectedSymbols = releaseScaleIndexProjection(
      repoId,
      RELEASE_SCALE_SYMBOL_COUNT,
    );

    const result = await indexRepo(repoId, "full");

    assert.equal(result.providerFirstExecution?.status, "executed");
    assert.equal(result.filesProcessed, 1);
    assert.equal(result.symbolsIndexed, RELEASE_SCALE_SYMBOL_COUNT);
    assert.equal(result.edgesCreated, 0);

    const shadowBuild = result.providerFirstExecution?.shadowBuild;
    assert.equal(shadowBuild?.status, "staged");
    assert.equal(shadowBuild?.counts.files, 1);
    assert.equal(shadowBuild?.counts.symbols, RELEASE_SCALE_SYMBOL_COUNT);
    assert.equal(shadowBuild?.counts.externalSymbols, 0);
    assert.equal(shadowBuild?.counts.edges, 0);
    assert.equal(shadowBuild?.shadowDb?.status, "loaded");
    assert.equal(
      shadowBuild?.shadowDb?.actualCounts.symbols,
      RELEASE_SCALE_SYMBOL_COUNT,
    );
    const secondaryIndexes = shadowBuild?.shadowDb?.secondaryIndexes;
    assert.ok(secondaryIndexes);
    assert.ok(Number.isSafeInteger(secondaryIndexes.attempted));
    assert.ok(secondaryIndexes.attempted >= secondaryIndexes.failures.length);
    assert.ok(
      secondaryIndexes.failures.every(
        (failure) => failure.statement.length > 0 && failure.error.length > 0,
      ),
    );

    assert.equal(shadowBuild?.finalization?.status, "skipped");
    assert.match(
      shadowBuild?.finalization?.reasons.join(" ") ?? "",
      /above 2048/,
    );
    assert.equal(shadowBuild?.activationResult?.status, "skipped");
    assert.match(
      shadowBuild?.activationResult?.reasons.join(" ") ?? "",
      /above 2048/,
    );
    assert.notEqual(
      result.providerFirstExecution?.phaseTimings?.phases.shadowFinalize,
      undefined,
    );

    const shadowDbPath = shadowBuild?.shadowDb?.path ?? "";
    assert.ok(shadowDbPath);
    assert.equal(existsSync(shadowDbPath), true);
    assert.notEqual(getLadybugDbPath(), shadowDbPath);

    const activeConn = await getLadybugConn();
    await assertReleaseScaleIndexState(
      activeConn,
      "release-scale active DB after guarded handoff",
      repoId,
      expectedSymbols,
    );
    await assertReleaseScaleIndexStateAtPath(
      shadowDbPath,
      "release-scale staged shadow after finalization guard",
      repoId,
      expectedSymbols,
    );
  });

  it("keeps source-file-list provider-first runs from activating subset shadows", async () => {
    const repoId = await initIndexedRepo("providerFirst", {
      scipFixture: "complete",
      scopedSourceFileList: ["src/index.ts"],
    });

    const result = await indexRepo(repoId, "full");

    assert.equal(result.providerFirstExecution?.status, "executed");
    assert.equal(result.providerFirstExecution?.shadowBuild?.status, "skipped");
    assert.match(
      result.providerFirstExecution?.shadowBuild?.reasons.join(" ") ?? "",
      /sourceFileListPath scopes this run to a benchmark subset/,
    );
    assert.match(
      result.providerFirstExecution?.reasons.join(" ") ?? "",
      /active row reuse and shadow activation are disabled/,
    );

    const conn = await getLadybugConn();
    const activeInputRecord = await ladybugDb.getScipIngestionRecord(
      conn,
      repoId,
      "__providerFirstActiveScipInput__",
    );
    assert.equal(activeInputRecord, null);
  });

  it("scans before SCIP fact collection so DB reads do not run under retained provider heap", async () => {
    const repoId = await initIndexedRepo("providerFirst", {
      scipFixture: "complete",
    });
    const progressEvents: string[] = [];

    const result = await indexRepo(repoId, "full", (progress) => {
      progressEvents.push(`${progress.stage}:${progress.substage ?? ""}`);
    });

    const firstScan = progressEvents.findIndex((event) =>
      event.startsWith("scanning:"),
    );
    const firstProviderCollection = progressEvents.findIndex((event) =>
      event.startsWith("providerFirst:providerCollection."),
    );
    assert.notEqual(firstScan, -1);
    assert.notEqual(firstProviderCollection, -1);
    assert.ok(
      firstScan < firstProviderCollection,
      `expected scanning before provider collection, got ${progressEvents.join(", ")}`,
    );
    assert.equal(
      result.providerFirstExecution?.phaseTimings?.phases[
        "materialize.deleteFileSymbols"
      ],
      undefined,
    );
  });

  it("defers provider-first semantic readiness when the embedding provider is mock", async () => {
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
    assert.equal(
      typeof result.timings?.phases[
        "semanticReadiness.symbolEmbeddings:jina-embeddings-v2-base-code"
      ],
      "undefined",
    );
    assert.equal(
      typeof result.timings?.phases[
        "semanticReadiness.fileSummaryEmbeddings:nomic-embed-text-v1.5"
      ],
      "number",
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

  it("keeps configured semantic work dirty when the embedding provider is mock", async () => {
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

  it("requires scip.generator for explicit providerFirst incremental refreshes", async () => {
    const repoId = await initIndexedRepo("providerFirst", {
      scipFixture: "complete",
    });

    await indexRepo(repoId, "full");

    await assert.rejects(
      () => indexRepo(repoId, "incremental"),
      /provider-first SCIP incremental execution requires an enabled scip\.generator/i,
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
    assert.equal(
      result.providerFirstExecution?.legacyFallbackDiagnostics?.files,
      1,
    );
    assert.equal(
      result.providerFirstExecution?.legacyFallbackDiagnostics?.samplePaths[0],
      "src/extra.ts",
    );
    assert.ok(
      (result.providerFirstExecution?.legacyFallbackDiagnostics?.durationMs ??
        0) >= 0,
    );
    assert.ok(
      Object.hasOwn(
        result.providerFirstExecution?.legacyFallbackDiagnostics?.phases ?? {},
        "pass1",
      ),
    );
    assert.ok(
      Object.hasOwn(
        result.providerFirstExecution?.legacyFallbackDiagnostics?.phases ?? {},
        "pass1",
      ),
    );
    assert.ok(
      Object.hasOwn(
        result.providerFirstExecution?.legacyFallbackDiagnostics?.phases ?? {},
        "finalizeIndexing.metrics",
      ),
    );
    assert.ok(
      Object.hasOwn(
        result.providerFirstExecution?.legacyFallbackDiagnostics?.phases ?? {},
        "finalizeIndexing.fileSummaries.loadFiles",
      ),
    );
    assert.ok(
      Object.hasOwn(
        result.providerFirstExecution?.legacyFallbackDiagnostics?.phases ?? {},
        "clustersAndProcesses.loadSymbols",
      ),
    );
    assert.ok(
      Object.hasOwn(
        result.providerFirstExecution?.legacyFallbackDiagnostics?.phases ?? {},
        "versionSnapshot.snapshot.writePages",
      ),
    );
    assert.ok(
      Object.hasOwn(
        result.providerFirstExecution?.legacyFallbackDiagnostics?.phases ?? {},
        "buildDeferredIndexes.secondaryIndexes",
      ),
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
      extraScannedFileMissingCall: true,
    });

    const result = await indexRepo(repoId, "full");

    assert.equal(result.providerFirst?.selectedPipeline, "providerFirst");
    assert.equal(result.providerFirstExecution?.status, "executed");
    assert.match(
      result.providerFirstExecution?.reasons.join(" ") ?? "",
      /legacy fallback indexed 1 uncovered or provider-unusable file/i,
    );
    assert.equal(result.filesProcessed, 2);
    assert.equal(result.providerFirstExecution?.shadowBuild?.status, "staged");
    assert.equal(result.providerFirstExecution?.shadowBuild?.counts.files, 2);
    assert.equal(
      result.providerFirstExecution?.shadowBuild?.shadowDb?.status,
      "loaded",
    );
    const finalization = result.providerFirstExecution?.shadowBuild?.finalization;
    assert.equal(
      finalization?.status,
      "finalized",
      JSON.stringify(finalization, null, 2),
    );
    assert.equal(
      finalization?.copyMode,
      "bulkCsv",
    );
    assert.ok(
      finalization?.bulkLoad?.manifestPath,
      "shadow finalization should expose the bulk-load manifest for diagnostics",
    );
    assert.equal(
      result.providerFirstExecution?.shadowBuild?.activationResult?.status,
      "activated",
    );
    assert.ok(
      (result.providerFirstExecution?.legacyFallbackDiagnostics?.phases[
        "pass1"
      ] ?? 0) > 0,
      "provider-first fallback should collect scoped pass-1 timing without broad timing diagnostics",
    );
    assert.equal(result.timings, undefined);

    const conn = await getLadybugConn();
    const edgeCount = await ladybugDb.getEdgeCount(conn, repoId);
    const symbolCount = await ladybugDb.getSymbolCount(conn, repoId);
    assert.equal(
      result.providerFirstExecution?.shadowBuild?.finalization?.actualCounts
        .edges,
      edgeCount,
    );
    assert.equal(
      result.providerFirstExecution?.shadowBuild?.finalization?.actualCounts
        .symbols,
      symbolCount,
      "shadow finalization symbols should match the public real-symbol count",
    );
    assert.ok(
      (result.providerFirstExecution?.shadowBuild?.finalization?.actualCounts
        .auxiliarySymbols ?? 0) > 0,
      "shadow finalization should report unresolved dependency placeholders separately",
    );
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

  it("defers semantic readiness after provider-first uses legacy fallback with mock", async () => {
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
    assert.equal(
      typeof result.timings?.phases[
        "semanticReadiness.symbolEmbeddings:jina-embeddings-v2-base-code"
      ],
      "undefined",
    );
    assert.equal(
      typeof result.timings?.phases[
        "semanticReadiness.fileSummaryEmbeddings:nomic-embed-text-v1.5"
      ],
      "number",
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
      semanticEligibleFiles: undefined,
      providerFiles: 1,
      providerCoveredFiles: 1,
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
    const mismatchReason =
      result.providerFirstExecution?.coverage?.callProofIncompleteReasons?.find(
        (reason) => reason.code === "symbolTextMismatch",
      );
    assert.equal(mismatchReason?.samples?.length, 1);
    assert.equal(mismatchReason?.samples?.[0]?.relPath, "src/index.ts");
    assert.equal(mismatchReason?.samples?.[0]?.actualText, "rename");
    assert.equal(result.clustersComputed, 0);
    assert.equal(result.processesTraced, 0);
    assert.equal(
      result.providerFirstExecution?.shadowBuild?.status,
      "skipped",
    );
    assert.match(
      result.providerFirstExecution?.shadowBuild?.reasons.join(" ") ?? "",
      /call proof unavailable/i,
    );
    assert.equal(
      result.providerFirstExecution?.shadowBuild?.finalization,
      undefined,
    );
    assert.equal(
      result.providerFirstExecution?.shadowBuild?.activationResult?.status,
      "skipped",
    );

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

  it("does not report multi-line import aliases as call-proof mismatches", async () => {
    const repoId = await initIndexedRepo("providerFirst", {
      scipFixture: "complete",
      multiLineAliasedImportReference: true,
    });

    const result = await indexRepo(repoId, "full");

    assert.equal(result.providerFirstExecution?.status, "executed");
    assert.doesNotMatch(
      result.providerFirstExecution?.reasons.join(" ") ?? "",
      /call proof was unavailable/i,
    );
    assert.equal(
      result.providerFirstExecution?.coverage?.callProofIncompleteFiles,
      0,
    );
    assert.equal(
      result.providerFirstExecution?.coverage?.callProofIncompleteReasons,
      undefined,
    );
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
    assert.deepEqual(
      result.providerFirstExecution?.coverage?.providerUnusableReasons,
      [
        {
          code: "noUsableProviderSymbols",
          files: 1,
          samplePaths: ["src/index.ts"],
          skippedSymbolReasons: [
            {
              reason: "local",
              symbols: 1,
              samplePaths: ["src/index.ts"],
            },
          ],
        },
      ],
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

  it("coalesces duplicate SCIP documents in explicit providerFirst mode", async () => {
    const repoId = await initIndexedRepo("providerFirst", {
      scipFixture: "complete",
      duplicateProviderDoc: true,
    });

    const result = await indexRepo(repoId, "full");

    assert.equal(result.providerFirstExecution?.status, "executed");
    assert.equal(result.providerFirstExecution?.shadowBuild?.counts.files, 1);

    const conn = await getLadybugConn();
    const symbolCount = await ladybugDb.querySingle<{ count: unknown }>(
      conn,
      `MATCH (s:Symbol)-[:SYMBOL_IN_REPO]->(:Repo {repoId: $repoId})
       WHERE s.source = 'scip'
       RETURN count(s) AS count`,
      { repoId },
    );
    assert.equal(ladybugDb.toNumber(symbolCount?.count), 3);
  });

  it("coalesces duplicate SCIP documents in auto providerFirst mode", async () => {
    const repoId = await initIndexedRepo("auto", {
      scipFixture: "complete",
      duplicateProviderDoc: true,
    });

    const result = await indexRepo(repoId, "full");

    assert.equal(result.providerFirstExecution?.status, "executed");
    assert.equal(result.providerFirstExecution?.shadowBuild?.counts.files, 1);

    const conn = await getLadybugConn();
    const symbolCount = await ladybugDb.querySingle<{ count: unknown }>(
      conn,
      `MATCH (s:Symbol)-[:SYMBOL_IN_REPO]->(:Repo {repoId: $repoId})
       WHERE s.source = 'scip'
       RETURN count(s) AS count`,
      { repoId },
    );
    assert.equal(ladybugDb.toNumber(symbolCount?.count), 3);
  });

  it("coalesces duplicate SCIP symbols in one document", async () => {
    const repoId = await initIndexedRepo("providerFirst", {
      scipFixture: "complete",
      duplicateProviderSymbol: true,
    });

    const result = await indexRepo(repoId, "full");

    assert.equal(result.providerFirstExecution?.status, "executed");

    const conn = await getLadybugConn();
    const symbolCount = await ladybugDb.querySingle<{ count: unknown }>(
      conn,
      `MATCH (s:Symbol)-[:SYMBOL_IN_REPO]->(:Repo {repoId: $repoId})
       WHERE s.source = 'scip'
       RETURN count(s) AS count`,
      { repoId },
    );
    assert.equal(ladybugDb.toNumber(symbolCount?.count), 3);
  });

  it("falls back before writing cross-document duplicate SCIP symbols", async () => {
    const repoId = await initIndexedRepo("providerFirst", {
      scipFixture: "complete",
      duplicateProviderSymbolDocument: true,
    });

    const result = await indexRepo(repoId, "full");

    assert.equal(result.providerFirstExecution?.status, "executed");
    assert.match(
      result.providerFirstExecution?.reasons.join(" ") ?? "",
      /legacy fallback indexed/i,
    );
    assert.ok(
      (result.providerFirstExecution?.legacyFallbackDiagnostics?.files ?? 0) >
        0,
    );

    const conn = await getLadybugConn();
    const providerMainCount = await ladybugDb.querySingle<{ count: unknown }>(
      conn,
      `MATCH (s:Symbol)-[:SYMBOL_IN_REPO]->(:Repo {repoId: $repoId})
       WHERE s.source = 'scip' AND s.name = 'main'
       RETURN count(s) AS count`,
      { repoId },
    );
    assert.equal(ladybugDb.toNumber(providerMainCount?.count), 0);
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
      multiLineAliasedImportReference?: boolean;
      emptyProviderDocument?: boolean;
      extraScannedFileMissingCall?: boolean;
      includeMissingScipIndex?: boolean;
      scopedSourceFileList?: string[];
      seedRemovedFile?: boolean;
      semanticProvider?: "api" | "local" | "mock";
      generateSummaries?: boolean;
      semanticRetrieval?: boolean;
      semanticEnabled?: boolean;
      releaseScaleSymbolCount?: number;
    } = {},
  ): Promise<string> {
    graphDbPath = mkdtempSync(join(tmpdir(), "sdl-provider-first-index-db-"));
    repoDir = mkdtempSync(join(tmpdir(), "sdl-provider-first-index-repo-"));
    configPath = join(
      tmpdir(),
      `sdl-provider-first-index-${pipeline}-${Date.now()}.json`,
    );
    mkdirSync(join(repoDir, "src"), { recursive: true });
    const indexSource = options.releaseScaleSymbolCount
      ? Array.from({ length: options.releaseScaleSymbolCount }, (_, index) =>
          releaseScaleSourceLine(index),
        )
      : options.multiLineAliasedImportReference
        ? [
            "import {",
            "  clearCache as clearGrammarCache,",
            '} from "./grammarLoader.js";',
            "",
            "export function main() {",
            "  clearGrammarCache();",
            "}",
          ]
        : [
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
          ];
    writeFileSync(
      join(repoDir, "src", "index.ts"),
      indexSource.join("\n"),
      "utf8",
    );
    if (options.extraScannedFile) {
      const extraSource = [
        "export function extra() {",
        options.extraScannedFileMissingCall
          ? "  return missingLegacy();"
          : "  return 2;",
        "}",
      ];
      writeFileSync(
        join(repoDir, "src", "extra.ts"),
        extraSource.join("\n"),
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
    const sourceFileListPath = options.scopedSourceFileList
      ? join(repoDir, "source-files.txt")
      : undefined;
    if (sourceFileListPath) {
      writeFileSync(
        sourceFileListPath,
        `${options.scopedSourceFileList.join("\n")}\n`,
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
            ...(options.semanticEnabled === undefined
              ? {}
              : { enabled: options.semanticEnabled }),
            ...(options.semanticProvider
              ? { provider: options.semanticProvider }
              : {}),
            generateSummaries: options.generateSummaries ?? false,
            ...(options.semanticRetrieval ? { retrieval: {} } : {}),
          },
          scip: {
            enabled: true,
            indexes: [
              {
                path:
                  options.scipFixture === "complete"
                    ? "index.scip"
                    : "missing.scip",
                ...(options.releaseScaleSymbolCount
                  ? { label: RELEASE_SCALE_PROVIDER_ID }
                  : {}),
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
          ...(sourceFileListPath ? { sourceFileListPath } : {}),
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
      if (options.releaseScaleSymbolCount) {
        const symbols = Array.from(
          { length: options.releaseScaleSymbolCount },
          (_, index) => {
            const name = releaseScaleSymbolName(index);
            return {
              symbol: releaseScaleProviderSymbolId(index),
              kind: 12,
              displayName: name,
            };
          },
        );
        await writeTestScipIndex(join(repoDir, "index.scip"), {
          metadata: {
            toolName: "scip-typescript",
            toolVersion: "1.0.0",
          },
          documents: [
            {
              language: "typescript",
              relativePath: RELEASE_SCALE_REL_PATH,
              occurrences: symbols.map((symbol, index) => {
                const sourceLine = releaseScaleSourceLine(index);
                return {
                  range: [
                    index,
                    RELEASE_SCALE_NAME_COLUMN,
                    RELEASE_SCALE_NAME_COLUMN + symbol.displayName.length,
                  ] as [number, number, number],
                  enclosingRange: [
                    index,
                    0,
                    index,
                    sourceLine.length,
                  ] as [number, number, number, number],
                  symbol: symbol.symbol,
                  symbolRoles: 1,
                };
              }),
              symbols,
            },
          ],
          externalSymbols: [],
        });
        return repoId;
      }
      const mainDocument = options.multiLineAliasedImportReference
        ? {
            language: "typescript",
            relativePath: "src/index.ts",
            occurrences: [
              {
                range: [1, 2, 12] as [number, number, number],
                symbol:
                  "scip-typescript npm fixture 1.0.0 src/grammarLoader.ts/clearCache().",
                symbolRoles: 0,
              },
              {
                range: [4, 16, 20] as [number, number, number],
                enclosingRange: [4, 0, 6, 1] as [
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
                range: [5, 2, 19] as [number, number, number],
                symbol:
                  "scip-typescript npm fixture 1.0.0 src/grammarLoader.ts/clearCache().",
                symbolRoles: 8,
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
          }
        : {
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
          options.multiLineAliasedImportReference
            ? {
                symbol:
                  "scip-typescript npm fixture 1.0.0 src/grammarLoader.ts/clearCache().",
                kind: 12,
                displayName: "clearCache",
              }
            : {
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

interface ReleaseScaleIndexProjection {
  symbolId: string;
  fileId: string;
  relPath: string;
  name: string;
  signatureJson: string;
  kind: string;
  language: string;
  rangeStartLine: number;
  rangeStartCol: number;
  rangeEndLine: number;
  rangeEndCol: number;
  summarySource: string;
  source: string;
  scipSymbol: string;
  astFingerprint: string;
  symbolStatus: string;
  external: boolean;
  placeholderKind: string;
  placeholderTarget: string;
}

interface ReleaseScalePlaceholderProjection {
  symbolId: string;
  symbolStatus: string;
  placeholderKind: string;
  placeholderTarget: string;
}

interface ReleaseScaleRelationshipProjection {
  fromSymbolId: string;
  toSymbolId: string;
  resolverId: string;
  provenance: string;
}

function releaseScaleSymbolName(index: number): string {
  return `releaseScale${index.toString().padStart(4, "0")}`;
}

function releaseScaleProviderSymbolId(index: number): string {
  return `scip-typescript npm fixture 1.0.0 ${RELEASE_SCALE_REL_PATH}/${releaseScaleSymbolName(index)}().`;
}

function releaseScaleSourceLine(index: number): string {
  return `export function ${releaseScaleSymbolName(index)}() { return ${index}; }`;
}

function releaseScaleIndexProjection(
  repoId: string,
  symbolCount: number,
): ReleaseScaleIndexProjection[] {
  const fileId = generateFileId(repoId, RELEASE_SCALE_REL_PATH);
  return Array.from({ length: symbolCount }, (_, index) => {
    const name = releaseScaleSymbolName(index);
    const providerSymbolId = releaseScaleProviderSymbolId(index);
    const range = {
      startLine: index + 1,
      startCol: 0,
      endLine: index + 1,
      endCol: releaseScaleSourceLine(index).length,
    };
    return {
      symbolId: createProviderSymbolId({
        repoId,
        providerType: "scip",
        providerId: RELEASE_SCALE_PROVIDER_ID,
        providerSymbolId,
        sourcePath: RELEASE_SCALE_REL_PATH,
      }),
      fileId,
      relPath: RELEASE_SCALE_REL_PATH,
      name,
      signatureJson: JSON.stringify({ text: `function ${name}` }),
      kind: "function",
      language: "typescript",
      rangeStartLine: range.startLine,
      rangeStartCol: range.startCol,
      rangeEndLine: range.endLine,
      rangeEndCol: range.endCol,
      summarySource: "provider:scip",
      source: "scip",
      scipSymbol: providerSymbolId,
      astFingerprint: hashValue({
        providerSymbolId,
        relPath: RELEASE_SCALE_REL_PATH,
        range,
        signature: null,
      }),
      symbolStatus: "real",
      external: false,
      placeholderKind: "",
      placeholderTarget: "",
    };
  }).sort((left, right) => left.symbolId.localeCompare(right.symbolId));
}

async function assertReleaseScaleIndexState(
  conn: import("kuzu").Connection,
  checkpoint: string,
  repoId: string,
  expectedSymbols: ReleaseScaleIndexProjection[],
): Promise<void> {
  const rows = await ladybugDb.queryAll<{
    symbolId: string;
    fileId: string;
    relPath: string;
    name: string;
    signatureJson: string | null;
    kind: string;
    language: string;
    rangeStartLine: unknown;
    rangeStartCol: unknown;
    rangeEndLine: unknown;
    rangeEndCol: unknown;
    summarySource: string | null;
    source: string | null;
    scipSymbol: string | null;
    astFingerprint: string;
    symbolStatus: string | null;
    external: unknown;
    placeholderKind: string | null;
    placeholderTarget: string | null;
  }>(
    conn,
    `MATCH (s:Symbol {repoId: $repoId})-[:SYMBOL_IN_FILE]->(f:File)
     RETURN s.symbolId AS symbolId,
            f.fileId AS fileId,
            f.relPath AS relPath,
            s.name AS name,
            s.signatureJson AS signatureJson,
            s.kind AS kind,
            s.language AS language,
            s.rangeStartLine AS rangeStartLine,
            s.rangeStartCol AS rangeStartCol,
            s.rangeEndLine AS rangeEndLine,
            s.rangeEndCol AS rangeEndCol,
            s.summarySource AS summarySource,
            s.source AS source,
            s.scipSymbol AS scipSymbol,
            s.astFingerprint AS astFingerprint,
            s.symbolStatus AS symbolStatus,
            s.external AS external,
            s.placeholderKind AS placeholderKind,
            s.placeholderTarget AS placeholderTarget
     ORDER BY s.symbolId`,
    { repoId },
  );
  const actualSymbols = rows
    .map((row) => ({
      symbolId: row.symbolId,
      fileId: row.fileId,
      relPath: row.relPath,
      name: row.name,
      signatureJson: row.signatureJson ?? "",
      kind: row.kind,
      language: row.language,
      rangeStartLine: ladybugDb.toNumber(row.rangeStartLine),
      rangeStartCol: ladybugDb.toNumber(row.rangeStartCol),
      rangeEndLine: ladybugDb.toNumber(row.rangeEndLine),
      rangeEndCol: ladybugDb.toNumber(row.rangeEndCol),
      summarySource: row.summarySource ?? "unknown",
      source: row.source ?? "",
      scipSymbol: row.scipSymbol ?? "",
      astFingerprint: row.astFingerprint,
      symbolStatus: row.symbolStatus ?? "real",
      external: Boolean(row.external),
      placeholderKind: row.placeholderKind ?? "",
      placeholderTarget: row.placeholderTarget ?? "",
    }))
    .sort((left, right) => left.symbolId.localeCompare(right.symbolId));
  assertBoundedProjection(
    `${checkpoint} symbols`,
    expectedSymbols,
    actualSymbols,
  );

  const placeholders = await ladybugDb.queryAll<ReleaseScalePlaceholderProjection>(
    conn,
    `MATCH (s:Symbol {repoId: $repoId})
     WHERE NOT (s)-[:SYMBOL_IN_FILE]->(:File)
     RETURN s.symbolId AS symbolId,
            s.symbolStatus AS symbolStatus,
            s.placeholderKind AS placeholderKind,
            s.placeholderTarget AS placeholderTarget
     ORDER BY s.symbolId`,
    { repoId },
  );
  assertBoundedProjection<ReleaseScalePlaceholderProjection>(
    `${checkpoint} isolated placeholders`,
    [],
    placeholders,
  );

  const relationships = await ladybugDb.queryAll<ReleaseScaleRelationshipProjection>(
    conn,
    `MATCH (from:Symbol)-[edge:DEPENDS_ON]->(to:Symbol)
     WHERE from.repoId = $repoId
     RETURN from.symbolId AS fromSymbolId,
            to.symbolId AS toSymbolId,
            edge.resolverId AS resolverId,
            edge.provenance AS provenance
     ORDER BY fromSymbolId, toSymbolId`,
    { repoId },
  );
  assertBoundedProjection<ReleaseScaleRelationshipProjection>(
    `${checkpoint} relationships`,
    [],
    relationships,
  );
}

async function assertReleaseScaleIndexStateAtPath(
  dbPath: string,
  checkpoint: string,
  repoId: string,
  expectedSymbols: ReleaseScaleIndexProjection[],
): Promise<void> {
  const kuzu = await import("kuzu");
  const db = new kuzu.Database(dbPath);
  const conn = new kuzu.Connection(db);
  try {
    await assertReleaseScaleIndexState(
      conn,
      checkpoint,
      repoId,
      expectedSymbols,
    );
  } finally {
    await conn.close().catch(() => {});
    await db.close().catch(() => {});
  }
}

function assertBoundedProjection<T>(
  checkpoint: string,
  expected: readonly T[],
  actual: readonly T[],
): void {
  const expectedDigest = createHash("sha256")
    .update(JSON.stringify(expected))
    .digest("hex");
  const actualDigest = createHash("sha256")
    .update(JSON.stringify(actual))
    .digest("hex");
  if (
    expected.length === actual.length &&
    expectedDigest === actualDigest
  ) {
    return;
  }

  const mismatchIndex = expected.findIndex(
    (row, index) => JSON.stringify(row) !== JSON.stringify(actual[index]),
  );
  const firstMismatch =
    mismatchIndex === -1
      ? Math.min(expected.length, actual.length)
      : mismatchIndex;
  assert.fail(
    `${checkpoint} projection mismatch: expected count=${expected.length} sha256=${expectedDigest}, actual count=${actual.length} sha256=${actualDigest}, first mismatch index=${firstMismatch}, expected=${JSON.stringify(expected[firstMismatch] ?? null)}, actual=${JSON.stringify(actual[firstMismatch] ?? null)}`,
  );
}
