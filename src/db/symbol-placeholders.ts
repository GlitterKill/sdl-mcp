export type SymbolStatus = "real" | "unresolved" | "external";

export interface SymbolPlaceholderMeta {
  symbolStatus: SymbolStatus;
  placeholderKind: string | null;
  placeholderTarget: string | null;
}

/**
 * Classify dependency target IDs that are intentionally represented as Symbol
 * nodes even though they are not indexed code symbols.
 */
export function classifyDependencyTarget(symbolId: string): SymbolPlaceholderMeta {
  if (symbolId.startsWith("unresolved:call:")) {
    const target = symbolId.slice("unresolved:call:".length).trim();
    return {
      symbolStatus: "unresolved",
      placeholderKind: "call",
      placeholderTarget: target || symbolId,
    };
  }

  if (symbolId.startsWith("unresolved:")) {
    const rendered = renderUnresolvedImportTarget(symbolId);
    return {
      symbolStatus: "unresolved",
      placeholderKind: "import",
      placeholderTarget: rendered ?? symbolId.slice("unresolved:".length),
    };
  }

  return {
    symbolStatus: "real",
    placeholderKind: null,
    placeholderTarget: null,
  };
}

export function externalDependencyTarget(
  target: string | null | undefined,
): SymbolPlaceholderMeta {
  return {
    symbolStatus: "external",
    placeholderKind: "scip",
    placeholderTarget: target?.trim() || null,
  };
}

function renderUnresolvedImportTarget(symbolId: string): string | null {
  const rest = symbolId.slice("unresolved:".length);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon <= 0 || lastColon === rest.length - 1) {
    return null;
  }

  const specifier = rest.slice(0, lastColon).trim();
  const name = rest.slice(lastColon + 1).trim();
  if (!specifier || !name) {
    return null;
  }

  if (name.startsWith("* as ")) {
    const namespaceName = name.slice(5).trim();
    return namespaceName ? `${namespaceName} (* from ${specifier})` : null;
  }

  return `${name} (from ${specifier})`;
}
