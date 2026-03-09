import { logger } from "./logger.js";

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
  // 1. Nested quantifiers after group closing paren: (a+)+, (a*)*,  (a+)*, etc.
  if (/\)[+*?{]/.test(pattern)) {
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
  // First, handle glob wildcards with placeholders to protect them
  // **/ must be handled before ** to avoid double-replacement
  let pattern = glob.replace(/\*\*\//g, "GLOB_DOUBLESTAR_SLASH");
  pattern = pattern.replace(/\*\*/g, "GLOB_DOUBLESTAR");
  pattern = pattern.replace(/\*/g, "GLOB_SINGLESTAR");

  // Now escape all regex metacharacters
  // Order matters: \ must be first
  pattern = pattern
    .replace(/\\/g, "\\\\") // backslash
    .replace(/\./g, "\\.") // dot
    .replace(/\+/g, "\\+") // plus
    .replace(/\?/g, "\\?") // question mark
    .replace(/\(/g, "\\(") // left paren
    .replace(/\)/g, "\\)") // right paren
    .replace(/\[/g, "\\[") // left bracket
    .replace(/\]/g, "\\]") // right bracket
    .replace(/\{/g, "\\{") // left brace
    .replace(/\}/g, "\\}") // right brace
    .replace(/\^/g, "\\^") // caret
    .replace(/\$/g, "\\$") // dollar
    .replace(/\|/g, "\\|"); // pipe

  // Replace placeholders with regex equivalents
  // **/ matches zero or more path segments (including the trailing /)
  pattern = pattern.replace(/GLOB_DOUBLESTAR_SLASH/g, "(?:.*/)?");
  // ** matches anything including /
  pattern = pattern.replace(/GLOB_DOUBLESTAR/g, ".*");
  // * matches anything except /
  pattern = pattern.replace(/GLOB_SINGLESTAR/g, "[^/]*");

  // Anchor the pattern
  return new RegExp(`^${pattern}$`);
}
