import { relative } from "path";
import { hashContent } from "../../util/hashing.js";
import type { ToolContext } from "../../server.js";
import type {
  LiveIndexCoordinator,
  SavedFileOwnership,
} from "../../live-index/types.js";
import { unlink } from "fs/promises";

import { parseActionHandlerArgs } from "../../gateway/dispatch-spine.js";
import {
  FileWriteRequestSchema,
  type DiffPreviewSnippets,
  type FileWriteResponse,
} from "../tools.js";
import { normalizePath, validatePathWithinRoot } from "../../util/paths.js";
import { logger } from "../../util/logger.js";
import {
  IndexError,
  NotFoundError,
  ValidationError,
} from "../../domain/errors.js";
import {
  getStructuralLanguageForPath,
  parseTreeForPath,
} from "./search-edit/structural.js";
import { attachRawContext } from "../token-usage.js";
import {
  assertStableCanonicalIdentity,
  BYTES_PER_TOKEN,
  preparePath,
  prepareNewContent,
  readExistingContent,
  runLiveIndexMutation,
  hashFileIfExists,
  validateExactlyOneMode,
  writeWithBackup,
} from "./file-write-internals.js";

function withRawTokenBaseline(
  response: FileWriteResponse,
  rawBytes: number,
): FileWriteResponse {
  return attachRawContext(response, {
    rawTokens: Math.ceil(rawBytes / BYTES_PER_TOKEN),
  });
}

function splitLines(content: string): string[] {
  return content.length === 0 ? [] : content.split(/\r?\n/);
}

function formatNumberedLines(
  lines: string[],
  startIndex: number,
  endIndex: number,
): string {
  if (lines.length === 0 || endIndex < startIndex) {
    return "";
  }
  // Keep both ends visible without letting a distant edit expand the preview.
  if (endIndex - startIndex + 1 > 80) {
    const headEnd = startIndex + 38;
    const tailStart = endIndex - 39;
    return [
      formatNumberedLines(lines, startIndex, headEnd),
      `... ${tailStart - headEnd - 1} lines omitted ...`,
      formatNumberedLines(lines, tailStart, endIndex),
    ].join("\n");
  }
  const out: string[] = [];
  for (let i = startIndex; i <= endIndex; i++) {
    out.push(`${String(i + 1).padStart(4, " ")} | ${lines[i] ?? ""}`);
  }
  return out.join("\n");
}

function buildDiffPreview(
  beforeContent: string,
  afterContent: string,
): DiffPreviewSnippets | undefined {
  if (beforeContent === afterContent) {
    return undefined;
  }

  const beforeLines = splitLines(beforeContent);
  const afterLines = splitLines(afterContent);
  const contextLines = 2;
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix++;
  }

  let beforeSuffix = beforeLines.length - 1;
  let afterSuffix = afterLines.length - 1;
  while (
    beforeSuffix >= prefix &&
    afterSuffix >= prefix &&
    beforeLines[beforeSuffix] === afterLines[afterSuffix]
  ) {
    beforeSuffix--;
    afterSuffix--;
  }

  const beforeStart = Math.max(0, prefix - contextLines);
  const afterStart = Math.max(0, prefix - contextLines);
  const beforeEnd = Math.min(
    beforeLines.length - 1,
    beforeSuffix + contextLines,
  );
  const afterEnd = Math.min(
    afterLines.length - 1,
    afterSuffix + contextLines,
  );

  return {
    before: formatNumberedLines(beforeLines, beforeStart, beforeEnd),
    after: formatNumberedLines(afterLines, afterStart, afterEnd),
    beforeStartLine: beforeStart + 1,
    beforeEndLine: beforeEnd >= beforeStart ? beforeEnd + 1 : beforeStart,
    afterStartLine: afterStart + 1,
    afterEndLine: afterEnd >= afterStart ? afterEnd + 1 : afterStart,
  };
}

export async function handleFileWrite(
  args: unknown,
  _context?: ToolContext,
  liveIndex?: LiveIndexCoordinator,
): Promise<FileWriteResponse> {
  const request = parseActionHandlerArgs(FileWriteRequestSchema, args);
  const prepared = await preparePath(request.repoId, request.filePath);
  const {
    canonicalRootPath,
    relPath,
    canonicalRelPath,
    absPath,
    canonicalAbsPath,
    fileExists,
  } = prepared;

  validateExactlyOneMode(request);

  if (!fileExists) {
    if (!request.createIfMissing && request.content === undefined) {
      throw new NotFoundError(
        `File not found: ${relPath}. Set createIfMissing: true to create it.`,
      );
    }
  }

  let existingContent = "";
  let existingBytes = 0;
  if (fileExists) {
    const read = await readExistingContent(absPath);
    existingContent = read.content;
    existingBytes = read.bytes;
  }

  const { newContent, mode, replacementCount } = prepareNewContent({
    prepared,
    request,
    existingContent,
    existingBytes,
  });
  // A no-op must not create a backup or queue a saved-file reconciliation.
  if (fileExists && mode === "replacePattern" && newContent === existingContent) {
    return withRawTokenBaseline({
      filePath: relPath,
      bytesWritten: 0,
      linesWritten: 0,
      mode,
      replacementCount,
      hint: "No text changed. Check the pattern and line endings (\\r?\\n), or use replaceLines.",
    }, existingBytes);
  }
  const snippets = buildDiffPreview(existingContent, newContent);

  // Indexed source must remain parseable before either disk or graph state changes.
  const syntaxTree = parseTreeForPath(canonicalRelPath, newContent);
  if (
    getStructuralLanguageForPath(canonicalRelPath) !== null &&
    (!syntaxTree || syntaxTree.rootNode.hasError)
  ) {
    throw new ValidationError(
      `Parse validation failed for indexed source: ${canonicalRelPath}`,
    );
  }

  let backupPath: string | undefined;
  let indexUpdate: FileWriteResponse["indexUpdate"];
  let written = false;
  let ownership: SavedFileOwnership | undefined;
  try {
    const mutation = await runLiveIndexMutation(
      request.repoId,
      canonicalRelPath,
      async (writePath) => {
        assertStableCanonicalIdentity(canonicalAbsPath, writePath);
        validatePathWithinRoot(canonicalRootPath, writePath);
        const currentHash = await hashFileIfExists(writePath);
        if (currentHash !== (fileExists ? hashContent(existingContent) : null))
          throw new ValidationError(
            "File changed after validation; refusing write",
          );
        backupPath = await writeWithBackup(
          absPath,
          newContent,
          request.createBackup ?? true,
          fileExists,
          undefined,
          writePath,
        );
        written = true;
        return backupPath;
      },
      liveIndex,
      {
        captureOwnership: (receipt) => {
          ownership = receipt;
        },
      },
    );
    indexUpdate = mutation.indexUpdate;
    if (indexUpdate?.applied === false && indexUpdate.pending !== true)
      throw new IndexError(
        `Indexed source reconciliation failed for ${relPath}: ${indexUpdate.error}`,
      );
  } catch (error) {
    if (written) {
      // Restoration is another accepted save. Never overwrite a later successful save.
      await runLiveIndexMutation(
        request.repoId,
        canonicalRelPath,
        async (writePath) => {
          assertStableCanonicalIdentity(canonicalAbsPath, writePath);
          if ((await hashFileIfExists(writePath)) !== hashContent(newContent))
            throw new IndexError(
              "Cannot restore write: a newer save owns the file",
            );
          if (fileExists)
            await writeWithBackup(
              absPath,
              existingContent,
              false,
              true,
              undefined,
              writePath,
            );
          else await unlink(writePath);
        },
        liveIndex,
        { expectedOwnership: ownership },
      );
    }
    throw error;
  } finally {
    ownership?.release();
  }
  const bytesWritten = Buffer.byteLength(newContent, "utf-8");
  const linesWritten = newContent.split("\n").length;
  logger.debug(
    `file.write completed: ${relPath} (${mode}, ${bytesWritten} bytes)`,
  );

  const rawBytes =
    mode === "create" || mode === "overwrite"
      ? bytesWritten
      : Math.max(existingBytes, bytesWritten);

  const response: FileWriteResponse = {
    filePath: relPath,
    bytesWritten,
    linesWritten,
    mode,
    ...(backupPath && {
      backupPath: normalizePath(relative(canonicalRootPath, backupPath)),
    }),
    ...(replacementCount !== undefined && { replacementCount }),
    ...(snippets !== undefined && { snippets }),
    ...(indexUpdate !== undefined && { indexUpdate }),
  };

  return withRawTokenBaseline(response, rawBytes);
}
