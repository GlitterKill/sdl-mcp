import { z } from "zod";
import {
  MAX_REPO_ID_LENGTH,
  MAX_SYMBOL_ID_LENGTH,
} from "../../config/constants.js";
import {
  CodeNeedWindowRequestObjectSchema,
  FileWriteReplaceLinesSchema,
  FileWriteReplacePatternSchema,
  FileWriteInsertAtSchema,
  SearchEditQuerySchema,
  SearchEditFiltersSchema,
  SearchEditEditMode,
  SymbolEditOperationSchema,
} from "../tools.js";

/**
 * Input-only schema surface shared by the executable gateway and recovery validation.
 * Keep this module free of handler and MCP error imports so cold imports cannot cycle.
 */
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
  maxTokens: z
    .number()
    .int()
    .min(1)
    .max(250_000)
    .optional()
    .describe(
      "Max estimated tokens to return. When maxBytes is also set, the tighter bound applies.",
    ),
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
      "Case-insensitive regex search; escape literal punctuation. Returns matching lines with context.",
    ),
  searchContext: z
    .number()
    .int()
    .min(0)
    .max(20)
    .default(2)
    .describe("Context lines per search match: 0-20 (default 2)."),
  jsonPath: z
    .string()
    .max(200)
    .optional()
    .describe(
      "For JSON/YAML files: dot-separated key path to extract (e.g. 'server.port' or 'dependencies').",
    ),
  responseMode: z
    .enum(["inline", "auto", "handle"])
    .optional()
    .default("inline"),
  deltaMode: z.enum(["off", "auto"]).optional().default("off"),
  maxDeltaLines: z.number().int().min(1).max(1000).optional(),
  includeDiagnostics: z.boolean().optional(),
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
    FileWriteReplacePatternSchema.optional().describe("Regex find/replace; match line endings with \\r?\\n for LF/CRLF files"),
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
    .describe(
      "Create a retained sibling .bak backup before modifying; fails if that backup already exists, so remove or move it or set createBackup: false (default: true)",
    ),
  createIfMissing: z
    .boolean()
    .optional()
    .default(false)
    .describe("Create file if it doesn't exist"),
  includeDiagnostics: z.boolean().optional(),
});

const FileGatewaySearchEditBatchOperationSchema = z.object({
  id: z.string().min(1).max(80).optional(),
  targeting: z.enum(["text", "symbol", "identifier", "structural"]),
  query: SearchEditQuerySchema,
  filters: SearchEditFiltersSchema.optional(),
  editMode: SearchEditEditMode,
  maxFiles: z.number().int().min(1).max(500).optional(),
  maxMatchesPerFile: z.number().int().min(1).max(5000).optional(),
  maxTotalMatches: z.number().int().min(1).max(50000).optional(),
});

const FileGatewaySearchEditPreviewSchema = z
  .object({
    op: z.literal("searchEditPreview"),
    repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
    targeting: z
      .enum(["text", "symbol", "identifier", "structural", "rename", "signature"])
      .optional(),
    query: SearchEditQuerySchema.optional(),
    filters: SearchEditFiltersSchema.optional(),
    editMode: SearchEditEditMode.optional(),
    operations: z
      .array(FileGatewaySearchEditBatchOperationSchema)
      .min(1)
      .max(50)
      .optional(),
    previewContextLines: z.number().int().min(0).max(20).optional(),
    maxFiles: z.number().int().min(1).max(500).optional(),
    maxMatchesPerFile: z.number().int().min(1).max(5000).optional(),
    maxTotalMatches: z.number().int().min(1).max(50000).optional(),
    createBackup: z.boolean().optional(),
    responseMode: z.enum(["inline", "auto", "handle"]).optional(),
    includeDiagnostics: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const operations = value.operations;
    if (operations !== undefined) {
      const seenOperationIds = new Map<string, number>();
      operations.forEach((operation, index) => {
        const trimmed = operation.id?.trim();
        const operationId =
          trimmed && trimmed.length > 0 ? trimmed : `op-${index + 1}`;
        const firstIndex = seenOperationIds.get(operationId);
        if (firstIndex !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["operations", index, "id"],
            message: `Duplicate search.edit operation id "${operationId}" at operations[${index}] (first used at operations[${firstIndex}]).`,
          });
        } else {
          seenOperationIds.set(operationId, index);
        }
      });
      for (const field of ["targeting", "query", "editMode"] as const) {
        if (value[field] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message:
              "operations[] is mutually exclusive with top-level targeting, query, and editMode.",
          });
        }
      }
      return;
    }
    for (const field of ["targeting", "query", "editMode"] as const) {
      if (value[field] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: "Required when operations[] is not provided.",
        });
      }
    }
  });

const FileGatewaySearchEditApplySchema = z.object({
  op: z.literal("searchEditApply"),
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  planHandle: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "Required for apply and preview/source window operations; obtain it from the matching preview response.",
    ),

  createBackup: z.boolean().optional(),
  includeDiagnostics: z.boolean().optional(),
});

const FileGatewaySymbolEditPreviewSchema = z
  .object({
    op: z.literal("symbolEditPreview"),
    repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
    symbolId: z.string().min(1).max(MAX_SYMBOL_ID_LENGTH).optional(),
    symbolRef: z
      .object({
        name: z.string().min(1),
        file: z.string().min(1).optional(),
        kind: z.string().min(1).optional(),
        exportedOnly: z.boolean().optional(),
      })
      .optional(),
    operation: SymbolEditOperationSchema,
    createBackup: z.boolean().optional(),
    includeDiagnostics: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const targetCount =
      Number(value.symbolId !== undefined) +
      Number(value.symbolRef !== undefined);
    if (targetCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one of symbolId or symbolRef.",
        path: ["symbolId"],
      });
    }
  });

const FileGatewaySymbolEditApplySchema = z.object({
  op: z.literal("symbolEditApply"),
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  planHandle: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "Required for apply and preview/source window operations; obtain it from the matching preview response.",
    ),
  createBackup: z.boolean().optional(),
  includeDiagnostics: z.boolean().optional(),
});

const FileGatewaySymbolEditApplyNowSchema = z.object({
  op: z.literal("symbolEditApplyNow"),
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  symbolId: z.string().min(1).max(MAX_SYMBOL_ID_LENGTH),
  expectedAstFingerprint: z.string().min(1),
  expectedRange: z.object({
    startLine: z.number().int().min(0),
    startCol: z.number().int().min(0),
    endLine: z.number().int().min(0),
    endCol: z.number().int().min(0),
  }),
  operation: SymbolEditOperationSchema,
  createBackup: z.boolean().optional(),
  includeDiagnostics: z.boolean().optional(),
});

const FileGatewayWindowBaseSchema = CodeNeedWindowRequestObjectSchema.omit({
  repoId: true,
  symbolId: true,
  symbolRef: true,
}).extend({
  repoId: z.string().min(1).max(MAX_REPO_ID_LENGTH),
  symbolId: z
    .string()
    .min(1)
    .max(MAX_SYMBOL_ID_LENGTH)
    .optional()
    .describe(
      "Symbol ID to inspect inside the planned file. Required for source-window retrieval; the plan handle constrains the file but does not identify a symbol.",
    ),
  symbolRef: z.never().optional(),
  planHandle: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "Required for apply and preview/source window operations; obtain it from the matching preview response.",
    ),

  filePath: z
    .string()
    .min(1)
    .max(1024)
    .refine((p) => !p.includes("\0"), {
      message: "filePath must not contain null bytes",
    })
    .optional()
    .describe(
      "Planned file path to inspect. Required when the edit plan has multiple indexed source files.",
    ),
  includeDiagnostics: z.boolean().optional(),
});

const FileGatewayPreviewWindowSchema = FileGatewayWindowBaseSchema.extend({
  op: z.literal("previewWindow"),
}).strict();

const FileGatewaySourceWindowSchema = FileGatewayWindowBaseSchema.extend({
  op: z.literal("sourceWindow"),
}).strict();

export const FileGatewayRequestSchema = z.discriminatedUnion("op", [
  FileGatewayReadSchema,
  FileGatewayWriteSchema,
  FileGatewaySearchEditPreviewSchema,
  FileGatewaySearchEditApplySchema,
  FileGatewaySymbolEditPreviewSchema,
  FileGatewaySymbolEditApplySchema,
  FileGatewaySymbolEditApplyNowSchema,
  FileGatewayPreviewWindowSchema,
  FileGatewaySourceWindowSchema,
]);

export type FileGatewayRequest = z.infer<typeof FileGatewayRequestSchema>;

export type FileGatewayWindowRequest =
  | z.infer<typeof FileGatewayPreviewWindowSchema>
  | z.infer<typeof FileGatewaySourceWindowSchema>;
