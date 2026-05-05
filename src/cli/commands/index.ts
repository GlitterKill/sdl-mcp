import { IndexOptions } from "../types.js";
import { loadConfig } from "../../config/loadConfig.js";
import {
  indexRepo,
  watchRepository,
  IndexWatchHandle,
  IndexResult,
} from "../../indexer/indexer.js";
import {
  disableDerivedRefreshQueue,
  enableDerivedRefreshQueue,
  shutdownDerivedRefreshQueue,
} from "../../indexer/derived-refresh-queue.js";
import type {
  IndexProgress,
  IndexProgressSubstage,
} from "../../indexer/indexer.js";
import { initGraphDb, resolveGraphDbPath } from "../../db/initGraphDb.js";
import {
  getLadybugConn,
  withWriteConn,
  closeLadybugDb,
} from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import { getCurrentTimestamp } from "../../util/time.js";
import { activateCliConfigPath } from "../../config/configPath.js";
import { findExistingProcess, type PidfileData } from "../../util/pidfile.js";
import { connectSSE, type SSEEvent } from "../../util/sse-client.js";
import { printBanner } from "../../util/banner.js";

// ---------------------------------------------------------------------------
// Progress renderer
// ---------------------------------------------------------------------------
//
// Renders indexer and SCIP progress in-place when stdout is a TTY (using
// carriage return + clear-to-EOL) and falls back to throttled line printing
// in non-TTY contexts (CI logs, piped output). The renderer is stateful so it
// can emit a newline when the active stage changes — without this, in-place
// updates from stage N would collide with stage N+1 on the same line.

/** @internal exported for tests; do not import from product code. */
export interface ProgressState {
  /** Key identifying the currently-rendered stage (e.g. "pass1", "scip:label:documents"). */
  currentStage: string | null;
  /** Last line written, used to dedupe identical updates from high-frequency callbacks. */
  lastLine: string;
  /** Last file line written (shown below the progress bar). */
  lastFileLine: string;
  /** Last percentage printed in non-TTY mode (throttles to ~10% increments). */
  lastPrintedPct: number;
  /**
   * Per-model embedding progress. Two models (jina + nomic) emit interleaved
   * events through the same onProgress callback; without per-model state the
   * displayed count would flicker between each model's last reported value.
   * Map preserves insertion order so the rendered line keeps a stable column
   * ordering across updates. Cleared on stage transitions away from
   * embeddings.
   */
  embeddingsByModel: Map<string, { current: number; total: number }>;
}

/** @internal exported for tests; do not import from product code. */
export function createProgressState(): ProgressState {
  return {
    currentStage: null,
    lastLine: "",
    lastFileLine: "",
    lastPrintedPct: -1,
    embeddingsByModel: new Map(),
  };
}

/**
 * Shorten a model identifier for display in the per-model progress line.
 * Model names like "jina-embeddings-v2-base-code" or "nomic-embed-text-v1.5"
 * are too long for a multi-model status line; the first dash-separated token
 * gives a stable, recognisable abbreviation.
 */
/** @internal exported for tests; do not import from product code. */
export function shortModelLabel(model: string): string {
  const head = model.split("-")[0] ?? model;
  return head.toLowerCase();
}

function isTty(): boolean {
  return Boolean(process.stdout.isTTY);
}

function buildBar(pct: number, width = 20): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  return "[" + "#".repeat(filled) + "-".repeat(width - filled) + "]";
}

/**
 * Map an IndexProgress stage to a user-facing label. The indexer emits
 * internal stage names (snake/camel); the CLI shows human-friendly strings.
 */
function indexStageLabel(stage: IndexProgress["stage"]): string {
  switch (stage) {
    case "scanning":
      return "Scanning files";
    case "parsing":
      return "Parsing";
    case "pass1":
      return "Pass 1 (symbols)";
    case "scipIngest":
      return "SCIP ingest";
    case "pass2":
      return "Pass 2 (edges)";
    case "finalizing":
      return "Finalizing";
    case "summaries":
      return "Summaries";
    case "embeddings":
      return "Embeddings";
    default:
      return stage;
  }
}

/**
 * Human-facing label for a finalize substage. Used to keep CLI / SSE / MCP
 * progress consumers reading the same vocabulary as the plan.
 */
function indexSubstageLabel(substage: IndexProgressSubstage): string {
  switch (substage) {
    case "pass1Drain":
      return "Flushing pass 1 writes";
    case "importReresolution":
      return "Import re-resolution";
    case "edgeFinalize":
      return "Finalize pending/config edges";
    case "versionSnapshot":
      return "Create version snapshot";
    case "metrics":
      return "Update metrics";
    case "fileSummaries":
      return "Materialize file summaries";
    case "audit":
      return "Audit events";
    case "semanticSummaries":
      return "Semantic summaries";
    case "semanticEmbeddings":
      return "Semantic embeddings";
    case "clusterRefresh":
      return "Cluster refresh";
    case "processRefresh":
      return "Process refresh";
    case "algorithmRefresh":
      return "Algorithm refresh";
    default:
      return substage;
  }
}

/**
 * Write a progress line to stdout, either in-place (TTY) or throttled
 * (non-TTY). When switching between stages, the previous line is finalized
 * with a newline so it remains visible in scrollback.
 */
function writeProgressLine(
  state: ProgressState,
  stageKey: string,
  line: string,
  pct: number | null,
  fileLine?: string,
): void {
  // Stage transition — finalize the previous line so the new stage starts
  // on a fresh line and scrollback shows all stages.
  if (state.currentStage !== null && state.currentStage !== stageKey) {
    if (isTty()) {
      // Clear file line if present, then move to new line
      if (state.lastFileLine) {
        process.stdout.write("\n"); // Move past file line
      }
      process.stdout.write("\n");
    }
    state.lastLine = "";
    state.lastFileLine = "";
    state.lastPrintedPct = -1;
  }
  state.currentStage = stageKey;

  const sameContent =
    line === state.lastLine && (fileLine ?? "") === state.lastFileLine;
  if (sameContent) return;

  if (isTty()) {
    // If we previously had a file line, move up one line first
    if (state.lastFileLine) {
      process.stdout.write("\x1b[1A"); // Move cursor up one line
    }
    // \r returns to line start; \x1b[K clears from cursor to end of line.
    process.stdout.write(`\r${line}\x1b[K`);
    state.lastLine = line;
    // Write file line below if provided
    if (fileLine) {
      process.stdout.write(`\n    ${fileLine}\x1b[K`);
      state.lastFileLine = fileLine;
    } else if (state.lastFileLine) {
      // Clear old file line if we no longer have one
      process.stdout.write("\n\x1b[K\x1b[1A");
      state.lastFileLine = "";
    }
  } else {
    // Non-TTY: throttle to ~10% boundaries so CI logs don't drown in ticks.
    // Pass pct=null for "always print" lines (stage headers, spinners).
    if (pct === null || pct === 100 || pct - state.lastPrintedPct >= 10) {
      console.log(line);
      if (fileLine) {
        console.log(`    ${fileLine}`);
      }
      state.lastLine = line;
      state.lastFileLine = fileLine ?? "";
      state.lastPrintedPct = pct ?? -1;
    }
  }
}

/** Finalize any in-flight progress line with a newline so output that follows starts cleanly. */
function finishProgress(state: ProgressState): void {
  if (state.currentStage !== null && isTty()) {
    // If we have a file line displayed, we're already on that line, so one \n is enough
    // Otherwise we need to move past the progress line
    if (state.lastFileLine) {
      process.stdout.write("\n");
    } else {
      process.stdout.write("\n");
    }
  }
  state.currentStage = null;
  state.lastLine = "";
  state.lastFileLine = "";
  state.lastPrintedPct = -1;
}

/**
 * Render a single IndexProgress event. Handles stages with a known total
 * (parsing, pass1, pass2, summaries, embeddings — drawn as a bar), stages
 * without progress (scanning — spinner/label), and the finalizing stage
 * which now carries explicit substages for the post-pass2 pipeline.
 */
/** @internal exported for tests; do not import from product code. */
export function renderIndexProgress(
  state: ProgressState,
  p: IndexProgress,
): void {
  const label = indexStageLabel(p.stage);
  let line: string;
  let pct: number | null = null;
  // Dedupe key includes substage so transitions inside `finalizing` are not
  // swallowed by the identical-stage check in writeProgressLine.
  const stageKey = `${p.stage}:${p.substage ?? ""}`;

  // Drop accumulated per-model embedding state when the active stage moves
  // away from embeddings — keeps a re-entered embeddings phase (a second
  // index.refresh) from showing a stale combined line.
  if (p.stage !== "embeddings" && state.embeddingsByModel.size > 0) {
    state.embeddingsByModel.clear();
  }

  if (p.stage === "scanning") {
    line = `  ${label}...`;
  } else if (p.stage === "parsing") {
    // parsing fires only once with current=0 before pass1 begins; show file
    // count without a progress bar to avoid the misleading 0% that never updates.
    line = `  Parsing ${p.total} files:`;
  } else if (p.stage === "scipIngest") {
    // SCIP emits two phase shapes: an `externals` phase with a known total
    // (rendered as a percentage bar) and a streaming `documents` phase with
    // no upfront total (rendered as a counter via `message`). Without this
    // branch the documents phase falls through to the generic "no total"
    // case and shows just `SCIP ingest...` for the entire ingest, which
    // looks indistinguishable from a hang on multi-MB index files.
    if (p.total > 0) {
      pct = Math.min(100, Math.floor((p.current / p.total) * 100));
      const bar = buildBar(pct);
      line = `  ${label}: ${bar} ${String(pct).padStart(3)}% (${p.current}/${p.total})`;
    } else if (p.message) {
      line = `  ${label} — ${p.message}`;
    } else {
      line = `  ${label}...`;
    }
  } else if (p.stage === "finalizing") {
    const subLabel = p.substage ? indexSubstageLabel(p.substage) : "Finalizing";
    const stageCur = p.stageCurrent;
    const stageTot = p.stageTotal;
    if (
      typeof stageCur === "number" &&
      typeof stageTot === "number" &&
      stageTot > 0
    ) {
      pct = Math.min(100, Math.floor((stageCur / stageTot) * 100));
      const bar = buildBar(pct);
      line = `  ${subLabel}: ${bar} ${String(pct).padStart(3)}% (${stageCur}/${stageTot})`;
    } else if (p.message) {
      line = `  ${subLabel} — ${p.message}`;
    } else {
      line = `  ${subLabel}...`;
    }
  } else if (p.stage === "embeddings") {
    // Per-model rendering: each model's progress lives in its own column of
    // a single status line. Two models emitting interleaved events used to
    // overwrite each other's counts, producing a flickering current-value
    // (e.g. 21 → 25 → 22 → 26). The Map preserves insertion order so the
    // displayed columns stay stable across updates.
    const modelKey = p.model ?? "default";
    state.embeddingsByModel.set(modelKey, {
      current: p.current,
      total: p.total,
    });
    const segments: string[] = [];
    let combinedCurrent = 0;
    let combinedTotal = 0;
    for (const [model, st] of state.embeddingsByModel) {
      const modelLabel = shortModelLabel(model);
      if (st.total > 0) {
        const modelPct = Math.min(
          100,
          Math.floor((st.current / st.total) * 100),
        );
        const bar = buildBar(modelPct, 12);
        segments.push(
          `${modelLabel} ${bar} ${String(modelPct).padStart(3)}% (${st.current}/${st.total})`,
        );
      } else {
        segments.push(`${modelLabel}...`);
      }
      combinedCurrent += st.current;
      combinedTotal += st.total;
    }
    if (combinedTotal > 0) {
      pct = Math.min(100, Math.floor((combinedCurrent / combinedTotal) * 100));
    }
    line = `  ${label}: ${segments.join(" | ")}`;
  } else if (p.total > 0) {
    pct = Math.min(100, Math.floor((p.current / p.total) * 100));
    const bar = buildBar(pct);
    line = `  ${label}: ${bar} ${String(pct).padStart(3)}% (${p.current}/${p.total})`;
  } else {
    line = `  ${label}...`;
  }

  writeProgressLine(state, stageKey, line, pct, p.currentFile);
}

/**
 * Delegate indexing for a single repo to the running HTTP server via SSE.
 * Returns true if delegation succeeded, false if it failed (caller should
 * fall back to direct indexing).
 */
async function delegateIndexToServer(
  server: PidfileData,
  repoId: string,
  mode: "full" | "incremental",
): Promise<boolean> {
  console.log(
    `  Delegating to running server (PID ${server.pid}, port ${server.port})...`,
  );

  const progressState = createProgressState();
  let completed = false;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (server.authToken) {
    headers.Authorization = `Bearer ${server.authToken}`;
  }

  try {
    await connectSSE({
      host: "localhost",
      port: server.port!,
      path: `/api/repo/${encodeURIComponent(repoId)}/reindex-stream`,
      method: "POST",
      headers,
      body: JSON.stringify({ mode }),
      onEvent: (evt: SSEEvent) => {
        if (evt.event === "progress") {
          try {
            // The server forwards every stage the indexer emits
            // (scanning/parsing/pass1/pass2/finalizing/summaries/embeddings),
            // so cast to IndexProgress once validated and defer all
            // formatting to the shared renderer.
            const p = JSON.parse(evt.data) as {
              stage: IndexProgress["stage"];
              current: number;
              total: number;
              currentFile?: string;
              substage?: IndexProgressSubstage;
              stageCurrent?: number;
              stageTotal?: number;
              message?: string;
            };
            renderIndexProgress(progressState, p);
          } catch {
            // Skip malformed SSE event
          }
        } else if (evt.event === "complete") {
          // Finalize the in-flight progress line so summary prints cleanly.
          finishProgress(progressState);
          try {
            const c = JSON.parse(evt.data) as {
              filesProcessed: number;
              symbolsIndexed: number;
              totalSymbols: number;
              edgesCreated: number;
              totalEdges: number;
              durationMs: number;
              summaryStats?: {
                generated: number;
                totalCostUsd: number;
                skipped: number;
                failed: number;
              } | null;
            };
            console.log(`  Files: ${c.filesProcessed}`);
            console.log(
              `  Symbols: ${c.symbolsIndexed} new (${c.totalSymbols} total)`,
            );
            console.log(
              `  Edges: ${c.edgesCreated} new (${c.totalEdges} total)`,
            );
            console.log(`  Duration: ${c.durationMs}ms`);
            if (c.summaryStats) {
              const s = c.summaryStats;
              console.log(
                `  Summaries: ${s.generated} new ($${s.totalCostUsd.toFixed(4)}), ${s.skipped} cached, ${s.failed} failed`,
              );
            }
            completed = true;
          } catch {
            // Skip malformed SSE event
          }
        } else if (evt.event === "error") {
          // Finalize any in-flight progress line so the error message isn't
          // glued to a half-written stage bar.
          finishProgress(progressState);
          try {
            const e = JSON.parse(evt.data) as { message: string };
            console.error(`  Error from server: ${e.message}`);
          } catch {
            // Skip malformed SSE event
          }
        }
      },
    });

    // Defensive finalize in case the SSE stream closed without emitting
    // complete/error (network drop, server crash).
    finishProgress(progressState);
    return completed;
  } catch (error) {
    finishProgress(progressState);
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`  Failed to delegate to server: ${msg}`);
    return false;
  }
}

async function cleanupOneShotIndexing(
  dbInitialized: boolean,
  derivedRefreshDisabled: boolean,
): Promise<void> {
  try {
    await shutdownDerivedRefreshQueue();
    if (dbInitialized) {
      await closeLadybugDb();
    }
  } finally {
    if (derivedRefreshDisabled) {
      enableDerivedRefreshQueue();
    }
  }
}

export function canDelegateIndexToServer(
  existing: PidfileData | null,
  httpAuthEnabled: boolean,
): existing is PidfileData & { transport: "http"; port: number } {
  if (!existing || existing.transport !== "http" || existing.port == null) {
    return false;
  }

  // Auth-disabled HTTP servers intentionally omit authToken from the pidfile.
  // Delegating avoids opening LadybugDB directly while the server owns the lock.
  if (!httpAuthEnabled) {
    return true;
  }

  return (
    typeof existing.authToken === "string" && existing.authToken.length > 0
  );
}

export async function indexCommand(options: IndexOptions): Promise<void> {
  printBanner();

  const configPath = activateCliConfigPath(options.config);
  const config = loadConfig(configPath);

  // Check if an HTTP server is already running on this database.
  const graphDbPath = resolveGraphDbPath(config, configPath);
  const existing = findExistingProcess(graphDbPath);

  const canDelegate = canDelegateIndexToServer(
    existing,
    config.httpAuth?.enabled === true,
  );

  if (canDelegate) {
    console.log(
      `Detected running SDL-MCP HTTP server (PID ${existing.pid}, port ${existing.port}).`,
    );
    console.log("Delegating indexing to the running server.\n");

    if (options.watch) {
      console.log(
        "Note: --watch flag is ignored when delegating to a running server " +
          "(the server manages its own file watchers).\n",
      );
    }
  }

  const reposToIndex = options.repoId
    ? config.repos.filter((r) => r.repoId === options.repoId)
    : config.repos;

  if (reposToIndex.length === 0) {
    console.error(
      options.repoId
        ? `Repository not found: ${options.repoId}`
        : "No repositories configured",
    );
    await closeLadybugDb();
    process.exit(1);
  }

  // If we cannot delegate, initialize the DB for direct indexing.
  // Track initialization state for lazy init on delegation fallback.
  let dbInitialized = false;
  if (!canDelegate) {
    await initGraphDb(config, configPath);
    dbInitialized = true;
  }

  console.log(`Indexing ${reposToIndex.length} repo(s)...`);

  const errors: Array<{ repoId: string; error: string }> = [];
  const isOneShot = !options.watch;
  let derivedRefreshDisabled = false;
  if (isOneShot) {
    // One-shot CLI invocations should mark derived state dirty but must not
    // start background work that keeps the command prompt alive after indexing.
    disableDerivedRefreshQueue();
    derivedRefreshDisabled = true;
  }

  for (const repo of reposToIndex) {
    const requestedMode = options.force ? "full" : "incremental";

    // Try delegating to the running server first. The server auto-upgrades
    // 'incremental' → 'full' when the repo has no indexed files (see
    // indexRepoImpl), so we display the requested mode and trust the server
    // to do the right thing — its log surfaces the upgrade if it fires.
    if (canDelegate) {
      console.log(
        `\nIndexing ${repo.repoId} (${repo.rootPath}) [mode=${requestedMode}]...`,
      );
      const ok = await delegateIndexToServer(
        existing,
        repo.repoId,
        requestedMode,
      );
      if (ok) {
        continue;
      }
      // Delegation failed — fall back to direct indexing.
      console.log("  Falling back to direct indexing...");
      if (!dbInitialized) {
        await initGraphDb(config, configPath);
        dbInitialized = true;
      }
    }

    // Direct indexing path (original behavior).
    const conn = await getLadybugConn();

    const existingRepo = await ladybugDb.getRepo(conn, repo.repoId);

    await withWriteConn(async (wConn) => {
      await ladybugDb.upsertRepo(wConn, {
        repoId: repo.repoId,
        rootPath: repo.rootPath,
        configJson: JSON.stringify(repo),
        createdAt: existingRepo?.createdAt ?? getCurrentTimestamp(),
      });
    });

    const directMode = options.force || !existingRepo ? "full" : "incremental";

    // Direct-path display reflects the actual mode that will run — fresh
    // repos correctly show `[mode=full]` even without --force. If we got
    // here via delegation fallback the requested-mode line was already
    // printed; otherwise this is the first per-repo banner.
    if (!canDelegate) {
      console.log(
        `\nIndexing ${repo.repoId} (${repo.rootPath}) [mode=${directMode}]...`,
      );
    }
    if (!existingRepo) {
      console.log(`  Registering repository: ${repo.repoId}`);
    }

    try {
      // Shared progress state across indexer + SCIP so stage transitions
      // between them (e.g. embeddings -> SCIP externals) produce a clean
      // newline boundary in TTY mode.
      const progressState = createProgressState();
      const stats: IndexResult = await indexRepo(
        repo.repoId,
        directMode,
        (progress) => {
          renderIndexProgress(progressState, progress);
        },
        undefined,
        { includeTimings: Boolean(options.diagnostics) },
      );
      // Finalize the last indexer stage line before printing summary lines.
      finishProgress(progressState);
      const totalSymbols = await ladybugDb.getSymbolCount(conn, repo.repoId);
      const totalEdges = await ladybugDb.getEdgeCount(conn, repo.repoId);
      console.log(`  Files: ${stats.filesProcessed}`);
      console.log(
        `  Symbols: ${stats.symbolsIndexed} new (${totalSymbols} total)`,
      );
      console.log(`  Edges: ${stats.edgesCreated} new (${totalEdges} total)`);
      console.log(`  Duration: ${stats.durationMs}ms`);
      if (stats.summaryStats) {
        const s = stats.summaryStats;
        console.log(
          `  Summaries: ${s.generated} new ($${s.totalCostUsd.toFixed(4)}), ${s.skipped} cached, ${s.failed} failed`,
        );
      }

      if (options.diagnostics && stats.timings) {
        console.log(`\n  Timings (total=${stats.timings.totalMs}ms):`);
        const entries = Object.entries(stats.timings.phases).sort(
          (a, b) => b[1] - a[1],
        );
        for (const [phase, ms] of entries) {
          console.log(`    ${ms.toString().padStart(6)}ms  ${phase}`);
        }
      }

      // Incremental runs defer cluster/process/algorithm/summary/embedding
      // recompute; surface that explicitly so the operator knows derived
      // state lags after this run.
      if (options.diagnostics) {
        try {
          const { getDerivedStateSummary } =
            await import("../../db/ladybug-derived-state.js");
          const ds = await getDerivedStateSummary(repo.repoId);
          if (ds?.stale) {
            const flags = [
              ds.clustersDirty && "clusters",
              ds.processesDirty && "processes",
              ds.algorithmsDirty && "algorithms",
              ds.summariesDirty && "summaries",
              ds.embeddingsDirty && "embeddings",
            ]
              .filter((x): x is string => Boolean(x))
              .join(", ");
            console.log(`  Derived-state deferred: ${flags}`);
          }
        } catch {
          // Non-fatal: diagnostics reporting is best-effort.
        }
      }

      // SCIP auto-ingest now runs INSIDE `indexRepoImpl` between pass 1 and
      // pass 2 (see indexer.ts). Progress is rendered through the same
      // `renderIndexProgress` pipeline as the rest of the index phases via
      // a new `stage: "scipIngest"` event. The CLI no longer needs its own
      // post-refresh SCIP block — it would duplicate work and miss the
      // edge-quality + embedding-quality wins of running pre-pass-2.
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`  Error indexing: ${msg}`);
      errors.push({ repoId: repo.repoId, error: msg });
    }
  }

  // Announce watch mode intention only if all repos indexed successfully
  if (options.watch && errors.length === 0) {
    for (const repo of reposToIndex) {
      console.log(`  File watcher will start for ${repo.repoId}`);
    }
  }

  if (errors.length > 0) {
    console.error(`\nFailed to index ${errors.length} repo(s):`);
    for (const e of errors) {
      console.error(`  - ${e.repoId}: ${e.error}`);
    }
    await cleanupOneShotIndexing(dbInitialized, derivedRefreshDisabled);
    process.exit(1);
  }

  if (options.watch && !canDelegate) {
    console.log("\nWatching for file changes (Ctrl+C to stop)...");

    const watchers: IndexWatchHandle[] = [];
    const results = await Promise.allSettled(
      reposToIndex.map(async (repo) => {
        try {
          return {
            repoId: repo.repoId,
            handle: await watchRepository(repo.repoId),
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          throw new Error(`[${repo.repoId}] ${msg}`);
        }
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        watchers.push(result.value.handle);
      } else {
        console.error(`Failed to start watcher: ${String(result.reason)}`);
      }
    }

    console.log(`Watching ${watchers.length} repo(s)`);

    let shutdownCalled = false;
    const shutdown = async (): Promise<void> => {
      if (shutdownCalled) {
        return;
      }
      shutdownCalled = true;
      console.log("\nStopping watchers...");
      for (const watcher of watchers) {
        await watcher.close();
      }
      await shutdownDerivedRefreshQueue();
      await closeLadybugDb();
      process.exit(0);
    };

    const handleShutdown = (signal: "SIGINT" | "SIGTERM"): void => {
      void shutdown().catch((error) => {
        console.error(
          `Failed to handle ${signal}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        process.exit(1);
      });
    };

    process.once("SIGINT", () => handleShutdown("SIGINT"));
    process.once("SIGTERM", () => handleShutdown("SIGTERM"));

    await new Promise(() => {});
  }

  if (!options.watch) {
    await cleanupOneShotIndexing(dbInitialized, derivedRefreshDisabled);
  }

  console.log("\n✓ Indexing complete");
}
