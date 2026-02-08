import {
  SymbolSearchRequestSchema,
  SymbolSearchResponse,
  SymbolGetCardRequestSchema,
  SymbolGetCardResponse,
} from "../tools.js";
import { SYMBOL_SEARCH_DEFAULT_LIMIT } from "../../config/constants.js";
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
import {
  PolicyEngine,
  type PolicyRequestContext,
} from "../../policy/engine.js";
import { logPolicyDecision } from "../telemetry.js";
import { DatabaseError, createPolicyDenial } from "../errors.js";
import { symbolCardCache } from "../../graph/cache.js";
import { loadConfig } from "../../config/loadConfig.js";

const policyEngine = new PolicyEngine();

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

  const escapedQuery = request.query.replace(/%/g, "\\%").replace(/_/g, "\\_");
  const results = db.searchSymbolsLite(request.repoId, escapedQuery, limit);

  return {
    repoId: request.repoId,
    results: results.map((row) => ({
      symbolId: row.symbol_id,
      name: row.name,
      file: getFile(row.file_id)?.rel_path ?? "",
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
    if (cachedCard) {
      const cachedETag = hashCard(cachedCard);
      if (ifNoneMatch && ifNoneMatch === cachedETag) {
        const notModified: NotModifiedResponse = {
          notModified: true,
          etag: cachedETag,
          ledgerVersion: latestVersion.version_id,
        };
        return notModified as any;
      }
      const cardWithETag: CardWithETag = {
        ...cachedCard,
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

  const deps: SymbolDeps = {
    imports: edgesFrom
      .filter((edge) => edge.type === "import")
      .map((edge) => edge.to_symbol_id),
    calls: edgesFrom
      .filter((edge) => edge.type === "call")
      .map((edge) => edge.to_symbol_id),
  };

  const cardMetrics: SymbolMetrics | undefined = metrics
    ? {
        fanIn: metrics.fan_in,
        fanOut: metrics.fan_out,
        churn30d: metrics.churn_30d,
        testRefs: metrics.test_refs_json
          ? JSON.parse(metrics.test_refs_json)
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
    summary: symbol.summary ?? undefined,
    invariants,
    sideEffects,
    deps,
    metrics: cardMetrics,
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
    await symbolCardCache.set(repoId, symbolId, latestVersion.version_id, card);
  }

  return { card: cardWithETag };
}
