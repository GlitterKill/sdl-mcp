/**
 * Pure helpers for computing string relevance between symbol names and queries.
 *
 * Extracted from `src/mcp/tools/symbol.ts` so that `src/util/resolve-symbol-ref.ts`
 * can use these helpers without creating an import cycle through the MCP tool layer.
 */

/**
 * Split a camelCase/PascalCase/snake_case identifier into lowercase subwords.
 * Handles digit-embedded acronyms (E2E, B2B), uppercase runs, and digits.
 * Exported for testability.
 */
export function splitCamelSubwords(s: string): string[] {
  const words = s.match(
    /[A-Z]+\d+[A-Z]+(?=[A-Z][a-z]|[^a-zA-Z0-9]|$)|[A-Z]{2,}(?=[A-Z][a-z]|$)|[A-Z]?[a-z]+|[A-Z]+|\d+/g,
  );
  return (words ?? [s])
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 2);
}

/**
 * Compute trigram (3-character subsequence) similarity between two strings.
 * Returns a value between 0 and 1.
 */
function trigramSimilarity(a: string, b: string): number {
  if (a.length < 3 || b.length < 3) return 0;
  const trigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i <= s.length - 3; i++) {
      set.add(s.substring(i, i + 3));
    }
    return set;
  };
  const tA = trigrams(a);
  const tB = trigrams(b);
  let intersection = 0;
  for (const t of tA) {
    if (tB.has(t)) intersection++;
  }
  const union = tA.size + tB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Compute a relevance score (0-1) for how well a result name matches the query.
 * Used to filter out spurious fuzzy matches.
 *
 * Scoring tiers (highest match wins):
 *  1.0  - exact match (case-insensitive)
 *  0.9  - glob wildcard full match
 *  0.85 - prefix match
 *  0.75 - glob wildcard partial match
 *  0.7  - substring match
 *  0.8  - all camelCase subwords match
 *  0.15-0.6 - partial camelCase subword match (scaled by ratio + trigram boost)
 *  0.05 - no meaningful match
 *
 * Exported for testability.
 */
export function computeRelevance(name: string, query: string): number {
  const nl = name.toLowerCase();
  const ql = query.toLowerCase();
  if (nl === ql) return 1;
  // Support glob wildcards: build*Slice matches buildSlice, buildGraphSlice
  if (ql.includes("*") || ql.includes("?")) {
    const escaped = ql.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const pattern = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
    try {
      if (new RegExp("^" + pattern + "$", "i").test(nl)) return 0.9;
      if (new RegExp(pattern, "i").test(nl)) return 0.75;
    } catch {
      /* invalid pattern, fall through */
    }
  }
  if (nl.startsWith(ql)) return 0.85;
  if (nl.includes(ql)) return 0.7;
  // Query starts with name (e.g., query "evaluatePolicy" starts with name "evaluate")
  if (ql.startsWith(nl) && nl.length >= 3) return 0.65;
  // CamelCase-aware: split both query and name into constituent subwords
  const queryParts = splitCamelSubwords(query);
  const nameParts = splitCamelSubwords(name);
  if (queryParts.length >= 2 && nameParts.length >= 2) {
    const matchCount = queryParts.filter((qp) =>
      nameParts.some((np) => np.includes(qp) || qp.includes(np)),
    ).length;
    const ratio = matchCount / queryParts.length;
    if (matchCount === queryParts.length) return 0.8;
    // Also check reverse: if ALL nameParts appear in queryParts (name is a subset of query)
    // e.g. query "buildGraphSlice" -> [build,graph,slice], name "buildSlice" -> [build,slice]
    // nameMatchCount = 2/2 = 1.0 -> score 0.7
    const nameMatchCount = nameParts.filter((np) =>
      queryParts.some((qp) => qp.includes(np) || np.includes(qp)),
    ).length;
    const nameRatio = nameMatchCount / nameParts.length;
    if (nameRatio === 1 && nameParts.length >= 2) return 0.7;
    if (matchCount > 0 || nameMatchCount > 0) {
      const bestRatio = Math.max(ratio, nameRatio);
      let score = 0.15 + 0.25 * bestRatio;
      // Trigram boost: if the overall strings are similar, give a bump
      const triSim = trigramSimilarity(nl, ql);
      score += triSim * 0.35;
      return Math.min(score, 0.79);
    }
  }
  // Check if query words appear in the name (multi-word queries)
  const queryWords = ql.split(/[\s_]+/).filter((w) => w.length >= 3);
  if (queryWords.length > 1) {
    const matchCount = queryWords.filter((w) => nl.includes(w)).length;
    if (matchCount > 0) return 0.3 + 0.3 * (matchCount / queryWords.length);
  }
  // Check if name appears in query
  if (nl.length >= 3 && ql.includes(nl)) return 0.5;
  // Trigram similarity as a standalone signal for single-word queries
  const triSim = trigramSimilarity(nl, ql);
  if (triSim >= 0.3) return 0.1 + 0.3 * triSim;
  // Weak: individual word overlap
  const nameWords = (
    nl.match(
      /[A-Z]+\d+[A-Z]+(?=[A-Z][a-z]|[^a-zA-Z0-9]|$)|[A-Z]{2,}(?=[A-Z][a-z]|$)|[A-Z]?[a-z]+|[A-Z]+|\d+/gi,
    ) ?? [nl]
  )
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 3);
  const overlap = nameWords.filter((w) => ql.includes(w)).length;
  if (overlap > 0)
    return 0.1 + 0.15 * (overlap / Math.max(nameWords.length, 1));
  return 0.05;
}
