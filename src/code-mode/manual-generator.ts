import { createActionMap } from "../gateway/router.js";
import type { LiveIndexCoordinator } from "../live-index/types.js";
import { logger } from "../util/logger.js";

export const FN_NAME_MAP: Record<string, string> = {
  symbolSearch: "symbol.search",
  symbolGetCard: "symbol.getCard",
  symbolGetCards: "symbol.getCards",
  sliceBuild: "slice.build",
  sliceRefresh: "slice.refresh",
  sliceSpilloverGet: "slice.spillover.get",
  deltaGet: "delta.get",
  contextSummary: "context.summary",
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
  agentContext: "agent.context",
  agentFeedback: "agent.feedback",
  agentFeedbackQuery: "agent.feedback.query",
  bufferPush: "buffer.push",
  bufferCheckpoint: "buffer.checkpoint",
  bufferStatus: "buffer.status",
  runtimeExecute: "runtime.execute",
  runtimeQueryOutput: "runtime.queryOutput",
  memoryStore: "memory.store",
  memoryQuery: "memory.query",
  memoryRemove: "memory.remove",
  memorySurface: "memory.surface",
  usageStats: "usage.stats",
  fileRead: "file.read",
};

export const ACTION_TO_FN: Record<string, string> = Object.fromEntries(
  Object.entries(FN_NAME_MAP).map(([fn, action]) => [action, fn]),
);

const MANUAL_TEMPLATE = `// SDL-MCP API - use sdl.context for context retrieval, sdl.workflow for multi-step operations
// repoId is set in the workflow envelope, not per-step.
// Reference prior step results with $N (e.g., $0.results[0].symbolId).

// === Query ===
/** Search symbols by name/pattern */
function symbolSearch(p: { query: string; kinds?: string[]; limit?: number; semantic?: boolean }): { results: { symbolId: string; name: string; kind: string; file: string; relevance?: number }[] }
/** Get symbol card (metadata, deps, metrics) */
function symbolGetCard(p: { symbolId: string; ifNoneMatch?: string }): { card: { symbolId: string; name: string; kind: string; signature: string; summary: string; deps: object }; etag: string } | { notModified: true }
/** Batch-fetch symbol cards */
function symbolGetCards(p: { symbolIds: string[]; knownEtags?: Record<string,string> }): { cards: object[]; notModified: string[] }
/** Build dependency graph slice */
function sliceBuild(p: { taskText?: string; entrySymbols?: string[]; budget?: { maxCards?: number; maxEstimatedTokens?: number } }): { handle: string; cards: object[]; spilloverCount: number }
/** Refresh existing slice (delta only) */
function sliceRefresh(p: { sliceHandle: string; knownVersion?: string }): { added: object[]; removed: string[]; changed: object[] }
/** Fetch spillover page */
function sliceSpilloverGet(p: { spilloverHandle: string; page?: number; pageSize?: number }): { cards: object[]; hasMore: boolean }
/** Get delta between versions */
function deltaGet(p: { fromVersion?: string; toVersion?: string; includeBlastRadius?: boolean }): { changed: object[]; blastRadius?: object[] }
/** Generate context summary */
function contextSummary(p: { symbolId?: string; file?: string; query?: string; budget?: number; format?: "markdown"|"json"|"clipboard"; scope?: "symbol"|"file"|"task"|"repo" }): { summary: string; tokens: number }
/** Analyze PR risk */
function prRiskAnalyze(p: { fromVersion: string; toVersion: string; riskThreshold?: number }): { riskItems: object[]; summary: string }

// === Code (ladder: card -> skeleton -> hotPath -> needWindow) ===
/** Get skeleton IR (signatures + control flow) */
function codeSkeleton(p: { symbolId?: string; file?: string; exportedOnly?: boolean }): { skeleton: string }
/** Get hot-path excerpt for specific identifiers */
function codeHotPath(p: { symbolId: string; identifiersToFind: string[]; contextLines?: number }): { excerpt: string; foundIdentifiers: string[] }
/** Request raw code window (requires justification) */
function codeNeedWindow(p: { symbolId: string; reason: string; expectedLines: number; identifiersToFind: string[]; maxTokens?: number }): { code: string; approved: boolean }

// === Repo ===
/** Register a repository */
function repoRegister(p: { rootPath: string }): { repoId: string }
/** Get repository status */
function repoStatus(): { status: object }
/** Get codebase overview */
function repoOverview(p: { level?: "stats" | "directories" | "full" }): { overview: object }
/** Refresh index */
function indexRefresh(p: { mode?: "full" | "incremental" }): { indexed: number; duration: number }
/** Get policy config */
function policyGet(): { policy: object }
/** Set policy config */
function policySet(p: { policyPatch: { maxWindowLines?: number; maxWindowTokens?: number; requireIdentifiers?: boolean; allowBreakGlass?: boolean; defaultDenyRaw?: boolean } }): { policy: object }

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
/** Retrieve multi-rung task context */
function agentContext(p: { taskType: "debug" | "review" | "implement" | "explain"; taskText: string; budget?: { maxTokens?: number; maxActions?: number; maxDurationMs?: number }; options?: { focusSymbols?: string[]; focusPaths?: string[]; includeTests?: boolean; requireDiagnostics?: boolean; contextMode?: "precise"|"broad" } }): { evidence: object[] }
/** Record agent feedback */
function agentFeedback(p: { versionId: string; sliceHandle: string; usefulSymbols: string[]; missingSymbols?: string[]; rating?: string; comment?: string }): { recorded: boolean }
/** Query feedback records */
function agentFeedbackQuery(p: { limit?: number }): { records: object[] }
/** Push buffer update */
function bufferPush(p: { eventType: "open"|"change"|"save"|"close"|"checkpoint"; filePath: string; version: number; dirty: boolean; timestamp: string; content?: string }): { accepted: boolean }
/** Request buffer checkpoint */
function bufferCheckpoint(): { checkpointed: boolean }
/** Get buffer status */
function bufferStatus(): { status: object }
/** Execute runtime command */
function runtimeExecute(p: { runtime: string; executable?: string; args?: string[]; code?: string; relativeCwd?: string; timeoutMs?: number; queryTerms?: string[]; maxResponseLines?: number; persistOutput?: boolean; outputMode?: "minimal"|"summary"|"intent" }): { status: string; exitCode: number; durationMs: number; artifactHandle?: string; stdoutSummary?: string }
// outputMode defaults to "minimal" (~50 tokens); use "summary" for head+tail, "intent" for queryTerms-only excerpts
/** Query stored runtime output by keywords */
function runtimeQueryOutput(p: { artifactHandle: string; queryTerms: string[]; maxExcerpts?: number; contextLines?: number; stream?: "stdout"|"stderr"|"both" }): { excerpts: object[] }

// === Usage ===
/** Get cumulative token savings statistics */
function usageStats(p: { scope?: "session" | "history" | "both"; since?: string; limit?: number }): { totalSdlTokens: number; totalSavedTokens: number; savingsPercent: number }

// === File ===
/** Read non-indexed file content (templates, configs, docs) */
function fileRead(p: { filePath: string; maxBytes?: number; offset?: number; limit?: number; search?: string; searchContext?: number; jsonPath?: string }): { content: string; bytes: number; totalLines: number; returnedLines: number; truncated: boolean; matchCount?: number; extractedPath?: string }

// === Data Transforms (use inside sdl.workflow steps) ===
// These are internal transforms, NOT gateway actions. Use as workflow step fn names.
// IMPORTANT: 'fields' is Record<string, string> (object mapping outputKey -> inputKey), NOT an array.
// IMPORTANT: First param is always 'input', NOT 'source'.
/** Project fields from an object */
function dataPick(p: { input: unknown; fields: Record<string, string> }): object
// Example: dataPick({"input":"$0","fields":{"name":"name","file":"file"}})
/** Project fields from each element of an array */
function dataMap(p: { input: unknown[]; fields: Record<string, string> }): object[]
// Example: dataMap({"input":"$0.results","fields":{"id":"symbolId","name":"name","file":"file"}})
/** Filter array elements by clauses */
function dataFilter(p: { input: unknown[]; clauses: Array<{path: string; op: "eq"|"ne"|"gt"|"gte"|"lt"|"lte"|"contains"|"in"|"exists"; value?: unknown}>; mode?: "all"|"any" }): object[]
// Example: dataFilter({"input":"$0.results","clauses":[{"path":"kind","op":"eq","value":"function"}]})
/** Sort array elements by a field. Uses 'by' (NOT field/order) */
function dataSort(p: { input: unknown[]; by: {path: string; direction?: "asc"|"desc"; type?: "string"|"number"|"date"|"boolean"} }): object[]
// Example: dataSort({"input":"$0.results","by":{"path":"name","direction":"asc"}})
/** Render {{mustache}} template strings from object(s) */
function dataTemplate(p: { input: Record<string, unknown> | unknown[]; template: string; joinWith?: string }): { text: string }
// Example: dataTemplate({"input":"$0.results","template":"{{name}} ({{kind}}) in {{file}}","joinWith":"\\n"})

// === Compact Wire Format Decode Guide (sliceBuild with wireFormat: "compact") ===
// Top-level: wf=wireFormat, wv=wireVersion, vid=versionId, b={mc=maxCards, mt=maxTokens}
// ss=seedSymbols(truncated IDs), si=symbolIndex(truncated IDs), fp=filePaths, et=edgeTypes
// Card (c[]): fi=fileIndex(into fp), r=[startLine,startCol,endLine,endCol], k=kind, n=name
//   x=exported, d={i=imports[], c=calls[]}, sig=signature, sum=summary, inv=invariants
//   se=sideEffects, m={fi=fanIn,fo=fanOut,ch=churn30d,t=testRefs}, dl=detailLevel
// Edge (e[]): [fromCardIdx, toCardIdx, edgeTypeIdx, weight]
// Frontier (f[]): ci=cardIndex(-1=not in slice), s=score, w=why(c=call,i=import,e=entry)
// Truncation (t): tr=truncated, dc=droppedCards, de=droppedEdges, res={t=type, v=value}
// CardRef (cr[]): ci=cardIndex, e=etag, dl=detailLevel (used with knownCardEtags)
`;

export function generateManual(_liveIndex?: LiveIndexCoordinator): string {
  const actionMap = createActionMap(_liveIndex);
  const actionKeys = Object.keys(actionMap);
  const mappedActions = Object.values(FN_NAME_MAP);
  for (const key of actionKeys) {
    if (!mappedActions.includes(key)) {
      logger.warn(`[code-mode] action "${key}" not in FN_NAME_MAP`);
    }
  }

  return MANUAL_TEMPLATE;
}

let cachedManual: string | null = null;

export function getManualCached(liveIndex?: LiveIndexCoordinator): string {
  if (cachedManual === null) {
    cachedManual = generateManual(liveIndex);
  }
  return cachedManual;
}

export function invalidateManualCache(): void {
  cachedManual = null;
}
