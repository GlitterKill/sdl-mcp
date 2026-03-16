import { createActionMap } from "../gateway/router.js";
import type { LiveIndexCoordinator } from "../live-index/types.js";

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
  agentOrchestrate: "agent.orchestrate",
  agentFeedback: "agent.feedback",
  agentFeedbackQuery: "agent.feedback.query",
  bufferPush: "buffer.push",
  bufferCheckpoint: "buffer.checkpoint",
  bufferStatus: "buffer.status",
  runtimeExecute: "runtime.execute",
  memoryStore: "memory.store",
  memoryQuery: "memory.query",
  memoryRemove: "memory.remove",
  memorySurface: "memory.surface",
};

export const ACTION_TO_FN: Record<string, string> = Object.fromEntries(
  Object.entries(FN_NAME_MAP).map(([fn, action]) => [action, fn]),
);

const MANUAL_TEMPLATE = `// SDL-MCP API — use with sdl.chain tool
// repoId is set in the chain envelope, not per-step.
// Reference prior step results with $N (e.g., $0.symbols[0].symbolId).

// === Query ===
/** Search symbols by name/pattern */
function symbolSearch(p: { query: string; kinds?: string[]; limit?: number; semantic?: boolean }): { symbols: { symbolId: string; name: string; kind: string; file: string }[] }
/** Get symbol card (metadata, deps, metrics) */
function symbolGetCard(p: { symbolId: string; ifNoneMatch?: string }): { card: { symbolId: string; name: string; kind: string; signature: string; summary: string; deps: object }; etag: string } | { notModified: true }
/** Batch-fetch symbol cards */
function symbolGetCards(p: { symbolIds: string[]; knownEtags?: Record<string,string> }): { cards: object[]; notModified: string[] }
/** Build dependency graph slice */
function sliceBuild(p: { taskText?: string; entrySymbols?: string[]; budget?: { maxCards?: number; maxEstimatedTokens?: number } }): { handle: string; cards: object[]; spilloverCount: number }
/** Refresh existing slice (delta only) */
function sliceRefresh(p: { sliceHandle: string }): { added: object[]; removed: string[]; changed: object[] }
/** Fetch spillover page */
function sliceSpilloverGet(p: { spilloverHandle: string; page?: number; pageSize?: number }): { cards: object[]; hasMore: boolean }
/** Get delta between versions */
function deltaGet(p: { fromVersion?: number; toVersion?: number; includeBlastRadius?: boolean }): { changed: object[]; blastRadius?: object[] }
/** Generate context summary */
function contextSummary(p: { symbolId?: string; file?: string; taskQuery?: string; maxTokens?: number }): { summary: string; tokens: number }
/** Analyze PR risk */
function prRiskAnalyze(p: { riskThreshold?: number }): { riskItems: object[]; summary: string }

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
function policySet(p: { maxWindowLines?: number; maxWindowTokens?: number; requireIdentifiers?: boolean }): { policy: object }

// === Memory ===
/** Store a development memory */
function memoryStore(p: { type: string; title: string; content: string; tags?: string[]; symbolIds?: string[]; fileIds?: string[] }): { memoryId: string }
/** Query memories */
function memoryQuery(p: { query?: string; types?: string[]; tags?: string[]; limit?: number }): { memories: object[] }
/** Soft-delete a memory */
function memoryRemove(p: { memoryId: string }): { removed: boolean }
/** Auto-surface relevant memories */
function memorySurface(p: { symbolIds?: string[]; fileIds?: string[]; taskText?: string; limit?: number }): { memories: object[] }

// === Agent ===
/** Orchestrate multi-rung context retrieval */
function agentOrchestrate(p: { taskText: string; focusSymbols?: string[]; budget?: { maxTokens?: number } }): { evidence: object[] }
/** Record agent feedback */
function agentFeedback(p: { useful: string[]; missing: string[]; taskText: string }): { recorded: boolean }
/** Query feedback records */
function agentFeedbackQuery(p: { limit?: number }): { records: object[] }
/** Push buffer update */
function bufferPush(p: { file: string; content: string }): { accepted: boolean }
/** Request buffer checkpoint */
function bufferCheckpoint(): { checkpointed: boolean }
/** Get buffer status */
function bufferStatus(): { status: object }
/** Execute runtime command */
function runtimeExecute(p: { runtime: string; args?: string[]; code?: string }): { stdout: string; exitCode: number }`;

export function generateManual(_liveIndex?: LiveIndexCoordinator): string {
  // Validate FN_NAME_MAP covers all actions
  const actionMap = createActionMap(_liveIndex);
  const actionKeys = Object.keys(actionMap);
  const mappedActions = Object.values(FN_NAME_MAP);
  for (const key of actionKeys) {
    if (!mappedActions.includes(key)) {
      process.stderr.write(
        `[code-mode] Warning: action "${key}" not in FN_NAME_MAP\n`,
      );
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
