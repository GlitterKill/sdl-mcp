/**
 * Scenario 1: Single Client Baseline
 *
 * Establishes baseline metrics and validates correctness end-to-end.
 * One client exercises all major MCP tools sequentially.
 */

import { MetricsCollector } from "../infra/metrics-collector.js";
import { createStressClient, disconnectAll } from "../infra/client-factory.js";
import type { ScenarioContext, ScenarioResult } from "../infra/types.js";
import { stressLog } from "../infra/types.js";

export async function runSingleClientBaseline(
  ctx: ScenarioContext,
): Promise<ScenarioResult> {
  const { config, serverPort, log } = ctx;
  const collector = new MetricsCollector();
  const warnings: string[] = [];
  const start = Date.now();

  collector.recordMemorySnapshot();

  let client;
  try {
    // Connect single client
    client = await createStressClient(
      serverPort,
      "baseline-0",
      collector,
      config.verbose,
    );

    // 1. Register the fixture repo
    log("Step 1: sdl.repo.register");
    await client.callToolParsed("sdl.repo.register", {
      repoId: "stress-fixtures",
      rootPath: config.fixturePath,
    });

    // 2. Full index
    log("Step 2: sdl.index.refresh (full)");
    const indexResult = await client.callToolParsed("sdl.index.refresh", {
      repoId: "stress-fixtures",
      mode: "full",
    });
    log(`  Indexed, versionId=${indexResult?.versionId}`);

    // 3. Repo status — validate symbol/file counts
    log("Step 3: sdl.repo.status");
    const status = await client.callToolParsed("sdl.repo.status", {
      repoId: "stress-fixtures",
    });
    const symbolCount = status?.symbolsIndexed as number | undefined;
    const fileCount = status?.filesIndexed as number | undefined;
    log(`  symbolCount=${symbolCount}, fileCount=${fileCount}`);

    if ((symbolCount ?? 0) < 50) {
      warnings.push(`Low symbol count: ${symbolCount} (expected > 100)`);
    }
    if ((fileCount ?? 0) < 10) {
      warnings.push(`Low file count: ${fileCount} (expected >= 24)`);
    }

    // 4. Symbol search
    log("Step 4: sdl.symbol.search");
    const searchResult = await client.callToolParsed("sdl.symbol.search", {
      repoId: "stress-fixtures",
      query: "User",
      limit: 20,
    });
    const searchResults = (searchResult?.results ?? []) as Array<{
      symbolId: string;
      name: string;
    }>;
    log(`  Found ${searchResults.length} results`);

    if (searchResults.length === 0) {
      warnings.push('Symbol search for "User" returned 0 results');
    }

    // 5. Symbol getCard
    let cardSymbolId: string | undefined;
    if (searchResults.length > 0) {
      log("Step 5: sdl.symbol.getCard");
      cardSymbolId = searchResults[0].symbolId;
      const cardResult = await client.callToolParsed("sdl.symbol.getCard", {
        repoId: "stress-fixtures",
        symbolId: cardSymbolId,
      });
      const card = cardResult?.card as
        | { signature?: string; name?: string }
        | undefined;
      log(`  Card: ${card?.name}`);
    }

    // 6. Slice build
    if (cardSymbolId) {
      log("Step 6: sdl.slice.build");
      const slice = await client.callToolParsed("sdl.slice.build", {
        repoId: "stress-fixtures",
        entrySymbols: [cardSymbolId],
        budget: { maxCards: 30, maxEstimatedTokens: 4000 },
      });
      const cards = slice?.cards as unknown[] | undefined;
      log(`  Slice: ${cards?.length ?? 0} cards`);
    }

    // 7. Skeleton
    if (cardSymbolId) {
      log("Step 7: sdl.code.getSkeleton");
      const skeleton = await client.callToolParsed("sdl.code.getSkeleton", {
        repoId: "stress-fixtures",
        symbolId: cardSymbolId,
      });
      const skeletonStr = skeleton?.skeleton as string | undefined;
      log(`  Skeleton: ${skeletonStr?.length ?? 0} chars`);
    }

    // 8. Hot path
    if (cardSymbolId) {
      log("Step 8: sdl.code.getHotPath");
      const hotPath = await client.callToolParsed("sdl.code.getHotPath", {
        repoId: "stress-fixtures",
        symbolId: cardSymbolId,
        identifiersToFind: ["User", "fetch"],
      });
      const excerpt = hotPath?.excerpt as string | undefined;
      log(`  HotPath: ${excerpt?.length ?? 0} chars`);
    }

    // 9. needWindow
    if (cardSymbolId) {
      log("Step 9: sdl.code.needWindow");
      try {
        await client.callToolParsed("sdl.code.needWindow", {
          repoId: "stress-fixtures",
          symbolId: cardSymbolId,
          reason: "Stress test baseline verification",
          expectedLines: 50,
          identifiersToFind: ["User"],
        });
        log("  needWindow: approved or returned code");
      } catch {
        log("  needWindow: denied (expected if policy gates it)");
      }
    }

    // 10. Policy get
    log("Step 10: sdl.policy.get");
    const policy = await client.callToolParsed("sdl.policy.get", {
      repoId: "stress-fixtures",
    });
    const policyObj = policy?.policy as { maxWindowLines?: number } | undefined;
    log(`  Policy: maxWindowLines=${policyObj?.maxWindowLines}`);

    // 11. Repo overview
    log("Step 11: sdl.repo.overview (stats)");
    const overview = await client.callToolParsed("sdl.repo.overview", {
      repoId: "stress-fixtures",
      level: "stats",
    });
    const overviewStats = overview?.stats as
      | { symbolCount?: number }
      | undefined;
    log(`  Overview symbolCount=${overviewStats?.symbolCount}`);

    collector.recordMemorySnapshot();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stressLog("error", `Baseline scenario failed: ${msg}`);
    // Record the orchestrator-level error so `passed` reflects it
    collector.recordToolCall("baseline-0", "scenario", 0, false, 0, msg);
  } finally {
    if (client) await disconnectAll([client]);
  }

  const durationMs = Date.now() - start;
  const errors = collector.getErrors();
  const toolMetrics = collector.getAllToolMetrics();

  return {
    name: "single-client-baseline",
    passed: errors.length === 0,
    clients: 1,
    durationMs,
    toolMetrics,
    errors,
    memoryPeakMB: collector.getMemoryPeakMB(),
    warnings,
    toolResultStats: collector.getResultStats(),
  };
}
