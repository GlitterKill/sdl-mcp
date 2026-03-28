import type { SymbolKind } from "../../domain/types.js";
import type { SymbolRow } from "../../db/ladybug-queries.js";

export interface MappedSymbolResult {
  symbolId: string;
  strategy: string;
}

export function toFullKey(
  kind: SymbolKind,
  name: string,
  range: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  },
): string {
  return `${kind}:${name}:${range.startLine}:${range.startCol}:${range.endLine}:${range.endCol}`;
}

export function toStartKey(
  kind: SymbolKind,
  name: string,
  range: {
    startLine: number;
    startCol: number;
  },
): string {
  return `${kind}:${name}:${range.startLine}:${range.startCol}`;
}

export function toStartLineKey(
  kind: SymbolKind,
  name: string,
  range: {
    startLine: number;
  },
): string {
  return `${kind}:${name}:${range.startLine}`;
}

export function toNameKindKey(kind: SymbolKind, name: string): string {
  return `${kind}:${name}`;
}

export interface SymbolKeyMaps {
  symbolIdByFullKey: Map<string, string>;
  symbolsByStartKey: Map<string, SymbolRow[]>;
  symbolsByStartLineKey: Map<string, SymbolRow[]>;
  symbolsByNameKindKey: Map<string, SymbolRow[]>;
}

export function buildSymbolKeyMaps(
  existingSymbols: SymbolRow[],
): SymbolKeyMaps {
  const symbolIdByFullKey = new Map<string, string>();
  const symbolsByStartKey = new Map<string, SymbolRow[]>();
  const symbolsByStartLineKey = new Map<string, SymbolRow[]>();
  const symbolsByNameKindKey = new Map<string, SymbolRow[]>();

  const pushSymbol = (
    map: Map<string, SymbolRow[]>,
    key: string,
    symbol: SymbolRow,
  ): void => {
    const existing = map.get(key) ?? [];
    existing.push(symbol);
    map.set(key, existing);
  };

  for (const symbol of existingSymbols) {
    const range = {
      startLine: symbol.rangeStartLine,
      startCol: symbol.rangeStartCol,
      endLine: symbol.rangeEndLine,
      endCol: symbol.rangeEndCol,
    };

    symbolIdByFullKey.set(
      toFullKey(symbol.kind as SymbolKind, symbol.name, range),
      symbol.symbolId,
    );
    pushSymbol(
      symbolsByStartKey,
      toStartKey(symbol.kind as SymbolKind, symbol.name, range),
      symbol,
    );
    pushSymbol(
      symbolsByStartLineKey,
      toStartLineKey(symbol.kind as SymbolKind, symbol.name, range),
      symbol,
    );
    pushSymbol(
      symbolsByNameKindKey,
      toNameKindKey(symbol.kind as SymbolKind, symbol.name),
      symbol,
    );
  }

  return {
    symbolIdByFullKey,
    symbolsByStartKey,
    symbolsByStartLineKey,
    symbolsByNameKindKey,
  };
}

export function mapExtractedSymbolId(
  extractedSymbol: {
    kind: SymbolKind;
    name: string;
    range: {
      startLine: number;
      startCol: number;
      endLine: number;
      endCol: number;
    };
  },
  maps: SymbolKeyMaps,
): MappedSymbolResult | null {
  const fullMatch = maps.symbolIdByFullKey.get(
    toFullKey(
      extractedSymbol.kind,
      extractedSymbol.name,
      extractedSymbol.range,
    ),
  );
  if (fullMatch) {
    return { symbolId: fullMatch, strategy: "full_range" };
  }

  const startCandidates = maps.symbolsByStartKey.get(
    toStartKey(
      extractedSymbol.kind,
      extractedSymbol.name,
      extractedSymbol.range,
    ),
  );
  if (startCandidates && startCandidates.length === 1) {
    return {
      symbolId: startCandidates[0].symbolId,
      strategy: "start_only",
    };
  }

  const startLineCandidates = maps.symbolsByStartLineKey.get(
    toStartLineKey(
      extractedSymbol.kind,
      extractedSymbol.name,
      extractedSymbol.range,
    ),
  );
  if (startLineCandidates && startLineCandidates.length === 1) {
    return {
      symbolId: startLineCandidates[0].symbolId,
      strategy: "start_line",
    };
  }

  const nameKindCandidates = maps.symbolsByNameKindKey.get(
    toNameKindKey(extractedSymbol.kind, extractedSymbol.name),
  );
  if (nameKindCandidates && nameKindCandidates.length === 1) {
    return {
      symbolId: nameKindCandidates[0].symbolId,
      strategy: "name_kind_unique",
    };
  }

  return null;
}
