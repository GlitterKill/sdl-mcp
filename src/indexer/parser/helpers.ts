import type { Connection } from "kuzu";

import { withWriteConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import type { EdgeRow, SymbolReferenceRow } from "../../db/ladybug-queries.js";
import {
  findEnclosingSymbolByRange,
  resolveSymbolIdFromIndex,
} from "../edge-builder.js";
import type {
  PendingCallEdge,
  SymbolIndex,
  TsCallResolver,
} from "../edge-builder.js";
import type { ProcessFileResult } from "./types.js";
import type { SymbolMapFileUpdate } from "../symbol-map-cache.js";

interface PersistSkippedFileParams {
  conn: Connection;
  existingFileId?: string;
  fileId: string;
  repoId: string;
  relPath: string;
  contentHash: string;
  language: string;
  byteSize: number;
}

export function isTestFile(relPath: string, languages: string[]): boolean {
  const ext = relPath.split(".").pop() || "";
  if (!languages.includes(ext)) return false;

  const fileName = relPath.split("/").pop() || relPath.split("\\").pop() || "";
  const hasTestSuffix =
    fileName.includes(".test.") || fileName.includes(".spec.");
  const isInTestDir =
    relPath.includes("/tests/") ||
    relPath.includes("\\tests\\") ||
    relPath.includes("/__tests__/") ||
    relPath.includes("\\__tests__\\");

  return hasTestSuffix || isInTestDir;
}

export function extractSymbolReferences(
  content: string,
  repoId: string,
  fileId: string,
  conn?: Connection,
): Promise<void> {
  const references = buildSymbolReferences(content, repoId, fileId);
  if (references.length === 0) return Promise.resolve();

  return (async () => {
    if (conn) {
      await ladybugDb.insertSymbolReferences(conn, references);
    } else {
      await withWriteConn(async (wConn) => {
        await ladybugDb.insertSymbolReferences(wConn, references);
      });
    }
  })();
}

export function buildSymbolReferences(
  content: string,
  repoId: string,
  fileId: string,
): SymbolReferenceRow[] {
  const tokens = content.match(/[A-Za-z_][A-Za-z0-9_]*/g);
  if (!tokens) return [];

  const uniqueTokens = new Set(tokens);
  const createdAt = new Date().toISOString();

  return Array.from(uniqueTokens, (token) => ({
    refId: `ref_${repoId}_${fileId}_${token}`,
    repoId,
    symbolName: token,
    fileId,
    lineNumber: 0,
    createdAt,
  }));
}

export async function persistSkippedFile({
  conn,
  existingFileId,
  fileId,
  repoId,
  relPath,
  contentHash,
  language,
  byteSize,
}: PersistSkippedFileParams): Promise<void> {
  await ladybugDb.withTransaction(conn, async (txConn) => {
    if (existingFileId) {
      await ladybugDb.deleteSymbolsByFileId(txConn, existingFileId);
    }
    await ladybugDb.upsertFile(txConn, {
      fileId,
      repoId,
      relPath,
      contentHash,
      language,
      byteSize,
      lastIndexedAt: new Date().toISOString(),
    });
  });
}

export function createEmptyProcessFileResult(
  changed: boolean,
  symbolMapFileUpdate?: SymbolMapFileUpdate,
): ProcessFileResult {
  return {
    symbolsIndexed: 0,
    edgesCreated: 0,
    changed,
    configEdges: [],
    pass2HintPaths: [],
    symbolMapFileUpdate,
  };
}

export interface ResolveTsCallEdgesParams {
  tsResolver: TsCallResolver;
  filePath: string;
  symbolDetails: Array<{
    extractedSymbol: {
      nodeId: string;
      kind: string;
      range: {
        startLine: number;
        startCol: number;
        endLine: number;
        endCol: number;
      };
    };
  }>;
  nodeIdToSymbolId: Map<string, string>;
  symbolIndex: SymbolIndex;
  repoId: string;
  languageId: string;
  createdCallEdges: Set<string>;
  pendingCallEdges: PendingCallEdge[];
  edgesToInsert: EdgeRow[];
}

/**
 * Resolve TypeScript-specific call edges using the TS compiler API resolver.
 * Creates resolved edges or defers unresolved ones to pendingCallEdges.
 * Mutates createdCallEdges, pendingCallEdges, and edgesToInsert in place.
 * Returns the number of edges created.
 */
export async function resolveTsCallEdges(
  params: ResolveTsCallEdgesParams,
): Promise<number> {
  const {
    tsResolver,
    filePath,
    symbolDetails,
    nodeIdToSymbolId,
    symbolIndex,
    repoId,
    languageId,
    createdCallEdges,
    pendingCallEdges,
    edgesToInsert,
  } = params;

  let edgesCreated = 0;
  const tsCalls = tsResolver.getResolvedCalls(filePath);

  for (const tsCall of tsCalls) {
    const callerNodeId = findEnclosingSymbolByRange(
      tsCall.caller,
      symbolDetails,
    );
    if (!callerNodeId) continue;

    const fromSymbolId = nodeIdToSymbolId.get(callerNodeId);
    if (!fromSymbolId) continue;

    const toSymbolId = await resolveSymbolIdFromIndex(
      symbolIndex,
      repoId,
      tsCall.callee.filePath,
      tsCall.callee.name,
      tsCall.callee.kind,
      languageId,
    );

    if (toSymbolId) {
      const edgeKey = `${fromSymbolId}->${toSymbolId}`;
      if (createdCallEdges.has(edgeKey)) continue;

      edgesToInsert.push({
        repoId,
        fromSymbolId,
        toSymbolId,
        edgeType: "call",
        weight: 1.0,
        confidence: tsCall.confidence ?? 1.0,
        resolution: "exact",
        resolverId: "pass1-generic",
        resolutionPhase: "pass1",
        provenance: `ts-call:${tsCall.callee.name}`,
        createdAt: new Date().toISOString(),
      });
      createdCallEdges.add(edgeKey);
      edgesCreated++;
    } else {
      pendingCallEdges.push({
        fromSymbolId,
        toFile: tsCall.callee.filePath,
        toName: tsCall.callee.name,
        toKind: tsCall.callee.kind,
        confidence: tsCall.confidence ?? 1.0,
        strategy: "exact",
        provenance: `ts-call:${tsCall.callee.name}`,
        callerLanguage: languageId,
      });
    }
  }

  return edgesCreated;
}
