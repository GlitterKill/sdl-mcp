import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

import {
  runLspCallDefinitionEnrichment,
  type SemanticLspClientLike,
} from "../../dist/semantic/providers/lsp/runner.js";
import type { LspCandidatePlan } from "../../dist/semantic/providers/lsp/candidates.js";

function makePlan(repoRoot: string): LspCandidatePlan {
  const sourceUri = pathToFileURL(join(repoRoot, "src/caller.ts")).toString();
  return {
    repoId: "repo",
    languageId: "typescript",
    documents: [
      {
        uri: sourceUri,
        sourcePath: "src/caller.ts",
        languageId: "typescript",
        text: "export function caller() { missingCall(); otherCall(); }\n",
        version: 1,
      },
    ],
    candidates: [
      {
        repoId: "repo",
        languageId: "typescript",
        sourceSymbolId: "sym:caller",
        sourceProviderSymbolId: "lsp-source:sym:caller",
        sourcePath: "src/caller.ts",
        sourceUri,
        sourceName: "caller",
        targetSymbolId: "unresolved:call:missingCall",
        targetName: "missingCall",
        existingEdgeConfidence: 0.5,
        position: { line: 0, character: 27 },
        callRange: {
          startLine: 1,
          startCol: 27,
          endLine: 1,
          endCol: 40,
        },
      },
      {
        repoId: "repo",
        languageId: "typescript",
        sourceSymbolId: "sym:caller",
        sourceProviderSymbolId: "lsp-source:sym:caller",
        sourcePath: "src/caller.ts",
        sourceUri,
        sourceName: "caller",
        targetSymbolId: "unresolved:call:otherCall",
        targetName: "otherCall",
        existingEdgeConfidence: 0.9,
        position: { line: 0, character: 42 },
        callRange: {
          startLine: 1,
          startCol: 42,
          endLine: 1,
          endCol: 53,
        },
      },
    ],
    skipped: [],
  };
}

function makeClient(params: {
  definitions?: unknown[];
  definitionProvider?: boolean;
  diagnosticProvider?: boolean;
  diagnostics?: unknown[];
  waitForDiagnostics?: (
    uris: readonly string[],
    timeoutMs: number,
  ) => Promise<void>;
  startError?: Error;
}): SemanticLspClientLike {
  const definitions = params.definitions ?? [];
  let requestIndex = 0;
  return {
    async start() {
      if (params.startError) throw params.startError;
      return {
        capabilities: {
          ...(params.definitionProvider === false
            ? {}
            : { definitionProvider: true }),
          ...(params.diagnosticProvider ? { diagnosticProvider: {} } : {}),
        },
        serverInfo: { name: "mock-lsp", version: "1.2.3" },
      };
    },
    async openDocument() {
      return undefined;
    },
    async definition() {
      return definitions[requestIndex++] as never;
    },
    diagnostics() {
      return (params.diagnostics ?? []) as never;
    },
    ...(params.waitForDiagnostics
      ? { waitForDiagnostics: params.waitForDiagnostics }
      : {}),
    async dispose() {
      return undefined;
    },
  };
}

describe("LSP call-definition runner", () => {
  it("normalizes Location and LocationLink definitions into SemanticIndex edges", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "sdl-lsp-runner-"));
    try {
      const targetUri = pathToFileURL(join(repoRoot, "src/target.ts")).toString();
      const result = await runLspCallDefinitionEnrichment({
        conn: {} as never,
        repoId: "repo",
        repoRoot,
        languageId: "typescript",
        server: {
          enabled: true,
          serverId: "mock",
          command: "mock",
          args: [],
          languages: ["typescript"],
          documentLanguageIds: ["typescript"],
          filePatterns: ["**/*.ts"],
          capabilities: [],
        },
        confidence: 0.8,
        timeoutMs: 1000,
        candidateLimit: 10,
        runId: "run-1",
        candidatePlanner: async () => makePlan(repoRoot),
        clientFactory: () =>
          makeClient({
            definitions: [
              {
                uri: targetUri,
                range: {
                  start: { line: 0, character: 16 },
                  end: { line: 0, character: 27 },
                },
              },
              [
                {
                  targetUri,
                  targetRange: {
                    start: { line: 2, character: 16 },
                    end: { line: 2, character: 25 },
                  },
                  targetSelectionRange: {
                    start: { line: 2, character: 16 },
                    end: { line: 2, character: 25 },
                  },
                },
              ],
            ],
          }),
      });

      assert.equal(result.failedRun, undefined);
      assert.equal(result.index?.edges.length, 2);
      assert.deepEqual(
        result.index?.edges.map((edge) => edge.resolverId),
        ["lsp:mock", "lsp:mock"],
      );
      assert.deepEqual(
        result.index?.symbols
          .filter((symbol) => symbol.providerSymbolId.startsWith("lsp-target:"))
          .map((symbol) => symbol.range?.startLine),
        [0, 2],
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("records a skipped run when the server has no useful capability", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "sdl-lsp-runner-no-def-"));
    try {
      const result = await runLspCallDefinitionEnrichment({
        conn: {} as never,
        repoId: "repo",
        repoRoot,
        languageId: "typescript",
        server: {
          enabled: true,
          serverId: "mock",
          command: "mock",
          args: [],
          languages: ["typescript"],
          documentLanguageIds: ["typescript"],
          filePatterns: ["**/*.ts"],
          capabilities: [],
        },
        confidence: 0.8,
        timeoutMs: 1000,
        candidateLimit: 10,
        runId: "run-2",
        candidatePlanner: async () => makePlan(repoRoot),
        clientFactory: () => makeClient({ definitionProvider: false }),
      });

      assert.equal(result.failedRun, undefined);
      assert.equal(result.index, undefined);
      assert.equal(result.skippedRun?.status, "skipped");
      assert.ok(
        result.skipped.every((skip) => skip.reason === "definition-unavailable"),
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("skips document-symbol-only LSP servers until symbol persistence exists", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "sdl-lsp-runner-doc-symbol-"));
    try {
      mkdirSync(join(repoRoot, "src"), { recursive: true });
      writeFileSync(
        join(repoRoot, "src", "main.py"),
        "def greet():\n    return 'hello'\n",
        "utf8",
      );
      const result = await runLspCallDefinitionEnrichment({
        conn: {} as never,
        repoId: "repo",
        repoRoot,
        languageId: "python",
        server: {
          enabled: true,
          serverId: "mock-python",
          command: "mock",
          args: [],
          languages: ["python"],
          documentLanguageIds: ["python"],
          filePatterns: ["**/*.py"],
          capabilities: ["documentSymbol"],
        },
        confidence: 0.8,
        timeoutMs: 1000,
        candidateLimit: 10,
        runId: "run-doc-symbol",
        candidatePlanner: async () => ({
          repoId: "repo",
          languageId: "python",
          documents: [],
          candidates: [],
          skipped: [],
        }),
        clientFactory: () => makeClient({ definitionProvider: false }),
      });

      assert.equal(result.failedRun, undefined);
      assert.equal(result.index, undefined);
      assert.equal(result.skippedRun?.status, "skipped");
      assert.match(
        result.skippedRun?.error ?? "",
        /diagnostic or definition capabilities/,
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("ingests bounded diagnostics after a bounded wait when config requests them", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "sdl-lsp-runner-diagnostic-"));
    try {
      mkdirSync(join(repoRoot, "src"), { recursive: true });
      writeFileSync(join(repoRoot, "src", "main.js"), "x = unknown\n", "utf8");
      let waitedFor: { uris: readonly string[]; timeoutMs: number } | null = null;
      const longMessage = "x".repeat(1_200);
      const diagnostics = Array.from({ length: 250 }, (_, index) => ({
        range: {
          start: { line: 0, character: 4 },
          end: { line: 0, character: 11 },
        },
        severity: index === 0 ? 1 : 2,
        message: longMessage,
        code: "E001",
      }));

      const result = await runLspCallDefinitionEnrichment({
        conn: {} as never,
        repoId: "repo",
        repoRoot,
        languageId: "typescript",
        server: {
          enabled: true,
          serverId: "mock-js",
          command: "mock",
          args: [],
          languages: ["typescript", "javascript"],
          documentLanguageIds: ["typescript", "javascript"],
          filePatterns: ["**/*.js"],
          capabilities: ["diagnostics"],
        },
        confidence: 0.8,
        timeoutMs: 1000,
        candidateLimit: 10,
        runId: "run-diagnostic",
        candidatePlanner: async () => ({
          repoId: "repo",
          languageId: "typescript",
          documents: [],
          candidates: [],
          skipped: [],
        }),
        clientFactory: () =>
          makeClient({
            definitionProvider: false,
            diagnostics,
            waitForDiagnostics: async (uris, timeoutMs) => {
              waitedFor = { uris, timeoutMs };
            },
          }),
      });

      assert.equal(result.failedRun, undefined);
      assert.equal(result.skippedRun, undefined);
      assert.equal(result.index?.diagnostics.length, 200);
      assert.equal(result.index?.diagnostics[0].severity, "error");
      assert.equal(result.index?.diagnostics[0].message.length, 1000);
      assert.equal(result.index?.diagnostics[0].languageId, "javascript");
      assert.equal(waitedFor?.uris.length, 1);
      assert.ok((waitedFor?.timeoutMs ?? 0) <= 1000);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("records a failed provider run when server startup fails", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "sdl-lsp-runner-fail-"));
    try {
      const result = await runLspCallDefinitionEnrichment({
        conn: {} as never,
        repoId: "repo",
        repoRoot,
        languageId: "typescript",
        server: {
          enabled: true,
          serverId: "mock",
          command: "mock",
          args: [],
          languages: ["typescript"],
          documentLanguageIds: ["typescript"],
          filePatterns: ["**/*.ts"],
          capabilities: [],
        },
        confidence: 0.8,
        timeoutMs: 1000,
        candidateLimit: 10,
        runId: "run-3",
        candidatePlanner: async () => makePlan(repoRoot),
        clientFactory: () =>
          makeClient({ startError: new Error("server failed") }),
      });

      assert.equal(result.index, undefined);
      assert.equal(result.failedRun?.status, "failed");
      assert.match(result.failedRun?.error ?? "", /server failed/);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
