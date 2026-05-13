import { relative } from "path";
import { realpathSync } from "fs";

import {
  FileWriteRequestSchema,
  type DiffPreviewSnippets,
  type FileWriteResponse,
} from "../tools.js";
import { normalizePath, validatePathWithinRoot } from "../../util/paths.js";
import { logger } from "../../util/logger.js";
import { NotFoundError } from "../../domain/errors.js";
import { attachRawContext } from "../token-usage.js";
import {
  BYTES_PER_TOKEN,
  preparePath,
  prepareNewContent,
  readExistingContent,
  syncLiveIndex,
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
  const maxLines = 80;
  let prefix = 0;
  while (
    prefix < beforeLines.length
    && prefix < afterLines.length
    && beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix++;
  }

  let beforeSuffix = beforeLines.length - 1;
  let afterSuffix = afterLines.length - 1;
  while (
    beforeSuffix >= prefix
    && afterSuffix >= prefix
    && beforeLines[beforeSuffix] === afterLines[afterSuffix]
  ) {
    beforeSuffix--;
    afterSuffix--;
  }

  const beforeStart = Math.max(0, prefix - contextLines);
  const afterStart = Math.max(0, prefix - contextLines);
  const beforeEnd = Math.min(
    beforeLines.length - 1,
    beforeSuffix + contextLines,
    beforeStart + maxLines - 1,
  );
  const afterEnd = Math.min(
    afterLines.length - 1,
    afterSuffix + contextLines,
    afterStart + maxLines - 1,
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
): Promise<FileWriteResponse> {
  const request = FileWriteRequestSchema.parse(args);
  const prepared = await preparePath(request.repoId, request.filePath);
  const { rootPath, relPath, absPath, fileExists } = prepared;

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
  const snippets = buildDiffPreview(existingContent, newContent);

  // Re-verify path hasn't been swapped for a symlink since preparePath
  if (fileExists) {
    const resolved = realpathSync(absPath);
    if (resolved !== absPath) {
      validatePathWithinRoot(rootPath, resolved);
    }
  }

  const backupPath = await writeWithBackup(
    absPath,
    newContent,
    request.createBackup ?? true,
    fileExists,
  );

  const bytesWritten = Buffer.byteLength(newContent, "utf-8");
  const linesWritten = newContent.split("\n").length;

  logger.debug(
    `file.write completed: ${relPath} (${mode}, ${bytesWritten} bytes)`,
  );

  const indexUpdate = await syncLiveIndex(
    request.repoId,
    relPath,
    newContent,
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
      backupPath: normalizePath(relative(rootPath, backupPath)),
    }),
    ...(replacementCount !== undefined && { replacementCount }),
    ...(snippets !== undefined && { snippets }),
    ...(indexUpdate !== undefined && { indexUpdate }),
  };

  return withRawTokenBaseline(response, rawBytes);
}
