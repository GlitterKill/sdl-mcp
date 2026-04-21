import { relative } from "path";
import { realpathSync } from "fs";

import { FileWriteRequestSchema, type FileWriteResponse } from "../tools.js";
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
  if (fileExists && request.content === undefined) {
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
    ...(indexUpdate !== undefined && { indexUpdate }),
  };

  return withRawTokenBaseline(response, rawBytes);
}
