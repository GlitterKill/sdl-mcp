/**
 * Compact tool descriptions for gateway tools.
 * Kept under 200 tokens each - these replace verbose per-tool descriptions.
 */

import { loadConfig } from "../config/loadConfig.js";
import { anyRepoHasMemoryTools } from "../config/memory-config.js";

export const QUERY_DESCRIPTION =
  `sdl.query - Read-only SDL intelligence. Pass { repoId, action, ...params }.` +
  `\nActions: symbol.search(query,limit?,semantic?) | symbol.getCard(symbolId,ifNoneMatch?,minCallConfidence?) | ` +
  `symbol.getCards(symbolIds[],knownEtags?) | slice.build(taskText?,entrySymbols?,editedFiles?,budget?,wireFormat?) | ` +
  `slice.refresh(sliceHandle,knownVersion) | slice.spillover.get(spilloverHandle,cursor?,pageSize?) | ` +
  `delta.get(fromVersion,toVersion,budget?) | context.summary(query,scope?,budget?,format?) | ` +
  `pr.risk.analyze(fromVersion,toVersion,riskThreshold?)` +
  `\nPrefer: repo.status -> symbol.search -> symbol.getCard -> slice.build.`;

export const CODE_DESCRIPTION =
  `sdl.code - Gated raw code access. Pass { repoId, action, ...params }.` +
  `\nActions: code.needWindow(symbolId,reason,expectedLines,identifiersToFind[],granularity?,maxTokens?,sliceContext?) | ` +
  `code.getSkeleton(symbolId?,file?,exportedOnly?,maxLines?,maxTokens?,identifiersToFind?) | ` +
  `code.getHotPath(symbolId,identifiersToFind[],maxLines?,maxTokens?,contextLines?)` +
  `\nPrefer: code.getSkeleton -> code.getHotPath -> code.needWindow.`;

export const REPO_DESCRIPTION =
  `sdl.repo - Repository lifecycle. Pass { repoId, action, ...params }.` +
  `\nActions: repo.register(rootPath,ignore?,languages?,maxFileBytes?) | repo.status() | ` +
  `repo.overview(level,includeHotspots?,directories?,maxDirectories?) | ` +
  `index.refresh(mode,reason?) | policy.get() | policy.set(policyPatch; budgetCaps requires maxCards+maxEstimatedTokens) | ` +
  `usage.stats(scope?,since?,limit?,persist?)`;

const AGENT_DESCRIPTION_BASE =
  `sdl.agent - Agentic + live-edit operations. Pass { repoId, action, ...params }.` +
  `\nActions: agent.context(taskType,taskText,budget?,options?{contextMode?,focusPaths?,...}) | ` +
  `agent.feedback(versionId,sliceHandle,usefulSymbols[],missingSymbols?,taskType?,taskText?) | ` +
  `agent.feedback.query(versionId?,limit?,since?) | ` +
  `buffer.push(eventType,filePath,content,version,dirty,timestamp,cursor?,selections?) | ` +
  `buffer.checkpoint(reason?) | buffer.status() | ` +
  `runtime.execute(runtime,executable?,args?,code?,relativeCwd?,timeoutMs?,queryTerms?,maxResponseLines?,persistOutput?,outputMode?) [outputMode defaults to "minimal" ~50 tokens; use "summary" for head+tail, "intent" for queryTerms-only excerpts] | runtime.queryOutput(artifactHandle,queryTerms[],maxExcerpts?,contextLines?,stream?)`;

const MEMORY_DESCRIPTION_SUFFIX =
  ` | memory.store(type,title,content,tags?,confidence?,symbolIds?,fileRelPaths?,memoryId?) | ` +
  `memory.query(query?,types?,tags?,symbolIds?,staleOnly?,limit?,sortBy?) | ` +
  `memory.remove(memoryId,deleteFile?) | memory.surface(symbolIds?,taskType?,limit?)`;

/**
 * Get the AGENT_DESCRIPTION dynamically based on memory config.
 * When no repo has memory enabled, memory action references are omitted.
 */
export function getAgentDescription(): string {
  const memoryVisible = anyRepoHasMemoryTools(loadConfig());
  return memoryVisible
    ? AGENT_DESCRIPTION_BASE + MEMORY_DESCRIPTION_SUFFIX
    : AGENT_DESCRIPTION_BASE;
}

/**
 * @deprecated Use `getAgentDescription()` instead. Kept for backward compatibility
 * with existing imports. Always includes memory actions regardless of config.
 */
export const AGENT_DESCRIPTION = AGENT_DESCRIPTION_BASE + MEMORY_DESCRIPTION_SUFFIX;
