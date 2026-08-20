import { ZodError } from "zod";

import { loadConfig } from "../../config/loadConfig.js";
import { ContextEngineV2 } from "../../context/engine.js";
import {
  canonicalizeContextPayload,
  stableContextValue,
} from "../../context/serialize.js";
import type {
  ContextEngine,
  ContextEngineV2Result,
  ContextPayload,
  ContextV2Request,
} from "../../context/types.js";
import { getLadybugConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import type { ToolContext } from "../../server.js";
import { buildConditionalResponse } from "../../util/conditional-response.js";
import { hashContent } from "../../util/hashing.js";
import { normalizePath } from "../../util/paths.js";
import { IndexError, ValidationError } from "../errors.js";
import {
  maybeCompressToolResponse,
  recordTokenSavings,
} from "../response-compression.js";
import { sessionContentLedger } from "../session-dedupe.js";
import {
  AgentContextRequestSchema,
  type AgentContextResponse,
} from "../tools.js";
import { markShortIdsDelivered } from "../wire/packed/short-ids.js";
import {
  publishContextWireDecision,
  serializeContextForWireFormat,
  type ContextWireResult,
} from "./context-wire-format.js";

const BYTES_PER_TOKEN = 4;
const SYMBOL_ID_PATTERN = /^[a-f0-9]{64}$/i;
const MIN_RAW_TOKENS_PER_CONTEXT_RESULT = 300;
const defaultContextEngine: ContextEngine = new ContextEngineV2();

interface EvidenceSourceCandidates {
  symbolIds: Set<string>;
  relPaths: Set<string>;
}

export interface ContextRawTokenSources {
  symbolIds: Set<string>;
  relPaths: Set<string>;
  evidenceCount: number;
  evidenceSources: EvidenceSourceCandidates[];
}

export interface ContextRawEquivalentInput {
  fileRawTokens: number;
  evidenceCount: number;
  resolvedEvidenceCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function shouldAttachPackedPayloadForContext(
  wireFormat: "packed" | "auto",
  wireResult: Pick<
    ContextWireResult,
    "jsonBytes" | "packedBytes" | "jsonTokens" | "packedTokens"
  >,
): boolean {
  const bytesSaved =
    (wireResult.jsonBytes ?? 0) > (wireResult.packedBytes ?? 0);
  const tokensSaved =
    typeof wireResult.jsonTokens === "number" &&
    typeof wireResult.packedTokens === "number" &&
    wireResult.jsonTokens > wireResult.packedTokens;
  return wireFormat === "packed" && bytesSaved && tokensSaved;
}

function isSymbolId(value: string): boolean {
  return SYMBOL_ID_PATTERN.test(value);
}

function normalizeEvidencePath(
  value: string,
  allowRootFile = false,
): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || isSymbolId(trimmed)) return undefined;
  const hasDirectory = trimmed.includes("/") || trimmed.includes("\\");
  if (!hasDirectory && !allowRootFile) return undefined;
  if (
    !hasDirectory &&
    !/^[^\\/:*?"<>|]+\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)
  ) {
    return undefined;
  }
  return normalizePath(trimmed);
}

function addCandidate(
  candidates: EvidenceSourceCandidates,
  sources: ContextRawTokenSources,
  kind: "symbol" | "path",
  value: string,
): void {
  if (kind === "symbol") {
    candidates.symbolIds.add(value);
    sources.symbolIds.add(value);
  } else {
    candidates.relPaths.add(value);
    sources.relPaths.add(value);
  }
}

function addContextEvidenceSource(
  evidence: Record<string, unknown>,
  sources: ContextRawTokenSources,
): void {
  const candidates: EvidenceSourceCandidates = {
    symbolIds: new Set(),
    relPaths: new Set(),
  };
  sources.evidenceCount += 1;
  if (typeof evidence.symbolId === "string" && evidence.symbolId) {
    addCandidate(candidates, sources, "symbol", evidence.symbolId);
  }
  if (typeof evidence.path === "string") {
    const path = normalizeEvidencePath(evidence.path, true);
    if (path) addCandidate(candidates, sources, "path", path);
  }
  if (candidates.symbolIds.size > 0 || candidates.relPaths.size > 0) {
    sources.evidenceSources.push(candidates);
  }
}

export function collectContextRawTokenSources(
  response: Record<string, unknown>,
): ContextRawTokenSources {
  const sources: ContextRawTokenSources = {
    symbolIds: new Set(),
    relPaths: new Set(),
    evidenceCount: 0,
    evidenceSources: [],
  };
  if (Array.isArray(response.evidence)) {
    for (const item of response.evidence) {
      if (isRecord(item)) addContextEvidenceSource(item, sources);
    }
  }
  return sources;
}

export function calculateContextRawEquivalentTokens({
  fileRawTokens,
  evidenceCount,
  resolvedEvidenceCount,
}: ContextRawEquivalentInput): number {
  const unresolvedEvidenceCount = Math.max(
    0,
    evidenceCount - resolvedEvidenceCount,
  );
  return (
    fileRawTokens +
    unresolvedEvidenceCount * MIN_RAW_TOKENS_PER_CONTEXT_RESULT
  );
}

function fileBytesToTokens(byteSize: number): number {
  return Math.ceil(byteSize / BYTES_PER_TOKEN);
}

export async function estimateContextRawEquivalentTokens(
  repoId: string,
  response: Record<string, unknown>,
): Promise<number> {
  const sources = collectContextRawTokenSources(response);
  if (sources.symbolIds.size === 0 && sources.relPaths.size === 0) {
    return calculateContextRawEquivalentTokens({
      fileRawTokens: 0,
      evidenceCount: sources.evidenceCount,
      resolvedEvidenceCount: 0,
    });
  }

  try {
    const conn = await getLadybugConn();
    const fileIds = new Set<string>();
    const resolvedSymbolIds = new Set<string>();
    const resolvedRelPaths = new Set<string>();

    if (sources.symbolIds.size > 0) {
      const symbols = await ladybugDb.getSymbolsByIds(conn, [
        ...sources.symbolIds,
      ]);
      for (const symbol of symbols.values()) {
        if (symbol.repoId !== repoId) continue;
        fileIds.add(symbol.fileId);
        resolvedSymbolIds.add(symbol.symbolId);
      }
    }
    for (const relPath of sources.relPaths) {
      const file = await ladybugDb.getFileByRepoPath(conn, repoId, relPath);
      if (!file) continue;
      fileIds.add(file.fileId);
      resolvedRelPaths.add(relPath);
    }

    const files = await ladybugDb.getFilesByIds(conn, [...fileIds]);
    let fileRawTokens = 0;
    for (const file of files.values()) {
      if (file.repoId === repoId) {
        fileRawTokens += fileBytesToTokens(file.byteSize);
      }
    }

    let resolvedEvidenceCount = 0;
    for (const candidates of sources.evidenceSources) {
      const resolved =
        [...candidates.symbolIds].some((id) => resolvedSymbolIds.has(id)) ||
        [...candidates.relPaths].some((path) => resolvedRelPaths.has(path));
      if (resolved) resolvedEvidenceCount += 1;
    }
    return calculateContextRawEquivalentTokens({
      fileRawTokens,
      evidenceCount: sources.evidenceCount,
      resolvedEvidenceCount,
    });
  } catch {
    // Token accounting must never make retrieval fail.
    return calculateContextRawEquivalentTokens({
      fileRawTokens: 0,
      evidenceCount: sources.evidenceCount,
      resolvedEvidenceCount: 0,
    });
  }
}

interface ContextSessionDeltaSummary {
  newCards: number;
  changedCards: number;
  unchangedRefs: number;
}

function applyContextSessionRefs(
  response: Record<string, unknown>,
  options: { repoId: string; refsMode?: "auto" | "off"; sessionId?: string },
): void {
  if (
    options.refsMode === "off" ||
    !options.sessionId ||
    !Array.isArray(response.evidence)
  ) {
    return;
  }

  const sessionDelta: ContextSessionDeltaSummary = {
    newCards: 0,
    changedCards: 0,
    unchangedRefs: 0,
  };
  let sawCard = false;
  response.evidence = response.evidence.map((item) => {
    if (!isRecord(item) || item.rung !== "card") return item;
    if (typeof item.symbolId !== "string") return item;
    sawCard = true;
    const key = `card:${options.repoId}:${item.symbolId}`;
    const result = sessionContentLedger.record({
      sessionId: options.sessionId,
      key,
      contentHash: hashContent(JSON.stringify(item.content)),
    });
    if (result.status === "unchanged") {
      sessionDelta.unchangedRefs += 1;
      return {
        rung: item.rung,
        symbolId: item.symbolId,
        path: item.path,
        rank: item.rank,
        tier: item.tier,
        lanes: item.lanes,
        ref: { key },
        unchanged: true,
      };
    }
    if (result.status === "changed") {
      sessionDelta.changedCards += 1;
      return { ...item, changedSincePrior: true };
    }
    sessionDelta.newCards += 1;
    return item;
  });
  if (sawCard) response.sessionDelta = sessionDelta;
}

export function buildContextPackedStats(
  wireResult: ContextWireResult,
  payloadAttached: boolean,
): Record<string, unknown> | undefined {
  if (!wireResult.gateDecision) return undefined;
  const savedRatio =
    wireResult.jsonBytes && wireResult.jsonBytes > 0
      ? (wireResult.jsonBytes - (wireResult.packedBytes ?? 0)) /
        wireResult.jsonBytes
      : 0;
  const tokenSavedRatio =
    typeof wireResult.jsonTokens === "number" &&
    typeof wireResult.packedTokens === "number" &&
    wireResult.jsonTokens > 0
      ? (wireResult.jsonTokens - wireResult.packedTokens) /
        wireResult.jsonTokens
      : undefined;
  return {
    encoderId: wireResult.encoderId,
    jsonBytes: wireResult.jsonBytes,
    packedBytes: wireResult.packedBytes,
    jsonTokens: wireResult.jsonTokens,
    packedTokens: wireResult.packedTokens,
    savedRatio,
    tokenSavedRatio,
    axisHit: wireResult.axisHit,
    candidateDecision: wireResult.gateDecision,
    gateDecision: payloadAttached ? "packed" : "fallback",
    payloadAttached,
    returnFormat: payloadAttached ? "packed" : "json",
  };
}

function isContextPayload(result: ContextEngineV2Result): result is ContextPayload {
  return !("isError" in result);
}

function toEngineRequest(
  request: ReturnType<typeof AgentContextRequestSchema.parse>,
): ContextV2Request {
  return {
    repoId: request.repoId,
    taskType: request.taskType,
    taskText: request.taskText,
    budget: request.budget,
    ...(request.focusPaths ? { focusPaths: request.focusPaths } : {}),
    ...(request.focusSymbols ? { focusSymbols: request.focusSymbols } : {}),
    ...(request.chatMentions ? { chatMentions: request.chatMentions } : {}),
    ...(request.includeTests !== undefined
      ? { includeTests: request.includeTests }
      : {}),
  };
}

export async function handleAgentContext(
  args: unknown,
  context?: ToolContext,
  contextEngine: ContextEngine = defaultContextEngine,
): Promise<AgentContextResponse> {
  try {
    const request = AgentContextRequestSchema.parse(args);
    const result = await contextEngine.buildContext(toEngineRequest(request));
    if (!isContextPayload(result)) return result;

    const canonical = canonicalizeContextPayload(result);
    const rawTokens = await estimateContextRawEquivalentTokens(
      request.repoId,
      canonical as unknown as Record<string, unknown>,
    );
    const conditional = buildConditionalResponse(canonical, {
      ifNoneMatch: request.ifNoneMatch,
      stableValue: stableContextValue(canonical),
    });
    if (request.ifNoneMatch) {
      const hit = "notModified" in conditional;
      recordTokenSavings({
        repoId: request.repoId,
        source: "etag",
        tool: "sdl.context",
        estimatedTokensAvoided: hit ? rawTokens : 0,
        opportunity: true,
        hit,
        realized: hit,
      });
    }
    if ("notModified" in conditional) return conditional;

    const response = conditional as unknown as Record<string, unknown>;
    applyContextSessionRefs(response, {
      repoId: request.repoId,
      refsMode: request.refsMode,
      sessionId: context?.sessionId,
    });

    if (request.wireFormat === "packed" || request.wireFormat === "auto") {
      const config = loadConfig();
      const wireResult = serializeContextForWireFormat(
        response,
        request.wireFormat,
        {
          repoId: request.repoId,
          sessionId: context?.sessionId,
          shortIds: config.wire?.shortIds,
        },
      );
      if (wireResult.format === "packed") {
        const payloadAttached = shouldAttachPackedPayloadForContext(
          request.wireFormat,
          wireResult,
        );
        response._packedStats = buildContextPackedStats(
          wireResult,
          payloadAttached,
        );
        publishContextWireDecision(
          wireResult,
          payloadAttached ? "packed" : "fallback",
        );
        if (payloadAttached) {
          response._packedPayload = wireResult.payload as string;
          response.evidence = [];
          response.edges = [];
          response.nextActions = [];
          const omitted = isRecord(response.omitted) ? response.omitted : {};
          response.omitted = { ...omitted, highestRanked: [] };
          markShortIdsDelivered(wireResult.payload as string, {
            sessionId: context?.sessionId,
            shortIds: config.wire?.shortIds,
          });
        }
      } else {
        response._packedStats = buildContextPackedStats(wireResult, false);
        publishContextWireDecision(wireResult, "fallback");
      }
    }

    return (await maybeCompressToolResponse({
      repoId: request.repoId,
      toolName: "sdl.context",
      payload: response,
      responseMode: request.responseMode,
      sessionId: context?.sessionId,
    })) as AgentContextResponse;
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ValidationError(
        `Invalid agent context request: ${error.issues
          .map((issue) => issue.message)
          .join(", ")}`,
      );
    }
    if (error instanceof ValidationError || error instanceof IndexError) {
      throw error;
    }
    throw new IndexError(
      `Agent context retrieval failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
