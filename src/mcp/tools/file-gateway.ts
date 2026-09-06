import { z } from "zod";
import { getLadybugConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import { normalizePath } from "../../util/paths.js";
import { resolveSymbolId } from "../../util/resolve-symbol-id.js";
import type { ToolContext } from "../../server.js";
import type { LiveIndexCoordinator } from "../../live-index/types.js";
import { NotFoundError, ValidationError } from "../errors.js";
import {
  CodeNeedWindowResponseSchema,
  DiffPreviewSnippetsSchema,
  FileReadResponseSchema,
  FileWriteResponseSchema,
  SearchEditResponseSchema,
  SymbolEditResponseSchema,
  withProjectionSuccessOutputSchema,
  type CodeNeedWindowResponse,
  type FileReadResponse,
  type FileWriteResponse,
  type SearchEditPreviewResponse,
  type SearchEditResponse,
  type SymbolEditResponse,
} from "../tools.js";
import {
  FileGatewayRequestSchema,
  type FileGatewayRequest,
  type FileGatewayWindowRequest,
} from "./file-gateway-schema.js";
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

export { FileGatewayRequestSchema };
export type { FileGatewayRequest };

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

const FileGatewayPreviewWindowResponseSchema = z
  .object({
    mode: z.enum(["previewWindow", "sourceWindow"]),
    planHandle: z.string(),
    file: z.string(),
    indexedSource: z.literal(true),
    snippets: DiffPreviewSnippetsSchema.optional(),
    codeWindow: withProjectionSuccessOutputSchema(
      "code.needWindow",
      CodeNeedWindowResponseSchema,
    ),
    diagnostics: z
      .object({
        timings: z
          .object({
            totalMs: z.number(),
            phases: z.record(z.string(), z.number()),
          })
          .strict(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const FileGatewayOutputSchema = z.union([
  withProjectionSuccessOutputSchema("file.read", FileReadResponseSchema),
  withProjectionSuccessOutputSchema("file.write", FileWriteResponseSchema),
  withProjectionSuccessOutputSchema("search.edit", SearchEditResponseSchema),
  withProjectionSuccessOutputSchema("symbol.edit", SymbolEditResponseSchema),
  FileGatewayPreviewWindowResponseSchema,
]);

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
    throw Object.assign(
      new NotFoundError(
        "Edit plan not found or expired: " + request.planHandle + ".",
      ),
      {
        classification: "not_found",
        retryable: false,
        fallbackTools: ["search.edit"],
        fallbackRationale:
          'Re-run search.edit with mode:"preview" and the original preview arguments, then apply the new planHandle.',
      },
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
    ...(request.op === "previewWindow"
      ? { snippets: findPlanPreviewEntry(plan, relPath)?.snippets }
      : {}),
    codeWindow,
  };
}

export async function handleFileGateway(
  args: unknown,
  context?: ToolContext,
  liveIndex?: LiveIndexCoordinator,
): Promise<FileGatewayResponse> {
  const timer = new ToolPhaseTimer();
  const parseStartedAt = timer.start();
  const hasExplicitResponseMode =
    typeof args === "object" &&
    args !== null &&
    Object.hasOwn(args, "responseMode");
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
        await handleFileRead(
          hasExplicitResponseMode ? rest : { ...rest, responseMode: "auto" },
          context,
        ),
        phaseStartedAt,
        "file.read",
      );
    }
    case "write": {
      const { op: _op, ...rest } = request;
      const phaseStartedAt = timer.start();
      return finish(await handleFileWrite(rest, context, liveIndex), phaseStartedAt, "file.write");
    }
    case "searchEditPreview": {
      const { op: _op, ...rest } = request;
      const phaseStartedAt = timer.start();
      return finish(
        await handleSearchEdit({ mode: "preview", ...rest }, context, liveIndex),
        phaseStartedAt,
        "file.searchEditPreview",
      );
    }
    case "searchEditApply": {
      const { op: _op, ...rest } = request;
      const phaseStartedAt = timer.start();
      return finish(
        await handleSearchEdit({ mode: "apply", ...rest }, context, liveIndex),
        phaseStartedAt,
        "file.searchEditApply",
      );
    }
    case "symbolEditPreview": {
      const { op: _op, ...rest } = request;
      const phaseStartedAt = timer.start();
      return finish(
        await handleSymbolEdit({ mode: "preview", ...rest }, context, liveIndex),
        phaseStartedAt,
        "file.symbolEditPreview",
      );
    }
    case "symbolEditApply": {
      const { op: _op, ...rest } = request;
      const phaseStartedAt = timer.start();
      return finish(
        await handleSymbolEdit({ mode: "apply", ...rest }, context, liveIndex),
        phaseStartedAt,
        "file.symbolEditApply",
      );
    }
    case "symbolEditApplyNow": {
      const { op: _op, ...rest } = request;
      const phaseStartedAt = timer.start();
      return finish(
        await handleSymbolEdit({ mode: "applyNow", ...rest }, context, liveIndex),
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
