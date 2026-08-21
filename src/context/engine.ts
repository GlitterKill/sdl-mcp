import type { Connection } from "kuzu";

import { ACTION_DEFINITION_BY_ACTION } from "../code-mode/action-catalog.js";
import { loadConfig } from "../config/loadConfig.js";
import { withReadOnlyTransaction } from "../db/ladybug-core.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { withExclusiveReadConnection } from "../db/ladybug.js";
import { GraphRetrievalUnavailableError } from "../domain/errors.js";
import {
  beamSearchLadybug,
  type BeamSearchRequest,
} from "../graph/slice/beam-search-engine.js";
import type { ResolvedStartNode } from "../graph/slice/start-node-resolver.js";
import {
  getOverlaySnapshot,
  type OverlaySnapshot,
} from "../live-index/overlay-reader.js";
import { searchContextCandidates } from "../retrieval/context-candidate-search.js";
import { extractQualifiedTermsFromContext } from "../retrieval/identifier-extraction.js";
import {
  createRetrievalQueryContext,
  prewarmRetrievalEmbeddingPromises,
  runAfterGraphRetrievalAdmission,
} from "../retrieval/orchestrator.js";
import {
  autoExtractMentions,
  resolveSeedSymbols,
} from "../retrieval/seed-resolver.js";
import { isTestCandidate } from "../retrieval/task-query-ranking.js";
import type {
  ContextCandidateSource,
  ContextSourceRanks,
} from "../retrieval/fusion.js";
import type {
  RetrievalCapabilities,
  RetrievalLaneOutcome,
  RetrievalQueryContext,
} from "../retrieval/types.js";
import { assertGraphRetrievalAvailable } from "../services/graph-retrieval-availability.js";
import { normalizePath } from "../util/paths.js";
import { parseTestCaseFacetJson } from "../util/test-case.js";
import {
  hydrateContextBundles,
  prepareContextHydrationPlan,
  type PreparedContextHydrationPlan,
} from "./hydrate.js";
import { getTaskProfile } from "./profiles.js";
import {
  CONTEXT_RUNG_TOKEN_LIMITS,
  enforceContextBudget,
  estimateContextRungTokens,
  estimateContextSelectionEnvelopeTokens,
  selectContextBundles,
} from "./select.js";
import type {
  ContextBudgetError,
  ContextCandidate,
  ContextEngineV2Result,
  ContextLaneId,
  ContextPayload,
  ContextRetrievalBackendError,
  ContextRecoveryError,
  ContextRetrievalLane,
  ContextRetrievalLevel,
  ContextV2Request,
  LogicalAction,
  OmittedContextItem,
  SelectedContextBundle,
  TaskProfile,
} from "./types.js";

const CANDIDATE_LIMIT = 48;
const FOCUS_PATH_SYMBOL_LIMIT = 16;
const SYMBOLS_PER_FILE_SUMMARY = 2;
const EXPANSION_SEED_LIMIT = 16;
const EXPANSION_CARD_LIMIT = 24;
const OMITTED_CAP = 1;
const DERIVED_MENTION_LIMIT = 8;
const CANDIDATE_ESTIMATES = CONTEXT_RUNG_TOKEN_LIMITS;

interface ContextEngineRuntime {
  conn?: Connection;
  versionId?: string;
  overlaySnapshot?: OverlaySnapshot;
  queryContext?: RetrievalQueryContext;
}

export interface ContextRetrievalStageResult {
  level: ContextRetrievalLevel;
  lanes: ContextRetrievalLane[];
  candidates: ContextCandidate[];
  runtime: ContextEngineRuntime;
}

export interface ContextExpandInput {
  request: ContextV2Request;
  profile: TaskProfile;
  candidates: ContextCandidate[];
  runtime: ContextEngineRuntime;
}

export interface ContextHydrateInput {
  request: ContextV2Request;
  profile: TaskProfile;
  selected: SelectedContextBundle[];
  runtime: ContextEngineRuntime;
  prepared: PreparedContextHydrationPlan;
}

export interface ContextHydrateResult {
  evidence: ContextPayload["evidence"];
  edges: ContextPayload["edges"];
  unavailable: OmittedContextItem[];
}

export interface ContextEngineV2Dependencies {
  runReadSnapshot<T>(
    repoId: string,
    fn: (runtime: ContextEngineRuntime) => Promise<T>,
    prewarm: ContextEmbeddingPrewarmInput,
  ): Promise<T>;
  retrieve(
    request: ContextV2Request,
    profile: TaskProfile,
    runtime: ContextEngineRuntime,
  ): Promise<ContextRetrievalStageResult>;
  expand(input: ContextExpandInput): Promise<ContextCandidate[]>;
  prepareHydration(
    input: Omit<ContextHydrateInput, "prepared">,
  ): Promise<PreparedContextHydrationPlan>;
  hydrate(input: ContextHydrateInput): Promise<ContextHydrateResult>;
}

export interface ContextEmbeddingPrewarmInput {
  query: string;
  includeFileSummary: boolean;
}

export interface FocusPathSymbolHit {
  path: string;
  symbolId: string;
}

export interface FocusPathSymbolAllocation {
  seedIds: string[];
  tierZeroIds: string[];
}

function catalogAction(
  actionId: string,
  args: Record<string, unknown>,
): LogicalAction {
  return {
    id: ACTION_DEFINITION_BY_ACTION[actionId]?.action ?? actionId,
    args,
  };
}

function recoveryError(): ContextRecoveryError {
  return {
    isError: true,
    error: {
      code: "CONTEXT_RETRIEVAL_INSUFFICIENT",
      message:
        "Context retrieval is unavailable until repository graph health is restored.",
      recovery: [
        catalogAction("repo.status", {}),
        catalogAction("index.refresh", { mode: "incremental" }),
      ],
    },
  };
}

function canonicalRetryArgs(
  request: ContextV2Request,
): Record<string, unknown> {
  return {
    repoId: request.repoId,
    taskType: request.taskType,
    taskText: request.taskText,
    budget: { maxTokens: request.budget.maxTokens },
    ...(request.focusPaths ? { focusPaths: [...request.focusPaths] } : {}),
    ...(request.focusSymbols
      ? { focusSymbols: [...request.focusSymbols] }
      : {}),
    ...(request.chatMentions
      ? { chatMentions: [...request.chatMentions] }
      : {}),
    ...(request.includeTests !== undefined
      ? { includeTests: request.includeTests }
      : {}),
  };
}

function focusPathUnavailableError(
  request: ContextV2Request,
  paths: readonly string[],
): ContextRecoveryError {
  return {
    isError: true,
    error: {
      code: "CONTEXT_FOCUS_PATH_UNAVAILABLE",
      message: `Exact focus path is indexed but has no available symbols: ${paths.join(", ")}`,
      recovery: [
        catalogAction("index.refresh", { mode: "incremental" }),
        catalogAction("context", canonicalRetryArgs(request)),
      ],
    },
  };
}

function retrievalBackendError(
  request: ContextV2Request,
): ContextRetrievalBackendError {
  return {
    isError: true,
    error: {
      code: "CONTEXT_RETRIEVAL_BACKEND_FAILED",
      message:
        "Every attempted context retrieval backend failed. Check repository status, then retry the same context request.",
      recovery: [
        catalogAction("repo.status", {}),
        catalogAction("context", canonicalRetryArgs(request)),
      ],
    },
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  return [
    ...new Set(values.map((value) => value.trim()).filter(Boolean)),
  ];
}

/** Keep exact dotted evidence ahead of broader caller and task identifiers. */
export function identifiersForContextRequest(
  request: ContextV2Request,
): string[] {
  return uniqueStrings([
    ...extractQualifiedTermsFromContext(
      request.taskText,
      request.chatMentions ?? [],
    ),
    ...(request.chatMentions ?? []),
    ...autoExtractMentions(request.taskText),
  ]);
}

export function focusPathTierZeroCapacity({
  maxTokens,
  explicitTierZeroCount,
  profile,
}: {
  maxTokens: number;
  explicitTierZeroCount: number;
  profile: TaskProfile;
}): number {
  const referenceCandidate: ContextCandidate = {
    symbolId: "focus-path",
    path: "",
    rank: 1,
    tier: 0,
    lanes: ["exactIdentifier"],
    estimates: CANDIDATE_ESTIMATES,
  };
  const guaranteedLadderEstimate = profile.rungPreference.reduce(
    (total, rung) =>
      total + estimateContextRungTokens(referenceCandidate, rung),
    0,
  );
  const emptyPayload: ContextPayload = {
    status: "empty",
    taskType: profile.taskType,
    retrieval: { level: "lexical", lanes: [] },
    evidence: [],
    edges: [],
    omitted: {
      total: 0,
      byReason: { budget: 0 },
      highestRanked: [],
    },
    nextActions: [],
  };
  const availableTokens = Math.max(
    0,
    maxTokens - estimateContextSelectionEnvelopeTokens(emptyPayload),
  );
  const explicitCost =
    Math.max(0, Math.trunc(explicitTierZeroCount)) *
    guaranteedLadderEstimate;
  // A focused file is a seed priority, not a retrieval boundary. Keep one
  // complete ladder available for the strongest non-focus candidate.
  const focusBudget = Math.max(
    0,
    availableTokens - explicitCost - guaranteedLadderEstimate,
  );
  const budgetCapacity =
    guaranteedLadderEstimate > 0
      ? Math.floor(focusBudget / guaranteedLadderEstimate)
      : 0;
  return Math.min(
    FOCUS_PATH_SYMBOL_LIMIT,
    Math.max(1, budgetCapacity),
  );
}

export function allocateFocusPathSymbols(
  hits: readonly FocusPathSymbolHit[],
  tierZeroCapacity: number,
): FocusPathSymbolAllocation {
  const idsByPath = new Map<string, Set<string>>();
  for (const hit of hits) {
    const path = normalizePath(hit.path)
      .replace(/^\.\//, "")
      .replace(/\/+$/, "");
    const ids = idsByPath.get(path) ?? new Set<string>();
    ids.add(hit.symbolId);
    idsByPath.set(path, ids);
  }

  const buckets = [...idsByPath.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, ids]) => [...ids].sort((left, right) => left.localeCompare(right)));
  const seedIds: string[] = [];
  const seen = new Set<string>();
  for (
    let offset = 0;
    seedIds.length < FOCUS_PATH_SYMBOL_LIMIT;
    offset++
  ) {
    let hasCandidate = false;
    for (const bucket of buckets) {
      const symbolId = bucket[offset];
      if (!symbolId) continue;
      hasCandidate = true;
      if (seen.has(symbolId)) continue;
      seen.add(symbolId);
      seedIds.push(symbolId);
      if (seedIds.length >= FOCUS_PATH_SYMBOL_LIMIT) break;
    }
    if (!hasCandidate) break;
  }

  const boundedCapacity = Math.min(
    seedIds.length,
    Math.max(0, Math.trunc(tierZeroCapacity)),
  );
  return {
    seedIds,
    tierZeroIds: seedIds.slice(0, boundedCapacity),
  };
}

function isIdentifierShapedMention(value: string): boolean {
  return /[a-z0-9][A-Z]/.test(value) || value.includes("_");
}

function isExplicitTaskIdentifier(taskText: string, value: string): boolean {
  if (!isIdentifierShapedMention(value)) return false;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(^|[^A-Za-z0-9_$])${escaped}($|[^A-Za-z0-9_$])`,
  ).test(taskText);
}

export function tierZeroMentionsForRequest(
  request: Pick<
    ContextV2Request,
    "chatMentions" | "focusSymbols" | "taskText"
  >,
): string[] {
  const quoted =
    request.taskText
      .match(/`([A-Za-z_$][A-Za-z0-9_$]*)`/g)
      ?.map((match) => match.slice(1, -1)) ?? [];
  // Generic task words still seed hybrid retrieval, but only explicit symbol-like
  // mentions receive the output guarantee carried by Tier 0.
  const taskIdentifiers = autoExtractMentions(request.taskText).filter(
    (value) => isExplicitTaskIdentifier(request.taskText, value),
  );
  return uniqueStrings([
    ...(request.focusSymbols ?? []),
    ...(request.chatMentions ?? []),
    ...quoted,
    ...taskIdentifiers,
  ]);
}

function compoundPart(part: string, preserveLeadingAcronym: boolean): string {
  if (preserveLeadingAcronym && /^[A-Z0-9]{2,4}$/.test(part)) {
    return part;
  }
  return part[0].toUpperCase() + part.slice(1).toLowerCase();
}

export function derivedTierOneMentionsForRequest(
  request: Pick<ContextV2Request, "taskText">,
): string[] {
  const identifiers =
    request.taskText.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
  const derived: string[] = [];
  for (const identifier of identifiers) {
    const parts = identifier.split("_").filter(Boolean);
    for (let index = 0; index < parts.length - 1; index++) {
      const compound =
        compoundPart(parts[index], true) +
        compoundPart(parts[index + 1], false);
      if (!derived.includes(compound)) derived.push(compound);
      if (derived.length >= DERIVED_MENTION_LIMIT) return derived;
    }
  }
  // ponytail: keep adjacent pairs and the eight-item ceiling until evaluation
  // evidence justifies broader compound expansion.
  return derived;
}

function lanesFromSourceRanks(
  sourceRanks: ContextSourceRanks | undefined,
  entity: "symbol" | "fileSummary",
): ContextLaneId[] {
  const lanes = new Set<ContextLaneId>();
  for (const source of Object.keys(
    sourceRanks ?? {},
  ) as ContextCandidateSource[]) {
    if (source === "exactIdentifier") {
      lanes.add("exactIdentifier");
    } else if (source === "fts") {
      lanes.add(entity === "symbol" ? "symbolFts" : "fileSummaryFts");
    } else if (source.startsWith("vector:")) {
      lanes.add(entity === "symbol" ? "symbolVec" : "fileSummaryVec");
    } else if (source === "overlay") {
      lanes.add("overlay");
    }
  }
  return [...lanes];
}

function lanesFromCandidateProvenance(provenance: {
  symbol?: ContextSourceRanks;
  fileSummary?: ContextSourceRanks;
}): ContextLaneId[] {
  return [
    ...new Set([
      ...lanesFromSourceRanks(provenance.symbol, "symbol"),
      ...lanesFromSourceRanks(
        provenance.fileSummary,
        "fileSummary",
      ),
    ]),
  ];
}

function compareSymbolRows(
  left: Awaited<ReturnType<typeof ladybugDb.getSymbolsByFile>>[number],
  right: Awaited<ReturnType<typeof ladybugDb.getSymbolsByFile>>[number],
): number {
  return (
    Number(right.exported) - Number(left.exported) ||
    left.rangeStartLine - right.rangeStartLine ||
    left.symbolId.localeCompare(right.symbolId)
  );
}

export type FocusPathReadQueries = Pick<
  typeof ladybugDb,
  "getFileByRepoPath" | "getFilesByPrefix" | "getSymbolsByFile"
>;

const DEFAULT_FOCUS_PATH_READ_QUERIES: FocusPathReadQueries = {
  getFileByRepoPath: ladybugDb.getFileByRepoPath,
  getFilesByPrefix: ladybugDb.getFilesByPrefix,
  getSymbolsByFile: ladybugDb.getSymbolsByFile,
};

export function resolveOverlayMentionSymbolIds(
  snapshot: OverlaySnapshot,
  mentions: readonly string[],
): string[] {
  const symbols = [...snapshot.symbolsById.values()].sort((left, right) =>
    left.symbolId.localeCompare(right.symbolId),
  );
  return uniqueStrings(
    mentions.flatMap((mention) =>
      symbols
        .filter(
          (symbol) =>
            symbol.repoId === snapshot.repoId &&
            (symbol.symbolId === mention || symbol.name === mention),
        )
        .map((symbol) => symbol.symbolId),
    ),
  );
}

interface FocusPathResolution {
  exactFileSymbolHits: FocusPathSymbolHit[];
  unavailableExactFiles: string[];
  directoryPrefixes: string[];
}

export class FocusPathUnavailableError extends Error {
  readonly paths: readonly string[];

  constructor(paths: readonly string[]) {
    const sortedPaths = [...paths].sort();
    super(`Exact focus paths are unavailable: ${sortedPaths.join(", ")}`);
    this.name = "FocusPathUnavailableError";
    this.paths = Object.freeze(sortedPaths);
  }
}

export async function resolveFocusPaths(
  conn: Connection,
  repoId: string,
  focusPaths: readonly string[],
  overlaySnapshot: OverlaySnapshot,
  queries: FocusPathReadQueries = DEFAULT_FOCUS_PATH_READ_QUERIES,
): Promise<FocusPathResolution> {
  const exactFiles = new Map<
    string,
    NonNullable<Awaited<ReturnType<typeof ladybugDb.getFileByRepoPath>>>
  >();
  const directoryPrefixes = new Set<string>();
  const normalizedFocusPaths = uniqueStrings(
    focusPaths.map((focusPath) =>
      normalizePath(focusPath).replace(/^\.\//, "").replace(/\/+$/, ""),
    ),
  )
    .filter(Boolean)
    .sort();

  for (const normalized of normalizedFocusPaths) {
    const directoryPrefix = `${normalized}/`;
    const overlayFiles = [...overlaySnapshot.filesById.values()].filter(
      (file) =>
        file.repoId === repoId &&
        (file.relPath === normalized ||
          file.relPath.startsWith(directoryPrefix)),
    );
    const overlayExact = overlayFiles.find(
      (file) => file.relPath === normalized,
    );
    const durableExact = overlayExact
      ? null
      : await queries.getFileByRepoPath(conn, repoId, normalized);
    const exact =
      overlayExact ??
      (durableExact &&
      !overlaySnapshot.touchedFileIds.has(durableExact.fileId)
        ? durableExact
        : null);

    if (exact) {
      exactFiles.set(exact.fileId, exact);
      continue;
    }
    if (overlayFiles.length > 0) {
      directoryPrefixes.add(normalized);
      continue;
    }

    const durablePrefixFiles = await queries.getFilesByPrefix(
      conn,
      repoId,
      directoryPrefix,
      1,
      Array.from(overlaySnapshot.touchedFileIds),
    );
    if (
      durablePrefixFiles.some((file) =>
        file.relPath.startsWith(directoryPrefix),
      )
    ) {
      directoryPrefixes.add(normalized);
    }
  }

  const exactFileSymbolHits: FocusPathSymbolHit[] = [];
  const unavailableExactFiles: string[] = [];
  for (const file of [...exactFiles.values()].sort(
    (left, right) =>
      left.relPath.localeCompare(right.relPath) ||
      left.fileId.localeCompare(right.fileId),
  )) {
    const overlaySymbols = [...overlaySnapshot.symbolsById.values()].filter(
      (symbol) => symbol.fileId === file.fileId,
    );
    const symbols = (overlaySnapshot.filesById.has(file.fileId)
      ? overlaySymbols
      : await queries.getSymbolsByFile(conn, file.fileId)
    )
      .filter((symbol) => symbol.external !== true)
      .sort(compareSymbolRows);
    if (symbols.length === 0) {
      unavailableExactFiles.push(file.relPath);
      continue;
    }
    for (const symbol of symbols) {
      exactFileSymbolHits.push({
        path: file.relPath,
        symbolId: symbol.symbolId,
      });
    }
  }

  return {
    exactFileSymbolHits,
    unavailableExactFiles,
    directoryPrefixes: [...directoryPrefixes].sort(),
  };
}

async function buildMetadataCandidates(
  conn: Connection,
  repoId: string,
  symbolIds: readonly string[],
  tier: 0 | 1,
  lanes: ContextLaneId[],
  overlaySnapshot?: OverlaySnapshot,
): Promise<ContextCandidate[]> {
  const overlaySymbols = new Map(
    symbolIds.flatMap((symbolId) => {
      const symbol = overlaySnapshot?.symbolsById.get(symbolId);
      return symbol?.repoId === repoId ? [[symbolId, symbol] as const] : [];
    }),
  );
  const durableIds = symbolIds.filter(
    (symbolId) => !overlaySymbols.has(symbolId),
  );
  const durableSymbols =
    durableIds.length > 0
      ? await ladybugDb.getSymbolsByIds(conn, durableIds)
      : new Map();
  const symbols = new Map(
    [...durableSymbols].filter(
      ([symbolId, symbol]) =>
        !overlaySnapshot?.touchedFileIds.has(symbol.fileId) ||
        overlaySnapshot.symbolsById.has(symbolId),
    ),
  );
  for (const item of overlaySymbols) symbols.set(...item);
  const durableFileIds = [
    ...new Set(
      [...symbols.values()]
        .filter(
          (symbol) =>
            symbol.repoId === repoId &&
            !overlaySnapshot?.filesById.has(symbol.fileId),
        )
        .map((symbol) => symbol.fileId),
    ),
  ];
  const files =
    durableFileIds.length > 0
      ? await ladybugDb.getFilesByIds(conn, durableFileIds)
      : new Map();
  for (const [fileId, file] of overlaySnapshot?.filesById ?? []) {
    if (file.repoId === repoId) files.set(fileId, file);
  }
  const candidates: ContextCandidate[] = [];
  for (const symbolId of symbolIds) {
    const symbol = symbols.get(symbolId);
    if (!symbol || symbol.repoId !== repoId || symbol.external === true) {
      continue;
    }
    const path = files.get(symbol.fileId)?.relPath;
    if (!path) continue;
    candidates.push({
      symbolId,
      path,
      hasTestCaseFacet:
        parseTestCaseFacetJson(symbol.testCaseJson) !== undefined,
      rank: candidates.length + 1,
      tier,
      lanes: [...lanes],
      estimates: CANDIDATE_ESTIMATES,
    });
  }
  return candidates;
}

function vectorAvailable(
  values: Record<string, boolean> | undefined,
): boolean {
  return Object.values(values ?? {}).some(Boolean);
}

export function profileUsesAuxiliaryLane(
  profile: TaskProfile,
  lane: TaskProfile["auxiliaryLanes"][number],
): boolean {
  return profile.auxiliaryLanes.includes(lane);
}

export function buildRetrievalState(
  capabilities: RetrievalCapabilities | undefined,
  candidates: readonly ContextCandidate[],
  laneOutcomes: ReadonlyMap<string, RetrievalLaneOutcome> = new Map(),
  profile?: TaskProfile,
): {
  level: ContextRetrievalLevel;
  lanes: ContextRetrievalLane[];
} {
  const hasOverlay = candidates.some((candidate) =>
    candidate.lanes.includes("overlay"),
  );
  const includeFileSummary =
    profile === undefined ||
    profileUsesAuxiliaryLane(profile, "fileSummary");
  const hasReportedAvailability = [...laneOutcomes.values()].some(
    (outcome) => outcome.available !== undefined,
  );
  const reportedAvailable = (prefix: string): boolean =>
    [...laneOutcomes.entries()].some(
      ([lane, outcome]) =>
        lane.startsWith(prefix) && outcome.available === true,
    );
  const symbolVector = hasReportedAvailability
    ? reportedAvailable("symbol:vector:")
    : capabilities?.vectorNomic === true ||
      capabilities?.vectorJinaCode === true ||
      vectorAvailable(capabilities?.vectorByEntityModel?.symbol);
  const fileSummaryVector = includeFileSummary
    ? hasReportedAvailability
      ? reportedAvailable("fileSummary:vector:")
      : vectorAvailable(capabilities?.vectorByEntityModel?.fileSummary)
    : false;
  const symbolFts = hasReportedAvailability
    ? laneOutcomes.get("symbol:fts")?.available === true
    : capabilities?.fts === true;
  const fileSummaryFts =
    includeFileSummary &&
    (hasReportedAvailability
      ? laneOutcomes.get("fileSummary:fts")?.available === true
      : capabilities?.fileSummaryFts === true);
  const lanes: ContextRetrievalLane[] = [
    { id: "exactIdentifier", available: true },
    { id: "symbolFts", available: symbolFts },
    {
      id: "symbolVec",
      available: symbolVector,
      coveragePermille:
        capabilities?.coveragePermille.symbolVector ?? 0,
    },
    ...(includeFileSummary
      ? [
          { id: "fileSummaryFts" as const, available: fileSummaryFts },
          {
            id: "fileSummaryVec" as const,
            available: fileSummaryVector,
            coveragePermille:
              capabilities?.coveragePermille.fileSummaryVector ?? 0,
          },
        ]
      : []),
  ];
  if (hasOverlay) {
    lanes.push({ id: "overlay", available: true });
  }

  const outcomes = [...laneOutcomes.values()].filter(
    (outcome) => outcome.attempted,
  );
  const anySucceeded = outcomes.some((outcome) => outcome.succeeded);
  const anyFailed = outcomes.some((outcome) => outcome.failed);
  const allAttemptedFailed =
    outcomes.length > 0 && !anySucceeded && anyFailed;
  const exactOrGraphCandidate = candidates.some(
    (candidate) =>
      candidate.tier === 0 || candidate.lanes.includes("graph"),
  );
  if (
    allAttemptedFailed &&
    !hasOverlay &&
    !exactOrGraphCandidate
  ) {
    return { level: "insufficient", lanes };
  }

  const lexicalSucceeded = [...laneOutcomes.entries()].some(
    ([lane, outcome]) =>
      lane.endsWith(":fts") && outcome.succeeded,
  );
  const vectorSucceeded = [...laneOutcomes.entries()].some(
    ([lane, outcome]) =>
      lane.includes(":vector:") && outcome.succeeded,
  );
  const hasObservedOutcomes = outcomes.length > 0;
  const hasLexical = hasObservedOutcomes
    ? lexicalSucceeded || hasOverlay
    : symbolFts || fileSummaryFts || hasOverlay;
  const hasVector = hasObservedOutcomes
    ? vectorSucceeded
    : symbolVector || fileSummaryVector;
  if (hasObservedOutcomes && anyFailed && (hasLexical || hasVector)) {
    return { level: "hybrid-partial", lanes };
  }
  if (hasVector) {
    const threshold =
      loadConfig().semantic?.retrieval?.fusion
        .partialCoverageThresholdPermille ?? 1000;
    const coverage = [
      ...(symbolVector
        ? [capabilities?.coveragePermille.symbolVector ?? 0]
        : []),
      ...(fileSummaryVector
        ? [capabilities?.coveragePermille.fileSummaryVector ?? 0]
        : []),
    ];
    return {
      level:
        hasLexical &&
        coverage.every((value) => value >= threshold)
          ? "hybrid"
          : "hybrid-partial",
      lanes,
    };
  }
  if (hasLexical) return { level: "lexical", lanes };
  if (candidates.some((candidate) => candidate.tier === 0)) {
    return {
      level: "graph-only",
      lanes: [...lanes, { id: "graph", available: true }],
    };
  }
  return { level: "insufficient", lanes };
}

interface ContextReadSnapshotDependencies {
  prewarmEmbeddingPromises: typeof prewarmRetrievalEmbeddingPromises;
  withExclusiveReadConnection: typeof withExclusiveReadConnection;
  runAfterGraphRetrievalAdmission: typeof runAfterGraphRetrievalAdmission;
  withReadOnlyTransaction: typeof withReadOnlyTransaction;
  getOverlaySnapshot: typeof getOverlaySnapshot;
  createRetrievalQueryContext: typeof createRetrievalQueryContext;
}

const DEFAULT_READ_SNAPSHOT_DEPENDENCIES: ContextReadSnapshotDependencies = {
  prewarmEmbeddingPromises: prewarmRetrievalEmbeddingPromises,
  withExclusiveReadConnection,
  runAfterGraphRetrievalAdmission,
  withReadOnlyTransaction,
  getOverlaySnapshot,
  createRetrievalQueryContext,
};

/** @internal Exported for focused transaction-boundary regression tests. */
export async function defaultRunReadSnapshot<T>(
  repoId: string,
  fn: (runtime: ContextEngineRuntime) => Promise<T>,
  prewarm: ContextEmbeddingPrewarmInput,
  dependencies: ContextReadSnapshotDependencies =
    DEFAULT_READ_SNAPSHOT_DEPENDENCIES,
): Promise<T> {
  // Fail before model inference. The in-snapshot assertion in retrieval remains
  // the TOCTOU guard after prewarm completes.
  await dependencies.withExclusiveReadConnection((conn) =>
    dependencies.runAfterGraphRetrievalAdmission(
      conn,
      repoId,
      async () => undefined,
    ),
  );
  const embeddingPromises = await dependencies.prewarmEmbeddingPromises(
    prewarm.query,
    { includeFileSummary: prewarm.includeFileSummary },
  );
  return dependencies.withExclusiveReadConnection((conn) => {
    return dependencies.withReadOnlyTransaction(conn, async () => {
      // Both the durable and draft views are fixed once per request.
      const overlaySnapshot = dependencies.getOverlaySnapshot(repoId);
      const queryContext = dependencies.createRetrievalQueryContext({
        connection: conn,
        embeddingPromises,
      });
      return fn({ conn, overlaySnapshot, queryContext });
    });
  });
}

async function defaultRetrieve(
  request: ContextV2Request,
  profile: TaskProfile,
  runtime: ContextEngineRuntime,
): Promise<ContextRetrievalStageResult> {
  const { conn, overlaySnapshot, queryContext } = runtime;
  if (!conn || !overlaySnapshot || !queryContext) {
    throw new Error("Context read snapshot was not initialized");
  }
  await assertGraphRetrievalAvailable(conn, request.repoId);
  const version = await ladybugDb.getLatestVersion(conn, request.repoId);
  if (!version) {
    return {
      level: "insufficient",
      lanes: [],
      candidates: [],
      runtime,
    };
  }

  const mentions = uniqueStrings([
    ...(request.focusSymbols ?? []),
    ...(request.chatMentions ?? []),
    ...autoExtractMentions(request.taskText),
  ]);
  const tierZeroMentions = tierZeroMentionsForRequest(request);
  const derivedTierOneMentions =
    derivedTierOneMentionsForRequest(request);
  const [resolved, derivedResolved, pathResolution] = await Promise.all([
    resolveSeedSymbols(conn, request.repoId, tierZeroMentions),
    resolveSeedSymbols(
      conn,
      request.repoId,
      derivedTierOneMentions,
    ),
    resolveFocusPaths(
      conn,
      request.repoId,
      request.focusPaths ?? [],
      overlaySnapshot,
    ),
  ]);

  if (pathResolution.unavailableExactFiles.length > 0) {
    throw new FocusPathUnavailableError(
      pathResolution.unavailableExactFiles,
    );
  }

  const explicitTier0Ids = uniqueStrings(
    [
      ...resolved.evidence.resolved,
      ...resolveOverlayMentionSymbolIds(
        overlaySnapshot,
        tierZeroMentions,
      ),
    ],
  );
  const explicitTier0Set = new Set(explicitTier0Ids);
  const pathAllocation = allocateFocusPathSymbols(
    pathResolution.exactFileSymbolHits.filter(
      (hit) => !explicitTier0Set.has(hit.symbolId),
    ),
    focusPathTierZeroCapacity({
      maxTokens: request.budget.maxTokens,
      explicitTierZeroCount: explicitTier0Ids.length,
      profile,
    }),
  );
  const tier0Ids = uniqueStrings([
    ...explicitTier0Ids,
    ...pathAllocation.tierZeroIds,
  ]);
  const candidateResult = await searchContextCandidates(
    conn,
    {
      repoId: request.repoId,
      graphVersionId: version.versionId,
      query: request.taskText,
      limit: CANDIDATE_LIMIT,
      includeFileSummary: profileUsesAuxiliaryLane(
        profile,
        "fileSummary",
      ),
      includeTests: request.includeTests ?? profile.includeTests,
      symbolsPerFileSummary: SYMBOLS_PER_FILE_SUMMARY,
      chatMentions: mentions,
      pinnedSymbolIds: tier0Ids,
      focusPathPrefixes: pathResolution.directoryPrefixes,
      exactIdentifierSymbolIds: uniqueStrings([
        ...tier0Ids,
        ...derivedResolved.evidence.resolved,
        ...resolveOverlayMentionSymbolIds(
          overlaySnapshot,
          derivedTierOneMentions,
        ),
        // Only the bounded Tier 0 focus allocation is exact/pinned; other
        // symbols in a focused file must still earn admission by relevance.
      ]),
    },
    queryContext,
    overlaySnapshot,
  );
  const candidates: ContextCandidate[] = candidateResult.rows.map(
    (row, index) => ({
      symbolId: row.symbolId,
      path: row.filePath,
      hasTestCaseFacet: row.hasTestCaseFacet,
      rank: index + 1,
      tier: row.tier,
      lanes: lanesFromCandidateProvenance(row.provenance),
      sourceRanks: row.sourceRanks,
      estimates: CANDIDATE_ESTIMATES,
    }),
  );
  const retrieval = buildRetrievalState(
    candidateResult.capabilities,
    candidates,
    queryContext.laneOutcomes,
    profile,
  );
  return {
    ...retrieval,
    candidates,
    runtime: { ...runtime, versionId: version.versionId },
  };
}

export async function defaultExpand(
  {
    request,
    profile,
    candidates,
    runtime,
  }: ContextExpandInput,
  beamSearch: typeof beamSearchLadybug = beamSearchLadybug,
): Promise<ContextCandidate[]> {
  if (!runtime.conn || candidates.length === 0) return candidates;
  const seeds = candidates.slice(0, EXPANSION_SEED_LIMIT);
  const startNodes: ResolvedStartNode[] = seeds.map((candidate) => ({
    symbolId: candidate.symbolId,
    source: candidate.tier === 0 ? "entrySymbol" : "taskText",
  }));
  const config = loadConfig();
  const edgeWeights = config.slice?.edgeWeights ?? {
    call: 1,
    import: 0.6,
    config: 0.8,
    implements: 0.9,
  };
  const beamRequest: BeamSearchRequest = {
    entrySymbols: seeds
      .filter((candidate) => candidate.tier === 0)
      .map((candidate) => candidate.symbolId),
    taskText: request.taskText,
    direction: profile.direction,
    maxDepth: profile.maxDepth,
  };
  const beam = await beamSearch(
    runtime.conn,
    request.repoId,
    startNodes,
    {
      maxCards: EXPANSION_CARD_LIMIT,
      maxEstimatedTokens: request.budget.maxTokens,
    },
    beamRequest,
    edgeWeights,
    0.5,
    undefined,
    undefined,
    runtime.overlaySnapshot,
  );
  const known = new Set(candidates.map((candidate) => candidate.symbolId));
  const expandedIds = [...beam.sliceCards].filter(
    (symbolId) => !known.has(symbolId),
  );
  const expanded = await buildMetadataCandidates(
    runtime.conn,
    request.repoId,
    expandedIds,
    1,
    ["graph"],
    runtime.overlaySnapshot,
  );
  const includeTests =
    request.includeTests ?? getTaskProfile(request.taskType).includeTests;
  const eligibleExpanded = expanded.filter(
    (candidate) =>
      includeTests ||
      !isTestCandidate(candidate.path, candidate.hasTestCaseFacet === true),
  );
  return [
    ...candidates,
    ...eligibleExpanded.map((candidate, index) => ({
      ...candidate,
      rank: candidates.length + index + 1,
    })),
  ];
}

async function defaultPrepareHydration({
  request,
  selected,
  runtime,
}: Omit<ContextHydrateInput, "prepared">): Promise<PreparedContextHydrationPlan> {
  if (!runtime.conn || !runtime.versionId || !runtime.overlaySnapshot) {
    throw new Error("Context hydration snapshot was not initialized");
  }
  return prepareContextHydrationPlan({
    conn: runtime.conn,
    repoId: request.repoId,
    versionId: runtime.versionId,
    selected,
    overlaySnapshot: runtime.overlaySnapshot,
  });
}

async function defaultHydrate({
  request,
  selected,
  runtime,
  prepared,
}: ContextHydrateInput): Promise<ContextHydrateResult> {
  if (
    !runtime.conn ||
    !runtime.versionId ||
    !runtime.overlaySnapshot
  ) {
    return { evidence: [], edges: [], unavailable: [] };
  }
  return hydrateContextBundles({
    conn: runtime.conn,
    repoId: request.repoId,
    versionId: runtime.versionId,
    selected,
    identifiers: identifiersForContextRequest(request),
    overlaySnapshot: runtime.overlaySnapshot,
    prepared,
  });
}

const DEFAULT_DEPENDENCIES: ContextEngineV2Dependencies = {
  runReadSnapshot: defaultRunReadSnapshot,
  retrieve: defaultRetrieve,
  expand: defaultExpand,
  prepareHydration: defaultPrepareHydration,
  hydrate: defaultHydrate,
};

function sortOmitted(
  omitted: readonly OmittedContextItem[],
): OmittedContextItem[] {
  return [...omitted].sort(
    (left, right) =>
      left.tier - right.tier ||
      // A missing card is first coverage; skeleton and hot path are upgrades.
      (left.rung === "card" ? 0 : 1) -
        (right.rung === "card" ? 0 : 1) ||
      left.rank - right.rank ||
      left.symbolId.localeCompare(right.symbolId) ||
      left.rung.localeCompare(right.rung),
  );
}

function uniqueActions(
  omitted: readonly OmittedContextItem[],
): LogicalAction[] {
  const actions = new Map<string, LogicalAction>();
  for (const item of omitted) {
    const key = `${item.action.id}\0${JSON.stringify(item.action.args)}`;
    if (!actions.has(key)) actions.set(key, item.action);
    if (actions.size >= 1) break;
  }
  return [...actions.values()];
}

function emptyContextPayload(
  taskType: ContextV2Request["taskType"],
  retrieval: ContextRetrievalStageResult,
): ContextPayload {
  if (retrieval.level === "insufficient") {
    throw new Error(
      "Cannot build a successful context envelope for insufficient retrieval",
    );
  }
  return {
    status: "empty",
    taskType,
    retrieval: {
      level: retrieval.level,
      lanes: retrieval.lanes,
    },
    evidence: [],
    edges: [],
    omitted: {
      total: 0,
      byReason: { budget: 0 },
      highestRanked: [],
    },
    nextActions: [],
  };
}

export class ContextEngineV2 {
  private readonly dependencies: ContextEngineV2Dependencies;

  constructor(
    overrides: Partial<ContextEngineV2Dependencies> = {},
  ) {
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  }

  async buildContext(
    request: ContextV2Request,
  ): Promise<ContextEngineV2Result> {
    const profile = getTaskProfile(request.taskType);
    const identifiers = identifiersForContextRequest(request);
    let snapshot: {
      retrieval: ContextRetrievalStageResult;
      selection?: ReturnType<typeof selectContextBundles>;
      prepared?: PreparedContextHydrationPlan;
      budgetError?: ContextBudgetError;
    };
    try {
      snapshot = await this.dependencies.runReadSnapshot(
        request.repoId,
        async (runtime) => {
          const retrieval = await this.dependencies.retrieve(
            request,
            profile,
            runtime,
          );
          if (
            retrieval.level === "insufficient"
          ) {
            return { retrieval };
          }
          const emptyPayload = emptyContextPayload(
            request.taskType,
            retrieval,
          );
          const budgetCheck = enforceContextBudget(
            emptyPayload,
            request.budget.maxTokens,
            identifiers,
          );
          if (budgetCheck.budgetError) {
            return {
              retrieval,
              budgetError: budgetCheck.budgetError,
            };
          }
          if (retrieval.candidates.length === 0) {
            return { retrieval };
          }
          const expanded = await this.dependencies.expand({
            request,
            profile,
            candidates: retrieval.candidates,
            runtime: retrieval.runtime,
          });
          const selection = selectContextBundles({
            candidates: expanded,
            profile,
            availableTokens: Math.max(
              0,
              request.budget.maxTokens -
                estimateContextSelectionEnvelopeTokens(emptyPayload),
            ),
            identifiersToFind: identifiers,
          });
          const prepared = await this.dependencies.prepareHydration({
            request,
            profile,
            selected: selection.selected,
            runtime: retrieval.runtime,
          });
          return { retrieval, selection, prepared };
        },
        {
          query: request.taskText,
          includeFileSummary: profileUsesAuxiliaryLane(
            profile,
            "fileSummary",
          ),
        },
      );
    } catch (error) {
      if (error instanceof FocusPathUnavailableError) {
        return focusPathUnavailableError(request, error.paths);
      }
      if (error instanceof GraphRetrievalUnavailableError) {
        return recoveryError();
      }
      throw error;
    }
    const { retrieval } = snapshot;
    if (retrieval.level === "insufficient") {
      return retrievalBackendError(request);
    }
    if (snapshot.budgetError) return snapshot.budgetError;

    if (retrieval.candidates.length === 0) {
      const enforced = enforceContextBudget(
        emptyContextPayload(request.taskType, retrieval),
        request.budget.maxTokens,
        identifiers,
      );
      return enforced.budgetError ?? enforced.payload;
    }

    const { selection, prepared } = snapshot;
    if (!selection || !prepared) {
      throw new Error("Context hydration plan was not prepared");
    }
    const hydrated = await this.dependencies.hydrate({
      request,
      profile,
      selected: selection.selected,
      runtime: retrieval.runtime,
      prepared,
    });
    const omitted = sortOmitted([
      ...selection.omitted,
      ...hydrated.unavailable,
    ]);
    const budgetOmitted = omitted.filter(
      (item) => item.reason === "budget",
    ).length;
    const unavailableOmitted = omitted.length - budgetOmitted;
    const payload: ContextPayload = {
      status:
        omitted.length > 0 || hydrated.evidence.length === 0
          ? "budgetLimited"
          : "complete",
      taskType: request.taskType,
      retrieval: {
        level: retrieval.level,
        lanes: retrieval.lanes,
      },
      evidence: hydrated.evidence,
      edges: hydrated.edges,
      omitted: {
        total: omitted.length,
        byReason: {
          budget: budgetOmitted,
          ...(unavailableOmitted > 0
            ? { unavailable: unavailableOmitted }
            : {}),
        },
        highestRanked: omitted.slice(0, OMITTED_CAP),
      },
      nextActions: uniqueActions(omitted),
    };
    const enforced = enforceContextBudget(
      payload,
      request.budget.maxTokens,
      identifiers,
    );
    return enforced.budgetError ?? enforced.payload;
  }
}
