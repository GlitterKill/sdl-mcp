export function signalsForLoss({ baselineTok, sdlTok, attribution, observability }) {
  const signals = [];
  const deltaPct = baselineTok > 0 ? Math.round(((baselineTok - sdlTok) / baselineTok) * 10000) / 100 : 0;
  if (deltaPct >= 0) return signals;

  const obs = observability ?? {};
  const retrieval = obs.retrieval_totalRetrievals ?? 0;
  const retrievalEmpty = obs.retrieval_emptyResultCount ?? 0;
  if (retrievalEmpty > 0) {
    signals.push({
      signal: "lowRetrievalRecall",
      detail: `${retrievalEmpty} empty-result retrievals out of ${retrieval}`,
    });
  }

  const toolVolume = obs.toolVolume_totalCalls ?? 0;
  const sizeClass = attribution?.repoSizeClass;
  if (sizeClass === "tiny" && toolVolume > 10) {
    signals.push({
      signal: "forcedLadderOnSmallRepo",
      detail: `${toolVolume} tool calls on a tiny repo — SDL retrieval ladder overhead may exceed savings`,
    });
  }

  const indexingEvents = obs.indexing_totalEvents ?? 0;
  if (indexingEvents > 0) {
    signals.push({
      signal: "coldIndexPerTask",
      detail: `${indexingEvents} indexing events — fresh index per task, no warm amortization`,
    });
  }

  const cachedInput = attribution?.cachedInput ?? 0;
  const total = attribution?.total ?? sdlTok;
  if (total > 0 && cachedInput / total > 0.9) {
    signals.push({
      signal: "contextBallooning",
      detail: `cachedInput=${cachedInput} / total=${total} = ${Math.round((cachedInput / total) * 100)}% — context pool dominates, reducing marginal savings`,
    });
  }

  return signals;
}
