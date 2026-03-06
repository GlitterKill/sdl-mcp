interface SignatureParamLike {
  name?: string | null;
}

interface SignatureLike {
  params?: Array<SignatureParamLike | null> | null;
}

interface ResolveSymbolEnrichmentParams {
  kind: string;
  name: string;
  relPath: string;
  summary: string | null;
  signature?: SignatureLike | null;
  nativeRoleTagsJson?: string | null;
  nativeSearchText?: string | null;
}

interface BuildSearchTextParams {
  kind: string;
  name: string;
  relPath: string;
  summary: string | null;
  signature?: SignatureLike | null;
  roleTags: string[];
}

export function resolveSymbolEnrichment(
  params: ResolveSymbolEnrichmentParams,
): {
  roleTags: string[];
  roleTagsJson: string | null;
  searchText: string;
} {
  const nativeRoleTags = parseStringArrayJson(params.nativeRoleTagsJson);
  const roleTags =
    nativeRoleTags.length > 0
      ? nativeRoleTags
      : extractRoleTags(params.kind, params.name, params.relPath);

  return {
    roleTags,
    roleTagsJson: roleTags.length > 0 ? JSON.stringify(roleTags) : null,
    searchText:
      typeof params.nativeSearchText === "string" &&
      params.nativeSearchText.trim().length > 0
        ? params.nativeSearchText.trim()
        : buildSearchText({
            kind: params.kind,
            name: params.name,
            relPath: params.relPath,
            summary: params.summary,
            signature: params.signature,
            roleTags,
          }),
  };
}

export function extractRoleTags(
  kind: string,
  name: string,
  relPath: string,
): string[] {
  const normalizedName = name.toLowerCase();
  const normalizedPath = relPath.replace(/\\/g, "/").toLowerCase();
  const nameTokens = splitIdentifierLikeText(name).map((part) => part.toLowerCase());
  const pathTokens = splitPathTokens(relPath).map((part) => part.toLowerCase());
  const tags: string[] = [];

  if (
    normalizedName.includes("handler") ||
    normalizedPath.includes("/handler") ||
    normalizedPath.includes("/api/")
  ) {
    tags.push("handler");
  }

  if (
    normalizedName.includes("controller") ||
    normalizedPath.includes("/controller")
  ) {
    tags.push("controller");
  }

  if (
    normalizedName.endsWith("service") ||
    normalizedPath.includes("/service")
  ) {
    tags.push("service");
  }

  if (
    nameTokens.includes("repo") ||
    nameTokens.includes("repository") ||
    pathTokens.includes("repo") ||
    pathTokens.includes("repository")
  ) {
    tags.push("repo");
  }

  if (normalizedName.includes("model") || normalizedPath.includes("/model")) {
    tags.push("model");
  }

  if (
    normalizedName.includes("middleware") ||
    normalizedPath.includes("/middleware/")
  ) {
    tags.push("middleware");
  }

  if (
    normalizedPath.startsWith("tests/") ||
    normalizedPath.includes("/tests/") ||
    normalizedPath.includes(".test.") ||
    normalizedPath.includes(".spec.")
  ) {
    tags.push("test");
  }

  if (
    pathTokens.includes("config") ||
    pathTokens.includes("settings") ||
    hasTaggedFileSuffix(normalizedPath, "config") ||
    hasTaggedFileSuffix(normalizedPath, "settings") ||
    nameTokens.includes("config") ||
    nameTokens.includes("settings")
  ) {
    tags.push("config");
  }

  if (
    kind === "function" &&
    (normalizedName === "main" ||
      normalizedName === "start" ||
      normalizedName === "bootstrap" ||
      normalizedName === "boot" ||
      normalizedName.startsWith("handle") ||
      normalizedName.startsWith("on"))
  ) {
    tags.push("entrypoint");
  }

  if (
    hasTaggedFileSuffix(normalizedPath, "main") ||
    hasTaggedFileSuffix(normalizedPath, "index") ||
    normalizedPath.includes("/cli/")
  ) {
    tags.push("entrypoint");
  }

  return Array.from(new Set(tags));
}

export function buildSearchText(params: BuildSearchTextParams): string {
  const parts = [
    params.name,
    ...splitIdentifierLikeText(params.name),
    params.summary?.trim() ?? "",
    ...splitIdentifierLikeText(params.summary ?? ""),
    params.kind,
    ...params.roleTags,
    ...splitPathTokens(params.relPath),
    ...extractSignatureTerms(params.signature),
  ];

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const part of parts) {
    const token = part.trim().toLowerCase();
    if (token.length === 0 || seen.has(token)) {
      continue;
    }
    seen.add(token);
    normalized.push(token);
  }

  return normalized.join(" ");
}

function splitIdentifierLikeText(input: string): string[] {
  const result: string[] = [];
  let current = "";
  const chars = Array.from(input);

  for (let index = 0; index < chars.length; index++) {
    const char = chars[index] ?? "";
    if (isAsciiAlphaNumeric(char)) {
      const previous = index > 0 ? chars[index - 1] ?? "" : "";
      const next = index + 1 < chars.length ? chars[index + 1] ?? "" : "";
      const boundary =
        index > 0 &&
        isAsciiUpper(char) &&
        (!isAsciiUpper(previous) || isAsciiLower(next));

      if (boundary && current.length > 0) {
        result.push(current);
        current = "";
      }

      current += char;
      continue;
    }

    if (current.length > 0) {
      result.push(current);
      current = "";
    }
  }

  if (current.length > 0) {
    result.push(current);
  }

  return result;
}

function splitPathTokens(relPath: string): string[] {
  return relPath
    .replace(/\\/g, "/")
    .split(/[\/._-]+/)
    .filter((part) => part.length > 0);
}

function hasTaggedFileSuffix(
  normalizedPath: string,
  basename: "config" | "index" | "main" | "settings",
): boolean {
  return [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".mts",
    ".cts",
    ".rs",
  ].some((extension) => normalizedPath.endsWith(`/${basename}${extension}`));
}

function extractSignatureTerms(signature?: SignatureLike | null): string[] {
  if (!signature?.params || !Array.isArray(signature.params)) {
    return [];
  }

  const terms: string[] = [];
  for (const param of signature.params) {
    if (!param?.name || typeof param.name !== "string") {
      continue;
    }
    terms.push(param.name);
    terms.push(...splitIdentifierLikeText(param.name));
  }

  return terms;
}

function parseStringArrayJson(raw: string | null | undefined): string[] {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function isAsciiAlphaNumeric(value: string): boolean {
  return /^[A-Za-z0-9]$/.test(value);
}

function isAsciiLower(value: string): boolean {
  return /^[a-z]$/.test(value);
}

function isAsciiUpper(value: string): boolean {
  return /^[A-Z]$/.test(value);
}
