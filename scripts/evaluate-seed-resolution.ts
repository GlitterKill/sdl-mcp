import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  buildSeedEntitySearchPlan,
  inferFocusPathsFromTaskText,
} from "../dist/agent/context-seeding.js";
import { Planner } from "../dist/agent/planner.js";
import type { AgentTask } from "../dist/agent/types.js";
import {
  collectTaskTextSeedTokens,
  getTaskTextTokenRank,
} from "../dist/graph/slice/start-node-resolver.js";
import {
  isNativeAddonGloballyEnabled,
  loadNativeAddon,
} from "../dist/native/addon-loader.js";
import { autoExtractMentions } from "../dist/retrieval/seed-resolver.js";

interface CorpusCase {
  id: string;
  taskType: AgentTask["taskType"];
  contextMode: "precise" | "broad";
  taskText: string;
  focusPaths: string[];
  expected: {
    contextPaths: string[];
    sliceTokens: string[];
    agentRefs: string[];
  };
}

interface Corpus {
  schemaVersion: number;
  source: string;
  cases: CorpusCase[];
}

const ROOT = resolve(import.meta.dirname, "..");
const CORPUS_PATH = resolve(
  ROOT,
  "devdocs/benchmarks/seed-resolution-corpus-v1.json",
);
const OUTPUT_PATH = resolve(
  ROOT,
  "devdocs/benchmarks/seed-resolution-evaluation-v1.json",
);
const SOURCE_PATHS = [
  "src/agent/context-seeding.ts",
  "src/agent/planner.ts",
  "src/agent/executor.ts",
  "src/graph/slice/start-node-resolver.ts",
  "src/retrieval/seed-resolver.ts",
] as const;
const ITERATIONS = 25;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceHashes(): Record<string, string> {
  return Object.fromEntries(
    SOURCE_PATHS.map((path) => [path, sha256(readFileSync(resolve(ROOT, path), "utf8"))]),
  );
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function recall(actual: readonly string[], expected: readonly string[]): number | null {
  if (expected.length === 0) return null;
  const actualSet = new Set(actual);
  const hits = expected.filter((item) => actualSet.has(item)).length;
  return Number((hits / expected.length).toFixed(3));
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function roundedMs(value: number): number {
  return Number(value.toFixed(4));
}

async function evaluateCase(input: CorpusCase) {
  const contextPlan = buildSeedEntitySearchPlan(
    input.taskText,
    input.contextMode === "broad",
  );
  const contextPaths = inferFocusPathsFromTaskText(input.taskText);
  const mentions = autoExtractMentions(input.taskText);
  const sliceTokens = collectTaskTextSeedTokens(input.taskText);
  const planner = new Planner();
  const task: AgentTask = {
    repoId: "seed-resolution-fixture",
    taskType: input.taskType,
    taskText: input.taskText,
    options: {
      contextMode: input.contextMode,
      focusPaths: input.focusPaths,
    },
  };
  const agentRefs = await planner.selectContext(task);

  return {
    id: input.id,
    contextAssembly: {
      rankedPathHints: contextPaths,
      autoMentions: mentions,
      ftsQuery: contextPlan.ftsQuery,
      entityTypes: contextPlan.entityTypes,
      toolQaFocused: contextPlan.toolQaFocused,
      recall: recall(contextPaths, input.expected.contextPaths),
      evidence: "concept map + action-aware FTS query + mention extraction",
    },
    sliceStartNodes: {
      rankedTaskTokens: sliceTokens.map((token) => ({
        token,
        rank: getTaskTextTokenRank(token),
      })),
      recall: recall(sliceTokens, input.expected.sliceTokens),
      evidence: "token rank, then token length, then graph/DB symbol matching",
    },
    autopilotExecution: {
      rankedExplicitContext: agentRefs,
      plannedRungs: planner.plan(task).rungs,
      recall: recall(agentRefs, input.expected.agentRefs),
      evidence: "caller order for explicit symbols/paths; executor fallback is later",
    },
  };
}

async function measureLatency(corpus: Corpus): Promise<Record<string, number>> {
  const samples = {
    contextAssembly: [] as number[],
    sliceStartNodes: [] as number[],
    autopilotExecution: [] as number[],
  };
  const planner = new Planner();
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    for (const item of corpus.cases) {
      let started = performance.now();
      buildSeedEntitySearchPlan(item.taskText, item.contextMode === "broad");
      inferFocusPathsFromTaskText(item.taskText);
      autoExtractMentions(item.taskText);
      samples.contextAssembly.push(performance.now() - started);

      started = performance.now();
      collectTaskTextSeedTokens(item.taskText);
      samples.sliceStartNodes.push(performance.now() - started);

      started = performance.now();
      await planner.selectContext({
        repoId: "seed-resolution-fixture",
        taskType: item.taskType,
        taskText: item.taskText,
        options: { contextMode: item.contextMode, focusPaths: item.focusPaths },
      });
      samples.autopilotExecution.push(performance.now() - started);
    }
  }
  return Object.fromEntries(
    Object.entries(samples).map(([name, values]) => [name, roundedMs(median(values))]),
  );
}

function averageRecall(
  cases: Awaited<ReturnType<typeof evaluateCase>>[],
  stack: "contextAssembly" | "sliceStartNodes" | "autopilotExecution",
): number {
  const values = cases
    .map((item) => item[stack].recall)
    .filter((value): value is number => value !== null);
  return Number(
    (values.reduce((total, value) => total + value, 0) / values.length).toFixed(3),
  );
}

function stableProjection(report: Record<string, unknown>): unknown {
  return {
    schemaVersion: report.schemaVersion,
    corpus: report.corpus,
    sourceHashes: (report.baseline as { sourceHashes: unknown }).sourceHashes,
    cases: report.cases,
    quality: report.quality,
    recommendation: report.recommendation,
  };
}

async function main(): Promise<void> {
  const corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as Corpus;
  const cases = [];
  for (const item of corpus.cases) cases.push(await evaluateCase(item));
  const nativeEnabled = isNativeAddonGloballyEnabled();
  const report = {
    schemaVersion: 1,
    corpus: {
      version: corpus.schemaVersion,
      source: corpus.source,
      sha256: sha256(readFileSync(CORPUS_PATH, "utf8")),
      caseCount: corpus.cases.length,
    },
    baseline: {
      gitHead: git(["rev-parse", "HEAD"]),
      evaluatedSourceDiffSha256: sha256(
        git(["diff", "--binary", "HEAD", "--", ...SOURCE_PATHS]),
      ),
      sourceHashes: sourceHashes(),
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      config: "not used; fixture-only pure-policy evaluation",
      indexVersion: null,
      providerModelSettings: "not used; no DB, embedding, or provider calls",
      nativeAddon: {
        globallyEnabled: nativeEnabled,
        available: nativeEnabled && loadNativeAddon() !== null,
        usedByEvaluation: false,
      },
    },
    cases,
    quality: {
      metric: "per-stack labeled recall; cross-stack top-k overlap is invalid because seed domains differ",
      contextAssemblyRecall: averageRecall(cases, "contextAssembly"),
      sliceStartNodeRecall: averageRecall(cases, "sliceStartNodes"),
      autopilotExplicitScopeRecall: averageRecall(cases, "autopilotExecution"),
    },
    observedMedianPolicyLatencyMs: await measureLatency(corpus),
    interfaces: {
      contextAssembly: "task text/options -> entity query plan + mixed entity candidates -> context refs",
      sliceStartNodes: "entry symbols/stack/test/edited files/task text -> prioritized symbol start nodes",
      autopilotExecution: "explicit focus + planned rungs -> resolved context; later per-rung fallback and ranking",
    },
    recommendation: {
      option: 2,
      summary: "Share proven candidate-retrieval primitives only; retain stack-specific ranking adapters.",
      implementationApproved: true,
      followUpPlan:
        "devdocs/plans/2026-07-13-seed-resolution-option-2-implementation-plan.md",
    },
    reproduction: "npm run benchmark:seed-resolution",
    check: "npm run build && node --experimental-strip-types scripts/evaluate-seed-resolution.ts --check",
  };

  if (process.argv.includes("--check")) {
    const existing = JSON.parse(readFileSync(OUTPUT_PATH, "utf8")) as Record<string, unknown>;
    if (JSON.stringify(stableProjection(existing)) !== JSON.stringify(stableProjection(report))) {
      throw new Error("Seed Resolution evaluation artifact is stale");
    }
    console.log("seed-resolution-evaluation: OK");
    return;
  }

  writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Seed Resolution evaluation saved to ${OUTPUT_PATH}`);
}

await main();
