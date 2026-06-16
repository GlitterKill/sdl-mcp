#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface LanguageProviderSupportRow {
  language: string;
  popularityRankSource: string;
  adapterStatus: string;
  parserInstallMode: string;
  scipStatus: string;
  lspIoServer: string;
  providerFirstStatus: string;
  validationRepo: string;
  validationEvidence: string;
  notes: string;
}

const REQUIRED_FIELDS: Array<keyof LanguageProviderSupportRow> = [
  "language",
  "popularityRankSource",
  "adapterStatus",
  "parserInstallMode",
  "scipStatus",
  "lspIoServer",
  "providerFirstStatus",
  "validationRepo",
  "validationEvidence",
  "notes",
];

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");
const DATA_PATH = resolve(ROOT, "docs", "generated", "language-provider-support.json");
const DOC_PATH = resolve(ROOT, "docs", "feature-deep-dives", "language-provider-support.md");
const START = "<!-- language-support-chart:start -->";
const END = "<!-- language-support-chart:end -->";

function loadRows(): LanguageProviderSupportRow[] {
  const rows = JSON.parse(readFileSync(DATA_PATH, "utf8")) as unknown;
  if (!Array.isArray(rows)) {
    throw new Error(`${DATA_PATH} must contain an array`);
  }
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== "object") {
      throw new Error(`language support row ${index} must be an object`);
    }
    for (const field of REQUIRED_FIELDS) {
      const value = (row as Record<string, unknown>)[field];
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`language support row ${index} missing ${field}`);
      }
    }
  }
  return rows as LanguageProviderSupportRow[];
}

function cell(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ").trim();
}

function renderChart(rows: readonly LanguageProviderSupportRow[]): string {
  const header = [
    "Language",
    "Popularity rank/source",
    "SDL adapter status",
    "Parser install mode",
    "SCIP status",
    "LSP-IO server",
    "Provider-first status",
    "Validation repo",
    "Validation evidence",
    "Notes",
  ];
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
  ];
  for (const row of rows) {
    lines.push(
      `| ${[
        row.language,
        row.popularityRankSource,
        row.adapterStatus,
        row.parserInstallMode,
        row.scipStatus,
        row.lspIoServer,
        row.providerFirstStatus,
        row.validationRepo,
        row.validationEvidence,
        row.notes,
      ].map(cell).join(" | ")} |`,
    );
  }
  return lines.join("\n");
}

function main(): void {
  const rows = loadRows();
  const expected = renderChart(rows);
  const doc = readFileSync(DOC_PATH, "utf8");
  const startIndex = doc.indexOf(START);
  const endIndex = doc.indexOf(END);
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    throw new Error(`${DOC_PATH} must contain ${START} and ${END} markers`);
  }
  const actual = doc.slice(startIndex + START.length, endIndex).trim();
  if (actual !== expected) {
    console.error("Language provider support chart is stale.");
    console.error(`Update ${DOC_PATH} from ${DATA_PATH}.`);
    process.exit(1);
  }
}

main();
