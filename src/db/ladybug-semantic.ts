import type { Connection } from "kuzu";
import type {
  PersistedSemanticProviderRun,
  SemanticDiagnostic,
  SemanticPrecisionMetric,
  SemanticProviderRun,
} from "../semantic/types.js";
import {
  exec,
  queryAll,
  toBoolean,
  toNumber,
  withTransaction,
} from "./ladybug-core.js";
import { normalizePath } from "../util/paths.js";

export interface SemanticEdgeWriteRow {
  sourceSymbolId: string;
  targetSymbolId: string;
  edgeType: string;
  confidence: number;
  resolution: string;
  resolverId: string;
  resolutionPhase: string;
  provenance: string;
}

interface SemanticProviderRunStorageFields {
  cacheKey?: string;
  configHash?: string;
  ledgerVersion?: string;
  cacheHit?: boolean;
  canAffectPass2?: boolean;
  selected?: boolean;
  metadataJson?: string;
}

export interface SemanticProviderRunRecord
  extends SemanticProviderRun,
    SemanticProviderRunStorageFields {}

export interface PersistedSemanticProviderRunRecord
  extends PersistedSemanticProviderRun,
    SemanticProviderRunStorageFields {}

export interface SemanticPrecisionMetricRecord extends SemanticPrecisionMetric {
  metadataJson?: string;
}

export interface SemanticExistingEdge {
  sourceSymbolId: string;
  targetSymbolId: string;
  edgeType: string;
  confidence: number;
  resolution: string;
  resolverId?: string;
}

export interface SemanticLspCallEdgeCandidateRow {
  sourceSymbolId: string;
  sourceName: string;
  sourceKind: string;
  sourcePath: string;
  sourceFileId: string;
  sourceLanguage: string;
  sourceRangeStartLine: number;
  sourceRangeStartCol: number;
  sourceRangeEndLine: number;
  sourceRangeEndCol: number;
  targetSymbolId: string;
  targetName: string | null;
  edgeResolution: string;
  edgeConfidence: number;
  edgeResolverId?: string;
  edgeProvenance?: string;
  fileContentHash?: string;
}

const EDGE_BATCH_SIZE = 256;

export async function mergeSemanticProviderRun(
  conn: Connection,
  run: SemanticProviderRunRecord,
): Promise<void> {
  await exec(
    conn,
    `MERGE (r:SemanticProviderRun {runId: $runId})
     ON CREATE SET
       r.repoId = $repoId,
       r.providerType = $providerType,
       r.providerId = $providerId,
       r.providerVersion = $providerVersion,
        r.languagesJson = $languagesJson,
        r.sourceIndexPath = $sourceIndexPath,
        r.sourceHash = $sourceHash,
        r.cacheKey = $cacheKey,
        r.configHash = $configHash,
        r.ledgerVersion = $ledgerVersion,
        r.status = $status,
        r.startedAt = $startedAt,
        r.finishedAt = $finishedAt,
       r.documentsProcessed = $documentsProcessed,
       r.symbolsMatched = $symbolsMatched,
       r.edgesCreated = $edgesCreated,
       r.edgesUpgraded = $edgesUpgraded,
       r.edgesReplaced = $edgesReplaced,
       r.edgesSkipped = $edgesSkipped,
        r.diagnosticsCount = $diagnosticsCount,
        r.precisionScore = $precisionScore,
        r.cacheHit = $cacheHit,
        r.canAffectPass2 = $canAffectPass2,
        r.selected = $selected,
        r.metadataJson = $metadataJson,
        r.error = $error
      ON MATCH SET
       r.repoId = $repoId,
       r.providerType = $providerType,
       r.providerId = $providerId,
       r.providerVersion = $providerVersion,
        r.languagesJson = $languagesJson,
        r.sourceIndexPath = $sourceIndexPath,
        r.sourceHash = $sourceHash,
        r.cacheKey = $cacheKey,
        r.configHash = $configHash,
        r.ledgerVersion = $ledgerVersion,
        r.status = $status,
        r.startedAt = $startedAt,
        r.finishedAt = $finishedAt,
       r.documentsProcessed = $documentsProcessed,
       r.symbolsMatched = $symbolsMatched,
       r.edgesCreated = $edgesCreated,
       r.edgesUpgraded = $edgesUpgraded,
       r.edgesReplaced = $edgesReplaced,
       r.edgesSkipped = $edgesSkipped,
        r.diagnosticsCount = $diagnosticsCount,
        r.precisionScore = $precisionScore,
        r.cacheHit = $cacheHit,
        r.canAffectPass2 = $canAffectPass2,
        r.selected = $selected,
        r.metadataJson = $metadataJson,
        r.error = $error`,
    {
      runId: run.runId,
      repoId: run.repoId,
      providerType: run.providerType,
      providerId: run.providerId,
      providerVersion: run.providerVersion ?? null,
      languagesJson: JSON.stringify(run.languages),
      sourceIndexPath: run.sourceIndexPath ?? null,
      sourceHash: run.sourceHash ?? null,
      cacheKey: run.cacheKey ?? null,
      configHash: run.configHash ?? null,
      ledgerVersion: run.ledgerVersion ?? null,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt ?? null,
      documentsProcessed: run.documentsProcessed,
      symbolsMatched: run.symbolsMatched,
      edgesCreated: run.edgesCreated,
      edgesUpgraded: run.edgesUpgraded,
      edgesReplaced: run.edgesReplaced,
      edgesSkipped: run.edgesSkipped,
      diagnosticsCount: run.diagnosticsCount,
      precisionScore: run.precisionScore ?? 0,
      cacheHit: run.cacheHit ?? false,
      canAffectPass2: run.canAffectPass2 ?? false,
      selected: run.selected ?? true,
      metadataJson: run.metadataJson ?? "{}",
      error: run.error ?? null,
    },
  );
}

export async function getLatestSemanticProviderRuns(
  conn: Connection,
  repoId: string,
): Promise<PersistedSemanticProviderRunRecord[]> {
  const rows = await queryAll<{
    runId: string;
    repoId: string;
    providerType: string;
    providerId: string;
    providerVersion: string | null;
    languagesJson: string | null;
    sourceIndexPath: string | null;
    sourceHash: string | null;
    cacheKey: string | null;
    configHash: string | null;
    ledgerVersion: string | null;
    status: PersistedSemanticProviderRun["status"];
    startedAt: string;
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
            r.documentsProcessed AS documentsProcessed,
            r.symbolsMatched AS symbolsMatched,
            r.edgesCreated AS edgesCreated,
            r.edgesUpgraded AS edgesUpgraded,
            r.edgesReplaced AS edgesReplaced,
            r.edgesSkipped AS edgesSkipped,
             r.diagnosticsCount AS diagnosticsCount,
             r.precisionScore AS precisionScore,
             r.cacheHit AS cacheHit,
             r.canAffectPass2 AS canAffectPass2,
             r.selected AS selected,
             r.metadataJson AS metadataJson,
             r.error AS error
     ORDER BY r.startedAt DESC`,
    { repoId },
  );

  return rows.map((row) => ({
    runId: row.runId,
    repoId: row.repoId,
    providerType: row.providerType as PersistedSemanticProviderRun["providerType"],
    providerId: row.providerId,
    providerVersion: row.providerVersion ?? undefined,
    languages: parseLanguages(row.languagesJson),
    sourceIndexPath: row.sourceIndexPath ?? undefined,
    sourceHash: row.sourceHash ?? undefined,
    cacheKey: row.cacheKey ?? undefined,
    configHash: row.configHash ?? undefined,
    ledgerVersion: row.ledgerVersion ?? undefined,
    status: row.status,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt ?? undefined,
    documentsProcessed: toNumber(row.documentsProcessed),
    symbolsMatched: toNumber(row.symbolsMatched),
    edgesCreated: toNumber(row.edgesCreated),
    edgesUpgraded: toNumber(row.edgesUpgraded),
    edgesReplaced: toNumber(row.edgesReplaced),
    edgesSkipped: toNumber(row.edgesSkipped),
    diagnosticsCount: toNumber(row.diagnosticsCount),
    precisionScore: toNumber(row.precisionScore),
    cacheHit: toBoolean(row.cacheHit),
    canAffectPass2: toBoolean(row.canAffectPass2),
    selected:
      row.selected === null || row.selected === undefined
        ? true
        : toBoolean(row.selected),
    metadataJson: row.metadataJson ?? "{}",
    error: row.error ?? undefined,
  }));
}

function parseLanguages(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export async function getSemanticLspCallEdgeCandidates(
  conn: Connection,
  repoId: string,
  languageId: string,
  limit?: number,
): Promise<SemanticLspCallEdgeCandidateRow[]> {
  const maxRows =
    limit === undefined ? 10_000 : Math.max(0, Math.min(limit, 10_000));
  const rows = await queryAll<{
    sourceSymbolId: string;
    sourceName: string;
    sourceKind: string;
    sourcePath: string;
    sourceFileId: string;
    sourceLanguage: string;
    sourceRangeStartLine: unknown;
    sourceRangeStartCol: unknown;
    sourceRangeEndLine: unknown;
    sourceRangeEndCol: unknown;
    targetSymbolId: string;
    targetName: string | null;
    edgeResolution: string;
    edgeConfidence: unknown;
    edgeResolverId: string | null;
    edgeProvenance: string | null;
    fileContentHash: string | null;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(source:Symbol)-[d:DEPENDS_ON]->(target:Symbol)
     MATCH (source)-[:SYMBOL_IN_FILE]->(file:File)
     WHERE d.edgeType = 'call'
       AND source.language = $languageId
       AND d.resolution IN ['heuristic', 'unresolved']
     RETURN source.symbolId AS sourceSymbolId,
            source.name AS sourceName,
            source.kind AS sourceKind,
            file.relPath AS sourcePath,
            file.fileId AS sourceFileId,
            source.language AS sourceLanguage,
            source.rangeStartLine AS sourceRangeStartLine,
            source.rangeStartCol AS sourceRangeStartCol,
            source.rangeEndLine AS sourceRangeEndLine,
            source.rangeEndCol AS sourceRangeEndCol,
            target.symbolId AS targetSymbolId,
            target.name AS targetName,
            d.resolution AS edgeResolution,
            d.confidence AS edgeConfidence,
            d.resolverId AS edgeResolverId,
            d.provenance AS edgeProvenance,
            file.contentHash AS fileContentHash
     ORDER BY file.relPath,
              source.rangeStartLine,
              source.rangeStartCol,
              source.symbolId,
              target.symbolId
     LIMIT $limit`,
    { repoId, languageId, limit: maxRows },
  );

  return rows.map((row) => ({
    sourceSymbolId: row.sourceSymbolId,
    sourceName: row.sourceName,
    sourceKind: row.sourceKind,
    sourcePath: row.sourcePath,
    sourceFileId: row.sourceFileId,
    sourceLanguage: row.sourceLanguage,
    sourceRangeStartLine: toNumber(row.sourceRangeStartLine),
    sourceRangeStartCol: toNumber(row.sourceRangeStartCol),
    sourceRangeEndLine: toNumber(row.sourceRangeEndLine),
    sourceRangeEndCol: toNumber(row.sourceRangeEndCol),
    targetSymbolId: row.targetSymbolId,
    targetName: row.targetName,
    edgeResolution: row.edgeResolution,
    edgeConfidence: toNumber(row.edgeConfidence),
    edgeResolverId: row.edgeResolverId ?? undefined,
    edgeProvenance: row.edgeProvenance ?? undefined,
    fileContentHash: row.fileContentHash ?? undefined,
  }));
}

export async function mergeSemanticDiagnostics(
  conn: Connection,
  diagnostics: readonly SemanticDiagnostic[],
): Promise<void> {
  if (diagnostics.length === 0) return;
  const now = new Date().toISOString();
  const rows = diagnostics.map((diagnostic) => ({
    id: diagnostic.id,
    repoId: diagnostic.repoId,
    runId: diagnostic.runId,
    providerType: diagnostic.providerType,
    providerId: diagnostic.providerId,
    languageId: diagnostic.languageId,
    sourcePath: normalizePath(diagnostic.sourcePath),
    severity: diagnostic.severity,
    message: diagnostic.message,
    code: diagnostic.code ?? null,
    rangeJson: diagnostic.range ? JSON.stringify(diagnostic.range) : null,
    createdAt: now,
  }));

  await exec(
    conn,
    `UNWIND $rows AS row
     MERGE (d:SemanticDiagnostic {id: row.id})
     ON CREATE SET
       d.repoId = row.repoId,
       d.runId = row.runId,
       d.providerType = row.providerType,
       d.providerId = row.providerId,
       d.languageId = row.languageId,
       d.sourcePath = row.sourcePath,
       d.severity = row.severity,
       d.message = row.message,
       d.code = row.code,
       d.rangeJson = row.rangeJson,
       d.createdAt = row.createdAt
     ON MATCH SET
       d.repoId = row.repoId,
       d.runId = row.runId,
       d.providerType = row.providerType,
       d.providerId = row.providerId,
       d.languageId = row.languageId,
       d.sourcePath = row.sourcePath,
       d.severity = row.severity,
       d.message = row.message,
       d.code = row.code,
       d.rangeJson = row.rangeJson`,
    { rows },
  );
}

export async function mergeSemanticPrecisionMetric(
  conn: Connection,
  metric: SemanticPrecisionMetricRecord,
): Promise<void> {
  await exec(
    conn,
    `MERGE (m:SemanticPrecisionMetric {id: $id})
     ON CREATE SET
       m.repoId = $repoId,
       m.runId = $runId,
       m.languageId = $languageId,
       m.providerType = $providerType,
       m.providerId = $providerId,
       m.score = $score,
       m.filesCovered = $filesCovered,
       m.filesEligible = $filesEligible,
       m.symbolMatchRate = $symbolMatchRate,
       m.resolvedEdgeRate = $resolvedEdgeRate,
        m.diagnosticsAvailable = $diagnosticsAvailable,
        m.pass2SkipRate = $pass2SkipRate,
        m.computedAt = $computedAt,
        m.metadataJson = $metadataJson
      ON MATCH SET
       m.repoId = $repoId,
       m.runId = $runId,
       m.languageId = $languageId,
       m.providerType = $providerType,
       m.providerId = $providerId,
       m.score = $score,
       m.filesCovered = $filesCovered,
       m.filesEligible = $filesEligible,
       m.symbolMatchRate = $symbolMatchRate,
       m.resolvedEdgeRate = $resolvedEdgeRate,
        m.diagnosticsAvailable = $diagnosticsAvailable,
        m.pass2SkipRate = $pass2SkipRate,
        m.computedAt = $computedAt,
        m.metadataJson = $metadataJson`,
    { ...metric, metadataJson: metric.metadataJson ?? "{}" },
  );
}

export async function batchGetSemanticEdges(
  conn: Connection,
  pairs: ReadonlyArray<{
    sourceId: string;
    targetId: string;
    edgeType: string;
  }>,
): Promise<Map<string, SemanticExistingEdge>> {
  if (pairs.length === 0) return new Map();
  const sourceIds = [...new Set(pairs.map((pair) => pair.sourceId))];
  const targetIds = [...new Set(pairs.map((pair) => pair.targetId))];
  const edgeTypes = [...new Set(pairs.map((pair) => pair.edgeType))];
  const allowedPairs = new Set(
    pairs.map((pair) => edgeKey(pair.sourceId, pair.targetId, pair.edgeType)),
  );
  const rows = await queryAll<{
    sourceSymbolId: string;
    targetSymbolId: string;
    edgeType: string;
    confidence: unknown;
    resolution: string;
    resolverId: string | null;
  }>(
    conn,
    `MATCH (source:Symbol)-[d:DEPENDS_ON]->(target:Symbol)
     WHERE source.symbolId IN $sourceIds AND d.edgeType IN $edgeTypes
       AND target.symbolId IN $targetIds
     RETURN source.symbolId AS sourceSymbolId,
            target.symbolId AS targetSymbolId,
            d.edgeType AS edgeType,
            d.confidence AS confidence,
            d.resolution AS resolution,
            d.resolverId AS resolverId`,
    { sourceIds, targetIds, edgeTypes },
  );

  const result = new Map<string, SemanticExistingEdge>();
  for (const row of rows) {
    const key = edgeKey(row.sourceSymbolId, row.targetSymbolId, row.edgeType);
    if (!allowedPairs.has(key)) continue;
    if (result.has(key)) continue;
    result.set(key, {
      sourceSymbolId: row.sourceSymbolId,
      targetSymbolId: row.targetSymbolId,
      edgeType: row.edgeType,
      confidence: toNumber(row.confidence),
      resolution: row.resolution,
      resolverId: row.resolverId ?? undefined,
    });
  }
  return result;
}

export async function batchGetSemanticEdgesBySourceAndType(
  conn: Connection,
  pairs: ReadonlyArray<{ sourceId: string; edgeType: string }>,
): Promise<Map<string, SemanticExistingEdge[]>> {
  if (pairs.length === 0) return new Map();
  const sourceIds = [...new Set(pairs.map((pair) => pair.sourceId))];
  const edgeTypes = [...new Set(pairs.map((pair) => pair.edgeType))];

  const rows = await queryAll<{
    sourceSymbolId: string;
    targetSymbolId: string;
    edgeType: string;
    confidence: unknown;
    resolution: string;
    resolverId: string | null;
  }>(
    conn,
    `MATCH (source:Symbol)-[d:DEPENDS_ON]->(target:Symbol)
     WHERE source.symbolId IN $sourceIds AND d.edgeType IN $edgeTypes
     RETURN source.symbolId AS sourceSymbolId,
            target.symbolId AS targetSymbolId,
            d.edgeType AS edgeType,
            d.confidence AS confidence,
            d.resolution AS resolution,
            d.resolverId AS resolverId`,
    { sourceIds, edgeTypes },
  );

  const result = new Map<string, SemanticExistingEdge[]>();
  for (const row of rows) {
    const key = sourceTypeKey(row.sourceSymbolId, row.edgeType);
    const bucket = result.get(key) ?? [];
    bucket.push({
      sourceSymbolId: row.sourceSymbolId,
      targetSymbolId: row.targetSymbolId,
      edgeType: row.edgeType,
      confidence: toNumber(row.confidence),
      resolution: row.resolution,
      resolverId: row.resolverId ?? undefined,
    });
    result.set(key, bucket);
  }
  return result;
}

export async function batchMergeSemanticEdges(
  conn: Connection,
  edges: readonly SemanticEdgeWriteRow[],
): Promise<void> {
  if (edges.length === 0) return;
  const rows = dedupeEdges(edges);
  const now = new Date().toISOString();

  await withTransaction(conn, async (txConn) => {
    for (let i = 0; i < rows.length; i += EDGE_BATCH_SIZE) {
      const batch = rows.slice(i, i + EDGE_BATCH_SIZE).map((edge) => ({
        ...edge,
        resolutionRank: resolutionRank(edge.resolution),
        createdAt: now,
      }));
      await exec(
        txConn,
        `UNWIND $rows AS row
         MATCH (source:Symbol {symbolId: row.sourceSymbolId})
         MATCH (target:Symbol {symbolId: row.targetSymbolId})
         OPTIONAL MATCH (source)-[existing:DEPENDS_ON {edgeType: row.edgeType}]->(target)
         WITH source, target, row, existing
         WHERE existing IS NULL
         CREATE (source)-[:DEPENDS_ON {
           edgeType: row.edgeType,
           confidence: row.confidence,
           resolution: row.resolution,
           resolverId: row.resolverId,
           resolutionPhase: row.resolutionPhase,
           provenance: row.provenance,
           createdAt: row.createdAt
         }]->(target)`,
        { rows: batch },
      );
      await exec(
        txConn,
        `UNWIND $rows AS row
         MATCH (source:Symbol {symbolId: row.sourceSymbolId})
         MATCH (target:Symbol {symbolId: row.targetSymbolId})
         MATCH (source)-[d:DEPENDS_ON {edgeType: row.edgeType}]->(target)
         WHERE d.confidence < row.confidence OR
               (d.confidence = row.confidence AND
                CASE d.resolution
                  WHEN 'exact' THEN 3
                  WHEN 'heuristic' THEN 2
                  WHEN 'unresolved' THEN 1
                  ELSE 0
                END < row.resolutionRank)
         SET d.confidence = row.confidence,
             d.resolution = row.resolution,
             d.resolverId = row.resolverId,
             d.resolutionPhase = row.resolutionPhase,
             d.provenance = row.provenance`,
        { rows: batch },
      );
    }
  });
}

export async function batchReplaceSemanticEdgeTargets(
  conn: Connection,
  ops: readonly (SemanticEdgeWriteRow & { oldTargetId: string })[],
): Promise<void> {
  if (ops.length === 0) return;
  const now = new Date().toISOString();
  const rows = ops.map((op) => ({ ...op, createdAt: now }));

  await withTransaction(conn, async (txConn) => {
    await exec(
      txConn,
      `UNWIND $rows AS row
       MATCH (source:Symbol {symbolId: row.sourceSymbolId})-[d:DEPENDS_ON {edgeType: row.edgeType}]->(oldTarget:Symbol {symbolId: row.oldTargetId})
       DELETE d`,
      { rows },
    );
    await exec(
      txConn,
      `UNWIND $rows AS row
       MATCH (source:Symbol {symbolId: row.sourceSymbolId})
       MATCH (target:Symbol {symbolId: row.targetSymbolId})
       OPTIONAL MATCH (source)-[existing:DEPENDS_ON {edgeType: row.edgeType}]->(target)
       WITH source, target, row, existing
       WHERE existing IS NULL
       CREATE (source)-[:DEPENDS_ON {
         edgeType: row.edgeType,
         confidence: row.confidence,
         resolution: row.resolution,
         resolverId: row.resolverId,
         resolutionPhase: row.resolutionPhase,
         provenance: row.provenance,
         createdAt: row.createdAt
       }]->(target)`,
      { rows },
    );
  });
}

function dedupeEdges(
  edges: readonly SemanticEdgeWriteRow[],
): SemanticEdgeWriteRow[] {
  const seen = new Set<string>();
  const result: SemanticEdgeWriteRow[] = [];
  for (const edge of edges) {
    const key = `${edge.sourceSymbolId}\0${edge.targetSymbolId}\0${edge.edgeType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(edge);
  }
  return result;
}

function edgeKey(sourceId: string, targetId: string, edgeType: string): string {
  return `${sourceId}\0${targetId}\0${edgeType}`;
}

function sourceTypeKey(sourceId: string, edgeType: string): string {
  return `${sourceId}\0${edgeType}`;
}

function resolutionRank(resolution: string): number {
  switch (resolution) {
    case "exact":
      return 3;
    case "heuristic":
      return 2;
    case "unresolved":
      return 1;
    default:
      return 0;
  }
}
