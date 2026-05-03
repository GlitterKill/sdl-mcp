/**
 * ladybug-processes.ts - Process Operations
 * Extracted from ladybug-queries.ts as part of the god-object split.
 */
import type { Connection } from "kuzu";
import {
  exec,
  queryAll,
  querySingle,
  toNumber,
  withTransaction,
} from "./ladybug-core.js";

export interface ProcessRow {
  processId: string;
  repoId: string;
  entrySymbolId: string;
  label: string;
  depth: number;
  versionId: string | null;
  createdAt: string;
  searchText?: string | null;
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

export interface ProcessStepForRepoRow {
  processId: string;
  symbolId: string;
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
         p.createdAt = $createdAt,
         p.searchText = $searchText
     MERGE (p)-[:PROCESS_IN_REPO]->(r)`,
    {
      processId: row.processId,
      repoId: row.repoId,
      entrySymbolId: row.entrySymbolId,
      label: row.label,
      depth: row.depth,
      versionId: row.versionId,
      createdAt: row.createdAt,
      searchText: row.searchText ?? null,
    },
  );
}

/**
 * Build a search-friendly text string for a process.
 * Concatenates the label, entry symbol name, and up to 15 step names.
 */
export function buildProcessSearchText(
  label: string,
  entrySymbolName: string,
  memberNames: string[],
): string {
  const names = memberNames.slice(0, 15).join(" ");
  return `process: ${label} entry: ${entrySymbolName} steps: ${names}`.trim();
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

/**
 * Batch-upsert process steps via UNWIND-batched MERGE within a single
 * transaction. Side-effect mode (no RETURN) avoids LadybugDB issue #285.
 */
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
  // UNWIND-batched MERGE; side-effect mode (no RETURN) avoids LadybugDB#285.
  const CHUNK = 256;
  await withTransaction(conn, async (txConn) => {
    for (let i = 0; i < steps.length; i += CHUNK) {
      const rows = steps.slice(i, i + CHUNK);
      await exec(
        txConn,
        `UNWIND $rows AS row
         MATCH (s:Symbol {symbolId: row.symbolId})
         MATCH (p:Process {processId: row.processId})
         MERGE (s)-[r:PARTICIPATES_IN]->(p)
         SET r.stepOrder = row.stepOrder,
             r.role = row.role`,
        { rows },
      );
    }
  });
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

export async function getProcessesForRepo(
  conn: Connection,
  repoId: string,
): Promise<ProcessRow[]> {
  const rows = await queryAll<{
    processId: string;
    entrySymbolId: string;
    label: string;
    depth: unknown;
    versionId: string | null;
    createdAt: string;
    searchText: string | null;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:PROCESS_IN_REPO]-(p:Process)
     RETURN p.processId AS processId,
            p.entrySymbolId AS entrySymbolId,
            p.label AS label,
            p.depth AS depth,
            p.versionId AS versionId,
            p.createdAt AS createdAt,
            p.searchText AS searchText
     ORDER BY p.processId ASC`,
    { repoId },
  );

  return rows.map((row) => ({
    processId: row.processId,
    repoId,
    entrySymbolId: row.entrySymbolId,
    label: row.label,
    depth: toNumber(row.depth),
    versionId: row.versionId,
    createdAt: row.createdAt,
    searchText: row.searchText,
  }));
}

export async function getProcessStepsForRepo(
  conn: Connection,
  repoId: string,
): Promise<ProcessStepForRepoRow[]> {
  const rows = await queryAll<{
    processId: string;
    symbolId: string;
    stepOrder: unknown;
    role: string | null;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:PROCESS_IN_REPO]-(p:Process)<-[step:PARTICIPATES_IN]-(s:Symbol)
     RETURN p.processId AS processId,
            s.symbolId AS symbolId,
            step.stepOrder AS stepOrder,
            step.role AS role
     ORDER BY p.processId ASC, step.stepOrder ASC, s.symbolId ASC`,
    { repoId },
  );

  return rows.map((row) => ({
    processId: row.processId,
    symbolId: row.symbolId,
    stepOrder: toNumber(row.stepOrder),
    role: row.role,
  }));
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

/**
 * Backfill searchText for all processes in a repo.
 * Fetches each process's steps, resolves symbol names, and updates searchText.
 * Returns the count of processes updated.
 */
export async function backfillProcessSearchText(
  conn: Connection,
  repoId: string,
): Promise<number> {
  const rows = await queryAll<{
    processId: string;
    label: string;
    entrySymbolId: string;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:PROCESS_IN_REPO]-(p:Process)
     RETURN p.processId AS processId,
            p.label AS label,
            p.entrySymbolId AS entrySymbolId
     ORDER BY p.processId`,
    { repoId },
  );
  if (rows.length === 0) return 0;

  let updated = 0;
  await withTransaction(conn, async (txConn) => {
    for (const proc of rows) {
      const steps = await getProcessFlow(txConn, proc.processId);
      const allSymbolIds = [
        proc.entrySymbolId,
        ...steps.map((s) => s.symbolId),
      ];

      // Fetch names for the entry + step symbols
      const nameRows = await queryAll<{ symbolId: string; name: string }>(
        txConn,
        `MATCH (s:Symbol)
         WHERE s.symbolId IN $symbolIds
         RETURN s.symbolId AS symbolId, s.name AS name`,
        { symbolIds: allSymbolIds },
      );
      const nameMap = new Map(nameRows.map((r) => [r.symbolId, r.name]));

      const entryName = nameMap.get(proc.entrySymbolId) ?? proc.entrySymbolId;
      const stepNames = steps
        .map((s) => nameMap.get(s.symbolId))
        .filter((n): n is string => Boolean(n));

      const searchText = buildProcessSearchText(proc.label, entryName, stepNames);
      await exec(
        txConn,
        `MATCH (p:Process {processId: $processId})
         SET p.searchText = $searchText`,
        { processId: proc.processId, searchText },
      );
      updated++;
    }
  });

  return updated;
}

export async function deleteProcessesByRepo(
  conn: Connection,
  repoId: string,
): Promise<void> {
  await withTransaction(conn, async (txConn) => {
    await exec(
      txConn,
      `MATCH (p:Process {repoId: $repoId})
       OPTIONAL MATCH (:Symbol)-[m:PARTICIPATES_IN]->(p)
       DELETE m`,
      { repoId },
    );

    await exec(
      txConn,
      `MATCH (p:Process {repoId: $repoId})-[rel:PROCESS_IN_REPO]->(:Repo {repoId: $repoId})
       DELETE rel`,
      { repoId },
    );

    await exec(
      txConn,
      `MATCH (p:Process {repoId: $repoId})
       DELETE p`,
      { repoId },
    );
  });
}
