import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { z } from "zod";

import { handleRetrieve } from "../../dist/code-mode/retrieve.js";
import { executeWorkflow } from "../../dist/code-mode/workflow-executor.js";
import type { ParsedWorkflowRequest } from "../../dist/code-mode/workflow-parser.js";
import type { CodeModeConfig } from "../../dist/config/types.js";
import {
  routeGatewayCall,
  type ActionMap,
} from "../../dist/gateway/router.js";
import { parseActionHandlerArgs } from "../../dist/gateway/dispatch-spine.js";

const testConfig: CodeModeConfig = {
  enabled: true,
  exclusive: false,
  maxWorkflowSteps: 5,
  maxWorkflowTokens: 5_000,
  maxWorkflowDurationMs: 10_000,
  ladderValidation: "off",
  etagCaching: false,
};

describe("Dispatch Spine surface parity", () => {
  it("routes codeSkeleton filePath aliases identically through retrieve and workflow", async () => {
    const received: unknown[] = [];
    const actionMap: ActionMap = {
      "code.getSkeleton": {
        schema: z.object({ repoId: z.string(), file: z.string() }),
        handler: async (args) => {
          received.push(args);
          return { ok: true };
        },
      },
    };

    await handleRetrieve(
      {
        repoId: "repo",
        op: "codeSkeleton",
        args: { filePath: "src/util/paths.ts" },
      },
      actionMap,
    );

    const workflow: ParsedWorkflowRequest = {
      repoId: "repo",
      steps: [
        {
          fn: "codeGetSkeleton",
          action: "code.getSkeleton",
          args: { filePath: "src/util/paths.ts" },
          internal: false,
        },
      ],
      onError: "stop",
    };
    const workflowResult = await executeWorkflow(
      workflow,
      actionMap,
      testConfig,
    );

    assert.equal(workflowResult.results[0]?.status, "ok");
    assert.deepEqual(received, [
      { repoId: "repo", file: "src/util/paths.ts" },
      { repoId: "repo", file: "src/util/paths.ts" },
    ]);
  });

  it("parses each dispatched action exactly once across gateway, retrieve, and workflow", async () => {
    let parseCount = 0;
    const schema = z
      .object({ repoId: z.string(), file: z.string() })
      .superRefine(() => {
        parseCount += 1;
      });
    const actionMap: ActionMap = {
      "code.getSkeleton": {
        schema,
        handler: async (args) => parseActionHandlerArgs(schema, args),
      },
    };

    await routeGatewayCall(
      {
        repoId: "repo",
        action: "code.getSkeleton",
        filePath: "src/util/paths.ts",
      },
      actionMap,
    );
    assert.equal(parseCount, 1);

    await handleRetrieve(
      {
        repoId: "repo",
        op: "codeSkeleton",
        args: { filePath: "src/util/paths.ts" },
      },
      actionMap,
    );
    assert.equal(parseCount, 2);

    const workflow: ParsedWorkflowRequest = {
      repoId: "repo",
      steps: [
        {
          fn: "codeGetSkeleton",
          action: "code.getSkeleton",
          args: { filePath: "src/util/paths.ts" },
          internal: false,
        },
      ],
      onError: "stop",
    };
    const result = await executeWorkflow(workflow, actionMap, testConfig);
    assert.equal(result.results[0]?.status, "ok");
    assert.equal(parseCount, 3);
  });

  it("scopes parsed markers to the schema that validated the object", () => {
    const stringSchema = z.object({ value: z.string() });
    const numberSchema = z.object({ value: z.number() });
    const parsed = parseActionHandlerArgs(stringSchema, { value: "one" });

    assert.throws(() => parseActionHandlerArgs(numberSchema, parsed));
  });
});
