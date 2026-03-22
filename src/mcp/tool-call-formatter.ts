/**
 * tool-call-formatter.ts — Human-readable tool call summaries.
 *
 * Formats SDL-MCP tool calls and results as concise text for user-facing
 * MCP logging notifications. The JSON response remains unchanged for the LLM.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncName(s: string, max = 40): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function shortPath(p: string): string {
  // Keep last 2 path segments for brevity
  const parts = p.replace(/\\/g, "/").split("/");
  return parts.length <= 2 ? p : "…/" + parts.slice(-2).join("/");
}

function tok(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1) + "k";
  return (n / 1_000_000).toFixed(2) + "M";
}

function safeRange(obj: unknown): { startLine?: number; endLine?: number } | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const r = obj as Record<string, unknown>;
  return {
    startLine: typeof r.startLine === "number" ? r.startLine : undefined,
    endLine: typeof r.endLine === "number" ? r.endLine : undefined,
  };
}

function rng(r: { startLine?: number; endLine?: number } | undefined): string {
  if (!r) return "";
  return `L${r.startLine ?? "?"}–${r.endLine ?? "?"}`;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

// ---------------------------------------------------------------------------
// Per-tool formatters
// ---------------------------------------------------------------------------

type Formatter = (
  args: Record<string, unknown>,
  res: Record<string, unknown>,
) => string | null;

function fmtSymbolSearch(_a: Record<string, unknown>, r: Record<string, unknown>): string | null {
  const results = r.results as Array<Record<string, unknown>> | undefined;
  if (!results) return null;
  const q = str(_a.query);
  const lines = [`symbol.search "${q}" → ${results.length} result${results.length !== 1 ? "s" : ""}`];
  for (const s of results.slice(0, 5)) {
    const name = str(s.name).padEnd(24);
    const kind = str(s.kind).padEnd(10);
    lines.push(`  ${name} ${kind} ${shortPath(str(s.file))}`);
  }
  if (results.length > 5) lines.push(`  …and ${results.length - 5} more`);
  return lines.join("\n");
}

function fmtSymbolGetCard(_a: Record<string, unknown>, r: Record<string, unknown>): string | null {
  const card = r.card as Record<string, unknown> | undefined;
  if (r.notModified) return `symbol.getCard → not modified (ETag hit)`;
  if (!card) return null;
  const deps = card.deps as Record<string, unknown[]> | undefined;
  const imports = deps?.imports?.length ?? 0;
  const calls = deps?.calls?.length ?? 0;
  return `symbol.getCard → ${str(card.name)} (${str(card.kind)})\n  File: ${shortPath(str(card.file))} ${rng(safeRange(card.range))}\n  Deps: ${imports} imports, ${calls} calls`;
}

function fmtSymbolGetCards(_a: Record<string, unknown>, r: Record<string, unknown>): string | null {
  const cards = r.cards as Array<Record<string, unknown>> | undefined;
  if (!cards) return null;
  return `symbol.getCards → ${cards.length} card${cards.length !== 1 ? "s" : ""}`;
}

function fmtCodeSkeleton(_a: Record<string, unknown>, r: Record<string, unknown>): string | null {
  const file = str(r.file);
  const orig = num(r.originalLines);
  const est = num(r.estimatedTokens);
  const trunc = r.truncated ? " (truncated)" : "";
  return `code.getSkeleton → ${shortPath(file)}\n  ${orig} → skeleton ${rng(safeRange(r.range))}${trunc} (~${tok(est)} tokens)`;
}

function fmtCodeHotPath(_a: Record<string, unknown>, r: Record<string, unknown>): string | null {
  const matched = r.matchedIdentifiers as string[] | undefined;
  const requested = (_a.identifiersToFind as string[])?.length ?? 0;
  const found = matched?.length ?? 0;
  const trunc = r.truncated ? " (truncated)" : "";
  return `code.getHotPath → matched ${found}/${requested} identifiers ${rng(safeRange(r.range))}${trunc}\n  (~${tok(num(r.estimatedTokens))} tokens)`;
}

function fmtCodeNeedWindow(_a: Record<string, unknown>, r: Record<string, unknown>): string | null {
  const approved = r.approved;
  const status = approved ? "approved" : "denied";
  const downgraded = r.downgradedFrom ? ` (downgraded from ${str(r.downgradedFrom)})` : "";
  const est = num(r.estimatedTokens);
  if (!approved) {
    const next = str(r.nextBestAction);
    return `code.needWindow → [${status}]${next ? "\n  Suggestion: " + next : ""}`;
  }
  return `code.needWindow → [${status}]${downgraded} ${rng(safeRange(r.range))}\n  (~${tok(est)} tokens)`;
}

function fmtSliceBuild(_a: Record<string, unknown>, r: Record<string, unknown>): string | null {
  const cards = (r.cards as unknown[])?.length ?? (r.cardRefs as unknown[])?.length ?? 0;
  const handle = str(r.sliceHandle);
  const spillover = num(r.spilloverCount);
  const budget = r.budgetUsed as Record<string, unknown> | undefined;
  let line = `slice.build → ${cards} cards`;
  if (handle) line += ` (handle: ${handle.slice(0, 8)}…)`;
  if (spillover > 0) line += `\n  ${spillover} in spillover`;
  if (budget) line += `\n  Budget: ~${tok(num(budget.estimatedTokens))} tokens used`;
  return line;
}

function fmtSliceRefresh(_a: Record<string, unknown>, r: Record<string, unknown>): string | null {
  const added = (r.addedCards as unknown[])?.length ?? 0;
  const removed = (r.removedSymbolIds as unknown[])?.length ?? 0;
  const updated = (r.updatedCards as unknown[])?.length ?? 0;
  return `slice.refresh → +${added} -${removed} ~${updated} cards`;
}

function fmtDeltaGet(_a: Record<string, unknown>, r: Record<string, unknown>): string | null {
  const changes = (r.changes as unknown[])?.length ?? 0;
  const blast = (r.blastRadius as unknown[])?.length ?? 0;
  return `delta.get → ${changes} changed symbols${blast > 0 ? `, ${blast} in blast radius` : ""}`;
}

function fmtRepoStatus(_a: Record<string, unknown>, r: Record<string, unknown>): string | null {
  const files = num(r.filesIndexed);
  const syms = num(r.symbolsIndexed);
  const health = num(r.healthScore);
  return `repo.status → ${files} files, ${syms} symbols, health ${health}/100`;
}

function fmtRepoOverview(_a: Record<string, unknown>, _r: Record<string, unknown>): string | null {
  const level = str(_a.level) || "stats";
  return `repo.overview (${level})`;
}

function fmtIndexRefresh(_a: Record<string, unknown>, r: Record<string, unknown>): string | null {
  const mode = str(_a.mode) || "incremental";
  const files = num(r.filesProcessed ?? r.filesScanned);
  return `index.refresh (${mode}) → ${files} files processed`;
}

function fmtChain(_a: Record<string, unknown>, r: Record<string, unknown>): string | null {
  const results = r.results as Array<Record<string, unknown>> | undefined;
  if (!results) return null;
  const ok = results.filter(s => s.status === "ok").length;
  const err = results.filter(s => s.status === "error").length;
  const total = num(r.totalTokens);
  let line = `chain → ${results.length} steps (${ok} ok`;
  if (err > 0) line += `, ${err} errors`;
  line += `)`;
  if (total > 0) line += ` ~${tok(total)} tokens`;
  return line;
}

function fmtAgentOrchestrate(_a: Record<string, unknown>, r: Record<string, unknown>): string | null {
  const plan = r.plan as Record<string, unknown> | undefined;
  const rungs = (plan?.rungs as unknown[])?.length ?? 0;
  const status = str(r.status) || "complete";
  return `agent.orchestrate [${status}] → ${rungs} rungs`;
}

function fmtMemoryStore(_a: Record<string, unknown>, _r: Record<string, unknown>): string | null {
  const title = str(_a.title);
  return `memory.store → "${truncName(title)}"`;
}

function fmtMemoryQuery(_a: Record<string, unknown>, r: Record<string, unknown>): string | null {
  const memories = (r.memories as unknown[])?.length ?? 0;
  return `memory.query → ${memories} result${memories !== 1 ? "s" : ""}`;
}

function fmtPrRisk(_a: Record<string, unknown>, r: Record<string, unknown>): string | null {
  const score = num(r.overallRisk ?? r.riskScore);
  const items = (r.riskItems as unknown[])?.length ?? 0;
  return `pr.risk.analyze → risk ${score}/100, ${items} items`;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const formatters: Record<string, Formatter> = {
  "sdl.symbol.search": fmtSymbolSearch,
  "sdl.symbol.getCard": fmtSymbolGetCard,
  "sdl.symbol.getCards": fmtSymbolGetCards,
  "sdl.code.getSkeleton": fmtCodeSkeleton,
  "sdl.code.getHotPath": fmtCodeHotPath,
  "sdl.code.needWindow": fmtCodeNeedWindow,
  "sdl.slice.build": fmtSliceBuild,
  "sdl.slice.refresh": fmtSliceRefresh,
  "sdl.delta.get": fmtDeltaGet,
  "sdl.repo.status": fmtRepoStatus,
  "sdl.repo.overview": fmtRepoOverview,
  "sdl.index.refresh": fmtIndexRefresh,
  "sdl.chain": fmtChain,
  "sdl.agent.orchestrate": fmtAgentOrchestrate,
  "sdl.memory.store": fmtMemoryStore,
  "sdl.memory.query": fmtMemoryQuery,
  "sdl.pr.risk.analyze": fmtPrRisk,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Format a tool call + result as human-readable text for user display.
 * Returns null if no formatter is registered for the tool.
 */
export function formatToolCallForUser(
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
): string | null {
  const fmt = formatters[toolName];
  if (!fmt) return null;
  try {
    return fmt(args, (result ?? {}) as Record<string, unknown>);
  } catch {
    return null;
  }
}
