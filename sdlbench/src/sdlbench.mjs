import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createServer as createNetServer } from "node:net";
import { performance } from "node:perf_hooks";
import { signalsForLoss } from "./attribution-signals.mjs";
import { computeCoverage } from "./coverage.mjs";
import { mean, stdDev, bootstrapCI, mannWhitneyU } from "./stats.mjs";
import { prepareOpencodeSterileRuntime } from "./agents/opencode-runtime.mjs";
import { extractOpencodeSessionUsage, tokensFromOpencodeSessionCounts } from "./agents/opencode.mjs";

const SCHEMA_VERSION = 2;
const DEFAULT_RESULTS = "sdlbench/results/sessions.jsonl";
const DEFAULT_ENCODING = "o200k_base";
const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_REPOS_LOCK = "sdlbench/config/repos.lock.json";
const TIKTOKEN_SPEC = "git+https://github.com/openai/tiktoken@0.13.0";
const CODEX_SYSTEM_SKILLS = ["imagegen", "openai-docs", "plugin-creator", "skill-creator", "skill-installer"];
const CODEX_STERILE_FEATURES = [
  "plugins",
  "memories",
  "multi_agent",
  "goals",
  "apps",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "image_generation",
  "shell_snapshot",
  "personality",
  "tool_suggest",
  "skill_mcp_dependency_install",
];
const CODEX_FORBIDDEN_CONTEXT_MARKERS = [
  { name: "ponytail", pattern: /PONYTAIL MODE ACTIVE|ponytail:ponytail|plugins[\\/]+cache[\\/]+ponytail/i },
  { name: "plugin instructions", pattern: /<plugins_instructions>|plugins[\\/]+cache/i },
  { name: "app connector instructions", pattern: /<apps_instructions>/i },
  { name: "skill registry", pattern: /<skills_instructions>|### Available skills/i },
  { name: "memory context", pattern: /MEMORY_SUMMARY BEGINS|<oai-mem-citation>/i },
];
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
  const agent = options.agent ?? "codex";
  const variant = options.variant ?? "baseline";
  const tokenizerCommand = options.tokenizerCommand ?? defaultTokenizerCommand(root);
  const executionMode = options.executionMode ?? (options.behavior ? "behavior" : "fixture");
  if (!["fixture", "behavior"].includes(executionMode)) throw new Error(`Unknown executionMode ${executionMode}`);
  const workDir = abs(root, options.workDir ?? defaultWorkDir(root, executionMode));
  const pricing = await loadPricing(root, options.pricingPath);
  const agentConfig = await loadAgentConfig(root, agent, options, { requireCommand: executionMode === "behavior" });
  const model = resolveModel({ options, agentConfig, pricing });
  const modelPricing = resolveModelPricing(pricing, model);
  const matrix = await readJson(matrixPath);
  const reposLock = await loadReposLock(root, options.reposLockPath);
  const tasks = await loadTasks(root, dirname(matrixPath), matrix);
  const filteredTasks = options.repoIdFilter
    ? tasks.filter((task) => task.repoId === options.repoIdFilter)
    : tasks;
  const records = [];
  const warmSessions = new Map();
  const indexedRepos = new Set();

  await mkdir(dirname(resultsPath), { recursive: true });
  await mkdir(workDir, { recursive: true });

  for (const task of filteredTasks) {
    const started = performance.now();
    const taskRunId = `${Date.now()}-${task.taskId}-${variant}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
    const runRoot = join(workDir, taskRunId);
    await rm(runRoot, { force: true, recursive: true });
    await cp(abs(root, task.repo.sourcePath), runRoot, { recursive: true });

    let sdlSession = null;
    let ownsSdlSession = false;
    try {
      const setupStart = performance.now();
      if (variant === "sdl") {
        if (options.warmSession) {
          const warmKey = task.repoId;
          sdlSession = warmSessions.get(warmKey) ?? null;
          if (!sdlSession) {
            sdlSession = await startSdlHttpSession({ root, workDir, runRoot, task, taskRunId, options });
            warmSessions.set(warmKey, sdlSession);
            indexedRepos.add(warmKey);
          }
        } else {
          sdlSession = await startSdlHttpSession({ root, workDir, runRoot, task, taskRunId, options });
          ownsSdlSession = true;
        }
      }
      const sdlEvidence = sdlSession?.evidence ?? null;
      const setupMs = Math.round(performance.now() - setupStart);
      const activeStart = performance.now();
      let promptPath = null;
      let agentResult = null;
      let agentMs = 0;
      let agentStartedAt = 0;
      let changedFiles = Object.keys(task.solution?.files ?? {});
      let outputText;
      let codexRuntime = null;
      let agentRuntime = null;

      if (executionMode === "behavior") {
        if (sdlSession) await installSdlBenchmarkReinforcement(runRoot, sdlSession);
        if (agent === "codex") {
          assertCodexWorktreeIsSterile(root, runRoot);
          codexRuntime = await prepareCodexSterileRuntime({ root, workDir, taskRunId });
          agentRuntime = codexRuntime;
        } else if (agent === "opencode") {
          agentRuntime = await prepareOpencodeSterileRuntime({ root, workDir, taskRunId, sdlSession });
        }
        promptPath = join(runRoot, ".sdlbench-prompt.md");
        await writeFile(promptPath, renderAgentPrompt(task, variant), "utf8");
        const before = await snapshotFiles(runRoot);
        agentStartedAt = Date.now();
        const agentStart = performance.now();
        agentResult = runAgentCommand(agentConfig, { runRoot, promptPath, task, variant, model, sdlSession, agentRuntime });
        agentMs = Math.round(performance.now() - agentStart);
        changedFiles = diffSnapshots(before, await snapshotFiles(runRoot));
        outputText = [agentResult.stdout, agentResult.stderr].filter(Boolean).join("\n");
      } else {
        await applySolution(runRoot, task);
      }

      const verify = runCommand(task.verify.command, runRoot, task.verify.timeoutMs ?? 10000);
      const durationMs = Math.round(performance.now() - activeStart);
      const wallMs = Math.round(performance.now() - started);
      const passed = verify.exitCode === 0 && (!agentResult || agentResult.exitCode === 0);
      const estimatedTokens = countSessionTokens(task, variant, tokenizerCommand, promptContextForVariant(task, variant), outputText, {
        model,
        encoding: modelPricing.encoding,
      });
      const codexTokenCounts = executionMode === "behavior"
        ? await findCodexSessionTokenCounts({
          runRoot,
          sessionsDir: codexRuntime?.sessionsDir ?? options.codexSessionsDir,
          sinceMs: agentStartedAt ? agentStartedAt - 120_000 : 0,
          tokenizerCommand,
        })
        : null;
      if (executionMode === "behavior" && agent === "codex" && !codexTokenCounts) {
        throw new Error(`Codex behavior benchmark did not find matching session token_count JSONL for ${runRoot}`);
      }
      const codexSterility = agent === "codex" && codexTokenCounts?.sessionFile
        ? await inspectCodexSessionSterility(codexTokenCounts.sessionFile)
        : null;
      if (codexSterility && !codexSterility.passed) {
        throw new Error(`Non-sterile Codex session ${codexTokenCounts.sessionFile}: ${codexSterility.forbidden.join(", ")}`);
      }
      let opencodeSessionCounts = null;
      if (executionMode === "behavior" && agent === "opencode") {
        const storageDir = agentRuntime?.storageRoot;
        opencodeSessionCounts = extractOpencodeSessionUsage({ storageDir, runRoot });
        if (!opencodeSessionCounts.input && !opencodeSessionCounts.output) {
          throw new Error(`Opencode behavior benchmark did not find session usage under ${storageDir ?? "<unset XDG_DATA_HOME>"} for ${runRoot}`);
        }
      }
      const tokens = codexTokenCounts
        ? tokensFromCodexSessionCounts(codexTokenCounts, estimatedTokens)
        : opencodeSessionCounts
          ? tokensFromOpencodeSessionCounts(opencodeSessionCounts, estimatedTokens)
          : estimatedTokens;
      const claimGrade = resolveClaimGrade(executionMode, tokens.tokenizerSource);
      const repoMeta = resolveRepoMeta(task.repoId, reposLock);
      const workflowSteps = Array.isArray(task.workflow) ? task.workflow : [];
      const turns = workflowSteps.length || task.workflow?.turns || 1;
      const perTurnTokens = workflowSteps.length > 0
        ? workflowSteps.map((step, i) => ({ turn: i + 1, phase: step.phase ?? `turn-${i + 1}`, tokens: Math.round(tokens.total / workflowSteps.length) }))
        : [];
      const isFirstWarmTask = options.warmSession && variant === "sdl" && indexedRepos.has(task.repoId) && !records.some((r) => r.repoId === task.repoId && r.variant === variant);
      const indexCost = sdlSession?.evidence?.index
        ? (isFirstWarmTask ? estimateIndexCost(sdlSession.evidence.index, tokenizerCommand, { model, encoding: modelPricing.encoding }) : 0)
        : (variant === "sdl" ? estimateIndexCost(null, tokenizerCommand, { model, encoding: modelPricing.encoding }) : 0);
      tokens.indexCost = indexCost;
      const record = {
        schemaVersion: SCHEMA_VERSION,
        runId: taskRunId,
        sessionId: randomUUID(),
        timestamp: new Date().toISOString(),
        agent,
        model,
        variant,
        product: variant,
        claimGrade,
        warmSession: options.warmSession ?? false,
        repoId: task.repoId,
        repo: repoMeta,
        taskId: task.taskId,
        category: task.category,
        status: passed ? "pass" : "fail",
        durationMs,
        wallMs,
        setupMs,
        agentMs: agentResult ? agentMs : durationMs,
        tokens,
        cost: estimateCost(tokens, modelPricing),
        attribution: codexTokenCounts?.attribution
          ? buildAttribution(codexTokenCounts.attribution, tokens)
          : undefined,
        coverage: task.contextTargets
          ? computeCoverage({
              changedFiles,
              retrievedSymbols: variant === "sdl"
                ? (sdlEvidence?.retrieval?.results ?? []).map((r) => r.name).filter(Boolean)
                : [],
              contextTargets: task.contextTargets,
            })
          : undefined,
        perTurnTokens: perTurnTokens.length > 0 ? perTurnTokens : undefined,
        quality: {
          passed,
          errorRate: passed ? 0 : 1,
          weightedErrorRate: passed ? 0 : 1,
          rubricScore: passed ? task.rubric?.maxScore ?? 1 : 0,
        },
        workflow: {
          executionMode,
          turns,
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
          codexSession: codexTokenCounts ? codexSessionArtifact(codexTokenCounts) : undefined,
          codexSterility: codexSterility ?? undefined,
          estimatedTokens: codexTokenCounts ? estimatedTokens : undefined,
          sdl: { ...sdlEvidence, observability: sdlSession?.observability ?? undefined },
          verifyStdout: verify.stdout.slice(-4000),
          verifyStderr: verify.stderr.slice(-4000),
        },
      };

      records.push(record);
      await appendFile(resultsPath, `${JSON.stringify(record)}\n`, "utf8");
    } finally {
      if (ownsSdlSession) await sdlSession?.stop?.();
    }
  }

  for (const session of warmSessions.values()) await session?.stop?.();

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
    claimGrade: "none",
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
    const executionMode = record.workflow?.executionMode ?? "unknown";
    const bucket = byVariant[record.variant] ??= { byExecutionMode: {}, durationMs: [] };
    const modeBucket = bucket.byExecutionMode[executionMode] ??= { sessions: 0, passed: 0, tokens: 0, costUsd: 0, durationMs: [] };
    modeBucket.sessions += 1;
    modeBucket.passed += record.quality?.passed ? 1 : 0;
    modeBucket.tokens += record.tokens?.total ?? 0;
    modeBucket.costUsd += record.cost?.totalUsd ?? 0;
    modeBucket.durationMs.push(record.durationMs ?? 0);
    bucket.durationMs.push(record.durationMs ?? 0);
  }

  for (const bucket of Object.values(byVariant)) {
    for (const modeBucket of Object.values(bucket.byExecutionMode)) {
      modeBucket.passRate = pct(modeBucket.passed, modeBucket.sessions);
      modeBucket.p50DurationMs = percentile(modeBucket.durationMs, 50);
      delete modeBucket.durationMs;
    }
    bucket.p50DurationMs = percentile(bucket.durationMs, 50);
    delete bucket.durationMs;
  }

  const paired = buildPairedDeltas(records);
  const deltas = {};

  const baseline = byVariant.baseline;
  if (baseline) {
    for (const [variant, bucket] of Object.entries(byVariant)) {
      if (variant === "baseline") continue;
      const pairedForVariant = paired.filter((row) => row.sdlVariant === variant);
      const tokensSaved = pairedForVariant.reduce((sum, row) => sum + row.deltaTok, 0);
      const costSavedUsd = round4(pairedForVariant.reduce((sum, row) => sum + (row.baselineCostUsd - row.sdlCostUsd), 0));
      const deltaPctValues = pairedForVariant.map((row) => row.deltaPct);

      const stats = deltaPctValues.length >= 3
        ? {
            deltasMean: round4(mean(deltaPctValues)),
            deltasStd: round4(stdDev(deltaPctValues)),
            bootstrap95: {
              lower: round4(bootstrapCI(deltaPctValues).lower),
              upper: round4(bootstrapCI(deltaPctValues).upper),
            },
            significant: mannWhitneyU(
              pairedForVariant.map((p) => p.baselineTok),
              pairedForVariant.map((p) => p.sdlTok),
            ).significant,
          }
        : {};

      deltas[variant] = {
        tokensSaved,
        costSavedUsd,
        pairedCount: pairedForVariant.length,
        medianDeltaPct: round4(median(deltaPctValues)),
        ...stats,
      };
    }
  }

  const deltaPcts = paired.map((row) => row.deltaPct).sort((a, b) => a - b);

  return {
    schemaVersion: SCHEMA_VERSION,
    totals: { sessions: records.length, variants: Object.keys(byVariant).length, paired: paired.length },
    byVariant,
    paired,
    deltas,
    headlineClaim: "median paired savings on tasks both solved",
    pairedMedianDeltaPct: round4(median(deltaPcts)),
  };
}

function buildPairedDeltas(records) {
  const byKey = new Map();
  for (const record of records) {
    if (!record.quality?.passed) continue;
    const mode = record.workflow?.executionMode ?? "unknown";
    const key = `${record.taskId}|${record.agent ?? "unknown"}|${record.model ?? "unknown"}|${mode}`;
    let slot = byKey.get(key);
    if (!slot) {
      slot = {};
      byKey.set(key, slot);
    }
    slot[record.variant] = record;
  }

  const paired = [];
  for (const slot of byKey.values()) {
    const baseline = slot.baseline;
    const sdl = slot.sdl;
    if (!baseline || !sdl) continue;
    const baselineTok = baseline.tokens?.total ?? 0;
    const sdlTok = sdl.tokens?.total ?? 0;
    const deltaTok = baselineTok - sdlTok;
    const deltaPctVal = pct(deltaTok, baselineTok);
    paired.push({
      taskId: baseline.taskId,
      agent: baseline.agent,
      model: baseline.model,
      executionMode: baseline.workflow?.executionMode ?? "unknown",
      baselineTok,
      sdlTok,
      deltaTok,
      deltaPct: deltaPctVal,
      bothPass: Boolean(baseline.quality?.passed) && Boolean(sdl.quality?.passed),
      baselineCostUsd: baseline.cost?.totalUsd ?? 0,
      sdlCostUsd: sdl.cost?.totalUsd ?? 0,
      sdlVariant: sdl.variant,
      lossSignals: deltaPctVal < 0
        ? signalsForLoss({
            baselineTok,
            sdlTok,
            attribution: {
              repoSizeClass: sdl.repo?.sizeClass,
              cachedInput: sdl.tokens?.cachedInput ?? 0,
              total: sdl.tokens?.total ?? 0,
            },
            observability: sdl.artifacts?.sdl?.observability ?? {},
          })
        : [],
    });
  }
  return paired;
}

function median(sortedValues) {
  if (!sortedValues.length) return 0;
  const mid = Math.floor(sortedValues.length / 2);
  return sortedValues.length % 2 ? sortedValues[mid] : (sortedValues[mid - 1] + sortedValues[mid]) / 2;
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
  const runs = matrix.runs ?? [];
  const fromFiles = [];
  for (const file of files) {
    const data = await readJson(abs(matrixDir, file));
    fromFiles.push(...(Array.isArray(data.tasks) ? data.tasks : data));
  }
  const fromRuns = [];
  for (const run of runs) {
    const data = await readJson(abs(matrixDir, run.tasks));
    const tasks = Array.isArray(data.tasks) ? data.tasks : data;
    for (const task of tasks) {
      fromRuns.push({ ...task, repoId: run.repoId ?? task.repoId, _runId: run.id, _family: run.family });
    }
  }
  const all = [...inline, ...fromFiles, ...fromRuns];
  const validated = [];
  for (const task of all) {
    const validatedTask = validateTask(root, task);
    // Skip tasks whose local sourcePath doesn't exist (e.g. repos not cloned yet).
    // Cloneable repos (cloneUrl) are loaded — cloning happens in startSdlHttpSession/runBenchmark.
    if (validatedTask.repo?.sourcePath && !existsSync(abs(root, validatedTask.repo.sourcePath))) {
      continue;
    }
    validated.push(validatedTask);
  }
  return validated;
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

function renderAgentPrompt(task, variant) {
  const context = promptContextForVariant(task, variant);
  return [
    `Task: ${task.taskId}`,
    task.prompt,
    "Context:",
    context,
    "Edit this repository in place. Keep changes limited to the task."
  ].join("\n\n");
}

function promptContextForVariant(task, variant) {
  if (variant !== "sdl") return task.context.raw;
  return "Use the configured SDL-MCP server for repository context. Follow the sdl-mcp-agent-workflow retrieval ladder, edit policy, runtime policy, and usageStats completion step.";
}

function runAgentCommand(config, { runRoot, promptPath, task, variant, model, sdlSession, agentRuntime }) {
  const command = renderCommandTemplate(config.commandTemplate, {
    repo: runRoot,
    prompt: promptPath,
    taskId: task.taskId,
    variant,
    model,
    sdlMcpConfig: sdlMcpConfigArgs(sdlSession),
    sdlMcpUrl: sdlSession?.mcpUrl ?? "",
  });
  return { command, ...runCommand(command, runRoot, config.timeoutMs ?? 600_000, agentRuntime?.env) };
}

function renderCommandTemplate(template, values) {
  return template.replace(/\{(repo|prompt|taskId|variant|model|sdlMcpConfig|sdlMcpUrl)\}/g, (_match, key) => {
    if (key === "sdlMcpConfig") return values[key] || "";
    return shellArg(values[key] ?? "");
  });
}

function shellArg(value) {
  return JSON.stringify(String(value));
}

function sdlMcpConfigArgs(sdlSession) {
  if (!sdlSession?.mcpUrl) return "";
  return [
    "--dangerously-bypass-hook-trust",
    "-c mcp_servers.sdl-mcp.enabled=true",
    "-c mcp_servers.sdl-mcp.url=" + JSON.stringify(sdlSession.mcpUrl),
  ].join(" ");
}

async function prepareCodexSterileRuntime({ root, workDir, taskRunId }) {
  const sourceHome = sourceCodexHome();
  const codexHome = join(dirname(workDir), "codex-home", taskRunId);
  await rm(codexHome, { force: true, recursive: true });
  await mkdir(codexHome, { recursive: true });

  const authPath = join(sourceHome, "auth.json");
  if (existsSync(authPath)) await copyFile(authPath, join(codexHome, "auth.json"));

  const disabledSkillPaths = await codexDisabledSkillPaths({ root, sourceHome, codexHome });
  await writeFile(join(codexHome, "config.toml"), renderCodexSterileConfig(disabledSkillPaths), "utf8");

  return {
    codexHome,
    sessionsDir: join(codexHome, "sessions"),
    env: { CODEX_HOME: codexHome },
  };
}

function sourceCodexHome() {
  return process.env.SDLBENCH_SOURCE_CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

async function codexDisabledSkillPaths({ root, sourceHome, codexHome }) {
  const paths = new Set();
  const skillRoots = [
    join(homedir(), ".agents", "skills"),
    join(sourceHome, "skills"),
    join(sourceHome, "plugins", "cache"),
    join(root, ".agents", "skills"),
    join(root, ".codex", "skills"),
  ];

  for (const skillRoot of skillRoots) {
    for (const path of await findSkillFiles(skillRoot)) paths.add(path);
  }
  for (const name of CODEX_SYSTEM_SKILLS) {
    paths.add(join(codexHome, "skills", ".system", name, "SKILL.md"));
  }

  return [...paths].sort((a, b) => a.localeCompare(b));
}

async function findSkillFiles(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        files.push(...await findSkillFiles(path));
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        files.push(path);
      }
    }
    return files;
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function renderCodexSterileConfig(disabledSkillPaths) {
  const lines = [
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    "",
    "[features]",
    "hooks = true",
    "shell_tool = true",
  ];
  for (const feature of CODEX_STERILE_FEATURES) lines.push(`${feature} = false`);

  for (const path of disabledSkillPaths) {
    lines.push(
      "",
      "[[skills.config]]",
      `path = "${tomlString(path)}"`,
      "enabled = false"
    );
  }

  return `${lines.join("\n")}\n`;
}

function tomlString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function assertCodexWorktreeIsSterile(root, runRoot) {
  if (!isPathInside(root, runRoot)) return;
  throw new Error(`Codex behavior worktree must be outside the benchmark repo to avoid parent AGENTS.md/rules: ${runRoot}`);
}

async function installSdlBenchmarkReinforcement(runRoot, sdlSession) {
  const hookDir = join(runRoot, ".codex", "hooks");
  await mkdir(hookDir, { recursive: true });
  await writeFile(join(runRoot, "AGENTS.md"), sdlBenchmarkInstructions(), "utf8");
  await writeFile(join(runRoot, "SDL.md"), sdlBenchmarkInstructions(), "utf8");
  await writeFile(join(runRoot, ".codex", "hooks.json"), JSON.stringify({
    hooks: {
      SessionStart: [{
        hooks: [{
          type: "command",
          command: `node ${JSON.stringify(join(hookDir, "load-sdl-skill.mjs"))}`,
          timeout: 5,
          statusMessage: "Loading SDL-MCP workflow skill",
        }],
      }],
      PreToolUse: [{
        matcher: ".*",
        hooks: [{
          type: "command",
          command: `node ${JSON.stringify(join(hookDir, "force-sdl-mcp.mjs"))}`,
          timeout: 10,
          statusMessage: "Checking SDL-MCP tool policy",
        }],
      }],
    },
  }, null, 2), "utf8");

  const sourceHookDir = join(defaultRoot(), ".codex", "hooks");
  await writeFile(
    join(hookDir, "load-sdl-skill.mjs"),
    await readFile(join(sourceHookDir, "load-sdl-skill.mjs"), "utf8"),
    "utf8",
  );
  const pidfilePath = sdlSession.evidence?.configPath
    ? join(dirname(sdlSession.evidence.configPath), "sdl-mcp.pid")
    : join(runRoot, ".sdlbench-sdl.pid");
  const forceHook = (await readFile(join(sourceHookDir, "force-sdl-mcp.mjs"), "utf8"))
    .replace(
      /const pidfilePath = ".*?";/,
      "const pidfilePath = " + JSON.stringify(pidfilePath) + ";",
    )
    .replace(
      'normalized === "shell_command" ||',
      'normalized === "shell_command" ||\n    normalized === "exec" ||\n    normalized.endsWith(".exec") ||',
    );
  await writeFile(join(hookDir, "force-sdl-mcp.mjs"), forceHook, "utf8");
}

function sdlBenchmarkInstructions() {
  return [
    "# SDL-MCP Benchmark Instructions",
    "",
    "Use SDL-MCP as the repository interface.",
    "Start with repo.status, then use sdl.context or sdl.workflow before reading or editing indexed source.",
    "Use SDL edit tools for indexed source and SDL runtime tools for repo-local commands.",
    "Call usageStats with scope session and persist true before the final answer.",
  ].join("\n");
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

function runCommand(command, cwd, timeoutMs, env = undefined) {
  const result = spawnSync(command, {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
    shell: true,
    timeout: timeoutMs,
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

export async function inspectCodexSessionSterility(sessionFile) {
  const text = await readFile(sessionFile, "utf8");
  const forbidden = CODEX_FORBIDDEN_CONTEXT_MARKERS
    .filter((marker) => marker.pattern.test(text))
    .map((marker) => marker.name);

  return {
    passed: forbidden.length === 0,
    forbidden,
    inspectedBytes: Buffer.byteLength(text, "utf8"),
  };
}


async function startSdlHttpSession({ root, workDir, runRoot, task, taskRunId, options }) {
  const authToken = options.sdlAuthToken ?? "sdlbench-" + taskRunId;
  if (options.sdlHttpBaseUrl) {
    const baseUrl = trimSlash(options.sdlHttpBaseUrl);
    const evidence = await retrieveSdlHttpContext({
      baseUrl: options.sdlHttpBaseUrl,
      authToken,
      task,
      timeoutMs: options.sdlHttpTimeoutMs ?? 120_000,
    });
    const observability = startObservabilityPolling(baseUrl, authToken, task.repoId, options);
    const stop = observability.stop;
    return {
      baseUrl,
      mcpUrl: baseUrl + "/mcp",
      evidence,
      get observability() { return observability.getDelta(); },
      stop: async () => { stop(); },
    };
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
    const observability = startObservabilityPolling(baseUrl, authToken, task.repoId, options);
    return {
      baseUrl,
      mcpUrl: baseUrl + "/mcp",
      evidence: {
        ...evidence,
        configPath,
        dbPath,
        server: { port, logTail: logs.join("").slice(-4000) },
      },
      get observability() { return observability.getDelta(); },
      stop: async () => { observability.stop(); await stopChild(child); },
    };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

export function createSdlHttpConfig({ task, runRoot, dbPath }) {
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
    httpAuth: { enabled: false },
  };
}

function startObservabilityPolling(baseUrl, authToken, repoId, options) {
  const intervalMs = options.sdlObservabilityPollMs ?? 2000;
  const samples = [];
  let first = null;
  let last = null;
  let timer = null;
  let callCounter = 0;

  async function poll() {
    try {
      const url = `${trimSlash(baseUrl)}/api/observability/snapshot?repoId=${encodeURIComponent(repoId)}&_c=${callCounter++}`;
      const snapshot = await getJson(url, authToken, 5000);
      if (!first) first = snapshot;
      last = snapshot;
      samples.push(snapshot);
    } catch {
      // Observability may not be ready yet; silently skip.
    }
  }

  // Fire one immediate poll, then start interval.
  poll();
  timer = setInterval(poll, intervalMs);
  timer.unref?.();

  return {
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },
    getDelta() {
      if (!first || !last) return null;
      return computeObservabilityDelta(first, last);
    },
  };
}

function computeObservabilityDelta(first, last) {
  const delta = {};
  const interesting = [
    "retrieval", "beam", "indexing", "tokenEfficiency",
    "health", "toolVolume", "delta",
  ];
  for (const key of interesting) {
    const f = first[key];
    const l = last[key];
    if (!f || !l) continue;
    delta[key] = {};
    for (const [k, v] of Object.entries(l)) {
      const fv = f[k];
      if (typeof v === "number" && typeof fv === "number") {
        delta[key][k] = v - fv;
      }
    }
  }
  return flattenObservabilityDelta(delta);
}

function flattenObservabilityDelta(delta) {
  const flat = {};
  for (const [section, fields] of Object.entries(delta)) {
    for (const [field, value] of Object.entries(fields)) {
      flat[`${section}_${field}`] = value;
    }
  }
  return flat;
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

function normalizeTokens({ input, output, productContext = 0, tokenizer }) {
  const total = input + output;
  // tiktoken-path records (fixture + behavior prompt estimates + imports) never
  // claim savings: the `rawEquivalent` line is a hand-written prompt-size proxy,
  // not a measured agent session. Setting saved=0/rawEquivalent=total closes the
  // fixture-mode tautology where saved = rawEquivalent - total. Behavior-mode
  // Codex session counts (tokensFromCodexSessionCounts) build their own honest
  // token object without this helper.
  return {
    input,
    output,
    total,
    productContext,
    rawEquivalent: total,
    saved: 0,
    savingsPercent: 0,
    model: tokenizer.model ?? tokenizer.modelHint,
    encoding: tokenizer.encoding,
    modelHint: tokenizer.modelHint,
    tokenizerResolution: tokenizer.tokenizerResolution,
    tokenizerVersion: tokenizer.tokenizerVersion,
    tokenizerSource: tokenizer.tokenizerSource,
  };
}

export async function findCodexSessionTokenCounts({ runRoot, sessionsDir = defaultCodexSessionsDir(), sinceMs = 0, tokenizerCommand } = {}) {
  if (!runRoot) return null;
  const sessionFiles = await findSessionJsonlFiles(sessionsDir, sinceMs);
  const normalizedRunRoot = normalizeSessionPath(runRoot);
  const matches = [];

  for (const sessionFile of sessionFiles) {
    const match = await readCodexSessionTokenFile(sessionFile, normalizedRunRoot, tokenizerCommand);
    if (match) matches.push(match);
  }

  matches.sort((a, b) => (b.mtimeMs - a.mtimeMs) || String(b.sessionFile).localeCompare(String(a.sessionFile)));
  return matches[0] ?? null;
}

function defaultCodexSessionsDir() {
  return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
}

async function findSessionJsonlFiles(root, sinceMs) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        files.push(...await findSessionJsonlFiles(path, sinceMs));
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const info = await stat(path);
        if (!sinceMs || info.mtimeMs >= sinceMs) files.push({ path, mtimeMs: info.mtimeMs });
      }
    }
    return files;
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function readCodexSessionTokenFile(sessionFile, normalizedRunRoot, tokenizerCommand) {
  const text = await readFile(sessionFile.path, "utf8");
  let metadata = null;
  let tokenInfo = null;
  const functionCalls = [];
  const functionOutputs = new Map();

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "session_meta") {
      metadata = event.payload ?? null;
    } else if (event.type === "event_msg" && event.payload?.type === "token_count") {
      tokenInfo = event.payload.info ?? tokenInfo;
    } else if (event.type === "response_item") {
      const payload = event.payload;
      if (payload?.type === "function_call" && payload.call_id) {
        functionCalls.push({
          callId: payload.call_id,
          toolName: payload.name ?? "unknown",
          arguments: payload.arguments ?? "",
          ts: event.timestamp ?? null,
        });
      } else if (payload?.type === "function_call_output" && payload.call_id) {
        functionOutputs.set(payload.call_id, payload.output ?? "");
      }
    }
  }

  if (!metadata?.cwd || normalizeSessionPath(metadata.cwd) !== normalizedRunRoot || !tokenInfo?.total_token_usage) {
    return null;
  }

  const toolCalls = tokenizerCommand
    ? tokenizeFunctionCalls(functionCalls, functionOutputs, tokenizerCommand)
    : functionCalls.map((fc) => ({ toolName: fc.toolName, tokensIn: 0, tokensOut: 0, ts: fc.ts }));

  return {
    sessionFile: sessionFile.path,
    mtimeMs: sessionFile.mtimeMs,
    sessionId: metadata.session_id ?? metadata.id,
    cwd: metadata.cwd,
    source: metadata.source,
    cliVersion: metadata.cli_version,
    modelProvider: metadata.model_provider,
    modelContextWindow: tokenInfo.model_context_window,
    usage: tokenInfo.total_token_usage,
    attribution: { toolCalls },
  };
}

function tokenizeFunctionCalls(calls, outputs, tokenizerCommand) {
  if (!calls.length) return [];
  const texts = {};
  calls.forEach((call, i) => {
    texts[`in_${i}`] = call.arguments ?? "";
    texts[`out_${i}`] = outputs.get(call.callId) ?? "";
  });
  let counted;
  try {
    counted = runTokenizer(tokenizerCommand, texts);
  } catch {
    return calls.map((call) => ({ toolName: call.toolName, tokensIn: 0, tokensOut: 0, ts: call.ts }));
  }
  return calls.map((call, i) => ({
    toolName: call.toolName,
    tokensIn: counted.counts[`in_${i}`] ?? 0,
    tokensOut: counted.counts[`out_${i}`] ?? 0,
    ts: call.ts,
  }));
}

function normalizeSessionPath(value) {
  return resolve(String(value).replace(/^\\\\\?\\/, "")).replace(/\\/g, "/").toLowerCase();
}

function buildAttribution(rawAttribution, tokens) {
  const toolCalls = rawAttribution.toolCalls ?? [];
  const retrievalTokens = toolCalls
    .filter((tc) => tc.toolName?.startsWith("sdl."))
    .reduce((sum, tc) => sum + tc.tokensIn + tc.tokensOut, 0);
  return {
    toolCalls,
    phaseBreakdown: {
      coldIndex: 0,
      retrieval: retrievalTokens,
      reasoning: tokens.reasoningOutput ?? 0,
      output: tokens.output ?? 0,
    },
  };
}

function tokensFromCodexSessionCounts(sessionCounts, estimatedTokens) {
  const usage = sessionCounts.usage ?? {};
  const input = wholeNumber(usage.input_tokens);
  const output = wholeNumber(usage.output_tokens);
  const total = wholeNumber(usage.total_tokens) || input + output;
  const cachedInput = wholeNumber(usage.cached_input_tokens);
  const reasoningOutput = wholeNumber(usage.reasoning_output_tokens);
  return {
    input,
    output,
    total,
    cachedInput,
    uncachedInput: Math.max(0, input - cachedInput),
    reasoningOutput,
    productContext: 0,
    rawEquivalent: total,
    saved: 0,
    savingsPercent: 0,
    model: estimatedTokens.model,
    encoding: estimatedTokens.encoding,
    modelHint: estimatedTokens.modelHint,
    tokenizerResolution: "tiktoken_session_count",
    tokenizerVersion: sessionCounts.cliVersion,
    tokenizerSource: "codex-session",
    usageSource: "codex_session_token_count",
    sessionId: sessionCounts.sessionId,
    sessionFile: sessionCounts.sessionFile,
    modelContextWindow: sessionCounts.modelContextWindow,
  };
}

function resolveClaimGrade(executionMode, tokenizerSource) {
  if (executionMode === "fixture") return "none";
  if (tokenizerSource === "codex-session") return "primary";
  return "secondary";
}

function estimateIndexCost(indexPayload, tokenizerCommand, { model, encoding } = {}) {
  if (!tokenizerCommand) return 0;
  try {
    const text = indexPayload ? JSON.stringify(indexPayload) : "";
    if (!text.trim()) return 0;
    const counted = runTokenizer(tokenizerCommand, { indexPayload: text }, { model, encoding });
    return counted.counts.indexPayload ?? 0;
  } catch {
    return 0;
  }
}

function codexSessionArtifact(sessionCounts) {
  return {
    sessionId: sessionCounts.sessionId,
    sessionFile: sessionCounts.sessionFile,
    cwd: sessionCounts.cwd,
    source: sessionCounts.source,
    cliVersion: sessionCounts.cliVersion,
    modelProvider: sessionCounts.modelProvider,
  };
}

function wholeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
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

export function estimateCost(tokens, pricing = DEFAULT_PRICING) {
  const rates = { ...DEFAULT_PRICING, ...pricing };
  const input = tokens.input ?? 0;
  const output = tokens.output ?? 0;
  const productContext = tokens.productContext ?? 0;
  const cachedInput = tokens.cachedInput ?? 0;
  const reasoningOutput = tokens.reasoningOutput ?? 0;
  const uncachedInput = Math.max(0, input - cachedInput);
  const nonReasoningOutput = Math.max(0, output - reasoningOutput);
  const cachedInputPerMTok = rates.cachedInputPerMTok ?? rates.inputPerMTok;
  const reasoningOutputPerMTok = rates.reasoningOutputPerMTok ?? rates.outputPerMTok;

  const cachedInputUsd = (cachedInput / 1_000_000) * cachedInputPerMTok;
  const uncachedInputUsd = (uncachedInput / 1_000_000) * rates.inputPerMTok;
  const nonReasoningOutputUsd = (nonReasoningOutput / 1_000_000) * rates.outputPerMTok;
  const reasoningOutputUsd = (reasoningOutput / 1_000_000) * reasoningOutputPerMTok;
  const contextUsd = (productContext / 1_000_000) * rates.contextPerMTok;
  // Comparability lines: what all input/output would cost at full rates with no
  // cache discount. They are reported for comparison only and are NOT part of totalUsd.
  const inputUsd = (input / 1_000_000) * rates.inputPerMTok;
  const outputUsd = (output / 1_000_000) * rates.outputPerMTok;

  return {
    inputUsd: round4(inputUsd),
    outputUsd: round4(outputUsd),
    cachedInputUsd: round4(cachedInputUsd),
    uncachedInputUsd: round4(uncachedInputUsd),
    nonReasoningOutputUsd: round4(nonReasoningOutputUsd),
    reasoningOutputUsd: round4(reasoningOutputUsd),
    contextUsd: round4(contextUsd),
    totalUsd: round4(cachedInputUsd + uncachedInputUsd + nonReasoningOutputUsd + reasoningOutputUsd + contextUsd),
    pricingModel: rates.model ?? tokens.model ?? DEFAULT_MODEL,
    inputPerMTok: rates.inputPerMTok,
    outputPerMTok: rates.outputPerMTok,
    contextPerMTok: rates.contextPerMTok,
    cachedInputPerMTok,
    reasoningOutputPerMTok,
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

async function loadReposLock(root, lockPath) {
  const path = abs(root, lockPath ?? DEFAULT_REPOS_LOCK);
  try {
    return await readJson(path);
  } catch (error) {
    if (error?.code !== "ENOENT") return { repos: [] };
    return { repos: [] };
  }
}

function resolveRepoMeta(repoId, reposLock) {
  const entry = reposLock?.repos?.find((repo) => repo.repoId === repoId);
  if (!entry) return { sizeClass: null, languageTags: [] };
  return {
    sizeClass: entry.sizeClass ?? null,
    languageTags: entry.languageTags ?? [],
  };
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

function defaultWorkDir(root, executionMode) {
  if (executionMode !== "behavior") return "sdlbench/.work/repos";
  return join(tmpdir(), "sdlbench", hash(root).slice(0, 12), "repos");
}

function abs(root, path) {
  return isAbsolute(path) ? path : resolve(root, path);
}

function isPathInside(parent, child) {
  const normalizedParent = normalizeSessionPath(parent);
  const normalizedChild = normalizeSessionPath(child);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(normalizedParent + "/");
}
