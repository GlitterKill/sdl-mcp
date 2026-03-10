import type { SearchSymbolLiteRow } from "../db/ladybug-queries.js";

export interface OverlaySearchResult extends SearchSymbolLiteRow {
  filePath: string;
  summary?: string | null;
  searchText?: string | null;
}

function filePenalty(filePath: string): number {
  if (
    filePath.includes("/adapter/") ||
    filePath.includes("/tests/") ||
    filePath.startsWith("tests/") ||
    filePath.startsWith("scripts/") ||
    filePath.includes(".test.") ||
    filePath.includes(".spec.")
  ) {
    return 2;
  }
  return 0;
}

function kindRank(kind: string): number {
  switch (kind) {
    case "class":
      return 0;
    case "function":
      return 1;
    case "interface":
      return 2;
    case "type":
      return 3;
    case "method":
      return 4;
    case "constructor":
      return 5;
    case "module":
      return 6;
    default:
      return 7;
  }
}

function searchRank(row: OverlaySearchResult, query: string): number[] {
  const loweredQuery = query.toLowerCase();
  const loweredName = row.name.toLowerCase();
  return [
    row.name === query ? 0 : 1,
    loweredName === loweredQuery ? 0 : 1,
    filePenalty(row.filePath),
    kindRank(row.kind),
    loweredName.includes(loweredQuery) ? 0 : 1,
  ];
}

function compareRank(a: number[], b: number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) {
      return left - right;
    }
  }
  return 0;
}

export function mergeSearchResults(
  durableRows: OverlaySearchResult[],
  overlayRows: OverlaySearchResult[],
  query: string,
  limit: number,
): OverlaySearchResult[] {
  const merged = new Map<string, OverlaySearchResult>();

  for (const row of durableRows) {
    merged.set(row.symbolId, row);
  }

  for (const row of overlayRows) {
    merged.set(row.symbolId, row);
  }

  return Array.from(merged.values())
    .sort((left, right) => {
      const rankCompare = compareRank(
        searchRank(left, query),
        searchRank(right, query),
      );
      if (rankCompare !== 0) {
        return rankCompare;
      }
      return left.name.localeCompare(right.name) || left.filePath.localeCompare(right.filePath);
    })
    .slice(0, limit);
}
