import type { Connection } from "kuzu";

import { queryAll, toBoolean, toNumber } from "./ladybug-core.js";
import type { SymbolStatus } from "./symbol-placeholders.js";

export interface PersistedGraphIntegritySymbolRow {
  symbolId: string;
  fileId: string;
  relPath: string;
  name: string;
  kind: string;
  language: string;
  rangeStartLine: number;
  rangeStartCol: number;
  rangeEndLine: number;
  rangeEndCol: number;
  signatureJson: string | null;
  source: string | null;
  scipSymbol: string | null;
  astFingerprint: string | null;
  symbolStatus: SymbolStatus | null;
  external: boolean;
  placeholderKind: string | null;
  placeholderTarget: string | null;
}

export interface GraphIntegritySymbolCursor {
  relPath: string;
  fileId: string;
  symbolId: string;
}

interface RawPersistedGraphIntegritySymbolRow extends Omit<
  PersistedGraphIntegritySymbolRow,
  | "rangeStartLine"
  | "rangeStartCol"
  | "rangeEndLine"
  | "rangeEndCol"
  | "external"
> {
  rangeStartLine: unknown;
  rangeStartCol: unknown;
  rangeEndLine: unknown;
  rangeEndCol: unknown;
  external: unknown;
}

/** Read one stable keyset page for the post-index integrity digest. */
export async function getPersistedGraphIntegritySymbolPage(
  conn: Connection,
  params: {
    repoId: string;
    after?: GraphIntegritySymbolCursor;
    limit: number;
  },
): Promise<PersistedGraphIntegritySymbolRow[]> {
  const hasCursor = params.after !== undefined;
  const rows = await queryAll<RawPersistedGraphIntegritySymbolRow>(
    conn,
    `MATCH (s:Symbol)-[:SYMBOL_IN_FILE]->(f:File)
     WHERE s.repoId = $repoId
     ${
       hasCursor
         ? `AND (
              f.relPath > $afterRelPath OR
              (f.relPath = $afterRelPath AND f.fileId > $afterFileId) OR
              (f.relPath = $afterRelPath AND f.fileId = $afterFileId AND s.symbolId > $afterSymbolId)
            )`
         : ""
     }
     RETURN s.symbolId AS symbolId,
            f.fileId AS fileId,
            f.relPath AS relPath,
            s.name AS name,
            s.kind AS kind,
            s.language AS language,
            s.rangeStartLine AS rangeStartLine,
            s.rangeStartCol AS rangeStartCol,
            s.rangeEndLine AS rangeEndLine,
            s.rangeEndCol AS rangeEndCol,
            s.signatureJson AS signatureJson,
            s.source AS source,
            s.scipSymbol AS scipSymbol,
            s.astFingerprint AS astFingerprint,
            s.symbolStatus AS symbolStatus,
            s.external AS external,
            s.placeholderKind AS placeholderKind,
            s.placeholderTarget AS placeholderTarget
     ORDER BY f.relPath ASC, f.fileId ASC, s.symbolId ASC
     LIMIT $limit`,
    {
      repoId: params.repoId,
      afterRelPath: params.after?.relPath ?? "",
      afterFileId: params.after?.fileId ?? "",
      afterSymbolId: params.after?.symbolId ?? "",
      limit: params.limit,
    },
  );
  return rows.map((row) => ({
    ...row,
    rangeStartLine: toNumber(row.rangeStartLine),
    rangeStartCol: toNumber(row.rangeStartCol),
    rangeEndLine: toNumber(row.rangeEndLine),
    rangeEndCol: toNumber(row.rangeEndCol),
    external: toBoolean(row.external),
  }));
}
