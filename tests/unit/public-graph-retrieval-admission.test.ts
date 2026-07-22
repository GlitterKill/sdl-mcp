import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  ACTION_DEFINITIONS,
  FN_NAME_MAP,
  GATEWAY_ACTION_DEFINITIONS,
} from "../../dist/code-mode/action-catalog.js";
import { RetrieveOpSchema } from "../../dist/code-mode/retrieve-schema.js";
import { INTERNAL_TRANSFORMS } from "../../dist/code-mode/transforms.js";
import {
  AGENT_ACTIONS,
  CODE_ACTIONS,
  QUERY_ACTIONS,
  REPO_ACTIONS,
} from "../../dist/gateway/schemas.js";
import { FileGatewayRequestSchema } from "../../dist/mcp/tools/file-gateway.js";
import { buildFlatToolDescriptors } from "../../dist/mcp/tools/tool-descriptors.js";
import { classifyPublicGraphRetrieval } from "../../dist/mcp/public-graph-retrieval-admission.js";

const REPO_ID = "repo-admission-contract";

// [action, workflow fn, flat tool, graph-backed read, gateway-exposed]
const ACTION_AUDIT = [
  ["symbol.search", "symbolSearch", "sdl.symbol.search", true, true],
  ["symbol.getCard", "symbolGetCard", "sdl.symbol.getCard", true, true],
  ["symbol.edit", "symbolEdit", "sdl.symbol.edit", false, true],
  ["slice.build", "sliceBuild", "sdl.slice.build", true, true],
  ["slice.refresh", "sliceRefresh", "sdl.slice.refresh", true, true],
  [
    "slice.spillover.get",
    "sliceSpilloverGet",
    "sdl.slice.spillover.get",
    true,
    true,
  ],
  ["delta.get", "deltaGet", "sdl.delta.get", true, true],
  ["pr.risk.analyze", "prRiskAnalyze", "sdl.pr.risk.analyze", true, true],
  ["code.needWindow", "codeNeedWindow", "sdl.code.needWindow", true, true],
  ["code.getSkeleton", "codeSkeleton", "sdl.code.getSkeleton", true, true],
  ["code.getHotPath", "codeHotPath", "sdl.code.getHotPath", true, true],
  ["repo.register", "repoRegister", "sdl.repo.register", false, true],
  ["repo.status", "repoStatus", "sdl.repo.status", false, true],
  ["repo.unregister", "repoUnregister", "sdl.repo.unregister", false, true],
  ["repo.overview", "repoOverview", "sdl.repo.overview", true, true],
  ["index.refresh", "indexRefresh", "sdl.index.refresh", false, true],
  ["policy.get", "policyGet", "sdl.policy.get", false, true],
  ["policy.set", "policySet", "sdl.policy.set", false, true],
  ["usage.stats", "usageStats", "sdl.usage.stats", false, true],
  ["file.read", "fileRead", "sdl.file.read", false, true],
  ["file.write", "fileWrite", "sdl.file.write", false, false],
  ["search.edit", "searchEdit", "sdl.search.edit", false, true],
  [
    "semantic.enrichment.refresh",
    "semanticEnrichmentRefresh",
    "sdl.semantic.enrichment.refresh",
    false,
    true,
  ],
  [
    "semantic.enrichment.status",
    "semanticEnrichmentStatus",
    "sdl.semantic.enrichment.status",
    false,
    true,
  ],
  ["agent.feedback", "agentFeedback", "sdl.agent.feedback", false, true],
  [
    "agent.feedback.query",
    "agentFeedbackQuery",
    "sdl.agent.feedback.query",
    false,
    true,
  ],
  ["buffer.push", "bufferPush", "sdl.buffer.push", false, true],
  [
    "buffer.checkpoint",
    "bufferCheckpoint",
    "sdl.buffer.checkpoint",
    false,
    true,
  ],
  ["buffer.status", "bufferStatus", "sdl.buffer.status", false, true],
  ["runtime.execute", "runtimeExecute", "sdl.runtime.execute", false, true],
  [
    "runtime.queryOutput",
    "runtimeQueryOutput",
    "sdl.runtime.queryOutput",
    false,
    true,
  ],
  ["response.get", "responseGet", "sdl.response.get", false, true],
  ["memory.store", "memoryStore", "sdl.memory.store", false, true],
  ["memory.query", "memoryQuery", "sdl.memory.query", false, true],
  ["memory.remove", "memoryRemove", "sdl.memory.remove", false, true],
  ["memory.surface", "memorySurface", "sdl.memory.surface", false, true],
] as const;

const REGISTERED_GRAPH_ACTIONS = new Set(
  ACTION_AUDIT.filter((entry) => entry[3]).map((entry) => entry[0]),
);
const CONDITIONAL_GRAPH_ACTIONS = new Set(["slice.refresh"]);
const CENTRAL_GRAPH_ACTIONS = new Set(
  [...REGISTERED_GRAPH_ACTIONS].filter(
    (action) => !CONDITIONAL_GRAPH_ACTIONS.has(action),
  ),
);
const REGISTERED_GRAPH_FLAT_TOOLS = new Set(
  ACTION_AUDIT.filter((entry) => entry[3]).map((entry) => entry[2]),
);
const CONDITIONAL_GRAPH_FLAT_TOOLS = new Set(["sdl.slice.refresh"]);
const CENTRAL_GRAPH_FLAT_TOOLS = new Set(
  [...REGISTERED_GRAPH_FLAT_TOOLS].filter(
    (toolName) => !CONDITIONAL_GRAPH_FLAT_TOOLS.has(toolName),
  ),
);
const EXCLUDED_FLAT_TOOLS = new Set(
  ACTION_AUDIT.filter((entry) => !entry[3]).map((entry) => entry[2]),
);
const EXCLUDED_GATEWAY_ACTIONS = new Set(
  ACTION_AUDIT.filter((entry) => entry[4] && !entry[3]).map(
    (entry) => entry[0],
  ),
);
const EXCLUDED_ACTION_DEFINITION_ACTIONS = new Set(
  ACTION_AUDIT.filter((entry) => !entry[3]).map((entry) => entry[0]),
);
const REGISTERED_GRAPH_WORKFLOW_FNS = new Set(
  ACTION_AUDIT.filter((entry) => entry[3]).map((entry) => entry[1]),
);
const CONDITIONAL_GRAPH_WORKFLOW_FNS = new Set(["sliceRefresh"]);
const CENTRAL_GRAPH_WORKFLOW_FNS = new Set(
  [...REGISTERED_GRAPH_WORKFLOW_FNS].filter(
    (fn) => !CONDITIONAL_GRAPH_WORKFLOW_FNS.has(fn),
  ),
);
const EXCLUDED_WORKFLOW_FNS = new Set(
  ACTION_AUDIT.filter((entry) => !entry[3]).map((entry) => entry[1]),
);

const GATED_FILE_OPS = new Set(["previewWindow", "sourceWindow"]);
const EXCLUDED_FILE_OPS = new Set([
  "read",
  "write",
  "searchEditPreview",
  "searchEditApply",
  "symbolEditPreview",
  "symbolEditApply",
  "symbolEditApplyNow",
]);

const GATED_RETRIEVE_OPS = new Set([
  "symbolSearch",
  "symbolGetCard",
  "sliceBuild",
  "codeSkeleton",
  "codeHotPath",
  "codeNeedWindow",
]);

const EXCLUDED_WORKFLOW_TRANSFORMS = new Set([
  "dataPick",
  "dataMap",
  "dataFilter",
  "dataSort",
  "dataTemplate",
  "workflowContinuationGet",
]);

const TOOL_INVENTORY = JSON.parse(
  readFileSync(resolve("docs/generated/tool-inventory.json"), "utf8"),
) as {
  flatToolNames: string[];
  universalToolNames: string[];
  codeModeToolNames: string[];
  gatewayToolNames: string[];
};

const ALWAYS_GATED_CODE_MODE_TOOLS = new Set(["sdl.context"]);
const CONDITIONAL_CODE_MODE_TOOLS = new Set([
  "sdl.file",
  "sdl.retrieve",
  "sdl.workflow",
]);
const EXCLUDED_CODE_MODE_TOOLS = new Set(["sdl.action.search", "sdl.manual"]);

const gatewayToolByAction = new Map<string, string>([
  ...QUERY_ACTIONS.map((action) => [action, "sdl.query"] as const),
  ...CODE_ACTIONS.map((action) => [action, "sdl.code"] as const),
  ...REPO_ACTIONS.map((action) => [action, "sdl.repo"] as const),
  ...AGENT_ACTIONS.map((action) => [action, "sdl.agent"] as const),
]);

function expected(required: boolean, conditional = false) {
  if (!required) return { mode: "excluded" };
  return conditional
    ? { mode: "conditional" }
    : { mode: "central", repoId: REPO_ID };
}

function assertClosedRegistry(
  actual: readonly string[],
  label: string,
  ...categories: ReadonlySet<string>[]
): void {
  const expectedEntries = categories.flatMap((category) => [...category]);
  assert.equal(
    new Set(actual).size,
    actual.length,
    `${label} contains duplicate live entries`,
  );
  assert.equal(
    new Set(expectedEntries).size,
    expectedEntries.length,
    `${label} contains duplicate audit categories`,
  );
  assert.deepEqual(
    [...actual].sort(),
    expectedEntries.sort(),
    `${label} has an uncategorized or stale entry`,
  );
}

describe("public graph retrieval admission classifier", () => {
  it("keeps every public registry closed to uncategorized additions", () => {
    const liveFlatToolNames = buildFlatToolDescriptors({
      actionAvailability: { memoryTools: true },
    }).map((descriptor) => descriptor.name);
    assertClosedRegistry(
      liveFlatToolNames,
      "live flat tools",
      CENTRAL_GRAPH_FLAT_TOOLS,
      CONDITIONAL_GRAPH_FLAT_TOOLS,
      EXCLUDED_FLAT_TOOLS,
    );
    assertClosedRegistry(
      TOOL_INVENTORY.flatToolNames,
      "flat tools",
      CENTRAL_GRAPH_FLAT_TOOLS,
      CONDITIONAL_GRAPH_FLAT_TOOLS,
      EXCLUDED_FLAT_TOOLS,
    );
    assertClosedRegistry(
      TOOL_INVENTORY.universalToolNames,
      "universal tools",
      new Set(),
      new Set(["sdl.action.search", "sdl.info"]),
    );
    assertClosedRegistry(
      ACTION_DEFINITIONS.filter(
        (definition) => definition.kind === "meta",
      ).flatMap((definition) =>
        definition.toolName ? [definition.toolName] : [],
      ),
      "meta action definitions",
      ALWAYS_GATED_CODE_MODE_TOOLS,
      CONDITIONAL_CODE_MODE_TOOLS,
      EXCLUDED_CODE_MODE_TOOLS,
    );
    assertClosedRegistry(
      TOOL_INVENTORY.codeModeToolNames,
      "code-mode tools",
      ALWAYS_GATED_CODE_MODE_TOOLS,
      CONDITIONAL_CODE_MODE_TOOLS,
      EXCLUDED_CODE_MODE_TOOLS,
    );
    assertClosedRegistry(
      TOOL_INVENTORY.gatewayToolNames,
      "gateway tools",
      new Set(),
      new Set(["sdl.agent", "sdl.code", "sdl.query", "sdl.repo"]),
    );
    assertClosedRegistry(
      [...gatewayToolByAction.keys()],
      "gateway actions",
      CENTRAL_GRAPH_ACTIONS,
      CONDITIONAL_GRAPH_ACTIONS,
      EXCLUDED_GATEWAY_ACTIONS,
    );
    assertClosedRegistry(
      GATEWAY_ACTION_DEFINITIONS.map((definition) => definition.action),
      "action definitions",
      CENTRAL_GRAPH_ACTIONS,
      CONDITIONAL_GRAPH_ACTIONS,
      EXCLUDED_ACTION_DEFINITION_ACTIONS,
    );
    assertClosedRegistry(
      FileGatewayRequestSchema.options.map((schema) => schema.shape.op.value),
      "sdl.file operations",
      GATED_FILE_OPS,
      EXCLUDED_FILE_OPS,
    );
    assertClosedRegistry(
      RetrieveOpSchema.options,
      "sdl.retrieve operations",
      GATED_RETRIEVE_OPS,
      new Set(),
    );
    assertClosedRegistry(
      Object.keys(FN_NAME_MAP),
      "workflow action functions",
      CENTRAL_GRAPH_WORKFLOW_FNS,
      CONDITIONAL_GRAPH_WORKFLOW_FNS,
      EXCLUDED_WORKFLOW_FNS,
    );
    assertClosedRegistry(
      Object.keys(INTERNAL_TRANSFORMS),
      "workflow transforms",
      new Set(),
      EXCLUDED_WORKFLOW_TRANSFORMS,
    );
  });

  it("classifies every registered flat action by exact tool name", () => {
    for (const definition of GATEWAY_ACTION_DEFINITIONS) {
      assert.ok(definition.toolName);
      const required = REGISTERED_GRAPH_ACTIONS.has(definition.action);
      assert.deepEqual(
        classifyPublicGraphRetrieval(definition.toolName, { repoId: REPO_ID }),
        expected(required, definition.action === "slice.refresh"),
        definition.toolName,
      );
    }
  });

  it("classifies every canonical gateway action through its registered gateway", () => {
    for (const [action, toolName] of gatewayToolByAction) {
      const required = REGISTERED_GRAPH_ACTIONS.has(action);
      assert.deepEqual(
        classifyPublicGraphRetrieval(toolName, {
          repoId: REPO_ID,
          action,
        }),
        expected(required, action === "slice.refresh"),
        `${toolName}:${action}`,
      );
    }
  });

  it("classifies every registered public top-level tool", () => {
    for (const toolName of TOOL_INVENTORY.flatToolNames) {
      assert.deepEqual(
        classifyPublicGraphRetrieval(toolName, { repoId: REPO_ID }),
        expected(
          REGISTERED_GRAPH_FLAT_TOOLS.has(toolName),
          CONDITIONAL_GRAPH_FLAT_TOOLS.has(toolName),
        ),
        toolName,
      );
    }
    for (const toolName of TOOL_INVENTORY.universalToolNames) {
      assert.deepEqual(
        classifyPublicGraphRetrieval(toolName, { repoId: REPO_ID }),
        expected(false),
        toolName,
      );
    }

    const codeModeRequests: Record<string, Record<string, unknown>> = {
      "sdl.action.search": { query: "graph" },
      "sdl.context": {
        repoId: REPO_ID,
        taskType: "explain",
        taskText: "graph",
      },
      "sdl.file": { repoId: REPO_ID, op: "read" },
      "sdl.manual": {},
      "sdl.retrieve": {
        repoId: REPO_ID,
        op: "symbolSearch",
        args: {},
      },
      "sdl.workflow": {
        repoId: REPO_ID,
        steps: [{ fn: "actionSearch", args: {} }],
      },
    };
    for (const toolName of TOOL_INVENTORY.codeModeToolNames) {
      assert.ok(codeModeRequests[toolName], `missing request for ${toolName}`);
      const required =
        toolName === "sdl.context" || toolName === "sdl.retrieve";
      assert.deepEqual(
        classifyPublicGraphRetrieval(toolName, codeModeRequests[toolName]),
        expected(required),
        toolName,
      );
    }

    const gatewayRequests: Record<string, Record<string, unknown>> = {
      "sdl.agent": {
        repoId: REPO_ID,
        action: "runtime.execute",
      },
      "sdl.code": {
        repoId: REPO_ID,
        action: "code.getSkeleton",
      },
      "sdl.query": {
        repoId: REPO_ID,
        action: "response.get",
      },
      "sdl.repo": {
        repoId: REPO_ID,
        action: "repo.status",
      },
    };
    for (const toolName of TOOL_INVENTORY.gatewayToolNames) {
      assert.ok(gatewayRequests[toolName], `missing request for ${toolName}`);
      assert.deepEqual(
        classifyPublicGraphRetrieval(toolName, gatewayRequests[toolName]),
        expected(toolName === "sdl.code"),
        toolName,
      );
    }
  });

  it("classifies every sdl.retrieve operation", () => {
    for (const op of RetrieveOpSchema.options) {
      assert.deepEqual(
        classifyPublicGraphRetrieval("sdl.retrieve", {
          repoId: REPO_ID,
          op,
          args: {},
        }),
        expected(true),
        op,
      );
    }
  });

  it("classifies every sdl.file operation", () => {
    for (const schema of FileGatewayRequestSchema.options) {
      const op = schema.shape.op.value;
      assert.deepEqual(
        classifyPublicGraphRetrieval("sdl.file", { repoId: REPO_ID, op }),
        expected(op === "previewWindow" || op === "sourceWindow"),
        op,
      );
    }
  });

  it("classifies every canonical workflow action and function name", () => {
    for (const definition of GATEWAY_ACTION_DEFINITIONS) {
      const required = REGISTERED_GRAPH_ACTIONS.has(definition.action);
      assert.deepEqual(
        classifyPublicGraphRetrieval("sdl.workflow", {
          repoId: REPO_ID,
          steps: [{ fn: definition.action, args: {} }],
        }),
        expected(required, definition.action === "slice.refresh"),
        definition.action,
      );

      assert.ok(definition.fn);
      assert.deepEqual(
        classifyPublicGraphRetrieval("sdl.workflow", {
          repoId: REPO_ID,
          steps: [{ fn: definition.fn, args: {} }],
        }),
        expected(required, definition.action === "slice.refresh"),
        definition.fn,
      );
    }

    for (const fn of Object.keys(INTERNAL_TRANSFORMS)) {
      assert.deepEqual(
        classifyPublicGraphRetrieval("sdl.workflow", {
          repoId: REPO_ID,
          steps: [{ fn, args: {} }],
        }),
        expected(false),
        fn,
      );
    }
    for (const fn of ["actionSearch", "action.search"]) {
      assert.deepEqual(
        classifyPublicGraphRetrieval("sdl.workflow", {
          repoId: REPO_ID,
          steps: [{ fn, args: {} }],
        }),
        expected(false),
        fn,
      );
    }

    assert.deepEqual(
      new Set(Object.values(FN_NAME_MAP)),
      new Set(
        GATEWAY_ACTION_DEFINITIONS.map((definition) => definition.action),
      ),
    );
  });

  it("requires admission when any workflow step reads the code graph", () => {
    assert.deepEqual(
      classifyPublicGraphRetrieval("sdl.workflow", {
        repoId: REPO_ID,
        steps: [
          { fn: "dataPick", args: {} },
          { fn: "repoOverview", args: {} },
        ],
      }),
      expected(true),
    );
  });

  it("excludes every dry-run workflow before inspecting graph step names", () => {
    for (const definition of GATEWAY_ACTION_DEFINITIONS) {
      for (const fn of [definition.action, definition.fn]) {
        assert.ok(fn);
        assert.deepEqual(
          classifyPublicGraphRetrieval("sdl.workflow", {
            repoId: REPO_ID,
            dryRun: true,
            steps: [{ fn, args: {} }],
          }),
          { mode: "excluded" },
          fn,
        );
      }
    }
  });

  it("returns only the explicit top-level repoId for gated calls", () => {
    assert.deepEqual(classifyPublicGraphRetrieval("sdl.context", {}), {
      mode: "central",
      repoId: undefined,
    });
    assert.deepEqual(
      classifyPublicGraphRetrieval("sdl.workflow", {
        steps: [{ fn: "symbolSearch", args: { repoId: "nested" } }],
      }),
      { mode: "central", repoId: undefined },
    );
  });

  it("does not admit exact near misses or unrelated object shapes", () => {
    const cases: Array<[string, unknown]> = [
      ["sdl.symbol.search.extra", { repoId: REPO_ID }],
      ["prefix.sdl.context", { repoId: REPO_ID }],
      ["sdl.query", { repoId: REPO_ID, action: "symbol.search.extra" }],
      ["sdl.retrieve", { repoId: REPO_ID, op: "symbolSearchExtra" }],
      ["sdl.file", { repoId: REPO_ID, op: "previewWindowExtra" }],
      [
        "sdl.workflow",
        {
          repoId: REPO_ID,
          steps: [{ fn: "symbolSearchExtra", args: {} }],
        },
      ],
      ["sdl.context.extra", { repoId: REPO_ID }],
      ["sdl.symbol.getCards", { repoId: REPO_ID }],
      ["sdl.query", { repoId: REPO_ID, action: "symbol.getCards" }],
      [
        "sdl.workflow",
        { repoId: REPO_ID, steps: [{ fn: "symbol.getCards", args: {} }] },
      ],
      [
        "sdl.workflow",
        { repoId: REPO_ID, steps: [{ fn: "symbolGetCards", args: {} }] },
      ],
      ["sdl.context", null],
    ];

    for (const [toolName, args] of cases) {
      const isContextWithMissingArgs = toolName === "sdl.context";
      assert.deepEqual(
        classifyPublicGraphRetrieval(toolName, args),
        isContextWithMissingArgs
          ? { mode: "central", repoId: undefined }
          : { mode: "excluded" },
        toolName,
      );
    }
  });
});
