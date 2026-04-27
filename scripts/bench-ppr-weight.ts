#!/usr/bin/env tsx
/**
 * A/B sweep for `DEFAULT_PPR_WEIGHT`.
 *
 * Runs `hybridSearch` with each candidate `pprWeight` against a fixture set
 * and reports NDCG@10 / recall@20 / latency. Designed to be a one-shot tune
 * before locking the default; not part of CI.
 *
 * Run: npm run bench:ppr -- --repo sdl-mcp --fixture tests/fixtures/ppr-tune/queries.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface MentionConfigs {
  near: string[];
  far: string[];
}

interface FixtureQuery {
  id: string;
  category: "debug" | "implement" | "explain";
  query: string;
  groundTruth: string[];
  mentions: MentionConfigs;
}

interface FixtureFile {
  repoId: string;
  queries: FixtureQuery[];
}

type MentionConfigKey = "none" | "near" | "far";

interface RunMetric {
  weight: number;
  queryId: string;
  category: FixtureQuery["category"];
  config: MentionConfigKey;
  ndcg10: number;
  recall20: number;
  latencyMs: number;
  pprLatencyMs: number;
  resultCount: number;
}

const DEFAULT_WEIGHTS = [0, 0.1, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0];
const NDCG_K = 10;
const RECALL_K = 20;
// Decision-rule thresholds.
const TIE_TOLERANCE = 0.01; // weights within 1% NDCG are considered tied
const RRF_BEAT_MARGIN = 0.05; // pprWeight!=0 must win by ≥5% over RRF-only

function getArg(name: string, fallback?: string): string | undefined {
  const flag = `--${name}`;
  const idx = process.argv.findIndex(
    (a) => a === flag || a.startsWith(`${flag}=`),
  );
  if (idx === -1) return fallback;
  const arg = process.argv[idx];
  if (arg.includes("=")) return arg.split("=", 2)[1];
  return process.argv[idx + 1] ?? fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function ndcgAtK(
  predicted: readonly string[],
  groundTruth: readonly string[],
  k: number,
): number {
  const truthSet = new Set(groundTruth);
  let dcg = 0;
  for (let i = 0; i < Math.min(predicted.length, k); i++) {
    if (truthSet.has(predicted[i])) dcg += 1 / Math.log2(i + 2);
  }
  const idealRel = Math.min(groundTruth.length, k);
  let idcg = 0;
  for (let i = 0; i < idealRel; i++) idcg += 1 / Math.log2(i + 2);
  return idcg > 0 ? dcg / idcg : 0;
}

function recallAtK(
  predicted: readonly string[],
  groundTruth: readonly string[],
  k: number,
): number {
  if (groundTruth.length === 0) return 1;
  const top = new Set(predicted.slice(0, k));
  let hits = 0;
  for (const id of groundTruth) if (top.has(id)) hits++;
  return hits / groundTruth.length;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((p / 100) * sorted.length)),
  );
  return sorted[idx];
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

interface AggregateRow {
  weight: number;
  ndcgMean: number;
  ndcgPerCategory: Record<string, number>;
  ndcgPerConfig: Record<string, number>;
  recall20Mean: number;
  pprLatencyP50: number;
  pprLatencyP95: number;
  totalLatencyP95: number;
  runs: number;
}

function aggregate(metrics: readonly RunMetric[]): AggregateRow[] {
  const byWeight = new Map<number, RunMetric[]>();
  for (const m of metrics) {
    const list = byWeight.get(m.weight) ?? [];
    list.push(m);
    byWeight.set(m.weight, list);
  }

  const rows: AggregateRow[] = [];
  for (const [weight, runs] of byWeight) {
    const byCategory = new Map<string, number[]>();
    const byConfig = new Map<string, number[]>();
    for (const r of runs) {
      const cat = byCategory.get(r.category) ?? [];
      cat.push(r.ndcg10);
      byCategory.set(r.category, cat);
      const cfg = byConfig.get(r.config) ?? [];
      cfg.push(r.ndcg10);
      byConfig.set(r.config, cfg);
    }

    const ndcgPerCategory: Record<string, number> = {};
    for (const [k, v] of byCategory) ndcgPerCategory[k] = mean(v);
    const ndcgPerConfig: Record<string, number> = {};
    for (const [k, v] of byConfig) ndcgPerConfig[k] = mean(v);

    rows.push({
      weight,
      ndcgMean: mean(runs.map((r) => r.ndcg10)),
      ndcgPerCategory,
      ndcgPerConfig,
      recall20Mean: mean(runs.map((r) => r.recall20)),
      pprLatencyP50: percentile(
        runs.map((r) => r.pprLatencyMs),
        50,
      ),
      pprLatencyP95: percentile(
        runs.map((r) => r.pprLatencyMs),
        95,
      ),
      totalLatencyP95: percentile(
        runs.map((r) => r.latencyMs),
        95,
      ),
      runs: runs.length,
    });
  }
  rows.sort((a, b) => a.weight - b.weight);
  return rows;
}

function pickWinner(
  rows: readonly AggregateRow[],
  baselineLatencyP95: number,
): { weight: number; rationale: string } {
  // Rule 0: locate RRF-only baseline.
  const baseline = rows.find((r) => r.weight === 0);
  if (!baseline) {
    return { weight: 0.5, rationale: "no baseline run, falling back to 0.5" };
  }

  // Gates: recall ≥ baseline.recall - 1%, p95 latency ≤ baseline + 5ms.
  const eligible = rows.filter(
    (r) =>
      r.recall20Mean >= baseline.recall20Mean - 0.01 &&
      r.totalLatencyP95 <= baselineLatencyP95 + 5,
  );

  if (eligible.length === 0) {
    return {
      weight: 0,
      rationale: "no candidate passed recall/latency gates; defaulting to 0",
    };
  }

  // Rule 3: if best non-zero weight does not beat baseline by ≥5% NDCG, ship 0.
  const sortedByNdcg = [...eligible].sort((a, b) => b.ndcgMean - a.ndcgMean);
  const best = sortedByNdcg[0];
  if (best.weight !== 0) {
    const lift =
      (best.ndcgMean - baseline.ndcgMean) / Math.max(baseline.ndcgMean, 1e-9);
    if (lift < RRF_BEAT_MARGIN) {
      return {
        weight: 0,
        rationale: `best non-zero (${best.weight}) lift ${(lift * 100).toFixed(2)}% < ${(RRF_BEAT_MARGIN * 100).toFixed(0)}% threshold`,
      };
    }
  }

  // Rule 2: if multiple weights tie within TIE_TOLERANCE, pick lowest.
  const tied = sortedByNdcg.filter(
    (r) =>
      Math.abs(r.ndcgMean - best.ndcgMean) <= TIE_TOLERANCE * best.ndcgMean,
  );
  tied.sort((a, b) => a.weight - b.weight);
  const winner = tied[0];

  return {
    weight: winner.weight,
    rationale:
      tied.length > 1
        ? `${tied.length} weights tied within ${(TIE_TOLERANCE * 100).toFixed(0)}%; chose lowest (${winner.weight})`
        : `single winner: ${winner.weight} (NDCG ${winner.ndcgMean.toFixed(4)})`,
  };
}

function formatTable(rows: readonly AggregateRow[]): string {
  const header =
    "weight | ndcg_mean | ndcg_none | ndcg_near | ndcg_far  | recall@20 | ppr_p50ms | ppr_p95ms | total_p95ms";
  const sep = "-".repeat(header.length);
  const lines = [header, sep];
  for (const r of rows) {
    lines.push(
      [
        r.weight.toFixed(2).padStart(6),
        r.ndcgMean.toFixed(4).padStart(9),
        (r.ndcgPerConfig.none ?? 0).toFixed(4).padStart(9),
        (r.ndcgPerConfig.near ?? 0).toFixed(4).padStart(9),
        (r.ndcgPerConfig.far ?? 0).toFixed(4).padStart(9),
        r.recall20Mean.toFixed(4).padStart(9),
        r.pprLatencyP50.toFixed(1).padStart(9),
        r.pprLatencyP95.toFixed(1).padStart(9),
        r.totalLatencyP95.toFixed(1).padStart(11),
      ].join(" | "),
    );
  }
  return lines.join("\n");
}

interface IdRow {
  symbolId: string;
}

async function resolveNamesToIds(
  conn: import("kuzu").Connection,
  repoId: string,
  names: readonly string[],
  queryAll: <T>(
    conn: import("kuzu").Connection,
    cy: string,
    params?: Record<string, unknown>,
  ) => Promise<T[]>,
): Promise<string[]> {
  const out: string[] = [];
  for (const name of names) {
    try {
      const rows = await queryAll<IdRow>(
        conn,
        `MATCH (s:Symbol)
         WHERE s.repoId = $repoId AND s.name = $name
         RETURN s.symbolId AS symbolId
         LIMIT 1`,
        { repoId, name },
      );
      if (rows.length > 0) out.push(rows[0].symbolId);
    } catch {
      // skip
    }
  }
  return out;
}

/** Compare current bench winner against a checked-in baseline; for CI gating. */
function compareToBaseline(
  current: { weight: number; ndcgMean: number },
  baselinePath: string,
  thresholdPct: number,
): { ok: boolean; message: string } {
  let baseline: {
    winner?: { weight: number };
    aggregate?: AggregateRow[];
  };
  try {
    baseline = JSON.parse(readFileSync(resolve(baselinePath), "utf-8"));
  } catch (err) {
    return {
      ok: false,
      message: `failed to read baseline ${baselinePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  const baseWinnerWeight = baseline.winner?.weight;
  if (baseWinnerWeight === undefined || !baseline.aggregate) {
    return { ok: false, message: "baseline missing winner / aggregate" };
  }
  const baseRow = baseline.aggregate.find((r) => r.weight === baseWinnerWeight);
  if (!baseRow) {
    return {
      ok: false,
      message: `baseline winner weight ${baseWinnerWeight} not in aggregate`,
    };
  }
  const lift =
    (current.ndcgMean - baseRow.ndcgMean) / Math.max(baseRow.ndcgMean, 1e-9);
  const dropPct = -lift * 100;
  if (dropPct > thresholdPct) {
    return {
      ok: false,
      message: `regression: current winner (w=${current.weight}, NDCG ${current.ndcgMean.toFixed(4)}) is ${dropPct.toFixed(2)}% below baseline winner (w=${baseWinnerWeight}, NDCG ${baseRow.ndcgMean.toFixed(4)}) — exceeds ${thresholdPct.toFixed(1)}% gate`,
    };
  }
  return {
    ok: true,
    message: `ok: current NDCG ${current.ndcgMean.toFixed(4)} vs baseline ${baseRow.ndcgMean.toFixed(4)} (delta ${(lift * 100).toFixed(2)}%, gate ${thresholdPct.toFixed(1)}%)`,
  };
}

async function main(): Promise<void> {
  const fixturePath = getArg("fixture", "tests/fixtures/ppr-tune/queries.json");
  const repoOverride = getArg("repo");
  const jsonOut = getArg("json");
  const weightsArg = getArg("weights");
  const baselinePath = getArg("baseline");
  const baselineThresholdPct = Number(getArg("baseline-threshold", "2")) || 2;
  const holdoutN = Math.max(0, Number(getArg("holdout", "0")) || 0);
  const verbose = hasFlag("verbose");
  const includeFar = !hasFlag("skip-far");

  if (!fixturePath) {
    console.error("missing --fixture");
    process.exit(2);
  }

  const weights = weightsArg
    ? weightsArg
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n))
    : DEFAULT_WEIGHTS;

  const fixture = JSON.parse(
    readFileSync(resolve(fixturePath), "utf-8"),
  ) as FixtureFile;
  const repoId = repoOverride ?? fixture.repoId;

  console.log(`[bench:ppr] repo=${repoId} fixture=${fixturePath}`);
  console.log(
    `[bench:ppr] weights=${weights.join(",")} queries=${fixture.queries.length}`,
  );

  const { hybridSearch } = await import("../dist/retrieval/orchestrator.js");
  const { getLadybugConn } = await import("../dist/db/ladybug.js");
  const { queryAll } = await import("../dist/db/ladybug-core.js");
  const { _clearPprCache } = await import("../dist/retrieval/ppr.js");
  const { initGraphDb } = await import("../dist/db/initGraphDb.js");
  const { loadConfig } = await import("../dist/config/loadConfig.js");
  const { resolveCliConfigPath } = await import("../dist/config/configPath.js");

  const configPath = resolveCliConfigPath(undefined, "read");
  const config = loadConfig(configPath);
  await initGraphDb(config, configPath);
  const conn = await getLadybugConn();

  // Resolve ground truth once per query.
  const truthCache = new Map<string, string[]>();
  for (const q of fixture.queries) {
    truthCache.set(
      q.id,
      await resolveNamesToIds(conn, repoId, q.groundTruth, queryAll),
    );
  }

  const configs: MentionConfigKey[] = includeFar
    ? ["none", "near", "far"]
    : ["none", "near"];

  // Holdout split: first (n-N) queries are the train set the winner is picked
  // from; last N queries are the held-out set used to detect overfit. With
  // holdoutN=0 (default) every query is in train, holdout is empty.
  const allQueries = fixture.queries;
  const holdoutCount = Math.min(holdoutN, Math.max(0, allQueries.length - 1));
  const trainQueries =
    holdoutCount > 0 ? allQueries.slice(0, -holdoutCount) : allQueries;
  const holdoutQueries =
    holdoutCount > 0 ? allQueries.slice(-holdoutCount) : [];
  if (holdoutCount > 0) {
    console.log(
      `[bench:ppr] holdout split: train=${trainQueries.length} holdout=${holdoutQueries.length}`,
    );
  }
  const trainIds = new Set(trainQueries.map((q) => q.id));
  const holdoutIds = new Set(holdoutQueries.map((q) => q.id));

  const metrics: RunMetric[] = [];
  let runIdx = 0;
  const totalRuns = weights.length * allQueries.length * configs.length;

  for (const weight of weights) {
    _clearPprCache();
    for (const q of allQueries) {
      const truth = truthCache.get(q.id) ?? [];
      if (truth.length === 0) {
        if (verbose)
          console.warn(
            `[bench:ppr] ${q.id}: no ground truth resolved, skipping`,
          );
        continue;
      }
      for (const config of configs) {
        const chatMentions =
          config === "none" ? [] : (q.mentions[config] ?? []);
        const t0 = performance.now();
        let result;
        try {
          result = await hybridSearch({
            repoId,
            query: q.query,
            limit: 30,
            includeEvidence: true,
            chatMentions,
            pprWeight: weight,
          });
        } catch (err) {
          console.error(
            `[bench:ppr] hybridSearch failed for ${q.id}/${config}/w=${weight}: ${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
        const latencyMs = Math.round(performance.now() - t0);
        const predicted = result.results.map((r) => r.symbolId);
        const ndcg10 = ndcgAtK(predicted, truth, NDCG_K);
        const recall20 = recallAtK(predicted, truth, RECALL_K);
        const pprLatencyMs = result.evidence?.pprBoosts?.latencyMs ?? 0;
        metrics.push({
          weight,
          queryId: q.id,
          category: q.category,
          config,
          ndcg10,
          recall20,
          latencyMs,
          pprLatencyMs,
          resultCount: predicted.length,
        });
        runIdx++;
        if (verbose && runIdx % 20 === 0) {
          console.log(
            `[bench:ppr] ${runIdx}/${totalRuns} done (latest: ${q.id}/${config}/w=${weight} ndcg=${ndcg10.toFixed(3)})`,
          );
        }
      }
    }
  }

  // Train aggregate (used to pick the winner).
  const trainMetrics =
    holdoutCount > 0 ? metrics.filter((m) => trainIds.has(m.queryId)) : metrics;
  const rows = aggregate(trainMetrics);
  const baselineLatency =
    rows.find((r) => r.weight === 0)?.totalLatencyP95 ?? 0;
  const winner = pickWinner(rows, baselineLatency);

  console.log("");
  console.log(formatTable(rows));
  console.log("");
  console.log(`[bench:ppr] WINNER: pprWeight=${winner.weight}`);
  console.log(`[bench:ppr] rationale: ${winner.rationale}`);

  // Holdout report: same aggregation on holdout subset, focus on winner row.
  let holdoutReport:
    | {
        train: { weight: number; ndcgMean: number };
        holdout: {
          weight: number;
          ndcgMean: number;
          ndcgWinnerOnHoldout: number;
        };
        deltaPct: number;
      }
    | undefined;
  if (holdoutCount > 0) {
    const holdoutRows = aggregate(
      metrics.filter((m) => holdoutIds.has(m.queryId)),
    );
    const trainWinnerRow = rows.find((r) => r.weight === winner.weight);
    const holdoutSameWeight = holdoutRows.find(
      (r) => r.weight === winner.weight,
    );
    const holdoutOwnWinner = holdoutRows.length
      ? [...holdoutRows].sort((a, b) => b.ndcgMean - a.ndcgMean)[0]
      : undefined;
    if (trainWinnerRow && holdoutSameWeight && holdoutOwnWinner) {
      const trainNdcg = trainWinnerRow.ndcgMean;
      const holdoutNdcg = holdoutSameWeight.ndcgMean;
      const deltaPct =
        trainNdcg > 0 ? ((holdoutNdcg - trainNdcg) / trainNdcg) * 100 : 0;
      holdoutReport = {
        train: { weight: winner.weight, ndcgMean: trainNdcg },
        holdout: {
          weight: winner.weight,
          ndcgMean: holdoutNdcg,
          ndcgWinnerOnHoldout: holdoutOwnWinner.ndcgMean,
        },
        deltaPct,
      };
      console.log("");
      console.log(
        `[bench:ppr] HOLDOUT: train(w=${winner.weight}) NDCG ${trainNdcg.toFixed(4)} -> holdout(w=${winner.weight}) NDCG ${holdoutNdcg.toFixed(4)} (delta ${deltaPct.toFixed(2)}%)`,
      );
      if (holdoutOwnWinner.weight !== winner.weight) {
        console.log(
          `[bench:ppr] note: holdout would have picked w=${holdoutOwnWinner.weight} (NDCG ${holdoutOwnWinner.ndcgMean.toFixed(4)})`,
        );
      }
    }
  }

  // Baseline gate: compare winner NDCG against a checked-in baseline file.
  let baselineCheck: { ok: boolean; message: string } | undefined;
  const winnerRow = rows.find((r) => r.weight === winner.weight);
  if (baselinePath && winnerRow) {
    baselineCheck = compareToBaseline(
      { weight: winner.weight, ndcgMean: winnerRow.ndcgMean },
      baselinePath,
      baselineThresholdPct,
    );
    console.log("");
    console.log(
      `[bench:ppr] BASELINE: ${baselineCheck.ok ? "PASS" : "FAIL"} — ${baselineCheck.message}`,
    );
  }

  if (jsonOut) {
    const payload = {
      repoId,
      fixturePath,
      weights,
      metrics,
      aggregate: rows,
      winner,
      holdout: holdoutReport,
      baselineCheck,
      timestamp: new Date().toISOString(),
    };
    writeFileSync(resolve(jsonOut), JSON.stringify(payload, null, 2), "utf-8");
    console.log(`[bench:ppr] wrote results to ${jsonOut}`);
  }

  if (baselineCheck && !baselineCheck.ok) {
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[bench:ppr] fatal:", err);
    process.exit(1);
  });
