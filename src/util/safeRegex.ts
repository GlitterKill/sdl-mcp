import { ConfigError } from "../domain/errors.js";
import { logger } from "./logger.js";
import { normalizePath } from "./paths.js";

/**
 * Detects if a regex pattern has ReDoS (Regular Expression Denial of Service) risks.
 * Checks for:
 * - Nested quantifiers: (a+)+, (a*)*,  (a+)*, etc.
 * - Overlapping alternation: (a|a)*
 *
 * @param pattern - The regex pattern string to check
 * @returns true if pattern has ReDoS risk, false otherwise
 */
export function isReDoSRisk(pattern: string): boolean {
  // 1. Nested quantifiers: (a+)+, (a*)*  — require a quantifier inside the group
  if (/\([^)]*[+*]\)[+*{]/.test(pattern)) {
    return true;
  }

  // 2. Nested quantifiers without group: a{1,}+  or  [abc]+{2,}
  //    Catches patterns like \w+\w+, \d+\d+  (adjacent quantified terms
  //    matching overlapping character sets).
  if (/[+*}]\s*[+*{]/.test(pattern)) {
    return true;
  }

  // 3. Quantified character classes followed by quantifier: [a-z]+[a-z]+
  if (/\][+*?{][^)]*\][+*?{]/.test(pattern)) {
    return true;
  }

  // 4. Star/plus height > 1 within groups: (.+)+ or (.*)+
  //    Catches nested quantifier even when there's content between
  if (/\([^)]*[+*][^)]*\)[+*?{]/.test(pattern)) {
    return true;
  }

  // 5. Overlapping alternation with quantifier: (a|a)* or similar
  if (/\([^)]*\|[^)]*\)[*+]/.test(pattern)) {
    const altMatch = pattern.match(/\(([^)]*)\|([^)]*)\)[*+]/);
    if (altMatch) {
      const left = altMatch[1].trim();
      const right = altMatch[2].trim();
      if (left === right) {
        return true;
      }
    }
  }

  // 6. Alternation with overlapping character classes under quantifier
  //    e.g., (\w|\d)+ where \w includes all \d characters.
  //    This is a heuristic enhancement and not exhaustive.
  if (/\([^)]*\\[wWdDsS][^)]*\|[^)]*\\[wWdDsS][^)]*\)[+*{]/.test(pattern)) {
    return true;
  }

  return false;
}

/**
 * Safely compiles a regex pattern with ReDoS protection.
 * Returns null if the pattern is detected as unsafe or has invalid syntax.
 *
 * @param pattern - The regex pattern string
 * @param flags - Optional regex flags (e.g., "i", "g", "m")
 * @returns RegExp object if safe, null if unsafe or invalid
 */
export function safeCompileRegex(
  pattern: string,
  flags?: string,
): RegExp | null {
  // Check for ReDoS risk
  if (isReDoSRisk(pattern)) {
    logger.warn(`ReDoS risk detected in pattern: ${pattern}`);
    return null;
  }

  // Try to compile the regex
  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    logger.warn(`Invalid regex pattern: ${pattern}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

type SafeClassToken = {
  value: string;
  escaped: boolean;
};

type CompiledSafeClass = {
  source: string;
  nextIndex: number;
};

type AsciiRangeKind = "digit" | "upper" | "lower";

function escapeRegexLiteral(value: string): string {
  return value.replace(
    /[.*+?^$()|[\]{}\\]/g,
    (match) => "\\" + match,
  );
}

function escapeRegexClassMember(value: string): string {
  if (value === "\\" || value === "]" || value === "-" || value === "^") {
    return "\\" + value;
  }
  return value;
}

function findUnescapedClassEnd(glob: string, startIndex: number): number {
  let escaped = false;
  for (let index = startIndex + 1; index < glob.length; index++) {
    const value = glob[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (value === "\\") {
      escaped = true;
      continue;
    }
    if (value === "]") {
      return index;
    }
  }
  return -1;
}

function asciiRangeKind(value: string): AsciiRangeKind | null {
  const code = value.charCodeAt(0);
  if (value.length !== 1) return null;
  if (code >= 48 && code <= 57) return "digit";
  if (code >= 65 && code <= 90) return "upper";
  if (code >= 97 && code <= 122) return "lower";
  return null;
}

function invalidClass(glob: string, startIndex: number, reason: string): never {
  throw new ConfigError(
    "Invalid ignore glob bracket class at index " +
      startIndex +
      ' in "' +
      glob +
      '": ' +
      reason,
  );
}

function compileSafeBracketClass(
  glob: string,
  startIndex: number,
): CompiledSafeClass | null {
  const endIndex = findUnescapedClassEnd(glob, startIndex);
  if (endIndex === -1) return null;

  const body = glob.slice(startIndex + 1, endIndex);
  if (body.length === 0) {
    invalidClass(glob, startIndex, "class has no members");
  }
  if (body[0] === "!" || body[0] === "^") {
    invalidClass(glob, startIndex, "class negation is unsupported");
  }

  const bodyCodePoints = Array.from(body);
  const tokens: SafeClassToken[] = [];
  for (let index = 0; index < bodyCodePoints.length; index++) {
    const value = bodyCodePoints[index];
    if (value === "[") {
      invalidClass(glob, startIndex, "nested opening bracket is unsupported");
    }
    if (value !== "\\") {
      tokens.push({ value, escaped: false });
      continue;
    }

    const escaped = bodyCodePoints[index + 1];
    if (escaped !== "]" && escaped !== "-" && escaped !== "\\") {
      invalidClass(
        glob,
        startIndex,
        "unsupported escape; only \\], \\-, and \\\\ are allowed",
      );
    }
    tokens.push({ value: escaped, escaped: true });
    index++;
  }

  // Validate ranges ourselves so RegExp never receives an ambiguous hyphen.
  const rangeEndpoints = new Set<number>();
  const pieces: string[] = [];
  for (let index = 1; index < tokens.length - 1; index++) {
    const token = tokens[index];
    if (token.value !== "-" || token.escaped) continue;

    const left = tokens[index - 1];
    const right = tokens[index + 1];
    if (rangeEndpoints.has(index - 1) || rangeEndpoints.has(index + 1)) {
      invalidClass(glob, startIndex, "range endpoints cannot be reused");
    }
    const leftKind = asciiRangeKind(left.value);
    const rightKind = asciiRangeKind(right.value);
    if (leftKind === null || rightKind === null) {
      invalidClass(
        glob,
        startIndex,
        "range endpoints must be ASCII letters or digits",
      );
    }
    if (leftKind !== rightKind) {
      invalidClass(
        glob,
        startIndex,
        "range endpoints must use the same ASCII category and case",
      );
    }
    if (left.value.charCodeAt(0) > right.value.charCodeAt(0)) {
      invalidClass(glob, startIndex, "range is reversed");
    }

    pieces.push(left.value + "-" + right.value);
    rangeEndpoints.add(index - 1);
    rangeEndpoints.add(index + 1);
  }

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.value === "-" && !token.escaped) {
      if (index === 0 || index === tokens.length - 1) {
        pieces.push("\\-");
      }
      continue;
    }
    if (!rangeEndpoints.has(index)) {
      pieces.push(escapeRegexClassMember(token.value));
    }
  }

  return {
    source: "[" + pieces.join("") + "]",
    nextIndex: endIndex + 1,
  };
}

function normalizeGlobPreservingClasses(glob: string) {
  const classes: string[] = [];
  let sentinel = "\u{E000}";
  while (glob.includes(sentinel)) sentinel += "\u{E000}";
  const literalOpenMarker = sentinel + "open" + sentinel;
  let masked = "";

  // Mask class substrings so normalizePath only consumes ordinary separators.
  for (let index = 0; index < glob.length; ) {
    if (glob[index] === "[") {
      const endIndex = findUnescapedClassEnd(glob, index);
      if (endIndex !== -1) {
        const marker = sentinel + classes.length + sentinel;
        classes.push(glob.slice(index, endIndex + 1));
        masked += marker;
        index = endIndex + 1;
        continue;
      }
      masked += literalOpenMarker;
      index++;
      continue;
    }
    const value = String.fromCodePoint(glob.codePointAt(index)!);
    masked += value;
    index += value.length;
  }

  let normalized = normalizePath(masked);
  for (let index = 0; index < classes.length; index++) {
    normalized = normalized.replaceAll(
      sentinel + index + sentinel,
      classes[index],
    );
  }
  return { normalizedGlob: normalized, literalOpenMarker };
}

function compileGlobBody(glob: string, literalOpenMarker: string): string {
  const source: string[] = [];
  let currentSegmentHasWildcard = false;

  for (let index = 0; index < glob.length; ) {
    const value = glob[index];

    if (glob.startsWith(literalOpenMarker, index)) {
      source.push("\\[");
      index += literalOpenMarker.length;
      continue;
    }

    if (value === "[") {
      const compiledClass = compileSafeBracketClass(glob, index);
      if (compiledClass !== null) {
        source.push(compiledClass.source);
        currentSegmentHasWildcard = true;
        index = compiledClass.nextIndex;
        continue;
      }
      source.push("\\[");
      index++;
      continue;
    }

    if (
      glob.startsWith("**/", index) ||
      glob.startsWith("**\\", index)
    ) {
      source.push("(?:.*/|)");
      currentSegmentHasWildcard = false;
      index += 3;
      continue;
    }

    if (
      (value === "/" || value === "\\") &&
      glob.startsWith("**", index + 1) &&
      index + 3 === glob.length
    ) {
      source.push(
        currentSegmentHasWildcard ? "(?:/.*)" : "(?:/.*|)",
      );
      index += 3;
      continue;
    }

    if (glob.startsWith("**", index)) {
      source.push(".*");
      currentSegmentHasWildcard = true;
      index += 2;
      continue;
    }

    if (value === "*") {
      source.push("[^/]*");
      currentSegmentHasWildcard = true;
      index++;
      continue;
    }

    if (value === "/" || value === "\\") {
      source.push("/");
      currentSegmentHasWildcard = false;
      index++;
      continue;
    }

    const codePoint = String.fromCodePoint(glob.codePointAt(index)!);
    source.push(escapeRegexLiteral(codePoint));
    index += codePoint.length;
  }

  return source.join("");
}

/**
 * Converts a glob pattern to a safe regex.
 * Handles:
 * - Single-segment wildcards: * matches anything except /
 * - Multi-segment wildcards: ** matches anything including /
 * - Proper escaping of regex metacharacters
 *
 * @param glob - The glob pattern (e.g., "src/*.ts", "src/**\/*.ts")
 * @returns RegExp object anchored with ^ and $
 */
export function globToSafeRegex(glob: string): RegExp {
  // Guard raw input before parsing or normalization can reduce its complexity.
  const doubleStarCount = (glob.match(/\*\*/g) || []).length;
  if (doubleStarCount > 5 || glob.length > 500) {
    logger.warn("Overly complex glob pattern rejected: " + glob);
    const normalizedLiteral = normalizePath(glob);
    return new RegExp(
      "^" + escapeRegexLiteral(normalizedLiteral) + "$",
      "u",
    );
  }

  const { normalizedGlob, literalOpenMarker } =
    normalizeGlobPreservingClasses(glob);
  return new RegExp(
    "^" + compileGlobBody(normalizedGlob, literalOpenMarker) + "$",
    "u",
  );
}
