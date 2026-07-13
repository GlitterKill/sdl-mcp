import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";

import {
  ACTION_DEFINITIONS,
  ACTION_TO_FN,
  FN_NAME_MAP,
  GATEWAY_ACTION_DEFINITIONS,
  LADDER,
  buildCatalog,
} from "../../dist/code-mode/action-catalog.js";
import {
  createActionHandlerMap,
  createActionMap,
} from "../../dist/gateway/router.js";
import { buildFlatToolDescriptors } from "../../dist/mcp/tools/tool-descriptors.js";
import { CLI_ACTION_DEFINITIONS } from "../../dist/cli/commands/tool-actions.js";

const ALL_ACTIONS = { memoryTools: true } as const;
const NO_MEMORY_ACTIONS = { memoryTools: false } as const;

const STATIC_IMPORT_STATEMENT = /(?:^|\n)((?:import|export)\s+[\s\S]*?;)/g;

function resolveSourceImport(fromFile: string, specifier: string): string | null {
  const imported = resolve(dirname(fromFile), specifier);
  const candidates = imported.endsWith(".js")
    ? [`${imported.slice(0, -3)}.ts`, `${imported.slice(0, -3)}.tsx`]
    : [`${imported}.ts`, `${imported}.tsx`, join(imported, "index.ts")];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function assertEntryNotInImportCycle(entryFile: string): void {
  const visited = new Set<string>();
  const active: string[] = [];

  const visit = (file: string): void => {
    const cycleStart = active.indexOf(file);
    if (cycleStart !== -1) {
      assert.notEqual(
        file,
        entryFile,
        `registry import cycle: ${[...active.slice(cycleStart), file].join(" -> ")}`,
      );
      return;
    }
    if (visited.has(file)) return;

    active.push(file);
    const source = readFileSync(file, "utf8");
    STATIC_IMPORT_STATEMENT.lastIndex = 0;
    const imports = [...source.matchAll(STATIC_IMPORT_STATEMENT)]
      .map((match) => match[1]!.trim())
      .filter(
        (statement) =>
          !statement.startsWith("import type ") &&
          !statement.startsWith("export type "),
      )
      .map((statement) =>
        statement.match(/(?:from\s+)?["'](\.[^"']+)["']\s*;$/)?.[1],
      )
      .filter((specifier): specifier is string => specifier !== undefined)
      .map((specifier) => resolveSourceImport(file, specifier))
      .filter((candidate): candidate is string => candidate !== null);
    for (const imported of imports) visit(imported);
    active.pop();
    visited.add(file);
  };

  visit(entryFile);
}

describe("Action Definition registry", () => {
  it("keeps ordered action identities unique and mapped to function names", () => {
    const actions = ACTION_DEFINITIONS.map((definition) => definition.action);
    assert.equal(new Set(actions).size, actions.length);

    for (const definition of GATEWAY_ACTION_DEFINITIONS) {
      assert.equal(ACTION_TO_FN[definition.action], definition.fn);
      assert.equal(FN_NAME_MAP[definition.fn!], definition.action);
      assert.equal(definition.toolName, `sdl.${definition.action}`);
    }
  });

  it("joins every gateway definition to exactly one handler and its published schema", () => {
    const handlers = createActionHandlerMap();
    const actionMap = createActionMap(undefined, ALL_ACTIONS);
    const definitionActions = GATEWAY_ACTION_DEFINITIONS.map(
      (definition) => definition.action,
    );

    assert.deepEqual(Object.keys(handlers), definitionActions);
    assert.deepEqual(Object.keys(actionMap), definitionActions);
    for (const definition of GATEWAY_ACTION_DEFINITIONS) {
      assert.equal(actionMap[definition.action]?.schema, definition.schema);
      assert.equal(typeof actionMap[definition.action]?.handler, "function");
      assert.equal(typeof handlers[definition.action], "function");
    }
  });

  it("projects discovery text and examples without exposing definition internals", () => {
    const catalog = buildCatalog({
      includeExamples: true,
      memoryVisible: true,
    });
    for (const entry of catalog) {
      const definition = ACTION_DEFINITIONS.find(
        (candidate) => candidate.action === entry.action,
      );
      assert.ok(definition, `missing definition for ${entry.action}`);
      assert.equal(entry.description, definition.description);
      assert.deepEqual(entry.example, definition.example);
      assert.equal("schema" in entry, false);
      assert.equal("toolName" in entry, false);
    }
  });

  it("drives flat tool identity and request schemas from the same definitions", () => {
    const descriptors = buildFlatToolDescriptors({
      actionAvailability: ALL_ACTIONS,
    });
    assert.equal(descriptors.length, GATEWAY_ACTION_DEFINITIONS.length);
    for (const definition of GATEWAY_ACTION_DEFINITIONS) {
      const descriptor = descriptors.find(
        (candidate) => candidate.name === definition.toolName,
      );
      assert.ok(descriptor, `missing flat tool ${definition.toolName}`);
      assert.equal(descriptor.schema, definition.schema);
    }
  });

  it("keeps every CLI flag projection attached to a canonical definition", () => {
    for (const cliDefinition of CLI_ACTION_DEFINITIONS) {
      assert.ok(
        ACTION_DEFINITIONS.some(
          (definition) => definition.action === cliDefinition.action,
        ),
        `orphan CLI action ${cliDefinition.action}`,
      );
    }
  });

  it("keeps memory availability as a projection over a static definition set", () => {
    const enabled = createActionMap(undefined, ALL_ACTIONS);
    const disabled = createActionMap(undefined, NO_MEMORY_ACTIONS);
    assert.ok(enabled["memory.store"]);
    assert.equal(disabled["memory.store"], undefined);
    assert.ok(GATEWAY_ACTION_DEFINITIONS.some((d) => d.action === "memory.store"));
  });

  it("centralizes the existing ladder order and token costs", () => {
    assert.deepEqual(LADDER, [
      { action: "symbol.search", rung: 0, estTokens: 150 },
      { action: "symbol.getCard", rung: 1, estTokens: 50 },
      { action: "slice.build", rung: 1, estTokens: 1500 },
      { action: "code.getSkeleton", rung: 2, estTokens: 200 },
      { action: "code.getHotPath", rung: 3, estTokens: 500 },
      { action: "code.needWindow", rung: 4, estTokens: 1400 },
    ]);
  });

  it("keeps the static definition module free of router and config I/O imports", () => {
    const source = readFileSync(
      join(process.cwd(), "src/code-mode/action-catalog.ts"),
      "utf8",
    );
    assert.equal(source.includes('from "../gateway/router.js"'), false);
    assert.equal(source.includes('from "./manual-generator.js"'), false);
    assert.equal(source.includes('from "../config/loadConfig.js"'), false);
    assert.equal(source.includes("../live-index/"), false);
  });

  it("does not participate in an import cycle", () => {
    assertEntryNotInImportCycle(
      join(process.cwd(), "src/code-mode/action-catalog.ts"),
    );
  });
});
