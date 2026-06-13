import { Buffer } from "node:buffer";

export type SymbolStatus = "real" | "unresolved" | "external";

export interface SymbolPlaceholderMeta {
  symbolStatus: SymbolStatus;
  placeholderKind: string | null;
  placeholderTarget: string | null;
}

const LOCAL_IMPORT_PREFIXES = [
  "src/",
  "test/",
  "tests/",
  "scripts/",
  "examples/",
  "native/",
  "grammar-wrappers/",
  "docs/",
  "devdocs/",
  "config/",
  "dist/",
  "packages/",
  "app/",
  "lib/",
  "libs/",
  "components/",
  "utils/",
  "server/",
  "client/",
  "shared/",
];

const LOCAL_ALIAS_SCOPES = new Set([
  "@app",
  "@client",
  "@components",
  "@core",
  "@features",
  "@hooks",
  "@internal",
  "@lib",
  "@pages",
  "@repo",
  "@root",
  "@server",
  "@services",
  "@shared",
  "@stores",
  "@src",
  "@test",
  "@tests",
  "@types",
  "@ui",
  "@utils",
]);

const UNRESOLVED_CALL_PREFIX = "unresolved:call:";
const SAFE_UNRESOLVED_CALL_PREFIX = `${UNRESOLVED_CALL_PREFIX}__sdl_v1__`;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export function unresolvedCallSymbolId(targetName: string): string {
  const target = targetName.trim();
  if (!target) {
    return UNRESOLVED_CALL_PREFIX;
  }
  const encoded = Buffer.from(target, "utf8").toString("base64url");
  return `${SAFE_UNRESOLVED_CALL_PREFIX}${encoded}`;
}

export function isSafeUnresolvedCallSymbolId(symbolId: string): boolean {
  return symbolId.startsWith(SAFE_UNRESOLVED_CALL_PREFIX);
}

export function parseUnresolvedCallTarget(symbolId: string): string | null {
  if (!symbolId.startsWith(UNRESOLVED_CALL_PREFIX)) {
    return null;
  }

  if (symbolId.startsWith(SAFE_UNRESOLVED_CALL_PREFIX)) {
    const encoded = symbolId.slice(SAFE_UNRESOLVED_CALL_PREFIX.length);
    if (encoded && BASE64URL_RE.test(encoded)) {
      const decoded = Buffer.from(encoded, "base64url").toString("utf8").trim();
      if (decoded && unresolvedCallSymbolId(decoded) === symbolId) {
        return decoded;
      }
    }
  }

  const target = symbolId.slice(UNRESOLVED_CALL_PREFIX.length).trim();
  return target || null;
}

export function unresolvedCallDependencyTarget(
  target: string | null | undefined,
): SymbolPlaceholderMeta {
  return {
    symbolStatus: "unresolved",
    placeholderKind: "call",
    placeholderTarget: target?.trim() || null,
  };
}

/**
 * Classify dependency target IDs that are intentionally represented as Symbol
 * nodes even though they are not indexed code symbols.
 */
export function classifyDependencyTarget(symbolId: string): SymbolPlaceholderMeta {
  if (symbolId.startsWith("unresolved:call:")) {
    const target = parseUnresolvedCallTarget(symbolId);
    return {
      ...unresolvedCallDependencyTarget(target),
      placeholderTarget: target || symbolId,
    };
  }

  if (symbolId.startsWith("unresolved:")) {
    const parsed = parseUnresolvedImportTarget(symbolId);
    const rendered = parsed?.rendered ?? symbolId.slice("unresolved:".length);
    return isRepoLocalImportSpecifier(parsed?.specifier ?? "")
      ? unresolvedImportDependencyTarget(rendered)
      : externalImportDependencyTarget(rendered);
  }

  return {
    symbolStatus: "real",
    placeholderKind: null,
    placeholderTarget: null,
  };
}

export function unresolvedImportDependencyTarget(
  target: string | null | undefined,
): SymbolPlaceholderMeta {
  return {
    symbolStatus: "unresolved",
    placeholderKind: "import",
    placeholderTarget: target?.trim() || null,
  };
}

export function externalImportDependencyTarget(
  target: string | null | undefined,
): SymbolPlaceholderMeta {
  return {
    symbolStatus: "external",
    placeholderKind: "import",
    placeholderTarget: target?.trim() || null,
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

function parseUnresolvedImportTarget(
  symbolId: string,
): { specifier: string; name: string; rendered: string } | null {
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
    return namespaceName
      ? {
          specifier,
          name,
          rendered: `${namespaceName} (* from ${specifier})`,
        }
      : null;
  }

  return { specifier, name, rendered: `${name} (from ${specifier})` };
}

export function isRepoLocalImportSpecifier(specifier: string): boolean {
  if (!specifier) return false;
  const normalized = specifier.replace(/\\/g, "/");
  if (normalized.startsWith("./") || normalized.startsWith("../")) {
    return true;
  }
  if (normalized.startsWith("@/")) {
    return true;
  }
  if (normalized.startsWith("~/") || normalized.startsWith("#imports/")) {
    return true;
  }
  if (normalized.startsWith("@")) {
    const slashIndex = normalized.indexOf("/");
    const aliasScope =
      slashIndex === -1 ? normalized : normalized.slice(0, slashIndex);
    if (LOCAL_ALIAS_SCOPES.has(aliasScope)) {
      return true;
    }
  }
  if (
    normalized.startsWith("crate::") ||
    normalized.startsWith("self::") ||
    normalized.startsWith("super::")
  ) {
    return true;
  }
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith("/")) {
    return true;
  }

  if (LOCAL_IMPORT_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return true;
  }

  return false;
}
