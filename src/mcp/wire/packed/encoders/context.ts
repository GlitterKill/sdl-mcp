/**
 * `ctx1` context encoder for sdl.context responses.
 */

import { encodeSchemaDriven } from "../schema.js";
import type { TableSpec } from "../types.js";

interface ContextCard {
  symbolId?: string;
  id?: string;
  file?: string;
  kind?: string;
  name?: string;
  summary?: string;
}

interface ContextRung {
  rung?: string;
  rungName?: string;
  rationale?: string;
}

interface ContextAction {
  id?: string;
  type?: string;
  status?: string;
  durationMs?: number;
  error?: string;
}

interface ContextEvidenceItem {
  type?: string;
  reference?: string;
  summary?: string;
}

interface ContextInput {
  taskType?: string;
  windowBytes?: number;
  cards?: ContextCard[];
  rungs?: ContextRung[];
  actions?: ContextAction[];
  evidence?: ContextEvidenceItem[];
  summary?: string;
  success?: boolean;
  nextBestActionTool?: string;
  nextBestActionRationale?: string;
}

const CARDS_SPEC: TableSpec = {
  tag: "c",
  key: "cards",
  columns: [
    { name: "id", type: "str" },
    { name: "f", type: "str", intern: true },
    { name: "k", type: "str" },
    { name: "n", type: "str" },
    { name: "sum", type: "str" },
  ],
};

const RUNGS_SPEC: TableSpec = {
  tag: "r",
  key: "rungs",
  columns: [
    { name: "rungName", type: "str" },
    { name: "rationale", type: "str" },
  ],
};

const ACTIONS_SPEC: TableSpec = {
  tag: "a",
  key: "actions",
  columns: [
    { name: "id", type: "str" },
    { name: "type", type: "str", intern: true },
    { name: "status", type: "str", intern: true },
    { name: "durationMs", type: "int" },
    { name: "error", type: "str" },
  ],
};

const EVIDENCE_SPEC: TableSpec = {
  tag: "e",
  key: "evidence",
  columns: [
    { name: "type", type: "str", intern: true },
    { name: "reference", type: "str" },
    { name: "summary", type: "str" },
  ],
};

export function encodePackedContext(input: ContextInput): string {
  const cardRows = (input.cards ?? []).map((card) => ({
    id: card.symbolId ?? card.id ?? "",
    f: card.file ?? "",
    k: card.kind ?? "",
    n: card.name ?? "",
    sum: card.summary ?? "",
  }));
  const rungRows = (input.rungs ?? []).map((r) => ({
    rungName: r.rungName ?? r.rung ?? "",
    rationale: r.rationale ?? "",
  }));
  const actionRows = (input.actions ?? []).map((a) => ({
    id: a.id ?? "",
    type: a.type ?? "",
    status: a.status ?? "",
    durationMs: a.durationMs ?? 0,
    error: a.error ?? "",
  }));
  const evidenceRows = (input.evidence ?? []).map((e) => ({
    type: e.type ?? "",
    reference: e.reference ?? "",
    summary: e.summary ?? "",
  }));
  return encodeSchemaDriven({
    toolName: "context",
    encoderId: "ctx1",
    scalars: {
      taskType: input.taskType ?? "",
      windowBytes: input.windowBytes ?? 0,
      summary: input.summary ?? "",
      success: input.success === true ? 1 : 0,
      nbaTool: input.nextBestActionTool ?? "",
      nbaRationale: input.nextBestActionRationale ?? "",
    },
    scalarTypes: {
      taskType: "str",
      windowBytes: "int",
      summary: "str",
      success: "int",
      nbaTool: "str",
      nbaRationale: "str",
    },
    tables: [
      { spec: CARDS_SPEC, rows: cardRows },
      { spec: RUNGS_SPEC, rows: rungRows },
      { spec: ACTIONS_SPEC, rows: actionRows },
      { spec: EVIDENCE_SPEC, rows: evidenceRows },
    ],
    legendCandidates: (input.cards ?? [])
      .map((c) => c.file ?? "")
      .filter((f) => f.length > 0),
  });
}

export const CONTEXT_ENCODER_ID = "ctx1";
