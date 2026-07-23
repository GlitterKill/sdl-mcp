import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  invalidateConfigCache,
  loadConfig,
} from "../../dist/config/loadConfig.js";
import {
  getLadybugDbPath,
  closeLadybugDb,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import { initGraphDb } from "../../dist/db/initGraphDb.js";
import {
  runSafeRebuild,
  validateSafeRebuildCandidate,
} from "../../dist/cli/commands/index-safe-rebuild.js";
import {
  getDerivedState,
  markCurrentGraphIntegrityRevisionFailed,
} from "../../dist/db/ladybug-derived-state.js";

describe("safe rebuild candidate lifecycle", { concurrency: 1 }, () => {
  const previousEnv = {
    SDL_CONFIG: process.env.SDL_CONFIG,
    SDL_CONFIG_PATH: process.env.SDL_CONFIG_PATH,
    SDL_GRAPH_DB_DIR: process.env.SDL_GRAPH_DB_DIR,
    SDL_GRAPH_DB_PATH: process.env.SDL_GRAPH_DB_PATH,
    SDL_DB_PATH: process.env.SDL_DB_PATH,
  };
  let testRoot = "";

  afterEach(async () => {
    await closeLadybugDb().catch(() => {});
    invalidateConfigCache();
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (testRoot && existsSync(testRoot)) {
      rmSync(testRoot, { recursive: true, force: true });
    }
    testRoot = "";
  });

  function createFixture(): {
    activePath: string;
    candidatePath: string;
    configPath: string;
    sentinel: string;
  } {
    testRoot = mkdtempSync(join(tmpdir(), "sdl-safe-rebuild-"));
    const sourceRepo = join(testRoot, "source-repo");
    const emptyRepo = join(testRoot, "empty-repo");
    mkdirSync(join(sourceRepo, "src"), { recursive: true });
    mkdirSync(emptyRepo, { recursive: true });
    writeFileSync(
      join(sourceRepo, "src", "index.ts"),
      "export function safeRebuildValue(): number { return 42; }\n",
      "utf8",
    );

    const activePath = join(testRoot, "active-graph.lbug");
    const candidatePath = join(testRoot, "candidate-graph.lbug");
    const configPath = join(testRoot, "sdlmcp.config.json");
    const sentinel = "forensic-active-sentinel\n";
    writeFileSync(activePath, sentinel, "utf8");
    writeFileSync(
      configPath,
      JSON.stringify({
        repos: [
          {
            repoId: "safe-rebuild-source",
            rootPath: sourceRepo,
            ignore: [],
            languages: ["ts"],
          },
          {
            repoId: "safe-rebuild-empty",
            rootPath: emptyRepo,
            ignore: [],
            languages: ["ts"],
          },
        ],
        graphDatabase: { path: activePath },
        policy: {},
        indexing: {
          pipeline: "legacy",
          engine: "typescript",
          enableFileWatching: false,
        },
        semantic: { enabled: false },
        semanticEnrichment: { enabled: false },
        scip: { enabled: false },
      }),
      "utf8",
    );

    process.env.SDL_CONFIG = configPath;
    delete process.env.SDL_CONFIG_PATH;
    delete process.env.SDL_GRAPH_DB_DIR;
    process.env.SDL_GRAPH_DB_PATH = activePath;
    delete process.env.SDL_DB_PATH;
    invalidateConfigCache();
    return { activePath, candidatePath, configPath, sentinel };
  }

  it("builds every configured repo and validates only after close/reopen", async () => {
    const fixture = createFixture();
    const events: string[] = [];
    const config = loadConfig(fixture.configPath);
    const result = await runSafeRebuild({
      options: {
        config: fixture.configPath,
        force: true,
        safeRebuildPath: fixture.candidatePath,
      },
      config,
      configPath: fixture.configPath,
      activeGraphDbPath: fixture.activePath,
      onLifecycleEvent: (event) => events.push(event),
    });

    assert.equal(readFileSync(fixture.activePath, "utf8"), fixture.sentinel);
    assert.equal(process.env.SDL_GRAPH_DB_PATH, fixture.activePath);
    assert.equal(getLadybugDbPath(), null);
    assert.equal(existsSync(fixture.candidatePath), true);
    assert.deepEqual(result.validation.repoIds, [
      "safe-rebuild-empty",
      "safe-rebuild-source",
    ]);
    assert.ok(result.validation.physicalSymbolTotal > 0);
    assert.ok(
      events.indexOf("candidate:closed-before-reopen") <
        events.indexOf("candidate:reopened"),
    );
    assert.ok(
      events.indexOf("candidate:reopened") <
        events.indexOf("candidate:validated"),
    );
    assert.equal(events.at(-1), "candidate:closed-after-validation");

    await initLadybugDb(fixture.candidatePath);
    await assert.rejects(
      validateSafeRebuildCandidate({
        ...config,
        semantic: {
          enabled: true,
          provider: "mock",
          alpha: 0.6,
          retrieval: {
            mode: "hybrid",
            extensionsOptional: true,
            candidateLimit: 100,
            fts: {
              enabled: true,
              indexName: "required_but_missing_fts",
              topK: 10,
              conjunctive: false,
            },
            vector: {
              enabled: false,
              topK: 10,
              efc: 20,
              efs: 20,
              indexes: {},
            },
            fusion: { strategy: "rrf", rrfK: 60 },
          },
        },
      }),
      /required Symbol FTS index required_but_missing_fts is absent/,
    );

    const state = await getDerivedState("safe-rebuild-source");
    assert.ok(state?.graphIntegrityVersionId);
    assert.equal(typeof state.graphIntegrityRevision, "number");
    assert.equal(
      await markCurrentGraphIntegrityRevisionFailed(
        "safe-rebuild-source",
        state.graphIntegrityVersionId!,
        state.graphIntegrityRevision!,
        "injected post-reopen integrity failure",
      ),
      true,
    );
    await assert.rejects(
      validateSafeRebuildCandidate(config),
      /does not have verified graph integrity/,
    );
    await closeLadybugDb();
    assert.equal(getLadybugDbPath(), null);
  });

  it("scans the incident-sensitive Symbol strings during reopen validation", () => {
    const source = readFileSync("src/db/ladybug-safe-rebuild.ts", "utf8");
    for (const field of [
      "name",
      "summary",
      "searchText",
      "signatureJson",
      "scipSymbol",
    ]) {
      assert.match(
        source,
        new RegExp(`LOWER\\(coalesce\\(s\\.${field}, ''\\)\\)`),
        `safe rebuild validation must force a full LOWER scan of Symbol.${field}`,
      );
    }
  });

  it("closes and retains a failed candidate without touching the active sentinel", async () => {
    const fixture = createFixture();

    await assert.rejects(
      runSafeRebuild({
        options: {
          config: fixture.configPath,
          force: true,
          safeRebuildPath: fixture.candidatePath,
        },
        config: loadConfig(fixture.configPath),
        configPath: fixture.configPath,
        activeGraphDbPath: fixture.activePath,
        _indexRepoForTesting: async () => {
          throw new Error("injected candidate build failure");
        },
      }),
      /injected candidate build failure/,
    );

    assert.equal(getLadybugDbPath(), null);
    assert.equal(existsSync(fixture.candidatePath), true);
    assert.equal(readFileSync(fixture.activePath, "utf8"), fixture.sentinel);
    assert.equal(process.env.SDL_GRAPH_DB_PATH, fixture.activePath);
  });

  it("closes a candidate whose initial database initialization opens then fails", async () => {
    const fixture = createFixture();
    const events: string[] = [];

    await assert.rejects(
      runSafeRebuild({
        options: {
          config: fixture.configPath,
          force: true,
          safeRebuildPath: fixture.candidatePath,
        },
        config: loadConfig(fixture.configPath),
        configPath: fixture.configPath,
        activeGraphDbPath: fixture.activePath,
        onLifecycleEvent: (event) => events.push(event),
        _initGraphDbForTesting: async (config, configPath) => {
          await initGraphDb(config, configPath);
          throw new Error("injected initial candidate initialization failure");
        },
      }),
      /injected initial candidate initialization failure/,
    );

    assert.equal(getLadybugDbPath(), null);
    assert.equal(existsSync(fixture.candidatePath), true);
    assert.equal(readFileSync(fixture.activePath, "utf8"), fixture.sentinel);
    assert.equal(process.env.SDL_GRAPH_DB_PATH, fixture.activePath);
    assert.equal(events.at(-1), "candidate:closed-after-failure");
  });

  it("closes a candidate whose reopen initialization opens then fails", async () => {
    const fixture = createFixture();
    const events: string[] = [];
    let initCalls = 0;

    await assert.rejects(
      runSafeRebuild({
        options: {
          config: fixture.configPath,
          force: true,
          safeRebuildPath: fixture.candidatePath,
        },
        config: loadConfig(fixture.configPath),
        configPath: fixture.configPath,
        activeGraphDbPath: fixture.activePath,
        onLifecycleEvent: (event) => events.push(event),
        _initGraphDbForTesting: async (config, configPath) => {
          initCalls += 1;
          await initGraphDb(config, configPath);
          if (initCalls === 2) {
            throw new Error("injected candidate reopen initialization failure");
          }
          return fixture.candidatePath;
        },
      }),
      /injected candidate reopen initialization failure/,
    );

    assert.equal(initCalls, 2);
    assert.equal(getLadybugDbPath(), null);
    assert.equal(existsSync(fixture.candidatePath), true);
    assert.equal(readFileSync(fixture.activePath, "utf8"), fixture.sentinel);
    assert.equal(process.env.SDL_GRAPH_DB_PATH, fixture.activePath);
    assert.equal(events.at(-1), "candidate:closed-after-failure");
  });

  it("closes and retains a candidate that fails post-reopen validation", async () => {
    const fixture = createFixture();

    await assert.rejects(
      runSafeRebuild({
        options: {
          config: fixture.configPath,
          force: true,
          safeRebuildPath: fixture.candidatePath,
        },
        config: loadConfig(fixture.configPath),
        configPath: fixture.configPath,
        activeGraphDbPath: fixture.activePath,
        _validateCandidateForTesting: async () => {
          throw new Error("injected post-reopen validation failure");
        },
      }),
      /injected post-reopen validation failure/,
    );

    assert.equal(getLadybugDbPath(), null);
    assert.equal(existsSync(fixture.candidatePath), true);
    assert.equal(readFileSync(fixture.activePath, "utf8"), fixture.sentinel);
    assert.equal(process.env.SDL_GRAPH_DB_PATH, fixture.activePath);
  });
});
