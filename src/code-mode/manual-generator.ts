import type { LiveIndexCoordinator } from "../live-index/types.js";
import { logger } from "../util/logger.js";
import { loadConfig } from "../config/loadConfig.js";
import { anyRepoHasMemoryTools } from "../config/memory-config.js";
import {
  ACTION_TO_FN,
  FN_NAME_MAP,
  GATEWAY_ACTION_DEFINITIONS,
  buildCatalog,
} from "./action-catalog.js";

export { ACTION_TO_FN, FN_NAME_MAP } from "./action-catalog.js";

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

/**
 * Get the active FN_NAME_MAP, filtering out memory entries when memory is disabled.
 */
export function getActiveFnNameMap(
  memoryVisible = anyRepoHasMemoryTools(loadConfig()),
): Readonly<Record<string, string>> {
  if (memoryVisible) return FN_NAME_MAP;
  const filtered: Record<string, string> = {};
  for (const [fn, action] of Object.entries(FN_NAME_MAP)) {
    if (!MEMORY_FN_NAMES.has(fn)) filtered[fn] = action;
  }
  return filtered;
}

/**
 * Get the active ACTION_TO_FN, filtering out memory entries when memory is disabled.
 */
export function getActiveActionToFn(
  memoryVisible = anyRepoHasMemoryTools(loadConfig()),
): Readonly<Record<string, string>> {
  if (memoryVisible) return ACTION_TO_FN;
  const filtered: Record<string, string> = {};
  for (const [action, fn] of Object.entries(ACTION_TO_FN)) {
    if (!MEMORY_ACTIONS.has(action)) filtered[action] = fn;
  }
  return filtered;
}

const MANUAL_TEMPLATE = `// SDL-MCP API
// ${"$"}N refs: ${"$"}0.results[0].symbolId; ${"$"}0.results[*].symbolId -> string[].
// Limits: sdl.action.search limit <= 50; workflowContinuationGet limit <= 1000; runtimeExecute maxResponseLines 5..1000; shell runtime requires code.
// Release-static medians: search150 runtimeDigest120.
// Economy: bounded context evidence; nearMisses.
// sdl.context requires budget.maxTokens; aliases and action/duration budgets are rejected.
// Use wireFormat:"json" for symbol.search/sliceBuild when ${"$"}N refs need fields.
// Continuation recipe: symbolSearch -> workflowContinuationGet(handle,path,offset,limit) -> dataMap/dataTemplate.

type RM = "inline"|"auto"|"handle"; type DM = "off"|"auto"; type ResponseHandle = { kind: "responseArtifact"; handle: string; action: "response.get" };
type SQ = { literal?: string; regex?: string; replacement?: string; global?: boolean; structural?: { language?: string; treeSitterQuery: string; capture?: string; requiredCaptures?: Record<string,string>; replacement?: string }; symbolRef?: object; symbolIds?: string[]; replaceLines?: object; insertAt?: object; content?: string; append?: string };
type EM = "replacePattern"|"replaceLines"|"insertAt"|"append"|"overwrite"; type ST = "text"|"symbol"|"identifier"|"structural"; type SEOps = { id?: string; targeting: ST; query: SQ; editMode: EM; filters?: object; maxFiles?: number; maxMatchesPerFile?: number; maxTotalMatches?: number };
type SEO = { kind: "replaceSymbol"|"replaceBody"|"replaceSignature"|"insertBefore"|"insertAfter"; content: string } | { kind: "renameLocal"; name: string; replacement: string }; type SR = { startLine: number; startCol: number; endLine: number; endCol: number }

// === Discovery ===
/** Action catalog; workflow fn "actionSearch" */
function actionSearch(p: { query: string; limit?: number; includeSchemas?: boolean }): { actions: object[] }
/** Runtime/config status; paths redacted by default */
function info(p?: { redactPaths?: boolean }): object

// === Query ===
/** ~150; nearMisses */
function symbolSearch(p: { query: string; kinds?: string[]; limit?: number; semantic?: boolean }): { results: { symbolId: string; name: string; kind: string; file: string; relevance?: number }[] }
/** Card ~50; refsMode:"off" expands refs */
function symbolGetCard(p: { symbolId: string; ifNoneMatch?: string }): { card: object; etag: string } | { notModified: true }
/** Snapshot-guarded symbol edit */
function symbolEdit(p: { mode: "preview"; symbolId?: string; symbolRef?: object; operation: SEO; createBackup?: boolean } | { mode: "apply"; planHandle: string; createBackup?: boolean } | { mode: "applyNow"; symbolId: string; expectedAstFingerprint: string; expectedRange: SR; operation: SEO; createBackup?: boolean }): { mode: "preview"|"apply"; planHandle: string; symbolId: string; file: string; writeTarget: "file"|"draft"; validation: object }
/** Slice ~1500 */
function sliceBuild(p: { taskText?: string; entrySymbols?: string[]; budget?: { maxCards?: number; maxEstimatedTokens?: number }; wireFormat?: "json"|"standard"|"readable"|"compact"|"agent"|"packed"|"auto" }): { sliceHandle: string; slice?: object }
/** Slice delta */
function sliceRefresh(p: { sliceHandle: string; knownVersion?: string }): { added: object[]; removed: string[]; changed: object[] }
/** Spillover page */
function sliceSpilloverGet(p: { spilloverHandle: string; page?: number; pageSize?: number }): { cards: object[]; hasMore: boolean }
/** Version delta */
function deltaGet(p: { fromVersion?: string; toVersion?: string; includeBlastRadius?: boolean }): { changed: object[]; blastRadius?: object[] }
/** PR risk */
function prRiskAnalyze(p: { fromVersion: string; toVersion: string; riskThreshold?: number }): { riskItems: object[]; summary: string }

// === Code (ladder: card -> skeleton -> hotPath -> needWindow) ===
/** Skeleton IR (~200) */
function codeSkeleton(p: { symbolId?: string; file?: string; exportedOnly?: boolean; ifNoneMatch?: string }): { skeleton: string; etag: string } | { notModified: true; etag: string }
/** Hot-path excerpt (~500) */
function codeHotPath(p: { symbolId: string; identifiersToFind: string[]; contextLines?: number; ifNoneMatch?: string }): { excerpt: string; foundIdentifiers: string[]; etag: string } | { notModified: true; etag: string }
/** Raw code window (<=1400; justify) */
function codeNeedWindow(p: { symbolId: string; reason: string; expectedLines: number; identifiersToFind: string[]; maxTokens?: number; responseMode?: RM; deltaMode?: DM; maxDeltaLines?: number }): object | ResponseHandle

// === Repo ===
function repoRegister(p: { rootPath: string }): { repoId: string }
/** compact */
function repoStatus(p?: { detail?: "compact" | "standard" | "full"; includeTelemetry?: boolean }): { status: object }
/** Permanent removal */
function repoUnregister(p: { confirmRepoId: string; discardDrafts?: boolean }): { ok: true; repoId: string; removed: true }
function repoOverview(p: { level?: "stats" | "directories" | "full"; ifNoneMatch?: string }): object
function indexRefresh(p: { mode: "full" | "incremental"; async?: boolean; includeDiagnostics?: boolean }): object
function policyGet(): { policy: object }
function policySet(p: { policyPatch: { maxWindowLines?: number; maxWindowTokens?: number; requireIdentifiers?: boolean; allowBreakGlass?: boolean; defaultDenyRaw?: boolean } }): { policy: object }

// === Semantic Providers ===
/** Refresh semantic enrichment source selection */
function semanticEnrichmentRefresh(p: { dryRun?: boolean; force?: boolean; install?: boolean; languages?: string[] }): { status: string }
/** Report semantic enrichment status */
function semanticEnrichmentStatus(p: { languages?: string[]; detail?: "compact"|"full"; limit?: number }): { status: object }
// === Memory ===
/** Store memory */
function memoryStore(p: { type: "decision"|"bugfix"|"task_context"|"pattern"|"convention"|"architecture"|"performance"|"security"; title: string; content: string; tags?: string[]; symbolIds?: string[]; fileRelPaths?: string[] }): { memoryId: string }
/** Find memories */
function memoryQuery(p: { query?: string; types?: string[]; tags?: string[]; limit?: number }): { memories: object[] }
/** Remove memory */
function memoryRemove(p: { memoryId: string }): { removed: boolean }
/** Surface memories */
function memorySurface(p: { symbolIds?: string[]; fileIds?: string[]; taskText?: string; limit?: number }): { memories: object[] }

// === Context / Agent ===
/** Record feedback */
function agentFeedback(p: { versionId: string; sliceHandle: string; usefulSymbols: string[]; missingSymbols?: string[]; rating?: string; comment?: string }): { recorded: boolean }
/** Query feedback */
function agentFeedbackQuery(p: { limit?: number }): { records: object[] }
/** Push draft */
function bufferPush(p: { eventType: "open"|"change"|"save"|"close"|"checkpoint"; filePath: string; content: string; version: number; dirty: boolean; timestamp: string }): { accepted: boolean }
/** Checkpoint draft */
function bufferCheckpoint(): { checkpointed: boolean }
/** Draft status */
function bufferStatus(): { status: object }
/** runtimeExecute executes repository tooling: build/test/lint/compiler, named scripts, targeted edit scripts. Do not use it to inspect, search, or print repository files. Use sdl.context or sdl.retrieve for indexed source; sdl.file with op="read" for other files. */
function runtimeExecute(p: { runtime: string; executable?: string; args?: string[]; code?: string; stdin?: string; relativeCwd?: string; timeoutMs?: number; queryTerms?: string[]; contextLines?: number; maxResponseLines?: number; persistOutput?: boolean; outputMode?: "minimal"|"summary"|"intent"|"digest" }): { status: string; exitCode: number; durationMs: number; artifactHandle?: string; stdoutSummary?: string; nextAction?: object }
/** Stored runtime excerpts */
function runtimeQueryOutput(p: { artifactHandle: string; queryTerms?: string[]; cursor?: { stream: "stdout"|"stderr"; afterLine: number }; lineRange?: { stream: "stdout"|"stderr"; startLine: number; endLine: number }; maxExcerpts?: number; contextLines?: number; stream?: "stdout"|"stderr"|"both" }): { excerpts: object[]; matchStatus: "matched"|"noMatchFallback"|"lineRange"; matchCount: number; nextCursor?: object }
/** Page a response artifact */
function responseGet(p: { handle: string; full?: boolean; maxBytes?: number; maxTokens?: number; offsetBytes?: number; jsonPath?: string; raw?: boolean; offset?: number; limit?: number }): { content: unknown; truncated: boolean; metadata: object; pagination?: object }

// === Usage ===
/** Token stats; compact has Signal density */
function usageStats(p: { scope?: "session" | "history" | "lifetime" | "both" | "all"; since?: string; limit?: number; persist?: boolean; detail?: "compact" | "full" }): { formattedSummary: string } | object

// === File ===
/** Read non-indexed files */
function fileRead(p: { filePath: string; maxBytes?: number; offset?: number; limit?: number; search?: string; searchContext?: number; jsonPath?: string; responseMode?: RM; deltaMode?: DM; maxDeltaLines?: number }): { content: string; truncated: boolean; sessionDelta?: object; delta?: object } | ResponseHandle
function fileWrite(p: { filePath: string; content?: string; replaceLines?: { start: number; end: number; content: string }; replacePattern?: { pattern: string; replacement: string; global?: boolean }; jsonPath?: string; jsonValue?: unknown; insertAt?: { line: number; content: string }; append?: string; createBackup?: boolean; createIfMissing?: boolean }): { filePath: string; mode: string; backupPath?: string; replacementCount?: number }
/** Preview/apply cross-file edits */
function searchEdit(p: { mode: "preview"; targeting?: ST; query?: SQ; editMode?: EM; operations?: SEOps[]; filters?: object; maxFiles?: number; createBackup?: boolean; responseMode?: RM } | { mode: "apply"; planHandle: string; createBackup?: boolean }): object | ResponseHandle

// === Data Transforms (workflow-only) ===
function dataPick(p: { input: unknown; fields: Record<string, string> }): object
function dataMap(p: { input: unknown[]; fields: Record<string, string> }): object[]
function dataFilter(p: { input: unknown[]; clauses: Array<{path: string; op: "eq"|"ne"|"gt"|"gte"|"lt"|"lte"|"contains"|"in"|"exists"; value?: unknown}>; mode?: "all"|"any" }): object[]
function dataSort(p: { input: unknown[]; by: {path: string; direction?: "asc"|"desc"; type?: "string"|"number"|"date"|"boolean"} }): object[]
function dataTemplate(p: { input: Record<string, unknown> | unknown[]; template: string; joinWith?: string }): string
function workflowContinuationGet(p: { handle: string; path?: string; offset?: number; limit?: number }): { data: unknown; totalTokens: number; hasMore: boolean }

// === Compact Wire Format (sliceBuild wireFormat:"compact") ===
// wf/wv/vid metadata; fp paths; c cards; e edges; f frontier; card fields include r/k/n/sig/sum/d/m.
// Truncation uses t.tr with dropped counts and res continuation data.
`;

export function generateManual(
  _liveIndex?: LiveIndexCoordinator,
  memoryVisible = anyRepoHasMemoryTools(loadConfig()),
): string {
  const actionKeys = GATEWAY_ACTION_DEFINITIONS.filter(
    (definition) =>
      memoryVisible || !MEMORY_ACTIONS.has(definition.action),
  ).map((definition) => definition.action);
  const activeFnMap = getActiveFnNameMap(memoryVisible);
  const mappedActions = Object.values(activeFnMap);
  for (const key of actionKeys) {
    if (!mappedActions.includes(key)) {
      logger.warn(`[code-mode] action "${key}" not in FN_NAME_MAP`);
    }
  }

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

/** Render the bounded discovery surface; the full signature manual remains separate. */
export function generateManualIndex(
  _liveIndex?: LiveIndexCoordinator,
  memoryVisible = anyRepoHasMemoryTools(loadConfig()),
  infoVisible = true,
): string {
  const lines = [
    "# SDL-MCP action index",
    "Use sdl.action.search({ query }) to narrow actions; use a focused sdl.manual request for schemas and examples.",
  ];
  for (const entry of buildCatalog({ memoryVisible, infoVisible })) {
    const purposeLine = entry.description
      .split(/\r?\n/, 1)[0]
      ?.replace(/\s+/g, " ")
      .trim();
    const purpose = purposeLine && purposeLine.length > 60
      ? `${purposeLine.slice(0, 57)}...`
      : purposeLine;
    const fn = entry.fn !== entry.action ? ` (${entry.fn})` : "";
    const requiredParams = entry.requiredParams.slice(0, 3);
    const required = requiredParams.length > 0
      ? ` [required: ${requiredParams.join(", ")}${entry.requiredParams.length > 3 ? ", ..." : ""}]`
      : "";
    const disabled = entry.disabled
      ? ` [disabled: ${entry.disabledReason ?? "Unavailable"}]`
      : "";
    lines.push(
      `- ${entry.action}${fn}: ${purpose ?? "SDL action."}${required}${disabled}`,
    );
  }
  return lines.join("\n");
}

let cachedManual: string | null = null;
let cachedManualMemoryVisible: boolean | null = null;
let cachedManualIndex: string | null = null;
let cachedManualIndexMemoryVisible: boolean | null = null;
let cachedManualIndexInfoVisible: boolean | null = null;

export function getManualCached(
  liveIndex?: LiveIndexCoordinator,
  memoryVisible = anyRepoHasMemoryTools(loadConfig()),
): string {
  if (cachedManual === null || cachedManualMemoryVisible !== memoryVisible) {
    cachedManual = generateManual(liveIndex, memoryVisible);
    cachedManualMemoryVisible = memoryVisible;
  }
  return cachedManual;
}

export function getManualIndexCached(
  liveIndex?: LiveIndexCoordinator,
  memoryVisible = anyRepoHasMemoryTools(loadConfig()),
  infoVisible = true,
): string {
  if (
    cachedManualIndex === null
    || cachedManualIndexMemoryVisible !== memoryVisible
    || cachedManualIndexInfoVisible !== infoVisible
  ) {
    cachedManualIndex = generateManualIndex(
      liveIndex,
      memoryVisible,
      infoVisible,
    );
    cachedManualIndexMemoryVisible = memoryVisible;
    cachedManualIndexInfoVisible = infoVisible;
  }
  return cachedManualIndex;
}

export function invalidateManualCache(): void {
  cachedManual = null;
  cachedManualMemoryVisible = null;
  cachedManualIndex = null;
  cachedManualIndexMemoryVisible = null;
  cachedManualIndexInfoVisible = null;
}
