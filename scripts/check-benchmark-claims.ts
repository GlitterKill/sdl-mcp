#!/usr/bin/env tsx

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";

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

type ClaimProfile = "realism" | "efficient" | "smoke";

interface ClaimThresholds {
  minFamilyP50: number;
  minFamilyP25: number;
  minTaskFloor: number;
}

const CLAIM_PROFILE_THRESHOLDS: Record<ClaimProfile, ClaimThresholds> = {
  realism: {
    minFamilyP50: 50,
    minFamilyP25: 40,
    minTaskFloor: 20,
  },
  efficient: {
    minFamilyP50: 45,
    minFamilyP25: 35,
    minTaskFloor: 0,
  },
  smoke: {
    minFamilyP50: 30,
    minFamilyP25: 20,
    minTaskFloor: 5,
  },
};

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

function resolveProfile(raw: string | undefined): ClaimProfile {
  if (!raw) return "realism";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "realism") return "realism";
  if (
    normalized === "efficient" ||
    normalized === "benchmark-efficient" ||
    normalized === "efficiency"
  ) {
    return "efficient";
  }
  if (normalized === "smoke") return "smoke";
  throw new Error(
    `Invalid --profile "${raw}". Supported values: realism, efficient, smoke.`,
  );
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
  const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  if (!inPath.startsWith(projectRoot)) {
    throw new Error(`--in path must be within project directory: ${inPath}`);
  }
  if (!existsSync(inPath)) {
    throw new Error(`Aggregate file not found: ${inPath}`);
  }

  const profile = resolveProfile(getArgValue(args, "profile"));
  const defaults = CLAIM_PROFILE_THRESHOLDS[profile];
  const minFamilyP50 = parseNumberArg(
    args,
    "min-family-p50",
    defaults.minFamilyP50,
  );
  const minFamilyP25 = parseNumberArg(
    args,
    "min-family-p25",
    defaults.minFamilyP25,
  );
  const minTaskFloor = parseNumberArg(
    args,
    "min-task-floor",
    defaults.minTaskFloor,
  );

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
    `[claims-check] PASS profile=${profile} (family p50>=${minFamilyP50}, family p25>=${minFamilyP25}, min task>=${minTaskFloor})`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
