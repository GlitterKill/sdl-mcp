import { readFileSync } from "fs";
import { join } from "path";
import type { ExtractedCall } from "../indexer/treesitter/extractCalls.js";
import type { CallResolutionContext } from "../indexer/adapter/LanguageAdapter.js";
import { PythonAdapter } from "../indexer/adapter/python.js";
import { GoAdapter } from "../indexer/adapter/go.js";
import { JavaAdapter } from "../indexer/adapter/java.js";

export interface EdgeAccuracyScore {
  language: string;
  cases: number;
  precision: number;
  recall: number;
  f1: number;
  strategyAccuracy: number;
}

interface EdgeAccuracyCase {
  language: "python" | "go" | "java";
  name: string;
  call: string;
  expectedResolved: boolean;
  expectedStrategy: "exact" | "heuristic" | "unresolved";
  importedNameToSymbolIds: Record<string, string[]>;
  namespaceImports: Record<string, Record<string, string>>;
  nameToSymbolIds: Record<string, string[]>;
}

interface EdgeAccuracyFixture {
  version: string;
  cases: EdgeAccuracyCase[];
}

function buildCall(calleeIdentifier: string): ExtractedCall {
  return {
    callerNodeId: "benchmark:caller",
    calleeIdentifier,
    isResolved: false,
    callType: "function",
    range: {
      startLine: 1,
      startCol: 0,
      endLine: 1,
      endCol: 1,
    },
  };
}

function toStringMap(
  source: Record<string, string[]>,
): Map<string, string[]> {
  return new Map(Object.entries(source));
}

function toNamespaceMap(
  source: Record<string, Record<string, string>>,
): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const [key, value] of Object.entries(source)) {
    out.set(key, new Map(Object.entries(value)));
  }
  return out;
}

function loadFixture(): EdgeAccuracyFixture {
  const path = join(process.cwd(), "tests/benchmark/edge-accuracy/cases.json");
  return JSON.parse(readFileSync(path, "utf-8")) as EdgeAccuracyFixture;
}

function buildContext(input: EdgeAccuracyCase): CallResolutionContext {
  return {
    call: buildCall(input.call),
    importedNameToSymbolIds: toStringMap(input.importedNameToSymbolIds),
    namespaceImports: toNamespaceMap(input.namespaceImports),
    nameToSymbolIds: toStringMap(input.nameToSymbolIds),
  };
}

function getResolver(language: "python" | "go" | "java") {
  switch (language) {
    case "python":
      return new PythonAdapter();
    case "go":
      return new GoAdapter();
    case "java":
      return new JavaAdapter();
    default:
      return null;
  }
}

function computeF1(precision: number, recall: number): number {
  if (precision <= 0 || recall <= 0) {
    return 0;
  }
  return (2 * precision * recall) / (precision + recall);
}

export function evaluateEdgeAccuracySuite(): EdgeAccuracyScore[] {
  const fixture = loadFixture();
  const byLanguage = new Map<string, EdgeAccuracyCase[]>();

  for (const scenario of fixture.cases) {
    const list = byLanguage.get(scenario.language) ?? [];
    list.push(scenario);
    byLanguage.set(scenario.language, list);
  }

  const scores: EdgeAccuracyScore[] = [];

  for (const [language, scenarios] of byLanguage) {
    const adapter = getResolver(language as "python" | "go" | "java");
    let truePositives = 0;
    let predictedPositives = 0;
    let expectedPositives = 0;
    let strategyMatches = 0;

    for (const scenario of scenarios) {
      const result = adapter?.resolveCall?.(buildContext(scenario)) ?? null;
      const predictedResolved = Boolean(result?.isResolved);
      if (scenario.expectedResolved) {
        expectedPositives += 1;
      }
      if (predictedResolved) {
        predictedPositives += 1;
      }
      if (scenario.expectedResolved && predictedResolved) {
        truePositives += 1;
      }
      const predictedStrategy = result?.strategy ?? "unresolved";
      if (predictedStrategy === scenario.expectedStrategy) {
        strategyMatches += 1;
      }
    }

    const precision =
      predictedPositives > 0 ? truePositives / predictedPositives : 0;
    const recall = expectedPositives > 0 ? truePositives / expectedPositives : 0;
    const f1 = computeF1(precision, recall);

    scores.push({
      language,
      cases: scenarios.length,
      precision,
      recall,
      f1,
      strategyAccuracy:
        scenarios.length > 0 ? strategyMatches / scenarios.length : 0,
    });
  }

  return scores.sort((a, b) => a.language.localeCompare(b.language));
}
