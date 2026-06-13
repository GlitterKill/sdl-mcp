#!/usr/bin/env node
/**
 * Verifies provider-first graph accuracy gates against a completed LadybugDB.
 *
 * Usage:
 *   npm run check:provider-first-graph -- --db path/to/sdl-mcp-graph.lbug --repo-root path/to/repo
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Args {
  db: string;
  repoRoot: string;
  repoId?: string;
  outDir: string;
}

interface GateFailure {
  gate: string;
  message: string;
  sample?: Record<string, unknown>;
}

interface GateResult {
  name: string;
  passed: boolean;
  checked: number;
  failures: GateFailure[];
}

interface FileRow {
  repoId: string;
  fileId: string;
  relPath: string;
  contentHash: string | null;
  byteSize: unknown;
}

interface SymbolRow {
  symbolId: string;
  symbolRepoId: string | null;
  repoId: string | null;
  fileId: string | null;
  relPath: string | null;
  external: unknown;
  symbolStatus: string | null;
  rangeStartLine: unknown;
  rangeStartCol: unknown;
  rangeEndLine: unknown;
  rangeEndCol: unknown;
}

interface EdgeRow {
  fromSymbolId: string;
  toSymbolId: string;
  edgeType: string;
  confidence: unknown;
  resolution: string | null;
  resolverId: string | null;
  provenance: string | null;
}

interface Report {
  generatedAt: string;
  dbPath: string;
  repoRoot: string;
  repoId?: string;
  passed: boolean;
  gates: GateResult[];
}

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");
const DEFAULT_OUT_DIR = resolve(ROOT, ".tmp", "provider-first-graph-checks");
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

function parseArgs(argv: string[]): Args {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    args.set(rawKey, inlineValue ?? argv[++i] ?? "");
  }
  const db = args.get("db");
  const repoRoot = args.get("repo-root");
  if (!db || !repoRoot) {
    throw new Error(
      "Usage: npm run check:provider-first-graph -- --db <path> --repo-root <path> [--repo-id <id>] [--out-dir <path>]",
    );
  }
  return {
    db: resolve(db),
    repoRoot: resolve(repoRoot),
    repoId: args.get("repo-id"),
    outDir: resolve(args.get("out-dir") ?? DEFAULT_OUT_DIR),
  };
}

async function queryAll<T>(
  conn: import("kuzu").Connection,
  statement: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  const prepared = await conn.prepare(statement);
  const result = await conn.execute(prepared, params);
  try {
    return (await result.getAll()) as T[];
  } finally {
    result.close();
  }
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value === null || value === undefined) return 0;
  return Number(value);
}

function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "bigint") return value !== 0n;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return false;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function fileHash(path: string): { contentHash: string; byteSize: number } {
  const content = readFileSync(path);
  return {
    contentHash: createHash("sha256").update(content).digest("hex"),
    byteSize: content.byteLength,
  };
}

function fileLineInfo(path: string): string[] {
  return readFileSync(path, "utf8").split(/\r?\n/);
}

function gate(
  name: string,
  checked: number,
  failures: GateFailure[],
): GateResult {
  return {
    name,
    checked,
    failures,
    passed: failures.length === 0,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.outDir, { recursive: true });

  const kuzu = await import("kuzu");
  const db = new kuzu.Database(args.db);
  const conn = new kuzu.Connection(db);
  try {
    const files = await queryAll<FileRow>(
      conn,
      `MATCH (f:File)-[:FILE_IN_REPO]->(r:Repo)
       RETURN r.repoId AS repoId,
              f.fileId AS fileId,
              f.relPath AS relPath,
              f.contentHash AS contentHash,
              f.byteSize AS byteSize`,
    );
    const scopedFiles = files.filter(
      (file) => !args.repoId || file.repoId === args.repoId,
    );
    const fileById = new Map(scopedFiles.map((file) => [file.fileId, file]));

    const symbols = await queryAll<SymbolRow>(
      conn,
      `MATCH (s:Symbol)
       OPTIONAL MATCH (s)-[:SYMBOL_IN_FILE]->(f:File)
       OPTIONAL MATCH (s)-[:SYMBOL_IN_REPO]->(r:Repo)
       RETURN s.symbolId AS symbolId,
              s.repoId AS symbolRepoId,
              r.repoId AS repoId,
              f.fileId AS fileId,
              f.relPath AS relPath,
              s.external AS external,
              s.symbolStatus AS symbolStatus,
              s.rangeStartLine AS rangeStartLine,
              s.rangeStartCol AS rangeStartCol,
              s.rangeEndLine AS rangeEndLine,
              s.rangeEndCol AS rangeEndCol`,
    );
    const scopedSymbols = symbols.filter(
      (symbol) => !args.repoId || symbol.symbolRepoId === args.repoId,
    );
    const symbolIds = new Set(scopedSymbols.map((symbol) => symbol.symbolId));
    const localRealSymbols = scopedSymbols.filter(
      (symbol) =>
        !toBoolean(symbol.external) &&
        (symbol.symbolStatus === null ||
          symbol.symbolStatus === "real" ||
          symbol.symbolStatus === ""),
    );

    const metrics = await queryAll<{ symbolId: string }>(
      conn,
      `MATCH (m:Metrics) RETURN m.symbolId AS symbolId`,
    );
    const metricSymbolIds = new Set(metrics.map((row) => row.symbolId));

    const edges = await queryAll<EdgeRow>(
      conn,
      `MATCH (from:Symbol)-[d:DEPENDS_ON]->(to:Symbol)
       RETURN from.symbolId AS fromSymbolId,
              to.symbolId AS toSymbolId,
              d.edgeType AS edgeType,
              d.confidence AS confidence,
              d.resolution AS resolution,
              d.resolverId AS resolverId,
              d.provenance AS provenance`,
    );
    const scopedEdges = edges.filter(
      (edge) =>
        symbolIds.has(edge.fromSymbolId) || symbolIds.has(edge.toSymbolId),
    );

    const providerRuns = await queryAll<{ runId: string; repoId: string }>(
      conn,
      `MATCH (r:SemanticProviderRun)
       RETURN r.runId AS runId, r.repoId AS repoId`,
    );
    const scopedProviderRuns = providerRuns.filter(
      (run) => !args.repoId || run.repoId === args.repoId,
    );
    const semanticDiagnostics = await queryAll<{ id: string; repoId: string }>(
      conn,
      `MATCH (d:SemanticDiagnostic)
       RETURN d.id AS id, d.repoId AS repoId`,
    );
    const scopedDiagnostics = semanticDiagnostics.filter(
      (diagnostic) => !args.repoId || diagnostic.repoId === args.repoId,
    );

    const gates: GateResult[] = [];
    gates.push(checkSourceFidelity(args.repoRoot, scopedFiles));
    gates.push(
      checkLocalSymbolUsability(localRealSymbols, fileById, metricSymbolIds),
    );
    gates.push(checkSourceRanges(args.repoRoot, localRealSymbols));
    gates.push(checkEdges(scopedEdges, symbolIds));
    gates.push(
      checkProvenance(scopedProviderRuns.length, scopedDiagnostics.length),
    );

    const report: Report = {
      generatedAt: new Date().toISOString(),
      dbPath: args.db,
      repoRoot: args.repoRoot,
      repoId: args.repoId,
      passed: gates.every((item) => item.passed),
      gates,
    };
    writeReport(args.outDir, report);
    const summary = `${report.passed ? "PASS" : "FAIL"} provider-first graph check: ${gates.filter((item) => !item.passed).length}/${gates.length} gate(s) failed`;
    console.log(summary);
    if (!report.passed) {
      for (const failedGate of gates.filter((item) => !item.passed)) {
        console.error(
          `${failedGate.name}: ${failedGate.failures.length} failure(s); first=${failedGate.failures[0]?.message ?? "unknown"}`,
        );
      }
      process.exitCode = 1;
    }
  } finally {
    await conn.close().catch(() => undefined);
    await db.close().catch(() => undefined);
  }
}

function checkSourceFidelity(
  repoRoot: string,
  files: readonly FileRow[],
): GateResult {
  const failures: GateFailure[] = [];
  for (const file of files) {
    const relPath = normalizePath(file.relPath);
    const sourcePath = resolve(repoRoot, relPath);
    if (!existsSync(sourcePath)) {
      failures.push({
        gate: "source-fidelity",
        message: `File row points to missing source file: ${relPath}`,
        sample: { fileId: file.fileId, relPath },
      });
      continue;
    }
    if (!file.contentHash || !SHA256_HEX_PATTERN.test(file.contentHash)) {
      failures.push({
        gate: "source-fidelity",
        message: `File row has invalid SHA-256 contentHash: ${relPath}`,
        sample: { fileId: file.fileId, contentHash: file.contentHash },
      });
      continue;
    }
    const disk = fileHash(sourcePath);
    const dbByteSize = toNumber(file.byteSize);
    if (file.contentHash !== disk.contentHash || dbByteSize !== disk.byteSize) {
      failures.push({
        gate: "source-fidelity",
        message: `File row does not match source bytes: ${relPath}`,
        sample: {
          fileId: file.fileId,
          dbHash: file.contentHash,
          diskHash: disk.contentHash,
          dbByteSize,
          diskByteSize: disk.byteSize,
        },
      });
    }
  }
  return gate("source-fidelity", files.length, failures);
}

function checkLocalSymbolUsability(
  symbols: readonly SymbolRow[],
  fileById: ReadonlyMap<string, FileRow>,
  metricSymbolIds: ReadonlySet<string>,
): GateResult {
  const failures: GateFailure[] = [];
  for (const symbol of symbols) {
    if (!symbol.repoId) {
      failures.push({
        gate: "local-symbol-usability",
        message: `Local symbol is missing SYMBOL_IN_REPO: ${symbol.symbolId}`,
      });
    }
    if (!symbol.fileId || !fileById.has(symbol.fileId)) {
      failures.push({
        gate: "local-symbol-usability",
        message: `Local symbol is missing SYMBOL_IN_FILE: ${symbol.symbolId}`,
        sample: { fileId: symbol.fileId },
      });
    }
    if (!metricSymbolIds.has(symbol.symbolId)) {
      failures.push({
        gate: "local-symbol-usability",
        message: `Local symbol is missing Metrics row: ${symbol.symbolId}`,
      });
    }
  }
  return gate("local-symbol-usability", symbols.length, failures);
}

function checkSourceRanges(
  repoRoot: string,
  symbols: readonly SymbolRow[],
): GateResult {
  const failures: GateFailure[] = [];
  const linesByPath = new Map<string, string[]>();
  for (const symbol of symbols) {
    const relPath = symbol.relPath ? normalizePath(symbol.relPath) : null;
    if (!relPath) continue;
    const startLine = toNumber(symbol.rangeStartLine);
    const startCol = toNumber(symbol.rangeStartCol);
    const endLine = toNumber(symbol.rangeEndLine);
    const endCol = toNumber(symbol.rangeEndCol);
    if (
      startLine < 1 ||
      startCol < 0 ||
      endLine < startLine ||
      (endLine === startLine && endCol < startCol)
    ) {
      failures.push({
        gate: "source-ranges",
        message: `Symbol has non-sensical range: ${symbol.symbolId}`,
        sample: { relPath, startLine, startCol, endLine, endCol },
      });
      continue;
    }
    let lines = linesByPath.get(relPath);
    if (!lines) {
      const sourcePath = resolve(repoRoot, relPath);
      if (!existsSync(sourcePath)) continue;
      lines = fileLineInfo(sourcePath);
      linesByPath.set(relPath, lines);
    }
    const startText = lines[startLine - 1];
    const endText = lines[endLine - 1];
    if (
      startText === undefined ||
      endText === undefined ||
      startCol > startText.length ||
      endCol > endText.length
    ) {
      failures.push({
        gate: "source-ranges",
        message: `Symbol range is out of source bounds: ${symbol.symbolId}`,
        sample: {
          relPath,
          startLine,
          startCol,
          endLine,
          endCol,
          lineCount: lines.length,
        },
      });
    }
  }
  return gate("source-ranges", symbols.length, failures);
}

function checkEdges(
  edges: readonly EdgeRow[],
  symbolIds: ReadonlySet<string>,
): GateResult {
  const failures: GateFailure[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    if (!symbolIds.has(edge.fromSymbolId) || !symbolIds.has(edge.toSymbolId)) {
      failures.push({
        gate: "edge-quality",
        message: `Edge has endpoint outside scoped symbol set: ${edge.fromSymbolId} -> ${edge.toSymbolId}`,
        sample: { edgeType: edge.edgeType, resolverId: edge.resolverId },
      });
    }
    const key = [
      edge.fromSymbolId,
      edge.toSymbolId,
      edge.edgeType,
      edge.resolverId ?? "",
    ].join("\u0000");
    if (seen.has(key)) {
      failures.push({
        gate: "edge-quality",
        message: `Duplicate DEPENDS_ON relationship: ${edge.fromSymbolId} -> ${edge.toSymbolId}`,
        sample: { edgeType: edge.edgeType, resolverId: edge.resolverId },
      });
    }
    seen.add(key);
    if (
      edge.edgeType === "call" &&
      edge.resolverId?.startsWith("provider-first:")
    ) {
      if (edge.resolution !== "exact" || toNumber(edge.confidence) <= 0) {
        failures.push({
          gate: "edge-quality",
          message: `Provider-first call edge is not exact source-proofed: ${edge.fromSymbolId} -> ${edge.toSymbolId}`,
        });
      }
      try {
        const provenance = edge.provenance
          ? (JSON.parse(edge.provenance) as { dedupeKey?: unknown })
          : {};
        if (
          typeof provenance.dedupeKey !== "string" ||
          provenance.dedupeKey.length === 0
        ) {
          failures.push({
            gate: "edge-quality",
            message: `Provider-first call edge lacks dedupeKey provenance: ${edge.fromSymbolId} -> ${edge.toSymbolId}`,
          });
        }
      } catch {
        failures.push({
          gate: "edge-quality",
          message: `Provider-first call edge has invalid provenance JSON: ${edge.fromSymbolId} -> ${edge.toSymbolId}`,
        });
      }
    }
  }
  return gate("edge-quality", edges.length, failures);
}

function checkProvenance(
  providerRuns: number,
  diagnostics: number,
): GateResult {
  const failures: GateFailure[] = [];
  if (providerRuns === 0) {
    failures.push({
      gate: "provenance",
      message: "No SemanticProviderRun rows found for provider-first graph",
    });
  }
  return gate("provenance", providerRuns + diagnostics, failures);
}

function writeReport(outDir: string, report: Report): void {
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const jsonPath = resolve(outDir, `provider-first-graph-check-${stamp}.json`);
  const mdPath = resolve(outDir, `provider-first-graph-check-${stamp}.md`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  writeFileSync(mdPath, reportMarkdown(report), "utf8");
}

function reportMarkdown(report: Report): string {
  const lines = [
    "# Provider-First Graph Check",
    "",
    `Status: ${report.passed ? "PASS" : "FAIL"}`,
    `Database: ${report.dbPath}`,
    `Repo root: ${report.repoRoot}`,
    report.repoId ? `Repo id: ${report.repoId}` : undefined,
    `Generated: ${report.generatedAt}`,
    "",
    "| Gate | Status | Checked | Failures |",
    "| --- | --- | ---: | ---: |",
    ...report.gates.map(
      (gateResult) =>
        `| ${gateResult.name} | ${gateResult.passed ? "PASS" : "FAIL"} | ${gateResult.checked} | ${gateResult.failures.length} |`,
    ),
    "",
  ].filter((line): line is string => line !== undefined);

  for (const gateResult of report.gates) {
    if (gateResult.failures.length === 0) continue;
    lines.push(`## ${gateResult.name}`, "");
    for (const failure of gateResult.failures.slice(0, 20)) {
      lines.push(`- ${failure.message}`);
    }
    if (gateResult.failures.length > 20) {
      lines.push(
        `- ${gateResult.failures.length - 20} more failure(s) omitted`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
