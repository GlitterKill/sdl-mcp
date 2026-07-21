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
import { classifyPublicGraphRetrieval } from "../../dist/mcp/public-graph-retrieval-admission.js";

const REPO_ID = "repo-admission-contract";

const GRAPH_ACTIONS = new Set([
  "symbol.search",
  "symbol.getCard",
  "symbol.getCards",
  "slice.build",
  "slice.refresh",
  "slice.spillover.get",
  "delta.get",
  "pr.risk.analyze",
  "code.needWindow",
  "code.getSkeleton",
  "code.getHotPath",
  "repo.overview",
]);

const DIRECT_GRAPH_TOOLS = new Set(
  [...GRAPH_ACTIONS].map((action) => `sdl.${action}`),
);

const gatewayToolByAction = new Map<string, string>([
  ...QUERY_ACTIONS.map((action) => [action, "sdl.query"] as const),
  ...CODE_ACTIONS.map((action) => [action, "sdl.code"] as const),
  ...REPO_ACTIONS.map((action) => [action, "sdl.repo"] as const),
  ...AGENT_ACTIONS.map((action) => [action, "sdl.agent"] as const),
]);

function expected(required: boolean) {
  return required ? { required: true, repoId: REPO_ID } : { required: false };
}

describe("public graph retrieval admission classifier", () => {
  it("classifies every registered flat action by exact tool name", () => {
    for (const definition of GATEWAY_ACTION_DEFINITIONS) {
      assert.ok(definition.toolName);
      const required = GRAPH_ACTIONS.has(definition.action);
      assert.deepEqual(
        classifyPublicGraphRetrieval(definition.toolName, { repoId: REPO_ID }),
        expected(required),
        definition.toolName,
      );
    }

    assert.deepEqual(
      classifyPublicGraphRetrieval("sdl.symbol.getCards", {
        repoId: REPO_ID,
      }),
      expected(true),
    );
  });

  it("classifies every canonical gateway action through its registered gateway", () => {
    for (const [action, toolName] of gatewayToolByAction) {
      const required = GRAPH_ACTIONS.has(action);
      assert.deepEqual(
        classifyPublicGraphRetrieval(toolName, {
          repoId: REPO_ID,
          action,
        }),
        expected(required),
        `${toolName}:${action}`,
      );
    }

    assert.deepEqual(
      classifyPublicGraphRetrieval("sdl.query", {
        repoId: REPO_ID,
        action: "symbol.getCards",
      }),
      expected(true),
    );
  });

  it("classifies every registered public top-level tool", () => {
    const inventory = JSON.parse(
      readFileSync(resolve("docs/generated/tool-inventory.json"), "utf8"),
    ) as {
      flatToolNames: string[];
      universalToolNames: string[];
      codeModeToolNames: string[];
      gatewayToolNames: string[];
    };

    for (const toolName of inventory.flatToolNames) {
      assert.deepEqual(
        classifyPublicGraphRetrieval(toolName, { repoId: REPO_ID }),
        expected(DIRECT_GRAPH_TOOLS.has(toolName)),
        toolName,
      );
    }
    for (const toolName of inventory.universalToolNames) {
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
    for (const toolName of inventory.codeModeToolNames) {
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
    for (const toolName of inventory.gatewayToolNames) {
      assert.ok(gatewayRequests[toolName], `missing request for ${toolName}`);
      assert.deepEqual(
        classifyPublicGraphRetrieval(toolName, gatewayRequests[toolName]),
        expected(toolName === "sdl.code"),
        toolName,
      );
    }

    const registeredDefinitionTools = ACTION_DEFINITIONS.flatMap(
      (definition) => (definition.toolName ? [definition.toolName] : []),
    );
    assert.deepEqual(
      new Set(inventory.codeModeToolNames),
      new Set(
        registeredDefinitionTools.filter((toolName) =>
          inventory.codeModeToolNames.includes(toolName),
        ),
      ),
    );
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
      const required = GRAPH_ACTIONS.has(definition.action);
      assert.deepEqual(
        classifyPublicGraphRetrieval("sdl.workflow", {
          repoId: REPO_ID,
          steps: [{ fn: definition.action, args: {} }],
        }),
        expected(required),
        definition.action,
      );

      assert.ok(definition.fn);
      assert.deepEqual(
        classifyPublicGraphRetrieval("sdl.workflow", {
          repoId: REPO_ID,
          steps: [{ fn: definition.fn, args: {} }],
        }),
        expected(required),
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

    for (const fn of ["symbolGetCards", "symbol.getCards"]) {
      assert.deepEqual(
        classifyPublicGraphRetrieval("sdl.workflow", {
          repoId: REPO_ID,
          steps: [{ fn, args: {} }],
        }),
        expected(true),
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

  it("returns only the explicit top-level repoId for gated calls", () => {
    assert.deepEqual(classifyPublicGraphRetrieval("sdl.context", {}), {
      required: true,
      repoId: undefined,
    });
    assert.deepEqual(
      classifyPublicGraphRetrieval("sdl.workflow", {
        steps: [{ fn: "symbolSearch", args: { repoId: "nested" } }],
      }),
      { required: true, repoId: undefined },
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
      ["sdl.context", null],
    ];

    for (const [toolName, args] of cases) {
      const isContextWithMissingArgs = toolName === "sdl.context";
      assert.deepEqual(
        classifyPublicGraphRetrieval(toolName, args),
        isContextWithMissingArgs
          ? { required: true, repoId: undefined }
          : { required: false },
        toolName,
      );
    }
  });
});
