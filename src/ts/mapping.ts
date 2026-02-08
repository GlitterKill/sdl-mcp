import type { RepoId } from "../db/schema.js";
import type { RepoConfig } from "../config/types.js";
import type { Diagnostic, DiagnosticSummary } from "./diagnostics.js";
import { diagnosticsManager } from "./diagnostics.js";
import {
  getFileByRepoPath,
  findSymbolsInRangeLite,
  getRepo,
} from "../db/queries.js";
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

export function mapDiagnosticsToSymbols(
  options: DiagnosticMappingOptions,
): DiagnosticSuspect[] {
  const { repoId, diagnostics, maxSuspects = 50 } = options;

  const repo = getRepo(repoId);
  if (!repo) {
    throw new Error(`Repository not found: ${repoId}`);
  }

  const suspects: DiagnosticSuspect[] = [];

  for (const diagnostic of diagnostics) {
    if (suspects.length >= maxSuspects) break;

    const relativePath = normalizePath(
      getRelativePath(repo.root_path, diagnostic.filePath),
    );
    const fileRecord = getFileByRepoPath(repoId, relativePath);

    if (!fileRecord) {
      continue;
    }

    const symbols = findSymbolsInRangeLite(
      repoId,
      fileRecord.file_id,
      diagnostic.startLine,
      diagnostic.endLine,
    );

    if (symbols.length === 0) {
      continue;
    }

    const symbol = symbols[0];
    const messageShort = truncateMessage(diagnostic.message, 100);

    suspects.push({
      symbolId: symbol.symbol_id,
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
  const repo = getRepo(repoId);
  if (!repo) {
    throw new Error(`Repository not found: ${repoId}`);
  }

  const repoConfig: RepoConfig = JSON.parse(repo.config_json);

  const { diagnostics, summary } = await diagnosticsManager.getDiagnostics(
    repoConfig,
    {
      maxErrors: 50,
      scope:
        changedFiles && changedFiles.length > 0 ? "changedFiles" : "workspace",
      changedFiles,
    },
  );

  const suspects = mapDiagnosticsToSymbols({
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
