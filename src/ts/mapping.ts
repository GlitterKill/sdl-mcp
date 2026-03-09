import type { RepoId } from "../db/schema.js";
import { RepoConfigSchema } from "../config/types.js";
import type { Diagnostic, DiagnosticSummary } from "./diagnostics.js";
import { diagnosticsManager } from "./diagnostics.js";
import { getKuzuConn } from "../db/kuzu.js";
import * as kuzuDb from "../db/kuzu-queries.js";
import { normalizePath, getRelativePath } from "../util/paths.js";

export interface DiagnosticSuspect {
  symbolId: string;
  file: string;
  range: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  };
  code: string | number;
  messageShort: string;
}

export interface DiagnosticMappingOptions {
  repoId: RepoId;
  diagnostics: Diagnostic[];
  maxSuspects?: number;
}

export async function mapDiagnosticsToSymbols(
  options: DiagnosticMappingOptions,
): Promise<DiagnosticSuspect[]> {
  const { repoId, diagnostics, maxSuspects = 50 } = options;

  const conn = await getKuzuConn();
  const repo = await kuzuDb.getRepo(conn, repoId);
  if (!repo) {
    throw new Error(`Repository not found: ${repoId}`);
  }

  const suspects: DiagnosticSuspect[] = [];

  for (const diagnostic of diagnostics) {
    if (suspects.length >= maxSuspects) break;

    const relativePath = normalizePath(
      getRelativePath(repo.rootPath, diagnostic.filePath),
    );
    const fileRecord = await kuzuDb.getFileByRepoPath(
      conn,
      repoId,
      relativePath,
    );

    if (!fileRecord) {
      continue;
    }

    const symbols = await kuzuDb.findSymbolsInRange(
      conn,
      repoId,
      fileRecord.fileId,
      diagnostic.startLine,
      diagnostic.endLine,
    );

    if (symbols.length === 0) {
      continue;
    }

    const symbol = symbols[0];
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
  const conn = await getKuzuConn();
  const repo = await kuzuDb.getRepo(conn, repoId);
  if (!repo) {
    throw new Error(`Repository not found: ${repoId}`);
  }

  const repoConfig = RepoConfigSchema.parse(JSON.parse(repo.configJson));

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
