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

    const sizeRecords = allRecords.filter((record) => record.repo?.sizeClass === sizeClass);
    const byVariant = new Map(variants.map((productVariant) => [productVariant, new Map()]));
    for (const record of sizeRecords) {
      if (!record.quality?.passed) continue;
      byVariant.get(record.variant)?.set(record.taskId, record);
    }
    const baselineByTask = byVariant.get("baseline") ?? new Map();

    for (const productVariant of variants.filter((value) => value !== "baseline")) {
      const productByTask = byVariant.get(productVariant) ?? new Map();
      const pairedTasks = [...baselineByTask.keys()].filter((taskId) => productByTask.has(taskId));
      if (pairedTasks.length === 0) continue;

      const baselineTok = pairedTasks.reduce(
        (sum, taskId) => sum + (baselineByTask.get(taskId).tokens?.total ?? 0),
        0,
      );
      const productTok = pairedTasks.reduce(
        (sum, taskId) => sum + (productByTask.get(taskId).tokens?.total ?? 0),
        0,
      );
      const perTaskDeltaPcts = pairedTasks.map((taskId) => {
        const baselineTokens = baselineByTask.get(taskId).tokens?.total ?? 0;
        const productTokens = productByTask.get(taskId).tokens?.total ?? 0;
        return baselineTokens > 0
          ? Math.round(((baselineTokens - productTokens) / baselineTokens) * 10000) / 100
          : 0;
      });
      const row = {
        sizeClass,
        variant: productVariant,
        symbolCount: baselineByTask.get(pairedTasks[0])?.repo?.symbolCount ?? null,
        baselineTok,
        productTok,
        deltaPct: baselineTok > 0
          ? Math.round(((baselineTok - productTok) / baselineTok) * 10000) / 100
          : 0,
        pairedCount: pairedTasks.length,
        medianDeltaPct: percentile(perTaskDeltaPcts, 50),
        perTaskDeltaPcts,
      };
      if (productVariant === "sdl") {
        Object.assign(row, { sdlTok: productTok, sdlVariant: productVariant });
      }
      scalingRows.push(row);
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
