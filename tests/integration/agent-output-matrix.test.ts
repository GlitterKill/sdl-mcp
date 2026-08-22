import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  projectToolResultForModelContent,
  projectWorkflowChildResultForModel,
} from "../../dist/mcp/context-response-projection.js";
import { RetrieveRequestSchema } from "../../dist/code-mode/retrieve-schema.js";
import {
  buildToolResponseEnvelope,
} from "../../dist/server.js";
import {
  FLAT_RECOVERY_TOOL_NAMES,
  WORKFLOW_CHILD_ACTION_BINDINGS,
  getProjectionProfile,
} from "../../dist/mcp/response-projection/registry.js";
import {
  buildValidatedRecoveryAction,
} from "../../dist/mcp/response-projection/recovery.js";
import { estimateTokens } from "../../dist/util/tokenize.js";
import {
  AGENT_OUTPUT_CASES,
  AGENT_OUTPUT_DIAGNOSTIC_FIELD_NAMES,
  AGENT_OUTPUT_DISALLOWED_FIELDS_BY_ACTION,
  AGENT_OUTPUT_DISALLOWED_FIELD_NAMES,
  AGENT_OUTPUT_DISALLOWED_PATH_PATTERNS,
  AGENT_OUTPUT_PROFILE_CASES,
  AGENT_OUTPUT_SUMMARY_FACT_EXCLUSIONS_BY_ACTION,
  AGENT_OUTPUT_SUMMARY_FACT_KEYS,
  AGENT_OUTPUT_TOKEN_BUDGETS,
} from "../fixtures/response-projection/agent-output-cases.ts";
import { SliceSpilloverGetResponseSchema } from "../../dist/mcp/tools.js";
import {
  decodePacked,
  encodePackedSymbolSearch,
} from "../../dist/mcp/wire/packed/index.js";

const RANGE = {
  start: { line: 10, col: 0 },
  end: { line: 30, col: 1 },
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fixtureKeyRecord(
  fixture: (typeof AGENT_OUTPUT_CASES)[number],
  value: unknown,
): Record<string, unknown> {
  if (fixture.compactResultKind === "scalar") return {};
  const candidate = fixture.compactResultKind === "array"
    ? (Array.isArray(value) ? value[0] : undefined)
    : value;
  assert.ok(isRecord(candidate), fixture.action);
  return candidate;
}

function modelValue(envelope: {
  structuredContent?: Record<string, unknown>;
}): unknown {
  const structured = envelope.structuredContent;
  return structured && Object.keys(structured).length === 1
      && Object.hasOwn(structured, "value")
    ? structured.value
    : structured;
}

function combinedModelTokens(envelope: {
  content: Array<{ text: string }>;
  structuredContent?: Record<string, unknown>;
}): number {
  return estimateTokens(envelope.content.map(({ text }) => text).join("\n"))
    + (envelope.structuredContent === undefined
      ? 0
      : estimateTokens(JSON.stringify(envelope.structuredContent)));
}

function visitRecords(
  value: unknown,
  visit: (record: Record<string, unknown>, path: string) => void,
  path = "$",
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => visitRecords(entry, visit, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  visit(value, path);
  for (const [key, entry] of Object.entries(value)) {
    visitRecords(entry, visit, `${path}.${key}`);
  }
}

function recoveryCandidates(value: unknown): unknown[] {
  const candidates: unknown[] = [];
  visitRecords(value, (record) => {
    if (Object.hasOwn(record, "nextAction")) candidates.push(record.nextAction);
    if (Array.isArray(record.nextActions)) candidates.push(...record.nextActions);
    if (Array.isArray(record.recovery)) candidates.push(...record.recovery);
  });
  return candidates.filter((candidate) => isRecord(candidate));
}

const SUMMARY_FACT_KEY_SET = new Set<string>(
  AGENT_OUTPUT_SUMMARY_FACT_KEYS,
);

function namedSummaryFacts(value: unknown): Array<{
  readonly name: string;
  readonly value: string | number | boolean;
}> {
  const facts: Array<{
    readonly name: string;
    readonly value: string | number | boolean;
  }> = [];
  visitRecords(value, (record, path) => {
    for (const [key, field] of Object.entries(record)) {
      if (
        (path === "$" || path === "$.summary")
        && (SUMMARY_FACT_KEY_SET.has(key) || key.endsWith("Count"))
        && (typeof field === "string"
          || typeof field === "number"
          || field === true)
      ) {
        facts.push({ name: `${path}.${key}`, value: field });
      }
    }
    if (isRecord(record.nextAction) && typeof record.nextAction.id === "string") {
      facts.push({
        name: `${path}.recovery`,
        value: record.nextAction.id,
      });
    }
  });
  return facts;
}

describe("agent retrieval output matrix", () => {
  it("enforces idempotent bounded compact/full/diagnostic envelopes", () => {
    const failures: string[] = [];

    for (const fixture of AGENT_OUTPUT_CASES) {
      const profile = getProjectionProfile(fixture.action);
      assert.equal(profile.defaultDetail, "compact", fixture.action);
      const canonical = fixture.canonicalResultFactory();
      const before = clone(canonical);
      const compact = projectToolResultForModelContent(
        `sdl.${fixture.action}`,
        canonical,
        {
          ...fixture.publicRequest,
          detail: "compact",
          includeDiagnostics: false,
        },
      );
      const full = projectToolResultForModelContent(
        `sdl.${fixture.action}`,
        canonical,
        {
          ...fixture.publicRequest,
          detail: "full",
          includeDiagnostics: false,
        },
      );
      const compactRecord = fixtureKeyRecord(fixture, compact);
      const fullRecord = fixtureKeyRecord(fixture, full);

      assert.deepEqual(
        Object.keys(compactRecord),
        fixture.expectedCompactKeys,
        `${fixture.action}:compact-key-order`,
      );
      for (const key of fixture.requiredActionabilityKeys) {
        assert.ok(
          Object.hasOwn(compactRecord, key),
          `${fixture.action}:compact:${key}`,
        );
        assert.ok(
          Object.hasOwn(fullRecord, key),
          `${fixture.action}:full:${key}`,
        );
      }

      for (const profileCase of AGENT_OUTPUT_PROFILE_CASES) {
        const args = {
          ...fixture.publicRequest,
          detail: profileCase.detail,
          includeDiagnostics: profileCase.includeDiagnostics,
        };
        const projected = projectToolResultForModelContent(
          `sdl.${fixture.action}`,
          canonical,
          args,
        );
        assert.deepEqual(
          projectToolResultForModelContent(
            `sdl.${fixture.action}`,
            projected,
            args,
          ),
          projected,
          `${fixture.action}:${profileCase.name}:idempotence`,
        );

        const first = buildToolResponseEnvelope(
          canonical,
          null,
          "",
          `sdl.${fixture.action}`,
          args,
        );
        const repeated = buildToolResponseEnvelope(
          canonical,
          null,
          "",
          `sdl.${fixture.action}`,
          args,
        );
        assert.equal(
          JSON.stringify(repeated),
          JSON.stringify(first),
          `${fixture.action}:${profileCase.name}:stable-key-order`,
        );
        assert.deepEqual(
          modelValue(first),
          projected,
          `${fixture.action}:${profileCase.name}:summary-structured-agreement`,
        );

        const visibleText = first.content.map(({ text }) => text).join("\n");
        const facts = namedSummaryFacts(projected);
        const excludedFacts = new Set(
          AGENT_OUTPUT_SUMMARY_FACT_EXCLUSIONS_BY_ACTION[fixture.action] ?? [],
        );
        if (facts.length === 0) {
          assert.ok(
            visibleText.trim().length > 0,
            `${fixture.action}:${profileCase.name}:summary-text`,
          );
        }
        for (const { name, value } of facts) {
          if (excludedFacts.has(name)) continue;
          const key = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
          const lowerText = visibleText.toLowerCase();
          const valueWords = String(value)
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((word) => word.length >= 3);
          const rendered = visibleText.includes(String(value))
            || lowerText.includes(key)
            || valueWords.some((word) => lowerText.includes(word));
          if (!rendered) {
            failures.push(
              `${fixture.action}:${profileCase.name}:summary-fact:${name}=${String(value)}`,
            );
          }
        }
        assert.doesNotMatch(
          visibleText,
          /^\s*[\[{]|#PACKED\//,
          `${fixture.action}:${profileCase.name}:duplicate-payload`,
        );

        const actual = combinedModelTokens(first);
        const budgetClass = profileCase.budgetClass === "profile"
          ? profile.budgetClass
          : profileCase.budgetClass;
        const allowed = AGENT_OUTPUT_TOKEN_BUDGETS[budgetClass];
        if (actual > allowed) {
          failures.push(
            `${fixture.action} profile=${profile.budgetClass} detail=${profileCase.name} actual=${actual} allowed=${allowed}`,
          );
        }
      }
      assert.deepEqual(canonical, before, `${fixture.action}:canonical`);
    }

    assert.deepEqual(failures, [], failures.join("\n"));
  });
  it("suppresses private data, validates recovery, diagnostics, and workflow parity", () => {
    const workflowFnByAction = new Map(
      Object.entries(WORKFLOW_CHILD_ACTION_BINDINGS)
        .map(([fn, action]) => [action, fn] as const),
    );
    const advertisedTools = [...FLAT_RECOVERY_TOOL_NAMES, "sdl.workflow"];
    const activeWorkflowFunctions = Object.keys(WORKFLOW_CHILD_ACTION_BINDINGS);

    for (const fixture of AGENT_OUTPUT_CASES) {
      const canonical = fixture.canonicalResultFactory();
      const compact = projectToolResultForModelContent(
        `sdl.${fixture.action}`,
        canonical,
        {
          ...fixture.publicRequest,
          detail: "compact",
          includeDiagnostics: false,
        },
      );
      const full = projectToolResultForModelContent(
        `sdl.${fixture.action}`,
        canonical,
        {
          ...fixture.publicRequest,
          detail: "full",
          includeDiagnostics: false,
        },
      );

      for (const [detail, payload] of [
        ["compact", compact],
        ["full", full],
      ] as const) {
        const serialized = JSON.stringify(payload);
        for (const pattern of AGENT_OUTPUT_DISALLOWED_PATH_PATTERNS) {
          assert.doesNotMatch(
            serialized,
            new RegExp(pattern),
            `${fixture.action}:${detail}:absolute-path`,
          );
        }
        visitRecords(payload, (record, path) => {
          for (const key of [
            ...AGENT_OUTPUT_DISALLOWED_FIELD_NAMES,
            ...(AGENT_OUTPUT_DISALLOWED_FIELDS_BY_ACTION[fixture.action] ?? []),
          ]) {
            assert.equal(
              Object.hasOwn(record, key),
              false,
              `${fixture.action}:${detail}:${path}.${key}`,
            );
          }
          if (path !== "$") return;
          for (const key of AGENT_OUTPUT_DIAGNOSTIC_FIELD_NAMES) {
            assert.equal(
              Object.hasOwn(record, key),
              false,
              `${fixture.action}:${detail}:${path}.${key}`,
            );
          }
        });
      }

      for (const candidate of recoveryCandidates(compact)) {
        const validated = buildValidatedRecoveryAction(candidate, {
          repoId: String(fixture.publicRequest.repoId ?? "projection-fixture"),
          advertisedTools,
          activeWorkflowFunctions,
        });
        assert.ok(
          validated.nextAction,
          `${fixture.action}:invalid-recovery:${JSON.stringify(candidate)}`,
        );
      }

      const diagnosticArgs = {
        ...fixture.publicRequest,
        detail: "compact" as const,
        includeDiagnostics: true,
      };
      const diagnostic = projectToolResultForModelContent(
        `sdl.${fixture.action}`,
        canonical,
        diagnosticArgs,
      );
      assert.deepEqual(
        projectToolResultForModelContent(
          `sdl.${fixture.action}`,
          canonical,
          diagnosticArgs,
        ),
        diagnostic,
        `${fixture.action}:diagnostic-opt-in-determinism`,
      );
      if (fixture.diagnosticExpectation) {
        assert.ok(isRecord(diagnostic), `${fixture.action}:diagnostic-shape`);
        assert.deepEqual(
          Object.keys(diagnostic),
          fixture.diagnosticExpectation.expectedKeys,
          `${fixture.action}:diagnostic-key-order`,
        );
      }

      const workflowFn = workflowFnByAction.get(fixture.action);
      if (workflowFn) {
        if (fixture.action === "runtime.queryOutput") {
          // Workflow children expose continuations through the exclusive public tool.
          const [recoveryAction] = recoveryCandidates(
            projectWorkflowChildResultForModel(
              workflowFn,
              canonical,
              { repoId: "projection-fixture", detail: "compact" },
              fixture.publicRequest,
            ),
          );
          assert.ok(isRecord(recoveryAction));
          assert.equal(recoveryAction.action, "sdl.workflow");
          continue;
        }
        assert.deepEqual(
          projectWorkflowChildResultForModel(
            workflowFn,
            canonical,
            { repoId: "projection-fixture", detail: "compact" },
            fixture.publicRequest,
          ),
          projectToolResultForModelContent(
            fixture.action,
            canonical,
            {
              ...fixture.publicRequest,
              detail: "compact",
              includeDiagnostics: false,
            },
          ),
          `${fixture.action}:workflow-child-parity`,
        );
      }
    }
  });

  it("compacts cards without mutating canonical dependencies", () => {
    const card = {
      symbolId: "symbol-a",
      shortId: "s1",
      repoId: "repo",
      file: "src/a.ts",
      range: RANGE,
      kind: "function",
      name: "alpha",
      exported: true,
      visibility: null,
      signature: { text: "function alpha(): void" },
      cluster: { id: "cluster-a", hash: "cluster-hash" },
      deps: {
        imports: Array.from({ length: 12 }, (_, index) => `import-${index}`),
        calls: Array.from({ length: 11 }, (_, index) => `call-${index}`),
        callsNote: "ordered",
      },
      metrics: { centrality: 99 },
      version: {
        ledgerVersion: "v1",
        astFingerprint: "editing-only",
      },
    };
    const canonical = { card };
    const before = clone(canonical);

    const compact = projectToolResultForModelContent(
      "sdl.symbol.getCard",
      canonical,
      { detail: "compact" },
    ) as { card: Record<string, unknown> };
    const full = projectToolResultForModelContent(
      "sdl.symbol.getCard",
      canonical,
      { detail: "full" },
    ) as { card: Record<string, unknown> };

    assert.equal("cluster" in compact.card, false);
    assert.equal("metrics" in compact.card, false);
    assert.equal("visibility" in compact.card, false);
    assert.equal(
      "astFingerprint" in (compact.card.version as Record<string, unknown>),
      false,
    );
    const deps = compact.card.deps as Record<string, unknown>;
    assert.deepEqual(deps.imports, card.deps.imports.slice(0, 8));
    assert.deepEqual(deps.calls, card.deps.calls.slice(0, 8));
    assert.equal(deps.importsOmitted, 4);
    assert.equal(deps.callsOmitted, 3);
    assert.deepEqual(full.card.cluster, card.cluster);
    assert.deepEqual(full.card.deps, card.deps);
    assert.deepEqual(canonical, before);
  });

  it("elides all-default packed columns while preserving follow-up aliases", () => {
    const packed = [
      "#PACKED/1 tool=symbol.search enc=ss2",
      "@ids=s1:symbol-a,s2:symbol-b",
      "",
      "query=alpha total=2 __tables=h:results:symbolId|file|line|kind|score|name:str|str|int|str|float|str __stypes=query:str|total:int",
      "",
      "h,s1,src/a.ts,0,function,0,alpha",
      "h,s2,src/b.ts,0,function,0,beta",
    ].join("\n");
    const canonical = {
      results: packed,
      exactMatchFound: false,
      retrievalEvidence: [{ symbolId: "symbol-a", retrievalSource: "hybrid" }],
    };
    const compact = projectToolResultForModelContent(
      "sdl.symbol.search",
      canonical,
      { detail: "compact" },
    ) as Record<string, unknown>;

    assert.match(String(compact.results), /@ids=s1:symbol-a,s2:symbol-b/);
    assert.doesNotMatch(String(compact.results), /\|line\|/);
    assert.doesNotMatch(String(compact.results), /\|score\|/);
    assert.match(String(compact.results), /h,s1,src\/a\.ts,function,alpha/);
    assert.equal("retrievalEvidence" in compact, false);
  });

  it("compacts encoder-generated RFC-4180 rows without corrupting values", () => {
    const sessionId = "agent-output-packed-rfc4180";
    const fullIds = ["a".repeat(64), "b".repeat(64)];
    const files = ["src/a,\"quoted\".ts", "src/b\nline.ts"];
    const names = ["alpha,\"quoted\"", "beta\nline"];
    const packed = encodePackedSymbolSearch(
      {
        query: "quoted values",
        total: 2,
        results: fullIds.map((symbolId, index) => ({
          symbolId,
          file: files[index],
          name: names[index],
        })),
      },
      { sessionId, shortIds: true },
    );
    const canonical = { results: packed };
    const before = clone(canonical);

    const compact = projectToolResultForModelContent(
      "sdl.symbol.search",
      canonical,
      { detail: "compact" },
    ) as { results: string };
    const repeated = projectToolResultForModelContent(
      "sdl.symbol.search",
      compact,
      { detail: "compact" },
    );
    const decoded = decodePacked(compact.results);
    const hits = decoded.data.results as Array<Record<string, unknown>>;

    assert.doesNotMatch(compact.results, /\|line\||\|kind\||\|score\|/);
    assert.match(compact.results, /@ids=s\d+:a{64},s\d+:b{64}/);
    assert.deepEqual(hits.map((hit) => hit.file), files);
    assert.deepEqual(hits.map((hit) => hit.name), names);
    assert.deepEqual(hits.map((hit) => hit.symbolId), ["s1", "s2"]);
    assert.deepEqual(repeated, compact);
    assert.deepEqual(canonical, before);
  });

  it("fails closed for malformed packed schemas and rows", () => {
    const sessionId = "agent-output-packed-fail-closed";
    const packed = encodePackedSymbolSearch(
      {
        query: "malformed rows",
        total: 2,
        results: [
          {
            symbolId: "c".repeat(64),
            file: "src/a,\"quoted\".ts",
            name: "alpha,\"quoted\"",
          },
          {
            symbolId: "d".repeat(64),
            file: "src/b.ts",
            name: "beta",
          },
        ],
      },
      { sessionId, shortIds: true },
    );
    const lines = packed.split("\n");
    const rowIndexes = lines
      .map((line, index) => line.startsWith("h,") ? index : -1)
      .filter((index) => index >= 0);
    assert.equal(rowIndexes.length, 2);

    const badArity = [...lines];
    badArity[rowIndexes[1]!] = "h,s2";
    const unclosedQuote = [...lines];
    unclosedQuote[rowIndexes[1]!] = 'h,s2,"unterminated';
    const malformedTag = [...lines];
    malformedTag[rowIndexes[1]!] = lines[rowIndexes[1]!]!.replace(/^h,/, "x,");
    const malformedSpec = packed.replace(
      "__tables=h:results:",
      "__tables=h:results",
    );
    const unknownRow = [...lines, "not-a-table-row"];
    const malformedPayloads = [
      badArity.join("\n"),
      unclosedQuote.join("\n"),
      malformedTag.join("\n"),
      malformedSpec,
      unknownRow.join("\n"),
    ];

    for (const malformed of malformedPayloads) {
      const canonical = { results: malformed };
      const before = clone(canonical);
      const compact = projectToolResultForModelContent(
        "sdl.symbol.search",
        canonical,
        { detail: "compact" },
      ) as { results: string };

      assert.equal(compact.results, malformed);
      assert.deepEqual(canonical, before);
    }
  });

  it("keeps code fragments canonical and adds executable truncated hot-path recovery", () => {
    const canonical = {
      excerpt: "alpha();\nbeta();\nalpha();",
      file: "src/a.ts",
      range: RANGE,
      estimatedTokens: 50,
      matchedIdentifiers: ["alpha", "beta"],
      matchedLineNumbers: [10, 11, 12],
      missedIdentifiers: [],
      truncated: true,
    };
    const before = clone(canonical);
    const args = {
      repoId: "repo",
      symbolId: "symbol-a",
      identifiersToFind: ["alpha", "beta"],
      maxLines: 20,
      detail: "compact",
    };
    const compact = projectToolResultForModelContent(
      "sdl.code.getHotPath",
      canonical,
      args,
    ) as Record<string, unknown>;
    const full = projectToolResultForModelContent(
      "sdl.code.getHotPath",
      canonical,
      { ...args, detail: "full" },
    ) as Record<string, unknown>;

    assert.equal(compact.excerpt, canonical.excerpt);
    assert.equal("matchedLineNumbers" in compact, false);
    assert.equal("missedIdentifiers" in compact, false);
    assert.equal("estimatedTokens" in compact, false);
    const nextAction = compact.nextAction as {
      action: string;
      args: Record<string, unknown>;
    };
    assert.equal(nextAction.action, "sdl.retrieve");
    RetrieveRequestSchema.parse(nextAction.args);
    const retrieved = projectToolResultForModelContent(
      "sdl.retrieve",
      canonical,
      {
        repoId: "repo",
        op: "codeHotPath",
        args: {
          symbolId: "symbol-a",
          identifiersToFind: ["alpha", "beta"],
          maxLines: 20,
        },
        detail: "compact",
      },
    ) as Record<string, unknown>;
    RetrieveRequestSchema.parse(
      (retrieved.nextAction as { args: unknown }).args,
    );
    assert.equal(full.excerpt, canonical.excerpt);
    assert.deepEqual(full.matchedIdentifiers, canonical.matchedIdentifiers);
    assert.deepEqual(canonical, before);
  });

  it("serializes a repeated slice handle once and leaves canonical ranking intact", () => {
    const cards = Array.from({ length: 20 }, (_, index) => ({
      symbolId: `symbol-${index}`,
      name: `symbol${index}`,
      file: `src/${index}.ts`,
      rank: index + 1,
      summary: "",
    }));
    const edges = Array.from({ length: 24 }, (_, index) => ({
      from: `symbol-${index % 20}`,
      to: `symbol-${(index + 1) % 20}`,
      kind: "calls",
      rank: index + 1,
    }));
    const canonical = {
      sliceHandle: "slice-a",
      slice: {
        handle: "slice-a",
        startSymbols: ["symbol-0"],
        cards,
        edges,
      },
      nextActions: [
        { id: "slice.spillover.get", args: { sliceHandle: "slice-a" } },
        { id: "code.getSkeleton", args: { symbolId: "symbol-0" } },
      ],
    };
    const beforeCards = clone(cards);
    const beforeEdges = clone(edges);

    const compact = projectToolResultForModelContent(
      "sdl.slice.build",
      canonical,
      { detail: "compact" },
    ) as Record<string, unknown>;

    assert.deepEqual(Object.keys(compact), ["nextAction"]);
    assert.equal(
      JSON.stringify(compact).match(/slice-a/g)?.length,
      1,
    );
    assert.deepEqual(cards, beforeCards);
    assert.deepEqual(edges, beforeEdges);
  });

  it("preserves slice refresh version and not-modified state", () => {
    const canonical = {
      sliceHandle: "slice-a",
      knownVersion: "v1",
      currentVersion: "v1",
      notModified: true,
      delta: null,
    };
    const compact = projectToolResultForModelContent(
      "sdl.slice.refresh",
      canonical,
      { detail: "compact" },
    );
    assert.deepEqual(compact, canonical);
  });

  it("preserves compact spillover paging across direct and workflow projection", () => {
    const symbols = Array.from({ length: 2 }, (_, index) => ({
      symbolId: `symbol-${index}`,
      repoId: "repo",
      file: `src/${index}.ts`,
      range: { startLine: index + 1, startCol: 0, endLine: index + 2, endCol: 1 },
      kind: "function",
      name: `symbol${index}`,
      exported: false,
      visibility: "public",
      signature: { text: `function symbol${index}(): void` },
      summary: "",
      invariants: [],
      sideEffects: [],
      deps: {
        imports: Array.from({ length: 12 }, (_, dep) => `import-${index}-${dep}`),
        calls: Array.from({ length: 11 }, (_, dep) => `call-${index}-${dep}`),
      },
      version: {
        ledgerVersion: "v1",
        astFingerprint: `editing-only-${index}`,
      },
    }));
    const canonical = {
      spilloverHandle: "spillover-a",
      cursor: "2",
      hasMore: true,
      symbols,
    };
    const before = clone(canonical);
    SliceSpilloverGetResponseSchema.parse(canonical);

    const args = {
      repoId: "repo",
      spilloverHandle: "spillover-a",
      detail: "compact",
    };
    const compact = projectToolResultForModelContent(
      "sdl.slice.spillover.get",
      canonical,
      args,
    ) as Record<string, unknown>;
    const compactSymbols = compact.symbols as Array<Record<string, unknown>>;
    SliceSpilloverGetResponseSchema.parse(compact);

    assert.deepEqual(Object.keys(compact), [
      "spilloverHandle",
      "cursor",
      "hasMore",
      "symbols",
    ]);
    assert.equal(compact.spilloverHandle, "spillover-a");
    assert.equal(compact.cursor, "2");
    assert.equal(compact.hasMore, true);
    assert.equal(compactSymbols.length, symbols.length);
    assert.equal("repoId" in compactSymbols[0]!, false);
    assert.equal("exported" in compactSymbols[0]!, false);
    assert.equal(
      "astFingerprint" in (compactSymbols[0]!.version as Record<string, unknown>),
      false,
    );
    assert.deepEqual(
      (compactSymbols[0]!.deps as Record<string, unknown>).imports,
      symbols[0]!.deps.imports.slice(0, 8),
    );
    assert.deepEqual(
      projectToolResultForModelContent(
        "sdl.slice.spillover.get",
        compact,
        args,
      ),
      compact,
    );

    const workflowArgs = { repoId: "repo", detail: "compact" };
    const workflowStepArgs = { spilloverHandle: "spillover-a" };
    const workflowChild = projectWorkflowChildResultForModel(
      "sliceSpilloverGet",
      canonical,
      workflowArgs,
      workflowStepArgs,
    );
    assert.deepEqual(workflowChild, compact);

    const workflow = projectToolResultForModelContent(
      "sdl.workflow",
      {
        results: [{
          stepIndex: 0,
          fn: "sliceSpilloverGet",
          status: "ok",
          result: workflowChild,
        }],
      },
      {
        ...workflowArgs,
        steps: [{
          fn: "sliceSpilloverGet",
          args: workflowStepArgs,
        }],
      },
    ) as { results: Array<{ fn: string; result: unknown }> };
    assert.deepEqual(workflow.results[0]!.result, compact);
    assert.deepEqual(canonical, before);
  });

  it("preserves terminal and empty spillover states", () => {
    const terminal = {
      spilloverHandle: "spillover-a",
      hasMore: false,
      symbols: [{
        symbolId: "symbol-a",
        repoId: "repo",
        file: "src/a.ts",
        range: { startLine: 1, startCol: 0, endLine: 2, endCol: 1 },
        kind: "function",
        name: "alpha",
        exported: false,
        version: { ledgerVersion: "v1", astFingerprint: "editing-only" },
      }],
    };
    const empty = {
      spilloverHandle: "spillover-empty",
      hasMore: false,
      symbols: [],
    };

    for (const canonical of [terminal, empty]) {
      const before = clone(canonical);
      SliceSpilloverGetResponseSchema.parse(canonical);
      const compact = projectToolResultForModelContent(
        "sdl.slice.spillover.get",
        canonical,
        { detail: "compact" },
      ) as Record<string, unknown>;
      SliceSpilloverGetResponseSchema.parse(compact);
      assert.equal(compact.hasMore, false);
      assert.equal("cursor" in compact, false);
      assert.ok(Array.isArray(compact.symbols));
      assert.deepEqual(
        projectToolResultForModelContent(
          "sdl.slice.spillover.get",
          compact,
          { detail: "compact" },
        ),
        compact,
      );
      assert.deepEqual(
        projectWorkflowChildResultForModel(
          "sliceSpilloverGet",
          canonical,
          { detail: "compact" },
          {},
        ),
        compact,
      );
      assert.deepEqual(canonical, before);
    }
  });

  it("omits healthy context lane noise and per-evidence ranks", () => {
    const canonical = {
      status: "complete",
      taskType: "review",
      retrieval: {
        level: "hybrid",
        lanes: [
          { id: "exactIdentifier", available: true },
          { id: "symbolFts", available: true },
          { id: "symbolVec", available: true, coveragePermille: 1000 },
        ],
      },
      evidence: [
        {
          rung: "card",
          symbolId: "symbol-a",
          path: "src/a.ts",
          rank: 1,
          tier: 0,
          lanes: ["exactIdentifier", "symbolFts"],
          content: { name: "alpha" },
        },
      ],
      edges: [],
      omitted: { total: 0, byReason: { budget: 0 }, highestRanked: [] },
      nextActions: [],
    };
    const beforeEvidence = clone(canonical.evidence);

    const compact = projectToolResultForModelContent(
      "sdl.context",
      canonical,
      { detail: "compact" },
    ) as Record<string, unknown>;
    const evidence = compact.evidence as Array<Record<string, unknown>>;

    assert.equal("retrieval" in compact, false);
    assert.equal("edges" in compact, false);
    assert.equal("nextActions" in compact, false);
    assert.equal("rank" in evidence[0]!, false);
    assert.equal("lanes" in evidence[0]!, false);
    assert.equal("omitted" in compact, false);
    assert.deepEqual(canonical.evidence, beforeEvidence);
  });

  it("separates semantic context detail from diagnostics", () => {
    const continuation = {
      id: "symbol.getCard",
      args: { symbolIds: ["symbol-beta"] },
    };
    const range = { startLine: 12, startCol: 0, endLine: 12, endCol: 25 };
    const canonical = {
      status: "budgetLimited",
      taskType: "debug",
      retrieval: {
        level: "hybrid-partial",
        lanes: [
          { id: "exactIdentifier", available: true, coveragePermille: 1000 },
          { id: "symbolVec", available: false, coveragePermille: 375 },
        ],
        fusionLatencyMs: 17,
        strategyMetrics: { vectorWeightPermille: 650 },
      },
      evidence: [
        {
          symbolId: "symbol-alpha",
          path: "src/alpha.ts",
          rank: 1,
          tier: 0,
          rung: "card",
          lanes: ["exactIdentifier"],
          content: {
            kind: "function",
            name: "alpha",
            estimatedTokens: 5,
          },
        },
        {
          symbolId: "symbol-beta",
          path: "src/beta.ts",
          rank: 2,
          tier: 1,
          rung: "hotPath",
          lanes: ["symbolVec"],
          content: {
            excerpt: "export function beta() {}",
            actualRange: range,
            estimatedTokens: 12,
            matchedIdentifiers: ["beta"],
            matchedLineNumbers: [12],
            truncated: true,
          },
        },
        {
          symbolId: "symbol-gamma",
          path: "src/gamma.ts",
          rank: 3,
          tier: 1,
          rung: "hotPath",
          lanes: ["symbolVec"],
          content: {
            excerpt: "export function gamma() {}",
            actualRange: range,
            matchedIdentifiers: ["gamma"],
            truncated: false,
          },
        },
      ],
      edges: [{
        from: "symbol-alpha",
        to: "symbol-beta",
        kind: "call",
        confidencePermille: 950,
      }],
      omitted: {
        total: 1,
        byReason: { budget: 1 },
        highestRanked: [{
          symbolId: "symbol-beta",
          path: "src/beta.ts",
          rank: 2,
          tier: 1,
          rung: "hotPath",
          reason: "budget",
          action: continuation,
        }],
      },
      nextActions: [continuation],
      sessionDelta: { changedCards: 1, newCards: 2, unchangedRefs: 3 },
      diagnosticTimings: { selectionMs: 4 },
      absolutePath: "C:\\private\\repo\\src\\alpha.ts",
    };
    const before = clone(canonical);
    const project = (
      detail?: "compact" | "standard" | "full",
      includeDiagnostics = false,
    ) => projectToolResultForModelContent(
      "sdl.context",
      canonical,
      { detail, includeDiagnostics },
    ) as Record<string, unknown>;
    const compact = project("compact");
    const noise = [
      "available", "coveragePermille", "rank", "tier", "lanes",
      "estimatedTokens", "matchedLineNumbers", "confidencePermille",
      "fusionLatencyMs", "strategyMetrics", "sessionDelta",
      "diagnosticTimings", "absolutePath",
    ];

    assert.deepEqual(project(), compact);
    for (const [detail, projected] of [
      ["compact", compact],
      ["standard", project("standard")],
      ["full", project("full")],
    ] as const) {
      visitRecords(projected, (record, path) => {
        for (const key of noise) {
          assert.equal(
            Object.hasOwn(record, key),
            false,
            `${detail}:${path}.${key}`,
          );
        }
        if (Object.hasOwn(record, "truncated")) {
          assert.equal(record.truncated, true, `${detail}:${path}.truncated`);
        }
      });
      const evidence = projected.evidence as Array<Record<string, unknown>>;
      assert.deepEqual(
        evidence.map(({ symbolId, path, rung }) => ({ symbolId, path, rung })),
        canonical.evidence.map(({ symbolId, path, rung }) => ({
          symbolId,
          path,
          rung,
        })),
      );
      assert.deepEqual(evidence[1]!.content, {
        excerpt: "export function beta() {}",
        actualRange: range,
        matchedIdentifiers: ["beta"],
        truncated: true,
      });
      assert.deepEqual(evidence[2]!.content, {
        excerpt: "export function gamma() {}",
        actualRange: range,
        matchedIdentifiers: ["gamma"],
      });
      assert.deepEqual(projected.edges, [
        { from: "symbol-alpha", to: "symbol-beta", kind: "call" },
      ]);
      assert.deepEqual(projected.omitted, {
        total: 1,
        byReason: { budget: 1 },
      });
      assert.deepEqual(recoveryCandidates(projected), [continuation]);
    }

    const diagnostics = project("full", true);
    assert.deepEqual(
      (diagnostics.retrieval as Record<string, unknown>).lanes,
      canonical.retrieval.lanes,
    );
    const evidence = diagnostics.evidence as Array<Record<string, unknown>>;
    assert.deepEqual(
      evidence.map(({ rank, tier, lanes }) => ({ rank, tier, lanes })),
      canonical.evidence.map(({ rank, tier, lanes }) => ({ rank, tier, lanes })),
    );
    const beta = evidence[1]!.content as Record<string, unknown>;
    assert.equal(beta.estimatedTokens, 12);
    assert.deepEqual(beta.matchedLineNumbers, [12]);
    assert.equal(
      (diagnostics.edges as Array<Record<string, unknown>>)[0]!
        .confidencePermille,
      950,
    );
    assert.deepEqual(diagnostics.sessionDelta, canonical.sessionDelta);
    assert.deepEqual(diagnostics.diagnosticTimings, canonical.diagnosticTimings);
    visitRecords(diagnostics, (record, path) => {
      for (const key of ["strategyMetrics", "absolutePath"]) {
        assert.equal(Object.hasOwn(record, key), false, `${path}.${key}`);
      }
      if (Object.hasOwn(record, "truncated")) {
        assert.equal(record.truncated, true, `${path}.truncated`);
      }
    });
    assert.deepEqual(recoveryCandidates(diagnostics), [continuation]);
    assert.deepEqual(canonical, before);
  });

  it("retains degraded retrieval lanes and one primary recovery", () => {
    const canonical = {
      status: "budgetLimited",
      retrieval: {
        level: "hybrid-partial",
        lanes: [
          { id: "symbolFts", available: true },
          { id: "symbolVec", available: false },
        ],
      },
      evidence: [],
      edges: [],
      omitted: {
        total: 2,
        byReason: { budget: 2 },
        highestRanked: [],
      },
      nextActions: [
        { id: "symbol.getCard", args: { symbolIds: ["symbol-a"] } },
        { id: "code.getSkeleton", args: { symbolId: "symbol-a" } },
      ],
    };

    const compact = projectToolResultForModelContent(
      "sdl.context",
      canonical,
      { detail: "compact" },
    ) as Record<string, unknown>;

    assert.deepEqual(compact.retrieval, {
      level: "hybrid-partial",
    });
    assert.equal("evidence" in compact, false);
    assert.deepEqual(compact.nextAction, canonical.nextActions[0]);
    assert.equal("nextActions" in compact, false);
    assert.deepEqual(compact.omitted, {
      total: 2,
      byReason: { budget: 2 },
    });
  });

  it("preserves typed graph-unavailable recovery while healthy results stay healthy", () => {
    const unavailable = {
      isError: true,
      error: {
        code: "GRAPH_RETRIEVAL_UNAVAILABLE",
        message: "Graph retrieval is unavailable.",
        recovery: [
          { id: "index.refresh", args: { mode: "incremental" } },
          { id: "repo.status", args: {} },
        ],
      },
    };
    assert.deepEqual(
      projectToolResultForModelContent(
        "sdl.slice.build",
        unavailable,
        { detail: "compact" },
      ),
      unavailable,
    );

    const healthy = projectToolResultForModelContent(
      "sdl.slice.build",
      {
        sliceHandle: "healthy-slice",
        slice: { cards: [], edges: [] },
      },
      { detail: "compact" },
    );
    assert.doesNotMatch(JSON.stringify(healthy), /unavailable/i);
  });

  it("does not duplicate structured payload in packed text fields", () => {
    const canonical = {
      results: "#PACKED/1 tool=symbol.search enc=ss2\nquery=x total=0",
      structuredContent: {
        results: [{ symbolId: "symbol-a", name: "alpha" }],
      },
    };
    const compact = projectToolResultForModelContent(
      "sdl.symbol.search",
      canonical,
      { detail: "compact" },
    ) as Record<string, unknown>;

    assert.equal("structuredContent" in compact, false);
    assert.match(String(compact.results), /^#PACKED\/1/);
  });
});
