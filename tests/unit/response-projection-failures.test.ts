import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { z } from "zod";

import { registerTools } from "../../dist/mcp/tools/index.js";
import {
  buildToolResponseEnvelope,
  MCPServer,
  responseForDeliveryAudit,
} from "../../dist/server.js";
import { projectCompatibilityValue } from
  "../../dist/mcp/context-response-projection.js";
import { projectModelResponse } from
  "../../dist/mcp/response-projection/projectors/index.js";
import { estimateTokens } from "../../dist/util/tokenize.js";

const TEST_PROFILE = Object.freeze({
  projector: "generic",
  observabilityProfile: "standard",
  defaultDetail: "compact",
  budgetClass: "compact",
  largeResponseStrategy: "truncate",
  recoveryPolicy: "none",
});

const TEST_OPTIONS = Object.freeze({
  detail: "compact",
  includeDiagnostics: false,
});

type RequestHandler = (
  request: { method: "tools/list" },
  extra: Record<string, unknown>,
) => Promise<{ tools: Array<Record<string, unknown>> }>;

function getListToolsHandler(server: MCPServer): RequestHandler {
  const sdkServer = server.getServer() as unknown as {
    _requestHandlers: Map<string, RequestHandler>;
  };
  const handler = sdkServer._requestHandlers.get("tools/list");
  assert.ok(handler, "tools/list handler should be registered");
  return handler;
}

function buildBoundaryEnvelope(
  canonicalResult: Record<string, unknown>,
  boundaryOverrides: Record<string, unknown> = {},
) {
  return buildToolResponseEnvelope(
    canonicalResult,
    null,
    "",
    "sdl.runtime.execute",
    {},
    { source: "divergent-structured-payload" },
    true,
    TEST_PROFILE,
    TEST_OPTIONS,
    boundaryOverrides,
  );
}

function assertSafeBoundaryFailure(
  response: Record<string, unknown>,
  code: string,
): void {
  assert.deepEqual(Object.keys(response), [
    "content",
    "structuredContent",
    "isError",
  ]);
  assert.equal(response.isError, true);

  const structured = response.structuredContent as Record<string, unknown>;
  assert.deepEqual(Object.keys(structured), ["error"]);
  assert.deepEqual(
    Object.keys(structured.error as Record<string, unknown>),
    ["code", "message"],
  );
  assert.equal(
    (structured.error as Record<string, unknown>).code,
    code,
  );

  const serialized = JSON.stringify(response);
  assert.match(serialized, new RegExp(code));
  assert.doesNotMatch(serialized, /canonical-secret|C:\\private|projector exploded/);
  assert.ok(estimateTokens(serialized) <= 200, serialized);

  const blocks = response.content as Array<Record<string, unknown>>;
  assert.ok(estimateTokens(String(blocks[0]?.text ?? "")) <= 120);
}

describe("response projection boundary", () => {
  it("derives both MCP channels and stats from one immutable projection", () => {
    const packedPayload = "#PACKED/v1\n@ids=0:symbol:one\ncanonical-secret";
    const repeatedJson = JSON.stringify({ canonical: "canonical-secret" });
    const canonicalResult = {
      status: "success",
      stdoutSummary: `${repeatedJson}\n${"large output ".repeat(300)}`,
      packedPayload,
      source: "canonical-source",
      _rawContext: { path: "C:\\private\\raw-context.json", rawTokens: 900 },
      _tokenUsage: { sdlTokens: 10, rawEquivalent: 100 },
    };
    const original = structuredClone(canonicalResult);

    const first = buildBoundaryEnvelope(canonicalResult) as Record<string, unknown>;
    const second = buildBoundaryEnvelope(canonicalResult) as Record<string, unknown>;
    const firstContent = first.content as Array<Record<string, unknown>>;
    const firstStructured = first.structuredContent as Record<string, unknown>;

    assert.equal(firstStructured.source, undefined);
    assert.notEqual(firstStructured.source, "divergent-structured-payload");
    assert.equal(firstStructured._rawContext, undefined);
    assert.equal(firstStructured._tokenUsage, undefined);
    assert.ok(first.projectionStats, "projection stats should be returned internally");
    assert.ok(estimateTokens(String(firstContent[0]?.text ?? "")) <= 120);
    assert.doesNotMatch(String(firstContent[0]?.text ?? ""), /#PACKED\/|canonical-secret/);
    assert.doesNotMatch(JSON.stringify(first), /canonical-source/);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.deepEqual(canonicalResult, original);
  });

  it("returns a bounded typed error when projection fails", () => {
    const response = buildBoundaryEnvelope(
      {
        canonical: "canonical-secret",
        path: "C:\\private\\projection.json",
      },
      {
        projectValue: () => {
          throw new Error("projector exploded at C:\\private\\projection.json");
        },
      },
    ) as Record<string, unknown>;

    assertSafeBoundaryFailure(response, "MODEL_PROJECTION_FAILED");
  });

  it("accepts projection boundary failures through the workflow validator", () => {
    const server = new MCPServer();
    registerTools(
      server,
      { actionAvailability: { memoryTools: true, infoTool: true } },
      undefined,
      { enabled: true, exclusive: true },
    );
    const workflowTool = (
      server as unknown as {
        tools: Map<string, { validationOutputSchema?: z.ZodType }>;
      }
    ).tools.get("sdl.workflow");
    assert.ok(workflowTool?.validationOutputSchema);

    const response = buildBoundaryEnvelope(
      { canonical: "workflow-boundary" },
      {
        projectValue: () => {
          throw new Error("workflow projector failed");
        },
      },
    );
    assert.deepEqual(Object.keys(response.structuredContent ?? {}), ["error"]);
    const validation = workflowTool.validationOutputSchema.safeParse(
      response.structuredContent,
    );

    assert.equal(
      validation.success,
      true,
      validation.success ? undefined : validation.error.message,
    );
  });

  it("audits the delivered boundary failure instead of canonical success", () => {
    const canonicalResult = {
      status: "success",
      secret: "canonical-secret",
      path: "C:\\private\\audit.json",
    };
    const envelope = buildBoundaryEnvelope(canonicalResult, {
      projectValue: () => {
        throw new Error("projector exploded at C:\\private\\audit.json");
      },
    });

    const auditResponse = responseForDeliveryAudit(canonicalResult, envelope);

    assert.deepEqual(auditResponse, {
      status: "error",
      error: { code: "MODEL_PROJECTION_FAILED" },
    });
    assert.doesNotMatch(
      JSON.stringify(auditResponse),
      /canonical-secret|C:\\private|Model response projection failed/,
    );
  });

  it("audits a delivered workflow-child failure as an error", () => {
    const canonicalResult = {
      status: "success",
      results: [
        {
          fn: "runtimeExecute",
          status: "error",
          error: "child failed at C:\\private\\workflow.json",
        },
      ],
    };
    const envelope = buildToolResponseEnvelope(
      canonicalResult,
      null,
      "",
      "sdl.workflow",
      { steps: [{ fn: "runtimeExecute", args: {} }] },
      canonicalResult,
      true,
      Object.freeze({ ...TEST_PROFILE, projector: "workflow" }),
      TEST_OPTIONS,
    );

    assert.equal(envelope.isError, true);
    const auditResponse = responseForDeliveryAudit(canonicalResult, envelope);
    assert.deepEqual(auditResponse, {
      status: "error",
      error: { code: "DELIVERED_RESPONSE_ERROR" },
    });
    assert.doesNotMatch(
      JSON.stringify(auditResponse),
      /runtimeExecute|child failed|C:\\private/,
    );
  });

  it("types failures raised while preparing canonical content", () => {
    const canonicalResult: Record<string, unknown> = { status: "success" };
    Object.defineProperty(canonicalResult, "secret", {
      enumerable: true,
      get: () => {
        throw new Error("getter exploded at C:\\private\\getter.json");
      },
    });

    const response = buildBoundaryEnvelope(canonicalResult) as Record<string, unknown>;

    assertSafeBoundaryFailure(response, "MODEL_PROJECTION_FAILED");
  });

  it("rejects cyclic canonical content without unbounded recursion", () => {
    const canonicalResult: Record<string, unknown> = { status: "success" };
    let cycleReads = 0;
    Object.defineProperty(canonicalResult, "self", {
      enumerable: true,
      get: () => {
        cycleReads += 1;
        return canonicalResult;
      },
    });

    const response = buildBoundaryEnvelope(canonicalResult) as Record<string, unknown>;

    assertSafeBoundaryFailure(response, "MODEL_PROJECTION_FAILED");
    assert.equal(cycleReads, 1);
  });

  it("returns a bounded typed error when output measurement fails", () => {
    const response = buildBoundaryEnvelope(
      {
        canonical: "canonical-secret",
        path: "C:\\private\\measurement.json",
      },
      {
        measureProjection: () => {
          throw new Error("measurement exploded at C:\\private\\measurement.json");
        },
      },
    ) as Record<string, unknown>;

    assertSafeBoundaryFailure(response, "MODEL_OUTPUT_MEASUREMENT_FAILED");
  });

  it("types getter failures while constructing measurement stats", () => {
    const measurement: Record<string, unknown> = {
      rawTokens: 1,
      projectedBytes: 1,
      projectedTokens: 1,
    };
    Object.defineProperty(measurement, "rawBytes", {
      enumerable: true,
      get: () => {
        throw new Error("stats getter exploded at C:\\private\\stats.json");
      },
    });

    const response = buildBoundaryEnvelope(
      { status: "success" },
      { measureProjection: () => measurement },
    ) as Record<string, unknown>;

    assertSafeBoundaryFailure(response, "MODEL_OUTPUT_MEASUREMENT_FAILED");
  });

  it("types bounded field counting failures during measurement", () => {
    const canonicalResult: Record<string, unknown> = { status: "success" };
    canonicalResult.self = canonicalResult;

    const response = buildBoundaryEnvelope(canonicalResult, {
      prepareCanonicalValue: () => ({ status: "success" }),
      measureProjection: () => ({
        rawBytes: 1,
        rawTokens: 1,
        projectedBytes: 1,
        projectedTokens: 1,
      }),
    }) as Record<string, unknown>;

    assertSafeBoundaryFailure(response, "MODEL_OUTPUT_MEASUREMENT_FAILED");
  });

  it("returns a bounded typed error when response handling fails", () => {
    const response = buildBoundaryEnvelope(
      {
        canonical: "canonical-secret",
        path: "C:\\private\\handling.json",
      },
      {
        handleProjection: () => {
          throw new Error("handling exploded at C:\\private\\handling.json");
        },
      },
    ) as Record<string, unknown>;

    assertSafeBoundaryFailure(response, "RESPONSE_HANDLING_FAILED");
  });

  it("freezes projection stats and descriptors at construction", () => {
    const projection = projectModelResponse(
      {
        canonicalResult: { status: "success" },
        action: "sdl.info",
        profile: TEST_PROFILE,
        options: TEST_OPTIONS,
        context: { toolName: "sdl.info", requestArgs: {} },
      },
      { projectCompatibilityValue },
    );

    assert.equal(Object.isFrozen(projection), true);
    assert.equal(Object.isFrozen(projection.stats), true);
    const summaryDescriptor = Object.getOwnPropertyDescriptor(projection, "summary");
    assert.equal(summaryDescriptor?.writable, false);
    assert.equal(summaryDescriptor?.configurable, false);
    const rawBytesDescriptor = Object.getOwnPropertyDescriptor(
      projection.stats,
      "rawBytes",
    );
    assert.equal(rawBytesDescriptor?.writable, false);
    assert.equal(rawBytesDescriptor?.configurable, false);
    assert.throws(
      () => Object.defineProperty(projection, "summary", { value: "mutated" }),
      TypeError,
    );
    assert.throws(
      () => Object.defineProperty(projection.stats, "rawBytes", { value: 999 }),
      TypeError,
    );

    const envelope = buildBoundaryEnvelope({ status: "success" });
    const statsDescriptor = Object.getOwnPropertyDescriptor(
      envelope,
      "projectionStats",
    );
    assert.equal(statsDescriptor?.enumerable, false);
    assert.equal(statsDescriptor?.writable, false);
    assert.equal(statsDescriptor?.configurable, false);
    assert.equal(Object.isFrozen(envelope.projectionStats), true);
  });

  it("keeps legacy helper callers compatible while unknown registration fails closed", async () => {
    const legacyEnvelope = buildToolResponseEnvelope(
      {
        status: "success",
        _tokenUsage: { sdlTokens: 1, rawEquivalent: 2 },
      },
      null,
      "",
      "sdl.example",
    );
    assert.deepEqual(legacyEnvelope.structuredContent, { status: "success" });

    const server = new MCPServer();
    assert.throws(
      () => server.registerTool(
        "sdl.example",
        "Unknown profile test",
        z.object({}),
        async () => ({ status: "success" }),
      ),
      /Missing response projection profile: example/,
    );
    const response = await getListToolsHandler(server)(
      { method: "tools/list" },
      {},
    );
    assert.deepEqual(response.tools, []);
  });

  it("does not register or advertise a tool whose projection profile is missing", async () => {
    const server = new MCPServer({
      resolveProjectionProfile: () => undefined,
    });

    assert.throws(
      () => server.registerTool(
        "sdl.info",
        "Profile failure test",
        z.object({}),
        async () => ({ version: "test" }),
      ),
      /Missing response projection profile: info/,
    );

    const response = await getListToolsHandler(server)(
      { method: "tools/list" },
      {},
    );
    assert.deepEqual(response.tools, []);
  });
});

describe("workflow root error summary", () => {
  it("does not report error=0 for a typed root error", () => {
    const canonical = {
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid sdl.workflow request",
      },
    };
    const response = buildToolResponseEnvelope(
      canonical,
      null,
      "",
      "sdl.workflow",
      { steps: [] },
      canonical,
      true,
      Object.freeze({ ...TEST_PROFILE, projector: "workflow" }),
      TEST_OPTIONS,
    );
    const text = response.content.map((block) => block.text ?? "").join("\n");

    assert.equal(response.isError, true);
    assert.match(text, /Invalid sdl\.workflow request|VALIDATION_ERROR/);
    assert.doesNotMatch(text, /error=0/);
  });
});
