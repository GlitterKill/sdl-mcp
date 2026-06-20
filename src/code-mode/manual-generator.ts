import { createActionMap } from "../gateway/router.js";
import type { LiveIndexCoordinator } from "../live-index/types.js";
import { logger } from "../util/logger.js";
import { loadConfig } from "../config/loadConfig.js";
import { anyRepoHasMemoryTools } from "../config/memory-config.js";

const MEMORY_FN_NAMES = new Set([
  "memoryStore",
  "memoryQuery",
  "memoryRemove",
  "memorySurface",
]);
const MEMORY_ACTIONS = new Set([
  "memory.store",
  "memory.query",
  "memory.remove",
  "memory.surface",
]);

export const FN_NAME_MAP: Record<string, string> = {
  symbolSearch: "symbol.search",
  symbolGetCard: "symbol.getCard",
  symbolEdit: "symbol.edit",
  sliceBuild: "slice.build",
  sliceRefresh: "slice.refresh",
  sliceSpilloverGet: "slice.spillover.get",
  deltaGet: "delta.get",
  prRiskAnalyze: "pr.risk.analyze",
  codeNeedWindow: "code.needWindow",
  codeSkeleton: "code.getSkeleton",
  codeHotPath: "code.getHotPath",
  repoRegister: "repo.register",
  repoStatus: "repo.status",
  repoOverview: "repo.overview",
  indexRefresh: "index.refresh",
  policyGet: "policy.get",
  policySet: "policy.set",
  agentFeedback: "agent.feedback",
  agentFeedbackQuery: "agent.feedback.query",
  bufferPush: "buffer.push",
  bufferCheckpoint: "buffer.checkpoint",
  bufferStatus: "buffer.status",
  runtimeExecute: "runtime.execute",
  runtimeQueryOutput: "runtime.queryOutput",
  responseGet: "response.get",
  memoryStore: "memory.store",
  memoryQuery: "memory.query",
  memoryRemove: "memory.remove",
  memorySurface: "memory.surface",
  usageStats: "usage.stats",
  fileRead: "file.read",
  fileWrite: "file.write",
  searchEdit: "search.edit",
  semanticEnrichmentRefresh: "semantic.enrichment.refresh",
  semanticEnrichmentStatus: "semantic.enrichment.status",
};

export const ACTION_TO_FN: Record<string, string> = Object.fromEntries(
  Object.entries(FN_NAME_MAP).map(([fn, action]) => [action, fn]),
);

/**
 * Get the active FN_NAME_MAP, filtering out memory entries when memory is disabled.
 */
export function getActiveFnNameMap(): Record<string, string> {
  if (anyRepoHasMemoryTools(loadConfig())) return FN_NAME_MAP;
  const filtered: Record<string, string> = {};
  for (const [fn, action] of Object.entries(FN_NAME_MAP)) {
    if (!MEMORY_FN_NAMES.has(fn)) filtered[fn] = action;
  }
  return filtered;
}

/**
 * Get the active ACTION_TO_FN, filtering out memory entries when memory is disabled.
 */
export function getActiveActionToFn(): Record<string, string> {
  if (anyRepoHasMemoryTools(loadConfig())) return ACTION_TO_FN;
  const filtered: Record<string, string> = {};
  for (const [action, fn] of Object.entries(ACTION_TO_FN)) {
    if (!MEMORY_ACTIONS.has(action)) filtered[action] = fn;
  }
  return filtered;
}

const MANUAL_TEMPLATE = `// SDL-MCP API - use sdl.context for context retrieval, sdl.workflow for multi-step operations
// repoId is set in the workflow envelope, not per-step.
// Reference prior step results with ${"$"}N (e.g., ${"$"}0.results[0].symbolId).
// Discovery limits: sdl.action.search limit <= 50; workflowContinuationGet limit <= 1000; runtimeExecute maxResponseLines 5..1000; shell runtime requires code.
// Edit: symbolEdit one symbol; searchEdit identifier/structural/operations[] batches; runtimeExecute stdin for multiline.
// sdl.context budgets accept maxTokens/maxEstimatedTokens, not maxCards.
// Use wireFormat:"json" for symbol.search/sliceBuild when ${"$"}N refs need fields.

type RM = "inline"|"auto"|"handle"; type DM = "off"|"auto"; type ResponseHandle = { kind: "responseArtifact"; handle: string; action: "response.get" };
type SQ = { literal?: string; regex?: string; replacement?: string; global?: boolean; structural?: { language?: string; treeSitterQuery: string; capture?: string; requiredCaptures?: Record<string,string>; replacement?: string }; symbolRef?: object; symbolIds?: string[]; replaceLines?: object; insertAt?: object; content?: string; append?: string };
type EM = "replacePattern"|"replaceLines"|"insertAt"|"append"|"overwrite"; type ST = "text"|"symbol"|"identifier"|"structural"; type SEOps = { id?: string; targeting: ST; query: SQ; editMode: EM; filters?: object; maxFiles?: number; maxMatchesPerFile?: number; maxTotalMatches?: number };
type SEO = { kind: "replaceSymbol"|"replaceBody"|"replaceSignature"|"insertBefore"|"insertAfter"; content: string } | { kind: "renameLocal"; name: string; replacement: string }; type SR = { startLine: number; startCol: number; endLine: number; endCol: number }

// === Query ===
/** Search symbols by name/pattern */
function symbolSearch(p: { query: string; kinds?: string[]; limit?: number; semantic?: boolean }): { results: { symbolId: string; name: string; kind: string; file: string; relevance?: number }[] }
/** Get symbol card (metadata, deps, metrics) */
function symbolGetCard(p: { symbolId: string; ifNoneMatch?: string }): { card: object; etag: string } | { notModified: true }
/** Symbol-scoped edit with snapshot preconditions */
function symbolEdit(p: { mode: "preview"; symbolId?: string; symbolRef?: object; operation: SEO; createBackup?: boolean } | { mode: "apply"; planHandle: string; createBackup?: boolean } | { mode: "applyNow"; symbolId: string; expectedAstFingerprint: string; expectedRange: SR; operation: SEO; createBackup?: boolean }): { mode: "preview"|"apply"; planHandle: string; symbolId: string; file: string; writeTarget: "file"|"draft"; validation: object }
/** Build dependency graph slice */
function sliceBuild(p: { taskText?: string; entrySymbols?: string[]; budget?: { maxCards?: number; maxEstimatedTokens?: number }; wireFormat?: "json"|"standard"|"readable"|"compact"|"agent"|"packed"|"auto" }): { sliceHandle: string; slice?: object }
/** Refresh existing slice (delta only) */
function sliceRefresh(p: { sliceHandle: string; knownVersion?: string }): { added: object[]; removed: string[]; changed: object[] }
/** Fetch spillover page */
function sliceSpilloverGet(p: { spilloverHandle: string; page?: number; pageSize?: number }): { cards: object[]; hasMore: boolean }
/** Get delta between versions */
function deltaGet(p: { fromVersion?: string; toVersion?: string; includeBlastRadius?: boolean }): { changed: object[]; blastRadius?: object[] }
/** Analyze PR risk */
function prRiskAnalyze(p: { fromVersion: string; toVersion: string; riskThreshold?: number }): { riskItems: object[]; summary: string }

// === Code (ladder: card -> skeleton -> hotPath -> needWindow) ===
/** Get skeleton IR (signatures + control flow) */
function codeSkeleton(p: { symbolId?: string; file?: string; exportedOnly?: boolean; ifNoneMatch?: string }): { skeleton: string; etag: string } | { notModified: true; etag: string }
/** Get hot-path excerpt for specific identifiers */
function codeHotPath(p: { symbolId: string; identifiersToFind: string[]; contextLines?: number; ifNoneMatch?: string }): { excerpt: string; foundIdentifiers: string[]; etag: string } | { notModified: true; etag: string }
/** Request raw code window (requires justification) */
function codeNeedWindow(p: { symbolId: string; reason: string; expectedLines: number; identifiersToFind: string[]; maxTokens?: number; responseMode?: RM; deltaMode?: DM; maxDeltaLines?: number }): object | ResponseHandle

// === Repo ===
/** Register a repository */
function repoRegister(p: { rootPath: string }): { repoId: string }
/** Get repository status */
function repoStatus(): { status: object }
/** Get codebase overview */
function repoOverview(p: { level?: "stats" | "directories" | "full"; ifNoneMatch?: string }): object
/** Refresh index */
function indexRefresh(p: { mode: "full" | "incremental"; async?: boolean; includeDiagnostics?: boolean }): object
/** Get policy config */
function policyGet(): { policy: object }
/** Set policy config */
function policySet(p: { policyPatch: { maxWindowLines?: number; maxWindowTokens?: number; requireIdentifiers?: boolean; allowBreakGlass?: boolean; defaultDenyRaw?: boolean } }): { policy: object }

// === Semantic Providers ===
/** Refresh semantic enrichment source selection */
function semanticEnrichmentRefresh(p: { dryRun?: boolean; force?: boolean; install?: boolean; languages?: string[] }): { status: string }
/** Report semantic enrichment status */
function semanticEnrichmentStatus(p: { languages?: string[] }): { status: object }
// === Memory ===
/** Store a development memory */
function memoryStore(p: { type: "decision"|"bugfix"|"task_context"|"pattern"|"convention"|"architecture"|"performance"|"security"; title: string; content: string; tags?: string[]; symbolIds?: string[]; fileRelPaths?: string[] }): { memoryId: string }
/** Query memories */
function memoryQuery(p: { query?: string; types?: string[]; tags?: string[]; limit?: number }): { memories: object[] }
/** Soft-delete a memory */
function memoryRemove(p: { memoryId: string }): { removed: boolean }
/** Auto-surface relevant memories */
function memorySurface(p: { symbolIds?: string[]; fileIds?: string[]; taskText?: string; limit?: number }): { memories: object[] }

// === Context / Agent ===
/** Record agent feedback */
function agentFeedback(p: { versionId: string; sliceHandle: string; usefulSymbols: string[]; missingSymbols?: string[]; rating?: string; comment?: string }): { recorded: boolean }
/** Query feedback records */
function agentFeedbackQuery(p: { limit?: number }): { records: object[] }
/** Push buffer update */
function bufferPush(p: { eventType: "open"|"change"|"save"|"close"|"checkpoint"; filePath: string; content: string; version: number; dirty: boolean; timestamp: string }): { accepted: boolean }
/** Request buffer checkpoint */
function bufferCheckpoint(): { checkpointed: boolean }
/** Get buffer status */
function bufferStatus(): { status: object }
/** Execute runtime command; pass stdin for multiline scripts/input instead of quote-heavy shell payloads */
function runtimeExecute(p: { runtime: string; executable?: string; args?: string[]; code?: string; stdin?: string; relativeCwd?: string; timeoutMs?: number; queryTerms?: string[]; maxResponseLines?: number; persistOutput?: boolean; outputMode?: "minimal"|"summary"|"intent" }): { status: string; exitCode: number; durationMs: number; artifactHandle?: string; stdoutSummary?: string; stdinBytes?: number; stdinSha256?: string; quotingWarnings?: string[]; serverDriftWarnings?: string[]; nextAction?: object }
/** Query stored runtime output by keywords or exact line range */
function runtimeQueryOutput(p: { artifactHandle: string; queryTerms?: string[]; cursor?: { stream: "stdout"|"stderr"; afterLine: number }; lineRange?: { stream: "stdout"|"stderr"; startLine: number; endLine: number }; maxExcerpts?: number; contextLines?: number; stream?: "stdout"|"stderr"|"both" }): { excerpts: object[]; matchStatus: "matched"|"noMatchFallback"|"lineRange"; matchCount: number; nextCursor?: object }
/** Retrieve a large tool response by handle */
function responseGet(p: { handle: string; full?: boolean; maxBytes?: number; maxTokens?: number; offsetBytes?: number; jsonPath?: string }): { content: unknown; truncated: boolean; metadata: object }

// === Usage ===
/** Get cumulative token savings statistics */
function usageStats(p: { scope?: "session" | "history" | "both"; since?: string; limit?: number }): { totalSdlTokens: number; totalSavedTokens: number; savingsPercent: number }

// === File ===
/** Read non-indexed file content (templates, configs, docs) */
function fileRead(p: { filePath: string; maxBytes?: number; offset?: number; limit?: number; search?: string; searchContext?: number; jsonPath?: string; responseMode?: RM; deltaMode?: DM; maxDeltaLines?: number }): { content: string; bytes: number; totalLines: number; returnedLines: number; truncated: boolean; sessionDelta?: object; delta?: object } | ResponseHandle
function fileWrite(p: { filePath: string; content?: string; replaceLines?: { start: number; end: number; content: string }; replacePattern?: { pattern: string; replacement: string; global?: boolean }; jsonPath?: string; jsonValue?: unknown; insertAt?: { line: number; content: string }; append?: string; createBackup?: boolean; createIfMissing?: boolean }): { filePath: string; bytesWritten: number; linesWritten: number; mode: string; backupPath?: string; replacementCount?: number }
/** Cross-file search-and-edit: preview computes a plan; identifier/structural targeting and operations[] batch safer replacements into one shared preview/apply */
function searchEdit(p: { mode: "preview"; targeting?: ST; query?: SQ; editMode?: EM; operations?: SEOps[]; filters?: object; maxFiles?: number; createBackup?: boolean; responseMode?: RM } | { mode: "apply"; planHandle: string; createBackup?: boolean }): object | ResponseHandle

// === Data Transforms (workflow-only) ===
/** Project fields from an object */
function dataPick(p: { input: unknown; fields: Record<string, string> }): object
/** Project fields from each element of an array */
function dataMap(p: { input: unknown[]; fields: Record<string, string> }): object[]
/** Filter array elements by clauses */
function dataFilter(p: { input: unknown[]; clauses: Array<{path: string; op: "eq"|"ne"|"gt"|"gte"|"lt"|"lte"|"contains"|"in"|"exists"; value?: unknown}>; mode?: "all"|"any" }): object[]
/** Sort array elements by a field. Uses 'by' (NOT field/order) */
function dataSort(p: { input: unknown[]; by: {path: string; direction?: "asc"|"desc"; type?: "string"|"number"|"date"|"boolean"} }): object[]
/** Render {{mustache}} template strings from object(s) */
function dataTemplate(p: { input: Record<string, unknown> | unknown[]; template: string; joinWith?: string }): string

// === Compact Wire Format Decode Guide (sliceBuild with wireFormat: "compact") ===
// Top-level: wf=wireFormat, wv=wireVersion, vid=versionId, b={mc=maxCards, mt=maxTokens}
// ss=seedSymbols(truncated IDs), si=symbolIndex(truncated IDs), fp=filePaths, et=edgeTypes
// Card (c[]): fi=fileIndex(into fp), r=[startLine,startCol,endLine,endCol], k=kind, n=name
//   x=exported, d={i=imports[], c=calls[]}, sig=signature, sum=summary, inv=invariants
//   se=sideEffects, m={fi=fanIn,fo=fanOut,ch=churn30d,t=testRefs}, dl=detailLevel
// Edge (e[]): [fromCardIdx, toCardIdx, edgeTypeIdx, weight]
// Frontier (f[]): ci=cardIndex(-1=not in slice), s=score, w=why(c=call,i=import,e=entry)
// Truncation (t): tr=truncated, dc=droppedCards, de=droppedEdges, res={t=type, v=value}
// CardRef (cr[]): ci=cardIndex, sid=fullSymbolId, e=etag, dl=detailLevel (used with knownCardEtags)
`;

export function generateManual(_liveIndex?: LiveIndexCoordinator): string {
  const actionMap = createActionMap(_liveIndex);
  const actionKeys = Object.keys(actionMap);
  const activeFnMap = getActiveFnNameMap();
  const mappedActions = Object.values(activeFnMap);
  for (const key of actionKeys) {
    if (!mappedActions.includes(key)) {
      logger.warn(`[code-mode] action "${key}" not in FN_NAME_MAP`);
    }
  }

  const memoryVisible = anyRepoHasMemoryTools(loadConfig());
  if (memoryVisible) {
    return MANUAL_TEMPLATE;
  }

  // Strip the "// === Memory ===" section from the manual when memory is disabled.
  const lines = MANUAL_TEMPLATE.split("\n");
  const filtered: string[] = [];
  let inMemorySection = false;
  for (const line of lines) {
    if (line.startsWith("// === Memory ===")) {
      inMemorySection = true;
      continue;
    }
    if (inMemorySection && line.startsWith("// ===")) {
      // Hit the next section marker, stop skipping
      inMemorySection = false;
    }
    if (!inMemorySection) {
      filtered.push(line);
    }
  }
  return filtered.join("\n");
}

let cachedManual: string | null = null;
let cachedManualMemoryVisible: boolean | null = null;

export function getManualCached(liveIndex?: LiveIndexCoordinator): string {
  const memoryVisible = anyRepoHasMemoryTools(loadConfig());
  if (cachedManual === null || cachedManualMemoryVisible !== memoryVisible) {
    cachedManual = generateManual(liveIndex);
    cachedManualMemoryVisible = memoryVisible;
  }
  return cachedManual;
}

export function invalidateManualCache(): void {
  cachedManual = null;
  cachedManualMemoryVisible = null;
}
