export interface TaskScopedCandidate {
  filePath: string;
  kind: string;
  exported: boolean;
  name?: string;
}

function stemToken(token: string): string {
  let stem = token.toLowerCase();
  for (const suffix of ["ing", "ers", "er", "ies", "ied", "ed", "es", "s"]) {
    if (stem.length > suffix.length + 2 && stem.endsWith(suffix)) {
      if (suffix === "ies") {
        return stem.slice(0, -3) + "y";
      }
      return stem.slice(0, -suffix.length);
    }
  }
  return stem;
}

function tokenizeForRanking(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3)
    .map(stemToken);
}

export function isTestLikePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  return normalized.includes("/tests/")
    || normalized.startsWith("tests/")
    || normalized.includes(".test.")
    || normalized.includes(".spec.");
}

function pathDomainScore(query: string, filePath: string): number {
  const queryTokens = tokenizeForRanking(query);
  const pathTokens = tokenizeForRanking(filePath);
  let score = 0;

  for (const queryToken of queryTokens) {
    for (const pathToken of pathTokens) {
      if (
        pathToken === queryToken
        || pathToken.startsWith(queryToken)
        || queryToken.startsWith(pathToken)
      ) {
        score += 2;
        break;
      }
    }
  }

  return score;
}

function kindScore(kind: string): number {
  switch (kind) {
    case "function":
    case "method":
      return 3;
    case "class":
    case "constructor":
      return 2;
    case "interface":
    case "type":
      return 1;
    default:
      return 0;
  }
}

function candidateScore(query: string, candidate: TaskScopedCandidate): number {
  let score = pathDomainScore(query, candidate.filePath);

  if (!isTestLikePath(candidate.filePath)) {
    score += 3;
  } else {
    score -= 6;
  }

  if (candidate.filePath.startsWith("src/")) {
    score += 2;
  }

  if (candidate.exported) {
    score += 2;
  }

  score += kindScore(candidate.kind);

  return score;
}

export function compareTaskScopedCandidates(
  query: string,
  left: TaskScopedCandidate,
  right: TaskScopedCandidate,
): number {
  const scoreDiff = candidateScore(query, right) - candidateScore(query, left);
  if (scoreDiff !== 0) {
    return scoreDiff;
  }

  if (left.exported !== right.exported) {
    return left.exported ? -1 : 1;
  }

  if (left.filePath !== right.filePath) {
    return left.filePath.localeCompare(right.filePath);
  }

  return (left.name ?? "").localeCompare(right.name ?? "");
}
