import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  analyzeSessions,
  createSdlHttpConfig,
  estimateCost,
  findCodexSessionTokenCounts,
  importTranscript,
  inspectCodexSessionSterility,
  runBenchmark,
} from "../src/sdlbench.mjs";
import { prepareOpencodeSterileRuntime } from "../src/agents/opencode-runtime.mjs";
import { serveViewer } from "../src/cli.mjs";
import { buildChartModel, parseJsonl } from "../viewer/app.mjs";
import { signalsForLoss } from "../src/attribution-signals.mjs";
import { computeCoverage } from "../src/coverage.mjs";
import { mean, stdDev, bootstrapCI, mannWhitneyU } from "../src/stats.mjs";
import { auditFairness } from "../src/fairness.mjs";
import { validateClaims } from "../src/claim-gates.mjs";
import { extractClaudeSessionUsage } from "../src/agents/claude.mjs";
import { extractOpencodeSessionUsage } from "../src/agents/opencode.mjs";

async function fakeTokenizer(root) {
  const path = join(root, "fake-tokenizer.mjs");
  await writeFile(path, `
    import { readFileSync } from "node:fs";
    const input = JSON.parse(readFileSync(0, "utf8"));
    const counts = Object.fromEntries(Object.entries(input.texts).map(([key, text]) => [key, String(text).trim().split(/\\s+/).filter(Boolean).length]));
    console.log(JSON.stringify({ counts, model: input.model, encoding: input.encoding, modelHint: input.modelHint, tokenizerResolution: "configured_encoding", tokenizerVersion: "fake-tiktoken-1.0", tokenizerSource: "tiktoken" }));
  `);
  return `node ${JSON.stringify(path)}`;
}

test("runBenchmark resolves tokenizer and pricing from the tested model", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdlbench-model-"));
  const repo = join(root, "repo");

  try {
    await mkdir(join(root, "sdlbench", "config", "agents"), { recursive: true });
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "package.json"), "{\"type\":\"module\"}\n");
    await writeFile(join(repo, "src", "value.js"), "export const value = \"broken\";\n");
    await writeFile(join(root, "sdlbench", "config", "agents", "codex.json"), JSON.stringify({
      schemaVersion: 1,
      agent: "codex",
      model: "gpt-test",
      commandTemplate: "unused"
    }));
    await writeFile(join(root, "sdlbench", "config", "pricing.json"), JSON.stringify({
      schemaVersion: 1,
      defaultModel: "fallback-test",
      models: {
        "gpt-test": { encoding: "test_base", inputPerMTok: 1000, outputPerMTok: 2000, contextPerMTok: 500 }
      }
    }));
    await writeFile(join(root, "matrix.json"), JSON.stringify({
      schemaVersion: 1,
      tasks: [{
        schemaVersion: 1,
        taskId: "model-aware-cost",
        repoId: "model-fixture",
        category: "bug-fix",
        prompt: "alpha beta gamma delta",
        repo: { sourcePath: repo },
        context: { raw: "raw one two three four", sdl: "sdl one two" },
        verify: { command: "node -e \"import('./src/value.js').then(() => {})\"", timeoutMs: 10000 },
        rubric: { maxScore: 1 },
        solution: { files: { "src/value.js": "export const value = \"fixed words\";\n" } }
      }]
    }));

    const result = await runBenchmark({
      agent: "codex",
      matrixPath: join(root, "matrix.json"),
      resultsPath: join(root, "sessions.jsonl"),
      root,
      tokenizerCommand: await fakeTokenizer(root),
      variant: "baseline",
      workDir: join(root, "work"),
    });
    const [record] = result.records;

    assert.equal(record.model, "gpt-test");
    assert.equal(record.tokens.model, "gpt-test");
    assert.equal(record.tokens.modelHint, "gpt-test");
    assert.equal(record.tokens.encoding, "test_base");
    assert.equal(record.tokens.tokenizerResolution, "configured_encoding");
    assert.equal(record.cost.inputUsd, 0.009);
    assert.equal(record.cost.outputUsd, 0.012);
    assert.equal(record.cost.pricingModel, "gpt-test");
    assert.equal(record.cost.pricingSource, "model");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});


test("behavior mode runs an agent command instead of applying canned solution files", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdlbench-behavior-"));
  const repo = join(root, "repo");
  const matrixPath = join(root, "matrix.json");
  const agentPath = join(root, "agent.mjs");

  try {
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, "package.json"), "{\"type\":\"module\"}\n");
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(join(repo, "tests"), { recursive: true });
    await writeFile(join(repo, "src", "value.js"), "export const value = \"broken\";\n");
    await writeFile(join(repo, "tests", "value.test.mjs"), `
      import assert from "node:assert/strict";
      import { value } from "../src/value.js";
      assert.equal(value, "agent");
    `);
    await writeFile(matrixPath, JSON.stringify({
      schemaVersion: 1,
      tasks: [{
        schemaVersion: 1,
        taskId: "behavior-edits-repo",
        repoId: "behavior-fixture",
        category: "bug-fix",
        prompt: "Make value export agent.",
        repo: { sourcePath: repo },
        context: { raw: "RAW_CONTEXT_ONLY", sdl: "SDL_CONTEXT_ONLY" },
        verify: { command: "node tests/value.test.mjs", timeoutMs: 10000 },
        rubric: { maxScore: 1 },
        solution: { files: { "src/value.js": "export const value = \"canned\";\n" } }
      }]
    }));
    await writeFile(agentPath, `
      import { readFileSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const repo = process.argv[process.argv.indexOf("--repo") + 1];
      const prompt = readFileSync(process.argv[process.argv.indexOf("--prompt") + 1], "utf8");
      if (!prompt.includes("RAW_CONTEXT_ONLY")) process.exit(2);
      writeFileSync(join(repo, "src", "value.js"), "export const value = \\\"agent\\\";\\n");
    `);

    const result = await runBenchmark({
      agent: "local",
      agentCommand: `node ${JSON.stringify(agentPath)} --repo {repo} --prompt {prompt}`,
      executionMode: "behavior",
      matrixPath,
      resultsPath: join(root, "sessions.jsonl"),
      tokenizerCommand: await fakeTokenizer(root),
      variant: "baseline",
      workDir: join(root, "work"),
    });
    const [record] = result.records;

    assert.equal(record.status, "pass");
    assert.equal(record.artifacts.agent.exitCode, 0);
    assert.equal(record.workflow.executionMode, "behavior");
    assert.equal(record.workflow.filesChanged, 1);
    assert.match(await readFile(join(record.artifacts.worktree, "src", "value.js"), "utf8"), /agent/);
    assert.match(await readFile(record.artifacts.promptPath, "utf8"), /RAW_CONTEXT_ONLY/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});


test("behavior mode records Codex tiktoken session counts when available", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdlbench-codex-tokens-"));
  const repo = join(root, "repo");
  const matrixPath = join(root, "matrix.json");
  const agentPath = join(root, "agent.mjs");
  const codexSessionsDir = join(root, "codex-sessions");
  const dayDir = join(codexSessionsDir, "2026", "06", "26");

  try {
    await mkdir(dayDir, { recursive: true });
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(join(repo, "tests"), { recursive: true });
    await writeFile(join(repo, "package.json"), "{\"type\":\"module\"}\n");
    await writeFile(join(repo, "src", "value.js"), "export const value = \"broken\";\n");
    await writeFile(join(repo, "tests", "value.test.mjs"), `
      import assert from "node:assert/strict";
      import { value } from "../src/value.js";
      assert.equal(value, "actual-session");
    `);
    await writeFile(matrixPath, JSON.stringify({
      schemaVersion: 1,
      tasks: [{
        schemaVersion: 1,
        taskId: "actual-codex-usage",
        repoId: "behavior-fixture",
        category: "bug-fix",
        prompt: "Make value export actual-session.",
        repo: { sourcePath: repo },
        context: { raw: "tiny raw context", sdl: "tiny sdl context" },
        verify: { command: "node tests/value.test.mjs", timeoutMs: 10000 },
        rubric: { maxScore: 1 },
        solution: { files: { "src/value.js": "export const value = \"canned\";\n" } }
      }]
    }));
    await writeFile(agentPath, `
      import { mkdirSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const repo = process.argv[process.argv.indexOf("--repo") + 1];
      const sessions = process.argv[process.argv.indexOf("--sessions") + 1];
      mkdirSync(sessions, { recursive: true });
      writeFileSync(join(repo, "src", "value.js"), "export const value = \\\"actual-session\\\";\\n");
      writeFileSync(join(sessions, "rollout-test.jsonl"), [
        JSON.stringify({ timestamp: "2026-06-26T00:00:00.000Z", type: "session_meta", payload: { session_id: "session-test", cwd: repo, source: "exec", cli_version: "0.test" } }),
        JSON.stringify({ timestamp: "2026-06-26T00:00:01.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 111, cached_input_tokens: 22, output_tokens: 33, reasoning_output_tokens: 7, total_tokens: 144 }, model_context_window: 258400 } } }),
        JSON.stringify({ timestamp: "2026-06-26T00:00:02.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1234, cached_input_tokens: 900, output_tokens: 456, reasoning_output_tokens: 123, total_tokens: 1690 }, model_context_window: 258400 } } })
      ].join("\\n") + "\\n");
    `);

    const result = await runBenchmark({
      agent: "local",
      agentCommand: `node ${JSON.stringify(agentPath)} --repo {repo} --sessions ${JSON.stringify(dayDir)}`,
      codexSessionsDir,
      executionMode: "behavior",
      matrixPath,
      resultsPath: join(root, "sessions.jsonl"),
      tokenizerCommand: await fakeTokenizer(root),
      variant: "baseline",
      workDir: join(root, "work"),
    });
    const [record] = result.records;

    assert.equal(record.status, "pass");
    assert.equal(record.tokens.tokenizerSource, "codex-session");
    assert.equal(record.tokens.input, 1234);
    assert.equal(record.tokens.cachedInput, 900);
    assert.equal(record.tokens.output, 456);
    assert.equal(record.tokens.reasoningOutput, 123);
    assert.equal(record.tokens.total, 1690);
    assert.equal(record.tokens.modelContextWindow, 258400);
    assert.equal(record.artifacts.estimatedTokens.tokenizerSource, "tiktoken");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Codex behavior mode uses a sterile temporary CODEX_HOME", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdlbench-codex-sterile-"));
  const repo = join(root, "repo");
  const matrixPath = join(root, "matrix.json");
  const agentPath = join(root, "agent.mjs");

  try {
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(join(repo, "tests"), { recursive: true });
    await writeFile(join(repo, "package.json"), "{\"type\":\"module\"}\n");
    await writeFile(join(repo, "src", "value.js"), "export const value = \"broken\";\n");
    await writeFile(join(repo, "tests", "value.test.mjs"), `
      import assert from "node:assert/strict";
      import { value } from "../src/value.js";
      assert.equal(value, "sterile");
    `);
    await writeFile(matrixPath, JSON.stringify({
      schemaVersion: 1,
      tasks: [{
        schemaVersion: 1,
        taskId: "sterile-codex-home",
        repoId: "behavior-fixture",
        category: "bug-fix",
        prompt: "Make value export sterile.",
        repo: { sourcePath: repo },
        context: { raw: "tiny raw context", sdl: "tiny sdl context" },
        verify: { command: "node tests/value.test.mjs", timeoutMs: 10000 },
        rubric: { maxScore: 1 },
        solution: { files: { "src/value.js": "export const value = \"canned\";\n" } }
      }]
    }));
    await writeFile(agentPath, `
      import { mkdirSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const repo = process.argv[process.argv.indexOf("--repo") + 1];
      const codexHome = process.env.CODEX_HOME;
      if (!codexHome || codexHome.includes(".codex")) process.exit(5);
      writeFileSync(join(repo, "src", "value.js"), "export const value = \\\"sterile\\\";\\n");
      const sessions = join(codexHome, "sessions", "2026", "06", "26");
      mkdirSync(sessions, { recursive: true });
      writeFileSync(join(sessions, "rollout-sterile.jsonl"), [
        JSON.stringify({ type: "session_meta", payload: { session_id: "sterile-session", cwd: repo, source: "exec", cli_version: "0.test" } }),
        JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 20, cached_input_tokens: 3, output_tokens: 5, reasoning_output_tokens: 2, total_tokens: 25 }, model_context_window: 123 } } })
      ].join("\\n") + "\\n");
    `);

    const result = await runBenchmark({
      agent: "codex",
      agentCommand: `node ${JSON.stringify(agentPath)} --repo {repo}`,
      executionMode: "behavior",
      matrixPath,
      resultsPath: join(root, "sessions.jsonl"),
      tokenizerCommand: await fakeTokenizer(root),
      variant: "baseline",
    });
    const [record] = result.records;

    assert.equal(record.status, "pass");
    assert.equal(record.tokens.tokenizerSource, "codex-session");
    assert.equal(record.artifacts.codexSterility.passed, true);
    assert.equal(record.artifacts.codexSession.sessionId, "sterile-session");
    assert.equal(record.artifacts.worktree.replace(/\\/g, "/").startsWith(root.replace(/\\/g, "/")), false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Codex sterility inspection rejects plugin, skill, memory, and Ponytail context", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdlbench-sterility-inspect-"));
  const sessionPath = join(root, "rollout-contaminated.jsonl");

  try {
    await writeFile(sessionPath, [
      JSON.stringify({ type: "session_meta", payload: { cwd: root, source: "exec" } }),
      JSON.stringify({ type: "response_item", content: "<skills_instructions>\\n### Available skills\\nPONYTAIL MODE ACTIVE\\n<plugins_instructions>\\n<apps_instructions>\\nMEMORY_SUMMARY BEGINS" })
    ].join("\n"));

    const inspection = await inspectCodexSessionSterility(sessionPath);

    assert.equal(inspection.passed, false);
    assert.ok(inspection.forbidden.includes("ponytail"));
    assert.ok(inspection.forbidden.includes("plugin instructions"));
    assert.ok(inspection.forbidden.includes("app connector instructions"));
    assert.ok(inspection.forbidden.includes("skill registry"));
    assert.ok(inspection.forbidden.includes("memory context"));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("findCodexSessionTokenCounts ignores other worktrees", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdlbench-codex-scan-"));
  const sessionsDir = join(root, "sessions", "2026", "06", "26");
  const runRoot = join(root, "repo");

  try {
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, "rollout-other.jsonl"), [
      JSON.stringify({ type: "session_meta", payload: { cwd: join(root, "other"), source: "exec" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } } })
    ].join("\n"));
    await writeFile(join(sessionsDir, "rollout-match.jsonl"), [
      JSON.stringify({ type: "session_meta", payload: { cwd: runRoot, source: "exec", session_id: "match" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 4, reasoning_output_tokens: 2, total_tokens: 14 } } } })
    ].join("\n"));

    const usage = await findCodexSessionTokenCounts({ runRoot, sessionsDir: join(root, "sessions") });

    assert.equal(usage.sessionId, "match");
    assert.equal(usage.usage.input_tokens, 10);
    assert.equal(usage.usage.reasoning_output_tokens, 2);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});


test("agentTimeoutMs overrides timeout from behavior agent config", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdlbench-timeout-"));
  const repo = join(root, "repo");
  const matrixPath = join(root, "matrix.json");
  const agentPath = join(root, "agent.mjs");
  const agentConfigPath = join(root, "agent.json");

  try {
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, "package.json"), "{\"type\":\"module\"}\n");
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(join(repo, "tests"), { recursive: true });
    await writeFile(join(repo, "src", "value.js"), "export const value = \"broken\";\n");
    await writeFile(join(repo, "tests", "value.test.mjs"), `
      import assert from "node:assert/strict";
      import { value } from "../src/value.js";
      assert.equal(value, "agent-timeout");
    `);
    await writeFile(matrixPath, JSON.stringify({
      schemaVersion: 1,
      tasks: [{
        schemaVersion: 1,
        taskId: "agent-timeout-override",
        repoId: "behavior-fixture",
        category: "bug-fix",
        prompt: "Make value export agent-timeout.",
        repo: { sourcePath: repo },
        context: { raw: "RAW_CONTEXT_ONLY", sdl: "SDL_CONTEXT_ONLY" },
        verify: { command: "node tests/value.test.mjs", timeoutMs: 10000 },
        rubric: { maxScore: 1 },
        solution: { files: { "src/value.js": "export const value = \"canned\";\n" } }
      }]
    }));
    await writeFile(agentPath, `
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      const repo = process.argv[process.argv.indexOf("--repo") + 1];
      await new Promise((resolve) => setTimeout(resolve, 100));
      writeFileSync(join(repo, "src", "value.js"), "export const value = \\\"agent-timeout\\\";\\n");
    `);
    await writeFile(agentConfigPath, JSON.stringify({
      schemaVersion: 1,
      agent: "local",
      commandTemplate: `node ${JSON.stringify(agentPath)} --repo {repo}`,
      timeoutMs: 1
    }));

    const result = await runBenchmark({
      agent: "local",
      agentConfigPath,
      agentTimeoutMs: 5000,
      executionMode: "behavior",
      matrixPath,
      resultsPath: join(root, "sessions.jsonl"),
      tokenizerCommand: await fakeTokenizer(root),
      variant: "baseline",
      workDir: join(root, "work"),
    });
    const [record] = result.records;

    assert.equal(record.status, "pass");
    assert.equal(record.artifacts.agent.exitCode, 0);
    assert.equal(record.artifacts.agent.error, undefined);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});


test("runBenchmark appends baseline and sdl fixture records with tokenizer-backed counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdlbench-"));

  try {
    const tokenizerCommand = await fakeTokenizer(root);
    const baseline = await runBenchmark({
      agent: "codex",
      matrixPath: "sdlbench/tasks/matrix.json",
      resultsPath: join(root, "sessions.jsonl"),
      tokenizerCommand,
      variant: "baseline",
      workDir: join(root, "work"),
    });
    const sdl = await runBenchmark({
      agent: "codex",
      matrixPath: "sdlbench/tasks/matrix.json",
      resultsPath: join(root, "sessions.jsonl"),
      tokenizerCommand,
      variant: "sdl",
      workDir: join(root, "work"),
    });

    assert.equal(baseline.records.length, 4);
    assert.equal(sdl.records.length, 4);
    assert.ok(sdl.records.every((record) => record.status === "pass"));

    const lines = (await readFile(join(root, "sessions.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    assert.equal(lines.length, 8);
    assert.deepEqual(new Set(lines.map((record) => record.variant)), new Set(["baseline", "sdl"]));
    assert.ok(lines.every((record) => record.tokens.tokenizerSource === "tiktoken"));
    assert.ok(lines.every((record) => record.tokens.tokenizerVersion === "fake-tiktoken-1.0"));
    // Fixture-mode records no longer claim synthetic savings (schema v2 truth-fix).
    assert.ok(lines.every((record) => record.tokens.saved === 0));
    assert.ok(lines.every((record) => record.claimGrade === "none"));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("sdl variant indexes and retrieves context through HTTP before applying solutions", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdlbench-http-"));
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push({ method: req.method, pathname: url.pathname, auth: req.headers.authorization });

    if (url.pathname.endsWith("/reindex-stream")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('event: complete\ndata: {"ok":true,"providerFirstExecution":{"selectedPipeline":"providerFirst"}}\n\n');
      return;
    }

    if (url.pathname.endsWith("/search")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        results: [
          { symbolId: "sym-build-cart", name: "buildCart", kind: "function", file: "src/cart.mjs", summary: "from-http-retrieval" }
        ]
      }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"status":"ok"}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const result = await runBenchmark({
      agent: "codex",
      matrixPath: "sdlbench/tasks/matrix.json",
      resultsPath: join(root, "sessions.jsonl"),
      tokenizerCommand: await fakeTokenizer(root),
      variant: "sdl",
      workDir: join(root, "work"),
      sdlAuthToken: "test-token",
      sdlHttpBaseUrl: `http://127.0.0.1:${port}`,
    });

    assert.equal(result.records.length, 4);
    assert.ok(requests.some((request) => request.pathname.endsWith("/reindex-stream")));
    assert.ok(requests.some((request) => request.pathname.endsWith("/search")));
    assert.ok(requests.every((request) => request.auth === "Bearer test-token"));
    assert.ok(result.records.every((record) => record.artifacts.sdl?.transport === "http"));
    assert.ok(result.records.every((record) => record.artifacts.sdl.context.includes("from-http-retrieval")));
  } finally {
    server.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("SDL behavior mode exposes a live MCP server instead of pasted lookup context", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdlbench-sdl-agent-"));
  const repo = join(root, "repo");
  const matrixPath = join(root, "matrix.json");
  const agentPath = join(root, "agent.mjs");
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push({ method: req.method, pathname: url.pathname });

    if (url.pathname.endsWith("/reindex-stream")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('event: complete\ndata: {"ok":true,"providerFirstExecution":{"selectedPipeline":"providerFirst"}}\n\n');
      return;
    }

    if (url.pathname.endsWith("/search")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        results: [
          { symbolId: "sym-value", name: "value", kind: "variable", file: "src/value.js", summary: "from-http-retrieval" }
        ]
      }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"status":"ok"}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, "package.json"), "{\"type\":\"module\"}\n");
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(join(repo, "tests"), { recursive: true });
    await writeFile(join(repo, "src", "value.js"), "export const value = \"broken\";\n");
    await writeFile(join(repo, "tests", "value.test.mjs"), `
      import assert from "node:assert/strict";
      import { value } from "../src/value.js";
      assert.equal(value, "sdl-agent");
    `);
    await writeFile(matrixPath, JSON.stringify({
      schemaVersion: 1,
      tasks: [{
        schemaVersion: 1,
        taskId: "sdl-agent-live-server",
        repoId: "sdl-agent-fixture",
        category: "bug-fix",
        prompt: "Make value export sdl-agent.",
        repo: { sourcePath: repo },
        context: {
          raw: "RAW_CONTEXT_ONLY",
          sdl: "PASTED_SDL_CONTEXT_SHOULD_NOT_APPEAR",
          sdlQueries: ["value"]
        },
        verify: { command: "node tests/value.test.mjs", timeoutMs: 10000 },
        rubric: { maxScore: 1 },
        solution: { files: { "src/value.js": "export const value = \"canned\";\n" } }
      }]
    }));
    await writeFile(agentPath, `
      import { readFileSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const repo = process.argv[process.argv.indexOf("--repo") + 1];
      const prompt = readFileSync(process.argv[process.argv.indexOf("--prompt") + 1], "utf8");
      if (prompt.includes("from-http-retrieval")) process.exit(2);
      if (!prompt.includes("configured SDL-MCP server")) process.exit(3);
      if (!process.argv.join(" ").includes("mcp_servers.sdl-mcp.url")) process.exit(4);
      writeFileSync(join(repo, "src", "value.js"), "export const value = \\\"sdl-agent\\\";\\n");
    `);

    const result = await runBenchmark({
      agent: "local",
      agentCommand: `node ${JSON.stringify(agentPath)} --repo {repo} --prompt {prompt} {sdlMcpConfig}`,
      executionMode: "behavior",
      matrixPath,
      resultsPath: join(root, "sessions.jsonl"),
      sdlHttpBaseUrl: `http://127.0.0.1:${port}`,
      tokenizerCommand: await fakeTokenizer(root),
      variant: "sdl",
      workDir: join(root, "work"),
    });
    const [record] = result.records;

    assert.equal(record.status, "pass");
    assert.match(record.artifacts.agent.command, /mcp_servers\.sdl-mcp\.url/);
    assert.match(record.artifacts.agent.command, new RegExp(`127\\.0\\.0\\.1:${port}`));
    assert.ok(requests.some((request) => request.pathname.endsWith("/reindex-stream")));
    assert.ok(requests.some((request) => request.pathname.endsWith("/search")));
  } finally {
    server.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("temporary SDL benchmark server disables HTTP auth for Codex MCP access", () => {
  const config = createSdlHttpConfig({
    task: { repoId: "fixture-js" },
    runRoot: "F:/tmp/repo",
    dbPath: "F:/tmp/graph.lbug",
  });

  assert.deepEqual(config.httpAuth, { enabled: false });
});

test("runBenchmark fails instead of estimating when tokenizer is unavailable", async () => {
  await assert.rejects(
    runBenchmark({
      agent: "codex",
      matrixPath: "sdlbench/tasks/matrix.json",
      tokenizerCommand: "node missing-tokenizer.mjs",
      variant: "baseline",
    }),
    /Tokenizer failed/
  );
});

test("runBenchmark tags records with repo.sizeClass and repo.languageTags from repos.lock.json", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdlbench-repo-tags-"));
  const repo = join(root, "repo");
  const lockPath = join(root, "repos.lock.json");

  try {
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "package.json"), "{\"type\":\"module\"}\n");
    await writeFile(join(repo, "src", "value.js"), "export const value = \"ok\";\n");
    await writeFile(lockPath, JSON.stringify({
      schemaVersion: 1,
      repos: [
        { repoId: "tagged-fixture", sourcePath: repo, pinnedRef: "local", languageTags: ["javascript"], ignoreGlobs: ["node_modules/**"], sizeClass: "tiny" }
      ]
    }));
    await writeFile(join(root, "matrix.json"), JSON.stringify({
      schemaVersion: 1,
      tasks: [{
        schemaVersion: 1,
        taskId: "repo-tag-test",
        repoId: "tagged-fixture",
        category: "bug-fix",
        prompt: "noop alpha beta",
        repo: { sourcePath: repo },
        context: { raw: "raw one two", sdl: "sdl three four" },
        verify: { command: "node -e \"import('./src/value.js').then(() => {})\"", timeoutMs: 10000 },
        rubric: { maxScore: 1 },
        solution: { files: { "src/value.js": "export const value = \"ok\";\n" } }
      }]
    }));

    const result = await runBenchmark({
      agent: "codex",
      matrixPath: join(root, "matrix.json"),
      resultsPath: join(root, "sessions.jsonl"),
      tokenizerCommand: await fakeTokenizer(root),
      variant: "baseline",
      workDir: join(root, "work"),
      reposLockPath: lockPath,
    });
    const [record] = result.records;

    assert.equal(record.repo.sizeClass, "tiny");
    assert.deepEqual(record.repo.languageTags, ["javascript"]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("runBenchmark resolves repos via runs matrix and accepts --repo-id filter", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdlbench-runs-matrix-"));
  const repoA = join(root, "repoA");
  const repoB = join(root, "repoB");
  const lockPath = join(root, "repos.lock.json");

  try {
    for (const repo of [repoA, repoB]) {
      await mkdir(join(repo, "src"), { recursive: true });
      await writeFile(join(repo, "package.json"), "{\"type\":\"module\"}\n");
      await writeFile(join(repo, "src", "value.js"), "export const value = \"ok\";\n");
    }
    await writeFile(lockPath, JSON.stringify({
      schemaVersion: 1,
      repos: [
        { repoId: "repo-a", sourcePath: repoA, pinnedRef: "local", languageTags: ["javascript"], ignoreGlobs: [], sizeClass: "tiny" },
        { repoId: "repo-b", sourcePath: repoB, pinnedRef: "local", languageTags: ["javascript"], ignoreGlobs: [], sizeClass: "small" }
      ]
    }));
    await writeFile(join(root, "matrix.json"), JSON.stringify({
      schemaVersion: 1,
      runs: [
        { id: "run-a", family: "bug-fix", repoId: "repo-a", tasks: "tasks-a.json", sizeClass: "tiny" },
        { id: "run-b", family: "bug-fix", repoId: "repo-b", tasks: "tasks-b.json", sizeClass: "small" }
      ]
    }));
    await writeFile(join(root, "tasks-a.json"), JSON.stringify({
      schemaVersion: 1,
      tasks: [{
        schemaVersion: 1, taskId: "task-a", repoId: "repo-a", category: "bug-fix", prompt: "noop alpha",
        repo: { sourcePath: repoA }, context: { raw: "raw", sdl: "sdl" },
        verify: { command: "node -e \"import('./src/value.js').then(() => {})\"", timeoutMs: 10000 },
        rubric: { maxScore: 1 }, solution: { files: { "src/value.js": "export const value = \"ok\";\n" } }
      }]
    }));
    await writeFile(join(root, "tasks-b.json"), JSON.stringify({
      schemaVersion: 1,
      tasks: [{
        schemaVersion: 1, taskId: "task-b", repoId: "repo-b", category: "bug-fix", prompt: "noop beta",
        repo: { sourcePath: repoB }, context: { raw: "raw", sdl: "sdl" },
        verify: { command: "node -e \"import('./src/value.js').then(() => {})\"", timeoutMs: 10000 },
        rubric: { maxScore: 1 }, solution: { files: { "src/value.js": "export const value = \"ok\";\n" } }
      }]
    }));

    const all = await runBenchmark({
      agent: "codex", matrixPath: join(root, "matrix.json"), resultsPath: join(root, "out.jsonl"),
      tokenizerCommand: await fakeTokenizer(root), variant: "baseline", workDir: join(root, "work"),
      reposLockPath: lockPath,
    });
    assert.equal(all.records.length, 2);
    assert.deepEqual(all.records.map((r) => r.taskId).sort(), ["task-a", "task-b"]);

    const filtered = await runBenchmark({
      agent: "codex", matrixPath: join(root, "matrix.json"), resultsPath: join(root, "out2.jsonl"),
      tokenizerCommand: await fakeTokenizer(root), variant: "baseline", workDir: join(root, "work2"),
      reposLockPath: lockPath, repoIdFilter: "repo-b",
    });
    assert.equal(filtered.records.length, 1);
    assert.equal(filtered.records[0].taskId, "task-b");
    assert.equal(filtered.records[0].repo.sizeClass, "small");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Codex reads parse function_call items and attach per-tool attribution", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdlbench-attribution-"));
  const sessionsDir = join(root, "sessions", "2026", "06", "26");
  const runRoot = join(root, "repo");

  try {
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, "rollout-attribution.jsonl"), [
      JSON.stringify({ type: "session_meta", payload: { session_id: "attr-session", cwd: runRoot, source: "exec", cli_version: "0.test" } }),
      JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "shell_command", arguments: "{\"command\":\"git status\"}", call_id: "call_a" } }),
      JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "call_a", output: "nothing to commit" } }),
      JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "sdl.symbol.search", arguments: "{\"query\":\"buildCart\"}", call_id: "call_b" } }),
      JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "call_b", output: "found buildCart" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 }, model_context_window: 200000 } } })
    ].join("\n"));

    const sessionCounts = await findCodexSessionTokenCounts({
      runRoot,
      sessionsDir: join(root, "sessions"),
      tokenizerCommand: await fakeTokenizer(root),
    });

    assert.ok(sessionCounts?.attribution);
    assert.equal(sessionCounts.attribution.toolCalls.length, 2);
    const shellCall = sessionCounts.attribution.toolCalls.find((tc) => tc.toolName === "shell_command");
    assert.ok(shellCall);
    assert.ok(shellCall.tokensIn > 0);
    assert.ok(shellCall.tokensOut > 0);
    const sdlCall = sessionCounts.attribution.toolCalls.find((tc) => tc.toolName === "sdl.symbol.search");
    assert.ok(sdlCall);
    assert.ok(sdlCall.tokensIn > 0);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("behavior records carry attribution.toolCalls and phaseBreakdown from codex session", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdlbench-attr-record-"));
  const repo = join(root, "repo");
  const matrixPath = join(root, "matrix.json");
  const agentPath = join(root, "agent.mjs");
  const codexSessionsDir = join(root, "codex-sessions");
  const dayDir = join(codexSessionsDir, "2026", "06", "26");

  try {
    await mkdir(dayDir, { recursive: true });
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(join(repo, "tests"), { recursive: true });
    await writeFile(join(repo, "package.json"), "{\"type\":\"module\"}\n");
    await writeFile(join(repo, "src", "value.js"), "export const value = \"broken\";\n");
    await writeFile(join(repo, "tests", "value.test.mjs"), `
      import assert from "node:assert/strict";
      import { value } from "../src/value.js";
      assert.equal(value, "attr");
    `);
    await writeFile(matrixPath, JSON.stringify({
      schemaVersion: 1,
      tasks: [{
        schemaVersion: 1, taskId: "attr-record", repoId: "attr-repo", category: "bug-fix",
        prompt: "Make value export attr.", repo: { sourcePath: repo },
        context: { raw: "raw", sdl: "sdl" },
        verify: { command: "node tests/value.test.mjs", timeoutMs: 10000 },
        rubric: { maxScore: 1 }, solution: { files: { "src/value.js": "export const value = \"canned\";\n" } }
      }]
    }));
    await writeFile(agentPath, `
      import { mkdirSync, writeFileSync } from "node:fs";
      const repo = process.argv[process.argv.indexOf("--repo") + 1];
      const sessions = process.argv[process.argv.indexOf("--sessions") + 1];
      mkdirSync(sessions, { recursive: true });
      writeFileSync(repo + "/src/value.js", "export const value = \\\"attr\\\";\\n");
      writeFileSync(sessions + "/rollout-attr-record.jsonl", [
        JSON.stringify({ type: "session_meta", payload: { session_id: "attr-rec", cwd: repo, source: "exec", cli_version: "0.test" } }),
        JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "shell_command", arguments: "{\\"command\\":\\"ls\\"}", call_id: "c1" } }),
        JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "file.txt" } }),
        JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 200, cached_input_tokens: 50, output_tokens: 80, reasoning_output_tokens: 30, total_tokens: 280 }, model_context_window: 200000 } } })
      ].join("\\n") + "\\n");
    `);

    const result = await runBenchmark({
      agent: "local",
      agentCommand: `node ${JSON.stringify(agentPath)} --repo {repo} --sessions ${JSON.stringify(dayDir)}`,
      codexSessionsDir,
      executionMode: "behavior",
      matrixPath,
      resultsPath: join(root, "sessions.jsonl"),
      tokenizerCommand: await fakeTokenizer(root),
      variant: "baseline",
      workDir: join(root, "work"),
    });
    const [record] = result.records;

    assert.ok(record.attribution);
    assert.ok(record.attribution.toolCalls.length >= 1);
    assert.ok(record.attribution.phaseBreakdown);
    assert.equal(record.attribution.phaseBreakdown.reasoning, 30);
    assert.equal(record.attribution.phaseBreakdown.output, 80);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("SDL runs poll observability snapshot and carry observabilityDelta onto the sdl record", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdlbench-obs-"));
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.endsWith("/reindex-stream")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('event: complete\ndata: {"ok":true,"providerFirstExecution":{"selectedPipeline":"providerFirst"}}\n\n');
      return;
    }
    if (url.pathname.endsWith("/search")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results: [{ symbolId: "s1", name: "buildCart", kind: "function", file: "src/cart.mjs", summary: "obs" }] }));
      return;
    }
    if (url.pathname.endsWith("/api/observability/snapshot")) {
      const calls = parseInt(url.searchParams.get("_c") ?? "0", 10);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        repoId: "fixture-js",
        uptimeMs: 1000 + calls * 500,
        retrieval: { totalRetrievals: 1 + calls, emptyResultCount: 0, avgLatencyMs: 10, p95LatencyMs: 20, byMode: {}, candidateCountPerSource: {}, phaseLatencyMs: {}, byRetrievalType: {} },
        beam: { totalSliceBuilds: 1, avgBuildMs: 10, p95BuildMs: 20, avgAccepted: 5, avgEvicted: 0, avgRejected: 0, avgFrontierMaxSize: 5, p95FrontierMaxSize: 10, retainedExplainHandles: 0 },
        delta: { totalBlastRadiusComputations: 0, avgBlastRadiusLatencyMs: 0, p95BlastRadiusLatencyMs: 0, avgDbRoundTripsPerChangedSymbol: 0, avgPathExplanationLatencyMs: 0, p95PathExplanationLatencyMs: 0, fallbackPathQueryCount: 0 },
        indexing: { totalEvents: 10 + calls * 5, filesPerMinute: 60, avgPass1Ms: 100, avgPass2Ms: 50, phaseCounts: {}, perLanguageAvgMs: {}, engineDispatch: { rust: 1, ts: 0 }, failures: 0, derivedStateLagMs: null },
        tokenEfficiency: { totalUsed: 100, totalSaved: 50 + calls * 10, savingsRatio: 0.33, avgPerCall: 10, compressionLayers: {} },
        health: { score: 80 + calls, components: { freshness: 1, coverage: 0.8, errorRate: 0, edgeQuality: 0.9, callResolution: 0.85 }, watcherRunning: true, watcherQueueDepth: 0, watcherStale: false, watcherErrors: 0, watcherRestartCount: 0 },
        latency: { avgMs: 50, p50Ms: 40, p95Ms: 80, p99Ms: 100, maxMs: 200, perTool: {} },
        pool: { totalAcquired: 1, totalReleased: 1, active: 0, maxActive: 1, avgWaitMs: 0, p95WaitMs: 0, timeoutCount: 0, evictionCount: 0, writeQueueDepth: 0, writeQueueMaxDepth: 0 },
        scip: { totalIndexes: 0, totalSymbols: 0, externalSymbols: 0, autoIngestedIndexes: 0, generatorRuns: 0, generatorFailures: 0 },
        packed: { totalEvents: 0, totalSymbols: 0, totalFiles: 0, avgSizeBytes: 0, maxSizeBytes: 0, deduplicatedCount: 0, compressionRatio: 0 },
        ppr: { totalRuns: 0, totalNodes: 0, totalEdges: 0, avgNodesPerRun: 0, avgDurationMs: 0, p95DurationMs: 0 },
        resources: { rssMb: 100, heapMb: 50, heapUsedMb: 30, cpuPercent: 5, eventLoopDelayMs: 0 },
        bottleneck: { class: "idle", confidence: 0.9, components: [] },
        toolVolume: { totalCalls: 1 + calls, perTool: {}, perToolErrors: {}, callsPerMinute: 10 },
        auditBuffer: { depth: 0, maxDepth: 0, droppedTotal: 0, sessionActive: false },
        postIndexSession: { totalSessions: 0, avgSessionDurationMs: 0, activeWriteCount: 0, totalWriteOps: 0, maxWriteOps: 0 },
        predictiveContext: { enabled: false, strategy: null, hits: 0, misses: 0, evictions: 0, hitRatePct: 0 },
      }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end('{"status":"ok"}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const result = await runBenchmark({
      agent: "codex",
      matrixPath: "sdlbench/tasks/matrix.json",
      resultsPath: join(root, "sessions.jsonl"),
      tokenizerCommand: await fakeTokenizer(root),
      variant: "sdl",
      workDir: join(root, "work"),
      sdlAuthToken: "test-token",
      sdlHttpBaseUrl: `http://127.0.0.1:${port}`,
    });

    assert.ok(result.records.every((r) => r.artifacts.sdl?.observability));
    const obs = result.records[0].artifacts.sdl.observability;
    assert.ok(typeof obs.health_score === "number" || typeof obs.healthScore === "number");
  } finally {
    server.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("signalsForLoss returns concrete signals on negative deltaPct and none on positive", () => {
  const lossSignals = signalsForLoss({
    baselineTok: 100,
    sdlTok: 150,
    attribution: { repoSizeClass: "tiny", cachedInput: 140, total: 150 },
    observability: {
      retrieval_totalRetrievals: 5,
      retrieval_emptyResultCount: 2,
      toolVolume_totalCalls: 15,
      indexing_totalEvents: 30,
    },
  });
  assert.ok(lossSignals.length >= 3);
  assert.ok(lossSignals.some((s) => s.signal === "lowRetrievalRecall"));
  assert.ok(lossSignals.some((s) => s.signal === "forcedLadderOnSmallRepo"));
  assert.ok(lossSignals.some((s) => s.signal === "coldIndexPerTask"));
  assert.ok(lossSignals.some((s) => s.signal === "contextBallooning"));

  const winSignals = signalsForLoss({
    baselineTok: 100,
    sdlTok: 50,
    attribution: {},
    observability: {},
  });
  assert.equal(winSignals.length, 0);
});

test("computeCoverage returns file/symbol coverage, precision, and recall", () => {
  const coverage = computeCoverage({
    changedFiles: ["src/cart.js", "src/discounts.js"],
    retrievedSymbols: ["buildCart", "resolvePromo", "estimateShipping"],
    contextTargets: {
      files: ["src/cart.js", "src/discounts.js", "src/shipping.js"],
      symbols: ["buildCart", "resolvePromo"],
    },
  });

  assert.equal(coverage.fileCoverage, 66.67);
  assert.equal(coverage.symbolCoverage, 100);
  assert.equal(coverage.precision, 80);
  assert.equal(coverage.recall, 80);
  assert.deepEqual(coverage.filesFound, ["src/cart.js", "src/discounts.js"]);
  assert.deepEqual(coverage.symbolsFound, ["buildCart", "resolvePromo"]);
});

test("computeCoverage returns null when contextTargets is absent", () => {
  assert.equal(computeCoverage({ changedFiles: [], retrievedSymbols: [], contextTargets: null }), null);
  assert.equal(computeCoverage({ changedFiles: [], retrievedSymbols: [], contextTargets: { files: [], symbols: [] } }), null);
});

test("warmSession reuses SDL server across tasks and only charges indexCost on first task", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdlbench-warm-"));
  let reindexCount = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.endsWith("/reindex-stream")) {
      reindexCount++;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('event: complete\ndata: {"ok":true,"providerFirstExecution":{"selectedPipeline":"providerFirst"}}\n\n');
      return;
    }
    if (url.pathname.endsWith("/search")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results: [{ symbolId: "s1", name: "buildCart", kind: "function", file: "src/cart.mjs", summary: "warm" }] }));
      return;
    }
    if (url.pathname.endsWith("/api/observability/snapshot")) {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        schemaVersion: 1, generatedAt: new Date().toISOString(), repoId: "fixture-js", uptimeMs: 500,
        retrieval: { totalRetrievals: 1, emptyResultCount: 0, avgLatencyMs: 1, p95LatencyMs: 2, byMode: {}, candidateCountPerSource: {}, phaseLatencyMs: {}, byRetrievalType: {} },
        beam: { totalSliceBuilds: 1, avgBuildMs: 1, p95BuildMs: 2, avgAccepted: 1, avgEvicted: 0, avgRejected: 0, avgFrontierMaxSize: 1, p95FrontierMaxSize: 1, retainedExplainHandles: 0 },
        delta: { totalBlastRadiusComputations: 0, avgBlastRadiusLatencyMs: 0, p95BlastRadiusLatencyMs: 0, avgDbRoundTripsPerChangedSymbol: 0, avgPathExplanationLatencyMs: 0, p95PathExplanationLatencyMs: 0, fallbackPathQueryCount: 0 },
        indexing: { totalEvents: 10, filesPerMinute: 60, avgPass1Ms: 1, avgPass2Ms: 1, phaseCounts: {}, perLanguageAvgMs: {}, engineDispatch: { rust: 1, ts: 0 }, failures: 0, derivedStateLagMs: null },
        tokenEfficiency: { totalUsed: 100, totalSaved: 50, savingsRatio: 0.33, avgPerCall: 10, compressionLayers: {} },
        health: { score: 80, components: { freshness: 1, coverage: 0.8, errorRate: 0, edgeQuality: 0.9, callResolution: 0.85 }, watcherRunning: true, watcherQueueDepth: 0, watcherStale: false, watcherErrors: 0, watcherRestartCount: 0 },
        latency: { avgMs: 1, p50Ms: 1, p95Ms: 2, p99Ms: 3, maxMs: 5, perTool: {} },
        pool: { totalAcquired: 1, totalReleased: 1, active: 0, maxActive: 1, avgWaitMs: 0, p95WaitMs: 0, timeoutCount: 0, evictionCount: 0, writeQueueDepth: 0, writeQueueMaxDepth: 0 },
        scip: { totalIndexes: 0, totalSymbols: 0, externalSymbols: 0, autoIngestedIndexes: 0, generatorRuns: 0, generatorFailures: 0 },
        packed: { totalEvents: 0, totalSymbols: 0, totalFiles: 0, avgSizeBytes: 0, maxSizeBytes: 0, deduplicatedCount: 0, compressionRatio: 0 },
        ppr: { totalRuns: 0, totalNodes: 0, totalEdges: 0, avgNodesPerRun: 0, avgDurationMs: 0, p95DurationMs: 0 },
        resources: { rssMb: 50, heapMb: 20, heapUsedMb: 10, cpuPercent: 1, eventLoopDelayMs: 0 },
        bottleneck: { class: "idle", confidence: 0.9, components: [] },
        toolVolume: { totalCalls: 1, perTool: {}, perToolErrors: {}, callsPerMinute: 10 },
        auditBuffer: { depth: 0, maxDepth: 0, droppedTotal: 0, sessionActive: false },
        postIndexSession: { totalSessions: 0, avgSessionDurationMs: 0, activeWriteCount: 0, totalWriteOps: 0, maxWriteOps: 0 },
        predictiveContext: { enabled: false, strategy: null, hits: 0, misses: 0, evictions: 0, hitRatePct: 0 },
      }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end('{"status":"ok"}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const result = await runBenchmark({
      agent: "codex",
      matrixPath: "sdlbench/tasks/matrix.json",
      resultsPath: join(root, "sessions.jsonl"),
      tokenizerCommand: await fakeTokenizer(root),
      variant: "sdl",
      workDir: join(root, "work"),
      sdlAuthToken: "test-token",
      sdlHttpBaseUrl: `http://127.0.0.1:${port}`,
      warmSession: true,
    });

    assert.ok(result.records.length >= 2);
    assert.ok(result.records.every((r) => r.warmSession === true));
    // With warmSession, we reindex once (the first task reuses for the rest).
    assert.ok(reindexCount <= result.records.length);
    const firstWithIndex = result.records.find((r) => (r.tokens?.indexCost ?? 0) > 0);
    const restWithout = result.records.filter((r) => (r.tokens?.indexCost ?? 0) === 0);
    assert.ok(firstWithIndex || restWithout.length === result.records.length);
  } finally {
    server.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("validateTask accepts multi-turn workflow[] and runBenchmark records perTurnTokens", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdlbench-multiturn-"));
  const matrixPath = join(root, "matrix.json");

  try {
    await writeFile(matrixPath, JSON.stringify({
      schemaVersion: 1,
      tasks: [{
        schemaVersion: 1,
        taskId: "multi-turn-incident",
        repoId: "fixture-js",
        category: "bug-fix",
        prompt: "Debug a multi-step incident.",
        repo: { sourcePath: "sdlbench/tests/fixtures/repo" },
        context: { raw: "raw", sdl: "sdl", sdlQueries: ["buildCart"] },
        workflow: [
          { id: "triage", phase: "triage", goal: "Triage", prompt: "Triage the incident" },
          { id: "investigate", phase: "investigate", goal: "Investigate", prompt: "Investigate the flow" },
          { id: "validate", phase: "validate", goal: "Validate", prompt: "Validate the fix" }
        ],
        verify: { command: "node tests/discount-tax.test.mjs", timeoutMs: 10000 },
        rubric: { maxScore: 1 },
        solution: { files: {} }
      }]
    }));

    const result = await runBenchmark({
      agent: "codex",
      matrixPath,
      resultsPath: join(root, "sessions.jsonl"),
      tokenizerCommand: await fakeTokenizer(root),
      variant: "baseline",
      workDir: join(root, "work"),
    });
    const [record] = result.records;

    assert.equal(record.workflow.turns, 3);
    assert.ok(Array.isArray(record.perTurnTokens));
    assert.equal(record.perTurnTokens.length, 3);
    assert.ok(record.perTurnTokens.every((turn) => typeof turn.tokens === "number"));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("stats: mean, stdDev, bootstrapCI, mannWhitneyU work on N>=3 samples", () => {
  const a = [100, 120, 80];
  const b = [50, 60, 55];
  assert.ok(mean(a) > mean(b));
  assert.ok(stdDev(a) > 0);
  const ci = bootstrapCI(a);
  assert.ok(ci.lower <= ci.mean);
  assert.ok(ci.upper >= ci.mean);
  const mw = mannWhitneyU(a, b);
  assert.equal(typeof mw.u, "number");
  assert.equal(typeof mw.pValue, "number");
  assert.equal(typeof mw.significant, "boolean");
});

test("analyzeSessions computes deltasMean/Std/bootstrap95 when N>=3 paired repeats exist", () => {
  const base = { agent: "codex", model: "m", quality: { errorRate: 0 }, cost: { totalUsd: 0 }, workflow: { executionMode: "fixture" }, durationMs: 0 };
  const records = [];
  for (let i = 0; i < 3; i++) {
    records.push({ ...base, variant: "baseline", taskId: `t${i}`, tokens: { total: 100 + i * 10 }, quality: { passed: true } });
    records.push({ ...base, variant: "sdl", taskId: `t${i}`, tokens: { total: 60 + i * 5 }, quality: { passed: true } });
  }
  const summary = analyzeSessions(records);
  assert.ok(summary.deltas.sdl.deltasMean !== undefined);
  assert.ok(summary.deltas.sdl.deltasStd !== undefined);
  assert.ok(summary.deltas.sdl.bootstrap95);
  assert.equal(typeof summary.deltas.sdl.significant, "boolean");
});

test("auditFairness measures SDL prompt injection token imbalance and recommends deduction", () => {
  const largeContent = "Use SDL-MCP as the repository interface. ".repeat(50);
  const result = auditFairness({
    baselinePromptTokens: 500,
    sdlPromptTokens: 400,
    sdlInjectedFiles: [
      { path: "AGENTS.md", content: largeContent },
      { path: "SDL.md", content: largeContent },
      { path: ".codex/hooks/force-sdl-mcp.mjs", content: largeContent },
    ],
    baselineInjectedFiles: [],
  });

  assert.ok(result.promptTokenImbalance > 0, `expected positive imbalance, got ${result.promptTokenImbalance}`);
  assert.ok(result.toolBudgetImbalance > 0);
  assert.ok(result.recommendedDeduction > 0);
  assert.equal(result.sdlInjectedFiles.length, 3);
  assert.ok(typeof result.netSavingsPct === "number");
});

test("extractClaudeSessionUsage reads usage records from .claude JSONL files", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdlbench-claude-"));
  const sessionDir = join(root, ".claude", "sessions");

  try {
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "session-1.jsonl"), [
      JSON.stringify({ type: "usage", usage: { input_tokens: 500, output_tokens: 100, total_tokens: 600 } }),
      JSON.stringify({ type: "usage", usage: { input_tokens: 300, output_tokens: 50, total_tokens: 350 } }),
    ].join("\n"));

    const usage = await extractClaudeSessionUsage({ sessionDir });

    assert.equal(usage.input, 800);
    assert.equal(usage.output, 150);
    assert.equal(usage.total, 950);
    assert.equal(usage.tokenizerSource, "claude-session");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("extractOpencodeSessionUsage sums usage records across fragmented session storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdlbench-opencode-usage-"));
  const storageDir = join(root, "storage");
  // opencode writes fragmented storage:
  //   storage/session/<sid>/info.json
  //   storage/session/<sid>/message/<mid>/index.json
  //   storage/message/<mid>/part/<pid>.json  (assistant parts carry usage)
  const sessionDir = join(storageDir, "session", "ses_test1");
  await mkdir(join(sessionDir, "message", "msg_test1"), { recursive: true });
  await mkdir(join(storageDir, "message", "msg_test1", "part"), { recursive: true });

  await writeFile(join(sessionDir, "info.json"), JSON.stringify({
    cwd: "/tmp/fake-run",
    modelID: "neuralwatt/glm-5.2",
    title: "sdlbench benchmark run",
  }));
  await writeFile(join(sessionDir, "message", "msg_test1", "index.json"), JSON.stringify({
    role: "assistant",
    sessionId: "ses_test1",
  }));
  await writeFile(join(storageDir, "message", "msg_test1", "part", "p1.json"), JSON.stringify({
    type: "assistant",
    model: "neuralwatt/glm-5.2",
    usage: {
      inputTokens: 1000,
      outputTokens: 200,
      reasoningTokens: 50,
      cacheReadInputTokens: 800,
      cacheWriteInputTokens: 100,
      totalTokens: 2050,
    },
  }));
  await writeFile(join(storageDir, "message", "msg_test1", "part", "p2.json"), JSON.stringify({
    type: "assistant",
    usage: {
      inputTokens: 1500,
      outputTokens: 300,
      reasoningTokens: 75,
      cacheReadInputTokens: 1200,
      cacheWriteInputTokens: 0,
      totalTokens: 3075,
    },
  }));
  // Non-usage part (should be ignored).
  await writeFile(join(storageDir, "message", "msg_test1", "part", "p3.txt"), "not a json usage record");

  try {
    const usage = await extractOpencodeSessionUsage({ storageDir });
    assert.equal(usage.input, 2500);
    assert.equal(usage.output, 500);
    assert.equal(usage.total, 5125);
    assert.equal(usage.reasoningOutput, 125);
    assert.equal(usage.cachedInput, 2000);
    assert.equal(usage.cachedWriteInput, 100);
    assert.equal(usage.tokenizerSource, "opencode-session");
    assert.ok(usage.sessionFiles.length >= 1, "sessionFiles should list files with usage records");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("extractOpencodeSessionUsage returns zero totals when no usage records are found", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdlbench-opencode-empty-"));
  const storageDir = join(root, "storage");
  await mkdir(join(storageDir, "session", "ses_empty"), { recursive: true });
  await writeFile(join(storageDir, "session", "ses_empty", "info.json"), JSON.stringify({ cwd: "/nope" }));

  try {
    const usage = await extractOpencodeSessionUsage({ storageDir });
    assert.equal(usage.input, 0);
    assert.equal(usage.output, 0);
    assert.equal(usage.total, 0);
    assert.equal(usage.tokenizerSource, "opencode-session");
    assert.equal(usage.sessionFiles.length, 0);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("validateClaims returns gates for smoke/efficient/realism profiles on paired data", () => {
  const paired = [
    { deltaPct: 60, coverage: { contextCoverage: 0.8, fileCoverage: 0.9 }, fairness: { netSavingsPct: 50 } },
    { deltaPct: 50, coverage: { contextCoverage: 0.7, fileCoverage: 0.8 }, fairness: { netSavingsPct: 40 } },
    { deltaPct: 35, coverage: { contextCoverage: 0.6, fileCoverage: 0.5 }, fairness: { netSavingsPct: 25 } },
  ];

  const realism = validateClaims({ paired, profile: "realism" });
  assert.ok(realism.gates.length >= 5);
  assert.equal(typeof realism.passed, "boolean");
  assert.ok(realism.gates.find((g) => g.name === "p50_paired_savings"));

  const smoke = validateClaims({ paired, profile: "smoke" });
  assert.ok(smoke.passed, "smoke profile should pass with good data");

  const efficient = validateClaims({ paired, profile: "efficient" });
  assert.ok(efficient.passed, "efficient profile should pass with good data");

  const badPaired = [{ deltaPct: 5, coverage: {}, fairness: {} }];
  const badRealism = validateClaims({ paired: badPaired, profile: "realism" });
  assert.equal(badRealism.passed, false);
});

test("analyzeSessions returns baseline deltas and imports transcript records", async () => {
  const tokenizerCommand = await fakeTokenizer(await mkdtemp(join(tmpdir(), "sdlbench-tokenizer-")));
  const imported = importTranscript({
    agent: "codex",
    repoId: "fixture-js",
    taskId: "bug-fix",
    text: "user: fix add\nassistant: patched add\n",
    tokenizerCommand,
    variant: "baseline",
  });

  assert.equal(imported.tokens.total > 0, true);
  assert.equal(imported.status, "imported");
  assert.equal(imported.tokens.tokenizerSource, "tiktoken");

  const summary = analyzeSessions([
    { ...imported, variant: "baseline", taskId: "t1", agent: "codex", model: "m", tokens: { total: 100, saved: 0 }, cost: { totalUsd: 0.1 }, quality: { passed: true, errorRate: 0 }, workflow: { executionMode: "fixture" } },
    { ...imported, variant: "sdl", taskId: "t1", agent: "codex", model: "m", tokens: { total: 45, saved: 0 }, cost: { totalUsd: 0.045 }, quality: { passed: true, errorRate: 0 }, workflow: { executionMode: "fixture" } },
  ]);

  assert.equal(summary.totals.sessions, 2);
  assert.equal(summary.byVariant.sdl.byExecutionMode.fixture.sessions, 1);
  assert.equal(summary.paired.length, 1);
  assert.equal(summary.paired[0].baselineTok, 100);
  assert.equal(summary.paired[0].sdlTok, 45);
  assert.equal(summary.paired[0].deltaTok, 55);
  assert.equal(summary.paired[0].bothPass, true);
  assert.equal(summary.deltas.sdl.tokensSaved, 55);
});

test("analyzeSessions builds a pass-gated paired ledger that excludes failures and separates execution modes", () => {
  const base = { agent: "codex", model: "m", quality: { errorRate: 0 }, cost: { totalUsd: 0 }, workflow: { executionMode: "fixture" }, durationMs: 0 };
  const summary = analyzeSessions([
    { ...base, variant: "baseline", taskId: "t1", tokens: { total: 100 }, quality: { passed: true } },
    { ...base, variant: "sdl", taskId: "t1", tokens: { total: 60 }, quality: { passed: true } },
    { ...base, variant: "baseline", taskId: "t2", tokens: { total: 100 }, quality: { passed: false } },
    { ...base, variant: "sdl", taskId: "t2", tokens: { total: 70 }, quality: { passed: true } },
    { ...base, variant: "baseline", taskId: "t3", agent: "local", model: "x", tokens: { total: 200 }, quality: { passed: true }, workflow: { executionMode: "behavior" } },
  ]);

  // Paired contains only t1 (the task where both baseline and sdl passed).
  assert.equal(summary.paired.length, 1);
  assert.equal(summary.paired[0].taskId, "t1");
  assert.equal(summary.paired[0].executionMode, "fixture");
  assert.equal(summary.paired[0].baselineTok, 100);
  assert.equal(summary.paired[0].sdlTok, 60);
  assert.equal(summary.paired[0].deltaTok, 40);
  assert.equal(summary.paired[0].deltaPct, 40);

  // Cross-mode sums are absent: byVariant has no mixed top-level totals, only per-mode buckets.
  assert.equal(summary.byVariant.sdl.byExecutionMode.fixture.tokens, 130);
  assert.equal(summary.byVariant.baseline.byExecutionMode.behavior.tokens, 200);
  assert.equal(summary.byVariant.sdl.tokens, undefined);
  assert.equal(summary.byVariant.sdl.mixedFixtureBehavior, undefined);

  // deltas computed from paired only (t1 delta = 40).
  assert.equal(summary.deltas.sdl.tokensSaved, 40);
  assert.equal(summary.deltas.sdl.pairedCount, 1);

  assert.match(summary.headlineClaim, /median paired savings on tasks both solved/);
});

test("estimateCost splits cached-input and reasoning pricing without double counting", () => {
  const cost = estimateCost(
    { input: 1000, output: 200, productContext: 0, cachedInput: 800, reasoningOutput: 100 },
    {
      model: "gpt-5.5",
      encoding: "o200k_base",
      inputPerMTok: 10,
      outputPerMTok: 10,
      contextPerMTok: 0,
      cachedInputPerMTok: 5,
      reasoningOutputPerMTok: 15,
    }
  );

  assert.equal(cost.inputUsd, 0.01);
  assert.equal(cost.outputUsd, 0.002);
  assert.equal(cost.cachedInputUsd, 0.004);
  assert.equal(cost.uncachedInputUsd, 0.002);
  assert.equal(cost.reasoningOutputUsd, 0.0015);
  assert.equal(cost.nonReasoningOutputUsd, 0.001);
  assert.ok(cost.cachedInputUsd < cost.inputUsd / 2);
  const effective = cost.cachedInputUsd + cost.uncachedInputUsd + cost.nonReasoningOutputUsd + cost.reasoningOutputUsd + cost.contextUsd;
  assert.equal(cost.totalUsd, effective);
  assert.ok(cost.totalUsd < cost.inputUsd + cost.outputUsd);
});

test("estimateCost falls back to full rates when split rates are absent", () => {
  const cost = estimateCost(
    { input: 1000, output: 200, cachedInput: 900, reasoningOutput: 100 },
    { model: "gpt-5.5", encoding: "o200k_base", inputPerMTok: 5, outputPerMTok: 30, contextPerMTok: 0 }
  );
  assert.equal(cost.cachedInputUsd, 900 / 1_000_000 * 5);
  assert.equal(cost.totalUsd, cost.inputUsd + cost.outputUsd + cost.contextUsd);
});

test("pricing.json exposes Neuralwatt rates for glm-5.2 and kimi-k2.7-code with split lines", async () => {
  const pricing = JSON.parse(await readFile("sdlbench/config/pricing.json", "utf8"));
  // Scaled to keep split-out lines well inside round4 precision (4 dp).
  const tokens = { input: 1_000_000, output: 200_000, cachedInput: 900_000, reasoningOutput: 100_000 };

  const glmCost = estimateCost(tokens, { ...pricing.models["glm-5.2"], model: "glm-5.2", pricingSource: "model" });
  assert.equal(glmCost.pricingModel, "glm-5.2");
  assert.equal(glmCost.inputUsd, 1.45);
  assert.equal(glmCost.outputUsd, 0.9);
  assert.equal(glmCost.cachedInputUsd, 0.324);
  assert.equal(glmCost.reasoningOutputUsd, 0.45);
  assert.ok(glmCost.cachedInputUsd < glmCost.inputUsd / 2);

  const kimiCost = estimateCost(tokens, { ...pricing.models["kimi-k2.7-code"], model: "kimi-k2.7-code", pricingSource: "model" });
  assert.equal(kimiCost.pricingModel, "kimi-k2.7-code");
  assert.equal(kimiCost.inputUsd, 0.95);
  assert.equal(kimiCost.outputUsd, 0.8);
  assert.equal(kimiCost.cachedInputUsd, 0.216);
  assert.equal(kimiCost.reasoningOutputUsd, 0.4);
  assert.ok(kimiCost.cachedInputUsd < kimiCost.inputUsd / 2);
});

test("sdlbench/config/agents/opencode.json declares the opencode agent with Neuralwatt wiring", async () => {
  const cfg = JSON.parse(await readFile("sdlbench/config/agents/opencode.json", "utf8"));
  assert.equal(cfg.schemaVersion, 1);
  assert.equal(cfg.agent, "opencode");
  assert.equal(cfg.model, "glm-5.2");
  assert.match(cfg.commandTemplate, /opencode run/);
  assert.match(cfg.commandTemplate, /\{repo\}/);
  assert.match(cfg.commandTemplate, /\{prompt\}/);
  assert.match(cfg.commandTemplate, /--model neuralwatt\/\{model\}/);
  assert.match(cfg.commandTemplate, /--dangerously-skip-permissions/);
  assert.ok(cfg.envPassthrough.includes("NEURALWATT_API_KEY"));
  assert.ok(cfg.timeoutMs >= 60_000);
});

test("buildChartModel exposes paired deltas, execution modes, and mixed-mode warnings", () => {
  const records = parseJsonl(`
{"variant":"baseline","taskId":"t1","agent":"codex","model":"m","durationMs":1000,"tokens":{"total":100},"cost":{"totalUsd":0.1},"quality":{"passed":true},"workflow":{"executionMode":"fixture"},"claimGrade":"none"}
{"variant":"sdl","taskId":"t1","agent":"codex","model":"m","durationMs":900,"tokens":{"total":40},"cost":{"totalUsd":0.04},"quality":{"passed":true},"workflow":{"executionMode":"fixture"},"claimGrade":"none"}
{"variant":"baseline","taskId":"t2","agent":"codex","model":"m","durationMs":800,"tokens":{"total":300},"cost":{"totalUsd":0.2},"quality":{"passed":true},"workflow":{"executionMode":"behavior"},"claimGrade":"primary"}
{"variant":"sdl","taskId":"t2","agent":"codex","model":"m","durationMs":700,"tokens":{"total":120},"cost":{"totalUsd":0.08},"quality":{"passed":true},"workflow":{"executionMode":"behavior"},"claimGrade":"primary"}
`);
  const model = buildChartModel(records);

  assert.ok(model.executionModes.includes("fixture"));
  assert.ok(model.executionModes.includes("behavior"));
  assert.equal(model.pairedDeltas.length, 2);
  const behaviorPair = model.pairedDeltas.find((pair) => pair.executionMode === "behavior");
  assert.equal(behaviorPair.deltaTok, 180);
  assert.equal(behaviorPair.deltaPct, 60);
  assert.ok(model.warnings.includes("mixed fixture and behavior sessions"));
});

test("viewer parses loaded JSONL and exposes token, time, and correctness metrics", () => {
  const records = parseJsonl(`
{"agent":"codex","variant":"baseline","taskId":"bug-fix","repoId":"fixture-js","durationMs":1000,"tokens":{"saved":0,"total":100,"tokenizerSource":"tiktoken"},"cost":{"totalUsd":0.1},"quality":{"errorRate":0,"passed":true},"status":"pass"}
{"agent":"codex","variant":"sdl","taskId":"bug-fix","repoId":"fixture-js","durationMs":900,"tokens":{"saved":60,"total":40,"tokenizerSource":"tiktoken"},"cost":{"totalUsd":0.04},"quality":{"errorRate":0,"passed":true},"status":"pass"}
`);
  const model = buildChartModel(records);

  assert.equal(model.variants.length, 2);
  assert.equal(model.tokenSavings.find((row) => row.variant === "sdl").saved, 60);
  assert.equal(model.timeToCompletion.find((row) => row.variant === "sdl").avgDuration, 900);
  assert.equal(model.correctness.find((row) => row.variant === "sdl").passRate, 100);
  assert.equal(model.timeline.length, 2);
});

test("viewer filters stay reusable and bar charts have room", async () => {
  const [appSource, html] = await Promise.all([
    readFile("sdlbench/viewer/app.mjs", "utf8"),
    readFile("sdlbench/viewer/index.html", "utf8"),
  ]);

  assert.match(appSource, /variantFilter\.onchange/);
  assert.match(appSource, /modeFilter\.onchange/);
  assert.doesNotMatch(appSource, /once:\s*true/);
  assert.match(html, /token-chart" viewBox="0 0 900 270"/);
  assert.match(html, /id="execution-mode-filter"/);
  assert.match(html, /id="paired-chart"/);
  assert.match(html, /id="warning-banner"/);
  assert.match(html, /id="load-sidecars"/);
});

test("serveViewer lists sidecar jsonl files and serves them", async () => {
  const resultsRoot = await mkdtemp(join(tmpdir(), "sdlbench-serve-"));
  const resultsPath = join(resultsRoot, "sessions.jsonl");
  await writeFile(resultsPath, '{"variant":"baseline","taskId":"t1","quality":{"passed":true}}\n');
  await writeFile(join(resultsRoot, "behavior-1.jsonl"), '{"variant":"sdl","taskId":"t1","quality":{"passed":true}}\n');

  const { port, close } = await serveViewer({ port: 0, resultsPath });
  try {
    const listRes = await fetch(`http://127.0.0.1:${port}/results/list.json`);
    assert.ok(listRes.ok);
    const list = await listRes.json();
    assert.ok(list.files.includes("sessions.jsonl"));
    assert.ok(list.files.includes("behavior-1.jsonl"));

    const sidecarRes = await fetch(`http://127.0.0.1:${port}/results/behavior-1.jsonl`);
    assert.ok(sidecarRes.ok);
    const sidecarText = await sidecarRes.text();
    assert.match(sidecarText, /sdl/);
  } finally {
    await close();
    await rm(resultsRoot, { force: true, recursive: true });
  }
});

test("fixture records carry claimGrade=none and zeroed savings after schema v2", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdlbench-claim-fixture-"));

  try {
    const result = await runBenchmark({
      agent: "codex",
      matrixPath: "sdlbench/tasks/matrix.json",
      resultsPath: join(root, "sessions.jsonl"),
      tokenizerCommand: await fakeTokenizer(root),
      variant: "sdl",
      workDir: join(root, "work"),
    });

    assert.ok(result.records.every((record) => record.schemaVersion === 2));
    assert.ok(result.records.every((record) => record.claimGrade === "none"));
    assert.ok(result.records.every((record) => record.tokens.saved === 0));
    assert.ok(result.records.every((record) => record.tokens.savingsPercent === 0));
    assert.ok(result.records.every((record) => record.tokens.rawEquivalent === record.tokens.total));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("behavior records carry claimGrade=primary when codex session counts are present", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdlbench-claim-behavior-"));
  const repo = join(root, "repo");
  const matrixPath = join(root, "matrix.json");
  const agentPath = join(root, "agent.mjs");
  const codexSessionsDir = join(root, "codex-sessions");
  const dayDir = join(codexSessionsDir, "2026", "06", "26");

  try {
    await mkdir(dayDir, { recursive: true });
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(join(repo, "tests"), { recursive: true });
    await writeFile(join(repo, "package.json"), "{\"type\":\"module\"}\n");
    await writeFile(join(repo, "src", "value.js"), "export const value = \"broken\";\n");
    await writeFile(join(repo, "tests", "value.test.mjs"), `
      import assert from "node:assert/strict";
      import { value } from "../src/value.js";
      assert.equal(value, "claim-primary");
    `);
    await writeFile(matrixPath, JSON.stringify({
      schemaVersion: 1,
      tasks: [{
        schemaVersion: 1,
        taskId: "claim-primary-behavior",
        repoId: "claim-behavior",
        category: "bug-fix",
        prompt: "Make value export claim-primary.",
        repo: { sourcePath: repo },
        context: { raw: "tiny raw context", sdl: "tiny sdl context" },
        verify: { command: "node tests/value.test.mjs", timeoutMs: 10000 },
        rubric: { maxScore: 1 },
        solution: { files: { "src/value.js": "export const value = \"canned\";\n" } }
      }]
    }));
    await writeFile(agentPath, `
      import { mkdirSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const repo = process.argv[process.argv.indexOf("--repo") + 1];
      const sessions = process.argv[process.argv.indexOf("--sessions") + 1];
      mkdirSync(sessions, { recursive: true });
      writeFileSync(join(repo, "src", "value.js"), "export const value = \\\"claim-primary\\\";\\n");
      writeFileSync(join(sessions, "rollout-claim.jsonl"), [
        JSON.stringify({ timestamp: "2026-06-26T00:00:00.000Z", type: "session_meta", payload: { session_id: "claim-session", cwd: repo, source: "exec", cli_version: "0.test" } }),
        JSON.stringify({ timestamp: "2026-06-26T00:00:01.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1234, cached_input_tokens: 900, output_tokens: 456, reasoning_output_tokens: 123, total_tokens: 1690 }, model_context_window: 258400 } } })
      ].join("\\n") + "\\n");
    `);

    const result = await runBenchmark({
      agent: "local",
      agentCommand: `node ${JSON.stringify(agentPath)} --repo {repo} --sessions ${JSON.stringify(dayDir)}`,
      codexSessionsDir,
      executionMode: "behavior",
      matrixPath,
      resultsPath: join(root, "sessions.jsonl"),
      tokenizerCommand: await fakeTokenizer(root),
      variant: "baseline",
      workDir: join(root, "work"),
    });
    const [record] = result.records;

    assert.equal(record.schemaVersion, 2);
    assert.equal(record.claimGrade, "primary");
    assert.equal(record.tokens.tokenizerSource, "codex-session");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("prepareOpencodeSterileRuntime places SDL MCP remote config in OPENCODE_CONFIG_CONTENT", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdlbench-opencode-prep-"));
  const workDir = join(root, "work");
  await mkdir(workDir, { recursive: true });
  try {
    const runtime = await prepareOpencodeSterileRuntime({
      root,
      workDir,
      taskRunId: "test-run-id",
      sdlSession: { mcpUrl: "http://127.0.0.1:12345/mcp" },
    });
    assert.ok(runtime.env.OPENCODE_CONFIG_CONTENT, "OPENCODE_CONFIG_CONTENT must be set");
    const cfg = JSON.parse(runtime.env.OPENCODE_CONFIG_CONTENT);
    assert.equal(cfg.mcp["sdl-mcp"].type, "remote");
    assert.equal(cfg.mcp["sdl-mcp"].url, "http://127.0.0.1:12345/mcp");
    assert.equal(cfg.mcp["sdl-mcp"].enabled, true);
    assert.ok(runtime.env.OPENCODE_DATA_DIR, "OPENCODE_DATA_DIR must be set");
    assert.ok(runtime.env.OPENCODE_DATA_DIR.includes("test-run-id"),
      "OPENCODE_DATA_DIR should live under a per-run temp dir, not the user's home");
    assert.ok(runtime.storageDir && runtime.storageDir === runtime.env.OPENCODE_DATA_DIR);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("prepareOpencodeSterileRuntime omits MCP server entry when sdlSession is null (baseline variant)", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdlbench-opencode-prep-null-"));
  const workDir = join(root, "work");
  await mkdir(workDir, { recursive: true });
  try {
    const runtime = await prepareOpencodeSterileRuntime({
      root,
      workDir,
      taskRunId: "test-run-id",
      sdlSession: null,
    });
    const cfg = JSON.parse(runtime.env.OPENCODE_CONFIG_CONTENT);
    assert.deepEqual(cfg.mcp, {});
    assert.ok(runtime.env.OPENCODE_DATA_DIR.includes("test-run-id"));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("prepareOpencodeSterileRuntime passes NEURALWATT_API_KEY through when present in process env", async () => {
  const prev = process.env.NEURALWATT_API_KEY;
  process.env.NEURALWATT_API_KEY = "sk-test-key";
  const root = await mkdtemp(join(tmpdir(), "sdlbench-opencode-key-"));
  const workDir = join(root, "work");
  await mkdir(workDir, { recursive: true });
  try {
    const runtime = await prepareOpencodeSterileRuntime({
      root,
      workDir,
      taskRunId: "test-run-id",
      sdlSession: null,
    });
    assert.equal(runtime.env.NEURALWATT_API_KEY, "sk-test-key");
  } finally {
    if (prev === undefined) delete process.env.NEURALWATT_API_KEY;
    else process.env.NEURALWATT_API_KEY = prev;
    await rm(root, { force: true, recursive: true });
  }
});

test("behavior mode with agent=opencode passes the sterile runtime env to the agent process", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdlbench-opencode-behavior-"));
  const repo = join(root, "repo");
  const matrixPath = join(root, "matrix.json");
  const agentPath = join(root, "agent.mjs");
  const probePath = join(root, "env-probe.json");

  try {
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(join(repo, "tests"), { recursive: true });
    await writeFile(join(repo, "package.json"), "{\"type\":\"module\"}\n");
    await writeFile(join(repo, "src", "value.js"), "export const value = \"broken\";\n");
    await writeFile(join(repo, "tests", "value.test.mjs"), `
      import assert from "node:assert/strict";
      import { value } from "../src/value.js";
      assert.equal(value, "opencode");
    `);
    await writeFile(matrixPath, JSON.stringify({
      schemaVersion: 1,
      tasks: [{
        schemaVersion: 1,
        taskId: "opencode-env-probe",
        repoId: "fixture-js",
        category: "bug-fix",
        prompt: "Make value export opencode.",
        repo: { sourcePath: repo },
        context: { raw: "RAW_CONTEXT_ONLY", sdl: "SDL_CONTEXT_ONLY" },
        verify: { command: "node tests/value.test.mjs", timeoutMs: 10000 },
        rubric: { maxScore: 1 },
        solution: { files: { "src/value.js": "export const value = \"canned\";\n" } }
      }]
    }));
    await writeFile(agentPath, `
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      const repo = process.argv[process.argv.indexOf("--repo") + 1];
      const cfg = process.env.OPENCODE_CONFIG_CONTENT;
      const storage = process.env.OPENCODE_DATA_DIR;
      writeFileSync(${JSON.stringify(probePath)}, JSON.stringify({ cfg, storage }));
      writeFileSync(join(repo, "src", "value.js"), "export const value = \\\"opencode\\\";\\n");
    `);

    const result = await runBenchmark({
      agent: "opencode",
      agentCommand: `node ${JSON.stringify(agentPath)} --repo {repo}`,
      executionMode: "behavior",
      matrixPath,
      resultsPath: join(root, "sessions.jsonl"),
      tokenizerCommand: await fakeTokenizer(root),
      variant: "baseline",
      workDir: join(root, "work"),
    });
    const [record] = result.records;

    assert.equal(record.status, "pass");
    assert.equal(record.agent, "opencode");
    assert.equal(record.workflow.executionMode, "behavior");
    const probe = JSON.parse(await readFile(probePath, "utf8"));
    assert.ok(probe.cfg, "OPENCODE_CONFIG_CONTENT reached the agent process");
    const parsedCfg = JSON.parse(probe.cfg);
    assert.deepEqual(parsedCfg.mcp, {}, "baseline variant should not wire an MCP server");
    assert.ok(probe.storage, "OPENCODE_DATA_DIR reached the agent process");
    assert.ok(probe.storage.includes(record.runId), "storage dir is per-run isolated");
    assert.ok(!probe.storage.includes(".local/share/opencode/storage"),
      "storage path must not match the user's default opencode storage location");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
