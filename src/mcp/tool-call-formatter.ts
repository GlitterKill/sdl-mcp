/**
 * tool-call-formatter.ts - Human-readable tool call summaries.
 *
 * Formats SDL-MCP tool calls and results as concise text for user-facing
 * MCP content and logging notifications. The JSON response stays first for the LLM.
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

function records(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> =>
      !!item && typeof item === "object" && !Array.isArray(item),
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function appendIndented(lines: string[], text: string, maxChars = 1200): void {
  const clipped =
    text.length > maxChars
      ? `${text.slice(0, maxChars)}\n...truncated...`
      : text;
  for (const line of clipped.split(/\r?\n/)) {
    lines.push(`    ${line}`);
  }
}

function plural(
  count: number,
  singular: string,
  pluralForm = `${singular}s`,
): string {
  return count === 1 ? singular : pluralForm;
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
  // Handle batch mode (symbolIds/symbolRefs returns cards array)
  const cards = result.cards as unknown[] | undefined;
  if (Array.isArray(cards)) {
    return `symbol.getCard -> ${cards.length} card${cards.length === 1 ? "" : "s"} returned`;
  }
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

function fmtCodeSkeleton(
  _args: Record<string, unknown>,
  result: Record<string, unknown>,
): string | null {
  if (result.notModified) {
    return "code.getSkeleton -> not modified (ETag hit)";
  }
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
  if (result.notModified) {
    return "code.getHotPath -> not modified (ETag hit)";
  }
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
    (result.cards as unknown[])?.length ??
    (result.cardRefs as unknown[])?.length ??
    0;
  const handle = str(result.sliceHandle);
  const spillover = num(result.spilloverCount);
  const budget = result.budgetUsed as Record<string, unknown> | undefined;
  let line = `slice.build -> ${cards} cards`;
  if (handle) line += ` (handle: ${handle.slice(0, 8)}...)`;
  if (spillover > 0) line += `\n  ${spillover} in spillover`;
  if (budget)
    line += `\n  Budget: ~${tok(num(budget.estimatedTokens))} tokens used`;
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
  result: Record<string, unknown>,
): string | null {
  if (result.notModified) {
    return "repo.overview -> not modified (ETag hit)";
  }
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
  if (result.notModified) {
    return "sdl.context -> not modified (ETag hit)";
  }
  const path = result.path as Record<string, unknown> | undefined;
  const rungs = (path?.rungs as unknown[])?.length ?? 0;
  const status =
    typeof result.success === "boolean"
      ? result.success
        ? "success"
        : "error"
      : "complete";
  return `sdl.context [${status}] -> ${rungs} rungs`;
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
// Current gateway/meta formatters
// ---------------------------------------------------------------------------

function fmtFileRead(
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): string | null {
  const file = str(result.filePath) || str(args.filePath);
  const bytes = num(result.bytesRead ?? result.totalBytes ?? result.sizeBytes);
  const truncated = result.truncated ? " (truncated)" : "";
  const suffix = bytes > 0 ? `, ${tok(bytes)} bytes` : "";
  return `file.read -> ${shortPath(file)}${suffix}${truncated}`;
}

function fmtFileWrite(
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): string | null {
  const file = str(result.filePath) || str(args.filePath);
  const mode = str(result.mode) || str(args.editMode) || "write";
  const lines = num(result.linesWritten);
  const bytes = num(result.bytesWritten);
  const replacements = num(result.replacementCount);
  const details: string[] = [];
  if (lines > 0) details.push(`${lines} ${plural(lines, "line")}`);
  if (bytes > 0) details.push(`${tok(bytes)} bytes`);
  if (replacements > 0) {
    details.push(`${replacements} ${plural(replacements, "replacement")}`);
  }
  return `file.write (${mode}) -> ${shortPath(file)}${details.length > 0 ? `, ${details.join(", ")}` : ""}`;
}

function fmtSearchEditPreview(result: Record<string, unknown>): string | null {
  const matches = num(result.matchesFound);
  const files = num(result.filesMatched);
  const plan = str(result.planHandle);
  const entries = records(result.fileEntries);
  const lines = [
    `search.edit preview -> ${matches} ${plural(matches, "match", "matches")} in ${files} ${plural(files, "file")}${plan ? ` (plan ${plan})` : ""}`,
  ];

  for (const entry of entries.slice(0, 2)) {
    const file = str(entry.file);
    const count = num(entry.matchCount);
    const mode = str(entry.editMode);
    lines.push(
      `  ${shortPath(file)}: ${count} ${plural(count, "match", "matches")}${mode ? ` (${mode})` : ""}`,
    );
    const snippets = record(entry.snippets);
    const before = str(snippets?.before);
    const after = str(snippets?.after);
    if (before || after) {
      lines.push("  diff preview:");
      if (before) {
        lines.push("  --- before");
        appendIndented(lines, before, 900);
      }
      if (after) {
        lines.push("  +++ after");
        appendIndented(lines, after, 900);
      }
    }
  }
  if (entries.length > 2) {
    lines.push(
      `  ...and ${entries.length - 2} more ${plural(entries.length - 2, "file")}`,
    );
  }
  return lines.join("\n");
}

function fmtSearchEditApply(result: Record<string, unknown>): string | null {
  const written = num(result.filesWritten);
  const attempted = num(result.filesAttempted);
  const failed = num(result.filesFailed);
  const skipped = num(result.filesSkipped);
  const lines = [
    `search.edit apply -> ${written}/${attempted} ${plural(attempted, "file")} written${failed > 0 ? `, ${failed} failed` : ""}${skipped > 0 ? `, ${skipped} skipped` : ""}`,
  ];
  for (const item of records(result.results).slice(0, 5)) {
    const file = str(item.file);
    const status = str(item.status) || "unknown";
    const reason = str(item.reason);
    lines.push(
      `  ${shortPath(file)}: ${status}${reason ? ` (${reason})` : ""}`,
    );
  }
  return lines.join("\n");
}

function fmtSearchEdit(
  _args: Record<string, unknown>,
  result: Record<string, unknown>,
): string | null {
  const mode = str(result.mode);
  if (mode === "preview") return fmtSearchEditPreview(result);
  if (mode === "apply") return fmtSearchEditApply(result);
  return null;
}

function fmtFileGateway(
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): string | null {
  const op = str(args.op);
  if (result.mode === "preview" || op === "searchEditPreview") {
    return fmtSearchEditPreview(result);
  }
  if (result.mode === "apply" || op === "searchEditApply") {
    return fmtSearchEditApply(result);
  }
  if (op === "write") return fmtFileWrite(args, result);
  if (op === "read") return fmtFileRead(args, result);
  if (op === "previewWindow" || op === "sourceWindow") {
    return fmtCodeNeedWindow(args, result);
  }
  return op ? `sdl.file ${op} -> complete` : null;
}

function fmtActionSearch(
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): string | null {
  const actions = records(result.actions);
  const total = num(result.total) || actions.length;
  const query = str(args.query);
  const lines = [
    `action.search "${truncName(query, 60)}" -> ${actions.length}/${total} ${plural(total, "action")}`,
  ];
  for (const action of actions.slice(0, 5)) {
    const name = str(action.action) || str(action.fn);
    const description = str(action.description);
    lines.push(
      `  ${name}${description ? ` - ${truncName(description, 90)}` : ""}`,
    );
  }
  return lines.join("\n");
}

function fmtManual(
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): string | null {
  const actionList = Array.isArray(args.actions)
    ? args.actions.filter(
        (action): action is string => typeof action === "string",
      )
    : [];
  const label = actionList.length > 0 ? actionList.join(", ") : "API reference";
  const tokens = num(result.tokenEstimate);
  return `manual -> ${label}${tokens > 0 ? ` (~${tok(tokens)} tokens)` : ""}`;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const formatters: Record<string, Formatter> = {
  "sdl.symbol.search": fmtSymbolSearch,
  "sdl.symbol.getCard": fmtSymbolGetCard,
  "sdl.code.getSkeleton": fmtCodeSkeleton,
  "sdl.code.getHotPath": fmtCodeHotPath,
  "sdl.code.needWindow": fmtCodeNeedWindow,
  "sdl.slice.build": fmtSliceBuild,
  "sdl.slice.refresh": fmtSliceRefresh,
  "sdl.delta.get": fmtDeltaGet,
  "sdl.repo.status": fmtRepoStatus,
  "sdl.repo.overview": fmtRepoOverview,
  "sdl.index.refresh": fmtIndexRefresh,
  "sdl.file": fmtFileGateway,
  "sdl.file.read": fmtFileRead,
  "sdl.file.write": fmtFileWrite,
  "sdl.search.edit": fmtSearchEdit,
  "sdl.action.search": fmtActionSearch,
  "sdl.manual": fmtManual,
  "sdl.workflow": fmtWorkflow,
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
