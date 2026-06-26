import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createServer as createNetServer } from "node:net";
import { performance } from "node:perf_hooks";

const SCHEMA_VERSION = 1;
const DEFAULT_RESULTS = "sdlbench/results/sessions.jsonl";
const DEFAULT_ENCODING = "o200k_base";
const DEFAULT_MODEL = "gpt-5.5";
const TIKTOKEN_SPEC = "git+https://github.com/openai/tiktoken@0.13.0";
const DEFAULT_PRICING = {
  model: DEFAULT_MODEL,
  encoding: DEFAULT_ENCODING,
  inputPerMTok: 1.25,
  outputPerMTok: 10,
  contextPerMTok: 0,
};

export async function setupBenchmark({ root = defaultRoot(), installTokenizer = true } = {}) {
  for (const rel of ["sdlbench/.work/products", "sdlbench/.work/repos", "sdlbench/results"]) {
    await mkdir(join(root, rel), { recursive: true });
  }
  if (installTokenizer) ensureTiktoken(root);
  return { ok: true, tokenizerCommand: defaultTokenizerCommand(root) };
}

export async function runBenchmark(options = {}) {
  const root = options.root ?? defaultRoot();
  const matrixPath = abs(root, options.matrixPath ?? "sdlbench/tasks/matrix.json");
  const resultsPath = abs(root, options.resultsPath ?? DEFAULT_RESULTS);
  const workDir = abs(root, options.workDir ?? "sdlbench/.work/repos");
  const agent = options.agent ?? "codex";
  const variant = options.variant ?? "baseline";
  const tokenizerCommand = options.tokenizerCommand ?? defaultTokenizerCommand(root);
  const executionMode = options.executionMode ?? (options.behavior ? "behavior" : "fixture");
  if (!["fixture", "behavior"].includes(executionMode)) throw new Error(`Unknown executionMode ${executionMode}`);
  const pricing = await loadPricing(root, options.pricingPath);
  const agentConfig = await loadAgentConfig(root, agent, options, { requireCommand: executionMode === "behavior" });
  const model = resolveModel({ options, agentConfig, pricing });
  const modelPricing = resolveModelPricing(pricing, model);
  const matrix = await readJson(matrixPath);
  const tasks = await loadTasks(root, dirname(matrixPath), matrix);
  const records = [];

  await mkdir(dirname(resultsPath), { recursive: true });
  await mkdir(workDir, { recursive: true });

  for (const task of tasks) {
    const started = performance.now();
    const taskRunId = `${Date.now()}-${task.taskId}-${variant}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
    const runRoot = join(workDir, taskRunId);
    await rm(runRoot, { force: true, recursive: true });
    await cp(abs(root, task.repo.sourcePath), runRoot, { recursive: true });

    const setupStart = performance.now();
    const sdlEvidence = variant === "sdl"
      ? await collectSdlHttpEvidence({ root, workDir, runRoot, task, taskRunId, options })
      : null;
    let promptPath = null;
    let agentResult = null;
    let agentMs = 0;
    let changedFiles = Object.keys(task.solution?.files ?? {});
    let outputText;

    if (executionMode === "behavior") {
      promptPath = join(runRoot, ".sdlbench-prompt.md");
      await writeFile(promptPath, renderAgentPrompt(task, variant, sdlEvidence?.context), "utf8");
      const before = await snapshotFiles(runRoot);
      const agentStart = performance.now();
      agentResult = runAgentCommand(agentConfig, { runRoot, promptPath, task, variant, model });
      agentMs = Math.round(performance.now() - agentStart);
      changedFiles = diffSnapshots(before, await snapshotFiles(runRoot));
      outputText = [agentResult.stdout, agentResult.stderr].filter(Boolean).join("\n");
    } else {
      await applySolution(runRoot, task);
    }
    const setupMs = Math.max(0, Math.round(performance.now() - setupStart) - agentMs);

    const verify = runCommand(task.verify.command, runRoot, task.verify.timeoutMs ?? 10000);
    const durationMs = Math.round(performance.now() - started);
    const passed = verify.exitCode === 0 && (!agentResult || agentResult.exitCode === 0);
    const tokens = countSessionTokens(task, variant, tokenizerCommand, sdlEvidence?.context, outputText, {
      model,
      encoding: modelPricing.encoding,
    });
    const record = {
      schemaVersion: SCHEMA_VERSION,
      runId: taskRunId,
      sessionId: randomUUID(),
      timestamp: new Date().toISOString(),
      agent,
      model,
      variant,
      product: variant,
      repoId: task.repoId,
      taskId: task.taskId,
      category: task.category,
      status: passed ? "pass" : "fail",
      durationMs,
      setupMs,
      agentMs: agentResult ? agentMs : Math.max(0, durationMs - setupMs),
      tokens,
      cost: estimateCost(tokens, modelPricing),
      quality: {
        passed,
        errorRate: passed ? 0 : 1,
        weightedErrorRate: passed ? 0 : 1,
        rubricScore: passed ? task.rubric?.maxScore ?? 1 : 0,
      },
      workflow: {
        executionMode,
        turns: task.workflow?.turns ?? 1,
        toolCalls: task.workflow?.toolCalls ?? (variant === "sdl" ? 2 : 0),
        fileReads: task.workflow?.fileReads ?? (variant === "sdl" ? 1 : 3),
        shellCommands: 1 + (agentResult ? 1 : 0),
        testsRun: 1,
        filesChanged: changedFiles.length,
        humanInterventions: 0,
      },
      artifacts: {
        worktree: runRoot,
        promptPath,
        agent: agentResult,
        changedFiles,
        sdl: sdlEvidence,
        verifyStdout: verify.stdout.slice(-4000),
        verifyStderr: verify.stderr.slice(-4000),
      },
    };

    records.push(record);
    await appendFile(resultsPath, `${JSON.stringify(record)}\n`, "utf8");
  }

  return { records, resultsPath };
}

export function importTranscript({ agent, variant, text, repoId = "unknown", taskId = "imported", tokenizerCommand = defaultTokenizerCommand(defaultRoot()) }) {
  const parsed = parseMaybeJsonl(text);
  const rawText = parsed.map((entry) => JSON.stringify(entry)).join("\n") || text;
  const counted = runTokenizer(tokenizerCommand, {
    transcript: rawText,
  });
  const total = counted.counts.transcript;
  const input = Math.ceil(total / 2);
  const output = total - input;
  const tokens = normalizeTokens({
    input,
    output,
    productContext: 0,
    rawEquivalent: total,
    tokenizer: counted,
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    runId: `import-${hash(rawText).slice(0, 10)}`,
    sessionId: randomUUID(),
    timestamp: new Date().toISOString(),
    agent,
    variant,
    product: variant,
    repoId,
    taskId,
    status: "imported",
    durationMs: 0,
    setupMs: 0,
    agentMs: 0,
    tokens,
    cost: estimateCost(tokens),
    quality: { passed: true, errorRate: 0, weightedErrorRate: 0, rubricScore: 0 },
    workflow: { turns: parsed.length || 1, toolCalls: 0, fileReads: 0, shellCommands: 0, testsRun: 0, filesChanged: 0, humanInterventions: 0 },
    artifacts: {},
  };
}

export function analyzeSessions(records) {
  const byVariant = {};
  for (const record of records) {
    const bucket = byVariant[record.variant] ??= { sessions: 0, passed: 0, tokens: 0, saved: 0, costUsd: 0, durationMs: [] };
    bucket.sessions += 1;
    bucket.passed += record.quality?.passed ? 1 : 0;
    bucket.tokens += record.tokens?.total ?? 0;
    bucket.saved += record.tokens?.saved ?? 0;
    bucket.costUsd += record.cost?.totalUsd ?? 0;
    bucket.durationMs.push(record.durationMs ?? 0);
  }

  for (const bucket of Object.values(byVariant)) {
    bucket.passRate = pct(bucket.passed, bucket.sessions);
    bucket.savingsPercent = pct(bucket.saved, bucket.tokens + bucket.saved);
    bucket.p50DurationMs = percentile(bucket.durationMs, 50);
    delete bucket.durationMs;
  }

  const baseline = byVariant.baseline;
  const deltas = {};
  if (baseline) {
    for (const [variant, bucket] of Object.entries(byVariant)) {
      if (variant === "baseline") continue;
      deltas[variant] = {
        tokensSaved: baseline.tokens - bucket.tokens,
        costSavedUsd: round4(baseline.costUsd - bucket.costUsd),
        durationDeltaMs: bucket.p50DurationMs - baseline.p50DurationMs,
      };
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    totals: { sessions: records.length, variants: Object.keys(byVariant).length },
    byVariant,
    deltas,
  };
}

export async function readJsonl(path) {
  const text = await readFile(path, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return text.trim() ? text.trim().split(/\r?\n/).map((line) => JSON.parse(line)) : [];
}

export async function writeAnalysis({ inPath, outPath }) {
  const records = await readJsonl(inPath);
  const summary = analyzeSessions(records);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summary;
}

async function loadTasks(root, matrixDir, matrix) {
  const files = matrix.taskFiles ?? [];
  const inline = matrix.tasks ?? [];
  const fromFiles = [];
  for (const file of files) {
    const data = await readJson(abs(matrixDir, file));
    fromFiles.push(...(Array.isArray(data.tasks) ? data.tasks : data));
  }
  return [...inline, ...fromFiles].map((task) => validateTask(root, task));
}

function validateTask(root, task) {
  const required = ["schemaVersion", "taskId", "repoId", "category", "prompt", "repo", "verify"];
  for (const key of required) {
    if (task[key] == null) throw new Error(`Task ${task.taskId ?? "<unknown>"} missing ${key}`);
  }
  if (!task.repo.sourcePath) throw new Error(`Task ${task.taskId} missing repo.sourcePath`);
  if (!task.verify.command) throw new Error(`Task ${task.taskId} missing verify.command`);
  if (!task.context?.raw || !task.context?.sdl) throw new Error(`Task ${task.taskId} missing context.raw/context.sdl`);
  abs(root, task.repo.sourcePath);
  return task;
}

async function applySolution(runRoot, task) {
  for (const [rel, content] of Object.entries(task.solution?.files ?? {})) {
    const target = join(runRoot, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
}

async function loadAgentConfig(root, agent, options, { requireCommand = false } = {}) {
  if (options.agentCommand) {
    return {
      commandTemplate: options.agentCommand,
      timeoutMs: options.agentTimeoutMs ?? 600_000,
      model: options.model,
    };
  }

  const configPath = abs(root, options.agentConfigPath ?? `sdlbench/config/agents/${agent}.json`);
  try {
    const config = await readJson(configPath);
    if (requireCommand && !config.commandTemplate) throw new Error(`Agent config ${configPath} missing commandTemplate`);
    return {
      ...config,
      // CLI overrides must still win when the command comes from an agent config.
      timeoutMs: options.agentTimeoutMs ?? config.timeoutMs,
      configPath,
    };
  } catch (error) {
    if (requireCommand || error?.code !== "ENOENT") throw error;
    return { model: options.model };
  }
}

function renderAgentPrompt(task, variant, sdlContext) {
  const context = variant === "sdl" ? sdlContext : task.context.raw;
  return [
    `Task: ${task.taskId}`,
    task.prompt,
    "Context:",
    context,
    "Edit this repository in place. Keep changes limited to the task."
  ].join("\n\n");
}

function runAgentCommand(config, { runRoot, promptPath, task, variant, model }) {
  const command = renderCommandTemplate(config.commandTemplate, { repo: runRoot, prompt: promptPath, taskId: task.taskId, variant, model });
  return { command, ...runCommand(command, runRoot, config.timeoutMs ?? 600_000) };
}

function renderCommandTemplate(template, values) {
  return template.replace(/\{(repo|prompt|taskId|variant|model)\}/g, (_match, key) => shellArg(values[key]));
}

function shellArg(value) {
  return JSON.stringify(String(value));
}

async function snapshotFiles(root) {
  const files = new Map();
  async function walk(dir) {
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      const rel = dir ? dir + "/" + entry.name : entry.name;
      if (entry.isDirectory()) {
        if (entry.name !== ".git" && entry.name !== "node_modules") await walk(rel);
      } else if (entry.isFile()) {
        files.set(rel, hash(await readFile(join(root, rel))));
      }
    }
  }
  await walk("");
  return files;
}

function diffSnapshots(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((file) => before.get(file) !== after.get(file))
    .sort();
}

function runCommand(command, cwd, timeoutMs) {
  const result = spawnSync(command, { cwd, encoding: "utf8", shell: true, timeout: timeoutMs });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}


async function collectSdlHttpEvidence({ root, workDir, runRoot, task, taskRunId, options }) {
  const authToken = options.sdlAuthToken ?? "sdlbench-" + taskRunId;
  if (options.sdlHttpBaseUrl) {
    return retrieveSdlHttpContext({
      baseUrl: options.sdlHttpBaseUrl,
      authToken,
      task,
      timeoutMs: options.sdlHttpTimeoutMs ?? 120_000,
    });
  }

  const sdlRoot = join(workDir, taskRunId + ".sdl");
  await rm(sdlRoot, { force: true, recursive: true });
  await mkdir(sdlRoot, { recursive: true });
  const configPath = join(sdlRoot, "sdlmcp.config.json");
  const dbPath = join(sdlRoot, "graph.lbug");
  await writeFile(configPath, JSON.stringify(createSdlHttpConfig({ task, runRoot, dbPath, authToken }), null, 2), "utf8");

  const cliPath = join(root, "dist/cli/index.js");
  if (!existsSync(cliPath)) {
    throw new Error("SDLBench HTTP mode requires dist/cli/index.js; run npm run build:runtime first.");
  }

  const port = await getFreePort();
  const child = spawn(process.execPath, [
    cliPath,
    "--config",
    configPath,
    "serve",
    "--http",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
  ], {
    cwd: root,
    env: {
      ...process.env,
      SDL_CONFIG: configPath,
      SDL_GRAPH_DB_PATH: dbPath,
      SDL_LOG_LEVEL: process.env.SDLBENCH_SDL_LOG_LEVEL ?? "warn",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));

  try {
    const baseUrl = "http://127.0.0.1:" + port;
    await waitForHttpHealth(baseUrl, child, logs, options.sdlHttpTimeoutMs ?? 120_000);
    const evidence = await retrieveSdlHttpContext({
      baseUrl,
      authToken,
      task,
      timeoutMs: options.sdlHttpTimeoutMs ?? 120_000,
    });
    return {
      ...evidence,
      configPath,
      dbPath,
      server: { port, logTail: logs.join("").slice(-4000) },
    };
  } finally {
    await stopChild(child);
  }
}

function createSdlHttpConfig({ task, runRoot, dbPath, authToken }) {
  return {
    repos: [{
      repoId: task.repoId,
      rootPath: runRoot,
      ignore: [
        "**/.git/**",
        "**/dist/**",
        "**/build/**",
        "**/out/**",
        "**/target/**",
        "**/coverage/**",
        "**/node_modules/**",
        "**/.sdlbench/**",
        "**/.tmp/**",
      ],
      languages: ["ts", "tsx", "js", "jsx", "py", "go", "java", "cs", "c", "cpp", "php", "rs", "kt", "sh"],
      maxFileBytes: 2_000_000,
      includeNodeModulesTypes: true,
    }],
    graphDatabase: { path: dbPath },
    policy: {
      maxWindowLines: 180,
      maxWindowTokens: 1400,
      requireIdentifiers: true,
      allowBreakGlass: true,
    },
    redaction: { enabled: true, includeDefaults: true, patterns: [] },
    indexing: {
      pipeline: "auto",
      engine: "rust",
      concurrency: 12,
      pass2Concurrency: 8,
      enableFileWatching: true,
      maxWatchedFiles: 35000,
      watchDebounceMs: 750,
      providerFirst: {
        lsp: {
          mode: "primaryWithCaps",
        },
      },
    },
    slice: {
      defaultMaxCards: 60,
      defaultMaxTokens: 12000,
      edgeWeights: { call: 1, import: 0.6, config: 0.8 },
    },
    cache: {
      enabled: true,
      symbolCardMaxEntries: 2000,
      symbolCardMaxSizeBytes: 104857600,
      graphSliceMaxEntries: 1000,
      graphSliceMaxSizeBytes: 52428800,
    },
    semantic: {
      enabled: true,
      provider: "local",
      onnx: {
        intraOpNumThreads: 4,
        interOpNumThreads: 1,
        executionMode: "parallel",
      },
      executionProviders: ["dml", "cpu"],
      embeddingProfile: "specialized",
      embeddingConcurrency: 4,
      embeddingBatchSize: 32,
      fileSummaryEmbeddingBatchSize: 4,
      retrieval: {
        mode: "hybrid",
        fts: {
          enabled: true,
          indexName: "symbol_search_text_v1",
          topK: 75,
          conjunctive: false,
        },
        vector: {
          enabled: true,
          topK: 75,
          efs: 200,
        },
        fusion: {
          strategy: "rrf",
          rrfK: 60,
        },
        candidateLimit: 100,
      },
      symbolEmbeddingModels: ["jina-embeddings-v2-base-code"],
      fileSummaryEmbeddingModels: ["nomic-embed-text-v1.5"],
    },
    scip: {
      enabled: true,
      indexes: [
        {
          path: "index.scip",
        },
      ],
      externalSymbols: {
        enabled: true,
        maxPerIndex: 10000,
      },
      confidence: 0.95,
      autoIngestOnRefresh: true,
      generator: {
        enabled: true,
        binary: "scip-io",
        args: ["--include-additional-configs", "--timeout", "3600"],
        autoInstall: true,
        timeoutMs: 18000000,
      },
    },
    prefetch: { enabled: false, maxBudgetPercent: 20, warmTopN: 50 },
    http: { allowRemote: false },
    httpAuth: { enabled: true, token: authToken },
  };
}

async function retrieveSdlHttpContext({ baseUrl, authToken, task, timeoutMs }) {
  const started = performance.now();
  const repoId = encodeURIComponent(task.repoId);
  const index = await postSseJson(trimSlash(baseUrl) + "/api/repo/" + repoId + "/reindex-stream", { mode: "full" }, authToken, timeoutMs);
  const searches = [];
  for (const query of sdlQueriesForTask(task)) {
    const url = trimSlash(baseUrl) + "/api/symbol/" + repoId + "/search?q=" + encodeURIComponent(query) + "&limit=8";
    const payload = await getJson(url, authToken, timeoutMs);
    const results = normalizeHttpSearchResults(payload.results);
    searches.push({ query, results });
  }
  const resultCount = searches.reduce((sum, search) => sum + search.results.length, 0);
  if (resultCount === 0) {
    throw new Error("SDL HTTP retrieval returned no symbols for " + task.taskId);
  }
  const context = formatSdlHttpContext(task, index, searches);
  return {
    transport: "http",
    repoId: task.repoId,
    durationMs: Math.round(performance.now() - started),
    index,
    retrieval: {
      queries: searches.map((search) => ({ query: search.query, resultCount: search.results.length })),
      resultCount,
      results: searches.flatMap((search) => search.results).slice(0, 20),
    },
    context,
  };
}

function sdlQueriesForTask(task) {
  const configured = task.context?.sdlQueries;
  if (Array.isArray(configured) && configured.length > 0) return configured.map(String);
  const candidates = String((task.context?.sdl ?? "") + " " + (task.prompt ?? "")).match(/\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?\b/g) ?? [];
  const skip = new Set(["the", "and", "for", "with", "should", "from", "task", "context", "slice", "symbol"]);
  const picked = candidates.find((word) => word.includes(".")) ?? candidates.find((word) => word.length > 3 && !skip.has(word.toLowerCase()));
  return [picked ? picked.split(".").pop() : task.taskId];
}

function normalizeHttpSearchResults(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw == null || raw === "") return [];
  return [{ summary: String(raw) }];
}

function formatSdlHttpContext(task, index, searches) {
  const lines = [
    "SDL HTTP indexed " + task.repoId + " for " + task.taskId,
    "providerFirst=" + (index.providerFirstExecution ? "yes" : "unknown"),
  ];
  for (const search of searches) {
    lines.push("query " + search.query + ":");
    for (const result of search.results.slice(0, 5)) {
      if (typeof result === "string") {
        lines.push("- " + result);
      } else {
        lines.push(("- " + (result.kind ?? "symbol") + " " + (result.name ?? result.symbolId ?? "unknown") + " " + (result.file ?? "") + " " + (result.summary ?? "")).trim());
      }
    }
  }
  return lines.join("\n");
}

async function getJson(url, authToken, timeoutMs) {
  const response = await fetchWithTimeout(url, {
    headers: { Authorization: "Bearer " + authToken },
  }, timeoutMs);
  const text = await response.text();
  if (!response.ok) throw new Error("SDL HTTP GET " + url + " failed " + response.status + ": " + text.slice(0, 500));
  return JSON.parse(text);
}

async function postSseJson(url, body, authToken, timeoutMs) {
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + authToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }, timeoutMs);
  const text = await response.text();
  if (!response.ok) throw new Error("SDL HTTP POST " + url + " failed " + response.status + ": " + text.slice(0, 500));
  const events = parseSse(text);
  const failure = events.find((event) => event.event === "error");
  if (failure) throw new Error("SDL HTTP reindex failed: " + JSON.stringify(failure.data));
  const complete = events.reverse().find((event) => event.event === "complete");
  if (!complete) throw new Error("SDL HTTP reindex did not emit complete: " + text.slice(-500));
  return complete.data;
}

function parseSse(text) {
  return text.split(/\r?\n\r?\n/).filter(Boolean).map((block) => {
    let event = "message";
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    const joined = data.join("\n");
    return { event, data: joined ? JSON.parse(joined) : null };
  });
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHttpHealth(baseUrl, child, logs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error("SDL HTTP server exited early: " + logs.join("").slice(-4000));
    try {
      const response = await fetchWithTimeout(baseUrl + "/health", {}, 1000);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await sleep(250);
  }
  throw new Error("SDL HTTP server did not become healthy: " + logs.join("").slice(-4000));
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function stopChild(child) {
  if (child.exitCode != null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("close", resolve)),
    sleep(2000).then(() => {
      if (child.exitCode == null) child.kill("SIGKILL");
    }),
  ]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function countSessionTokens(task, variant, tokenizerCommand, sdlContext, outputOverride, tokenizerOptions = {}) {
  const outputText = outputOverride ?? Object.values(task.solution?.files ?? {}).join("\n");
  const activeContext = variant === "sdl" ? sdlContext : task.context.raw;
  const counted = runTokenizer(tokenizerCommand, {
    input: `${task.prompt}\n\n${activeContext}`,
    output: outputText || task.expectedArtifacts?.join("\n") || task.prompt,
    productContext: variant === "sdl" ? activeContext : "",
    rawInput: `${task.prompt}\n\n${task.context.raw}`,
  }, tokenizerOptions);

  return normalizeTokens({
    input: counted.counts.input,
    output: counted.counts.output,
    productContext: counted.counts.productContext,
    rawEquivalent: counted.counts.rawInput + counted.counts.output,
    tokenizer: counted,
  });
}

function runTokenizer(command, texts, { model = DEFAULT_MODEL, encoding = DEFAULT_ENCODING } = {}) {
  const payload = JSON.stringify({ encoding, model, modelHint: model, texts });
  const result = spawnSync(command, { encoding: "utf8", input: payload, shell: true });
  if (result.status !== 0) {
    throw new Error(`Tokenizer failed (${command}): ${(result.stderr || result.stdout || result.error?.message || "unknown error").trim()}`);
  }
  try {
    const parsed = JSON.parse(result.stdout.trim());
    if (!parsed.counts || parsed.tokenizerSource !== "tiktoken") throw new Error("missing tiktoken counts");
    return parsed;
  } catch (error) {
    throw new Error(`Tokenizer failed (${command}): ${error.message}`);
  }
}

function normalizeTokens({ input, output, productContext = 0, rawEquivalent, tokenizer }) {
  const total = input + output;
  const raw = Math.max(rawEquivalent ?? total, total);
  const saved = Math.max(0, raw - total);
  return {
    input,
    output,
    total,
    productContext,
    rawEquivalent: raw,
    saved,
    savingsPercent: pct(saved, raw),
    model: tokenizer.model ?? tokenizer.modelHint,
    encoding: tokenizer.encoding,
    modelHint: tokenizer.modelHint,
    tokenizerResolution: tokenizer.tokenizerResolution,
    tokenizerVersion: tokenizer.tokenizerVersion,
    tokenizerSource: tokenizer.tokenizerSource,
  };
}

function ensureTiktoken(root) {
  const python = venvPython(root);
  if (!existsSync(python)) {
    const created = spawnSync("python", ["-m", "venv", join(root, "sdlbench/.work/tiktoken-venv")], { encoding: "utf8" });
    if (created.status !== 0) throw new Error(`Failed to create tiktoken venv: ${created.stderr || created.stdout}`);
  }

  const probe = spawnSync(python, ["-c", "import tiktoken, importlib.metadata; print(importlib.metadata.version('tiktoken'))"], { encoding: "utf8" });
  if (probe.status === 0) return;

  const spec = process.env.SDLBENCH_TIKTOKEN_SPEC || TIKTOKEN_SPEC;
  const installed = spawnSync(python, ["-m", "pip", "install", spec], { encoding: "utf8" });
  if (installed.status !== 0) throw new Error(`Failed to install tiktoken ${spec}: ${installed.stderr || installed.stdout}`);
}

function defaultTokenizerCommand(root) {
  return `${JSON.stringify(venvPython(root))} ${JSON.stringify(join(root, "sdlbench/scripts/count_tokens.py"))}`;
}

function venvPython(root) {
  return join(root, "sdlbench/.work/tiktoken-venv/Scripts/python.exe");
}

function parseMaybeJsonl(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { text: line };
      }
    });
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

function pct(part, whole) {
  return whole ? Math.round((part / whole) * 10000) / 100 : 0;
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function estimateCost(tokens, pricing = DEFAULT_PRICING) {
  const rates = { ...DEFAULT_PRICING, ...pricing };
  const inputUsd = (tokens.input / 1_000_000) * rates.inputPerMTok;
  const outputUsd = (tokens.output / 1_000_000) * rates.outputPerMTok;
  const contextUsd = (tokens.productContext / 1_000_000) * rates.contextPerMTok;
  return {
    inputUsd: round4(inputUsd),
    outputUsd: round4(outputUsd),
    contextUsd: round4(contextUsd),
    totalUsd: round4(inputUsd + outputUsd + contextUsd),
    pricingModel: rates.model ?? tokens.model ?? DEFAULT_MODEL,
    inputPerMTok: rates.inputPerMTok,
    outputPerMTok: rates.outputPerMTok,
    contextPerMTok: rates.contextPerMTok,
    pricingSource: rates.pricingSource ?? "default",
  };
}

function hash(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function loadPricing(root, pricingPath) {
  const path = abs(root, pricingPath ?? "sdlbench/config/pricing.json");
  try {
    return await readJson(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { defaultModel: DEFAULT_MODEL, default: DEFAULT_PRICING, models: {} };
  }
}

function resolveModel({ options, agentConfig, pricing }) {
  return options.model ?? agentConfig?.model ?? pricing.defaultModel ?? pricing.default?.model ?? DEFAULT_MODEL;
}

function resolveModelPricing(pricing, model) {
  const defaults = { ...DEFAULT_PRICING, ...(pricing.default ?? {}) };
  const models = pricing.models ?? {};
  const modelEntry = models[model];
  if (Object.keys(models).length > 0 && !modelEntry) {
    throw new Error(`Pricing config missing rates for model ${model}`);
  }
  return {
    ...defaults,
    ...(modelEntry ?? {}),
    model,
    encoding: modelEntry?.encoding ?? defaults.encoding ?? DEFAULT_ENCODING,
    pricingSource: modelEntry ? "model" : "default",
  };
}

function defaultRoot() {
  const cwd = process.cwd();
  return cwd.endsWith("sdlbench") ? dirname(cwd) : cwd;
}

function abs(root, path) {
  return isAbsolute(path) ? path : resolve(root, path);
}
