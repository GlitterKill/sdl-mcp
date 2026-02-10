#!/usr/bin/env tsx

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";

interface RealWorldTaskResult {
  id: string;
  category: string;
  title: string;
  difficulty?: "easy" | "medium" | "hard";
  baseline: {
    tokens: number;
  };
  sdl: {
    tokens: number;
  };
}

interface RealWorldBenchmarkPayload {
  generatedAt?: string;
  repoId?: string;
  tasks: RealWorldTaskResult[];
}

interface TaskDefinition {
  id: string;
  difficulty?: "easy" | "medium" | "hard";
}

interface TasksFile {
  tasks: TaskDefinition[];
}

interface ReplayTrace {
  id: string;
  scenario: string;
  traditional: {
    description: string;
    tokens: number;
  };
  sdlMcp: {
    description: string;
    tokens: number;
  };
  qualifier?: string;
  sourceTaskId: string;
  sourceRepoId?: string;
}

interface ReplayTraceFile {
  version: number;
  generatedAt: string;
  source: {
    inputFile: string;
    benchmarkGeneratedAt?: string;
  };
  traces: ReplayTrace[];
}

function getArgValue(args: string[], name: string): string | undefined {
  const direct = args.find((arg) => arg.startsWith(`--${name}=`));
  if (direct) return direct.slice(name.length + 3);
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0) return args[idx + 1];
  return undefined;
}

function main(): void {
  const args = process.argv.slice(2);
  const inputPath = resolve(
    getArgValue(args, "input") ?? "benchmarks/real-world/results.json",
  );
  const outPath = resolve(
    getArgValue(args, "out") ?? "benchmarks/synthetic/replay-traces.json",
  );
  const tasksPath = getArgValue(args, "tasks");
  const maxTraces = Number(getArgValue(args, "max") ?? "0");

  const inputRaw = readFileSync(inputPath, "utf-8");
  const payload = JSON.parse(inputRaw) as RealWorldBenchmarkPayload;

  // Build a difficulty lookup from tasks.json if provided (fallback for
  // results files that lack the difficulty field).
  let difficultyLookup: Map<string, "easy" | "medium" | "hard"> | undefined;
  if (tasksPath) {
    const tasksRaw = readFileSync(resolve(tasksPath), "utf-8");
    const tasksFile = JSON.parse(tasksRaw) as TasksFile;
    difficultyLookup = new Map(
      tasksFile.tasks
        .filter((t) => t.difficulty)
        .map((t) => [t.id, t.difficulty!]),
    );
  }

  const selectedTasks =
    maxTraces > 0 ? payload.tasks.slice(0, maxTraces) : payload.tasks;

  const traces: ReplayTrace[] = selectedTasks.map((task) => {
    const difficulty =
      task.difficulty ?? difficultyLookup?.get(task.id) ?? undefined;
    return {
      id: `trace-${task.id}`,
      scenario: task.title,
      traditional: {
        description: `${task.category} workflow replay (traditional)`,
        tokens: Math.max(0, Math.round(task.baseline.tokens)),
      },
      sdlMcp: {
        description: `${task.category} workflow replay (SDL tool-ladder)`,
        tokens: Math.max(0, Math.round(task.sdl.tokens)),
      },
      qualifier: difficulty ? `(${difficulty})` : undefined,
      sourceTaskId: task.id,
      sourceRepoId: payload.repoId,
    };
  });

  const replayFile: ReplayTraceFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: {
      inputFile: inputPath,
      benchmarkGeneratedAt: payload.generatedAt,
    },
    traces,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(replayFile, null, 2), "utf-8");

  console.log(`Recorded ${traces.length} replay traces to ${outPath}`);
}

main();
