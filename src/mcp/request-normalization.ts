import { logger } from "../util/logger.js";
import { ValidationError } from "./errors.js";
import { shortIdRegistry, ShortIdRegistry } from "./short-id-registry.js";

const ID_ARRAY_FIELDS = new Set(["symbolIds", "entrySymbols", "focusSymbols"]);
const ID_MAP_FIELDS = new Set(["knownCardEtags", "knownEtags"]);

const FIELD_ALIASES: Record<string, string> = {
  repo: "repoId",
  repo_id: "repoId",
  project_path: "rootPath",
  root_path: "rootPath",
  symbol_id: "symbolId",
  symbol_ids: "symbolIds",
  from_version: "fromVersion",
  to_version: "toVersion",
  slice_handle: "sliceHandle",
  spillover_handle: "spilloverHandle",
  if_none_match: "ifNoneMatch",
  known_etags: "knownEtags",
  known_card_etags: "knownCardEtags",
  failing_test_path: "failingTestPath",
  edited_files: "editedFiles",
  entry_symbols: "entrySymbols",
  relative_cwd: "relativeCwd",
  identifiers: "identifiersToFind",
};

function toCamelCase(key: string): string {
  if (!key.includes("_")) {
    return key;
  }

  return key.replace(/_+([a-zA-Z0-9])/g, (_match, char: string) =>
    char.toUpperCase(),
  );
}

function normalizeKey(key: string): string {
  return FIELD_ALIASES[key] ?? toCamelCase(key);
}

export function normalizeToolArguments(args: unknown, sessionId?: string): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return args;
  }

  const normalized: Record<string, unknown> = {};
  const source = args as Record<string, unknown>;

  for (const [key, value] of Object.entries(source)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const normalizedKey = normalizeKey(key);
    if (!(normalizedKey in normalized)) {
      normalized[normalizedKey] = value;
    } else {
      logger.warn("Request key collision during normalization", {
        originalKey: key,
        normalizedKey,
        droppedValue: typeof value,
      });
    }
  }

  return resolveShortIdAliases(normalized, sessionId);
}

export function extractReferencedSymbolIds(args: Record<string, unknown>): string[] {
  const referenced = new Set<string>();
  collectReferencedSymbolIds(args, referenced);
  return [...referenced].sort();
}

export function resolveShortIdAliases(
  args: Record<string, unknown>,
  sessionId?: string,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = { ...args };
  for (const [key, value] of Object.entries(args)) {
    if (key === "symbolId" && typeof value === "string") {
      resolved[key] = resolveMaybeAlias(value, sessionId);
    } else if (ID_ARRAY_FIELDS.has(key) && Array.isArray(value)) {
      resolved[key] = value.map((item) =>
        typeof item === "string" ? resolveMaybeAlias(item, sessionId) : item,
      );
    } else if (ID_MAP_FIELDS.has(key) && isRecord(value)) {
      const mapped: Record<string, unknown> = {};
      for (const [id, etag] of Object.entries(value)) {
        mapped[resolveMaybeAlias(id, sessionId)] = etag;
      }
      resolved[key] = mapped;
    } else if (key === "options" && isRecord(value)) {
      resolved[key] = resolveShortIdAliases(value, sessionId);
    }
  }
  return resolved;
}

function collectReferencedSymbolIds(
  args: Record<string, unknown>,
  referenced: Set<string>,
): void {
  for (const [key, value] of Object.entries(args)) {
    if (key === "symbolId") {
      addReferencedSymbolId(value, referenced);
    } else if (ID_ARRAY_FIELDS.has(key) && Array.isArray(value)) {
      for (const item of value) addReferencedSymbolId(item, referenced);
    } else if (ID_MAP_FIELDS.has(key) && isRecord(value)) {
      for (const id of Object.keys(value)) addReferencedSymbolId(id, referenced);
    } else if (key === "options" && isRecord(value)) {
      collectReferencedSymbolIds(value, referenced);
    }
  }
}

function addReferencedSymbolId(value: unknown, referenced: Set<string>): void {
  if (typeof value === "string" && value.length > 0) {
    referenced.add(value);
  }
}

function resolveMaybeAlias(value: string, sessionId?: string): string {
  if (!ShortIdRegistry.looksLikeAlias(value)) return value;
  const resolved = sessionId ? shortIdRegistry.resolve(sessionId, value) : undefined;
  if (!resolved) {
    throw new ValidationError(
      `Unknown short id ${value} for this session. Re-run the producing call or use the full symbolId.`,
    );
  }
  return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
