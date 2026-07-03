/**
 * Rename planner for `sdl.search.edit` `targeting: "rename"`.
 *
 * Resolves the target symbol, gathers graph-scoped candidate files
 * (declaration file + referencing files), flags name collisions, and
 * optionally reports text-only recall matches without editing them.
 */

import { resolve } from "path";

import type { getLadybugConn } from "../../../db/ladybug.js";
import * as ladybugDb from "../../../db/ladybug-queries.js";
import { normalizePath } from "../../../util/paths.js";
import { ValidationError } from "../../../domain/errors.js";
import { resolveSymbolRef } from "../../../util/resolve-symbol-ref.js";

import {
  DEFAULT_MAX_FILES,
  enumerateRepoFiles,
  readSearchEditCandidateFile,
  type PreviewFileSkip,
  type SearchEditSingleOperationRequest,
} from "./planner.js";

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function wordRegexForIdentifier(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "g");
}

/** Validation for the rename targeting branch (throws ValidationError). */
export function validateRenameRequest(
  request: SearchEditSingleOperationRequest,
): void {
  if (request.editMode !== "replacePattern") {
    throw new ValidationError('rename targeting currently supports editMode="replacePattern" only');
  }
  if (request.query.rename === undefined) {
    throw new ValidationError("rename targeting requires query.rename");
  }
  if (!IDENTIFIER_RE.test(request.query.rename.newName)) {
    throw new ValidationError("rename.newName must be a valid identifier");
  }
  const hasOneSymbolId = request.query.symbolIds?.length === 1;
  const hasSymbolRef = request.query.symbolRef !== undefined;
  if (hasOneSymbolId === hasSymbolRef) {
    throw new ValidationError("rename targeting requires exactly one of query.symbolIds[0] or query.symbolRef");
  }
}

export interface RenamePlan {
  request: SearchEditSingleOperationRequest;
  candidates: string[];
  skipped: PreviewFileSkip[];
  regex: RegExp;
}

export async function prepareRenameRequest(
  conn: Awaited<ReturnType<typeof getLadybugConn>>,
  request: SearchEditSingleOperationRequest,
): Promise<RenamePlan> {
  const rename = request.query.rename;
  if (rename === undefined) {
    throw new ValidationError("rename targeting requires query.rename");
  }

  let targetSymbolId = request.query.symbolIds?.[0];
  if (targetSymbolId === undefined && request.query.symbolRef) {
    const resolved = await resolveSymbolRef(
      conn,
      request.repoId,
      request.query.symbolRef,
    );
    if (resolved.status !== "resolved") {
      throw new ValidationError(`rename symbolRef ${resolved.status}`);
    }
    targetSymbolId = resolved.symbolId;
  }
  if (targetSymbolId === undefined) {
    throw new ValidationError("rename targeting requires query.symbolIds[0] or query.symbolRef");
  }

  const target = (await ladybugDb.getSymbolsByIds(conn, [targetSymbolId])).get(targetSymbolId);
  if (!target || target.repoId !== request.repoId) {
    throw new ValidationError(`rename target symbol not found: ${targetSymbolId}`);
  }

  const candidateSet = new Set<string>();
  const targetFile = (await ladybugDb.getFilesByIds(conn, [target.fileId])).get(target.fileId);
  if (targetFile) candidateSet.add(normalizePath(targetFile.relPath));

  const references = await ladybugDb.getReferencingSymbolsForTarget(
    conn,
    request.repoId,
    targetSymbolId,
    rename.minConfidence ?? 0.5,
  );
  for (const ref of references) candidateSet.add(normalizePath(ref.relPath));

  const skipped: PreviewFileSkip[] = [];
  if (rename.includeTextOnlyMatches === true) {
    const rootPath =
      (await ladybugDb.getRepo(conn, request.repoId))?.rootPath ?? "";
    const textCandidates = await enumerateRepoFiles(
      rootPath,
      request.filters,
      request.maxFiles ?? DEFAULT_MAX_FILES,
    );
    // No g flag — .test() must be stateless across the file loop.
    const oldNameRegex = new RegExp(wordRegexForIdentifier(target.name).source);
    for (const rel of textCandidates.candidates) {
      if (candidateSet.has(rel)) continue;
      try {
        const abs = resolve(rootPath, rel);
        const readResult = await readSearchEditCandidateFile(rootPath, abs);
        if (readResult.ok && oldNameRegex.test(readResult.value.content)) {
          skipped.push({ path: rel, reason: "text-only-match" });
        }
      } catch {
        // text-only recall hints are best-effort diagnostics.
      }
    }
  }

  const renameCollisionFiles = new Set<string>();
  for (const rel of candidateSet) {
    const fileSymbols = await ladybugDb.getSymbolsForFile(conn, request.repoId, rel);
    if (fileSymbols.some((sym) => sym.name === rename.newName && sym.symbolId !== targetSymbolId)) {
      renameCollisionFiles.add(rel);
    }
  }

  return {
    request: {
      ...request,
      query: {
        ...request.query,
        literal: target.name,
        replacement: rename.newName,
        global: true,
      },
      renameCollisionFiles,
    },
    candidates: [...candidateSet],
    skipped,
    regex: wordRegexForIdentifier(target.name),
  };
}
