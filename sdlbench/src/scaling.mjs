import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildPairedDeltas, runBenchmark } from "./sdlbench.mjs";
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
  executionMode = "behavior",
  experimentId = randomUUID(),
  repetitions = 1,
}, benchmark = runBenchmark) {
  if (!root) throw new Error("runScalingCurve: root is required (pass process.cwd() or repo root)");
  if (!["fixture", "behavior"].includes(executionMode)) throw new Error(`Unknown executionMode ${executionMode}`);
  if (!Number.isSafeInteger(repetitions) || repetitions < 1) throw new Error("repetitions must be a positive integer");
  if (!iUnderstandCost) {
    throw new Error(
      "Scaling run requires --i-understand-cost. Estimated budget: unknown; " +
      "agent usage and indexing expenses are not known before execution. " +
      "Pass --i-understand-cost to proceed.",
    );
  }

  const variants = [...new Set(variant.split(",").map((v) => v.trim()).filter(Boolean))];
  if (variants.length === 0) throw new Error("At least one scaling variant is required");
  if (variants.some((value) => !["baseline", "sdl"].includes(value))) throw new Error("Unsupported scaling variant; use baseline or sdl");
  const allRecords = [];
  const scalingRows = [];
  const selections = [];

  for (const sizeClass of [...new Set(sizeClasses)]) {
    const sizeRecords = [];
    for (let repetition = 0; repetition < repetitions; repetition++) {
      // Rotate order to distribute first-run effects across repeated comparisons.
      const offset = repetition % variants.length;
      const order = [...variants.slice(offset), ...variants.slice(0, offset)];
      for (const v of order) {
        const result = await benchmark({
          root,
          matrixPath,
          agent,
          model,
          variant: v,
          reposLockPath,
          sizeClassFilter: sizeClass,
          tokenizerCommand,
          executionMode,
          experimentId,
          repetitionId: String(repetition),
          warmSession: false,
          resultsPath: resolve(root, resultsDir, `scaling-${sizeClass}-${v}-${randomUUID()}.jsonl`),
        });
        // Selection belongs in the runner, before any paid agent or indexing work.
        selections.push({
          sizeClass, variant: v, repetitionId: String(repetition),
          selectedTaskCount: result.selectedTaskCount,
        });
        sizeRecords.push(...result.records);
      }
    }
    allRecords.push(...sizeRecords);
    const paired = buildPairedDeltas(sizeRecords);
    for (const productVariant of variants.filter((value) => value !== "baseline")) {
      const pairs = paired.filter((row) => row.variant === productVariant);
      if (pairs.length === 0) continue;
      const baselineTok = pairs.reduce((sum, row) => sum + row.baselineTok, 0);
      const productTok = pairs.reduce((sum, row) => sum + row.productTok, 0);
      const perTaskDeltaPcts = pairs.map((row) => row.deltaPct);
      const row = {
        experimentId,
        executionMode,
        sizeClass,
        variant: productVariant,
        selectedTaskCount: selections
          .filter((selection) => selection.sizeClass === sizeClass && selection.variant === productVariant)
          .reduce((sum, selection) => sum + selection.selectedTaskCount, 0),
        baselineTok,
        productTok,
        deltaPct: baselineTok > 0
          ? Math.round(((baselineTok - productTok) / baselineTok) * 10000) / 100
          : 0,
        pairedCount: pairs.length,
        medianDeltaPct: percentile(perTaskDeltaPcts, 50),
        perTaskDeltaPcts,
      };
      if (productVariant === "sdl") Object.assign(row, { sdlTok: productTok, sdlVariant: productVariant });
      scalingRows.push(row);
    }
  }

  const outputPath = resolve(root, resultsDir, `scaling-${randomUUID()}.jsonl`);
  await mkdir(dirname(outputPath), { recursive: true });
  const lines = scalingRows.map((row) => JSON.stringify(row)).join("\n");
  await writeFile(outputPath, lines ? `${lines}\n` : "", "utf8");
  return { experimentId, executionMode, scalingRows, selections, outputPath, records: allRecords };
}
