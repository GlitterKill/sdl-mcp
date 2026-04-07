import type { RepoId, DiagnosticSuspect } from "../domain/types.js";
import { RepoConfigSchema } from "../config/types.js";
import type { Diagnostic, DiagnosticSummary } from "./diagnostics.js";
import { diagnosticsManager } from "./diagnostics.js";
import { NotFoundError } from "../domain/errors.js";
import { getLadybugConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { normalizePath, getRelativePath } from "../util/paths.js";
import { logger } from "../util/logger.js";

export type { DiagnosticSuspect };

export interface DiagnosticMappingOptions {
  repoId: RepoId;
  diagnostics: Diagnostic[];
  maxSuspects?: number;
}

export async function mapDiagnosticsToSymbols(
  options: DiagnosticMappingOptions,
): Promise<DiagnosticSuspect[]> {
  const { repoId, diagnostics, maxSuspects = 50 } = options;

  const conn = await getLadybugConn();
  const repo = await ladybugDb.getRepo(conn, repoId);
  if (!repo) {
    throw new NotFoundError(`Repository not found: ${repoId}`);
  }

  const suspects: DiagnosticSuspect[] = [];

  for (const diagnostic of diagnostics) {
    if (suspects.length >= maxSuspects) break;

    const relativePath = normalizePath(
      getRelativePath(repo.rootPath, diagnostic.filePath),
    );
    const fileRecord = await ladybugDb.getFileByRepoPath(
      conn,
      repoId,
      relativePath,
    );

    if (!fileRecord) {
      continue;
    }

    const symbols = await ladybugDb.findSymbolsInRange(
      conn,
      repoId,
      fileRecord.fileId,
      diagnostic.startLine,
      diagnostic.endLine,
    );

    if (symbols.length === 0) {
      continue;
    }

    const symbol = chooseMostSpecificSymbol(symbols);
    const messageShort = truncateMessage(diagnostic.message, 100);

    suspects.push({
      symbolId: symbol.symbolId,
      file: relativePath,
      range: {
        startLine: diagnostic.startLine,
        startCol: diagnostic.startCol,
        endLine: diagnostic.endLine,
        endCol: diagnostic.endCol,
      },
      code: diagnostic.code,
      messageShort,
    });
  }

  return suspects;
}

export interface DiagnosticsWithSuspects {
  diagnostics: Diagnostic[];
  summary: DiagnosticSummary;
  suspects: DiagnosticSuspect[];
}

export async function getDiagnosticsWithSuspects(
  repoId: RepoId,
  changedFiles?: string[],
): Promise<DiagnosticsWithSuspects> {
  const conn = await getLadybugConn();
  const repo = await ladybugDb.getRepo(conn, repoId);
  if (!repo) {
    throw new NotFoundError(`Repository not found: ${repoId}`);
  }

  let parsedConfigJson: unknown;
  try {
    parsedConfigJson = JSON.parse(repo.configJson);
  } catch {
    logger.error("Corrupt configJson for repo", { repoId });
    throw new Error(`Corrupt configJson for repo ${repoId}`);
  }
  const repoConfig = RepoConfigSchema.parse(parsedConfigJson);

  const { diagnostics, summary } = await diagnosticsManager.getDiagnostics(
    repoConfig,
    {
      maxErrors: 50,
      scope:
        changedFiles && changedFiles.length > 0 ? "changedFiles" : "workspace",
      changedFiles,
    },
  );

  const suspects = await mapDiagnosticsToSymbols({
    repoId,
    diagnostics,
    maxSuspects: 50,
  });

  return {
    diagnostics,
    summary,
    suspects,
  };
}

function truncateMessage(message: string, maxLength: number): string {
  if (message.length <= maxLength) {
    return message;
  }
  return message.substring(0, maxLength - 3) + "...";
}

function chooseMostSpecificSymbol<T extends {
  rangeStartLine: number;
  rangeStartCol: number;
  rangeEndLine: number;
  rangeEndCol: number;
}>(symbols: T[]): T {
  return [...symbols].sort((a, b) => {
    const aLineSpan = a.rangeEndLine - a.rangeStartLine;
    const bLineSpan = b.rangeEndLine - b.rangeStartLine;
    if (aLineSpan !== bLineSpan) {
      return aLineSpan - bLineSpan;
    }

    const aColSpan = a.rangeEndCol - a.rangeStartCol;
    const bColSpan = b.rangeEndCol - b.rangeStartCol;
    if (aColSpan !== bColSpan) {
      return aColSpan - bColSpan;
    }

    if (a.rangeStartLine !== b.rangeStartLine) {
      return b.rangeStartLine - a.rangeStartLine;
    }

    return b.rangeStartCol - a.rangeStartCol;
  })[0];
}
