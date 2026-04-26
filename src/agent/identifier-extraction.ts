// =============================================================================
// agent/identifier-extraction.ts — Pure identifier-extraction helpers.
//
// Public exports:
//   - BEHAVIORAL_KINDS, MAX_IDENTIFIERS, IDENTIFIER_STOP_WORDS
//   - buildContextAwareStopWords(queryText)
//   - generateCompoundIdentifiers(text)
//   - extractIdentifiersFromText(text, queryContext?)
//
// Extracted from agent/executor.ts to lower per-file LLM cognitive load.
// All helpers are pure (no I/O, no class deps).
// =============================================================================
/** Injectable gate evaluator for testability. */

export const MAX_IDENTIFIERS = 10;

const ALWAYS_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "that",
  "this",
  "with",
  "from",
  "are",
  "was",
  "have",
  "has",
  "had",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "need",
  "use",
  "used",
  "using",
  "make",
  "find",
  "found",
  "look",
  "into",
  "what",
  "how",
  "why",
  "when",
  "where",
  "which",
  "new",
  "true",
  "false",
  "null",
]);

/**
 * Domain terms that are stop words only when the query is NOT about them.
 * When a query *is* about one of these subsystems (e.g., "slice cache strategy"),
 * the domain term is the most discriminating keyword and must not be filtered.
 *
 * These are conditionally filtered: a domain term is kept when the query
 * contains fewer than 3 non-stop content words *after* removing it, or when
 * the domain term appears alongside a qualifying noun/adjective
 * (heuristic: the query has other substantive words that form a concept
 * with the domain term).
 */
const DOMAIN_STOP_WORDS = new Set([
  "code",
  "file",
  "function",
  "class",
  "method",
  "implement",
  "fix",
  "bug",
  "error",
  "issue",
  "problem",
  "task",
  "work",
  "check",
  "symbol",
  "review",
  "analyze",
  "inspect",
  "debug",
  "explain",
  "context",
  "skeleton",
  "hotpath",
  "window",
  "slice",
  "rung",
  "return",
  "import",
  "export",
  "const",
  "let",
  "var",
  "type",
  "interface",
  "async",
  "await",
]);

/**
 * The full stop word set used by default (no query context).
 * Exported for backward compatibility with existing tests.
 */
export const IDENTIFIER_STOP_WORDS = new Set([
  ...ALWAYS_STOP_WORDS,
  ...DOMAIN_STOP_WORDS,
]);

/**
 * Build a context-aware stop word set. Domain terms that appear in the
 * query alongside other substantive words are preserved (not filtered).
 *
 * Heuristic: count non-stop content words in the query (words 3+ chars
 * not in ALWAYS_STOP_WORDS). If a domain term co-occurs with at least
 * 2 other content words, it is likely a subsystem reference and is kept.
 */
export function buildContextAwareStopWords(queryText: string): Set<string> {
  const words = queryText.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) ?? [];
  const contentWords = words.filter((w) => !ALWAYS_STOP_WORDS.has(w));
  const nonDomainContent = contentWords.filter(
    (w) => !DOMAIN_STOP_WORDS.has(w),
  );

  // Short queries (≤2 content words) or queries where domain terms
  // don't co-occur with enough non-domain content: filter all domain
  // terms as usual. Example: "find the code that does validation" has
  // only "code" (domain) + "validation" (non-domain) → "code" is filler.
  if (contentWords.length < 3 || nonDomainContent.length < 1) {
    return new Set(IDENTIFIER_STOP_WORDS);
  }

  // For compound conceptual queries (3+ content words with at least
  // 1 non-domain word), keep domain terms that appear in the query.
  // Example: "slice cache strategy eviction" → "slice" is kept because
  // it co-occurs with "cache", "strategy", "eviction" to form a concept.
  const queryWordSet = new Set(contentWords);
  const stopWords = new Set(ALWAYS_STOP_WORDS);
  for (const domainWord of DOMAIN_STOP_WORDS) {
    if (!queryWordSet.has(domainWord)) {
      stopWords.add(domainWord);
    }
  }
  return stopWords;
}

/**
 * Extract potential code identifiers from free text.
 * Exported for testability; the Executor class method delegates to this
 * plus evidence-based augmentation.
 *
 * @param text - The text to extract identifiers from.
 * @param queryContext - Optional original query text used to build
 *   context-aware stop words. When provided, domain terms that appear
 *   in the query are preserved instead of being filtered.
 */
/**
 * Generate compound identifiers from adjacent word tokens in text.
 * Produces camelCase, PascalCase, and snake_case variants from word pairs
 * and triples found in the text.
 *
 * Examples:
 *   "graph slice" → ["graphSlice", "GraphSlice", "graph_slice"]
 *   "barrel re exports" → ["barrelReExports", "BarrelReExports", "barrel_re_exports", "reExports", "ReExports"]
 */
/** Stop words for compound identifier generation. */
const COMPOUND_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "have",
  "are",
  "was",
  "not",
  "but",
  "has",
  "how",
  "does",
  "what",
  "when",
  "where",
  "which",
  "about",
  "into",
  "through",
  "during",
  "before",
  "after",
  "should",
  "would",
  "could",
  "being",
  "been",
  "will",
  "than",
  "also",
  "need",
  "understand",
  "investigate",
  "check",
  "look",
  "find",
]);

export function generateCompoundIdentifiers(text: string): string[] {
  // Extract plain words (3+ chars, no stop words)
  const words = (text.match(/[a-zA-Z]{3,}/g) ?? [])
    .map((w) => w.toLowerCase())
    .filter((w) => !COMPOUND_STOP_WORDS.has(w));

  if (words.length < 2) return [];

  const result: string[] = [];
  const seen = new Set<string>();

  const addUnique = (s: string): void => {
    if (s.length >= 4 && !seen.has(s)) {
      seen.add(s);
      result.push(s);
    }
  };

  const toCamel = (parts: string[]): string =>
    parts[0] +
    parts
      .slice(1)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join("");
  const toPascal = (parts: string[]): string =>
    parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
  const toSnake = (parts: string[]): string => parts.join("_");

  // Pairs
  for (let i = 0; i < words.length - 1 && result.length < 30; i++) {
    const pair = [words[i], words[i + 1]];
    addUnique(toCamel(pair));
    addUnique(toPascal(pair));
    addUnique(toSnake(pair));
  }

  // Triples (up to 5)
  for (let i = 0; i < words.length - 2 && result.length < 40; i++) {
    const triple = [words[i], words[i + 1], words[i + 2]];
    addUnique(toCamel(triple));
    addUnique(toPascal(triple));
  }

  return result;
}

export function extractIdentifiersFromText(
  text: string,
  queryContext?: string,
): string[] {
  const bounded = text.slice(0, 2000);
  const stopWords = queryContext
    ? buildContextAwareStopWords(queryContext)
    : IDENTIFIER_STOP_WORDS;

  // Specific code-identifier patterns (high priority)
  const camelCase = bounded.match(/[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*/g) ?? [];
  const pascalCase = bounded.match(/[A-Z][a-z]+[A-Z][a-zA-Z0-9]*/g) ?? [];
  const singlePascal = (
    bounded.match(/\b[A-Z][a-z]{5,}[a-zA-Z0-9]*\b/g) ?? []
  ).filter((w) => !stopWords.has(w.toLowerCase()));
  const snakeCase = bounded.match(/[a-zA-Z][a-zA-Z0-9]*_[a-zA-Z0-9_]+/g) ?? [];

  const primary = [
    ...new Set([...camelCase, ...pascalCase, ...singlePascal, ...snakeCase]),
  ];

  // Generic word tokens — for conceptual queries these are often the
  // most valuable terms (e.g., "cache", "eviction", "pipeline").
  const words = (bounded.match(/[a-zA-Z_][a-zA-Z0-9_]{2,}/g) ?? []).filter(
    (w) => !stopWords.has(w.toLowerCase()),
  );
  const primarySet = new Set(primary);
  const secondary = [...new Set(words)].filter((w) => !primarySet.has(w));

  // Generate compound identifiers from adjacent word pairs.
  // "graph slice" → "graphSlice", "graph_slice"
  // "barrel re-exports" → "barrelReExports", "barrel_re_exports", "reExport"
  const compounds = generateCompoundIdentifiers(bounded);
  const allSet = new Set([...primary, ...secondary]);
  const compoundsFiltered = compounds.filter((c) => !allSet.has(c));

  return [...primary, ...secondary, ...compoundsFiltered].slice(
    0,
    MAX_IDENTIFIERS,
  );
}
