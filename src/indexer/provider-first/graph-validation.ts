import type { ProviderFirstGraphRows } from "./materializer.js";

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
    if (
      !symbolIds.has(edge.fromSymbolId) ||
      !symbolIds.has(edge.toSymbolId)
    ) {
      fail(
        `${context} edge ${edge.fromSymbolId} -> ${edge.toSymbolId} has a missing endpoint`,
      );
    }
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
