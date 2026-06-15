import { createWriteStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { finished } from "node:stream/promises";

import type { Connection } from "kuzu";

import * as ladybugDb from "../../db/ladybug-queries.js";
import type { DerivedStateRow } from "../../db/ladybug-derived-state.js";
import { exec, execDdl, querySingle } from "../../db/ladybug-core.js";
import { normalizePath } from "../../util/paths.js";
import { canonicalizeLanguageId } from "../language.js";

export type ProviderFirstShadowFinalizationStatus =
  | "finalized"
  | "skipped"
  | "failed";

export interface ProviderFirstShadowFinalizationCounts {
  files: number;
  symbols: number;
  auxiliarySymbols: number;
  edges: number;
  versions: number;
  symbolVersions: number;
  metrics: number;
  fileSummaries: number;
  clusters: number;
  clusterMembers: number;
  processes: number;
  processSteps: number;
  shadowClusters: number;
  shadowClusterMembers: number;
  derivedStates: number;
}

export interface ProviderFirstShadowFinalizationBulkArtifact {
  path: string;
  columns: string[];
  rows: number;
  targetTable: string;
  kind: "node" | "relationship";
}

export interface ProviderFirstShadowFinalizationBulkLoadSummary {
  status: "loaded";
  stagingDir: string;
  manifestPath: string;
  copiedAt: string;
  artifacts: ProviderFirstShadowFinalizationBulkArtifact[];
}

export interface ProviderFirstShadowFinalizationSummary {
  status: ProviderFirstShadowFinalizationStatus;
  shadowDbPath?: string;
  copyMode?: "bulkCsv";
  bulkLoad?: ProviderFirstShadowFinalizationBulkLoadSummary;
  expectedCounts?: ProviderFirstShadowFinalizationCounts;
  actualCounts?: ProviderFirstShadowFinalizationCounts;
  finalizedAt?: string;
  reasons: string[];
}

export interface FinalizeProviderFirstShadowDbParams {
  activeConn: Connection;
  repoId: string;
  versionId: string;
  shadowDbPath?: string | null;
}

const CSV_NULL_SENTINEL = "\\N";
const CSV_ARRAY_NULL = Symbol("providerFirstFinalizationCsvArrayNull");

const SYMBOL_COLUMNS = [
  "symbolId",
  "repoId",
  "kind",
  "name",
  "exported",
  "visibility",
  "language",
  "rangeStartLine",
  "rangeStartCol",
  "rangeEndLine",
  "rangeEndCol",
  "astFingerprint",
  "signatureJson",
  "summary",
  "summaryQuality",
  "summarySource",
  "invariantsJson",
  "sideEffectsJson",
  "roleTagsJson",
  "searchText",
  "updatedAt",
  "embeddingMiniLM",
  "embeddingMiniLMCardHash",
  "embeddingMiniLMUpdatedAt",
  "embeddingMiniLMVec",
  "embeddingNomic",
  "embeddingNomicCardHash",
  "embeddingNomicUpdatedAt",
  "embeddingJinaCode",
  "embeddingJinaCodeCardHash",
  "embeddingJinaCodeUpdatedAt",
  "embeddingNomicVec",
  "embeddingJinaCodeVec",
  "external",
  "scipSymbol",
  "source",
  "packageName",
  "packageVersion",
  "symbolStatus",
  "placeholderKind",
  "placeholderTarget",
] as const;

const SYMBOL_IN_REPO_COLUMNS = ["from", "to"] as const;

const EDGE_COLUMNS = [
  "from",
  "to",
  "edgeType",
  "weight",
  "confidence",
  "resolution",
  "resolverId",
  "resolutionPhase",
  "provenance",
  "createdAt",
] as const;

const VERSION_COLUMNS = [
  "versionId",
  "createdAt",
  "reason",
  "prevVersionHash",
  "versionHash",
] as const;
const VERSION_OF_REPO_COLUMNS = ["from", "to"] as const;

const SYMBOL_VERSION_COLUMNS = [
  "id",
  "versionId",
  "symbolId",
  "astFingerprint",
  "signatureJson",
  "summary",
  "invariantsJson",
  "sideEffectsJson",
] as const;

const METRICS_COLUMNS = [
  "symbolId",
  "fanIn",
  "fanOut",
  "churn30d",
  "testRefsJson",
  "canonicalTestJson",
  "pageRank",
  "kCore",
  "updatedAt",
] as const;

const FILE_SUMMARY_COLUMNS = [
  "fileId",
  "repoId",
  "summary",
  "searchText",
  "updatedAt",
  "embeddingMiniLM",
  "embeddingMiniLMCardHash",
  "embeddingMiniLMUpdatedAt",
  "embeddingMiniLMVec",
  "embeddingNomic",
  "embeddingNomicCardHash",
  "embeddingNomicUpdatedAt",
  "embeddingNomicVec",
  "embeddingJinaCode",
  "embeddingJinaCodeCardHash",
  "embeddingJinaCodeUpdatedAt",
  "embeddingJinaCodeVec",
] as const;
const FILE_SUMMARY_IN_REPO_COLUMNS = ["from", "to"] as const;
const SUMMARY_OF_FILE_COLUMNS = ["from", "to"] as const;

const CLUSTER_COLUMNS = [
  "clusterId",
  "repoId",
  "label",
  "symbolCount",
  "cohesionScore",
  "versionId",
  "createdAt",
  "searchText",
] as const;
const CLUSTER_IN_REPO_COLUMNS = ["from", "to"] as const;
const BELONGS_TO_CLUSTER_COLUMNS = [
  "from",
  "to",
  "membershipScore",
] as const;

const PROCESS_COLUMNS = [
  "processId",
  "repoId",
  "entrySymbolId",
  "label",
  "depth",
  "versionId",
  "createdAt",
  "searchText",
] as const;
const PROCESS_IN_REPO_COLUMNS = ["from", "to"] as const;
const PARTICIPATES_IN_COLUMNS = ["from", "to", "stepOrder", "role"] as const;

const SHADOW_CLUSTER_COLUMNS = [
  "shadowClusterId",
  "repoId",
  "algorithm",
  "label",
  "symbolCount",
  "modularity",
  "versionId",
  "createdAt",
] as const;
const SHADOW_CLUSTER_IN_REPO_COLUMNS = ["from", "to"] as const;
const BELONGS_TO_SHADOW_CLUSTER_COLUMNS = [
  "from",
  "to",
  "membershipScore",
] as const;

const DERIVED_STATE_COLUMNS = [
  "repoId",
  "clustersDirty",
  "processesDirty",
  "algorithmsDirty",
  "summariesDirty",
  "embeddingsDirty",
  "targetVersionId",
  "computedVersionId",
  "updatedAt",
  "lastError",
] as const;

interface AuxiliarySymbolRow {
  symbolId: string;
  repoId: string;
  kind: string;
  name: string;
  exported: boolean;
  visibility: string | null;
  language: string;
  rangeStartLine: number;
  rangeStartCol: number;
  rangeEndLine: number;
  rangeEndCol: number;
  astFingerprint: string;
  signatureJson: string | null;
  summary: string | null;
  summaryQuality: number;
  summarySource: string;
  invariantsJson: string | null;
  sideEffectsJson: string | null;
  roleTagsJson: string | null;
  searchText: string | null;
  updatedAt: string | null;
  external: boolean;
  scipSymbol: string | null;
  source: string | null;
  packageName: string | null;
  packageVersion: string | null;
  symbolStatus: string;
  placeholderKind: string | null;
  placeholderTarget: string | null;
}

interface SemanticProviderRunCopyRow {
  runId: string;
  repoId: string;
  providerType: string;
  providerId: string;
  providerVersion: string | null;
  languagesJson: string;
  sourceIndexPath: string | null;
  sourceHash: string | null;
  cacheKey: string | null;
  configHash: string | null;
  ledgerVersion: string | null;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  documentsProcessed: number;
  symbolsMatched: number;
  edgesCreated: number;
  edgesUpgraded: number;
  edgesReplaced: number;
  edgesSkipped: number;
  diagnosticsCount: number;
  precisionScore: number;
  cacheHit: boolean;
  canAffectPass2: boolean;
  selected: boolean;
  metadataJson: string;
  error: string | null;
}

interface SemanticDiagnosticCopyRow {
  id: string;
  repoId: string;
  runId: string;
  providerType: string;
  providerId: string;
  languageId: string | null;
  sourcePath: string | null;
  severity: string;
  message: string;
  code: string | null;
  rangeJson: string;
  createdAt: string;
}

export async function finalizeProviderFirstShadowDb(
  params: FinalizeProviderFirstShadowDbParams,
): Promise<ProviderFirstShadowFinalizationSummary> {
  const shadowDbPath = params.shadowDbPath
    ? normalizePath(params.shadowDbPath)
    : undefined;
  if (!shadowDbPath) {
    return {
      status: "skipped",
      reasons: ["loaded shadow LadybugDB path is not available"],
    };
  }

  try {
    const kuzu = await import("kuzu");
    const db = new kuzu.Database(shadowDbPath);
    const shadowConn = new kuzu.Connection(db);
    try {
      const stagedAuxiliarySymbolIds = await readStagedAuxiliarySymbolIds(
        shadowConn,
        params.repoId,
      );
      const bulkLoad = await copyFinalizedRows({
        activeConn: params.activeConn,
        shadowConn,
        repoId: params.repoId,
        versionId: params.versionId,
        shadowDbPath,
        stagedAuxiliarySymbolIds,
      });
      const expectedCounts = await readFinalizationCounts(
        params.activeConn,
        params.repoId,
        params.versionId,
        stagedAuxiliarySymbolIds,
      );
      const actualCounts = await readFinalizationCounts(
        shadowConn,
        params.repoId,
        params.versionId,
      );
      const mismatches = finalizationCountMismatches(
        expectedCounts,
        actualCounts,
      );
      if (mismatches.length > 0) {
        return {
          status: "failed",
          shadowDbPath,
          expectedCounts,
          actualCounts,
          reasons: mismatches,
        };
      }
      await execDdl(shadowConn, "CHECKPOINT");
      return {
        status: "finalized",
        shadowDbPath,
        copyMode: "bulkCsv",
        bulkLoad,
        expectedCounts,
        actualCounts,
        finalizedAt: new Date().toISOString(),
        reasons: [],
      };
    } finally {
      await shadowConn.close().catch(() => {});
      await db.close().catch(() => {});
    }
  } catch (err) {
    return {
      status: "failed",
      shadowDbPath,
      reasons: [`shadow DB finalization failed: ${errorMessage(err)}`],
    };
  }
}

async function copyFinalizedRows(params: {
  activeConn: Connection;
  shadowConn: Connection;
  repoId: string;
  versionId: string;
  shadowDbPath: string;
  stagedAuxiliarySymbolIds: ReadonlySet<string>;
}): Promise<ProviderFirstShadowFinalizationBulkLoadSummary> {
  const version = await ladybugDb.getVersion(params.activeConn, params.versionId);
  if (!version) {
    throw new Error(`active version ${params.versionId} was not found`);
  }

  // Keep reads ordered on the active LadybugDB connection; finalization is an
  // activation safety gate, so deterministic driver usage matters more here
  // than overlapping queries on one connection.
  const edges = (
    await ladybugDb.getEdgesByRepo(params.activeConn, params.repoId)
  ).filter(
    (edge) =>
      !params.stagedAuxiliarySymbolIds.has(edge.fromSymbolId) &&
      !params.stagedAuxiliarySymbolIds.has(edge.toSymbolId),
  );
  const auxiliarySymbols = await readAuxiliarySymbolsForRepo(
    params.activeConn,
    params.repoId,
  );
  const auxiliarySymbolIds = new Set(
    auxiliarySymbols.map((symbol) => symbol.symbolId),
  );
  const edgeEndpointSymbols = await readEdgeTargetSymbolsForRepo(
    params.activeConn,
    params.repoId,
    new Set([...auxiliarySymbolIds, ...params.stagedAuxiliarySymbolIds]),
  );
  const symbolVersions = await readRealSymbolVersionsForRepoAtVersion(
    params.activeConn,
    params.repoId,
    params.versionId,
    params.stagedAuxiliarySymbolIds,
  );
  const metrics = await readMetricsForRepo(
    params.activeConn,
    params.repoId,
    params.stagedAuxiliarySymbolIds,
  );
  const fileSummaries = await ladybugDb.getFileSummariesForRepo(
    params.activeConn,
    params.repoId,
  );
  const clusters = await ladybugDb.getClustersForRepo(
    params.activeConn,
    params.repoId,
  );
  const clusterMembers = await ladybugDb.getClusterMembersWithScoresForRepo(
    params.activeConn,
    params.repoId,
  );
  const processes = await ladybugDb.getProcessesForRepo(
    params.activeConn,
    params.repoId,
  );
  const processSteps = await ladybugDb.getProcessStepsForRepo(
    params.activeConn,
    params.repoId,
  );
  const shadowClusters = await ladybugDb.getShadowClustersForRepo(
    params.activeConn,
    params.repoId,
  );
  const shadowClusterMembers = await ladybugDb.getShadowClusterMembersForRepo(
    params.activeConn,
    params.repoId,
  );
  const derivedState = await readDerivedStateRow(
    params.activeConn,
    params.repoId,
  );
  const semanticProviderRuns = await readSemanticProviderRunsForRepo(
    params.activeConn,
    params.repoId,
  );
  const semanticDiagnostics = await readSemanticDiagnosticsForRepo(
    params.activeConn,
    params.repoId,
  );
  const bulkAuxiliarySymbols = auxiliarySymbols.filter(isSymbolRelCopySafe);
  const fallbackAuxiliarySymbols = auxiliarySymbols.filter(
    (row) => !isSymbolRelCopySafe(row),
  );
  const bulkEdges = edges.filter(isEdgeRelCopySafe);
  const fallbackEdges = edges.filter((row) => !isEdgeRelCopySafe(row));
  const bulkClusterMembers = clusterMembers.filter(isClusterMemberRelCopySafe);
  const fallbackClusterMembers = clusterMembers.filter(
    (row) => !isClusterMemberRelCopySafe(row),
  );
  const bulkProcessSteps = processSteps.filter(isProcessStepRelCopySafe);
  const fallbackProcessSteps = processSteps.filter(
    (row) => !isProcessStepRelCopySafe(row),
  );
  const bulkShadowClusterMembers = shadowClusterMembers.filter(
    isShadowClusterMemberRelCopySafe,
  );
  const fallbackShadowClusterMembers = shadowClusterMembers.filter(
    (row) => !isShadowClusterMemberRelCopySafe(row),
  );

  const stagingDir = join(dirname(params.shadowDbPath), "finalization");
  const manifestPath = join(stagingDir, "manifest.json");
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  const artifacts = [
    await writeCsvArtifact({
      stagingDir,
      fileName: "auxiliary-symbols.csv",
      columns: [...SYMBOL_COLUMNS],
      targetTable: "Symbol",
      kind: "node",
      rows: bulkAuxiliarySymbols,
      mapRow: auxiliarySymbolToCopyCells,
    }),
    await writeCsvArtifact({
      stagingDir,
      fileName: "auxiliary-symbol-in-repo.csv",
      columns: [...SYMBOL_IN_REPO_COLUMNS],
      targetTable: "SYMBOL_IN_REPO",
      kind: "relationship",
      rows: bulkAuxiliarySymbols,
      mapRow: (row) => [row.symbolId, row.repoId],
    }),
    await writeCsvArtifact({
      stagingDir,
      fileName: "depends-on.csv",
      columns: [...EDGE_COLUMNS],
      targetTable: "DEPENDS_ON",
      kind: "relationship",
      rows: bulkEdges,
      mapRow: edgeToCopyCells,
    }),
    await writeCsvArtifact({
      stagingDir,
      fileName: "versions.csv",
      columns: [...VERSION_COLUMNS],
      targetTable: "Version",
      kind: "node",
      rows: [version],
      mapRow: (row) => [
        row.versionId,
        row.createdAt,
        row.reason,
        row.prevVersionHash,
        row.versionHash,
      ],
    }),
    await writeCsvArtifact({
      stagingDir,
      fileName: "version-of-repo.csv",
      columns: [...VERSION_OF_REPO_COLUMNS],
      targetTable: "VERSION_OF_REPO",
      kind: "relationship",
      rows: [version],
      mapRow: (row) => [row.versionId, row.repoId],
    }),
    await writeCsvArtifact({
      stagingDir,
      fileName: "symbol-versions.csv",
      columns: [...SYMBOL_VERSION_COLUMNS],
      targetTable: "SymbolVersion",
      kind: "node",
      rows: symbolVersions,
      mapRow: (row) => [
        row.id,
        row.versionId,
        row.symbolId,
        row.astFingerprint,
        row.signatureJson,
        row.summary,
        row.invariantsJson,
        row.sideEffectsJson,
      ],
    }),
    await writeCsvArtifact({
      stagingDir,
      fileName: "metrics.csv",
      columns: [...METRICS_COLUMNS],
      targetTable: "Metrics",
      kind: "node",
      rows: metrics,
      mapRow: (row) => [
        row.symbolId,
        row.fanIn,
        row.fanOut,
        row.churn30d,
        row.testRefsJson,
        row.canonicalTestJson,
        row.pageRank,
        row.kCore,
        row.updatedAt,
      ],
    }),
    await writeCsvArtifact({
      stagingDir,
      fileName: "file-summaries.csv",
      columns: [...FILE_SUMMARY_COLUMNS],
      targetTable: "FileSummary",
      kind: "node",
      rows: fileSummaries,
      mapRow: fileSummaryToCopyCells,
    }),
    await writeCsvArtifact({
      stagingDir,
      fileName: "file-summary-in-repo.csv",
      columns: [...FILE_SUMMARY_IN_REPO_COLUMNS],
      targetTable: "FILE_SUMMARY_IN_REPO",
      kind: "relationship",
      rows: fileSummaries,
      mapRow: (row) => [row.fileId, row.repoId],
    }),
    await writeCsvArtifact({
      stagingDir,
      fileName: "summary-of-file.csv",
      columns: [...SUMMARY_OF_FILE_COLUMNS],
      targetTable: "SUMMARY_OF_FILE",
      kind: "relationship",
      rows: fileSummaries,
      mapRow: (row) => [row.fileId, row.fileId],
    }),
    await writeCsvArtifact({
      stagingDir,
      fileName: "clusters.csv",
      columns: [...CLUSTER_COLUMNS],
      targetTable: "Cluster",
      kind: "node",
      rows: clusters,
      mapRow: (row) => [
        row.clusterId,
        row.repoId,
        row.label,
        row.symbolCount,
        row.cohesionScore,
        row.versionId,
        row.createdAt,
        row.searchText,
      ],
    }),
    await writeCsvArtifact({
      stagingDir,
      fileName: "cluster-in-repo.csv",
      columns: [...CLUSTER_IN_REPO_COLUMNS],
      targetTable: "CLUSTER_IN_REPO",
      kind: "relationship",
      rows: clusters,
      mapRow: (row) => [row.clusterId, row.repoId],
    }),
    await writeCsvArtifact({
      stagingDir,
      fileName: "belongs-to-cluster.csv",
      columns: [...BELONGS_TO_CLUSTER_COLUMNS],
      targetTable: "BELONGS_TO_CLUSTER",
      kind: "relationship",
      rows: bulkClusterMembers,
      mapRow: (row) => [row.symbolId, row.clusterId, row.membershipScore],
    }),
    await writeCsvArtifact({
      stagingDir,
      fileName: "processes.csv",
      columns: [...PROCESS_COLUMNS],
      targetTable: "Process",
      kind: "node",
      rows: processes,
      mapRow: (row) => [
        row.processId,
        row.repoId,
        row.entrySymbolId,
        row.label,
        row.depth,
        row.versionId,
        row.createdAt,
        row.searchText,
      ],
    }),
    await writeCsvArtifact({
      stagingDir,
      fileName: "process-in-repo.csv",
      columns: [...PROCESS_IN_REPO_COLUMNS],
      targetTable: "PROCESS_IN_REPO",
      kind: "relationship",
      rows: processes,
      mapRow: (row) => [row.processId, row.repoId],
    }),
    await writeCsvArtifact({
      stagingDir,
      fileName: "participates-in.csv",
      columns: [...PARTICIPATES_IN_COLUMNS],
      targetTable: "PARTICIPATES_IN",
      kind: "relationship",
      rows: bulkProcessSteps,
      mapRow: (row) => [
        row.symbolId,
        row.processId,
        row.stepOrder,
        row.role ?? "",
      ],
    }),
    await writeCsvArtifact({
      stagingDir,
      fileName: "shadow-clusters.csv",
      columns: [...SHADOW_CLUSTER_COLUMNS],
      targetTable: "ShadowCluster",
      kind: "node",
      rows: shadowClusters,
      mapRow: (row) => [
        row.shadowClusterId,
        row.repoId,
        row.algorithm,
        row.label,
        row.symbolCount,
        row.modularity,
        row.versionId,
        row.createdAt,
      ],
    }),
    await writeCsvArtifact({
      stagingDir,
      fileName: "shadow-cluster-in-repo.csv",
      columns: [...SHADOW_CLUSTER_IN_REPO_COLUMNS],
      targetTable: "SHADOW_CLUSTER_IN_REPO",
      kind: "relationship",
      rows: shadowClusters,
      mapRow: (row) => [row.shadowClusterId, row.repoId],
    }),
    await writeCsvArtifact({
      stagingDir,
      fileName: "belongs-to-shadow-cluster.csv",
      columns: [...BELONGS_TO_SHADOW_CLUSTER_COLUMNS],
      targetTable: "BELONGS_TO_SHADOW_CLUSTER",
      kind: "relationship",
      rows: bulkShadowClusterMembers,
      mapRow: (row) => [
        row.symbolId,
        row.shadowClusterId,
        row.membershipScore,
      ],
    }),
    await writeCsvArtifact({
      stagingDir,
      fileName: "derived-state.csv",
      columns: [...DERIVED_STATE_COLUMNS],
      targetTable: "DerivedState",
      kind: "node",
      rows: derivedState ? [derivedState] : [],
      mapRow: (row) => [
        row.repoId,
        row.clustersDirty,
        row.processesDirty,
        row.algorithmsDirty,
        row.summariesDirty,
        row.embeddingsDirty,
        row.targetVersionId,
        row.computedVersionId,
        row.updatedAt,
        row.lastError,
      ],
    }),
  ];

  await resetBulkFinalizationTargets(params.shadowConn, params.repoId);
  await ensureEdgeEndpointSymbols(params.shadowConn, edgeEndpointSymbols);
  for (const artifact of artifacts) {
    await copyArtifact(params.shadowConn, artifact.targetTable, artifact);
  }
  await upsertAuxiliarySymbolsFallback(
    params.shadowConn,
    fallbackAuxiliarySymbols,
  );
  await upsertFinalizedEdgesFallback(params.shadowConn, fallbackEdges);
  const callProvenanceRepairs =
    await ladybugDb.normalizeProviderFirstCallEdgeProvenance(
      params.shadowConn,
      params.repoId,
    );
  await replaceSemanticProvenanceRows(
    params.shadowConn,
    params.repoId,
    semanticProviderRuns,
    semanticDiagnostics,
  );
  await upsertClusterMembersFallback(params.shadowConn, fallbackClusterMembers);
  await upsertProcessStepsFallback(params.shadowConn, fallbackProcessSteps);
  await upsertShadowClusterMembersFallback(
    params.shadowConn,
    fallbackShadowClusterMembers,
  );

  const bulkLoad: ProviderFirstShadowFinalizationBulkLoadSummary = {
    status: "loaded",
    stagingDir: normalizePath(stagingDir),
    manifestPath: normalizePath(manifestPath),
    copiedAt: new Date().toISOString(),
    artifacts,
  };
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        version: 1,
        kind: "provider-first-shadow-finalization",
        repoId: params.repoId,
        generationVersionId: params.versionId,
        copiedAt: bulkLoad.copiedAt,
        artifacts,
        fallbackRows: {
          auxiliarySymbols: fallbackAuxiliarySymbols.length,
          edges: fallbackEdges.length,
          clusterMembers: fallbackClusterMembers.length,
          processSteps: fallbackProcessSteps.length,
          shadowClusterMembers: fallbackShadowClusterMembers.length,
          semanticProviderRuns: semanticProviderRuns.length,
          semanticDiagnostics: semanticDiagnostics.length,
          providerFirstCallProvenanceRepairs: callProvenanceRepairs,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return bulkLoad;
}

async function readSemanticProviderRunsForRepo(
  conn: Connection,
  repoId: string,
): Promise<SemanticProviderRunCopyRow[]> {
  const rows = await ladybugDb.queryAll<{
    runId: string;
    repoId: string;
    providerType: string | null;
    providerId: string | null;
    providerVersion: string | null;
    languagesJson: string | null;
    sourceIndexPath: string | null;
    sourceHash: string | null;
    cacheKey: string | null;
    configHash: string | null;
    ledgerVersion: string | null;
    status: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    documentsProcessed: unknown;
    symbolsMatched: unknown;
    edgesCreated: unknown;
    edgesUpgraded: unknown;
    edgesReplaced: unknown;
    edgesSkipped: unknown;
    diagnosticsCount: unknown;
    precisionScore: unknown;
    cacheHit: unknown;
    canAffectPass2: unknown;
    selected: unknown;
    metadataJson: string | null;
    error: string | null;
  }>(
    conn,
    `MATCH (r:SemanticProviderRun {repoId: $repoId})
     RETURN r.runId AS runId,
            r.repoId AS repoId,
            r.providerType AS providerType,
            r.providerId AS providerId,
            r.providerVersion AS providerVersion,
            r.languagesJson AS languagesJson,
            r.sourceIndexPath AS sourceIndexPath,
            r.sourceHash AS sourceHash,
            r.cacheKey AS cacheKey,
            r.configHash AS configHash,
            r.ledgerVersion AS ledgerVersion,
            r.status AS status,
            r.startedAt AS startedAt,
            r.finishedAt AS finishedAt,
            coalesce(r.documentsProcessed, 0) AS documentsProcessed,
            coalesce(r.symbolsMatched, 0) AS symbolsMatched,
            coalesce(r.edgesCreated, 0) AS edgesCreated,
            coalesce(r.edgesUpgraded, 0) AS edgesUpgraded,
            coalesce(r.edgesReplaced, 0) AS edgesReplaced,
            coalesce(r.edgesSkipped, 0) AS edgesSkipped,
            coalesce(r.diagnosticsCount, 0) AS diagnosticsCount,
            coalesce(r.precisionScore, 0.0) AS precisionScore,
            coalesce(r.cacheHit, false) AS cacheHit,
            coalesce(r.canAffectPass2, false) AS canAffectPass2,
            coalesce(r.selected, true) AS selected,
            r.metadataJson AS metadataJson,
            r.error AS error
     ORDER BY runId`,
    { repoId },
  );
  return rows.map((row) => ({
    runId: row.runId,
    repoId: row.repoId,
    providerType: row.providerType ?? "unknown",
    providerId: row.providerId ?? "unknown",
    providerVersion: row.providerVersion ?? null,
    languagesJson: row.languagesJson ?? "[]",
    sourceIndexPath: row.sourceIndexPath ?? null,
    sourceHash: row.sourceHash ?? null,
    cacheKey: row.cacheKey ?? null,
    configHash: row.configHash ?? null,
    ledgerVersion: row.ledgerVersion ?? null,
    status: row.status ?? "completed",
    startedAt: row.startedAt ?? "",
    finishedAt: row.finishedAt ?? null,
    documentsProcessed: ladybugDb.toNumber(row.documentsProcessed),
    symbolsMatched: ladybugDb.toNumber(row.symbolsMatched),
    edgesCreated: ladybugDb.toNumber(row.edgesCreated),
    edgesUpgraded: ladybugDb.toNumber(row.edgesUpgraded),
    edgesReplaced: ladybugDb.toNumber(row.edgesReplaced),
    edgesSkipped: ladybugDb.toNumber(row.edgesSkipped),
    diagnosticsCount: ladybugDb.toNumber(row.diagnosticsCount),
    precisionScore: ladybugDb.toNumber(row.precisionScore),
    cacheHit: ladybugDb.toBoolean(row.cacheHit),
    canAffectPass2: ladybugDb.toBoolean(row.canAffectPass2),
    selected: ladybugDb.toBoolean(row.selected),
    metadataJson: row.metadataJson ?? "{}",
    error: row.error ?? null,
  }));
}

async function readSemanticDiagnosticsForRepo(
  conn: Connection,
  repoId: string,
): Promise<SemanticDiagnosticCopyRow[]> {
  const rows = await ladybugDb.queryAll<{
    id: string;
    repoId: string;
    runId: string | null;
    providerType: string | null;
    providerId: string | null;
    languageId: string | null;
    sourcePath: string | null;
    severity: string | null;
    message: string | null;
    code: string | null;
    rangeJson: string | null;
    createdAt: string | null;
  }>(
    conn,
    `MATCH (d:SemanticDiagnostic {repoId: $repoId})
     RETURN d.id AS id,
            d.repoId AS repoId,
            d.runId AS runId,
            d.providerType AS providerType,
            d.providerId AS providerId,
            d.languageId AS languageId,
            d.sourcePath AS sourcePath,
            d.severity AS severity,
            d.message AS message,
            d.code AS code,
            d.rangeJson AS rangeJson,
            d.createdAt AS createdAt
     ORDER BY id`,
    { repoId },
  );
  return rows.map((row) => ({
    id: row.id,
    repoId: row.repoId,
    runId: row.runId ?? "",
    providerType: row.providerType ?? "unknown",
    providerId: row.providerId ?? "unknown",
    languageId: row.languageId ?? null,
    sourcePath: row.sourcePath ?? null,
    severity: row.severity ?? "info",
    message: row.message ?? "",
    code: row.code ?? null,
    rangeJson: row.rangeJson ?? "{}",
    createdAt: row.createdAt ?? "",
  }));
}

async function replaceSemanticProvenanceRows(
  conn: Connection,
  repoId: string,
  providerRuns: readonly SemanticProviderRunCopyRow[],
  diagnostics: readonly SemanticDiagnosticCopyRow[],
): Promise<void> {
  await exec(
    conn,
    `MATCH (d:SemanticDiagnostic {repoId: $repoId})
     DELETE d`,
    { repoId },
  );
  await exec(
    conn,
    `MATCH (r:SemanticProviderRun {repoId: $repoId})
     DELETE r`,
    { repoId },
  );

  const chunkSize = 256;
  for (let i = 0; i < providerRuns.length; i += chunkSize) {
    const rows = providerRuns.slice(i, i + chunkSize);
    await exec(
      conn,
      `UNWIND $rows AS row
       MERGE (r:SemanticProviderRun {runId: row.runId})
       SET r.repoId = row.repoId,
           r.providerType = row.providerType,
           r.providerId = row.providerId,
           r.providerVersion = row.providerVersion,
           r.languagesJson = row.languagesJson,
           r.sourceIndexPath = row.sourceIndexPath,
           r.sourceHash = row.sourceHash,
           r.cacheKey = row.cacheKey,
           r.configHash = row.configHash,
           r.ledgerVersion = row.ledgerVersion,
           r.status = row.status,
           r.startedAt = row.startedAt,
           r.finishedAt = row.finishedAt,
           r.documentsProcessed = row.documentsProcessed,
           r.symbolsMatched = row.symbolsMatched,
           r.edgesCreated = row.edgesCreated,
           r.edgesUpgraded = row.edgesUpgraded,
           r.edgesReplaced = row.edgesReplaced,
           r.edgesSkipped = row.edgesSkipped,
           r.diagnosticsCount = row.diagnosticsCount,
           r.precisionScore = row.precisionScore,
           r.cacheHit = row.cacheHit,
           r.canAffectPass2 = row.canAffectPass2,
           r.selected = row.selected,
           r.metadataJson = row.metadataJson,
           r.error = row.error`,
      { rows },
    );
  }

  for (let i = 0; i < diagnostics.length; i += chunkSize) {
    const rows = diagnostics.slice(i, i + chunkSize);
    await exec(
      conn,
      `UNWIND $rows AS row
       MERGE (d:SemanticDiagnostic {id: row.id})
       SET d.repoId = row.repoId,
           d.runId = row.runId,
           d.providerType = row.providerType,
           d.providerId = row.providerId,
           d.languageId = row.languageId,
           d.sourcePath = row.sourcePath,
           d.severity = row.severity,
           d.message = row.message,
           d.code = row.code,
           d.rangeJson = row.rangeJson,
           d.createdAt = row.createdAt`,
      { rows },
    );
  }
}

async function readEdgeTargetSymbolsForRepo(
  conn: Connection,
  repoId: string,
  excludedSymbolIds: ReadonlySet<string>,
): Promise<AuxiliarySymbolRow[]> {
  const excluded = [...excludedSymbolIds];
  const exclusionClause =
    excluded.length > 0 ? "WHERE NOT target.symbolId IN $excludedSymbolIds" : "";
  const rows = await ladybugDb.queryAll<{
    symbolId: string;
    repoId: string | null;
    kind: string | null;
    name: string | null;
    exported: unknown;
    visibility: string | null;
    language: string | null;
    rangeStartLine: unknown;
    rangeStartCol: unknown;
    rangeEndLine: unknown;
    rangeEndCol: unknown;
    astFingerprint: string | null;
    signatureJson: string | null;
    summary: string | null;
    summaryQuality: unknown;
    summarySource: string | null;
    invariantsJson: string | null;
    sideEffectsJson: string | null;
    roleTagsJson: string | null;
    searchText: string | null;
    updatedAt: string | null;
    external: unknown;
    scipSymbol: string | null;
    source: string | null;
    packageName: string | null;
    packageVersion: string | null;
    symbolStatus: string | null;
    placeholderKind: string | null;
    placeholderTarget: string | null;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(source:Symbol)-[:DEPENDS_ON]->(target:Symbol)
     ${exclusionClause}
     RETURN DISTINCT target.symbolId AS symbolId,
            target.repoId AS repoId,
            target.kind AS kind,
            target.name AS name,
            coalesce(target.exported, false) AS exported,
            target.visibility AS visibility,
            target.language AS language,
            coalesce(target.rangeStartLine, 0) AS rangeStartLine,
            coalesce(target.rangeStartCol, 0) AS rangeStartCol,
            coalesce(target.rangeEndLine, 0) AS rangeEndLine,
            coalesce(target.rangeEndCol, 0) AS rangeEndCol,
            target.astFingerprint AS astFingerprint,
            target.signatureJson AS signatureJson,
            target.summary AS summary,
            coalesce(target.summaryQuality, 0.0) AS summaryQuality,
            coalesce(target.summarySource, 'unknown') AS summarySource,
            target.invariantsJson AS invariantsJson,
            target.sideEffectsJson AS sideEffectsJson,
            target.roleTagsJson AS roleTagsJson,
            target.searchText AS searchText,
            target.updatedAt AS updatedAt,
            coalesce(target.external, false) AS external,
            target.scipSymbol AS scipSymbol,
            target.source AS source,
            target.packageName AS packageName,
            target.packageVersion AS packageVersion,
            target.symbolStatus AS symbolStatus,
            target.placeholderKind AS placeholderKind,
            target.placeholderTarget AS placeholderTarget
     ORDER BY symbolId`,
    { repoId, excludedSymbolIds: excluded },
  );
  return rows.map((row) => ({
    symbolId: row.symbolId,
    repoId: row.repoId ?? repoId,
    kind: row.kind ?? "unknown",
    name: row.name ?? row.symbolId,
    exported: ladybugDb.toBoolean(row.exported),
    visibility: row.visibility,
    language: canonicalizeLanguageId(row.language),
    rangeStartLine: ladybugDb.toNumber(row.rangeStartLine ?? 0),
    rangeStartCol: ladybugDb.toNumber(row.rangeStartCol ?? 0),
    rangeEndLine: ladybugDb.toNumber(row.rangeEndLine ?? 0),
    rangeEndCol: ladybugDb.toNumber(row.rangeEndCol ?? 0),
    astFingerprint: row.astFingerprint ?? row.symbolId,
    signatureJson: row.signatureJson,
    summary: row.summary,
    summaryQuality: ladybugDb.toNumber(row.summaryQuality ?? 0),
    summarySource: row.summarySource ?? "unknown",
    invariantsJson: row.invariantsJson,
    sideEffectsJson: row.sideEffectsJson,
    roleTagsJson: row.roleTagsJson,
    searchText: row.searchText,
    updatedAt: row.updatedAt,
    external: ladybugDb.toBoolean(row.external),
    scipSymbol: row.scipSymbol,
    source: row.source,
    packageName: row.packageName,
    packageVersion: row.packageVersion,
    symbolStatus: row.symbolStatus ?? "real",
    placeholderKind: row.placeholderKind,
    placeholderTarget: row.placeholderTarget,
  }));
}

function isSymbolRelCopySafe(row: AuxiliarySymbolRow): boolean {
  return copyRelEndpointIsSafe(row.symbolId) && copyRelEndpointIsSafe(row.repoId);
}

function isEdgeRelCopySafe(row: ladybugDb.EdgeRow): boolean {
  return (
    copyRelEndpointIsSafe(row.fromSymbolId) &&
    copyRelEndpointIsSafe(row.toSymbolId) &&
    edgeToCopyCells(row).slice(2).every(copyRelCellIsSafe) &&
    pass2CppProvenanceIsCopySafe(row)
  );
}

function isClusterMemberRelCopySafe(
  row: ladybugDb.ClusterMemberForRepoRow,
): boolean {
  return (
    copyRelEndpointIsSafe(row.symbolId) &&
    copyRelEndpointIsSafe(row.clusterId)
  );
}

function isProcessStepRelCopySafe(
  row: ladybugDb.ProcessStepForRepoRow,
): boolean {
  return (
    copyRelEndpointIsSafe(row.symbolId) &&
    copyRelEndpointIsSafe(row.processId) &&
    copyRelCellIsSafe(row.role ?? "")
  );
}

function isShadowClusterMemberRelCopySafe(
  row: ladybugDb.ShadowClusterMemberForRepoRow,
): boolean {
  return (
    copyRelEndpointIsSafe(row.symbolId) &&
    copyRelEndpointIsSafe(row.shadowClusterId)
  );
}

function edgeToCopyCells(row: ladybugDb.EdgeRow): unknown[] {
  return [
    row.fromSymbolId,
    row.toSymbolId,
    row.edgeType,
    row.weight,
    row.confidence,
    row.resolution,
    row.resolverId ?? "pass1-generic",
    row.resolutionPhase ?? "pass1",
    row.provenance,
    row.createdAt,
  ];
}

function copyRelEndpointIsSafe(value: string): boolean {
  // LadybugDB relationship COPY resolves endpoints by primary-key literal.
  // Quoted IDs can bulk-load as node keys but still fail endpoint lookup.
  return !/["\r\n]/.test(value);
}

function copyRelCellIsSafe(value: unknown): boolean {
  return typeof value !== "string" || !/[\r\n]/.test(value);
}

function pass2CppProvenanceIsCopySafe(row: ladybugDb.EdgeRow): boolean {
  if (row.resolverId !== "pass2-cpp") return true;
  return !requiresCsvQuoting(row.provenance ?? "");
}

function requiresCsvQuoting(value: unknown): boolean {
  return typeof value === "string" && /[",\r\n]/.test(value);
}

async function ensureEdgeEndpointSymbols(
  conn: Connection,
  rows: AuxiliarySymbolRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const chunkSize = 256;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize).map(symbolRowToFallbackParams);
    await exec(
      conn,
      `UNWIND $rows AS row
       MERGE (s:Symbol {symbolId: row.symbolId})
       ON CREATE SET s.repoId = row.repoId,
           s.kind = row.kind,
           s.name = row.name,
           s.exported = row.exported,
           s.visibility = row.visibility,
           s.language = row.language,
           s.rangeStartLine = row.rangeStartLine,
           s.rangeStartCol = row.rangeStartCol,
           s.rangeEndLine = row.rangeEndLine,
           s.rangeEndCol = row.rangeEndCol,
           s.astFingerprint = row.astFingerprint,
           s.signatureJson = row.signatureJson,
           s.summary = row.summary,
           s.summaryQuality = row.summaryQuality,
           s.summarySource = row.summarySource,
           s.invariantsJson = row.invariantsJson,
           s.sideEffectsJson = row.sideEffectsJson,
           s.roleTagsJson = row.roleTagsJson,
           s.searchText = row.searchText,
           s.updatedAt = row.updatedAt,
           s.external = row.external,
           s.scipSymbol = row.scipSymbol,
           s.source = row.source,
           s.packageName = row.packageName,
           s.packageVersion = row.packageVersion,
           s.symbolStatus = row.symbolStatus,
           s.placeholderKind = row.placeholderKind,
           s.placeholderTarget = row.placeholderTarget`,
      { rows: chunk },
    );
  }
}

async function upsertAuxiliarySymbolsFallback(
  conn: Connection,
  rows: AuxiliarySymbolRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const chunkSize = 256;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize).map(symbolRowToFallbackParams);
    await exec(
      conn,
      `UNWIND $rows AS row
       MERGE (s:Symbol {symbolId: row.symbolId})
       SET s.repoId = row.repoId,
           s.kind = row.kind,
           s.name = row.name,
           s.exported = row.exported,
           s.visibility = row.visibility,
           s.language = row.language,
           s.rangeStartLine = row.rangeStartLine,
           s.rangeStartCol = row.rangeStartCol,
           s.rangeEndLine = row.rangeEndLine,
           s.rangeEndCol = row.rangeEndCol,
           s.astFingerprint = row.astFingerprint,
           s.signatureJson = row.signatureJson,
           s.summary = row.summary,
           s.summaryQuality = row.summaryQuality,
           s.summarySource = row.summarySource,
           s.invariantsJson = row.invariantsJson,
           s.sideEffectsJson = row.sideEffectsJson,
           s.roleTagsJson = row.roleTagsJson,
           s.searchText = row.searchText,
           s.updatedAt = row.updatedAt,
           s.external = row.external,
           s.scipSymbol = row.scipSymbol,
           s.source = row.source,
           s.packageName = row.packageName,
           s.packageVersion = row.packageVersion,
           s.symbolStatus = row.symbolStatus,
           s.placeholderKind = row.placeholderKind,
           s.placeholderTarget = row.placeholderTarget`,
      { rows: chunk },
    );
    await exec(
      conn,
      `UNWIND $rows AS row
       MATCH (r:Repo {repoId: row.repoId})
       MATCH (s:Symbol {symbolId: row.symbolId})
       OPTIONAL MATCH (s)-[existing:SYMBOL_IN_REPO]->(r)
       WITH s, r, existing
       WHERE existing IS NULL
       CREATE (s)-[:SYMBOL_IN_REPO]->(r)`,
      { rows: chunk },
    );
  }
}

async function upsertFinalizedEdgesFallback(
  conn: Connection,
  edges: ladybugDb.EdgeRow[],
): Promise<void> {
  if (edges.length === 0) return;
  const chunkSize = 256;
  for (let i = 0; i < edges.length; i += chunkSize) {
    const rows = edges.slice(i, i + chunkSize).map((edge) => ({
      fromSymbolId: edge.fromSymbolId,
      toSymbolId: edge.toSymbolId,
      edgeType: edge.edgeType,
      weight: edge.weight,
      confidence: edge.confidence,
      resolution: edge.resolution,
      resolverId: edge.resolverId ?? "pass1-generic",
      resolutionPhase: edge.resolutionPhase ?? "pass1",
      provenance: edge.provenance ?? "",
      createdAt: edge.createdAt,
    }));
    await exec(
      conn,
      `UNWIND $rows AS row
       MATCH (a:Symbol {symbolId: row.fromSymbolId})
       MATCH (b:Symbol {symbolId: row.toSymbolId})
       OPTIONAL MATCH (a)-[existing:DEPENDS_ON {edgeType: row.edgeType}]->(b)
       WITH a, b, row, existing
       WHERE existing IS NULL
       CREATE (a)-[:DEPENDS_ON {
         edgeType: row.edgeType,
         weight: row.weight,
         confidence: row.confidence,
         resolution: row.resolution,
         resolverId: row.resolverId,
         resolutionPhase: row.resolutionPhase,
         provenance: row.provenance,
         createdAt: row.createdAt
       }]->(b)`,
      { rows },
    );
    await exec(
      conn,
      `UNWIND $rows AS row
       MATCH (a:Symbol {symbolId: row.fromSymbolId})
       MATCH (b:Symbol {symbolId: row.toSymbolId})
       MATCH (a)-[d:DEPENDS_ON {edgeType: row.edgeType}]->(b)
       SET d.weight = row.weight,
           d.confidence = row.confidence,
           d.resolution = row.resolution,
           d.resolverId = row.resolverId,
           d.resolutionPhase = row.resolutionPhase,
           d.provenance = row.provenance`,
      { rows },
    );
  }
}

async function upsertClusterMembersFallback(
  conn: Connection,
  members: ladybugDb.ClusterMemberForRepoRow[],
): Promise<void> {
  if (members.length === 0) return;
  const chunkSize = 256;
  for (let i = 0; i < members.length; i += chunkSize) {
    const rows = members.slice(i, i + chunkSize).map((member) => ({
      symbolId: member.symbolId,
      clusterId: member.clusterId,
      membershipScore: member.membershipScore,
    }));
    await exec(
      conn,
      `UNWIND $rows AS row
       MATCH (s:Symbol {symbolId: row.symbolId})
       MATCH (c:Cluster {clusterId: row.clusterId})
       OPTIONAL MATCH (s)-[existing:BELONGS_TO_CLUSTER]->(c)
       WITH s, c, row, existing
       WHERE existing IS NULL
       CREATE (s)-[:BELONGS_TO_CLUSTER {
         membershipScore: row.membershipScore
       }]->(c)`,
      { rows },
    );
    await exec(
      conn,
      `UNWIND $rows AS row
       MATCH (s:Symbol {symbolId: row.symbolId})
       MATCH (c:Cluster {clusterId: row.clusterId})
       MATCH (s)-[m:BELONGS_TO_CLUSTER]->(c)
       SET m.membershipScore = row.membershipScore`,
      { rows },
    );
  }
}

async function upsertProcessStepsFallback(
  conn: Connection,
  steps: ladybugDb.ProcessStepForRepoRow[],
): Promise<void> {
  if (steps.length === 0) return;
  const chunkSize = 256;
  for (let i = 0; i < steps.length; i += chunkSize) {
    const rows = steps.slice(i, i + chunkSize).map((step) => ({
      symbolId: step.symbolId,
      processId: step.processId,
      stepOrder: step.stepOrder,
      role: step.role ?? "",
    }));
    await exec(
      conn,
      `UNWIND $rows AS row
       MATCH (s:Symbol {symbolId: row.symbolId})
       MATCH (p:Process {processId: row.processId})
       OPTIONAL MATCH (s)-[existing:PARTICIPATES_IN]->(p)
       WITH s, p, row, existing
       WHERE existing IS NULL
       CREATE (s)-[:PARTICIPATES_IN {
         stepOrder: row.stepOrder,
         role: row.role
       }]->(p)`,
      { rows },
    );
    await exec(
      conn,
      `UNWIND $rows AS row
       MATCH (s:Symbol {symbolId: row.symbolId})
       MATCH (p:Process {processId: row.processId})
       MATCH (s)-[step:PARTICIPATES_IN]->(p)
       SET step.stepOrder = row.stepOrder,
           step.role = row.role`,
      { rows },
    );
  }
}

async function upsertShadowClusterMembersFallback(
  conn: Connection,
  members: ladybugDb.ShadowClusterMemberForRepoRow[],
): Promise<void> {
  if (members.length === 0) return;
  const chunkSize = 256;
  for (let i = 0; i < members.length; i += chunkSize) {
    const rows = members.slice(i, i + chunkSize).map((member) => ({
      symbolId: member.symbolId,
      shadowClusterId: member.shadowClusterId,
      membershipScore: member.membershipScore,
    }));
    await exec(
      conn,
      `UNWIND $rows AS row
       MATCH (s:Symbol {symbolId: row.symbolId})
       MATCH (c:ShadowCluster {shadowClusterId: row.shadowClusterId})
       OPTIONAL MATCH (s)-[existing:BELONGS_TO_SHADOW_CLUSTER]->(c)
       WITH s, c, row, existing
       WHERE existing IS NULL
       CREATE (s)-[:BELONGS_TO_SHADOW_CLUSTER {
         membershipScore: row.membershipScore
       }]->(c)`,
      { rows },
    );
    await exec(
      conn,
      `UNWIND $rows AS row
       MATCH (s:Symbol {symbolId: row.symbolId})
       MATCH (c:ShadowCluster {shadowClusterId: row.shadowClusterId})
       MATCH (s)-[m:BELONGS_TO_SHADOW_CLUSTER]->(c)
       SET m.membershipScore = row.membershipScore`,
      { rows },
    );
  }
}

function symbolRowToFallbackParams(row: AuxiliarySymbolRow): {
  symbolId: string;
  repoId: string;
  kind: string;
  name: string;
  exported: boolean;
  visibility: string;
  language: string;
  rangeStartLine: number;
  rangeStartCol: number;
  rangeEndLine: number;
  rangeEndCol: number;
  astFingerprint: string;
  signatureJson: string;
  summary: string;
  summaryQuality: number;
  summarySource: string;
  invariantsJson: string;
  sideEffectsJson: string;
  roleTagsJson: string;
  searchText: string;
  updatedAt: string;
  external: boolean;
  scipSymbol: string;
  source: string;
  packageName: string;
  packageVersion: string;
  symbolStatus: string;
  placeholderKind: string;
  placeholderTarget: string;
} {
  return {
    symbolId: row.symbolId,
    repoId: row.repoId,
    kind: row.kind,
    name: row.name,
    exported: row.exported,
    visibility: row.visibility ?? "",
    language: canonicalizeLanguageId(row.language),
    rangeStartLine: row.rangeStartLine,
    rangeStartCol: row.rangeStartCol,
    rangeEndLine: row.rangeEndLine,
    rangeEndCol: row.rangeEndCol,
    astFingerprint: row.astFingerprint,
    signatureJson: row.signatureJson ?? "",
    summary: row.summary ?? "",
    summaryQuality: row.summaryQuality,
    summarySource: row.summarySource,
    invariantsJson: row.invariantsJson ?? "",
    sideEffectsJson: row.sideEffectsJson ?? "",
    roleTagsJson: row.roleTagsJson ?? "",
    searchText: row.searchText ?? "",
    updatedAt: row.updatedAt ?? "",
    external: row.external,
    scipSymbol: row.scipSymbol ?? "",
    source: row.source ?? "treesitter",
    packageName: row.packageName ?? "",
    packageVersion: row.packageVersion ?? "",
    symbolStatus: row.symbolStatus,
    placeholderKind: row.placeholderKind ?? "",
    placeholderTarget: row.placeholderTarget ?? "",
  };
}

async function readStagedAuxiliarySymbolIds(
  conn: Connection,
  repoId: string,
): Promise<Set<string>> {
  const rows = await ladybugDb.queryAll<{ symbolId: string }>(
    conn,
    `MATCH (:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
     WHERE coalesce(s.symbolStatus, 'real') <> 'real'
        OR coalesce(s.external, false) = true
     RETURN s.symbolId AS symbolId`,
    { repoId },
  );
  return new Set(rows.map((row) => row.symbolId));
}

async function resetBulkFinalizationTargets(
  conn: Connection,
  repoId: string,
): Promise<void> {
  // Finalization replaces the staged provider/fallback edge set with the
  // post-finalize active graph edge set. The shadow database is fresh for a
  // single repo, but keeping this explicit avoids duplicate COPY rows if a
  // failed finalize is retried in the same shadow database.
  await exec(conn, `MATCH (:Symbol)-[d:DEPENDS_ON]->(:Symbol) DELETE d`);
  await exec(
    conn,
    `MATCH (s:Symbol)-[rel:SYMBOL_IN_REPO]->(:Repo {repoId: $repoId})
     WHERE coalesce(s.symbolStatus, 'real') <> 'real'
        OR coalesce(s.external, false) = true
     DELETE rel`,
    { repoId },
  );
  await exec(
    conn,
    `MATCH (s:Symbol)-[rel:SYMBOL_IN_FILE]->(:File)
     WHERE s.repoId = $repoId
       AND (
         coalesce(s.symbolStatus, 'real') <> 'real'
         OR coalesce(s.external, false) = true
       )
     DELETE rel`,
    { repoId },
  );
  await exec(
    conn,
    `MATCH (s:Symbol {repoId: $repoId})
     WHERE coalesce(s.symbolStatus, 'real') <> 'real'
        OR coalesce(s.external, false) = true
     DELETE s`,
    { repoId },
  );
}

async function readAuxiliarySymbolsForRepo(
  conn: Connection,
  repoId: string,
): Promise<AuxiliarySymbolRow[]> {
  const rows = await ladybugDb.queryAll<{
    symbolId: string;
    repoId: string;
    kind: string | null;
    name: string | null;
    exported: unknown;
    visibility: string | null;
    language: string | null;
    rangeStartLine: unknown;
    rangeStartCol: unknown;
    rangeEndLine: unknown;
    rangeEndCol: unknown;
    astFingerprint: string | null;
    signatureJson: string | null;
    summary: string | null;
    summaryQuality: unknown;
    summarySource: string | null;
    invariantsJson: string | null;
    sideEffectsJson: string | null;
    roleTagsJson: string | null;
    searchText: string | null;
    updatedAt: string | null;
    external: unknown;
    scipSymbol: string | null;
    source: string | null;
    packageName: string | null;
    packageVersion: string | null;
    symbolStatus: string | null;
    placeholderKind: string | null;
    placeholderTarget: string | null;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
     WHERE coalesce(s.symbolStatus, 'real') <> 'real'
        OR coalesce(s.external, false) = true
     RETURN s.symbolId AS symbolId,
            r.repoId AS repoId,
            s.kind AS kind,
            s.name AS name,
            coalesce(s.exported, false) AS exported,
            s.visibility AS visibility,
            s.language AS language,
            coalesce(s.rangeStartLine, 0) AS rangeStartLine,
            coalesce(s.rangeStartCol, 0) AS rangeStartCol,
            coalesce(s.rangeEndLine, 0) AS rangeEndLine,
            coalesce(s.rangeEndCol, 0) AS rangeEndCol,
            s.astFingerprint AS astFingerprint,
            s.signatureJson AS signatureJson,
            s.summary AS summary,
            coalesce(s.summaryQuality, 0.0) AS summaryQuality,
            coalesce(s.summarySource, 'unknown') AS summarySource,
            s.invariantsJson AS invariantsJson,
            s.sideEffectsJson AS sideEffectsJson,
            s.roleTagsJson AS roleTagsJson,
            s.searchText AS searchText,
            s.updatedAt AS updatedAt,
            coalesce(s.external, false) AS external,
            s.scipSymbol AS scipSymbol,
            s.source AS source,
            s.packageName AS packageName,
            s.packageVersion AS packageVersion,
            s.symbolStatus AS symbolStatus,
            s.placeholderKind AS placeholderKind,
            s.placeholderTarget AS placeholderTarget
     ORDER BY s.symbolId`,
    { repoId },
  );
  return rows.map((row) => ({
    symbolId: row.symbolId,
    repoId: row.repoId,
    kind: row.kind ?? "unknown",
    name: row.name ?? row.symbolId,
    exported: ladybugDb.toBoolean(row.exported),
    visibility: row.visibility,
    language: canonicalizeLanguageId(row.language),
    rangeStartLine: ladybugDb.toNumber(row.rangeStartLine ?? 0),
    rangeStartCol: ladybugDb.toNumber(row.rangeStartCol ?? 0),
    rangeEndLine: ladybugDb.toNumber(row.rangeEndLine ?? 0),
    rangeEndCol: ladybugDb.toNumber(row.rangeEndCol ?? 0),
    astFingerprint: row.astFingerprint ?? row.symbolId,
    signatureJson: row.signatureJson,
    summary: row.summary,
    summaryQuality: ladybugDb.toNumber(row.summaryQuality ?? 0),
    summarySource: row.summarySource ?? "unknown",
    invariantsJson: row.invariantsJson,
    sideEffectsJson: row.sideEffectsJson,
    roleTagsJson: row.roleTagsJson,
    searchText: row.searchText,
    updatedAt: row.updatedAt,
    external: ladybugDb.toBoolean(row.external),
    scipSymbol: row.scipSymbol,
    source: row.source,
    packageName: row.packageName,
    packageVersion: row.packageVersion,
    symbolStatus: row.symbolStatus ?? "unresolved",
    placeholderKind: row.placeholderKind,
    placeholderTarget: row.placeholderTarget,
  }));
}

function auxiliarySymbolToCopyCells(row: AuxiliarySymbolRow): unknown[] {
  return [
    row.symbolId,
    row.repoId,
    row.kind,
    row.name,
    row.exported,
    row.visibility,
    canonicalizeLanguageId(row.language),
    row.rangeStartLine,
    row.rangeStartCol,
    row.rangeEndLine,
    row.rangeEndCol,
    row.astFingerprint,
    row.signatureJson,
    row.summary,
    row.summaryQuality,
    row.summarySource,
    row.invariantsJson,
    row.sideEffectsJson,
    row.roleTagsJson,
    row.searchText,
    row.updatedAt,
    null,
    null,
    null,
    CSV_ARRAY_NULL,
    null,
    null,
    null,
    null,
    null,
    null,
    CSV_ARRAY_NULL,
    CSV_ARRAY_NULL,
    row.external,
    row.scipSymbol,
    row.source,
    row.packageName,
    row.packageVersion,
    row.symbolStatus,
    row.placeholderKind,
    row.placeholderTarget,
  ];
}

function fileSummaryToCopyCells(
  row: ladybugDb.FileSummaryRow,
): unknown[] {
  return [
    row.fileId,
    row.repoId,
    row.summary,
    row.searchText,
    row.updatedAt,
    null,
    null,
    null,
    CSV_ARRAY_NULL,
    row.embeddingNomic,
    row.embeddingNomicCardHash,
    row.embeddingNomicUpdatedAt,
    CSV_ARRAY_NULL,
    row.embeddingJinaCode,
    row.embeddingJinaCodeCardHash,
    row.embeddingJinaCodeUpdatedAt,
    CSV_ARRAY_NULL,
  ];
}

async function writeCsvArtifact<T>(params: {
  stagingDir: string;
  fileName: string;
  columns: string[];
  targetTable: string;
  kind: "node" | "relationship";
  rows: readonly T[];
  mapRow: (row: T) => unknown[];
}): Promise<ProviderFirstShadowFinalizationBulkArtifact> {
  const filePath = join(params.stagingDir, params.fileName);
  const stream = createWriteStream(filePath, { encoding: "utf8" });
  try {
    await writeCsvLine(stream, params.columns);
    for (const row of params.rows) {
      await writeCsvLine(stream, params.mapRow(row));
    }
    stream.end();
    await finished(stream);
  } catch (err) {
    stream.destroy();
    throw err;
  }
  return {
    path: normalizePath(filePath),
    columns: params.columns,
    rows: params.rows.length,
    targetTable: params.targetTable,
    kind: params.kind,
  };
}

async function copyArtifact(
  conn: Connection,
  tableName: string,
  artifact: ProviderFirstShadowFinalizationBulkArtifact,
): Promise<void> {
  if (artifact.targetTable !== tableName) {
    throw new Error(
      `Provider-first shadow finalization artifact target mismatch: expected ${tableName}, got ${artifact.targetTable}`,
    );
  }
  await execDdl(
    conn,
    `COPY ${tableName} FROM '${escapeCopyPath(artifact.path)}' ` +
      `(HEADER=true, PARALLEL=FALSE, QUOTE='"', NULL_STRINGS=['${escapeCopyOptionString(CSV_NULL_SENTINEL)}'])`,
  );
}

async function writeCsvLine(
  stream: NodeJS.WritableStream,
  cells: readonly unknown[],
): Promise<void> {
  const line = `${cells.map(csvCell).join(",")}\n`;
  if (!stream.write(line)) {
    await waitForDrain(stream);
  }
}

function waitForDrain(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      stream.removeListener("drain", onDrain);
      stream.removeListener("error", onError);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

function csvCell(value: unknown): string {
  if (value === CSV_ARRAY_NULL) return "";
  if (value === null || value === undefined) return CSV_NULL_SENTINEL;
  const text = String(value);
  if (text === "") return '""';
  const escaped = text.replaceAll('"', '""');
  return /[",\r\n]/.test(escaped) ? `"${escaped}"` : escaped;
}

function escapeCopyPath(path: string): string {
  return normalizePath(path).replace(/'/g, "''");
}

function escapeCopyOptionString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "''");
}

async function readMetricsForRepo(
  conn: Connection,
  repoId: string,
  excludedSymbolIds: ReadonlySet<string>,
): Promise<ladybugDb.MetricsRow[]> {
  const excluded = [...excludedSymbolIds];
  const exclusionClause =
    excluded.length > 0 ? "AND NOT s.symbolId IN $excludedSymbolIds" : "";
  const rows = await ladybugDb.queryAll<{
    symbolId: string;
    fanIn: unknown;
    fanOut: unknown;
    churn30d: unknown;
    testRefsJson: string | null;
    canonicalTestJson: string | null;
    pageRank: unknown;
    kCore: unknown;
    updatedAt: string;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
     WHERE coalesce(s.symbolStatus, 'real') = 'real'
       AND coalesce(s.external, false) = false
       ${exclusionClause}
     MATCH (m:Metrics {symbolId: s.symbolId})
     RETURN m.symbolId AS symbolId,
            m.fanIn AS fanIn,
            m.fanOut AS fanOut,
            m.churn30d AS churn30d,
            m.testRefsJson AS testRefsJson,
            m.canonicalTestJson AS canonicalTestJson,
            m.pageRank AS pageRank,
            m.kCore AS kCore,
            m.updatedAt AS updatedAt
     ORDER BY m.symbolId`,
    { repoId, excludedSymbolIds: excluded },
  );
  return rows.map((row) => ({
    symbolId: row.symbolId,
    fanIn: ladybugDb.toNumber(row.fanIn),
    fanOut: ladybugDb.toNumber(row.fanOut),
    churn30d: ladybugDb.toNumber(row.churn30d),
    testRefsJson: row.testRefsJson,
    canonicalTestJson: row.canonicalTestJson,
    pageRank: ladybugDb.toNumber(row.pageRank ?? 0),
    kCore: ladybugDb.toNumber(row.kCore ?? 0),
    updatedAt: row.updatedAt,
  }));
}

async function readDerivedStateRow(
  conn: Connection,
  repoId: string,
): Promise<DerivedStateRow | null> {
  const row = await ladybugDb.querySingle<{
    repoId: string;
    clustersDirty: unknown;
    processesDirty: unknown;
    algorithmsDirty: unknown;
    summariesDirty: unknown;
    embeddingsDirty: unknown;
    targetVersionId: string | null;
    computedVersionId: string | null;
    updatedAt: string | null;
    lastError: string | null;
  }>(
    conn,
    `MATCH (d:DerivedState {repoId: $repoId})
     RETURN d.repoId AS repoId,
            d.clustersDirty AS clustersDirty,
            d.processesDirty AS processesDirty,
            d.algorithmsDirty AS algorithmsDirty,
            d.summariesDirty AS summariesDirty,
            d.embeddingsDirty AS embeddingsDirty,
            d.targetVersionId AS targetVersionId,
            d.computedVersionId AS computedVersionId,
            d.updatedAt AS updatedAt,
            d.lastError AS lastError`,
    { repoId },
  );
  if (!row) return null;
  return {
    repoId: row.repoId,
    clustersDirty: ladybugDb.toBoolean(row.clustersDirty),
    processesDirty: ladybugDb.toBoolean(row.processesDirty),
    algorithmsDirty: ladybugDb.toBoolean(row.algorithmsDirty),
    summariesDirty: ladybugDb.toBoolean(row.summariesDirty),
    embeddingsDirty: ladybugDb.toBoolean(row.embeddingsDirty),
    targetVersionId: row.targetVersionId,
    computedVersionId: row.computedVersionId,
    updatedAt: row.updatedAt,
    lastError: row.lastError,
  };
}

async function readRealSymbolVersionsForRepoAtVersion(
  conn: Connection,
  repoId: string,
  versionId: string,
  excludedSymbolIds: ReadonlySet<string>,
): Promise<ladybugDb.SymbolVersionRow[]> {
  const excluded = [...excludedSymbolIds];
  const exclusionClause =
    excluded.length > 0 ? "AND NOT s.symbolId IN $excludedSymbolIds" : "";
  return await ladybugDb.queryAll<ladybugDb.SymbolVersionRow>(
    conn,
    `MATCH (sv:SymbolVersion {versionId: $versionId})
     MATCH (s:Symbol {symbolId: sv.symbolId})-[:SYMBOL_IN_REPO]->(:Repo {repoId: $repoId})
     WHERE coalesce(s.symbolStatus, 'real') = 'real'
       AND coalesce(s.external, false) = false
       ${exclusionClause}
     RETURN sv.id AS id,
            sv.versionId AS versionId,
            sv.symbolId AS symbolId,
            sv.astFingerprint AS astFingerprint,
            sv.signatureJson AS signatureJson,
            sv.summary AS summary,
            sv.invariantsJson AS invariantsJson,
            sv.sideEffectsJson AS sideEffectsJson`,
    { repoId, versionId, excludedSymbolIds: excluded },
  );
}

async function readFinalizationCounts(
  conn: Connection,
  repoId: string,
  versionId: string,
  excludedSymbolIds: ReadonlySet<string> = new Set(),
): Promise<ProviderFirstShadowFinalizationCounts> {
  const excluded = [...excludedSymbolIds];
  const exclusionClause =
    excluded.length > 0 ? "AND NOT s.symbolId IN $excludedSymbolIds" : "";
  const edgeExclusionClause =
    excluded.length > 0
      ? "AND NOT s.symbolId IN $excludedSymbolIds AND NOT target.symbolId IN $excludedSymbolIds"
      : "";
  return {
    files: await count(
      conn,
      `MATCH (:Repo {repoId: $repoId})<-[:FILE_IN_REPO]-(f:File)
       RETURN count(f) AS count`,
      { repoId },
    ),
    symbols: await count(
      conn,
      `MATCH (:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
       WHERE coalesce(s.symbolStatus, 'real') = 'real'
         AND coalesce(s.external, false) = false
         ${exclusionClause}
       RETURN count(s) AS count`,
      { repoId, excludedSymbolIds: excluded },
    ),
    auxiliarySymbols: await count(
      conn,
      `MATCH (:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
       WHERE coalesce(s.symbolStatus, 'real') <> 'real'
          OR coalesce(s.external, false) = true
       RETURN count(s) AS count`,
      { repoId },
    ),
    edges: await count(
      conn,
      `MATCH (:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)-[d:DEPENDS_ON]->(target:Symbol)
       WHERE true
         ${edgeExclusionClause}
       RETURN count(d) AS count`,
      { repoId, excludedSymbolIds: excluded },
    ),
    versions: await count(
      conn,
      `MATCH (v:Version {versionId: $versionId})-[:VERSION_OF_REPO]->(:Repo {repoId: $repoId})
       RETURN count(v) AS count`,
      { repoId, versionId },
    ),
    symbolVersions: await count(
      conn,
      `MATCH (sv:SymbolVersion {versionId: $versionId})
       MATCH (s:Symbol {symbolId: sv.symbolId})-[:SYMBOL_IN_REPO]->(:Repo {repoId: $repoId})
       WHERE coalesce(s.symbolStatus, 'real') = 'real'
         AND coalesce(s.external, false) = false
         ${exclusionClause}
       RETURN count(sv) AS count`,
      { repoId, versionId, excludedSymbolIds: excluded },
    ),
    metrics: await count(
      conn,
      `MATCH (:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
       WHERE coalesce(s.symbolStatus, 'real') = 'real'
         AND coalesce(s.external, false) = false
         ${exclusionClause}
       MATCH (m:Metrics {symbolId: s.symbolId})
       RETURN count(m) AS count`,
      { repoId, excludedSymbolIds: excluded },
    ),
    fileSummaries: await count(
      conn,
      `MATCH (:Repo {repoId: $repoId})<-[:FILE_SUMMARY_IN_REPO]-(fs:FileSummary)
       RETURN count(fs) AS count`,
      { repoId },
    ),
    clusters: await count(
      conn,
      `MATCH (:Repo {repoId: $repoId})<-[:CLUSTER_IN_REPO]-(c:Cluster)
       RETURN count(c) AS count`,
      { repoId },
    ),
    clusterMembers: await count(
      conn,
      `MATCH (:Repo {repoId: $repoId})<-[:CLUSTER_IN_REPO]-(c:Cluster)<-[m:BELONGS_TO_CLUSTER]-(:Symbol)
       RETURN count(m) AS count`,
      { repoId },
    ),
    processes: await count(
      conn,
      `MATCH (:Repo {repoId: $repoId})<-[:PROCESS_IN_REPO]-(p:Process)
       RETURN count(p) AS count`,
      { repoId },
    ),
    processSteps: await count(
      conn,
      `MATCH (:Repo {repoId: $repoId})<-[:PROCESS_IN_REPO]-(p:Process)<-[step:PARTICIPATES_IN]-(:Symbol)
       RETURN count(step) AS count`,
      { repoId },
    ),
    shadowClusters: await count(
      conn,
      `MATCH (c:ShadowCluster {repoId: $repoId})
       RETURN count(c) AS count`,
      { repoId },
    ),
    shadowClusterMembers: await count(
      conn,
      `MATCH (c:ShadowCluster {repoId: $repoId})<-[m:BELONGS_TO_SHADOW_CLUSTER]-(:Symbol)
       RETURN count(m) AS count`,
      { repoId },
    ),
    derivedStates: await count(
      conn,
      `MATCH (d:DerivedState {repoId: $repoId})
       RETURN count(d) AS count`,
      { repoId },
    ),
  };
}

async function count(
  conn: Connection,
  statement: string,
  params: Record<string, unknown>,
): Promise<number> {
  const row = await querySingle<{ count: unknown }>(conn, statement, params);
  return ladybugDb.toNumber(row?.count ?? 0);
}

function finalizationCountMismatches(
  expected: ProviderFirstShadowFinalizationCounts,
  actual: ProviderFirstShadowFinalizationCounts,
): string[] {
  const mismatches: string[] = [];
  for (const key of Object.keys(expected) as Array<
    keyof ProviderFirstShadowFinalizationCounts
  >) {
    if (expected[key] !== actual[key]) {
      mismatches.push(
        `shadow finalized ${key} count mismatch: expected ${expected[key]}, got ${actual[key]}`,
      );
    }
  }
  return mismatches;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
