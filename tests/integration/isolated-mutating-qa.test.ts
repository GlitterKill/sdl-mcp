import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { resolveCliConfigPath } from "../../dist/config/configPath.js";
import { loadConfig } from "../../dist/config/loadConfig.js";
import { resolveGraphDbPath } from "../../dist/db/graph-db-path.js";
import { PUBLIC_TOOL_CONTRACT_CASES } from "../fixtures/tool-contract/public-tool-contract-cases.ts";

const cleanupRoots: string[] = [];

afterEach(() => {
  const roots = cleanupRoots.splice(0);
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
  for (const root of roots) {
    assert.equal(existsSync(root), false, `teardown leaked ${root}`);
  }
});

function makeQaInputs(scenario: unknown[]) {
  const root = mkdtempSync(join(tmpdir(), "sdl-isolated-qa-integration-"));
  cleanupRoots.push(root);
  const fixtureRoot = join(root, "fixture");
  const repoRoot = join(fixtureRoot, "repo");
  const activeDbPath = join(root, "production.lbug");
  const configPath = join(root, "qa-config.json");
  const scenarioPath = join(root, "scenario.json");
  mkdirSync(repoRoot, { recursive: true });
  writeFileSync(join(repoRoot, "index.ts"), "export const qaValue = 1;\n");
  writeFileSync(join(repoRoot, "second.ts"), "export const qaSecond = 1;\n");
  writeFileSync(join(repoRoot, "notes.txt"), "oldName\n");
  writeFileSync(activeDbPath, "production-sentinel-bytes");
  writeFileSync(
    configPath,
    JSON.stringify({
      repos: [],
      policy: {},
      codeMode: { enabled: true, exclusive: false },
      indexing: {
        engine: "typescript",
        enableFileWatching: false,
        algorithmRefresh: { enabled: false },
      },
      semantic: { enabled: false },
      semanticEnrichment: {
        enabled: true,
        autoRunOnIndexRefresh: false,
        installPolicy: "never",
      },
      liveIndex: { enabled: true },
      prefetch: { enabled: false },
      memory: { enabled: true },
    }),
  );
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  return {
    root,
    fixtureRoot,
    repoRoot,
    activeDbPath,
    configPath,
    scenarioPath,
  };
}

const HASH_CHUNK_BYTES = 64 * 1024;

function updateDigestWithPath(
  digest: ReturnType<typeof createHash>,
  absolutePath: string,
  relativePath: string,
): void {
  digest.update(relativePath);
  digest.update("\0");

  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(absolutePath);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      digest.update("missing\0");
      return;
    }
    throw error;
  }

  if (stat.isSymbolicLink()) {
    digest.update(`symlink:${stat.mode}\0`);
    digest.update(readlinkSync(absolutePath));
    digest.update("\0");
    return;
  }
  if (stat.isDirectory()) {
    digest.update(`directory:${stat.mode}\0`);
    for (const child of readdirSync(absolutePath).sort()) {
      updateDigestWithPath(
        digest,
        join(absolutePath, child),
        `${relativePath}/${child}`,
      );
    }
    return;
  }
  if (!stat.isFile()) {
    digest.update(`other:${stat.mode}\0`);
    return;
  }

  digest.update(`file:${stat.mode}:${stat.size}\0`);
  const handle = openSync(absolutePath, "r");
  const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  try {
    let bytesRead = 0;
    while (
      (bytesRead = readSync(handle, chunk, 0, chunk.length, null)) > 0
    ) {
      digest.update(chunk.subarray(0, bytesRead));
    }
  } finally {
    closeSync(handle);
  }
}

function snapshotTrackedWorktree(): string {
  const worktreeRoot = process.cwd();
  const files = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: worktreeRoot, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  assert.ok(
    files.length > 0,
    "active worktree has no tracked or non-ignored untracked files",
  );

  const digest = createHash("sha256");
  for (const file of files) {
    updateDigestWithPath(digest, join(worktreeRoot, file), file);
  }
  return digest.digest("hex");
}

function snapshotActiveDatabaseFamily(): {
  dbPath: string;
  digest: string;
} {
  const configPath = resolveCliConfigPath(undefined, "read");
  assert.equal(existsSync(configPath), true, "active SDL config is missing");
  const dbPath = resolveGraphDbPath(loadConfig(configPath), configPath);
  assert.equal(isAbsolute(dbPath), true, "active DB path must be absolute");
  assert.notEqual(dirname(dbPath), dbPath, "refusing a filesystem root DB path");

  const dbName = basename(dbPath);
  const family = readdirSync(dirname(dbPath))
    .filter((name) => name === dbName || name.startsWith(`${dbName}.`))
    .sort();
  assert.ok(
    family.includes(dbName),
    `active DB path could not be resolved safely: ${dbPath}`,
  );

  // Plain read-only file handles hash the active DB bytes without opening it
  // through LadybugDB or following symlinks outside the DB family.
  const digest = createHash("sha256");
  const familyRoot = dirname(dbPath);
  for (const entry of family) {
    updateDigestWithPath(digest, join(familyRoot, entry), entry);
  }
  return { dbPath, digest: digest.digest("hex") };
}

describe("isolated mutating QA process", () => {
  it(
    "registers and mutates only through its owned server, then removes the QA database family",
    { timeout: 120_000 },
    async () => {
      const { runIsolatedMutatingQa } = await import(
        "../../scripts/run-isolated-mutating-qa.mjs"
      );
      const inputs = makeQaInputs([]);
      writeFileSync(
        inputs.scenarioPath,
        JSON.stringify([
          {
            tool: "sdl.repo.register",
            arguments: {
              repoId: "qa-fixture",
              rootPath: inputs.repoRoot,
            },
          },
          {
            tool: "sdl.index.refresh",
            arguments: { repoId: "qa-fixture", mode: "full" },
          },
        ]),
      );
      const activeBytes = readFileSync(inputs.activeDbPath);

      const receipt = await runIsolatedMutatingQa({
        activeDbPath: inputs.activeDbPath,
        fixtureRoot: inputs.fixtureRoot,
        configPath: inputs.configPath,
        scenarioPath: inputs.scenarioPath,
        projectRoot: process.cwd(),
      });

      assert.deepEqual(receipt.completedTools, [
        "sdl.repo.register",
        "sdl.index.refresh",
      ]);
      assert.equal(receipt.closed, true);
      assert.equal(receipt.sidecarsClean, true);
      assert.equal(receipt.cleaned, true);
      assert.equal(existsSync(receipt.qaDbPath), false);
      assert.equal(existsSync(`${receipt.qaDbPath}.wal`), false);
      assert.deepEqual(readFileSync(inputs.activeDbPath), activeBytes);
    },
  );

  it(
    "preflights unknown tools and retains the exact QA fixture paths",
    { timeout: 120_000 },
    async () => {
      const { runIsolatedMutatingQa } = await import(
        "../../scripts/run-isolated-mutating-qa.mjs"
      );
      const inputs = makeQaInputs([
        {
          tool: "sdl.not-a-tool",
          arguments: {},
        },
      ]);
      const activeBytes = readFileSync(inputs.activeDbPath);
      let retainedRoot: string | undefined;

      await assert.rejects(
        runIsolatedMutatingQa({
          activeDbPath: inputs.activeDbPath,
          fixtureRoot: inputs.fixtureRoot,
          configPath: inputs.configPath,
          scenarioPath: inputs.scenarioPath,
          projectRoot: process.cwd(),
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          const qaError = error as Error & {
            qaDbPath?: string;
            qaRootPath?: string;
          };
          assert.match(error.message, /sdl\.not-a-tool/);
          assert.match(error.message, /not available/i);
          assert.equal(typeof qaError.qaDbPath, "string");
          assert.equal(typeof qaError.qaRootPath, "string");
          assert.equal(qaError.qaDbPath, join(qaError.qaRootPath!, "qa.lbug"));
          assert.equal(existsSync(qaError.qaRootPath!), true);
          assert.equal(existsSync(inputs.fixtureRoot), true);
          retainedRoot = qaError.qaRootPath;
          return true;
        },
      );

      assert.deepEqual(readFileSync(inputs.activeDbPath), activeBytes);
      if (retainedRoot) {
        cleanupRoots.push(retainedRoot);
      }
    },
  );

  it(
    "reports structured validation details from an available child tool",
    { timeout: 120_000 },
    async () => {
      const { runIsolatedMutatingQa } = await import(
        "../../scripts/run-isolated-mutating-qa.mjs"
      );
      const inputs = makeQaInputs([
        {
          tool: "sdl.repo.register",
          arguments: {},
        },
      ]);
      let retainedRoot: string | undefined;

      await assert.rejects(
        runIsolatedMutatingQa({
          activeDbPath: inputs.activeDbPath,
          fixtureRoot: inputs.fixtureRoot,
          configPath: inputs.configPath,
          scenarioPath: inputs.scenarioPath,
          projectRoot: process.cwd(),
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          const qaError = error as Error & { qaRootPath?: string };
          assert.match(error.message, /QA tool failed: sdl\.repo\.register/);
          assert.match(error.message, /isError=true/);
          assert.match(error.message, /code=VALIDATION_ERROR/);
          assert.match(error.message, /classification=invalid_input/);
          assert.match(error.message, /Invalid tool arguments/);
          assert.equal(existsSync(qaError.qaRootPath!), true);
          retainedRoot = qaError.qaRootPath;
          return true;
        },
      );

      if (retainedRoot) {
        cleanupRoots.push(retainedRoot);
      }
    },
  );
});

const FULL_MUTATION_SCENARIO =
  "executes disposable mutation branches through the isolated runner";
const WORKFLOW_REPO_LIFECYCLE_SCENARIO =
  "registers and unregisters through the workflow surface";
const WRITE_EDIT_PRECONDITION_SCENARIO =
  "preserves files when write and search-edit preconditions fail";
const RUNTIME_SCHEMA_ONLY_SCENARIO =
  "keeps runtime execution blocked by the isolated runner";

const FULL_MUTATION_CASE_IDS = [
  "flat-agent-feedback-contract",
  "codeMode-agent-feedback-contract",
  "workflow-agent-feedback-contract",
  "flat-buffer-checkpoint-contract",
  "codeMode-buffer-checkpoint-contract",
  "workflow-buffer-checkpoint-contract",
  "flat-buffer-push-contract",
  "codeMode-buffer-push-contract",
  "workflow-buffer-push-contract",
  "codeMode-file-contract",
  "flat-file-write-contract",
  "codeMode-file-write-contract",
  "workflow-file-write-contract",
  "flat-index-refresh-contract",
  "codeMode-index-refresh-contract",
  "workflow-index-refresh-contract",
  "flat-memory-remove-contract",
  "codeMode-memory-remove-contract",
  "workflow-memory-remove-contract",
  "flat-memory-store-contract",
  "codeMode-memory-store-contract",
  "workflow-memory-store-contract",
  "flat-memory-surface-contract",
  "codeMode-memory-surface-contract",
  "workflow-memory-surface-contract",
  "flat-policy-set-contract",
  "codeMode-policy-set-contract",
  "workflow-policy-set-contract",
  "flat-repo-register-contract",
  "flat-repo-unregister-contract",
  "flat-search-edit-contract",
  "codeMode-search-edit-contract",
  "workflow-search-edit-contract",
  "flat-semantic-enrichment-refresh-contract",
  "codeMode-semantic-enrichment-refresh-contract",
  "workflow-semantic-enrichment-refresh-contract",
  "flat-symbol-edit-contract",
  "codeMode-symbol-edit-contract",
  "workflow-symbol-edit-contract",
  "codeMode-workflow-contract",
] as const;
const WORKFLOW_REPO_CASE_IDS = [
  "codeMode-repo-register-contract",
  "workflow-repo-register-contract",
  "codeMode-repo-unregister-contract",
  "workflow-repo-unregister-contract",
] as const;
const RUNTIME_SCHEMA_ONLY_CASE_IDS = [
  "flat-runtime-execute-contract",
  "codeMode-runtime-execute-contract",
  "workflow-runtime-execute-contract",
] as const;

const ISOLATED_CASE_SCENARIOS: Readonly<Record<string, string>> =
  Object.fromEntries([
    ...FULL_MUTATION_CASE_IDS.map((id) => [id, FULL_MUTATION_SCENARIO]),
    ...WORKFLOW_REPO_CASE_IDS.map((id) => [
      id,
      WORKFLOW_REPO_LIFECYCLE_SCENARIO,
    ]),
    ...RUNTIME_SCHEMA_ONLY_CASE_IDS.map((id) => [
      id,
      RUNTIME_SCHEMA_ONLY_SCENARIO,
    ]),
  ]);

it(FULL_MUTATION_SCENARIO, { timeout: 240_000 }, async () => {
  const { runIsolatedMutatingQa } = await import(
    "../../scripts/run-isolated-mutating-qa.mjs"
  );
  const inputs = makeQaInputs([]);
  const scenario = [
    {
      tool: "sdl.repo.register",
      arguments: {
        repoId: "qa-fixture",
        rootPath: inputs.repoRoot,
      },
    },
    {
      tool: "sdl.index.refresh",
      arguments: { repoId: "qa-fixture", mode: "full" },
    },
    {
      tool: "sdl.agent.feedback",
      arguments: {
        repoId: "qa-fixture",
        usefulSymbols: ["qaValue"],
        taskType: "implement",
        taskText: "Exercise flat mutation QA",
      },
    },
    {
      tool: "sdl.buffer.push",
      arguments: {
        repoId: "qa-fixture",
        eventType: "save",
        filePath: "index.ts",
        content: "export const qaValue = 1;\n",
        version: 1,
        dirty: false,
        timestamp: "2026-08-22T00:00:00.000Z",
      },
    },
    {
      tool: "sdl.buffer.checkpoint",
      arguments: { repoId: "qa-fixture", reason: "flat mutation QA" },
    },
    {
      tool: "sdl.memory.store",
      arguments: {
        repoId: "qa-fixture",
        memoryId: "qa-flat-memory",
        type: "pattern",
        title: "Disposable flat QA memory",
        content: "Stored only in the runner-owned database.",
      },
    },
    {
      tool: "sdl.memory.surface",
      arguments: { repoId: "qa-fixture", taskType: "pattern", limit: 5 },
    },
    {
      tool: "sdl.memory.remove",
      arguments: {
        repoId: "qa-fixture",
        memoryId: "qa-flat-memory",
        deleteFile: false,
      },
    },
    {
      tool: "sdl.policy.set",
      arguments: {
        repoId: "qa-fixture",
        maxWindowLines: 202,
        requireIdentifiers: true,
      },
    },
    {
      tool: "sdl.search.edit",
      arguments: {
        repoId: "qa-fixture",
        mode: "preview",
        targeting: "text",
        query: { literal: "oldName", replacement: "newName" },
        filters: { include: ["notes.txt"] },
        editMode: "replacePattern",
        responseMode: "inline",
      },
    },
    {
      tool: "sdl.semantic.enrichment.refresh",
      arguments: {
        repoId: "qa-fixture",
        dryRun: true,
        force: true,
        install: false,
        languages: ["typescript"],
      },
    },
    {
      tool: "sdl.symbol.edit",
      arguments: {
        repoId: "qa-fixture",
        mode: "preview",
        symbolRef: {
          name: "qaValue",
          file: "index.ts",
          kind: "variable",
        },
        operation: {
          kind: "replaceSymbol",
          content: "export const qaValue = 2;",
        },
      },
    },
    {
      tool: "sdl.file",
      arguments: {
        op: "write",
        repoId: "qa-fixture",
        filePath: "gateway.txt",
        content: "gateway-write\n",
        createIfMissing: true,
        createBackup: false,
      },
    },
    {
      tool: "sdl.file.write",
      arguments: {
        repoId: "qa-fixture",
        filePath: "flat.txt",
        content: "flat-write\n",
        createIfMissing: true,
        createBackup: false,
      },
    },
    {
      tool: "sdl.workflow",
      arguments: {
        repoId: "qa-fixture",
        onError: "stop",
        detail: "full",
        steps: [
          {
            fn: "agentFeedback",
            args: {
              usefulSymbols: ["qaValue"],
              taskType: "implement",
              taskText: "Exercise disposable mutation QA",
            },
          },
          {
            fn: "bufferPush",
            args: {
              eventType: "save",
              filePath: "index.ts",
              content: "export const qaValue = 1;\n",
              version: 1,
              dirty: false,
              timestamp: "2026-08-22T00:00:00.000Z",
            },
          },
          {
            fn: "bufferCheckpoint",
            args: { reason: "isolated mutation QA" },
          },
          {
            fn: "memoryStore",
            args: {
              memoryId: "qa-memory",
              type: "pattern",
              title: "Disposable QA memory",
              content: "Stored only in the runner-owned database.",
            },
          },
          {
            fn: "memorySurface",
            args: { taskType: "pattern", limit: 5 },
          },
          {
            fn: "memoryRemove",
            args: { memoryId: "qa-memory", deleteFile: false },
          },
          {
            fn: "policySet",
            args: { maxWindowLines: 201, requireIdentifiers: true },
          },
          {
            fn: "searchEdit",
            args: {
              mode: "preview",
              targeting: "text",
              query: {
                literal: "oldName",
                replacement: "newName",
              },
              filters: { include: ["notes.txt"] },
              editMode: "replacePattern",
              maxFiles: 1,
              maxMatchesPerFile: 1,
              maxTotalMatches: 1,
              responseMode: "inline",
            },
          },
          {
            fn: "searchEdit",
            args: {
              mode: "apply",
              planHandle: "$7.planHandle",
              createBackup: true,
            },
          },
          {
            fn: "semanticEnrichmentRefresh",
            args: {
              dryRun: false,
              force: true,
              install: false,
              languages: ["typescript"],
            },
          },
          {
            fn: "symbolEdit",
            args: {
              mode: "preview",
              symbolRef: {
                name: "qaValue",
                file: "index.ts",
                kind: "variable",
              },
              operation: {
                kind: "replaceSymbol",
                content: "export const qaValue = 3;",
              },
            },
          },
          {
            fn: "symbolEdit",
            args: {
              mode: "apply",
              planHandle: "$10.planHandle",
              createBackup: true,
            },
          },
          {
            fn: "sliceBuild",
            args: {
              taskText: "Explain qaValue",
              budget: { maxCards: 8, maxEstimatedTokens: 2_000 },
              wireFormat: "json",
            },
          },
          {
            fn: "sliceRefresh",
            args: { sliceHandle: "$12.sliceHandle" },
          },
          {
            fn: "fileWrite",
            args: {
              filePath: "workflow-file.txt",
              content: "workflow-write\n",
              createIfMissing: true,
              createBackup: false,
            },
          },
          {
            fn: "indexRefresh",
            args: { mode: "incremental" },
          },
        ],
      },
    },
    {
      tool: "sdl.repo.unregister",
      arguments: {
        repoId: "qa-fixture",
        confirmRepoId: "qa-fixture",
        discardDrafts: true,
      },
    },
  ];
  writeFileSync(inputs.scenarioPath, JSON.stringify(scenario));

  const worktreeBefore = snapshotTrackedWorktree();
  const activeBefore = snapshotActiveDatabaseFamily();
  assert.notEqual(activeBefore.dbPath, inputs.activeDbPath);

  const receipt = await runIsolatedMutatingQa({
    activeDbPath: activeBefore.dbPath,
    fixtureRoot: inputs.fixtureRoot,
    configPath: inputs.configPath,
    scenarioPath: inputs.scenarioPath,
    projectRoot: process.cwd(),
  });

  assert.deepEqual(receipt.completedTools, [
    "sdl.repo.register",
    "sdl.index.refresh",
    "sdl.agent.feedback",
    "sdl.buffer.push",
    "sdl.buffer.checkpoint",
    "sdl.memory.store",
    "sdl.memory.surface",
    "sdl.memory.remove",
    "sdl.policy.set",
    "sdl.search.edit",
    "sdl.semantic.enrichment.refresh",
    "sdl.symbol.edit",
    "sdl.file",
    "sdl.file.write",
    "sdl.workflow",
    "sdl.repo.unregister",
  ]);
  assert.equal(
    readFileSync(join(inputs.repoRoot, "gateway.txt"), "utf8"),
    "gateway-write\n",
  );
  assert.equal(
    readFileSync(join(inputs.repoRoot, "flat.txt"), "utf8"),
    "flat-write\n",
  );
  assert.equal(
    readFileSync(join(inputs.repoRoot, "workflow-file.txt"), "utf8"),
    "workflow-write\n",
  );
  assert.equal(readFileSync(join(inputs.repoRoot, "notes.txt"), "utf8"), "newName\n");
  assert.equal(
    readFileSync(join(inputs.repoRoot, "index.ts"), "utf8"),
    "export const qaValue = 3;\n",
  );
  assert.equal(receipt.closed, true);
  assert.equal(receipt.sidecarsClean, true);
  assert.equal(receipt.cleaned, true);
  assert.equal(existsSync(receipt.qaDbPath), false);
  assert.equal(existsSync(`${receipt.qaDbPath}.wal`), false);
  assert.equal(snapshotTrackedWorktree(), worktreeBefore);
  assert.deepEqual(snapshotActiveDatabaseFamily(), activeBefore);
});

it(WORKFLOW_REPO_LIFECYCLE_SCENARIO, { timeout: 120_000 }, async () => {
  const { runIsolatedMutatingQa } = await import(
    "../../scripts/run-isolated-mutating-qa.mjs"
  );
  const inputs = makeQaInputs([]);
  const scenario = [
    {
      tool: "sdl.workflow",
      arguments: {
        repoId: "qa-workflow",
        onError: "stop",
        detail: "full",
        steps: [
          {
            fn: "repoRegister",
            args: { rootPath: inputs.repoRoot },
          },
          {
            fn: "repoUnregister",
            args: {
              confirmRepoId: "qa-workflow",
              discardDrafts: true,
            },
          },
        ],
      },
    },
  ];
  writeFileSync(inputs.scenarioPath, JSON.stringify(scenario));

  const worktreeBefore = snapshotTrackedWorktree();
  const activeBefore = snapshotActiveDatabaseFamily();

  const receipt = await runIsolatedMutatingQa({
    activeDbPath: activeBefore.dbPath,
    fixtureRoot: inputs.fixtureRoot,
    configPath: inputs.configPath,
    scenarioPath: inputs.scenarioPath,
    projectRoot: process.cwd(),
  });

  assert.deepEqual(receipt.completedTools, ["sdl.workflow"]);
  assert.equal(receipt.closed, true);
  assert.equal(receipt.sidecarsClean, true);
  assert.equal(receipt.cleaned, true);
  assert.equal(existsSync(receipt.qaDbPath), false);
  assert.equal(existsSync(`${receipt.qaDbPath}.wal`), false);
  assert.equal(snapshotTrackedWorktree(), worktreeBefore);
  assert.deepEqual(snapshotActiveDatabaseFamily(), activeBefore);
});

it(WRITE_EDIT_PRECONDITION_SCENARIO, { timeout: 120_000 }, async () => {
  const { runIsolatedMutatingQa } = await import(
    "../../scripts/run-isolated-mutating-qa.mjs"
  );
  const worktreeBefore = snapshotTrackedWorktree();
  const activeBefore = snapshotActiveDatabaseFamily();

  const writeInputs = makeQaInputs([]);
  cleanupRoots.push(writeInputs.fixtureRoot);
  const protectedPath = join(writeInputs.repoRoot, "protected.txt");
  const backupPath = `${protectedPath}.bak`;
  writeFileSync(protectedPath, "original\n");
  writeFileSync(backupPath, "existing backup\n");
  writeFileSync(
    writeInputs.scenarioPath,
    JSON.stringify([
      {
        tool: "sdl.repo.register",
        arguments: {
          repoId: "qa-fixture",
          rootPath: writeInputs.repoRoot,
        },
      },
      {
        tool: "sdl.file.write",
        arguments: {
          repoId: "qa-fixture",
          filePath: "protected.txt",
          content: "updated\n",
          createBackup: true,
        },
      },
    ]),
  );

  await assert.rejects(
    runIsolatedMutatingQa({
      activeDbPath: activeBefore.dbPath,
      fixtureRoot: writeInputs.fixtureRoot,
      configPath: writeInputs.configPath,
      scenarioPath: writeInputs.scenarioPath,
      projectRoot: process.cwd(),
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /backup.*exists|already exists/i);
      const qaError = error as Error & { qaRootPath?: string };
      assert.equal(existsSync(qaError.qaRootPath!), true);
      cleanupRoots.push(qaError.qaRootPath!);
      return true;
    },
  );
  assert.equal(readFileSync(protectedPath, "utf8"), "original\n");
  assert.equal(readFileSync(backupPath, "utf8"), "existing backup\n");

  const editInputs = makeQaInputs([]);
  cleanupRoots.push(editInputs.fixtureRoot);
  writeFileSync(
    editInputs.scenarioPath,
    JSON.stringify([
      {
        tool: "sdl.repo.register",
        arguments: {
          repoId: "qa-fixture",
          rootPath: editInputs.repoRoot,
        },
      },
      {
        tool: "sdl.workflow",
        arguments: {
          repoId: "qa-fixture",
          onError: "stop",
          detail: "full",
          steps: [
            {
              fn: "searchEdit",
              args: {
                mode: "preview",
                targeting: "text",
                query: { literal: "oldName", replacement: "newName" },
                filters: { include: ["notes.txt"] },
                editMode: "replacePattern",
                responseMode: "inline",
              },
            },
            {
              fn: "fileWrite",
              args: {
                filePath: "notes.txt",
                content: "drifted\n",
                createBackup: false,
              },
            },
            {
              fn: "searchEdit",
              args: {
                mode: "apply",
                planHandle: "$0.planHandle",
                createBackup: true,
              },
            },
          ],
        },
      },
    ]),
  );

  await assert.rejects(
    runIsolatedMutatingQa({
      activeDbPath: activeBefore.dbPath,
      fixtureRoot: editInputs.fixtureRoot,
      configPath: editInputs.configPath,
      scenarioPath: editInputs.scenarioPath,
      projectRoot: process.cwd(),
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /precondition|sha256|changed since preview/i);
      const qaError = error as Error & { qaRootPath?: string };
      assert.equal(existsSync(qaError.qaRootPath!), true);
      cleanupRoots.push(qaError.qaRootPath!);
      return true;
    },
  );
  assert.equal(
    readFileSync(join(editInputs.repoRoot, "notes.txt"), "utf8"),
    "drifted\n",
  );
  assert.equal(snapshotTrackedWorktree(), worktreeBefore);
  assert.deepEqual(snapshotActiveDatabaseFamily(), activeBefore);
});

it(RUNTIME_SCHEMA_ONLY_SCENARIO, async () => {
  const { validateScenario } = await import(
    "../../scripts/run-isolated-mutating-qa.mjs"
  );

  assert.throws(
    () =>
      validateScenario([
        {
          tool: "sdl.workflow",
          arguments: {
            repoId: "qa-fixture",
            steps: [
              {
                fn: "runtimeExecute",
                args: { runtime: "node", args: ["--version"] },
              },
            ],
          },
        },
      ]),
    /runtime/i,
  );
});

it("binds every schema-derived isolated mutation case to named coverage", () => {
  const isolatedCaseIds = PUBLIC_TOOL_CONTRACT_CASES.filter(
    (contractCase) => contractCase.mutation === "isolated",
  ).map(({ id }) => id);

  assert.equal(isolatedCaseIds.length, 47);
  assert.equal(Object.keys(ISOLATED_CASE_SCENARIOS).length, 47);
  assert.deepEqual(
    [...isolatedCaseIds].sort(),
    Object.keys(ISOLATED_CASE_SCENARIOS).sort(),
  );
  assert.deepEqual(
    isolatedCaseIds
      .filter((id) => !ISOLATED_CASE_SCENARIOS[id])
      .map((id) => `${id} (uncovered)`),
    [],
  );
  assert.deepEqual(
    [...new Set(Object.values(ISOLATED_CASE_SCENARIOS))].sort(),
    [
      FULL_MUTATION_SCENARIO,
      RUNTIME_SCHEMA_ONLY_SCENARIO,
      WORKFLOW_REPO_LIFECYCLE_SCENARIO,
    ].sort(),
  );
});
