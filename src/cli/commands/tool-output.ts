/**
 * Output formatting for CLI tool results.
 *
 * Supports JSON (default), compact JSON, pretty (human-readable), and table formats.
 * Pretty printers are action-specific for common queries; others fall back to JSON.
 */

export type OutputFormat = "json" | "json-compact" | "pretty" | "table";

/**
 * Format and write the tool result to the given stream.
 */
export function formatOutput(
  result: unknown,
  format: OutputFormat,
  stream: NodeJS.WritableStream = process.stdout,
): void {
  switch (format) {
    case "json":
      stream.write(JSON.stringify(result, null, 2) + "\n");
      break;

    case "json-compact":
      stream.write(JSON.stringify(result) + "\n");
      break;

    case "pretty":
      stream.write(prettyPrint(result) + "\n");
      break;

    case "table":
      stream.write(tablePrint(result) + "\n");
      break;

    default:
      stream.write(JSON.stringify(result, null, 2) + "\n");
      break;
  }
}

/**
 * Detect the best output format based on context.
 */
export function detectOutputFormat(
  explicit?: string,
): OutputFormat {
  if (explicit) {
    const normalized = explicit.toLowerCase();
    if (normalized === "json" || normalized === "json-compact" || normalized === "pretty" || normalized === "table") {
      return normalized;
    }
  }

  // Default to JSON (machine-readable, pipeable)
  return "json";
}

// ---------------------------------------------------------------------------
// Pretty printers
// ---------------------------------------------------------------------------

function prettyPrint(result: unknown): string {
  if (!result || typeof result !== "object") {
    return String(result);
  }

  const obj = result as Record<string, unknown>;

  // symbol.search results
  if (Array.isArray(obj.results) && obj.results.length > 0 && "symbolId" in obj.results[0]) {
    return prettySearchResults(obj.results as SymbolSearchResult[]);
  }

  // repo.status
  if ("filesIndexed" in obj && "symbolsIndexed" in obj && "repoId" in obj) {
    return prettyRepoStatus(obj);
  }

  // symbol.getCard
  if ("card" in obj && typeof obj.card === "object" && obj.card !== null) {
    return prettySymbolCard(obj.card as Record<string, unknown>);
  }

  // slice.build
  if ("cards" in obj && "edges" in obj && Array.isArray(obj.cards)) {
    return prettySliceResult(obj);
  }

  // Default: indented JSON
  return JSON.stringify(result, null, 2);
}

function tablePrint(result: unknown): string {
  if (!result || typeof result !== "object") {
    return String(result);
  }

  const obj = result as Record<string, unknown>;

  // symbol.search results as a table
  if (Array.isArray(obj.results)) {
    return formatTable(obj.results as Record<string, unknown>[]);
  }

  // feedback.query results
  if (Array.isArray(obj.records)) {
    return formatTable(obj.records as Record<string, unknown>[]);
  }

  return JSON.stringify(result, null, 2);
}

// ---------------------------------------------------------------------------
// Action-specific pretty printers
// ---------------------------------------------------------------------------

interface SymbolSearchResult {
  symbolId: string;
  name: string;
  file: string;
  kind: string;
}

function prettySearchResults(results: SymbolSearchResult[]): string {
  const lines: string[] = [];
  lines.push(`Found ${results.length} symbol(s):\n`);

  // Column widths
  const nameW = Math.max(4, ...results.map((r) => r.name.length));
  const kindW = Math.max(4, ...results.map((r) => r.kind.length));
  const fileW = Math.max(4, ...results.map((r) => r.file.length));

  const header = `  ${"NAME".padEnd(nameW)}  ${"KIND".padEnd(kindW)}  ${"FILE".padEnd(fileW)}`;
  const sep = `  ${"─".repeat(nameW)}  ${"─".repeat(kindW)}  ${"─".repeat(fileW)}`;

  lines.push(header);
  lines.push(sep);

  for (const r of results) {
    lines.push(`  ${r.name.padEnd(nameW)}  ${r.kind.padEnd(kindW)}  ${r.file.padEnd(fileW)}`);
  }

  return lines.join("\n");
}

function prettyRepoStatus(obj: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(`Repository: ${obj.repoId}`);
  lines.push(`  Root Path:      ${obj.rootPath}`);
  lines.push(`  Files Indexed:  ${obj.filesIndexed}`);
  lines.push(`  Symbols Indexed: ${obj.symbolsIndexed}`);
  lines.push(`  Latest Version: ${obj.latestVersionId ?? "none"}`);
  lines.push(`  Last Indexed:   ${obj.lastIndexedAt ?? "never"}`);
  lines.push(`  Health Score:   ${obj.healthScore}${obj.healthAvailable ? "" : " (unavailable)"}`);
  return lines.join("\n");
}

function prettySymbolCard(card: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(`Symbol: ${card.name} (${card.kind})`);
  lines.push(`  ID:       ${card.symbolId}`);
  lines.push(`  File:     ${card.file}`);
  if (card.exported) lines.push(`  Exported: true`);
  if (card.summary) lines.push(`  Summary:  ${card.summary}`);

  const deps = card.deps as Record<string, unknown[]> | undefined;
  if (deps) {
    if (deps.imports && Array.isArray(deps.imports) && deps.imports.length > 0) {
      lines.push(`  Imports:  ${deps.imports.join(", ")}`);
    }
    if (deps.calls && Array.isArray(deps.calls) && deps.calls.length > 0) {
      lines.push(`  Calls:    ${deps.calls.join(", ")}`);
    }
  }

  return lines.join("\n");
}

function prettySliceResult(obj: Record<string, unknown>): string {
  const cards = obj.cards as unknown[];
  const edges = obj.edges as unknown[];
  const lines: string[] = [];
  lines.push(`Slice built:`);
  lines.push(`  Cards: ${cards.length}`);
  lines.push(`  Edges: ${edges.length}`);

  const truncation = obj.truncation as Record<string, unknown> | undefined;
  if (truncation?.truncated) {
    lines.push(`  Truncated: yes (dropped ${truncation.droppedCards} cards, ${truncation.droppedEdges} edges)`);
  }

  if (obj.sliceHandle) {
    lines.push(`  Handle: ${obj.sliceHandle}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Generic table formatter
// ---------------------------------------------------------------------------

function formatTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "(no results)";

  // Get all unique keys from first few rows
  const keys = [...new Set(rows.slice(0, 5).flatMap((r) => Object.keys(r)))];
  if (keys.length === 0) return "(no columns)";

  // Limit to reasonable number of columns
  const displayKeys = keys.slice(0, 8);

  // Calculate column widths
  const widths = displayKeys.map((key) => {
    const values = rows.map((r) => {
      const v = r[key];
      if (v === undefined || v === null) return "";
      if (typeof v === "object") return JSON.stringify(v);
      return String(v);
    });
    return Math.min(60, Math.max(key.length, ...values.map((v) => v.length)));
  });

  const lines: string[] = [];

  // Header
  const header = displayKeys.map((k, i) => k.toUpperCase().padEnd(widths[i])).join("  ");
  lines.push(header);
  lines.push(widths.map((w) => "─".repeat(w)).join("  "));

  // Rows
  for (const row of rows) {
    const cells = displayKeys.map((k, i) => {
      const v = row[k];
      let s: string;
      if (v === undefined || v === null) s = "";
      else if (typeof v === "object") s = JSON.stringify(v);
      else s = String(v);
      const truncated = s.length > widths[i] && widths[i] > 3
        ? s.slice(0, widths[i] - 1) + "…"
        : s.slice(0, widths[i]);
      return truncated.padEnd(widths[i]);
    });
    lines.push(cells.join("  "));
  }

  return lines.join("\n");
}

/**
 * Write an error to stderr in a consistent format.
 */
export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `Error: ${error.message}`;
  }
  return `Error: ${String(error)}`;
}
