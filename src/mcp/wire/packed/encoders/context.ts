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

interface ContextInput {
  taskType?: string;
  windowBytes?: number;
  cards?: ContextCard[];
  rungs?: ContextRung[];
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
  return encodeSchemaDriven({
    toolName: "context",
    encoderId: "ctx1",
    scalars: {
      taskType: input.taskType ?? "",
      windowBytes: input.windowBytes ?? 0,
    },
    scalarTypes: { taskType: "str", windowBytes: "int" },
    tables: [
      { spec: CARDS_SPEC, rows: cardRows },
      { spec: RUNGS_SPEC, rows: rungRows },
    ],
    legendCandidates: (input.cards ?? [])
      .map((c) => c.file ?? "")
      .filter((f) => f.length > 0),
  });
}

export const CONTEXT_ENCODER_ID = "ctx1";
