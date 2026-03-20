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

export function normalizeToolArguments(args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return args;
  }

  const normalized: Record<string, unknown> = {};
  const source = args as Record<string, unknown>;

  for (const [key, value] of Object.entries(source)) {
    const normalizedKey = normalizeKey(key);
    if (!(normalizedKey in normalized)) {
      normalized[normalizedKey] = value;
    }
  }

  return normalized;
}
