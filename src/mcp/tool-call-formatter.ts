/**
 * tool-call-formatter.ts - Human-readable tool call summaries.
 *
 * Formats SDL-MCP tool calls and results as concise text for user-facing
 * MCP logging notifications. The JSON response remains unchanged for the LLM.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncName(s: string, max = 40): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function shortPath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join("/")}`;
}

function tok(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function safeRange(
  obj: unknown,
): { startLine?: number; endLine?: number } | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const record = obj as Record<string, unknown>;
  return {
    startLine:
      typeof record.startLine === "number" ? record.startLine : undefined,
    endLine: typeof record.endLine === "number" ? record.endLine : undefined,
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

function fmtSymbolSearch(
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): string | null {
  const results = result.results as Array<Record<string, unknown>> | undefined;
  if (!results) return null;
  const query = str(args.query);
  const lines = [
    `symbol.search "${query}" -> ${results.length} result${results.length !== 1 ? "s" : ""}`,
  ];
  for (const symbol of results.slice(0, 5)) {
    const name = str(symbol.name).padEnd(24);
    const kind = str(symbol.kind).padEnd(10);
    lines.push(`  ${name} ${kind} ${shortPath(str(symbol.file))}`);
  }
  if (results.length > 5) {
    lines.push(`  …and ${results.length - 5} more`);
  }
  return lines.join("\n");
}

function fmtSymbolGetCard(
  _args: Record<string, unknown>,
  result: Record<string, unknown>,
): string | null {
  const card = result.card as Record<string, unknown> | undefined;
  if (result.notModified) {
    return "symbol.getCard -> not modified (ETag hit)";
  }
  if (!card) return null;
  const deps = card.deps as Record<string, unknown[]> | undefined;
  const imports = deps?.imports?.length ?? 0;
  const calls = deps?.calls?.length ?? 0;
  return `symbol.getCard -> ${str(card.name)} (${str(card.kind)})\n  File: ${shortPath(str(card.file))} ${rng(safeRange(card.range))}\n  Deps: ${imports} imports, ${calls} calls`;
}

function fmtSymbolGetCards(
  _args: Record<string, unknown>,
  result: Record<string, unknown>,
): string | null {
  const cards = result.cards as Array<Record<string, unknown>> | undefined;
  if (!cards) return null;
  return `symbol.getCards -> ${cards.length} card${cards.length !== 1 ? "s" : ""}`;
}

function fmtCodeSkeleton(
  _args: Record<string, unknown>,
  result: Record<string, unknown>,
): string | null {
  const file = str(result.file);
  const originalLines = num(result.originalLines);
  const estimatedTokens = num(result.estimatedTokens);
  const truncated = result.truncated ? " (truncated)" : "";
  return `code.getSkeleton -> ${shortPath(file)}\n  ${originalLines} -> skeleton ${rng(safeRange(result.range))}${truncated} (~${tok(estimatedTokens)} tokens)`;
}

function fmtCodeHotPath(
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): string | null {
  const matched = result.matchedIdentifiers as string[] | undefined;
  const requested = (args.identifiersToFind as string[])?.length ?? 0;
  const found = matched?.length ?? 0;
  const truncated = result.truncated ? " (truncated)" : "";
  return `code.getHotPath -> matched ${found}/${requested} identifiers ${rng(safeRange(result.range))}${truncated}\n  (~${tok(num(result.estimatedTokens))} tokens)`;
}

function fmtCodeNeedWindow(
  _args: Record<string, unknown>,
  result: Record<string, unknown>,
): string | null {
  const approved = result.approved;
  const status = approved ? "approved" : "denied";
  const downgraded = result.downgradedFrom
    ? ` (downgraded from ${str(result.downgradedFrom)})`
    : "";
  const estimatedTokens = num(result.estimatedTokens);
  if (!approved) {
    const next = str(result.nextBestAction);
    return `code.needWindow -> [${status}]${next ? `\n  Suggestion: ${next}` : ""}`;
  }
  return `code.needWindow -> [${status}]${downgraded} ${rng(safeRange(result.range))}\n  (~${tok(estimatedTokens)} tokens)`;
}

function fmtSliceBuild(
  _args: Record<string, unknown>,
  result: Record<string, unknown>,
): string | null {
  const cards =
    (result.cards as unknown[])?.length
    ?? (result.cardRefs as unknown[])?.length
    ?? 0;
  const handle = str(result.sliceHandle);
  const spillover = num(result.spilloverCount);
  const budget = result.budgetUsed as Record<string, unknown> | undefined;
  let line = `slice.build -> ${cards} cards`;
  if (handle) line += ` (handle: ${handle.slice(0, 8)}...)`;
  if (spillover > 0) line += `\n  ${spillover} in spillover`;
  if (budget) line += `\n  Budget: ~${tok(num(budget.estimatedTokens))} tokens used`;
  return line;
}

function fmtSliceRefresh(
  _args: Record<string, unknown>,
  result: Record<string, unknown>,
): string | null {
  const added = (result.addedCards as unknown[])?.length ?? 0;
  const removed = (result.removedSymbolIds as unknown[])?.length ?? 0;
  const updated = (result.updatedCards as unknown[])?.length ?? 0;
  return `slice.refresh -> +${added} -${removed} ~${updated} cards`;
}

function fmtDeltaGet(
  _args: Record<string, unknown>,
  result: Record<string, unknown>,
): string | null {
  const changes = (result.changes as unknown[])?.length ?? 0;
  const blast = (result.blastRadius as unknown[])?.length ?? 0;
  return `delta.get -> ${changes} changed symbols${blast > 0 ? `, ${blast} in blast radius` : ""}`;
}

function fmtRepoStatus(
  _args: Record<string, unknown>,
  result: Record<string, unknown>,
): string | null {
  const files = num(result.filesIndexed);
  const symbols = num(result.symbolsIndexed);
  const health = num(result.healthScore);
  return `repo.status -> ${files} files, ${symbols} symbols, health ${health}/100`;
}

function fmtRepoOverview(
  args: Record<string, unknown>,
  _result: Record<string, unknown>,
): string | null {
  const level = str(args.level) || "stats";
  return `repo.overview (${level})`;
}

function fmtIndexRefresh(
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): string | null {
  const mode = str(args.mode) || "incremental";
  const files = num(result.filesProcessed ?? result.filesScanned);
  return `index.refresh (${mode}) -> ${files} files processed`;
}

function fmtWorkflow(
  _args: Record<string, unknown>,
  result: Record<string, unknown>,
): string | null {
  const results = result.results as Array<Record<string, unknown>> | undefined;
  if (!results) return null;
  const ok = results.filter((step) => step.status === "ok").length;
  const err = results.filter((step) => step.status === "error").length;
  const total = num(result.totalTokens);
  let line = `workflow -> ${results.length} steps (${ok} ok`;
  if (err > 0) line += `, ${err} errors`;
  line += ")";
  if (total > 0) line += ` ~${tok(total)} tokens`;
  return line;
}

function fmtAgentContext(
  _args: Record<string, unknown>,
  result: Record<string, unknown>,
): string | null {
  const path = result.path as Record<string, unknown> | undefined;
  const rungs = (path?.rungs as unknown[])?.length ?? 0;
  const status = typeof result.success === "boolean"
    ? (result.success ? "success" : "error")
    : "complete";
  return `agent.context [${status}] -> ${rungs} rungs`;
}

function fmtMemoryStore(
  args: Record<string, unknown>,
  _result: Record<string, unknown>,
): string | null {
  const title = str(args.title);
  return `memory.store -> "${truncName(title)}"`;
}

function fmtMemoryQuery(
  _args: Record<string, unknown>,
  result: Record<string, unknown>,
): string | null {
  const memories = (result.memories as unknown[])?.length ?? 0;
  return `memory.query -> ${memories} result${memories !== 1 ? "s" : ""}`;
}

function fmtPrRisk(
  _args: Record<string, unknown>,
  result: Record<string, unknown>,
): string | null {
  const score = num(result.overallRisk ?? result.riskScore);
  const items = (result.riskItems as unknown[])?.length ?? 0;
  return `pr.risk.analyze -> risk ${score}/100, ${items} items`;
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
  "sdl.workflow": fmtWorkflow,
  "sdl.agent.context": fmtAgentContext,
  "sdl.context": fmtAgentContext,
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
  const formatter = formatters[toolName];
  if (!formatter) return null;
  try {
    return formatter(args, (result ?? {}) as Record<string, unknown>);
  } catch {
    return null;
  }
}
