import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, it } from "node:test";
import { fileURLToPath } from "node:url";

import { invalidateConfigCache } from "../../dist/config/loadConfig.js";
import { closeLadybugDb, getLadybugConn, initLadybugDb } from "../../dist/db/ladybug.js";
import { getSymbolsByRepo } from "../../dist/db/ladybug-queries.js";
import { indexRepo } from "../../dist/indexer/indexer.js";
import { handleAgentContext } from "../../dist/mcp/tools/context.js";
import { handleRepoRegister } from "../../dist/mcp/tools/repo.js";
import { estimateTokens } from "../../dist/util/tokenize.js";
import contract from "../fixtures/info-contract/v1/manifest.json" with { type: "json" };
import qualityConfig from "./config/context-quality-sdl-mcp.json" with { type: "json" };

// This newer contract deliberately has its own versioned corpus. The scheduled
// frozen benchmark corpus and its baseline must not move to accommodate it.
const fixtureDir = fileURLToPath(new URL("../fixtures/info-contract/v1/", import.meta.url));
const testRoot = mkdtempSync(join(tmpdir(), "sdl-info-contract-v1-"));
const rootPath = join(testRoot, "repo");
const dbPath = join(testRoot, "graph.lbug");
const configPath = join(testRoot, "config.json");
const repoId = "info-contract-v1";
const expectedCaseIds = new Set<string>();
const previousConfig = process.env.SDL_CONFIG;
const previousConfigPath = process.env.SDL_CONFIG_PATH;

before(async () => {
  for (const [fixture, descriptor] of [
    ["code-mode-tool-validation.fixture", contract],
    ["retrieval-distractors.fixture", contract.distractors],
  ] as const) {
    const source = readFileSync(join(fixtureDir, fixture), "utf8").replace(/\r\n/g, "\n");
    assert.equal(createHash("sha256").update(source).digest("hex"), descriptor.sha256);
    const target = join(rootPath, descriptor.sourcePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  writeFileSync(configPath, JSON.stringify({
    ...qualityConfig,
    repos: [],
    graphDatabase: { path: dbPath },
    security: { allowedRepoRoots: [rootPath] },
  }));
  process.env.SDL_CONFIG = configPath;
  process.env.SDL_CONFIG_PATH = configPath;
  invalidateConfigCache();
  await initLadybugDb(dbPath);
  await handleRepoRegister({ repoId, rootPath, languages: ["ts"], ignore: [] });
  const indexed = await indexRepo(repoId, "full");
  assert.equal(indexed.filesProcessed, 2);
  const symbols = await getSymbolsByRepo(await getLadybugConn(), repoId);
  for (const title of contract.expectedTitles) {
    const symbol = symbols.find((candidate) => candidate.name === title);
    assert.ok(symbol, `contract case must be indexed: ${title}`);
    expectedCaseIds.add(symbol.symbolId);
  }
  for (const name of contract.distractors.names) {
    assert.ok(symbols.some((symbol) => symbol.name === name), `${name} must be an indexed distractor`);
  }
});

after(async () => {
  try {
    await closeLadybugDb();
  } finally {
    if (previousConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = previousConfig;
    if (previousConfigPath === undefined) delete process.env.SDL_CONFIG_PATH;
    else process.env.SDL_CONFIG_PATH = previousConfigPath;
    invalidateConfigCache();
    rmSync(testRoot, { recursive: true, force: true });
  }
});

it("retrieves the exact sdl.info contract cases within 2400 tokens", async () => {
  const request = {
    repoId: repoId,
    taskType: "review" as const,
    taskText:
      "Find the tests that assert sdl.info is exposed as a top-level Code Mode tool and rejected as an sdl.workflow action.",
    focusPaths: ["tests"],
    includeTests: true,
    budget: { maxTokens: 2400 },
    responseMode: "inline" as const,
    refsMode: "off" as const,
    wireFormat: "json" as const,
  };
  const session = { sessionId: "semantic-test-case-acceptance" };
  const first = await handleAgentContext(request, session);
  const second = await handleAgentContext(request, session);
  const serialized = JSON.stringify(first);
  assert.equal(serialized, JSON.stringify(second));
  assert.ok("evidence" in first);

  const result = first as {
    retrieval: {
      level: string;
      lanes: Array<{ id: string; available: boolean; coveragePermille?: number }>;
    };
    evidence: Array<{
      path?: string;
      symbolId?: string;
      content?: {
        name?: string;
        excerpt?: string;
        testCase?: { title?: string };
        card?: { name?: string; testCase?: { title?: string } };
      };
    }>;
    omitted?: { highestRanked?: Array<{ symbolId?: string }> };
  };
  assert.equal(result.retrieval.level, "hybrid");
  for (const id of ["symbolFts", "symbolVec", "fileSummaryFts", "fileSummaryVec"]) {
    const lane = result.retrieval.lanes.find((candidate) => candidate.id === id);
    assert.equal(lane?.available, true, `${id} must use the real configured backend`);
    if (id.endsWith("Vec")) assert.equal(lane?.coveragePermille, 1000);
  }
  const expectedTitles = [
    "rejects info and sdl.info as sdl.workflow actions",
    "keeps sdl.info callable and discoverable in exclusive Code Mode",
  ];
  const target = result.evidence.filter(
    (item) => item.path === "tests/unit/code-mode-tool-validation.test.ts",
  );
  const foundTitles = new Set(
    target.flatMap((item) =>
      typeof (item.content?.card ?? item.content)?.testCase?.title === "string"
        ? [(item.content?.card ?? item.content)!.testCase!.title!]
        : [],
    ),
  );
  assert.deepEqual(foundTitles, new Set(expectedTitles), serialized);

  const targetText = target
    .map((item) => item.content?.excerpt ?? JSON.stringify(item.content))
    .join("\n");
  assert.match(targetText, /Invalid sdl\.workflow request/u);
  assert.match(targetText, /handlers\.has\("sdl\.info"\)/u);
  assert.equal(
    result.evidence.some((item) =>
      ["createArtifact", "weight"].includes((item.content?.card ?? item.content)?.name ?? ""),
    ),
    false,
  );
  assert.equal(
    (result.omitted?.highestRanked ?? []).some(
      (item) => expectedCaseIds.has(item.symbolId ?? ""),
    ),
    false,
  );
  assert.ok(estimateTokens(serialized) <= 2400);
});
