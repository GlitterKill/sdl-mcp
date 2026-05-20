import { z } from "zod";
import {
  MAX_REPO_ID_LENGTH,
  MAX_SYMBOL_ID_LENGTH,
} from "../../config/constants.js";
import { getLadybugConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import { normalizePath } from "../../util/paths.js";
import { resolveSymbolId } from "../../util/resolve-symbol-id.js";
import type { ToolContext } from "../../server.js";
import { NotFoundError, ValidationError } from "../errors.js";
import {
  CodeNeedWindowRequestSchema,
  FileWriteReplaceLinesSchema,
  FileWriteReplacePatternSchema,
  FileWriteInsertAtSchema,
  SearchEditQuerySchema,
  SearchEditFiltersSchema,
  SearchEditEditMode,
  SymbolEditOperationSchema,
  type CodeNeedWindowResponse,
  type FileReadResponse,
  type FileWriteResponse,
  type SearchEditPreviewResponse,
  type SearchEditResponse,
  type SymbolEditResponse,
} from "../tools.js";
import { handleCodeNeedWindow } from "./code.js";
import { handleFileRead } from "./file-read.js";
import { handleFileWrite } from "./file-write.js";
import { handleSearchEdit } from "./search-edit/index.js";
import { handleSymbolEdit } from "./symbol-edit/index.js";
import {
  getSearchEditPlanStore,
  type StoredPlan,
} from "./search-edit/plan-store.js";
import {
  attachTimingDiagnostics,
  ToolPhaseTimer,
  type ToolTimingDiagnostics,
} from "../timing-diagnostics.js";

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
  includeDiagnostics: z.boolean().optional(),
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
  responseMode: z
    .enum(["inline", "auto", "handle"])
    .optional()
    .default("inline"),
  includeDiagnostics: z.boolean().optional(),
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

const FileGatewayWindowBaseSchema = CodeNeedWindowRequestSchema.omit({
  repoId: true,
  symbolId: true,
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
});

const FileGatewaySourceWindowSchema = FileGatewayWindowBaseSchema.extend({
  op: z.literal("sourceWindow"),
});

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

type FileGatewayWindowRequest =
  | z.infer<typeof FileGatewayPreviewWindowSchema>
  | z.infer<typeof FileGatewaySourceWindowSchema>;

type SearchEditPreviewFileEntry =
  SearchEditPreviewResponse["fileEntries"][number];

export interface FileGatewayPreviewWindowResponse {
  mode: "previewWindow" | "sourceWindow";
  planHandle: string;
  file: string;
  indexedSource: true;
  snippets?: SearchEditPreviewFileEntry["snippets"];
  codeWindow: CodeNeedWindowResponse;
  diagnostics?: ToolTimingDiagnostics;
}

export type FileGatewayResponse =
  | FileReadResponse
  | FileWriteResponse
  | SearchEditResponse
  | SymbolEditResponse
  | FileGatewayPreviewWindowResponse;

function findPlanPreviewEntry(
  plan: StoredPlan,
  relPath: string,
): SearchEditPreviewFileEntry | undefined {
  const entries = (plan.summary as { fileEntries?: unknown }).fileEntries;
  if (!Array.isArray(entries)) return undefined;
  return entries.find(
    (entry): entry is SearchEditPreviewFileEntry =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as { file?: unknown }).file === relPath,
  );
}

function selectPlanWindowEdit(
  plan: StoredPlan,
  request: FileGatewayWindowRequest,
) {
  const requestedPath = request.filePath
    ? normalizePath(request.filePath)
    : undefined;
  const indexedEdits = plan.edits.filter((edit) => edit.indexedSource);
  if (indexedEdits.length === 0) {
    throw new ValidationError(
      "Edit plan " +
        request.planHandle +
        " does not contain indexed source edits.",
    );
  }

  if (!requestedPath && indexedEdits.length > 1) {
    throw new ValidationError(
      "filePath is required because the edit plan contains multiple indexed source files.",
    );
  }

  const edit = requestedPath
    ? indexedEdits.find(
        (candidate) => normalizePath(candidate.relPath) === requestedPath,
      )
    : indexedEdits[0];
  if (!edit) {
    throw new ValidationError(
      "Edit plan " +
        request.planHandle +
        " does not include indexed source file " +
        (requestedPath ?? "<unspecified>") +
        ".",
    );
  }
  return edit;
}

async function resolvePlanWindowSymbolId(
  request: FileGatewayWindowRequest,
  relPath: string,
): Promise<string> {
  if (!request.symbolId) {
    throw new ValidationError(
      request.op +
        " requires symbolId for the planned indexed source file " +
        relPath +
        ". Use symbol.search or symbol.getCard to select the symbol; planHandle only constrains the file.",
    );
  }

  const conn = await getLadybugConn();
  const { symbolId } = await resolveSymbolId(
    conn,
    request.repoId,
    request.symbolId,
  );
  const symbols = await ladybugDb.getSymbolsByIds(conn, [symbolId]);
  const symbol = symbols.get(symbolId);
  if (!symbol) {
    throw new NotFoundError(
      "Symbol not found: " +
        request.symbolId +
        ". Use sdl.symbol.search to find valid symbol IDs.",
    );
  }
  if (symbol.repoId !== request.repoId) {
    throw new ValidationError(
      "Symbol " +
        request.symbolId +
        ' belongs to repo "' +
        symbol.repoId +
        '", not "' +
        request.repoId +
        '".',
    );
  }

  const files = await ladybugDb.getFilesByIds(conn, [symbol.fileId]);
  const file = files.get(symbol.fileId);
  if (!file) {
    throw new NotFoundError(
      "File record missing for symbol " +
        symbol.name +
        " (" +
        symbolId +
        "). Try re-indexing with sdl.index.refresh.",
    );
  }

  const symbolRelPath = normalizePath(file.relPath);
  const plannedRelPath = normalizePath(relPath);
  if (symbolRelPath !== plannedRelPath) {
    throw new ValidationError(
      "Symbol " +
        request.symbolId +
        " belongs to " +
        symbolRelPath +
        ", not planned file " +
        plannedRelPath +
        ".",
    );
  }
  return symbolId;
}

function buildPlanWindowSliceContext(
  request: FileGatewayWindowRequest,
  relPath: string,
): NonNullable<FileGatewayWindowRequest["sliceContext"]> {
  const editedFiles = Array.from(
    new Set([
      normalizePath(relPath),
      ...(request.sliceContext?.editedFiles?.map((file) =>
        normalizePath(file),
      ) ?? []),
    ]),
  );
  return request.sliceContext
    ? { ...request.sliceContext, editedFiles }
    : { taskText: request.reason, editedFiles };
}

async function handleFileGatewayPreviewWindow(
  request: FileGatewayWindowRequest,
  context?: ToolContext,
): Promise<FileGatewayPreviewWindowResponse> {
  const plan = getSearchEditPlanStore().get(request.planHandle);
  if (!plan) {
    throw new NotFoundError(
      "Edit plan not found or expired: " +
        request.planHandle +
        ". Run searchEditPreview again.",
    );
  }
  if (plan.repoId !== request.repoId) {
    throw new ValidationError(
      "Edit plan " +
        request.planHandle +
        ' belongs to repo "' +
        plan.repoId +
        '", not "' +
        request.repoId +
        '".',
    );
  }

  // The plan handle selects the file; source access still goes through code.needWindow policy.
  const edit = selectPlanWindowEdit(plan, request);
  const relPath = normalizePath(edit.relPath);
  const symbolId = await resolvePlanWindowSymbolId(request, relPath);
  const {
    op: _op,
    planHandle: _planHandle,
    filePath: _filePath,
    ...codeWindowRequest
  } = request;
  const codeWindow = await handleCodeNeedWindow(
    {
      ...codeWindowRequest,
      repoId: request.repoId,
      symbolId,
      sliceContext: buildPlanWindowSliceContext(request, relPath),
    },
    context,
  );

  if (
    "approved" in codeWindow &&
    codeWindow.approved &&
    normalizePath(codeWindow.file) !== relPath
  ) {
    throw new ValidationError(
      "Code-window policy returned " +
        codeWindow.file +
        ", not planned file " +
        relPath +
        ".",
    );
  }

  return {
    mode: request.op,
    planHandle: request.planHandle,
    file: relPath,
    indexedSource: true,
    snippets: findPlanPreviewEntry(plan, relPath)?.snippets,
    codeWindow,
  };
}

export async function handleFileGateway(
  args: unknown,
  context?: ToolContext,
): Promise<FileGatewayResponse> {
  const timer = new ToolPhaseTimer();
  const parseStartedAt = timer.start();
  const request = FileGatewayRequestSchema.parse(args);
  timer.record("file.validate", parseStartedAt);

  const finish = <T extends FileGatewayResponse>(
    response: T,
    phaseStartedAt: number,
    phase: string,
  ): T => {
    timer.record(phase, phaseStartedAt);
    return request.includeDiagnostics
      ? attachTimingDiagnostics(response, timer.snapshot())
      : response;
  };

  switch (request.op) {
    case "read": {
      const { op: _op, ...rest } = request;
      const phaseStartedAt = timer.start();
      return finish(
        await handleFileRead(rest, context),
        phaseStartedAt,
        "file.read",
      );
    }
    case "write": {
      const { op: _op, ...rest } = request;
      const phaseStartedAt = timer.start();
      return finish(await handleFileWrite(rest), phaseStartedAt, "file.write");
    }
    case "searchEditPreview": {
      const { op: _op, ...rest } = request;
      const phaseStartedAt = timer.start();
      return finish(
        await handleSearchEdit({ mode: "preview", ...rest }, context),
        phaseStartedAt,
        "file.searchEditPreview",
      );
    }
    case "searchEditApply": {
      const { op: _op, ...rest } = request;
      const phaseStartedAt = timer.start();
      return finish(
        await handleSearchEdit({ mode: "apply", ...rest }, context),
        phaseStartedAt,
        "file.searchEditApply",
      );
    }
    case "symbolEditPreview": {
      const { op: _op, ...rest } = request;
      const phaseStartedAt = timer.start();
      return finish(
        await handleSymbolEdit({ mode: "preview", ...rest }, context),
        phaseStartedAt,
        "file.symbolEditPreview",
      );
    }
    case "symbolEditApply": {
      const { op: _op, ...rest } = request;
      const phaseStartedAt = timer.start();
      return finish(
        await handleSymbolEdit({ mode: "apply", ...rest }, context),
        phaseStartedAt,
        "file.symbolEditApply",
      );
    }
    case "symbolEditApplyNow": {
      const { op: _op, ...rest } = request;
      const phaseStartedAt = timer.start();
      return finish(
        await handleSymbolEdit({ mode: "applyNow", ...rest }, context),
        phaseStartedAt,
        "file.symbolEditApplyNow",
      );
    }
    case "previewWindow":
    case "sourceWindow": {
      const phaseStartedAt = timer.start();
      return finish(
        await handleFileGatewayPreviewWindow(request, context),
        phaseStartedAt,
        `file.${request.op}`,
      );
    }
  }
}
