import { z } from "zod";
import { MAX_REPO_ID_LENGTH } from "../../config/constants.js";
import {
  FileWriteReplaceLinesSchema,
  FileWriteReplacePatternSchema,
  FileWriteInsertAtSchema,
  SearchEditQuerySchema,
  SearchEditFiltersSchema,
  SearchEditEditMode,
  type FileReadResponse,
  type FileWriteResponse,
  type SearchEditResponse,
} from "../tools.js";
import { handleFileRead } from "./file-read.js";
import { handleFileWrite } from "./file-write.js";
import { handleSearchEdit } from "./search-edit/index.js";

const FileGatewayReadSchema = z.object({
  op: z.literal("read"),
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  filePath: z
    .string()
    .min(1)
    .describe(
      "File path relative to repo root. Only non-indexed file types allowed.",
    ),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(512 * 1024)
    .optional()
    .describe("Max bytes to read. Default 512KB."),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Start reading from this line number (0-based). Omit for beginning of file.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .optional()
    .describe(
      "Max lines to return. Omit for no line limit (maxBytes still applies).",
    ),
  search: z
    .string()
    .max(500)
    .optional()
    .describe(
      "Return only lines matching this regex pattern (case-insensitive). Includes context lines.",
    ),
  searchContext: z
    .number()
    .int()
    .min(0)
    .max(20)
    .default(2)
    .describe("Lines of context around each search match. Default 2."),
  jsonPath: z
    .string()
    .max(200)
    .optional()
    .describe(
      "For JSON/YAML files: dot-separated key path to extract (e.g. 'server.port' or 'dependencies').",
    ),
});

const FileGatewayWriteSchema = z.object({
  op: z.literal("write"),
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  filePath: z
    .string()
    .min(1)
    .max(1024)
    .refine((p) => !p.includes("\0"), {
      message: "filePath must not contain null bytes",
    })
    .describe("File path relative to repo root"),
  content: z
    .string()
    .max(512 * 1024)
    .optional()
    .describe("Full file content for create/overwrite mode (max 512KB)"),
  replaceLines: FileWriteReplaceLinesSchema.optional().describe(
    "Replace a line range with new content",
  ),
  replacePattern:
    FileWriteReplacePatternSchema.optional().describe("Regex find/replace"),
  jsonPath: z
    .string()
    .max(200)
    .optional()
    .describe("Dot-separated path to update in JSON/YAML"),
  jsonValue: z
    .unknown()
    .optional()
    .describe("New value for jsonPath (required if jsonPath is set)"),
  insertAt: FileWriteInsertAtSchema.optional().describe(
    "Insert content at a specific line",
  ),
  append: z
    .string()
    .max(512 * 1024)
    .optional()
    .describe("Content to append to end of file (max 512KB)"),
  createBackup: z
    .boolean()
    .optional()
    .default(true)
    .describe("Create .bak backup before modifying (default: true)"),
  createIfMissing: z
    .boolean()
    .optional()
    .default(false)
    .describe("Create file if it doesn't exist"),
});

const FileGatewaySearchEditPreviewSchema = z.object({
  op: z.literal("searchEditPreview"),
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  targeting: z.enum(["text", "symbol"]),
  query: SearchEditQuerySchema,
  filters: SearchEditFiltersSchema.optional(),
  editMode: SearchEditEditMode,
  previewContextLines: z.number().int().min(0).max(20).optional(),
  maxFiles: z.number().int().min(1).max(500).optional(),
  maxMatchesPerFile: z.number().int().min(1).max(5000).optional(),
  maxTotalMatches: z.number().int().min(1).max(50000).optional(),
  createBackup: z.boolean().optional(),
});

const FileGatewaySearchEditApplySchema = z.object({
  op: z.literal("searchEditApply"),
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  planHandle: z.string().min(1).max(200),
  createBackup: z.boolean().optional(),
});

export const FileGatewayRequestSchema = z.discriminatedUnion("op", [
  FileGatewayReadSchema,
  FileGatewayWriteSchema,
  FileGatewaySearchEditPreviewSchema,
  FileGatewaySearchEditApplySchema,
]);

export type FileGatewayRequest = z.infer<typeof FileGatewayRequestSchema>;
export type FileGatewayResponse =
  | FileReadResponse
  | FileWriteResponse
  | SearchEditResponse;

export async function handleFileGateway(
  args: unknown,
): Promise<FileGatewayResponse> {
  const request = FileGatewayRequestSchema.parse(args);

  switch (request.op) {
    case "read": {
      const { op, ...rest } = request;
      return handleFileRead(rest);
    }
    case "write": {
      const { op, ...rest } = request;
      return handleFileWrite(rest);
    }
    case "searchEditPreview": {
      const { op, ...rest } = request;
      return handleSearchEdit({ mode: "preview", ...rest });
    }
    case "searchEditApply": {
      const { op, ...rest } = request;
      return handleSearchEdit({ mode: "apply", ...rest });
    }
  }
}
