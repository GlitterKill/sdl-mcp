import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  analyzeSessions,
  createSdlHttpConfig,
  findCodexSessionTokenCounts,
  importTranscript,
  runBenchmark,
} from "../src/sdlbench.mjs";
import { buildChartModel, parseJsonl } from "../viewer/app.mjs";

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
    assert.ok(lines.find((record) => record.variant === "sdl").tokens.saved > 0);
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
    { ...imported, variant: "baseline", tokens: { total: 100, saved: 0 }, cost: { totalUsd: 0.1 }, quality: { passed: true, errorRate: 0 } },
    { ...imported, variant: "sdl", tokens: { total: 45, saved: 55 }, cost: { totalUsd: 0.045 }, quality: { passed: true, errorRate: 0 } },
  ]);

  assert.equal(summary.totals.sessions, 2);
  assert.equal(summary.byVariant.sdl.savingsPercent, 55);
  assert.equal(summary.deltas.sdl.tokensSaved, 55);
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
  assert.doesNotMatch(appSource, /once:\s*true/);
  assert.match(html, /token-chart" viewBox="0 0 900 270"/);
});
