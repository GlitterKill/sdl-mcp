import {
  SymbolSearchRequestSchema,
  SymbolSearchResponse,
  SymbolGetCardRequestSchema,
  SymbolGetCardResponse,
} from "../tools.js";
import {
  SYMBOL_CARD_MAX_DEPS_PER_KIND,
  SYMBOL_CARD_MAX_INVARIANTS,
  SYMBOL_CARD_MAX_SIDE_EFFECTS,
  SYMBOL_CARD_MAX_TEST_REFS,
  SYMBOL_CARD_SUMMARY_MAX_CHARS,
  SYMBOL_SEARCH_DEFAULT_LIMIT,
  SYMBOL_SEARCH_MAX_QUERY_TOKENS,
  SYMBOL_SEARCH_MIN_QUERY_TOKEN_LENGTH,
} from "../../config/constants.js";
import type { SymbolRow } from "../../db/schema.js";
import type {
  SymbolCard,
  SymbolSignature,
  SymbolDeps,
  SymbolMetrics,
  CardWithETag,
  NotModifiedResponse,
} from "../types.js";
import * as db from "../../db/queries.js";
import { getFile } from "../../db/queries.js";
import { hashCard } from "../../util/hashing.js";
import { tokenize } from "../../util/tokenize.js";
import { pickDepLabel } from "../../util/depLabels.js";
import {
  PolicyEngine,
  type PolicyRequestContext,
} from "../../policy/engine.js";
import { logPolicyDecision } from "../telemetry.js";
import { DatabaseError, createPolicyDenial } from "../errors.js";
import { symbolCardCache } from "../../graph/cache.js";
import { loadConfig } from "../../config/loadConfig.js";

const policyEngine = new PolicyEngine();
type SearchRow = {
  symbol_id: string;
  name: string;
  file_id: number;
  file_path: string;
  kind: SymbolRow["kind"];
};
const SYMBOL_SEARCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "with",
]);
const UNDERSTANDING_INTENT_TOKENS = new Set([
  "understand",
  "understanding",
  "explain",
  "flow",
  "lifecycle",
  "pipeline",
  "request",
  "response",
  "refresh",
  "cache",
]);
const UNDERSTANDING_SYMBOL_TOKENS = new Set([
  "build",
  "refresh",
  "handle",
  "load",
  "resolve",
  "cache",
  "request",
  "response",
  "slice",
  "state",
]);
const AGGREGATOR_PATH_RE = /(^|\/)(index|tools|types|main|mod|util|utils)\.[^.]+$/;

function uniqueLimit(values: string[], max: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length >= max) break;
  }
  return result;
}

function splitIdentifierTokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.trim().toLowerCase())
    .filter(
      (token) =>
        token.length >= SYMBOL_SEARCH_MIN_QUERY_TOKEN_LENGTH &&
        !SYMBOL_SEARCH_STOP_WORDS.has(token),
    );
}

function isAggregatorPath(path: string): boolean {
  return AGGREGATOR_PATH_RE.test(path);
}

function countTokenOverlap(tokens: string[], queryTokens: Set<string>): number {
  let count = 0;
  for (const token of tokens) {
    if (queryTokens.has(token)) count++;
  }
  return count;
}

function isUnderstandingIntent(queryTokens: Set<string>): boolean {
  for (const token of queryTokens) {
    if (UNDERSTANDING_INTENT_TOKENS.has(token)) return true;
  }
  return false;
}

function expandSemanticQueryTokens(tokens: string[]): string[] {
  const expanded = new Set(tokens);
  for (const token of tokens) {
    if (
      token === "understand" ||
      token === "understanding" ||
      token === "explain"
    ) {
      expanded.add("flow");
      expanded.add("lifecycle");
      expanded.add("request");
      expanded.add("refresh");
    } else if (token === "flow" || token === "lifecycle") {
      expanded.add("build");
      expanded.add("handle");
      expanded.add("refresh");
      expanded.add("cache");
      expanded.add("slice");
    }
  }
  return uniqueLimit(Array.from(expanded), SYMBOL_SEARCH_MAX_QUERY_TOKENS);
}

function enrichSearchRowsWithFilePath(rows: Array<Omit<SearchRow, "file_path">>): SearchRow[] {
  const filePathCache = new Map<number, string>();
  return rows.map((row) => {
    let filePath = filePathCache.get(row.file_id);
    if (filePath === undefined) {
      filePath = getFile(row.file_id)?.rel_path ?? "";
      filePathCache.set(row.file_id, filePath);
    }
    return {
      ...row,
      file_path: filePath,
    };
  });
}

function rankSymbolMatch(
  row: SearchRow,
  term: string,
  queryTokens: Set<string>,
  understandingIntent: boolean,
): number {
  const name = row.name.toLowerCase();
  const filePath = row.file_path.toLowerCase();
  const nameTokens = splitIdentifierTokens(name);
  const fileTokens = splitIdentifierTokens(filePath);
  let score = 0;

  if (name === term) score += 30;
  else if (name.startsWith(term)) score += 16;
  else if (name.includes(term)) score += 8;

  if (row.kind === "class") score += 4;
  else if (row.kind === "function" || row.kind === "method") score += 3;
  else if (row.kind === "interface" || row.kind === "type") score += 2;

  const nameOverlap = countTokenOverlap(nameTokens, queryTokens);
  const pathOverlap = countTokenOverlap(fileTokens, queryTokens);
  score += nameOverlap * 5;
  score += pathOverlap * 2;

  if (understandingIntent) {
    if (row.kind === "function" || row.kind === "method") score += 4;
    if (nameTokens.some((token) => UNDERSTANDING_SYMBOL_TOKENS.has(token))) {
      score += 5;
    }
    if (nameOverlap >= 2) score += 4;
    if (isAggregatorPath(filePath)) score -= 9;
    if (row.kind === "module" || row.kind === "variable") score -= 4;
  } else if (isAggregatorPath(filePath)) {
    score -= 2;
  }

  if (
    filePath.includes("/tests/") ||
    filePath.startsWith("tests/") ||
    filePath.includes(".test.") ||
    filePath.includes(".spec.")
  ) {
    score -= 2;
  }

  return score;
}

function searchSymbolsNaturalLanguage(
  repoId: string,
  rawQuery: string,
  limit: number,
): SearchRow[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [];

  const scored = new Map<
    string,
    { row: SearchRow; score: number }
  >();

  const queryTokens = expandSemanticQueryTokens(
    uniqueLimit(
      tokenize(query)
        .map((token) => token.toLowerCase())
        .filter(
          (token) =>
            token.length >= SYMBOL_SEARCH_MIN_QUERY_TOKEN_LENGTH &&
            !SYMBOL_SEARCH_STOP_WORDS.has(token),
        )
        .flatMap((token) => splitIdentifierTokens(token)),
      SYMBOL_SEARCH_MAX_QUERY_TOKENS,
    ),
  );
  const queryTokenSet = new Set(queryTokens);
  const understandingIntent = isUnderstandingIntent(queryTokenSet);

  const addResults = (
    rawResults: Array<Omit<SearchRow, "file_path">>,
    delta: (row: SearchRow, idx: number) => number,
  ): void => {
    const results = enrichSearchRowsWithFilePath(rawResults);
    for (let i = 0; i < results.length; i++) {
      const row = results[i];
      const existing = scored.get(row.symbol_id);
      const increment = delta(row, i);
      if (!existing) {
        scored.set(row.symbol_id, { row, score: increment });
      } else {
        existing.score += increment;
      }
    }
  };

  const direct = db.searchSymbolsLite(repoId, query, Math.max(limit, 20));
  addResults(
    direct,
    (row, idx) =>
      50 -
      Math.min(idx, 20) +
      rankSymbolMatch(row, query, queryTokenSet, understandingIntent),
  );

  for (const token of queryTokens) {
    const tokenResults = db.searchSymbolsLite(repoId, token, Math.max(limit, 12));
    addResults(tokenResults, (row, idx) => {
      const rankBonus = Math.max(0, 20 - idx);
      return (
        rankBonus +
        rankSymbolMatch(row, token, queryTokenSet, understandingIntent)
      );
    });
  }

  return Array.from(scored.values())
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.row.kind !== b.row.kind) return a.row.kind.localeCompare(b.row.kind);
      return a.row.name.localeCompare(b.row.name);
    })
    .slice(0, limit)
    .map((entry) => entry.row);
}

/**
 * Handles symbol search requests.
 * Searches for symbols by name or summary with optional limit.
 *
 * @param args - Raw arguments containing repoId, query, and optional limit
 * @returns Search results with repoId and array of symbol summaries
 */
export async function handleSymbolSearch(
  args: unknown,
): Promise<SymbolSearchResponse> {
  const request = SymbolSearchRequestSchema.parse(args);
  const limit = request.limit ?? SYMBOL_SEARCH_DEFAULT_LIMIT;
  const results = searchSymbolsNaturalLanguage(
    request.repoId,
    request.query,
    limit,
  );

  return {
    results: results.map((row) => ({
      symbolId: row.symbol_id,
      name: row.name,
      file: row.file_path,
      kind: row.kind,
    })),
  };
}

/**
 * Handles requests for symbol cards with ETag support.
 * Returns comprehensive symbol metadata including dependencies, metrics, and version info.
 * Supports conditional requests with ifNoneMatch for cache validation.
 *
 * @param args - Raw arguments containing repoId, symbolId, and optional ifNoneMatch
 * @returns Symbol card with metadata or notModified response if ETag matches
 * @throws {DatabaseError} If symbol or file not found
 * @throws {PolicyError} If policy denies the request
 */
export async function handleSymbolGetCard(
  args: unknown,
): Promise<SymbolGetCardResponse> {
  const request = SymbolGetCardRequestSchema.parse(args);
  const { repoId, symbolId, ifNoneMatch } = request;

  const config = loadConfig();
  const cacheConfig = config.cache;
  const cacheEnabled = cacheConfig?.enabled ?? true;

  const latestVersion = db.getLatestVersion(repoId);

  if (cacheEnabled && latestVersion) {
    const cachedCard = symbolCardCache.get(
      repoId,
      symbolId,
      latestVersion.version_id,
    );
    if (cachedCard && cachedCard.detailLevel !== "compact") {
      const normalizedCachedCard: SymbolCard = {
        ...cachedCard,
        detailLevel: "full",
      };
      delete normalizedCachedCard.etag;
      const cachedETag = hashCard(normalizedCachedCard);
      if (ifNoneMatch && ifNoneMatch === cachedETag) {
        const notModified: NotModifiedResponse = {
          notModified: true,
          etag: cachedETag,
          ledgerVersion: latestVersion.version_id,
        };
        return notModified as any;
      }
      const cardWithETag: CardWithETag = {
        ...normalizedCachedCard,
        etag: cachedETag,
      };
      return { card: cardWithETag };
    }
  }

  const symbol = db.getSymbol(symbolId);
  if (!symbol) {
    throw new DatabaseError(`Symbol not found: ${symbolId}`);
  }

  const policyContext: PolicyRequestContext = {
    requestType: "symbolCard",
    repoId: request.repoId,
    symbolId: request.symbolId,
    symbolData: symbol,
  };

  const policyDecision = policyEngine.evaluate(policyContext);
  const { nextBestAction, requiredFieldsForNext } =
    policyEngine.generateNextBestAction(policyDecision, policyContext);

  logPolicyDecision({
    requestType: policyContext.requestType,
    repoId: policyContext.repoId,
    symbolId: policyContext.symbolId,
    decision: policyDecision.decision,
    auditHash: policyDecision.auditHash,
    evidenceUsed: policyDecision.evidenceUsed,
    deniedReasons: policyDecision.deniedReasons,
    nextBestAction,
    requiredFieldsForNext,
    context: policyContext,
  });

  if (policyDecision.decision === "deny") {
    const error = createPolicyDenial(
      `Policy denied symbol card request: ${policyDecision.deniedReasons?.join(", ")}`,
      nextBestAction,
      requiredFieldsForNext,
    );
    throw error;
  }

  const file = getFile(symbol.file_id);
  if (!file) {
    throw new DatabaseError(`File not found: ${symbol.file_id}`);
  }

  const edgesFrom = db.getEdgesFrom(symbolId);
  const metrics = db.getMetrics(symbolId);

  const signature: SymbolSignature | undefined = symbol.signature_json
    ? JSON.parse(symbol.signature_json)
    : undefined;

  const invariants: string[] | undefined = symbol.invariants_json
    ? JSON.parse(symbol.invariants_json)
    : undefined;

  const sideEffects: string[] | undefined = symbol.side_effects_json
    ? JSON.parse(symbol.side_effects_json)
    : undefined;

  const importTargetIds = edgesFrom
    .filter((edge) => edge.type === "import")
    .map((edge) => edge.to_symbol_id);
  const callTargetIds = edgesFrom
    .filter((edge) => edge.type === "call")
    .map((edge) => edge.to_symbol_id);
  const targetNamesById = db.getSymbolsByIdsLite(
    Array.from(new Set([...importTargetIds, ...callTargetIds])),
  );

  const deps: SymbolDeps = {
    imports: uniqueLimit(
      importTargetIds
        .map((targetId) =>
          pickDepLabel(targetId, targetNamesById.get(targetId)?.name),
        )
        .filter((label): label is string => Boolean(label)),
      SYMBOL_CARD_MAX_DEPS_PER_KIND,
    ),
    calls: uniqueLimit(
      callTargetIds
        .map((targetId) =>
          pickDepLabel(targetId, targetNamesById.get(targetId)?.name),
        )
        .filter((label): label is string => Boolean(label)),
      SYMBOL_CARD_MAX_DEPS_PER_KIND,
    ),
  };

  const cardMetrics: SymbolMetrics | undefined = metrics
    ? {
        fanIn: metrics.fan_in,
        fanOut: metrics.fan_out,
        churn30d: metrics.churn_30d,
        testRefs: metrics.test_refs_json
          ? uniqueLimit(
              JSON.parse(metrics.test_refs_json),
              SYMBOL_CARD_MAX_TEST_REFS,
            )
          : undefined,
      }
    : undefined;

  const card: SymbolCard = {
    symbolId: symbol.symbol_id,
    repoId: symbol.repo_id,
    file: file.rel_path,
    range: {
      startLine: symbol.range_start_line,
      startCol: symbol.range_start_col,
      endLine: symbol.range_end_line,
      endCol: symbol.range_end_col,
    },
    kind: symbol.kind,
    name: symbol.name,
    exported: symbol.exported === 1,
    visibility: symbol.visibility ?? undefined,
    signature,
    summary: symbol.summary
      ? symbol.summary.slice(0, SYMBOL_CARD_SUMMARY_MAX_CHARS)
      : undefined,
    invariants: invariants
      ? invariants.slice(0, SYMBOL_CARD_MAX_INVARIANTS)
      : undefined,
    sideEffects: sideEffects
      ? sideEffects.slice(0, SYMBOL_CARD_MAX_SIDE_EFFECTS)
      : undefined,
    deps,
    metrics: cardMetrics,
    detailLevel: "full",
    version: {
      ledgerVersion: latestVersion?.version_id ?? "current",
      astFingerprint: symbol.ast_fingerprint,
    },
  };

  const etag = hashCard(card);

  if (ifNoneMatch && ifNoneMatch === etag) {
    const notModified: NotModifiedResponse = {
      notModified: true,
      etag,
      ledgerVersion: latestVersion?.version_id ?? "current",
    };
    return notModified as any;
  }

  const cardWithETag: CardWithETag = {
    ...card,
    etag,
  };

  if (cacheEnabled && latestVersion) {
    const cacheCard: SymbolCard = {
      ...card,
      detailLevel: "full",
    };
    delete cacheCard.etag;
    await symbolCardCache.set(repoId, symbolId, latestVersion.version_id, cacheCard);
  }

  return { card: cardWithETag };
}
