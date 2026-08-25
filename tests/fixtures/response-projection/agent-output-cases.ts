import type { ProjectionAction } from "../../../src/mcp/response-projection/registry.js";

export interface AgentOutputExpectation {
  readonly expectedKeys: readonly string[];
  readonly requiredActionabilityKeys: readonly string[];
}

export interface AgentOutputDiagnosticExpectation extends AgentOutputExpectation {
  readonly includeDiagnostics: true;
}

export interface AgentOutputCase {
  readonly action: ProjectionAction;
  readonly publicRequest: Readonly<Record<string, unknown>>;
  readonly canonicalResultFactory: () => unknown;
  readonly expectedCompactKeys: readonly string[];
  readonly requiredActionabilityKeys: readonly string[];
  readonly compactResultKind?: "record" | "array" | "scalar";
  readonly executionMode: "read-only" | "dry-run" | "synthetic-handler-free";
  readonly fullExpectation?: AgentOutputExpectation;
  readonly diagnosticExpectation?: AgentOutputDiagnosticExpectation;
}

function compactCase(fixture: AgentOutputCase): AgentOutputCase {
  return Object.freeze({
    ...fixture,
    publicRequest: Object.freeze({ ...fixture.publicRequest }),
  });
}

const SYNTHETIC = "synthetic-handler-free" as const;
const REPO_ID = "projection-fixture";

function fixtureRange() {
  return { startLine: 1, startCol: 0, endLine: 5, endCol: 1 };
}

function fixtureEditSnippets() {
  return {
    before: "1 | OldName",
    after: "1 | NewName",
    beforeStartLine: 1,
    beforeEndLine: 1,
    afterStartLine: 1,
    afterEndLine: 1,
  };
}

function fixtureKindCounts() {
  return {
    function: 0,
    class: 1,
    interface: 0,
    type: 0,
    method: 0,
    variable: 0,
    module: 0,
    constructor: 0,
  };
}

function fixtureSymbolCard() {
  return {
    symbolId: "symbol-user-repository",
    repoId: REPO_ID,
    file: "src/user-repository.ts",
    range: fixtureRange(),
    kind: "class",
    name: "UserRepository",
    exported: true,
    version: { ledgerVersion: "v2", astFingerprint: "ast-fixture" },
  };
}

function fixtureDeltaPack() {
  return {
    repoId: REPO_ID,
    fromVersion: "v1",
    toVersion: "v2",
    changedSymbols: [
      {
        symbolId: "symbol-user-repository",
        changeType: "modified",
      },
    ],
    blastRadius: [
      {
        symbolId: "symbol-user",
        distance: 1,
        rank: 1,
        signal: "directDependent",
      },
    ],
  };
}

export const AGENT_OUTPUT_CASES = [
  compactCase({
    action: "symbol.search",
    publicRequest: { repoId: REPO_ID, query: "UserRepository" },
    canonicalResultFactory: () => ({
      repoId: REPO_ID,
      results: [
        {
          symbolId: "symbol-user-repository",
          name: "UserRepository",
          kind: "class",
          file: "src/user-repository.ts",
        },
      ],
      exactMatchFound: true,
      nextBestAction: {
        tool: "sdl.context",
        args: {
          repoId: REPO_ID,
          taskType: "explain",
          taskText: "Explain UserRepository.",
          budget: { maxTokens: 1000 },
          focusPaths: ["src/user-repository.ts"],
        },
        rationale: "Retrieve task-shaped context.",
      },
    }),
    expectedCompactKeys: ["repoId", "results", "exactMatchFound", "nextBestAction"],
    requiredActionabilityKeys: ["results", "nextBestAction"],
    executionMode: "read-only",
  }),
  compactCase({
    action: "symbol.getCard",
    publicRequest: { repoId: REPO_ID, symbolId: "symbol-user-repository" },
    canonicalResultFactory: () => ({
      card: {
        ...fixtureSymbolCard(),
        deps: { calls: ["loadUser"], callsOmitted: 1 },
      },
    }),
    expectedCompactKeys: ["card"],
    requiredActionabilityKeys: ["card"],
    executionMode: "read-only",
  }),
  compactCase({
    action: "symbol.edit",
    publicRequest: {
      repoId: REPO_ID,
      mode: "preview",
      symbolId: "symbol-user-repository",
      operation: { kind: "replaceBody", content: "return true;\n" },
    },
    canonicalResultFactory: () => ({
      mode: "preview",
      planHandle: "symbol-plan-fixture",
      symbolId: "symbol-user-repository",
      symbolName: "UserRepository",
      operation: "replaceBody",
      file: "src/user-repository.ts",
      writeTarget: "file",
      requiresApply: true,
      validation: {
        parseBefore: true,
        parseAfter: true,
        targetSymbolResolved: true,
      },
      fileEntries: [
        {
          file: "src/user-repository.ts",
          matchCount: 1,
          editMode: "replacePattern",
          snippets: fixtureEditSnippets(),
          indexedSource: true,
        },
      ],
    }),
    expectedCompactKeys: [
      "mode",
      "planHandle",
      "symbolId",
      "symbolName",
      "operation",
      "file",
      "writeTarget",
      "requiresApply",
      "validation",
      "fileEntries",
    ],
    requiredActionabilityKeys: ["planHandle", "fileEntries"],
    executionMode: "synthetic-handler-free",
  }),
  compactCase({
    action: "slice.build",
    publicRequest: {
      repoId: REPO_ID,
      entrySymbols: ["symbol-user-repository"],
    },
    canonicalResultFactory: () => ({
      sliceHandle: "slice-fixture",
      ledgerVersion: "v2",
      slice: {
        startSymbols: ["symbol-user-repository"],
        cards: [],
        edges: [],
      },
      relationshipNote: "One direct dependency.",
    }),
    expectedCompactKeys: ["sliceHandle"],
    requiredActionabilityKeys: ["sliceHandle"],
    executionMode: "read-only",
  }),
  compactCase({
    action: "slice.refresh",
    publicRequest: { repoId: REPO_ID, sliceHandle: "slice-fixture" },
    canonicalResultFactory: () => ({
      sliceHandle: "slice-fixture",
      knownVersion: "v1",
      currentVersion: "v2",
      delta: fixtureDeltaPack(),
    }),
    expectedCompactKeys: [
      "sliceHandle",
      "knownVersion",
      "currentVersion",
      "delta",
    ],
    requiredActionabilityKeys: ["sliceHandle", "delta"],
    executionMode: "read-only",
  }),
  compactCase({
    action: "slice.spillover.get",
    publicRequest: {
      repoId: REPO_ID,
      spilloverHandle: "spillover-fixture",
    },
    canonicalResultFactory: () => ({
      spilloverHandle: "spillover-fixture",
      cursor: "cursor-2",
      hasMore: true,
      symbols: [fixtureSymbolCard()],
    }),
    expectedCompactKeys: ["spilloverHandle", "cursor", "hasMore", "symbols"],
    requiredActionabilityKeys: ["cursor", "symbols"],
    executionMode: "read-only",
  }),
  compactCase({
    action: "delta.get",
    publicRequest: {
      repoId: REPO_ID,
      fromVersion: "v1",
      toVersion: "v2",
      preview: true,
      previewSampleSize: 1,
    },
    canonicalResultFactory: () => ({
      delta: {
        ...fixtureDeltaPack(),
        blastRadius: [],
        mode: "preview",
        totalChanges: 1,
        sampleSize: 1,
        largeDeltaWarning: "Narrow the version range.",
      },
      amplifiers: [
        {
          symbolId: "symbol-user-repository",
          growthRate: 1.5,
          previous: 1,
          current: 2,
        },
      ],
    }),
    expectedCompactKeys: ["delta"],
    requiredActionabilityKeys: ["delta"],
    executionMode: "read-only",
  }),
  compactCase({
    action: "pr.risk.analyze",
    publicRequest: {
      repoId: REPO_ID,
      fromVersion: "v1",
      toVersion: "v2",
      detail: "compact",
    },
    canonicalResultFactory: () => ({
      summary: {
        riskScore: 81,
        riskLevel: "high",
        changedCount: 1,
        filteredCount: 1,
        blastRadiusCount: 1,
        topRiskItem: "symbol-user-repository",
      },
      analysis: {
        repoId: REPO_ID,
        fromVersion: "v1",
        toVersion: "v2",
        riskScore: 81,
        riskLevel: "high",
        changedSymbolsCount: 1,
        blastRadiusCount: 1,
      },
      escalationRequired: true,
    }),
    expectedCompactKeys: ["summary", "analysis", "escalationRequired"],
    requiredActionabilityKeys: ["summary", "analysis"],
    executionMode: "read-only",
  }),
  compactCase({
    action: "code.needWindow",
    publicRequest: {
      repoId: REPO_ID,
      symbolId: "symbol-user-repository",
      reason: "Inspect the fixture implementation.",
      expectedLines: 5,
      identifiersToFind: ["UserRepository"],
    },
    canonicalResultFactory: () => ({
      approved: true,
      status: "approvedRaw",
      contentKind: "raw",
      symbolId: "symbol-user-repository",
      file: "src/user-repository.ts",
      range: fixtureRange(),
      code: "export class UserRepository {}",
      whyApproved: ["Bounded symbol window."],
      estimatedTokens: 12,
    }),
    expectedCompactKeys: [
      "approved",
      "symbolId",
      "file",
      "range",
      "code",
      "status",
      "contentKind",
    ],
    requiredActionabilityKeys: ["file", "code"],
    executionMode: "read-only",
  }),
  compactCase({
    action: "code.getSkeleton",
    publicRequest: { repoId: REPO_ID, symbolId: "symbol-user-repository" },
    canonicalResultFactory: () => ({
      skeleton: "export class UserRepository { find(): User }",
      file: "src/user-repository.ts",
      range: fixtureRange(),
      estimatedTokens: 16,
      originalLines: 5,
      truncated: false,
    }),
    expectedCompactKeys: ["file", "range", "skeleton"],
    requiredActionabilityKeys: ["skeleton", "file"],
    executionMode: "read-only",
  }),
  compactCase({
    action: "code.getHotPath",
    publicRequest: {
      repoId: REPO_ID,
      symbolId: "symbol-user-repository",
      identifiersToFind: ["find"],
    },
    canonicalResultFactory: () => ({
      excerpt: "find(): User { return this.users[0]; }",
      file: "src/user-repository.ts",
      range: fixtureRange(),
      estimatedTokens: 14,
      matchedIdentifiers: ["find"],
      matchedLineNumbers: [2],
      truncated: false,
    }),
    expectedCompactKeys: ["file", "range", "excerpt", "matchedIdentifiers"],
    requiredActionabilityKeys: ["excerpt", "matchedIdentifiers"],
    executionMode: "read-only",
  }),
  compactCase({
    action: "repo.register",
    publicRequest: { repoId: REPO_ID, rootPath: ".", dryRun: true },
    canonicalResultFactory: () => ({
      ok: true,
      repoId: REPO_ID,
      dryRun: true,
      changed: false,
      wouldChange: true,
      requiresUpdateExisting: false,
      message: "Repository would be registered.",
      configChanges: [{ field: "rootPath", before: null, after: "." }],
      proposedConfig: { rootPath: "." },
    }),
    expectedCompactKeys: [
      "ok",
      "dryRun",
      "changed",
      "wouldChange",
      "requiresUpdateExisting",
      "message",
      "configChanges",
      "proposedConfig",
    ],
    requiredActionabilityKeys: [
      "wouldChange",
      "configChanges",
      "proposedConfig",
    ],
    executionMode: "dry-run",
  }),
  compactCase({
    action: "repo.status",
    publicRequest: { repoId: REPO_ID, detail: "compact" },
    canonicalResultFactory: () => ({
      repoId: REPO_ID,
      rootAvailability: { status: "available" },
      latestVersionId: "v2",
      filesIndexed: 1,
      symbolsIndexed: 2,
      derivedState: {
        graphIntegrityState: "verified",
        nextBestAction: "No recovery required.",
      },
    }),
    expectedCompactKeys: [
      "repoId",
      "rootAvailability",
      "latestVersionId",
      "filesIndexed",
      "symbolsIndexed",
      "derivedState",
    ],
    requiredActionabilityKeys: ["derivedState"],
    executionMode: "read-only",
  }),
  compactCase({
    action: "repo.unregister",
    publicRequest: { repoId: REPO_ID, confirmRepoId: REPO_ID },
    canonicalResultFactory: () => ({
      ok: true,
      repoId: REPO_ID,
      removed: true,
    }),
    expectedCompactKeys: ["ok", "removed"],
    requiredActionabilityKeys: ["removed"],
    executionMode: "synthetic-handler-free",
  }),
  compactCase({
    action: "repo.overview",
    publicRequest: { repoId: REPO_ID, level: "stats" },
    canonicalResultFactory: () => ({
      repoId: REPO_ID,
      versionId: "v2",
      stats: {
        fileCount: 1,
        symbolCount: 2,
        edgeCount: 1,
        exportedSymbolCount: 1,
        byKind: fixtureKindCounts(),
        byEdgeType: { call: 1, import: 0, config: 0 },
        avgSymbolsPerFile: 2,
        avgEdgesPerSymbol: 0.5,
      },
      directories: [
        {
          path: "src",
          fileCount: 1,
          symbolCount: 2,
          exportedCount: 1,
          byKind: fixtureKindCounts(),
          exports: [],
          topByFanIn: [],
          topByChurn: [],
          estimatedFullTokens: 100,
          summaryTokens: 20,
        },
      ],
    }),
    expectedCompactKeys: ["repoId", "stats", "directories"],
    requiredActionabilityKeys: ["stats", "directories"],
    executionMode: "read-only",
  }),
  compactCase({
    action: "index.refresh",
    publicRequest: { repoId: REPO_ID, mode: "incremental" },
    canonicalResultFactory: () => ({
      ok: true,
      repoId: REPO_ID,
      async: true,
      operationId: "index-operation-fixture",
      message: "Incremental refresh queued.",
    }),
    expectedCompactKeys: ["ok", "async", "operationId", "message"],
    requiredActionabilityKeys: ["operationId", "message"],
    executionMode: "synthetic-handler-free",
  }),
  compactCase({
    action: "policy.get",
    publicRequest: { repoId: REPO_ID },
    canonicalResultFactory: () => ({
      policy: {
        maxWindowLines: 200,
        maxWindowTokens: 4000,
        requireIdentifiers: true,
        allowBreakGlass: false,
      },
    }),
    expectedCompactKeys: ["policy"],
    requiredActionabilityKeys: ["policy"],
    executionMode: "read-only",
  }),
  compactCase({
    action: "policy.set",
    publicRequest: {
      repoId: REPO_ID,
      policyPatch: { maxWindowLines: 200 },
    },
    canonicalResultFactory: () => ({ ok: true, repoId: REPO_ID }),
    expectedCompactKeys: ["ok"],
    requiredActionabilityKeys: ["ok"],
    executionMode: "synthetic-handler-free",
  }),
  compactCase({
    action: "usage.stats",
    publicRequest: { detail: "compact" },
    canonicalResultFactory: () => ({
      session: {
        sessionId: "usage-session-fixture",
        startedAt: "2026-08-09T00:00:00.000Z",
        timestamp: "2026-08-09T00:00:01.000Z",
        processId: 4242,
        process: {
          pid: 4242,
          startedAt: "2026-08-09T00:00:00.000Z",
          nested: {
            sessionId: "nested-usage-session",
            timestamp: "2026-08-09T00:00:02.000Z",
          },
        },
        totalSdlTokens: 120,
        totalRawEquivalent: 500,
        totalSavedTokens: 380,
        overallSavingsPercent: 76,
        toolBreakdown: [
          {
            tool: "sdl.symbol.search",
            sdlTokens: 120,
            rawEquivalent: 500,
            savedTokens: 380,
            callCount: 2,
          },
        ],
        callCount: 2,
      },
    }),
    expectedCompactKeys: ["aggregate", "topTools"],
    requiredActionabilityKeys: [],
    executionMode: "read-only",
  }),
  compactCase({
    action: "file.read",
    publicRequest: { repoId: REPO_ID, filePath: "README.md" },
    canonicalResultFactory: () => ({
      filePath: "README.md",
      content: "# Fixture\n",
      bytes: 10,
      totalLines: 1,
      returnedLines: 1,
    }),
    expectedCompactKeys: ["filePath", "content"],
    requiredActionabilityKeys: ["filePath", "content"],
    executionMode: "read-only",
  }),
  compactCase({
    action: "file.write",
    publicRequest: {
      repoId: REPO_ID,
      filePath: "fixture.txt",
      editMode: "overwrite",
      content: "fixture\n",
    },
    canonicalResultFactory: () => ({
      filePath: "fixture.txt",
      bytesWritten: 8,
      linesWritten: 1,
      mode: "overwrite",
      replacementCount: 1,
      snippets: fixtureEditSnippets(),
    }),
    expectedCompactKeys: ["filePath", "mode", "replacementCount", "snippets"],
    requiredActionabilityKeys: ["filePath", "snippets"],
    executionMode: "synthetic-handler-free",
  }),
  compactCase({
    action: "search.edit",
    publicRequest: {
      repoId: REPO_ID,
      mode: "preview",
      operations: [
        {
          id: "rename-fixture",
          targeting: "text",
          query: {
            literal: "OldName",
            replacement: "NewName",
            global: true,
          },
          editMode: "replacePattern",
        },
      ],
    },
    canonicalResultFactory: () => ({
      mode: "preview",
      planHandle: "search-plan-fixture",
      defaultCreateBackup: false,
      applyArgs: {
        mode: "apply",
        repoId: REPO_ID,
        planHandle: "search-plan-fixture",
        createBackup: false,
      },
      filesMatched: 1,
      matchesFound: 1,
      filesEligible: 1,
      fileEntries: [
        {
          file: "src/user-repository.ts",
          matchCount: 1,
          editMode: "replacePattern",
          snippets: fixtureEditSnippets(),
          indexedSource: true,
        },
      ],
      requiresApply: true,
    }),
    expectedCompactKeys: [
      "mode",
      "planHandle",
      "defaultCreateBackup",
      "applyArgs",
      "filesMatched",
      "matchesFound",
      "filesEligible",
      "fileEntries",
      "requiresApply",
    ],
    requiredActionabilityKeys: ["planHandle", "fileEntries"],
    executionMode: "synthetic-handler-free",
  }),
  compactCase({
    action: "semantic.enrichment.refresh",
    publicRequest: { repoId: REPO_ID, mode: "incremental", dryRun: true },
    canonicalResultFactory: () => ({
      ok: true,
      repoId: REPO_ID,
      enabled: true,
      dryRun: true,
      installPolicy: "never",
      selections: [],
      runs: [],
      scipResults: [],
      skipped: [
        {
          providerType: "semanticEnrichment",
          reason: "Dry-run fixture; no provider executed.",
        },
      ],
    }),
    expectedCompactKeys: [
      "ok",
      "enabled",
      "dryRun",
      "installPolicy",
      "selections",
      "runs",
      "scipResults",
      "skipped",
    ],
    requiredActionabilityKeys: ["selections", "runs"],
    executionMode: "dry-run",
  }),
  compactCase({
    action: "semantic.enrichment.status",
    publicRequest: { repoId: REPO_ID },
    canonicalResultFactory: () => ({
      ok: true,
      repoId: REPO_ID,
      enabled: true,
      autoRunOnIndexRefresh: false,
      installPolicy: "never",
      selections: [
        {
          languageId: "typescript",
          selected: {
            providerType: "scip",
            providerId: "scip",
            canAffectPass2: true,
          },
          skipped: [
            { providerType: "lsp", reason: "Provider unavailable in fixture." },
          ],
        },
      ],
      lastRuns: [
        {
          runId: "run-fixture",
          repoId: REPO_ID,
          providerType: "scip",
          providerId: "scip",
          languages: ["typescript"],
          status: "completed",
          startedAt: "2026-08-09T00:00:00.000Z",
          finishedAt: "2026-08-09T00:00:01.000Z",
          documentsProcessed: 3,
          symbolsMatched: 2,
          edgesCreated: 1,
          edgesUpgraded: 0,
          edgesReplaced: 0,
          edgesSkipped: 0,
          diagnosticsCount: 2,
          precisionScore: 1,
          precisionMeasurement: "measured",
          precisionBasis: "operational-composite",
        },
      ],
    }),
    expectedCompactKeys: [
      "ok",
      "enabled",
      "availability",
      "selections",
      "latestRun",
      "warnings",
    ],
    requiredActionabilityKeys: ["enabled", "selections"],
    executionMode: "read-only",
  }),
  compactCase({
    action: "agent.feedback",
    publicRequest: {
      repoId: REPO_ID,
      usefulSymbols: ["symbol-user-repository"],
      taskType: "implement",
      taskText: "Verify projection fixtures.",
    },
    canonicalResultFactory: () => ({
      ok: true,
      feedbackId: "feedback-fixture",
      repoId: REPO_ID,
      versionId: "v2",
      symbolsRecorded: 1,
    }),
    expectedCompactKeys: ["ok", "feedbackId"],
    requiredActionabilityKeys: ["ok", "feedbackId"],
    executionMode: "synthetic-handler-free",
  }),
  compactCase({
    action: "agent.feedback.query",
    publicRequest: { repoId: REPO_ID },
    canonicalResultFactory: () => ({
      repoId: REPO_ID,
      feedback: [
        {
          feedbackId: "feedback-fixture",
          versionId: "v2",
          sliceHandle: "slice-fixture",
          usefulSymbols: ["symbol-user-repository"],
          missingSymbols: [],
          taskTags: ["projection"],
          taskType: "implement",
          taskText: "Verify projection fixtures.",
          createdAt: "2026-08-09T00:00:00.000Z",
        },
      ],
      aggregatedStats: {
        totalFeedback: 1,
        topUsefulSymbols: [
          {
            symbolId: "symbol-user-repository",
            count: 1,
          },
        ],
        topMissingSymbols: [],
      },
      hasMore: true,
    }),
    expectedCompactKeys: ["repoId", "state", "feedback", "aggregatedStats", "hasMore"],
    requiredActionabilityKeys: ["feedback", "aggregatedStats"],
    executionMode: "read-only",
  }),
  compactCase({
    action: "buffer.push",
    publicRequest: {
      repoId: REPO_ID,
      eventType: "change",
      filePath: "src/user-repository.ts",
      content: "export class UserRepository {}\n",
      version: 1,
      dirty: true,
      timestamp: "2026-08-09T00:00:00.000Z",
    },
    canonicalResultFactory: () => ({
      accepted: true,
      repoId: REPO_ID,
      overlayVersion: 1,
      parseScheduled: true,
      checkpointScheduled: true,
      warnings: ["Synthetic buffer fixture; no handler executed."],
    }),
    expectedCompactKeys: [
      "accepted",
      "overlayVersion",
      "parseScheduled",
      "checkpointScheduled",
      "warnings",
    ],
    requiredActionabilityKeys: ["accepted", "overlayVersion"],
    executionMode: "synthetic-handler-free",
  }),
  compactCase({
    action: "buffer.checkpoint",
    publicRequest: { repoId: REPO_ID },
    canonicalResultFactory: () => ({
      repoId: REPO_ID,
      requested: true,
      checkpointId: "checkpoint-fixture",
      pending: true,
      pendingBuffers: 1,
      message: "Checkpoint queued.",
    }),
    expectedCompactKeys: [
      "repoId",
      "requested",
      "checkpointId",
      "pending",
      "pendingBuffers",
      "message",
    ],
    requiredActionabilityKeys: ["checkpointId", "pendingBuffers"],
    executionMode: "synthetic-handler-free",
  }),
  compactCase({
    action: "buffer.status",
    publicRequest: { repoId: REPO_ID },
    canonicalResultFactory: () => ({
      repoId: REPO_ID,
      enabled: true,
      pendingBuffers: 1,
      dirtyBuffers: 1,
      parseQueueDepth: 1,
      checkpointPending: true,
      lastBufferEventAt: "2026-08-09T00:00:00.000Z",
      lastCheckpointAt: "2026-08-09T00:00:01.000Z",
      reconcileQueueDepth: 1,
      reconcileInflight: true,
    }),
    expectedCompactKeys: [
      "repoId",
      "enabled",
      "state",
      "pendingBuffers",
      "dirtyBuffers",
      "parseQueueDepth",
      "checkpointPending",
      "reconcileQueueDepth",
      "reconcileInflight",
    ],
    requiredActionabilityKeys: ["pendingBuffers", "checkpointPending"],
    executionMode: "read-only",
  }),
  compactCase({
    action: "runtime.execute",
    publicRequest: {
      repoId: REPO_ID,
      runtime: "node",
      code: "console.log('fixture')",
    },
    canonicalResultFactory: () => ({
      status: "success",
      exitCode: 0,
      signal: null,
      durationMs: 1,
      stdoutSummary: "fixture",
      stderrSummary: "",
      artifactHandle: "runtime-fixture",
      nextAction: {
        kind: "queryOutput",
        action: "runtime.queryOutput",
        message: "Query the persisted output.",
        queryTerms: ["fixture"],
      },
      truncation: {
        stdoutTruncated: false,
        stderrTruncated: false,
        totalStdoutBytes: 7,
        totalStderrBytes: 0,
      },
    }),
    expectedCompactKeys: ["status", "artifactHandle", "nextAction"],
    requiredActionabilityKeys: ["status", "artifactHandle", "nextAction"],
    executionMode: "synthetic-handler-free",
  }),
  compactCase({
    action: "runtime.queryOutput",
    publicRequest: {
      repoId: REPO_ID,
      artifactHandle: "runtime-fixture",
      queryTerms: ["fixture"],
    },
    canonicalResultFactory: () => ({
      artifactHandle: "runtime-fixture",
      excerpts: [
        {
          source: "stdout",
          lineStart: 1,
          lineEnd: 1,
          content: "fixture",
        },
      ],
      totalLines: 1,
      totalBytes: 7,
      searchedStreams: ["stdout"],
      matchStatus: "matched",
      matchCount: 1,
      nextCursor: { stream: "stdout", afterLine: 1 },
    }),
    expectedCompactKeys: [
      "artifactHandle",
      "excerpts",
      "matchStatus",
      "nextAction",
    ],
    requiredActionabilityKeys: ["artifactHandle", "excerpts", "nextAction"],
    executionMode: "read-only",
  }),
  compactCase({
    action: "response.get",
    publicRequest: {
      repoId: REPO_ID,
      handle: "response-fixture",
      jsonPath: "results",
    },
    canonicalResultFactory: () => ({
      handle: "response-fixture",
      full: false,
      complete: false,
      truncated: true,
      contentKind: "json",
      content: { results: [{ symbolId: "symbol-user-repository" }] },
      metadata: {
        handle: "response-fixture",
        repoId: REPO_ID,
        toolName: "sdl.symbol.search",
        originalBytes: 512,
        contentKind: "json",
      },
      range: { offsetBytes: 0, returnedBytes: 128, totalBytes: 512 },
      pagination: {
        offset: 0,
        limit: 1,
        total: 2,
        returned: 1,
        hasMore: true,
        nextOffset: 1,
      },
      nextAction: {
        action: "response.get",
        args: {
          repoId: REPO_ID,
          handle: "response-fixture",
          view: "model",
          cursor: { offsetBytes: 0 },
          full: false,
          maxBytes: 8_192,
          offsetBytes: 0,
          raw: false,
          jsonPath: "results",
          offset: 1,
          limit: 1,
        },
      },
    }),
    expectedCompactKeys: [
      "handle",
      "full",
      "complete",
      "truncated",
      "contentKind",
      "content",
      "metadata",
      "range",
      "pagination",
      "nextAction",
    ],
    requiredActionabilityKeys: ["handle", "content"],
    executionMode: "read-only",
  }),
  compactCase({
    action: "memory.store",
    publicRequest: {
      repoId: REPO_ID,
      type: "pattern",
      title: "Projection fixture",
      content: "Canonical synthetic memory content.",
    },
    canonicalResultFactory: () => ({
      ok: true,
      memoryId: "memory-fixture",
      created: true,
      deduplicated: false,
    }),
    expectedCompactKeys: ["ok", "memoryId"],
    requiredActionabilityKeys: ["ok", "memoryId"],
    executionMode: "synthetic-handler-free",
  }),
  compactCase({
    action: "memory.query",
    publicRequest: { repoId: REPO_ID, query: "projection fixture" },
    canonicalResultFactory: () => ({
      repoId: REPO_ID,
      memories: [
        {
          memoryId: "memory-fixture",
          type: "pattern",
          title: "Projection fixture",
          content: "Canonical synthetic memory content.",
          confidence: 0.9,
          stale: false,
          linkedSymbols: ["symbol-user-repository"],
          tags: ["projection"],
        },
      ],
      total: 1,
      hasMore: true,
      nextOffset: 1,
    }),
    expectedCompactKeys: ["memories", "total", "hasMore", "nextOffset"],
    requiredActionabilityKeys: ["memories", "nextOffset"],
    executionMode: "read-only",
  }),
  compactCase({
    action: "memory.remove",
    publicRequest: { repoId: REPO_ID, memoryId: "memory-fixture" },
    canonicalResultFactory: () => ({ ok: true, memoryId: "memory-fixture" }),
    expectedCompactKeys: ["ok", "memoryId"],
    requiredActionabilityKeys: ["ok", "memoryId"],
    executionMode: "synthetic-handler-free",
  }),
  compactCase({
    action: "memory.surface",
    publicRequest: { repoId: REPO_ID, memoryId: "memory-fixture" },
    canonicalResultFactory: () => ({
      repoId: REPO_ID,
      memories: [
        {
          memoryId: "memory-fixture",
          type: "pattern",
          title: "Projection fixture",
          content: "Canonical synthetic memory content.",
          confidence: 0.9,
          stale: false,
          linkedSymbols: ["symbol-user-repository"],
          tags: ["projection"],
        },
      ],
    }),
    expectedCompactKeys: ["memories"],
    requiredActionabilityKeys: ["memories"],
    executionMode: "synthetic-handler-free",
  }),
  compactCase({
    action: "dataPick",
    publicRequest: {
      input: { name: "UserRepository", file: "src/user-repository.ts" },
      fields: { name: "name", file: "file" },
    },
    canonicalResultFactory: () => ({
      name: "UserRepository",
      file: "src/user-repository.ts",
    }),
    expectedCompactKeys: ["name", "file"],
    requiredActionabilityKeys: ["name", "file"],
    executionMode: "read-only",
  }),
  compactCase({
    action: "dataMap",
    publicRequest: {
      input: [{ name: "UserRepository", file: "src/user-repository.ts" }],
      fields: { name: "name", file: "file" },
    },
    canonicalResultFactory: () => [
      {
        name: "UserRepository",
        file: "src/user-repository.ts",
      },
    ],
    expectedCompactKeys: ["name", "file"],
    requiredActionabilityKeys: ["name", "file"],
    compactResultKind: "array",
    executionMode: "read-only",
  }),
  compactCase({
    action: "dataFilter",
    publicRequest: {
      input: [{ name: "UserRepository", kind: "class" }],
      clauses: [{ path: "kind", op: "eq", value: "class" }],
    },
    canonicalResultFactory: () => [
      {
        name: "UserRepository",
        kind: "class",
      },
    ],
    expectedCompactKeys: ["name", "kind"],
    requiredActionabilityKeys: ["name", "kind"],
    compactResultKind: "array",
    executionMode: "read-only",
  }),
  compactCase({
    action: "dataSort",
    publicRequest: {
      input: [{ name: "Beta" }, { name: "Alpha" }],
      by: { path: "name", direction: "asc" },
    },
    canonicalResultFactory: () => [{ name: "Alpha" }, { name: "Beta" }],
    expectedCompactKeys: ["name"],
    requiredActionabilityKeys: ["name"],
    compactResultKind: "array",
    executionMode: "read-only",
  }),
  compactCase({
    action: "dataTemplate",
    publicRequest: {
      input: { name: "UserRepository" },
      template: "Symbol: {name}",
    },
    canonicalResultFactory: () => "Symbol: UserRepository",
    expectedCompactKeys: [],
    requiredActionabilityKeys: [],
    compactResultKind: "scalar",
    executionMode: "read-only",
  }),
  compactCase({
    action: "workflowContinuationGet",
    publicRequest: { handle: "continuation-fixture" },
    canonicalResultFactory: () => ({
      data: [{ symbolId: "symbol-user-repository" }],
      totalTokens: 12,
      hasMore: true,
      nextOffset: 1,
    }),
    expectedCompactKeys: ["data", "hasMore", "nextOffset"],
    requiredActionabilityKeys: ["data", "nextOffset"],
    executionMode: "read-only",
  }),
  compactCase({
    action: "action.search",
    publicRequest: { query: "symbol.search", limit: 1 },
    canonicalResultFactory: () => ({
      actions: [{ action: "symbol.search", description: "Search symbols." }],
      summary: { total: 1 },
      total: 1,
      hasMore: false,
      nextAction: { id: "manual", args: { actions: ["symbol.search"] } },
    }),
    expectedCompactKeys: [
      "actions",
      "summary",
      "total",
      "nextAction",
    ],
    requiredActionabilityKeys: ["actions", "nextAction"],
    executionMode: "read-only",
  }),
  compactCase({
    action: "info",
    publicRequest: { redactPaths: true },
    canonicalResultFactory: () => ({
      version: "0.13.3",
      runtime: {
        node: "24",
        platform: "win32",
        arch: "x64",
      },
      config: {
        path: "sdlmcp.config.json",
        exists: true,
        loaded: true,
      },
      logging: {
        path: null,
        consoleMirroring: false,
        fallbackUsed: false,
      },
      ladybug: {
        available: true,
        activePath: null,
      },
      native: {
        available: false,
        sourcePath: null,
        disabledByEnv: true,
        reason: "Synthetic fixture uses the TypeScript fallback.",
      },
      warnings: ["Synthetic fixture values."],
      misconfigurations: ["memory.enabled is disabled for this fixture."],
    }),
    expectedCompactKeys: [
      "version",
      "runtime",
      "config",
      "ladybug",
      "native",
      "warnings",
      "misconfigurations",
    ],
    requiredActionabilityKeys: ["version", "misconfigurations"],
    executionMode: "read-only",
  }),
  compactCase({
    action: "manual",
    publicRequest: { actions: ["symbol.search"] },
    canonicalResultFactory: () => ({
      manual:
        "function symbolSearch(p: { repoId: string; query: string }): object",
    }),
    expectedCompactKeys: ["manual"],
    requiredActionabilityKeys: ["manual"],
    executionMode: "read-only",
  }),
  compactCase({
    action: "context",
    publicRequest: {
      repoId: REPO_ID,
      taskType: "explain",
      taskText: "Explain the synthetic fixture.",
      budget: { maxTokens: 1000 },
    },
    canonicalResultFactory: () => ({
      status: "complete",
      taskType: "explain",
      retrieval: {
        level: "lexical",
        lanes: [{ id: "exactIdentifier", available: true }],
      },
      evidence: [
        {
          symbolId: "symbol-user-repository",
          path: "src/user-repository.ts",
          rank: 1,
          tier: 0,
          rung: "card",
          lanes: ["exactIdentifier"],
        },
      ],
      edges: [
        {
          from: "symbol-user-repository",
          to: "symbol-user",
          kind: "call",
          confidencePermille: 950,
        },
      ],
      omitted: {
        total: 1,
        byReason: { budget: 1 },
        highestRanked: [
          {
            symbolId: "symbol-user",
            path: "src/user.ts",
            rank: 2,
            tier: 1,
            rung: "card",
            reason: "budget",
            action: {
              id: "symbol.getCard",
              args: { symbolId: "symbol-user" },
            },
          },
        ],
      },
      nextActions: [
        {
          id: "symbol.getCard",
          args: { symbolId: "symbol-user-repository" },
        },
      ],
    }),
    expectedCompactKeys: [
      "status",
      "taskType",
      "retrieval",
      "evidence",
      "edges",
      "omitted",
      "nextAction",
    ],
    requiredActionabilityKeys: ["evidence"],
    executionMode: "read-only",
  }),
  compactCase({
    action: "file",
    publicRequest: {
      repoId: REPO_ID,
      op: "read",
      filePath: "README.md",
    },
    canonicalResultFactory: () => ({
      filePath: "README.md",
      content: "# Fixture\n",
      bytes: 10,
      totalLines: 1,
      returnedLines: 1,
    }),
    expectedCompactKeys: ["filePath", "content"],
    requiredActionabilityKeys: ["filePath", "content"],
    executionMode: "synthetic-handler-free",
  }),
  compactCase({
    action: "retrieve",
    publicRequest: {
      repoId: REPO_ID,
      op: "symbolSearch",
      args: { query: "UserRepository", limit: 1 },
    },
    canonicalResultFactory: () => ({
      results: [
        {
          symbolId: "symbol-user-repository",
          name: "UserRepository",
          kind: "class",
          file: "src/user-repository.ts",
        },
      ],
      exactMatchFound: true,
    }),
    expectedCompactKeys: ["results", "exactMatchFound"],
    requiredActionabilityKeys: ["results"],
    executionMode: "read-only",
  }),
  compactCase({
    action: "workflow",
    publicRequest: {
      repoId: REPO_ID,
      steps: [{ fn: "repoStatus", args: {} }],
    },
    canonicalResultFactory: () => ({
      results: [
        {
          fn: "repoStatus",
          status: "ok",
          result: {
            repoId: REPO_ID,
            rootAvailability: { status: "available" },
            latestVersionId: "v2",
            filesIndexed: 1,
            symbolsIndexed: 2,
            derivedState: { graphIntegrityState: "verified" },
          },
        },
      ],
    }),
    expectedCompactKeys: ["results"],
    requiredActionabilityKeys: ["results"],
    executionMode: "synthetic-handler-free",
  }),
] as const satisfies readonly AgentOutputCase[];

/**
 * These families intentionally pin only today's safe compact boundary. Later
 * migration tasks own their family-specific full and diagnostic RED assertions.
 */
export const AGENT_OUTPUT_PROFILE_CASES = Object.freeze([
  Object.freeze({
    name: "compact",
    detail: "compact",
    includeDiagnostics: false,
    budgetClass: "profile",
  }),
  Object.freeze({
    name: "full",
    detail: "full",
    includeDiagnostics: false,
    budgetClass: "full",
  }),
  Object.freeze({
    name: "diagnostic",
    detail: "compact",
    includeDiagnostics: true,
    budgetClass: "diagnostic",
  }),
] as const);

export const AGENT_OUTPUT_SUMMARY_FACT_KEYS = Object.freeze([
  "status",
  "mode",
  "total",
  "count",
  "callCount",
  "changedCount",
  "filteredCount",
  "blastRadiusCount",
  "truncated",
  "complete",
  "hasMore",
] as const);

/** Summary facts intentionally omitted from prose because they are non-summary data. */
export const AGENT_OUTPUT_SUMMARY_FACT_EXCLUSIONS_BY_ACTION = Object.freeze({
  "action.search": Object.freeze(["$.recovery"]),
  context: Object.freeze(["$.recovery"]),
} satisfies Readonly<Record<string, readonly string[]>>);

export const AGENT_OUTPUT_TOKEN_BUDGETS = Object.freeze({
  summary: 120,
  empty: 200,
  error: 200,
  small: 500,
  compact: 1_000,
  standard: 2_000,
  full: 8_000,
  diagnostic: 8_000,
} as const);

export const AGENT_OUTPUT_DISALLOWED_FIELD_NAMES = Object.freeze([
  "_displayFooter",
  "_packedStats",
  "actionsTaken",
  "etagCache",
  "projectionStats",
  "retrievalEvidence",
  "structuredContent",
] as const);

export const AGENT_OUTPUT_DISALLOWED_FIELDS_BY_ACTION = Object.freeze({
  "usage.stats": Object.freeze([
    "pid",
    "process",
    "processId",
    "sessionId",
    "startedAt",
    "timestamp",
  ] as const),
} satisfies Partial<Record<ProjectionAction, readonly string[]>>);

export const AGENT_OUTPUT_DIAGNOSTIC_FIELD_NAMES = Object.freeze([
  "diagnostics",
] as const);

export const AGENT_OUTPUT_DISALLOWED_PATH_PATTERNS = Object.freeze([
  String.raw`(?:[A-Za-z]:[\\/]|\\\\\?\\)`,
] as const);

export const DEFERRED_FAMILY_ASSERTIONS = Object.freeze([
  "retrieval-family-full-detail",
  "mutation-family-recovery",
  "runtime-family-diagnostics",
] as const);
