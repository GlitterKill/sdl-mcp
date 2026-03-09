import { getKuzuConn } from "../db/kuzu.js";
import * as kuzuDb from "../db/kuzu-queries.js";
import { hashContent } from "../util/hashing.js";
import { safeCompileRegex } from "../util/safeRegex.js";

import type { ProcessTrace, ProcessTraceStep } from "./process-types.js";

function compileEntryPatterns(entryPatterns: string[]): RegExp[] {
  const patterns: RegExp[] = [];
  for (const pattern of entryPatterns) {
    const compiled = safeCompileRegex(pattern);
    if (compiled) {
      patterns.push(compiled);
    }
  }
  return patterns;
}

export async function traceProcessesTS(
  repoId: string,
  entryPatterns: string[],
  options: { maxDepth?: number } = {},
): Promise<ProcessTrace[]> {
  const maxDepth = options.maxDepth ?? 20;
  const patterns = compileEntryPatterns(entryPatterns);
  if (patterns.length === 0) return [];

  const conn = await getKuzuConn();
  const symbols = await kuzuDb.getSymbolsByRepo(conn, repoId);
  if (symbols.length === 0) return [];

  const entrySymbolIds = symbols
    .filter((s) => patterns.some((re) => re.test(s.name)))
    .map((s) => s.symbolId)
    .sort()
    .filter((id, idx, arr) => idx === 0 || id !== arr[idx - 1]);

  if (entrySymbolIds.length === 0) return [];

  const allSymbolIds = symbols.map((s) => s.symbolId).sort();
  const edgesByFrom = await kuzuDb.getEdgesFromSymbolsLite(conn, allSymbolIds);

  const adjacency = new Map<string, string[]>();
  for (const id of allSymbolIds) adjacency.set(id, []);

  for (const [fromSymbolId, edges] of edgesByFrom) {
    const out = adjacency.get(fromSymbolId);
    if (!out) continue;
    for (const e of edges) {
      if (e.edgeType !== "call") continue;
      out.push(e.toSymbolId);
    }
  }

  for (const out of adjacency.values()) {
    out.sort();
    for (let i = out.length - 1; i > 0; i--) {
      if (out[i] === out[i - 1]) out.splice(i, 1);
    }
  }

  function trace(entrySymbolId: string): ProcessTrace {
    const visited = new Set<string>();
    const steps: ProcessTraceStep[] = [];
    let depthReached = 0;

    function dfs(currentId: string, depth: number): void {
      if (depth > maxDepth) return;
      if (visited.has(currentId)) return;
      visited.add(currentId);
      depthReached = Math.max(depthReached, depth);

      steps.push({ symbolId: currentId, stepOrder: steps.length });

      const callees = adjacency.get(currentId) ?? [];
      for (const calleeId of callees) {
        dfs(calleeId, depth + 1);
      }
    }

    dfs(entrySymbolId, 0);

    return {
      processId: hashContent(`process:${entrySymbolId}`),
      entrySymbolId,
      steps,
      depth: depthReached,
    };
  }

  return entrySymbolIds.map(trace);
}
