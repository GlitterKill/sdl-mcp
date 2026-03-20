/**
 * Compact tool descriptions for gateway tools.
 * Kept under 200 tokens each — these replace verbose per-tool descriptions.
 */

export const QUERY_DESCRIPTION =
  `sdl.query — Read-only SDL intelligence. Pass { repoId, action, ...params }.` +
  `\nActions: symbol.search(query,limit?,semantic?) | symbol.getCard(symbolId,ifNoneMatch?,minCallConfidence?) | ` +
  `symbol.getCards(symbolIds[],knownEtags?) | slice.build(taskText?,entrySymbols?,editedFiles?,budget?,wireFormat?) | ` +
  `slice.refresh(sliceHandle,knownVersion) | slice.spillover.get(spilloverHandle,cursor?,pageSize?) | ` +
  `delta.get(fromVersion,toVersion,budget?) | context.summary(query,scope?,budget?,format?) | ` +
  `pr.risk.analyze(fromVersion,toVersion,riskThreshold?)`;

export const CODE_DESCRIPTION =
  `sdl.code — Gated raw code access. Pass { repoId, action, ...params }.` +
  `\nActions: code.needWindow(symbolId,reason,expectedLines,identifiersToFind[],granularity?,maxTokens?,sliceContext?) | ` +
  `code.getSkeleton(symbolId?,file?,exportedOnly?,maxLines?,maxTokens?,identifiersToFind?) | ` +
  `code.getHotPath(symbolId,identifiersToFind[],maxLines?,maxTokens?,contextLines?)`;

export const REPO_DESCRIPTION =
  `sdl.repo — Repository lifecycle. Pass { repoId, action, ...params }.` +
  `\nActions: repo.register(rootPath,ignore?,languages?,maxFileBytes?) | repo.status() | ` +
  `repo.overview(level,includeHotspots?,directories?,maxDirectories?) | ` +
  `index.refresh(mode,reason?) | policy.get() | policy.set(policyPatch) | ` +
  `usage.stats(scope?,since?,limit?,persist?)`;

export const AGENT_DESCRIPTION =
  `sdl.agent — Agentic + live-edit operations. Pass { repoId, action, ...params }.` +
  `\nActions: agent.orchestrate(taskType,taskText,budget?,options?) | ` +
  `agent.feedback(versionId,sliceHandle,usefulSymbols[],missingSymbols?,taskType?,taskText?) | ` +
  `agent.feedback.query(versionId?,limit?,since?) | ` +
  `buffer.push(eventType,filePath,content,version,dirty,timestamp,cursor?,selections?) | ` +
  `buffer.checkpoint(reason?) | buffer.status() | ` +
  `runtime.execute(runtime,executable?,args?,code?,relativeCwd?,timeoutMs?,queryTerms?,maxResponseLines?,persistOutput?) | ` +
  `memory.store(type,title,content,tags?,confidence?,symbolIds?,fileRelPaths?,memoryId?) | ` +
  `memory.query(query?,types?,tags?,symbolIds?,staleOnly?,limit?,sortBy?) | ` +
  `memory.remove(memoryId,deleteFile?) | memory.surface(symbolIds?,taskType?,limit?)`;
