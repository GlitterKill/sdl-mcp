import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isDeepStrictEqual } from "node:util";

import { z, type ZodType } from "zod";

import { auditOutputContractObligations } from "../../scripts/generate-tool-inventory.ts";

import {
  ACTION_DEFINITION_BY_ACTION,
  INTERNAL_TRANSFORM_OUTPUT_SCHEMA_BY_ACTION,
  buildCatalog,
} from "../../dist/code-mode/action-catalog.js";
import { getActiveFnNameMap } from "../../dist/code-mode/manual-generator.js";
import { projectToolResultForModelContent } from "../../dist/mcp/context-response-projection.js";
import { OUTPUT_BUDGET_TOKEN_LIMITS } from "../../dist/mcp/response-projection/budgets.js";
import { buildValidatedRecoveryAction } from "../../dist/mcp/response-projection/recovery.js";
import {
  PROJECTION_PROFILE_ACTIONS,
  PROJECTION_PROFILE_REGISTRY,
  WORKFLOW_CHILD_ACTION_BINDINGS,
  assertProjectionProfileInventory,
  assertWorkflowProjectionBindings,
} from "../../dist/mcp/response-projection/registry.js";
import {
  DeltaGetResponseSchema,
  ResponseGetResponseSchema,
  withProjectionSuccessOutputSchema,
} from "../../dist/mcp/tools.js";
import { registerTools } from "../../dist/mcp/tools/index.js";
import {
  AGENT_OUTPUT_CASES,
  AGENT_OUTPUT_TOKEN_BUDGETS,
  DEFERRED_FAMILY_ASSERTIONS,
} from "../fixtures/response-projection/agent-output-cases.ts";

const MUTATING_ACTIONS = new Set([
  "symbol.edit",
  "repo.register",
  "repo.unregister",
  "index.refresh",
  "policy.set",
  "file.write",
  "search.edit",
  "semantic.enrichment.refresh",
  "agent.feedback",
  "buffer.push",
  "buffer.checkpoint",
  "runtime.execute",
  "memory.store",
  "memory.remove",
  "memory.surface",
  "file",
  "workflow",
]);

interface PublicToolRegistration {
  readonly name: string;
  readonly outputSchema: ZodType | undefined;
  readonly validationOutputSchema: ZodType | undefined;
}

function capturePublicToolRegistrations(
  codeModeConfig?: Parameters<typeof registerTools>[3],
): readonly PublicToolRegistration[] {
  const registrations: PublicToolRegistration[] = [];
  const server = {
    gatewayMode: false,
    registerPostDispatchHook(): void {},
    registerTool(
      name: string,
      _description: string,
      _inputSchema: ZodType,
      _handler: (args: unknown) => unknown,
      _wireSchema?: Record<string, unknown>,
      _presentation?: { title?: string },
      outputSchema?: ZodType,
      validationOutputSchema?: ZodType,
    ): void {
      registrations.push({ name, outputSchema, validationOutputSchema });
    },
  } as unknown as Parameters<typeof registerTools>[0];

  registerTools(
    server,
    { actionAvailability: { memoryTools: true, infoTool: true } },
    undefined,
    codeModeConfig,
  );
  return registrations;
}

function exhaustiveOutputSchema(
  registration: PublicToolRegistration,
): ZodType | undefined {
  return registration.validationOutputSchema ?? registration.outputSchema;
}

function capturePublicFlatToolNames(): readonly string[] {
  return capturePublicToolRegistrations().map(({ name }) => name);
}

function canonicalFlatAction(toolName: string): string {
  assert.match(toolName, /^sdl\./);
  return toolName.slice("sdl.".length);
}

function compactKeyRecord(
  action: string,
  resultKind: "record" | "array" | "scalar" | undefined,
  projected: unknown,
): Record<string, unknown> {
  if (resultKind === "scalar") {
    assert.notEqual(projected, undefined, action);
    assert.notEqual(projected, null, action);
    assert.notEqual(typeof projected, "object", action);
    return {};
  }
  const candidate =
    resultKind === "array"
      ? (assert.ok(Array.isArray(projected) && projected.length > 0, action),
        projected[0])
      : projected;
  assert.ok(candidate && typeof candidate === "object", action);
  assert.equal(Array.isArray(candidate), false, action);
  return candidate as Record<string, unknown>;
}

type ObjectPath = readonly (string | number)[];

function collectObjectPaths(
  value: unknown,
  path: ObjectPath = [],
): readonly ObjectPath[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      collectObjectPaths(item, [...path, index]),
    );
  }
  if (value === null || typeof value !== "object") {
    return [];
  }
  const record = value as Record<string, unknown>;
  return [
    path,
    ...Object.entries(record).flatMap(([key, child]) =>
      collectObjectPaths(child, [...path, key]),
    ),
  ];
}

function injectObjectSentinel(value: unknown, path: ObjectPath): unknown {
  if (path.length === 0) {
    assert.ok(value !== null && typeof value === "object");
    assert.equal(Array.isArray(value), false);
    return { ...(value as Record<string, unknown>), __privateSentinel: true };
  }
  const [head, ...tail] = path;
  if (Array.isArray(value)) {
    assert.equal(typeof head, "number");
    return value.map((item, index) =>
      index === head ? injectObjectSentinel(item, tail) : item,
    );
  }
  assert.ok(value !== null && typeof value === "object");
  assert.equal(typeof head, "string");
  const record = value as Record<string, unknown>;
  return { ...record, [head]: injectObjectSentinel(record[head], tail) };
}

function outputSchemaStats(schema: ZodType): {
  readonly arbitraryRecordNodes: number;
  readonly genericErrorArms: number;
  readonly nodes: number;
} {
  let arbitraryRecordNodes = 0;
  let genericErrorArms = 0;
  let nodes = 0;
  const visit = (current: ZodType): void => {
    nodes++;
    if (current instanceof z.ZodObject) {
      if (Object.keys(current.shape).sort().join(",") === "error,nextAction") {
        genericErrorArms++;
      }
      for (const child of Object.values(current.shape)) visit(child);
      return;
    }
    if (
      current instanceof z.ZodUnion
      || current instanceof z.ZodDiscriminatedUnion
    ) {
      for (const child of current.options) visit(child as ZodType);
      return;
    }
    if (current instanceof z.ZodArray) {
      visit(current.element);
      return;
    }
    if (
      current instanceof z.ZodOptional
      || current instanceof z.ZodNullable
      || current instanceof z.ZodDefault
    ) {
      visit(current.unwrap());
      return;
    }
    if (current instanceof z.ZodRecord) {
      arbitraryRecordNodes++;
      visit(current.def.keyType as ZodType);
      visit(current.def.valueType as ZodType);
      return;
    }
    if (current instanceof z.ZodPipe) {
      visit(current.def.in as ZodType);
      visit(current.def.out as ZodType);
      return;
    }
    if (current instanceof z.ZodTuple) {
      for (const child of current.def.items) visit(child as ZodType);
      if (current.def.rest) visit(current.def.rest as ZodType);
    }
  };
  visit(schema);
  return { arbitraryRecordNodes, genericErrorArms, nodes };
}

function derivePublicActions(): readonly string[] {
  const flatActions = capturePublicFlatToolNames().map(canonicalFlatAction);
  const codeModeActions = buildCatalog({
    memoryVisible: true,
    infoVisible: true,
  }).map((entry) => entry.action);
  const workflowActions = Object.values(getActiveFnNameMap(true));
  return [
    ...new Set([...flatActions, ...codeModeActions, ...workflowActions]),
  ].sort();
}

describe("response projection inventory", () => {
  it("has exactly one complete profile for every advertised canonical action", () => {
    const publicActions = derivePublicActions();
    const advertisedActions = [
      ...publicActions,
      "query",
      "code",
      "repo",
      "agent",
    ].sort();
    const profileActions = Object.keys(PROJECTION_PROFILE_REGISTRY).sort();

    assert.doesNotThrow(() =>
      assertProjectionProfileInventory(advertisedActions),
    );
    assert.deepEqual(profileActions, advertisedActions);
    assert.deepEqual([...PROJECTION_PROFILE_ACTIONS].sort(), advertisedActions);

    for (const action of advertisedActions) {
      assert.deepEqual(
        Object.keys(
          PROJECTION_PROFILE_REGISTRY[
            action as keyof typeof PROJECTION_PROFILE_REGISTRY
          ],
        ).sort(),
        [
          "budgetClass",
          "defaultDetail",
          "largeResponseStrategy",
          "observabilityProfile",
          "projector",
          "recoveryPolicy",
        ],
        action,
      );
    }
  });

  it("lists every active workflow child exactly once", () => {
    const activeFnNameMap = getActiveFnNameMap(true);

    assert.doesNotThrow(() =>
      assertWorkflowProjectionBindings(activeFnNameMap),
    );
    assert.deepEqual(WORKFLOW_CHILD_ACTION_BINDINGS, activeFnNameMap);
  });

  it("wraps file, retrieve, and workflow in one bounded generic-error arm", () => {
    const registrations = capturePublicToolRegistrations({
      enabled: true,
      exclusive: true,
    });
    const nodeBudgets = new Map([
      ["sdl.file", 1_000],
      ["sdl.retrieve", 1_500],
      // Successful-truncation recovery duplicates the strict callable-action schema across bound result arms (5,313 nodes).
      ["sdl.workflow", 5_400],
    ]);

    for (const [name, maxNodes] of nodeBudgets) {
      const registration = registrations.find((entry) => entry.name === name);
      assert.ok(registration, name);
      const schema = exhaustiveOutputSchema(registration);
      assert.ok(schema, name);
      const stats = outputSchemaStats(schema);
      assert.equal(stats.genericErrorArms, 1, `${name}: ${JSON.stringify(stats)}`);
      assert.ok(
        stats.nodes <= maxNodes,
        `${name}: ${JSON.stringify(stats)} exceeds ${maxNodes}`,
      );
    }
  });

  it("rejects sensitive fields inside action-search and manual entries", () => {
    const registrations = capturePublicToolRegistrations({
      enabled: true,
      exclusive: true,
    });
    const entry = {
      action: "symbol.search",
      fn: "symbolSearch",
      description: "Search symbols.",
      tags: ["query"],
      kind: "gateway",
      prerequisites: [],
      recommendedNextActions: [],
      fallbacks: [],
      requiredParams: ["query"],
      schemaSummary: {
        fields: [{ name: "query", type: "string", required: true }],
      },
      example: { query: "UserRepository" },
    };
    const fixtures = new Map<string, Record<string, unknown>>([
      [
        "sdl.action.search",
        {
          actions: [entry],
          total: 1,
          hasMore: false,
          tokenEstimate: 10,
          offset: 0,
          limit: 1,
        },
      ],
      ["sdl.manual", { actions: [entry], tokenEstimate: 10 }],
    ]);

    for (const [name, valid] of fixtures) {
      const schema = registrations.find(
        (registration) => registration.name === name,
      )?.outputSchema;
      assert.ok(schema, name);
      assert.deepEqual(schema.parse(valid), valid, name);
      for (const field of [
        "sessionId",
        "absolutePath",
        "timestamp",
        "privateField",
      ]) {
        const invalid = {
          ...valid,
          actions: [{ ...entry, [field]: "private" }],
        };
        assert.equal(
          schema.safeParse(invalid).success,
          false,
          `${name} accepted actions[0].${field}`,
        );
        const invalidNested = {
          ...valid,
          actions: [
            { ...entry, example: { ...entry.example, [field]: "private" } },
          ],
        };
        assert.equal(
          schema.safeParse(invalidNested).success,
          false,
          `${name} accepted actions[0].example.${field}`,
        );
      }
    }
  });

  it("validates workflow success results against the bound child action schema", () => {
    const workflowRegistration = capturePublicToolRegistrations({
      enabled: true,
      exclusive: true,
    }).find(({ name }) => name === "sdl.workflow");
    assert.ok(workflowRegistration);
    const workflowOutputSchema = exhaustiveOutputSchema(workflowRegistration);
    assert.ok(workflowOutputSchema);

    const symbolSearch = AGENT_OUTPUT_CASES.find(
      ({ action }) => action === "symbol.search",
    );
    const repoStatus = AGENT_OUTPUT_CASES.find(
      ({ action }) => action === "repo.status",
    );
    assert.ok(symbolSearch);
    assert.ok(repoStatus);

    for (const detail of ["compact", "full"] as const) {
      const request = {
        ...symbolSearch.publicRequest,
        detail,
        includeDiagnostics: false,
      };
      const symbolResult = projectToolResultForModelContent(
        symbolSearch.action,
        symbolSearch.canonicalResultFactory(),
        request,
      );
      const repoResult = projectToolResultForModelContent(
        repoStatus.action,
        repoStatus.canonicalResultFactory(),
        { ...repoStatus.publicRequest, detail, includeDiagnostics: false },
      );
      const valid = {
        results: [
          {
            fn: "symbolSearch",
            ...(detail === "full" ? { stepIndex: 0, status: "ok" as const } : {}),
            result: symbolResult,
          },
        ],
      };
      assert.deepEqual(
        workflowOutputSchema.parse(valid),
        valid,
        `symbolSearch/${detail}`,
      );

      const mismatched = {
        ...valid,
        results: [{ ...valid.results[0], result: repoResult }],
      };
      assert.equal(
        workflowOutputSchema.safeParse(mismatched).success,
        false,
        `symbolSearch/${detail}: accepted repo.status result`,
      );
    }
  });

  it("rejects arbitrary response content schemas and incoherent continuations", () => {
    const registrations = capturePublicToolRegistrations();
    const responseRegistration = registrations.find(
      ({ name }) => name === "sdl.response.get",
    );
    const workflowRegistration = capturePublicToolRegistrations({
      enabled: true,
      exclusive: true,
    }).find(({ name }) => name === "sdl.workflow");
    assert.ok(responseRegistration);
    assert.ok(workflowRegistration);
    const responseSchema = exhaustiveOutputSchema(responseRegistration);
    const workflowSchema = exhaustiveOutputSchema(workflowRegistration);
    assert.ok(responseSchema);
    assert.ok(workflowSchema);

    const failures: string[] = [];
    const responseSuccessSchema = withProjectionSuccessOutputSchema(
      "response.get",
      ResponseGetResponseSchema,
    );
    if (outputSchemaStats(responseSuccessSchema).arbitraryRecordNodes !== 0) {
      failures.push("response.get added an arbitrary-record success schema node");
    }

    const fixture = AGENT_OUTPUT_CASES.find(
      ({ action }) => action === "response.get",
    );
    assert.ok(fixture);
    const projected = projectToolResultForModelContent(
      fixture.action,
      fixture.canonicalResultFactory(),
      { ...fixture.publicRequest, detail: "compact", includeDiagnostics: false },
    ) as {
      handle: string;
      full: false;
      complete: false;
      truncated: true;
      range: { offsetBytes: number; returnedBytes: number };
      pagination: {
        offset: number;
        limit: number;
        total: number;
        returned: number;
        hasMore: boolean;
        nextOffset?: number;
      };
      nextAction: {
        action: "response.get";
        args: {
          handle: string;
          cursor: { offsetBytes: number };
          full: boolean;
          raw: boolean;
          offset?: number;
          limit?: number;
        };
      };
    };
    assert.deepEqual(responseSchema.parse(projected), projected);

    const sharedChild = { value: "shared" };
    const sharedAlias = {
      ...projected,
      content: { left: sharedChild, right: sharedChild },
    };
    assert.deepEqual(responseSchema.parse(sharedAlias), sharedAlias);
    assert.deepEqual(
      workflowSchema.parse({
        results: [{ fn: "responseGet", result: sharedAlias }],
      }),
      { results: [{ fn: "responseGet", result: sharedAlias }] },
    );

    const selfCycle: Record<string, unknown> = {};
    selfCycle.self = selfCycle;
    const mutualCycleA: Record<string, unknown> = {};
    const mutualCycleB: Record<string, unknown> = {};
    mutualCycleA.other = mutualCycleB;
    mutualCycleB.other = mutualCycleA;
    for (const cyclicContent of [selfCycle, mutualCycleA]) {
      const cyclic = { ...projected, content: cyclicContent };
      assert.equal(responseSchema.safeParse(cyclic).success, false);
      assert.equal(
        workflowSchema.safeParse({
          results: [{ fn: "responseGet", result: cyclic }],
        }).success,
        false,
      );
    }

    const {
      truncated: _truncated,
      nextAction: _nextAction,
      pagination: projectedPagination,
      ...completeBase
    } = projected;
    const {
      nextOffset: _nextOffset,
      ...terminalPagination
    } = projectedPagination;
    const terminalComplete = {
      ...completeBase,
      complete: true as const,
      pagination: {
        ...terminalPagination,
        offset: 1,
        returned: 1,
        hasMore: false,
      },
    };
    assert.deepEqual(responseSchema.parse(terminalComplete), terminalComplete);

    const {
      range: _missingRange,
      pagination: _missingPagination,
      ...completeWithoutRange
    } = terminalComplete;
    const malformedComplete = [
      completeWithoutRange,
      {
        ...terminalComplete,
        pagination: {
          ...terminalComplete.pagination,
          hasMore: true,
        },
      },
      {
        ...terminalComplete,
        pagination: {
          ...terminalComplete.pagination,
          nextOffset: 2,
        },
      },
    ];
    for (const [index, invalid] of malformedComplete.entries()) {
      if (responseSchema.safeParse(invalid).success) {
        failures.push(`response.get accepted malformed complete result ${index}`);
      }
      if (
        workflowSchema.safeParse({
          results: [{ fn: "responseGet", result: invalid }],
        }).success
      ) {
        failures.push(`workflow accepted malformed complete responseGet child ${index}`);
      }
    }

    const malformed = [
      {
        ...projected,
        nextAction: {
          ...projected.nextAction,
          args: { ...projected.nextAction.args, handle: "response-other" },
        },
      },
      {
        ...projected,
        nextAction: {
          ...projected.nextAction,
          args: { ...projected.nextAction.args, full: true },
        },
      },
      {
        ...projected,
        nextAction: {
          ...projected.nextAction,
          args: { ...projected.nextAction.args, raw: true },
        },
      },
      {
        ...projected,
        nextAction: {
          ...projected.nextAction,
          args: { ...projected.nextAction.args, offsetBytes: 1 },
        },
      },
      {
        ...projected,
        nextAction: {
          ...projected.nextAction,
          args: {
            ...projected.nextAction.args,
            cursor: { offsetBytes: 1 },
          },
        },
      },
      {
        ...projected,
        pagination: { ...projected.pagination, hasMore: false },
      },
      {
        ...projected,
        pagination: { ...projected.pagination, nextOffset: 2 },
      },
    ];

    for (const [index, invalid] of malformed.entries()) {
      if (responseSchema.safeParse(invalid).success) {
        failures.push(`response.get accepted malformed continuation ${index}`);
      }
      if (
        workflowSchema.safeParse({
          results: [{ fn: "responseGet", result: invalid }],
        }).success
      ) {
        failures.push(`workflow accepted malformed responseGet child ${index}`);
      }
    }

    const nonPaged = {
      ...projected,
      pagination: undefined,
      nextAction: {
        ...projected.nextAction,
        args: {
          ...projected.nextAction.args,
          cursor: {
            offsetBytes:
              projected.range.offsetBytes + projected.range.returnedBytes - 1,
          },
          offset: undefined,
          limit: undefined,
        },
      },
    };
    if (responseSchema.safeParse(nonPaged).success) {
      failures.push("response.get accepted a mismatched byte cursor");
    }
    assert.deepEqual(failures, []);
  });

  it("accepts every fixture request through the active public schema", () => {
    const failures: string[] = [];
    for (const fixture of AGENT_OUTPUT_CASES) {
      const definition = ACTION_DEFINITION_BY_ACTION[fixture.action];
      if (!definition) {
        failures.push(`${fixture.action}: missing action definition`);
        continue;
      }
      const parsed = definition.schema.safeParse(fixture.publicRequest);
      if (!parsed.success) {
        failures.push(
          `${fixture.action}: ${JSON.stringify(parsed.error.issues)}`,
        );
      }
    }
    assert.deepEqual(failures, []);
  });

  it("accepts the canonical full delta through its deduplicated public schema", () => {
    const fixture = AGENT_OUTPUT_CASES.find(({ action }) => action === "delta.get");
    assert.ok(fixture);
    const projected = projectToolResultForModelContent(
      fixture.action,
      fixture.canonicalResultFactory(),
      { ...fixture.publicRequest, detail: "full", includeDiagnostics: false },
    );
    const schema = withProjectionSuccessOutputSchema(
      "delta.get",
      DeltaGetResponseSchema,
    );
    assert.deepEqual(schema.parse(projected), projected);
  });

  it("accepts every projected compact/full fixture without stripping fields", () => {
    const flatRegistrations = capturePublicToolRegistrations();
    const codeModeRegistrations = capturePublicToolRegistrations({
      enabled: true,
      exclusive: true,
    });
    const outputSchemaByAction = new Map<string, ZodType>(
      Object.entries(INTERNAL_TRANSFORM_OUTPUT_SCHEMA_BY_ACTION),
    );
    const failures: string[] = [];

    assert.deepEqual(
      flatRegistrations.slice(0, 2).map(({ name }) => name),
      ["sdl.action.search", "sdl.info"],
    );
    assert.equal(
      new Set(flatRegistrations.map(({ name }) => name)).size,
      flatRegistrations.length,
    );
    for (const registration of [
      ...flatRegistrations,
      ...codeModeRegistrations,
    ]) {
      const action = canonicalFlatAction(registration.name);
      const schema = exhaustiveOutputSchema(registration);
      if (!schema) {
        failures.push(`${action}: missing output schema`);
        continue;
      }
      outputSchemaByAction.set(action, schema);
    }

    assert.deepEqual(
      [...outputSchemaByAction.keys()].sort(),
      AGENT_OUTPUT_CASES.map(({ action }) => action).sort(),
    );
    for (const fixture of AGENT_OUTPUT_CASES) {
      const outputSchema = outputSchemaByAction.get(fixture.action);
      if (!outputSchema) {
        failures.push(`${fixture.action}: missing output schema`);
        continue;
      }
      for (const detail of ["compact", "full"] as const) {
        const projected = projectToolResultForModelContent(
          fixture.action,
          fixture.canonicalResultFactory(),
          { ...fixture.publicRequest, detail, includeDiagnostics: false },
        );
        const parsed = outputSchema.safeParse(projected);
        if (!parsed.success) {
          failures.push(
            `${fixture.action}/${detail}: rejected ${JSON.stringify(parsed.error.issues)}`,
          );
        } else if (!isDeepStrictEqual(parsed.data, projected)) {
          failures.push(`${fixture.action}/${detail}: stripped public fields`);
        }
      }
    }
    assert.deepEqual(failures, []);
  });

  it("rejects private success fields for every closed public action schema", () => {
    const registrations = [
      ...capturePublicToolRegistrations(),
      ...capturePublicToolRegistrations({ enabled: true, exclusive: true }),
    ];
    const outputSchemaByAction = new Map<string, ZodType>(
      Object.entries(INTERNAL_TRANSFORM_OUTPUT_SCHEMA_BY_ACTION),
    );
    for (const registration of registrations) {
      const schema = exhaustiveOutputSchema(registration);
      if (schema) {
        outputSchemaByAction.set(canonicalFlatAction(registration.name), schema);
      }
    }
    const strippedActions = new Set<string>();
    const retainedActions = new Set<string>();
    const dataPickFailures: string[] = [];

    for (const fixture of AGENT_OUTPUT_CASES) {
      const outputSchema = outputSchemaByAction.get(fixture.action);
      assert.ok(outputSchema, `${fixture.action}: missing output schema`);
      for (const detail of ["compact", "full"] as const) {
        const projected = projectToolResultForModelContent(
          fixture.action,
          fixture.canonicalResultFactory(),
          { ...fixture.publicRequest, detail, includeDiagnostics: false },
        );
        const withSentinel =
          projected !== null && typeof projected === "object"
            ? Array.isArray(projected)
              ? Object.assign([...projected], { __privateSentinel: true })
              : { ...projected, __privateSentinel: true }
            : { value: projected, __privateSentinel: true };
        const parsed = outputSchema.safeParse(withSentinel);

        // dataPick intentionally transforms arbitrary records and is the sole
        // public exception: its caller-owned keys must survive byte-for-byte.
        if (fixture.action === "dataPick") {
          if (!parsed.success || !isDeepStrictEqual(parsed.data, withSentinel)) {
            dataPickFailures.push(`${fixture.action}/${detail}`);
          }
        } else if (parsed.success) {
          if (isDeepStrictEqual(parsed.data, withSentinel)) {
            retainedActions.add(fixture.action);
          } else {
            strippedActions.add(fixture.action);
          }
        }
      }
    }

    assert.deepEqual(
      {
        stripped: [...strippedActions].sort(),
        retained: [...retainedActions].sort(),
        dataPickFailures,
      },
      { stripped: [], retained: [], dataPickFailures: [] },
    );
  });

  it("rejects private fields at every projected success record path", () => {
    const registrations = [
      ...capturePublicToolRegistrations(),
      ...capturePublicToolRegistrations({ enabled: true, exclusive: true }),
    ];
    const outputSchemaByAction = new Map<string, ZodType>(
      Object.entries(INTERNAL_TRANSFORM_OUTPUT_SCHEMA_BY_ACTION),
    );
    for (const registration of registrations) {
      const schema = exhaustiveOutputSchema(registration);
      if (schema) {
        outputSchemaByAction.set(canonicalFlatAction(registration.name), schema);
      }
    }
    const failures: string[] = [];

    for (const fixture of AGENT_OUTPUT_CASES) {
      const outputSchema = outputSchemaByAction.get(fixture.action);
      assert.ok(outputSchema, `${fixture.action}: missing output schema`);
      for (const detail of ["compact", "full"] as const) {
        const projected = projectToolResultForModelContent(
          fixture.action,
          fixture.canonicalResultFactory(),
          { ...fixture.publicRequest, detail, includeDiagnostics: false },
        );
        for (const path of collectObjectPaths(projected)) {
          const withSentinel = injectObjectSentinel(projected, path);
          const parsed = outputSchema.safeParse(withSentinel);
          const label = `${fixture.action}/${detail}/${JSON.stringify(path)}`;
          if (fixture.action === "dataPick") {
            if (!parsed.success || !isDeepStrictEqual(parsed.data, withSentinel)) {
              failures.push(`${label}: dataPick did not preserve arbitrary record`);
            }
          } else if (parsed.success) {
            failures.push(`${label}: accepted private record field`);
          }
        }
      }
    }

    assert.deepEqual(failures, []);
  });

  it("rejects private fields on projected workflow step envelopes", () => {
    const workflowRegistration = capturePublicToolRegistrations({
      enabled: true,
      exclusive: true,
    }).find(({ name }) => name === "sdl.workflow");
    assert.ok(workflowRegistration);
    const workflowOutputSchema = exhaustiveOutputSchema(workflowRegistration);
    assert.ok(workflowOutputSchema);
    const fixture = AGENT_OUTPUT_CASES.find(
      ({ action }) => action === "workflow",
    );
    assert.ok(fixture);

    for (const detail of ["compact", "full"] as const) {
      const projected = projectToolResultForModelContent(
        fixture.action,
        fixture.canonicalResultFactory(),
        { ...fixture.publicRequest, detail, includeDiagnostics: false },
      ) as { results: Array<Record<string, unknown>> };
      const withNestedSentinel = {
        ...projected,
        results: projected.results.map((step, index) =>
          index === 0 ? { ...step, __privateSentinel: true } : step,
        ),
      };

      assert.equal(
        workflowOutputSchema.safeParse(withNestedSentinel).success,
        false,
        detail,
      );
    }
  });

  it("accepts the projected generic error contract without stripping fields", () => {
    const registrations = [
      ...capturePublicToolRegistrations(),
      ...capturePublicToolRegistrations({ enabled: true, exclusive: true }),
    ];
    const outputSchemaByAction = new Map<string, ZodType>(
      Object.entries(INTERNAL_TRANSFORM_OUTPUT_SCHEMA_BY_ACTION),
    );
    for (const registration of registrations) {
      const schema = exhaustiveOutputSchema(registration);
      if (schema) {
        outputSchemaByAction.set(canonicalFlatAction(registration.name), schema);
      }
    }
    const canonicalError = {
      error: {
        message: "fixture validation failed",
        code: "VALIDATION_ERROR",
        details: [{ path: "repoId", message: "Required" }],
        classification: "invalid_input",
        retryable: false,
        fallbackTools: ["sdl.action.search"],
        fallbackRationale: "Inspect the action schema and retry.",
      },
    };
    const validatedRecovery = buildValidatedRecoveryAction(
      { action: "symbol.search", args: { query: "projection fixture" } },
      {
        repoId: "projection-fixture",
        advertisedTools: ["sdl.symbol.search"],
        activeWorkflowFunctions: Object.keys(getActiveFnNameMap()),
      },
    ).nextAction;
    assert.ok(validatedRecovery, "generic error fixture recovery must be valid");
    const canonicalErrors = [
      { name: "without-recovery", value: canonicalError },
      {
        name: "with-recovery",
        value: { ...canonicalError, nextAction: validatedRecovery },
      },
    ] as const;
    const failures: string[] = [];

    for (const fixture of AGENT_OUTPUT_CASES) {
      const outputSchema = outputSchemaByAction.get(fixture.action);
      if (!outputSchema) {
        failures.push(`${fixture.action}: missing output schema`);
        continue;
      }
      for (const errorCase of canonicalErrors) {
        for (const detail of ["compact", "full"] as const) {
          const projected = projectToolResultForModelContent(
            fixture.action,
            errorCase.value,
            { ...fixture.publicRequest, detail, includeDiagnostics: false },
          );
          const parsed = outputSchema.safeParse(projected);
          if (!parsed.success) {
            failures.push(
              `${fixture.action}/${detail}/${errorCase.name}: rejected ${JSON.stringify(parsed.error.issues)}`,
            );
          } else if (!isDeepStrictEqual(parsed.data, projected)) {
            failures.push(
              `${fixture.action}/${detail}/${errorCase.name}: stripped public fields`,
            );
          }
        }
      }
      const arbitraryRecovery = {
        ...canonicalError,
        nextAction: { ...validatedRecovery, privateField: "not-public" },
      };
      const arbitraryParsed = outputSchema.safeParse(arbitraryRecovery);
      if (
        arbitraryParsed.success
        && !isDeepStrictEqual(arbitraryParsed.data, arbitraryRecovery)
      ) {
        failures.push(`${fixture.action}: silently stripped recovery fields`);
      }
    }
    assert.deepEqual(failures, []);
  });

  it("pins one actionable compact fixture for every public action", () => {
    const publicActions = derivePublicActions();
    const fixtureActions = AGENT_OUTPUT_CASES.map(
      ({ action }) => action,
    ).sort();

    assert.deepEqual(fixtureActions, publicActions);
    assert.equal(new Set(fixtureActions).size, fixtureActions.length);

    for (const fixture of AGENT_OUTPUT_CASES) {
      const projected = projectToolResultForModelContent(
        fixture.action,
        fixture.canonicalResultFactory(),
        {
          ...fixture.publicRequest,
          detail: "compact",
          includeDiagnostics: false,
        },
      );
      const projectedRecord = compactKeyRecord(
        fixture.action,
        fixture.compactResultKind,
        projected,
      );

      assert.deepEqual(
        Object.keys(projectedRecord),
        fixture.expectedCompactKeys,
        fixture.action,
      );
      for (const key of fixture.requiredActionabilityKeys) {
        assert.ok(
          Object.hasOwn(projectedRecord, key),
          `${fixture.action}:${key}`,
        );
      }
      if (MUTATING_ACTIONS.has(fixture.action)) {
        assert.notEqual(fixture.executionMode, "read-only", fixture.action);
      }
    }
  });

  it("keeps later family RED assertions separate from global parity", () => {
    assert.deepEqual(DEFERRED_FAMILY_ASSERTIONS, [
      "retrieval-family-full-detail",
      "mutation-family-recovery",
      "runtime-family-diagnostics",
    ]);
  });

  it("has compact and full determinism entries or diagnostic-only reasons per fixture", () => {
    const fixtures = JSON.parse(
      readFileSync(
        join(process.cwd(), "tests/integration/determinism.fixtures.json"),
        "utf8",
      ),
    ) as {
      projectionCases?: Array<{
        action: string;
        detail: string;
        includeDiagnostics: boolean;
      }>;
      projectionDiagnosticVolatilityAllowlist?: Array<{
        action: string;
        reason: string;
      }>;
    };

    assert.ok(Array.isArray(fixtures.projectionCases));
    assert.ok(Array.isArray(fixtures.projectionDiagnosticVolatilityAllowlist));

    const projectionCases = fixtures.projectionCases;
    const diagnosticAllowlist =
      fixtures.projectionDiagnosticVolatilityAllowlist;
    const determinismActions = projectionCases.map(({ action }) => action);
    const allowlistedActions = diagnosticAllowlist.map(({ action }) => action);
    const coveredActions = [
      ...new Set([...determinismActions, ...allowlistedActions]),
    ].sort();

    assert.deepEqual(
      coveredActions,
      AGENT_OUTPUT_CASES.map(({ action }) => action).sort(),
    );
    const determinismCaseKeys = projectionCases.map(
      ({ action, detail, includeDiagnostics }) =>
        `${action}:${detail}:${String(includeDiagnostics)}`,
    );
    assert.equal(
      new Set(determinismCaseKeys).size,
      determinismCaseKeys.length,
    );
    for (const entry of projectionCases) {
      assert.ok(
        entry.detail === "compact" || entry.detail === "full",
        entry.action,
      );
      assert.equal(entry.includeDiagnostics, false, entry.action);

      const fixture = AGENT_OUTPUT_CASES.find(
        ({ action }) => action === entry.action,
      );
      assert.ok(fixture, entry.action);
      const args = {
        ...fixture.publicRequest,
        detail: entry.detail,
        includeDiagnostics: entry.includeDiagnostics,
      };
      const first = projectToolResultForModelContent(
        fixture.action,
        fixture.canonicalResultFactory(),
        args,
      );
      const second = projectToolResultForModelContent(
        fixture.action,
        fixture.canonicalResultFactory(),
        args,
      );
      const firstJson = JSON.stringify(first);
      const secondJson = JSON.stringify(second);
      assert.deepEqual(
        Buffer.from(firstJson, "utf8"),
        Buffer.from(secondJson, "utf8"),
        entry.action,
      );

      if (entry.detail === "compact") {
        const firstRecord = compactKeyRecord(
          fixture.action,
          fixture.compactResultKind,
          first,
        );
        const secondRecord = compactKeyRecord(
          fixture.action,
          fixture.compactResultKind,
          second,
        );
        assert.deepEqual(
          Object.keys(firstRecord),
          fixture.expectedCompactKeys,
          entry.action,
        );
        assert.deepEqual(
          Object.keys(secondRecord),
          fixture.expectedCompactKeys,
          entry.action,
        );
      }
    }
    for (const entry of diagnosticAllowlist) {
      const fixture = AGENT_OUTPUT_CASES.find(
        ({ action }) => action === entry.action,
      );
      assert.ok(
        fixture?.diagnosticExpectation?.includeDiagnostics,
        entry.action,
      );
      assert.ok(entry.reason.trim().length > 0, entry.action);
    }
  });
  it("audits every public action against the real output-contract inventories", () => {
    const inventory = JSON.parse(
      readFileSync(
        join(process.cwd(), "docs/generated/tool-inventory.json"),
        "utf8",
      ),
    ) as {
      outputProfiles: Array<{
        action: string;
        projector: string;
        budgetClass: keyof typeof OUTPUT_BUDGET_TOKEN_LIMITS;
        budgetTokenLimit: number;
        largeResponseStrategy: string;
        recoveryPolicy: string;
        observabilityProfile: string;
      }>;
    };
    const markdown = readFileSync(
      join(process.cwd(), "docs/generated/tool-inventory.md"),
      "utf8",
    );
    const determinism = JSON.parse(
      readFileSync(
        join(process.cwd(), "tests/integration/determinism.fixtures.json"),
        "utf8",
      ),
    ) as {
      projectionCases: Array<{
        action: string;
        detail: string;
        includeDiagnostics: boolean;
      }>;
    };

    const schemaActions = new Set<string>(
      Object.keys(INTERNAL_TRANSFORM_OUTPUT_SCHEMA_BY_ACTION),
    );
    for (const registration of [
      ...capturePublicToolRegistrations(),
      ...capturePublicToolRegistrations({ enabled: true, exclusive: true }),
    ]) {
      if (exhaustiveOutputSchema(registration)) {
        schemaActions.add(canonicalFlatAction(registration.name));
      }
    }

    const projectorActions = new Set<string>();
    for (const fixture of AGENT_OUTPUT_CASES) {
      assert.doesNotThrow(() =>
        projectToolResultForModelContent(
          fixture.action,
          fixture.canonicalResultFactory(),
          {
            ...fixture.publicRequest,
            detail: "compact",
            includeDiagnostics: false,
          },
        )
      );
      projectorActions.add(fixture.action);
    }

    const generatedInventoryActions = new Set(
      inventory.outputProfiles.map(({ action }) => action),
    );
    const documentationActions = new Set(
      inventory.outputProfiles
        .filter(({ action }) => markdown.includes(`| \`${action}\` |`))
        .map(({ action }) => action),
    );
    const observabilityExtractorActions = new Set(
      inventory.outputProfiles
        .filter(({ observabilityProfile }) => observabilityProfile.length > 0)
        .map(({ action }) => action),
    );
    const budgetStrategyActions = new Set(
      inventory.outputProfiles
        .filter(
          ({ budgetClass, budgetTokenLimit }) =>
            OUTPUT_BUDGET_TOKEN_LIMITS[budgetClass] === budgetTokenLimit,
        )
        .map(({ action }) => action),
    );
    const budgetFixtureActions = new Set(
      inventory.outputProfiles
        .filter(
          ({ budgetClass, budgetTokenLimit }) =>
            AGENT_OUTPUT_TOKEN_BUDGETS[budgetClass] === budgetTokenLimit,
        )
        .map(({ action }) => action),
    );
    const largeResponseStrategyActions = new Set(
      inventory.outputProfiles
        .filter(
          ({ largeResponseStrategy }) =>
            largeResponseStrategy === "truncate"
            || largeResponseStrategy === "artifact",
        )
        .map(({ action }) => action),
    );
    const recoveryPolicyActions = new Set(
      inventory.outputProfiles
        .filter(
          ({ recoveryPolicy }) =>
            recoveryPolicy === "none" || recoveryPolicy === "on-truncation",
        )
        .map(({ action }) => action),
    );
    const compactDeterminismActions = new Set(
      determinism.projectionCases
        .filter(
          ({ detail, includeDiagnostics }) =>
            detail === "compact" && !includeDiagnostics,
        )
        .map(({ action }) => action),
    );
    const fullDeterminismActions = new Set(
      determinism.projectionCases
        .filter(
          ({ detail, includeDiagnostics }) =>
            detail === "full" && !includeDiagnostics,
        )
        .map(({ action }) => action),
    );

    const inventories = {
      profileRegistryActions: new Set(Object.keys(PROJECTION_PROFILE_REGISTRY)),
      generatedInventoryActions,
      fixtureActions: new Set(
        AGENT_OUTPUT_CASES.map(({ action }) => action),
      ),
      compactDeterminismActions,
      fullDeterminismActions,
      observabilityExtractorActions,
      budgetStrategyActions,
      budgetFixtureActions,
      largeResponseStrategyActions,
      recoveryPolicyActions,
      schemaActions,
      projectorActions,
      documentationActions,
    };
    const diagnostics = derivePublicActions().flatMap((action) =>
      auditOutputContractObligations(action, inventories)
    );

    assert.deepEqual(diagnostics, []);
  });

  it("reports every missing obligation for a synthetic contributor action", () => {
    const action = "synthetic.newAction";
    const empty = new Set<string>();
    const diagnostics = auditOutputContractObligations(action, {
      profileRegistryActions: empty,
      generatedInventoryActions: empty,
      fixtureActions: empty,
      compactDeterminismActions: empty,
      fullDeterminismActions: empty,
      observabilityExtractorActions: empty,
      budgetStrategyActions: empty,
      budgetFixtureActions: empty,
      largeResponseStrategyActions: empty,
      recoveryPolicyActions: empty,
      schemaActions: empty,
      projectorActions: empty,
      documentationActions: empty,
    });

    assert.deepEqual(diagnostics, [
      "synthetic.newAction: missing profile registry entry",
      "synthetic.newAction: missing generated inventory row",
      "synthetic.newAction: missing agent-output fixture",
      "synthetic.newAction: missing compact determinism entry",
      "synthetic.newAction: missing full determinism entry",
      "synthetic.newAction: missing observability extractor",
      "synthetic.newAction: missing budget strategy",
      "synthetic.newAction: missing budget fixture",
      "synthetic.newAction: missing large-response strategy",
      "synthetic.newAction: missing recovery policy",
      "synthetic.newAction: missing output schema",
      "synthetic.newAction: missing projector",
      "synthetic.newAction: missing documentation row",
    ]);
  });

});
