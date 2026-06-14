import type { ProviderFirstGraphRows } from "./materializer.js";

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

export interface ValidateProviderFirstGraphRowsOptions {
  repoId?: string;
  context?: string;
}

export class ProviderFirstGraphValidationError extends Error {
  override name = "ProviderFirstGraphValidationError";
}

/**
 * Validate provider graph rows before any writer sees them. COPY-based shadow
 * builds fail on duplicate primary keys, while live MERGE writers dedupe some
 * rows implicitly; keeping this gate shared prevents shadow/live drift.
 */
export function validateProviderFirstGraphRows(
  rows: ProviderFirstGraphRows,
  options: ValidateProviderFirstGraphRowsOptions = {},
): void {
  const context = options.context ?? "Provider-first graph";
  const expectedRepoId = options.repoId ?? firstRepoId(rows);
  if (!expectedRepoId) {
    fail(`${context} requires at least one repo-scoped row`);
  }

  const fileIds = new Set<string>();
  for (const file of rows.files) {
    assertRepoId(context, expectedRepoId, "File", file.fileId, file.repoId);
    assertUnique(context, fileIds, "File primary key", file.fileId);
    if (!SHA256_HEX_PATTERN.test(file.contentHash)) {
      fail(
        `${context} file ${file.relPath} has missing or invalid raw SHA-256 contentHash`,
      );
    }
    if (!Number.isSafeInteger(file.byteSize) || file.byteSize < 0) {
      fail(
        `${context} file ${file.relPath} has missing or invalid byteSize ${String(file.byteSize)}`,
      );
    }
  }

  const symbolIds = new Set<string>();
  for (const symbol of rows.symbols) {
    assertRepoId(
      context,
      expectedRepoId,
      "Symbol",
      symbol.symbolId,
      symbol.repoId,
    );
    assertUnique(context, symbolIds, "Symbol primary key", symbol.symbolId);
    if (!fileIds.has(symbol.fileId)) {
      fail(
        `${context} symbol ${symbol.symbolId} references missing file ${symbol.fileId}`,
      );
    }
    const range = {
      startLine: symbol.rangeStartLine,
      startCol: symbol.rangeStartCol,
      endLine: symbol.rangeEndLine,
      endCol: symbol.rangeEndCol,
    };
    if ((symbol.symbolStatus ?? "real") === "real") {
      assertSensibleRange(context, symbol.symbolId, range);
    } else {
      assertNonRealRange(context, symbol.symbolId, range);
    }
  }

  for (const symbol of rows.externalSymbols) {
    assertRepoId(
      context,
      expectedRepoId,
      "ExternalSymbol",
      symbol.symbolId,
      symbol.repoId,
    );
    assertUnique(context, symbolIds, "Symbol primary key", symbol.symbolId);
  }

  const edgeKeys = new Set<string>();
  for (const edge of rows.edges) {
    assertRepoId(
      context,
      expectedRepoId,
      "DEPENDS_ON",
      `${edge.fromSymbolId} -> ${edge.toSymbolId}`,
      edge.repoId,
    );
    if (!symbolIds.has(edge.fromSymbolId) || !symbolIds.has(edge.toSymbolId)) {
      fail(
        `${context} edge ${edge.fromSymbolId} -> ${edge.toSymbolId} has a missing endpoint`,
      );
    }
    assertProviderCallEdgeProof(context, edge);
    assertUnique(
      context,
      edgeKeys,
      "DEPENDS_ON relationship",
      relationshipKey([
        edge.fromSymbolId,
        edge.toSymbolId,
        edge.edgeType,
        edge.resolverId ?? "",
      ]),
    );
  }
}

function assertSensibleRange(
  context: string,
  symbolId: string,
  range: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  },
): void {
  for (const [label, value] of Object.entries(range)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail(
        `${context} symbol ${symbolId} has invalid range ${label}=${String(value)}`,
      );
    }
  }
  if (range.startLine < 1 || range.endLine < 1) {
    fail(
      `${context} symbol ${symbolId} has invalid 1-based line range ${range.startLine}:${range.startCol}-${range.endLine}:${range.endCol}`,
    );
  }
  if (
    range.endLine < range.startLine ||
    (range.endLine === range.startLine && range.endCol < range.startCol)
  ) {
    fail(
      `${context} symbol ${symbolId} has non-sensical range ${range.startLine}:${range.startCol}-${range.endLine}:${range.endCol}`,
    );
  }
}

function assertNonRealRange(
  context: string,
  symbolId: string,
  range: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  },
): void {
  for (const [label, value] of Object.entries(range)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail(
        `${context} non-real symbol ${symbolId} has invalid range ${label}=${String(value)}`,
      );
    }
  }
  if (
    range.endLine < range.startLine ||
    (range.endLine === range.startLine && range.endCol < range.startCol)
  ) {
    fail(
      `${context} non-real symbol ${symbolId} has non-sensical range ${range.startLine}:${range.startCol}-${range.endLine}:${range.endCol}`,
    );
  }
}

function assertProviderCallEdgeProof(
  context: string,
  edge: ProviderFirstGraphRows["edges"][number],
): void {
  if (edge.edgeType !== "call") return;
  if (!edge.resolverId?.startsWith("provider-first:")) return;
  if (edge.resolution !== "exact" || edge.confidence <= 0) {
    fail(
      `${context} provider call edge ${edge.fromSymbolId} -> ${edge.toSymbolId} is not exact source-proofed`,
    );
  }
  if (!edge.provenance) {
    fail(
      `${context} provider call edge ${edge.fromSymbolId} -> ${edge.toSymbolId} is missing provenance`,
    );
  }
  try {
    const parsed = JSON.parse(edge.provenance) as { dedupeKey?: unknown };
    if (typeof parsed.dedupeKey !== "string" || parsed.dedupeKey.length === 0) {
      fail(
        `${context} provider call edge ${edge.fromSymbolId} -> ${edge.toSymbolId} is missing call-proof dedupeKey provenance`,
      );
    }
  } catch (error) {
    if (error instanceof ProviderFirstGraphValidationError) throw error;
    fail(
      `${context} provider call edge ${edge.fromSymbolId} -> ${edge.toSymbolId} has invalid provenance JSON`,
    );
  }
}

function firstRepoId(rows: ProviderFirstGraphRows): string | undefined {
  return (
    rows.files[0]?.repoId ??
    rows.symbols[0]?.repoId ??
    rows.externalSymbols[0]?.repoId ??
    rows.edges[0]?.repoId
  );
}

function assertRepoId(
  context: string,
  expectedRepoId: string,
  rowKind: string,
  rowId: string,
  actualRepoId: string,
): void {
  if (actualRepoId !== expectedRepoId) {
    fail(
      `${context} cross-repo ${rowKind} row ${rowId}: expected repo ${expectedRepoId}, got ${actualRepoId}`,
    );
  }
}

function assertUnique(
  context: string,
  seen: Set<string>,
  label: string,
  key: string,
): void {
  if (seen.has(key)) {
    fail(`${context} duplicate ${label} ${key}`);
  }
  seen.add(key);
}

function fail(message: string): never {
  throw new ProviderFirstGraphValidationError(message);
}

function relationshipKey(parts: readonly string[]): string {
  return parts.join("\u0000");
}
