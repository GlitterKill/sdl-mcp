import type { AppConfig } from "../config/types.js";
import {
  configurePrefetch,
  warmPrefetchOnServeStart,
} from "../graph/prefetch.js";
import {
  configurePrefetchPolicy,
  hydratePrefetchPolicyFromDb,
} from "../graph/prefetch-outcomes.js";

export async function startPrefetchPolicy(config: AppConfig): Promise<void> {
  configurePrefetch({
    enabled: config.prefetch?.enabled ?? true,
    maxBudgetPercent: config.prefetch?.maxBudgetPercent ?? 20,
  });
  configurePrefetchPolicy(config.prefetch?.policy ?? {});
  await hydratePrefetchPolicyFromDb();

  if (!(config.prefetch?.enabled ?? true)) return;

  // warmTopN defaults to 0 to avoid the "100% wasted prefetch" pattern
  // observed when no caller actually requests the warmed top-fan-in symbols.
  const warmTopN = config.prefetch?.warmTopN ?? 0;
  if (warmTopN <= 0) return;

  for (const repo of config.repos) {
    warmPrefetchOnServeStart(repo.repoId, warmTopN);
  }
}
