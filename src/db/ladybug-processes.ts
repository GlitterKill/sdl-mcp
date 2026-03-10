/**
 * ladybug-processes.ts - Process Operations
 * Extracted from ladybug-queries.ts as part of the god-object split.
 */
import type { Connection } from "kuzu";
import { exec, queryAll, querySingle, toNumber } from "./ladybug-core.js";

export interface ProcessRow {
  processId: string;
  repoId: string;
  entrySymbolId: string;
  label: string;
  depth: number;
  versionId: string | null;
  createdAt: string;
}

export interface ProcessStepRow {
  symbolId: string;
  stepOrder: number;
  role: string | null;
}

export interface ProcessForSymbolRow {
  processId: string;
  entrySymbolId: string;
  label: string;
  depth: number;
  stepOrder: number;
  role: string | null;
}

export async function upsertProcess(
  conn: Connection,
  row: ProcessRow,
): Promise<void> {
  await exec(
    conn,
    `MATCH (r:Repo {repoId: $repoId})
     MERGE (p:Process {processId: $processId})
     SET p.repoId = $repoId,
         p.entrySymbolId = $entrySymbolId,
         p.label = $label,
         p.depth = $depth,
         p.versionId = $versionId,
         p.createdAt = $createdAt
     MERGE (p)-[:PROCESS_IN_REPO]->(r)`,
    {
      processId: row.processId,
      repoId: row.repoId,
      entrySymbolId: row.entrySymbolId,
      label: row.label,
      depth: row.depth,
      versionId: row.versionId,
      createdAt: row.createdAt,
    },
  );
}

export async function upsertProcessStep(
  conn: Connection,
  row: { processId: string; symbolId: string; stepOrder: number; role: string },
): Promise<void> {
  await exec(
    conn,
    `MATCH (s:Symbol {symbolId: $symbolId})
     MATCH (p:Process {processId: $processId})
     MERGE (s)-[r:PARTICIPATES_IN]->(p)
     SET r.stepOrder = $stepOrder,
         r.role = $role`,
    {
      processId: row.processId,
      symbolId: row.symbolId,
      stepOrder: row.stepOrder,
      role: row.role,
    },
  );
}

export async function upsertProcessStepsBatch(
  conn: Connection,
  steps: Array<{
    processId: string;
    symbolId: string;
    stepOrder: number;
    role: string;
  }>,
): Promise<void> {
  if (steps.length === 0) return;
  for (const step of steps) {
    await exec(
      conn,
      `MATCH (s:Symbol {symbolId: $symbolId})
       MATCH (p:Process {processId: $processId})
       MERGE (s)-[r:PARTICIPATES_IN]->(p)
       SET r.stepOrder = $stepOrder,
           r.role = $role`,
      {
        processId: step.processId,
        symbolId: step.symbolId,
        stepOrder: step.stepOrder,
        role: step.role,
      },
    );
  }
}

export async function getProcessesForSymbol(
  conn: Connection,
  symbolId: string,
): Promise<ProcessForSymbolRow[]> {
  const rows = await queryAll<{
    processId: string;
    entrySymbolId: string;
    label: string;
    depth: unknown;
    stepOrder: unknown;
    role: string | null;
  }>(
    conn,
    `MATCH (s:Symbol {symbolId: $symbolId})-[r:PARTICIPATES_IN]->(p:Process)
     RETURN p.processId AS processId,
            p.entrySymbolId AS entrySymbolId,
            p.label AS label,
            p.depth AS depth,
            r.stepOrder AS stepOrder,
            r.role AS role
     ORDER BY r.stepOrder ASC, processId ASC`,
    { symbolId },
  );

  return rows.map((row) => ({
    processId: row.processId,
    entrySymbolId: row.entrySymbolId,
    label: row.label,
    depth: toNumber(row.depth),
    stepOrder: toNumber(row.stepOrder),
    role: row.role,
  }));
}

export async function getProcessesForSymbols(
  conn: Connection,
  symbolIds: string[],
): Promise<Map<string, ProcessForSymbolRow[]>> {
  if (symbolIds.length === 0) return new Map();

  const rows = await queryAll<{
    symbolId: string;
    processId: string;
    entrySymbolId: string;
    label: string;
    depth: unknown;
    stepOrder: unknown;
    role: string | null;
  }>(
    conn,
    `MATCH (s:Symbol)-[r:PARTICIPATES_IN]->(p:Process)
     WHERE s.symbolId IN $symbolIds
     RETURN s.symbolId AS symbolId,
            p.processId AS processId,
            p.entrySymbolId AS entrySymbolId,
            p.label AS label,
            p.depth AS depth,
            r.stepOrder AS stepOrder,
            r.role AS role
     ORDER BY symbolId ASC, r.stepOrder ASC, processId ASC`,
    { symbolIds },
  );

  const map = new Map<string, ProcessForSymbolRow[]>();
  for (const row of rows) {
    const list = map.get(row.symbolId) ?? [];
    list.push({
      processId: row.processId,
      entrySymbolId: row.entrySymbolId,
      label: row.label,
      depth: toNumber(row.depth),
      stepOrder: toNumber(row.stepOrder),
      role: row.role,
    });
    map.set(row.symbolId, list);
  }

  return map;
}

export async function getProcessOverviewStats(
  conn: Connection,
  repoId: string,
): Promise<{
  totalProcesses: number;
  averageDepth: number;
  entryPoints: number;
  longestProcesses: Array<{ processId: string; label: string; depth: number }>;
}> {
  const agg = await querySingle<{
    totalProcesses: unknown;
    averageDepth: unknown;
    entryPoints: unknown;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:PROCESS_IN_REPO]-(p:Process)
     RETURN COUNT(p) AS totalProcesses,
            AVG(p.depth) AS averageDepth,
            COUNT(DISTINCT p.entrySymbolId) AS entryPoints`,
    { repoId },
  );

  const top = await queryAll<{
    processId: string;
    label: string;
    depth: unknown;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:PROCESS_IN_REPO]-(p:Process)
     RETURN p.processId AS processId,
            p.label AS label,
            p.depth AS depth
     ORDER BY depth DESC, processId ASC
     LIMIT 5`,
    { repoId },
  );

  return {
    totalProcesses: toNumber(agg?.totalProcesses ?? 0),
    averageDepth: toNumber(agg?.averageDepth ?? 0),
    entryPoints: toNumber(agg?.entryPoints ?? 0),
    longestProcesses: top.map((row) => ({
      processId: row.processId,
      label: row.label,
      depth: toNumber(row.depth),
    })),
  };
}

export async function getProcessFlow(
  conn: Connection,
  processId: string,
): Promise<ProcessStepRow[]> {
  const rows = await queryAll<{
    symbolId: string;
    stepOrder: unknown;
    role: string | null;
  }>(
    conn,
    `MATCH (s:Symbol)-[r:PARTICIPATES_IN]->(p:Process {processId: $processId})
     RETURN s.symbolId AS symbolId,
            r.stepOrder AS stepOrder,
            r.role AS role
     ORDER BY r.stepOrder ASC, symbolId ASC`,
    { processId },
  );

  return rows.map((row) => ({
    symbolId: row.symbolId,
    stepOrder: toNumber(row.stepOrder),
    role: row.role,
  }));
}

export async function getProcessStepsAfterSymbol(
  conn: Connection,
  processId: string,
  symbolId: string,
): Promise<ProcessStepRow[]> {
  const rows = await queryAll<{
    symbolId: string;
    stepOrder: unknown;
    role: string | null;
  }>(
    conn,
    `MATCH (s:Symbol {symbolId: $symbolId})-[r:PARTICIPATES_IN]->(p:Process {processId: $processId})
     WITH p, r.stepOrder AS startOrder
     MATCH (s2:Symbol)-[r2:PARTICIPATES_IN]->(p)
     WHERE r2.stepOrder > startOrder
     RETURN s2.symbolId AS symbolId,
            r2.stepOrder AS stepOrder,
            r2.role AS role
     ORDER BY r2.stepOrder ASC, symbolId ASC`,
    { processId, symbolId },
  );

  return rows.map((row) => ({
    symbolId: row.symbolId,
    stepOrder: toNumber(row.stepOrder),
    role: row.role,
  }));
}

export async function deleteProcessesByRepo(
  conn: Connection,
  repoId: string,
): Promise<void> {
  await exec(
    conn,
    `MATCH (p:Process {repoId: $repoId})
     OPTIONAL MATCH (:Symbol)-[m:PARTICIPATES_IN]->(p)
     DELETE m`,
    { repoId },
  );

  await exec(
    conn,
    `MATCH (p:Process {repoId: $repoId})-[rel:PROCESS_IN_REPO]->(:Repo {repoId: $repoId})
     DELETE rel`,
    { repoId },
  );

  await exec(
    conn,
    `MATCH (p:Process {repoId: $repoId})
     DELETE p`,
    { repoId },
  );
}
