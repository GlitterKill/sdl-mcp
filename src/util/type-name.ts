/**
 * Strip nested generic arguments from a type name without relying on
 * backtracking regular expressions.
 */
export function stripGenericArguments(typeName: string): string {
  let depth = 0;
  let result = "";

  for (const char of typeName) {
    if (char === "<") {
      depth++;
      continue;
    }

    if (char === ">") {
      if (depth > 0) {
        depth--;
        continue;
      }
    }

    if (depth === 0) {
      result += char;
    }
  }

  return result;
}

/**
 * Normalize a type name for summaries and resolver matching.
 * Removes generic payloads and trailing array suffixes while preserving
 * the outer type name.
 */
export function normalizeTypeName(typeName: string): string {
  let normalized = stripGenericArguments(typeName).trim();

  while (normalized.endsWith("[]")) {
    normalized = normalized.slice(0, -2).trim();
  }

  return normalized;
}
