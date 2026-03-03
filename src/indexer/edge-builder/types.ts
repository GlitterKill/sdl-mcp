import type { SymbolKind } from "../../db/schema.js";

import type { ResolvedCall } from "../ts/tsParser.js";

export type SymbolIndex = Map<string, Map<string, Map<SymbolKind, string[]>>>;

export interface PendingCallEdge {
  fromSymbolId: string;
  toFile: string;
  toName: string;
  toKind: SymbolKind;
  confidence?: number;
  strategy?: "exact" | "heuristic" | "unresolved";
  provenance: string;
  callerLanguage: string; // ML-D.1: Track caller's language for cross-language detection
}

export interface TsCallResolver {
  getResolvedCalls: (relPath: string) => ResolvedCall[];
}

