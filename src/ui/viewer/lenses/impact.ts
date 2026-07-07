import type { ViewerApi } from "../api.js";

export async function runImpactLens(api: ViewerApi, repoId: string, fromVersion: string, toVersion: string, renderList: (items: string[]) => void): Promise<void> {
  const result = await api.impact(repoId, fromVersion, toVersion);
  const changed = (result.changed ?? []).map((symbolId) => symbolId);
  const blast = (result.blastRadius ?? []).map((item) => item.name ?? item.symbolId);
  renderList([...changed, ...blast]);
}
