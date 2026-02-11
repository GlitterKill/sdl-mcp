#!/usr/bin/env tsx

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { pathToFileURL } from "url";

interface FamilyStats {
  family: string;
  p25TokenReductionPct: number;
  p50TokenReductionPct: number;
  minTokenReductionPct: number;
}

interface AggregatePayload {
  overall?: {
    minTokenReductionPct?: number;
  };
  families?: FamilyStats[];
}

function getArgValue(args: string[], name: string): string | undefined {
  const direct = args.find((arg) => arg.startsWith(`--${name}=`));
  if (direct) return direct.slice(name.length + 3);
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0) return args[idx + 1];
  return undefined;
}

function parseNumberArg(
  args: string[],
  name: string,
  fallback: number,
): number {
  const raw = getArgValue(args, name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function evaluateBenchmarkClaims(params: {
  aggregate: AggregatePayload;
  minFamilyP50: number;
  minFamilyP25: number;
  minTaskFloor: number;
}): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  const families = params.aggregate.families ?? [];

  if (families.length === 0) {
    failures.push("No family aggregates found.");
    return { passed: false, failures };
  }

  for (const family of families) {
    if (family.p50TokenReductionPct < params.minFamilyP50) {
      failures.push(
        `Family ${family.family} p50 ${family.p50TokenReductionPct.toFixed(1)}% < ${params.minFamilyP50.toFixed(1)}%`,
      );
    }
    if (family.p25TokenReductionPct < params.minFamilyP25) {
      failures.push(
        `Family ${family.family} p25 ${family.p25TokenReductionPct.toFixed(1)}% < ${params.minFamilyP25.toFixed(1)}%`,
      );
    }
    if (family.minTokenReductionPct < params.minTaskFloor) {
      failures.push(
        `Family ${family.family} min task ${family.minTokenReductionPct.toFixed(1)}% < ${params.minTaskFloor.toFixed(1)}%`,
      );
    }
  }

  const globalMin = params.aggregate.overall?.minTokenReductionPct;
  if (typeof globalMin === "number" && globalMin < params.minTaskFloor) {
    failures.push(
      `Overall min task ${globalMin.toFixed(1)}% < ${params.minTaskFloor.toFixed(1)}%`,
    );
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const inPathRaw = getArgValue(args, "in");
  if (!inPathRaw) {
    throw new Error("Missing required argument: --in <aggregate.json path>");
  }
  const inPath = resolve(inPathRaw);
  if (!existsSync(inPath)) {
    throw new Error(`Aggregate file not found: ${inPath}`);
  }

  const minFamilyP50 = parseNumberArg(args, "min-family-p50", 50);
  const minFamilyP25 = parseNumberArg(args, "min-family-p25", 40);
  const minTaskFloor = parseNumberArg(args, "min-task-floor", 20);

  const aggregate = JSON.parse(readFileSync(inPath, "utf-8")) as AggregatePayload;
  const evaluation = evaluateBenchmarkClaims({
    aggregate,
    minFamilyP50,
    minFamilyP25,
    minTaskFloor,
  });

  if (!evaluation.passed) {
    console.error("[claims-check] FAILED");
    for (const failure of evaluation.failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }

  console.log(
    `[claims-check] PASS (family p50>=${minFamilyP50}, family p25>=${minFamilyP25}, min task>=${minTaskFloor})`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
