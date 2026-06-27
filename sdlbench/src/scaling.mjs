import { runBenchmark } from "./sdlbench.mjs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { percentile } from "./stats.mjs";

export async function runScalingCurve({
  root,
  matrixPath,
  sizeClasses = ["tiny", "small"],
  agent = "codex",
  model,
  variant = "baseline,sdl",
  reposLockPath,
  resultsDir = "sdlbench/results",
  iUnderstandCost = false,
  tokenizerCommand,
}) {
  if (!root) throw new Error("runScalingCurve: root is required (pass process.cwd() or repo root)");
  if (!iUnderstandCost) {
    const budget = await estimateBudget({ root, reposLockPath, sizeClasses, agent, model });
    throw new Error(
      `Scaling run requires --i-understand-cost. Estimated budget: ${budget.estimatedUsd} USD ` +
      `across ${budget.taskCount} task pairs (${sizeClasses.join(", ")}). ` +
      `Pass --i-understand-cost to proceed.`
    );
  }

  const variants = variant.split(",").map((v) => v.trim()).filter(Boolean);
  const allRecords = [];
  const scalingRows = [];

  for (const sizeClass of sizeClasses) {
    for (const v of variants) {
      const result = await runBenchmark({
        root,
        matrixPath,
        agent,
        model,
        variant: v,
        reposLockPath,
        repoIdFilter: null,
        tokenizerCommand,
        warmSession: false,
        resultsPath: join(root, resultsDir, `scaling-${sizeClass}-${v}-${Date.now()}.jsonl`),
      });

      for (const record of result.records) {
        if (record.repo?.sizeClass === sizeClass) {
          allRecords.push(record);
        }
      }
    }

    const sizeRecords = allRecords.filter((r) => r.repo?.sizeClass === sizeClass);
    const baselineByTask = new Map();
    const sdlByTask = new Map();
    for (const r of sizeRecords) {
      if (!r.quality?.passed) continue;
      const bucket = r.variant === "baseline" ? baselineByTask : (r.variant === "sdl" ? sdlByTask : null);
      if (!bucket) continue;
      bucket.set(r.taskId, r);
    }
    const pairedTasks = [...baselineByTask.keys()].filter((id) => sdlByTask.has(id));
    if (pairedTasks.length > 0) {
      const baselineToks = pairedTasks.map((id) => baselineByTask.get(id).tokens?.total ?? 0);
      const sdlToks = pairedTasks.map((id) => sdlByTask.get(id).tokens?.total ?? 0);
      const baselineTok = baselineToks.reduce((a, b) => a + b, 0);
      const sdlTok = sdlToks.reduce((a, b) => a + b, 0);
      const perTaskDeltaPcts = pairedTasks.map((id) => {
        const b = baselineByTask.get(id).tokens?.total ?? 0;
        const s = sdlByTask.get(id).tokens?.total ?? 0;
        return b > 0 ? Math.round(((b - s) / b) * 10000) / 100 : 0;
      });
      scalingRows.push({
        sizeClass,
        symbolCount: sdlByTask.get(pairedTasks[0])?.artifacts?.sdl?.observability?.indexing_totalEvents ?? 0,
        baselineTok,
        sdlTok,
        deltaPct: baselineTok > 0
          ? Math.round(((baselineTok - sdlTok) / baselineTok) * 10000) / 100
          : 0,
        pairedCount: pairedTasks.length,
        medianDeltaPct: percentile(perTaskDeltaPcts, 50),
        perTaskDeltaPcts,
      });
    }
  }

  const outputPath = join(root, resultsDir, `scaling-${Date.now()}.jsonl`);
  await mkdir(dirname(outputPath), { recursive: true });
  const lines = scalingRows.map((row) => JSON.stringify(row)).join("\n");
  await writeFile(outputPath, `${lines}\n`, "utf8");

  return { scalingRows, outputPath, records: allRecords };
}

async function estimateBudget({ root, reposLockPath, sizeClasses, agent, model }) {
  let lock;
  try {
    const text = await readFile(
      reposLockPath
        ? (reposLockPath.startsWith("/") || reposLockPath.includes(":") ? reposLockPath : join(root, reposLockPath))
        : join(root, "sdlbench/config/repos.lock.json"),
      "utf8"
    );
    lock = JSON.parse(text);
  } catch {
    lock = { repos: [] };
  }

  const matching = lock.repos?.filter((r) => sizeClasses.includes(r.sizeClass)) ?? [];
  const taskCount = matching.length * 2;
  const avgTokPerTask = 5000;
  const pricePerMTok = 5 + 30;
  const inputRatio = 0.8;
  const estimatedUsd = Math.round(taskCount * avgTokPerTask * (pricePerMTok / 1_000_000) * inputRatio * 100) / 100;

  return { estimatedUsd, taskCount, sizeClasses, matching: matching.map((r) => r.repoId) };
}
