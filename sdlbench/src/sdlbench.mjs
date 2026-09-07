import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, copyFile, cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createServer as createNetServer } from "node:net";
import { performance } from "node:perf_hooks";
import { signalsForLoss } from "./attribution-signals.mjs";
import { computeCoverage } from "./coverage.mjs";
import { percentile, mean, stdDev, clusteredPairedCI } from "./stats.mjs";
import { prepareOpencodeSterileRuntime } from "./agents/opencode-runtime.mjs";
import { extractOpencodeSessionUsage, tokensFromOpencodeSessionCounts } from "./agents/opencode.mjs";

const SESSION_SCHEMA_VERSION = 4;
const ANALYSIS_SCHEMA_VERSION = 4;
const DEFAULT_RESULTS = "sdlbench/results/sessions.jsonl";
const DEFAULT_ENCODING = "o200k_base";
const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_REPOS_LOCK = "sdlbench/config/repos.lock.json";
const TIKTOKEN_SPEC = "git+https://github.com/openai/tiktoken@0.13.0";
const ATTRIBUTION_TEXT_LIMIT = 2000;
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
  if (!["baseline", "sdl"].includes(variant)) throw new Error(`Unsupported variant ${variant}`);
  const experimentId = options.experimentId ?? randomUUID();
  const repetitionId = String(options.repetitionId ?? "1");
  const tokenizerCommand = options.tokenizerCommand ?? defaultTokenizerCommand(root);
  const executionMode = options.executionMode ?? (options.behavior ? "behavior" : "fixture");
  if (!["fixture", "behavior"].includes(executionMode)) throw new Error(`Unknown executionMode ${executionMode}`);
  if (options.warmSession) {
    throw new Error("warmSession is unavailable until the reused server is verified against the exact agent worktree.");
  }
  const workDir = abs(root, options.workDir ?? defaultWorkDir(root, executionMode));
  const pricing = await loadPricing(root, options.pricingPath);
  const agentConfig = await loadAgentConfig(root, agent, options, { requireCommand: executionMode === "behavior" });
  const model = resolveModel({ options, agentConfig, pricing });
  const modelPricing = resolveModelPricing(pricing, model);
  const matrix = await readJson(matrixPath);
  const reposLock = await loadReposLock(root, options.reposLockPath);
  const tasks = await loadTasks(root, dirname(matrixPath), matrix);
  const filteredTasks = tasks.filter((task) =>
    (!options.repoIdFilter || task.repoId === options.repoIdFilter)
    && (!options.sizeClassFilter || resolveRepoMeta(task.repoId, reposLock).sizeClass === options.sizeClassFilter));
  const records = [];


  await mkdir(dirname(resultsPath), { recursive: true });
  await mkdir(workDir, { recursive: true });

  for (const task of filteredTasks) {
    const started = performance.now();
    const taskRunId = `${randomUUID()}-${task.taskId}-${variant}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
    const runRoot = join(workDir, taskRunId);
    const provenance = {
      sourceHash: null,
      taskHash: hash(JSON.stringify(task)),
      verifierHash: hash(JSON.stringify(task.verify)),
      promptHash: hash(renderAgentPrompt(task, variant)),
      agentConfigHash: hash(JSON.stringify(agentConfig)),
      pricingHash: hash(JSON.stringify(modelPricing)),
      productVersion: variant === "sdl" ? (await readJson(join(root, "package.json")).catch(() => ({}))).version ?? null : null,
    };
    let sdlSession = null;
    let ownsSdlSession = false;
    let attemptRecord = null;
    let attemptAgent = null;
    try {
      await cp(abs(root, task.repo.sourcePath), runRoot, { recursive: true });
      provenance.sourceHash = hash(JSON.stringify([...await snapshotFiles(runRoot)].sort(([a], [b]) => a.localeCompare(b))));
      const setupStart = performance.now();
      if (variant === "sdl") {
        sdlSession = await startSdlHttpSession({ root, workDir, runRoot, task, taskRunId, options, repoMeta: resolveRepoMeta(task.repoId, reposLock) });
        ownsSdlSession = true;
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
        if (agent === "codex") {
          assertCodexWorktreeIsSterile(root, runRoot);
          codexRuntime = await prepareCodexSterileRuntime({ root, workDir, taskRunId });
        if (variant === "sdl") {
          await installCodexEnforcementAssets({
            runRoot,
            repoId: sdlSession.repoId,
            configPath: sdlSession.configPath ?? options.sdlConfigPath,
          });
        }
          agentRuntime = codexRuntime;
        } else if (agent === "opencode") {
          agentRuntime = await prepareOpencodeSterileRuntime({ root, workDir, taskRunId, sdlSession });
        }
        promptPath = join(runRoot, ".sdlbench-prompt.md");
        await writeFile(promptPath, renderAgentPrompt(task, variant), "utf8");
        const before = await snapshotFiles(runRoot);
        agentStartedAt = Date.now();
        const agentStart = performance.now();
        agentResult = await runAgentCommand(agentConfig, { runRoot, promptPath, task, variant, model, sdlSession, agentRuntime });
        attemptAgent = agentResult;
        agentMs = Math.round(performance.now() - agentStart);
        changedFiles = diffSnapshots(before, await snapshotFiles(runRoot));
        outputText = [agentResult.stdout, agentResult.stderr].filter(Boolean).join("\n");
      } else {
        await applySolution(runRoot, task);
      }

      await sdlSession?.finishObservation?.();
      const verify = await runCommandAsync(task.verify.command, runRoot, task.verify.timeoutMs ?? 10000);
      const durationMs = Math.round(performance.now() - activeStart);
      const wallMs = Math.round(performance.now() - started);
      const passed = verify.exitCode === 0 && (!agentResult || agentResult.exitCode === 0);
      const estimatedTokens = countSessionTokens(task, variant, tokenizerCommand, "", outputText, {
        model,
        encoding: modelPricing.encoding,
        promptText: executionMode === "behavior" ? renderAgentPrompt(task, variant) : task.prompt,
      });
      const codexTokenCounts = executionMode === "behavior" && agent === "codex"
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
        ? await inspectCodexSessionsSterility(codexTokenCounts.sessionFiles ?? [codexTokenCounts.sessionFile])
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
      const attribution = codexTokenCounts?.attribution
        ? buildAttribution(codexTokenCounts.attribution, tokens)
        : undefined;
      const sdlRetrievedSymbols = variant === "sdl" && attribution
        ? extractRetrievedSymbolsFromAttribution(attribution, task.contextTargets)
        : null;
      const claimGrade = resolveClaimGrade(executionMode, tokens.tokenizerSource);
      const repoMeta = resolveRepoMeta(task.repoId, reposLock);
      const workflowSteps = Array.isArray(task.workflow) ? task.workflow : [];
      const turns = workflowSteps.length || task.workflow?.turns || 1;
      const perTurnTokens = [];
      // Index responses describe work; their JSON size is not provider usage.
      const indexing = {
        durationMs: variant === "sdl" ? sdlSession?.evidence?.durationMs ?? null : 0,
        usage: null,
        rates: null,
        totalUsd: variant === "sdl" ? null : 0,
        status: variant === "sdl" ? "usage-unavailable" : "not-applicable",
      };
      const cost = estimateCost(tokens, modelPricing);
      cost.scope = tokens.usageSource ? "provider-agent-usage" : "observed-text-estimate";
      cost.billingUsageAvailable = Boolean(tokens.usageSource);
      cost.coldTotalUsd = indexing.totalUsd === null ? null : cost.totalUsd + indexing.totalUsd;
      cost.amortizedTotalUsd = null;
      const cache = computeCacheMetrics({ tokens, cost });
      const record = {
        schemaVersion: SESSION_SCHEMA_VERSION,
        experimentId,
        repetitionId,
        provenance,
        pricingSnapshot: modelPricing,
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
    promptSpecificity: task.promptSpecificity,
        status: agentResult?.timedOut || verify.timedOut ? "timeout" : passed ? "pass" : "fail",
        durationMs,
        wallMs,
        timingScope: { agentMs: "agent-child-execution", durationMs: "runtime-preparation-through-verification", wallMs: "copy-through-verification-excludes-accounting-and-cleanup" },
        setupMs,
        agentMs: agentResult ? agentMs : null,
        tokens,
        providerUsage: tokens.usageSource ? tokens : null,
        observedContent: { ...estimatedTokens, coverage: executionMode === "behavior" ? "prompt-and-captured-agent-output" : "fixture-prompt-and-solution", completeModelSession: false, missing: ["tool-schemas", "repeated-request-input", "hidden-reasoning"] },
        indexing,
        fairness: { available: false, passed: false, promptHash: provenance.promptHash, promptTokens: estimatedTokens.input, injectedTokens: null, toolBudget: null },
        cost,
        cache,
        attribution,
        coverage: task.contextTargets
          ? computeCoverage({
              changedFiles,
              retrievedSymbols: sdlRetrievedSymbols,
              contextTargets: task.contextTargets,
            })
          : undefined,
        perTurnTokens: perTurnTokens.length > 0 ? perTurnTokens : undefined,
        quality: {
          passed,
          errorRate: passed ? 0 : 1,
          weightedErrorRate: passed ? 0 : 1,
          rubricScore: null,
          verifierPassed: verify.exitCode === 0,
        },
        workflow: {
          executionMode,
          turns,
          toolCalls: attribution?.toolCalls?.length ?? null,
          fileReads: null,
          shellCommands: null,
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
          estimatedTokens,
          sdl: { ...sdlEvidence, observability: sdlSession?.observability ?? undefined },
          verifier: { exitCode: verify.exitCode, timedOut: verify.timedOut },
          verifyStdout: verify.stdout.slice(-4000),
          verifyStderr: verify.stderr.slice(-4000),
        },
      };

      attemptRecord = record;
      assertSdlBehaviorIntegrity({
    variant,
    executionMode,
    attribution: record.attribution,
    observability: record.artifacts?.sdl?.observability,
    claimGrade: record.claimGrade,
  });
      records.push(record);
      await appendFile(resultsPath, `${JSON.stringify(record)}\n`, "utf8");
    } catch (error) {
      // Preserve the planned attempt even when setup or provider telemetry fails.
      const record = attemptRecord ?? {
        schemaVersion: SESSION_SCHEMA_VERSION, experimentId, repetitionId, provenance,
        runId: taskRunId, agent, model, variant, product: variant, repoId: task.repoId,
        repo: resolveRepoMeta(task.repoId, reposLock), taskId: task.taskId,
        workflow: { executionMode }, tokens: null, providerUsage: null,
        cost: { totalUsd: null, coldTotalUsd: null, amortizedTotalUsd: null },
        artifacts: { worktree: runRoot, agent: attemptAgent },
      };
      record.status = attemptAgent?.timedOut ? "timeout" : "error";
      record.claimGrade = "none";
      record.quality = { ...record.quality, passed: false };
      record.error = { message: error.message };
      records.push(record);
      await appendFile(resultsPath, `${JSON.stringify(record)}\n`, "utf8");
    } finally {
      if (ownsSdlSession) await sdlSession?.stop?.();
    }
  }



  return { records, resultsPath, selectedTaskCount: filteredTasks.length, experimentId, repetitionId };
}

export function importTranscript({ agent, variant, text, repoId = "unknown", taskId = "imported", tokenizerCommand = defaultTokenizerCommand(defaultRoot()) }) {
  const parsed = parseMaybeJsonl(text);
  const rawText = parsed.map((entry) => JSON.stringify(entry)).join("\n") || text;
  const counted = runTokenizer(tokenizerCommand, {
    transcript: rawText,
  });
  const total = counted.counts.transcript;
  // A transcript is observed text, not a sequence of billable model requests.
  const tokens = { ...normalizeTokens({ input: 0, output: 0, tokenizer: counted }), input: null, output: null, total };
  const cost = { totalUsd: null, scope: "unavailable", billingUsageAvailable: false };
  const cache = computeCacheMetrics({ tokens, cost });

  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
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
    providerUsage: null,
    observedContent: { ...tokens, coverage: "imported-transcript", completeModelSession: false },
    durationMs: 0,
    setupMs: 0,
    agentMs: 0,
    tokens,
    cost,
    cache,
    quality: { passed: true, errorRate: 0, weightedErrorRate: 0, rubricScore: 0 },
    workflow: { turns: parsed.length || 1, toolCalls: 0, fileReads: 0, shellCommands: 0, testsRun: 0, filesChanged: 0, humanInterventions: 0 },
    artifacts: {},
  };
}

function createCacheAggregate() {
  return {
    totalSessions: 0,
    availableSessions: 0,
    inputTokens: 0,
    readTokens: 0,
    writeTokens: 0,
    discountSavingsUsd: 0,
    uncachedEquivalentInputUsd: 0,
  };
}

function addCacheAggregate(aggregate, cache) {
  aggregate.totalSessions += 1;
  if (!cache?.available) return;
  aggregate.availableSessions += 1;
  aggregate.inputTokens += nonNegativeNumber(cache.inputTokens);
  aggregate.readTokens += nonNegativeNumber(cache.readTokens);
  aggregate.writeTokens += nonNegativeNumber(cache.writeTokens);
  aggregate.discountSavingsUsd += nonNegativeNumber(cache.discountSavingsUsd);
  aggregate.uncachedEquivalentInputUsd += nonNegativeNumber(cache.uncachedEquivalentInputUsd);
}

function finalizeCacheAggregate(aggregate) {
  return {
    totalSessions: aggregate.totalSessions,
    availableSessions: aggregate.availableSessions,
    coveragePercent: pct(aggregate.availableSessions, aggregate.totalSessions),
    inputTokens: aggregate.inputTokens,
    readTokens: aggregate.readTokens,
    writeTokens: aggregate.writeTokens,
    hitPercent: pct(aggregate.readTokens, aggregate.inputTokens),
    discountSavingsUsd: round4(aggregate.discountSavingsUsd),
    discountSavingsPercent: pct(aggregate.discountSavingsUsd, aggregate.uncachedEquivalentInputUsd),
  };
}

function analyzeSessionsCore(records) {
  const byVariant = {};
  for (const record of records) {
    const executionMode = record.workflow?.executionMode ?? "unknown";
    const bucket = byVariant[record.variant] ??= {
      byExecutionMode: {},
      durationMs: [],
      cache: createCacheAggregate(),
    };
    const modeBucket = bucket.byExecutionMode[executionMode] ??= {
      sessions: 0,
      passed: 0,
      tokens: 0,
      costUsd: 0,
      missingCostSessions: 0,
      missingTokenSessions: 0,
      durationMs: [],
      cache: createCacheAggregate(),
    };
    modeBucket.sessions += 1;
    modeBucket.passed += record.quality?.passed ? 1 : 0;
    if (Number.isFinite(record.tokens?.total)) modeBucket.tokens += record.tokens.total;
    else modeBucket.missingTokenSessions++;
    if (Number.isFinite(record.cost?.totalUsd)) modeBucket.costUsd += record.cost.totalUsd;
    else modeBucket.missingCostSessions++;
    if (Number.isFinite(record.durationMs)) {
      modeBucket.durationMs.push(record.durationMs);
      bucket.durationMs.push(record.durationMs);
    }
    addCacheAggregate(modeBucket.cache, record.cache);
    addCacheAggregate(bucket.cache, record.cache);
  }

  for (const bucket of Object.values(byVariant)) {
    for (const modeBucket of Object.values(bucket.byExecutionMode)) {
      modeBucket.knownCostUsd = modeBucket.costUsd;
      if (modeBucket.missingCostSessions) modeBucket.costUsd = null;
      modeBucket.costPerSolvedTaskUsd = modeBucket.passed && modeBucket.costUsd !== null ? modeBucket.costUsd / modeBucket.passed : null;
      if (modeBucket.missingTokenSessions) modeBucket.tokens = null;
      modeBucket.passRate = pct(modeBucket.passed, modeBucket.sessions);
      modeBucket.p50DurationMs = percentile(modeBucket.durationMs, 50);
      modeBucket.cache = finalizeCacheAggregate(modeBucket.cache);
      delete modeBucket.durationMs;
    }
    bucket.p50DurationMs = percentile(bucket.durationMs, 50);
    bucket.cache = finalizeCacheAggregate(bucket.cache);
    delete bucket.durationMs;
  }

  const paired = buildPairedDeltas(records);
  const deltas = {};

  if (byVariant.baseline) {
    for (const variant of Object.keys(byVariant)) {
      if (variant === "baseline") continue;
      const pairedForVariant = paired.filter((row) => row.variant === variant);
      const tokensSaved = pairedForVariant.reduce((sum, row) => sum + row.deltaTok, 0);
      const costSavedUsd = pairedForVariant.every(row => Number.isFinite(row.baselineCostUsd) && Number.isFinite(row.productCostUsd))
        ? round4(pairedForVariant.reduce((sum, row) => sum + row.baselineCostUsd - row.productCostUsd, 0))
        : null;
      const deltaPctValues = pairedForVariant.map((row) => row.deltaPct);

      const uncertainty = {
        tokens: clusteredPairedCI(pairedForVariant, "deltaTok"),
        costUsd: clusteredPairedCI(pairedForVariant, "deltaCostUsd"),
        agentMs: clusteredPairedCI(pairedForVariant, "deltaAgentMs"),
        percent: clusteredPairedCI(pairedForVariant, "deltaPct"),
      };
      const stats = {
        deltasMean: round4(mean(deltaPctValues)),
        deltasStd: round4(stdDev(deltaPctValues)),
        bootstrap95: uncertainty.percent.interval,
        uncertainty,
      };

      deltas[variant] = {
        tokensSaved,
        costSavedUsd,
        pairedCount: pairedForVariant.length,
        medianDeltaPct: round4(percentile(deltaPctValues, 50)),
        ...stats,
      };
    }
  }

  const sdlDeltaPcts = paired
    .filter((row) => row.variant === "sdl")
    .map((row) => row.deltaPct)
    .sort((a, b) => a - b);

  return {
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    totals: { sessions: records.length, variants: Object.keys(byVariant).length, paired: paired.length },
    byVariant,
    paired,
    deltas,
    headlineClaim: "median paired savings on tasks both solved",
    pairedMedianDeltaPct: round4(percentile(sdlDeltaPcts, 50)),
  };
}

function buildCacheComparison(baselineCache, productCache) {
  const baselineAvailable = Boolean(baselineCache?.available);
  const productAvailable = Boolean(productCache?.available);
  if (!baselineAvailable || !productAvailable) {
    return {
      comparable: false,
      reason: "provider-usage-unavailable",
      baselineAvailable,
      productAvailable,
    };
  }

  return {
    comparable: true,
    baseline: baselineCache,
    product: productCache,
    hitPercentDelta: round4(productCache.hitPercent - baselineCache.hitPercent),
    discountSavingsUsdDelta: round4(productCache.discountSavingsUsd - baselineCache.discountSavingsUsd),
    discountSavingsPercentDelta: round4(
      productCache.discountSavingsPercent - baselineCache.discountSavingsPercent,
    ),
  };
}

export function buildPairedDeltas(records) {
  const byKey = new Map();
  const attempts = new Set();

  for (const record of records) {
    const mode = record.workflow?.executionMode ?? "unknown";
    const attemptKey = JSON.stringify([record.repoId ?? "unknown", record.taskId, record.agent ?? "unknown", record.model ?? "unknown", mode, record.warmSession ?? false, record.experimentId ?? null, record.repetitionId ?? null, record.variant]);
    if (attempts.has(attemptKey)) throw new Error(`Ambiguous benchmark pair for ${attemptKey}; assign distinct repetition IDs to planned retries.`);
    attempts.add(attemptKey);
    const key = JSON.stringify([
      record.repoId ?? "unknown", record.taskId, record.agent ?? "unknown",
      record.model ?? "unknown", mode, record.warmSession ?? false,
      record.experimentId ?? null, record.repetitionId ?? null,
      ...["sourceHash", "taskHash", "verifierHash", "promptHash", "agentConfigHash", "pricingHash"].map(key => record.provenance?.[key] ?? null),
      record.tokens?.usageSource ?? record.tokens?.tokenizerSource ?? null,
      record.observedContent?.encoding ?? record.tokens?.encoding ?? null,
      record.observedContent?.tokenizerVersion ?? record.tokens?.tokenizerVersion ?? null,
    ]);
    let slot = byKey.get(key);
    if (!slot) {
      slot = Object.create(null);
      byKey.set(key, slot);
    }
    // Validate before pass-gating: failed retries must not disappear from pairing.
    if (Object.hasOwn(slot, record.variant)) {
      throw new Error(`Ambiguous benchmark pair for ${key}, variant ${record.variant}; analyze one attempt per variant in a separate input file.`);
    }
    slot[record.variant] = record;
  }

  const paired = [];
  for (const slot of byKey.values()) {
    const baseline = slot.baseline;
    if (!baseline?.quality?.passed) continue;
    const products = Object.entries(slot)
      .filter(([variant, product]) => variant !== "baseline" && product.quality?.passed)
      .sort(([left], [right]) => left.localeCompare(right));
    for (const [variant, product] of products) {
      if (!Number.isFinite(baseline.tokens?.total) || !Number.isFinite(product.tokens?.total)) continue;
      const baselineTok = baseline.tokens.total;
      const productTok = product.tokens.total;
      const deltaTok = baselineTok - productTok;
      const deltaPctVal = pct(deltaTok, baselineTok);
      const row = {
        repoId: baseline.repoId,
        experimentId: baseline.experimentId,
        repetitionId: baseline.repetitionId,
        taskId: baseline.taskId,
        agent: baseline.agent,
        model: baseline.model,
        executionMode: baseline.workflow?.executionMode ?? "unknown",
        claimGrade: baseline.claimGrade === "primary" && product.claimGrade === "primary"
          ? "primary"
          : "none",
        variant,
        baselineTok,
        productTok,
        deltaTok,
        deltaPct: deltaPctVal,
        bothPass: true,
        baselineCostUsd: baseline.cost?.totalUsd ?? null,
        productCostUsd: product.cost?.totalUsd ?? null,
        deltaCostUsd: Number.isFinite(baseline.cost?.totalUsd) && Number.isFinite(product.cost?.totalUsd) ? baseline.cost.totalUsd - product.cost.totalUsd : null,
        cache: buildCacheComparison(baseline.cache, product.cache),
        coverage: product.coverage,
        fairness: { available: baseline.fairness?.available === true && product.fairness?.available === true, passed: baseline.fairness?.passed === true && product.fairness?.passed === true },
        deltaAgentMs: Number.isFinite(baseline.agentMs) && Number.isFinite(product.agentMs) ? baseline.agentMs - product.agentMs : null,
        lossSignals: deltaPctVal < 0
          ? signalsForLoss({
              baselineTok,
              sdlTok: productTok,
              attribution: {
                repoSizeClass: product.repo?.sizeClass,
                cachedInput: product.tokens?.cachedInput ?? 0,
                total: product.tokens?.total ?? 0,
              },
              observability: product.artifacts?.sdl?.observability ?? {},
            })
          : [],
      };
      if (variant === "sdl") {
        Object.assign(row, {
          sdlTok: productTok,
          sdlCostUsd: row.productCostUsd,
          sdlVariant: variant,
        });
      }
      paired.push(row);
    }
  }
  return paired;
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
    // Missing sources are failed planned attempts, recorded by the runner.
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
  const promptSpecificity = task.promptSpecificity ?? "normal";
  if (!["sparse", "normal", "explicit"].includes(promptSpecificity)) {
    throw new Error(`${source}: invalid promptSpecificity '${promptSpecificity}'`);
  }
  abs(root, task.repo.sourcePath);
  return { ...task, promptSpecificity };
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

export function renderAgentPrompt(task, _variant) {
  return [
    `Task: ${task.taskId}`,
    task.prompt,
    "Edit this repository in place. Keep changes limited to the task."
  ].join("\n\n");
}

async function runAgentCommand(config, { runRoot, promptPath, task, variant, model, sdlSession, agentRuntime }) {
  const command = renderCommandTemplate(config.commandTemplate, {
    repo: runRoot,
    prompt: promptPath,
    taskId: task.taskId,
    variant,
    model,
    sdlMcpConfig: sdlMcpConfigArgs(sdlSession),
    sdlMcpUrl: sdlSession?.mcpUrl ?? "",
  });
  return { command, ...await runCommandAsync(command, runRoot, config.timeoutMs ?? 600_000, agentRuntime?.env) };
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

async function findSkillFiles(root, visited = new Set()) {
  try {
    // Codex discovers junctioned skills, so the disable list must follow them once.
    const canonicalRoot = await realpath(root);
    if (visited.has(canonicalRoot)) return [];
    visited.add(canonicalRoot);

    const entries = await readdir(root, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const path = join(root, entry.name);
      let type = entry;
      if (entry.isSymbolicLink()) {
        try {
          type = await stat(path);
        } catch (error) {
          if (error?.code === "ENOENT" || error?.code === "ELOOP") continue;
          throw error;
        }
      }
      if (type.isDirectory()) {
        files.push(...await findSkillFiles(path, visited));
      } else if (type.isFile() && entry.name === "SKILL.md") {
        files.push(path);
      }
    }
    return files;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ELOOP") return [];
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

export function runCommandAsync(command, cwd, timeoutMs, env = undefined) {
  return new Promise((resolveResult) => {
    const child = spawn(command, {
      cwd, shell: true, detached: process.platform !== "win32",
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    // Bound captured output without blocking the child on unread pipes.
    child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-4_000_000); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4_000_000); });
    const finish = (exitCode, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({ exitCode: exitCode ?? 1, stdout, stderr: stderr || error?.message || "", timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      // Kill the shell's process tree so timed-out agents cannot keep editing.
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        killer.on("error", () => child.kill());
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    }, timeoutMs);
    child.once("error", error => finish(1, error));
    child.once("close", code => finish(timedOut ? 1 : code));
  });
}

async function inspectCodexSessionsSterility(sessionFiles) {
  const inspections = await Promise.all(sessionFiles.map(inspectCodexSessionSterility));
  return { passed: inspections.every(item => item.passed), forbidden: [...new Set(inspections.flatMap(item => item.forbidden))], inspectedBytes: inspections.reduce((sum, item) => sum + item.inspectedBytes, 0) };
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


async function startSdlHttpSession({ root, workDir, runRoot, task, taskRunId, options, repoMeta }) {
  const authToken = options.sdlAuthToken ?? "sdlbench-" + taskRunId;
  if (options.sdlHttpBaseUrl) {
    const baseUrl = trimSlash(options.sdlHttpBaseUrl);
    const evidence = await prepareSdlHttpEvidence({
      baseUrl: options.sdlHttpBaseUrl,
      authToken,
      task,
      timeoutMs: options.sdlHttpTimeoutMs ?? 120_000,
    });
    const observability = await startObservabilityPolling(baseUrl, authToken, task.repoId, options);
    const stop = observability.stop;
    return {
      baseUrl,
    configPath: options.sdlConfigPath,
      mcpUrl: baseUrl + "/mcp",
      repoId: task.repoId,
      evidence,
      get observability() { return observability.getDelta(); },
      finishObservation: () => observability.stop(),
      stop: async () => { await stop(); },
    };
  }

  const sdlRoot = join(workDir, taskRunId + ".sdl");
  await rm(sdlRoot, { force: true, recursive: true });
  await mkdir(sdlRoot, { recursive: true });
  const configPath = join(sdlRoot, "sdlmcp.config.json");
  const dbPath = join(sdlRoot, "graph.lbug");
  await writeFile(configPath, JSON.stringify(createSdlHttpConfig({ task, runRoot, dbPath, repoMeta }), null, 2), "utf8");

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
    const evidence = await prepareSdlHttpEvidence({
      baseUrl,
      authToken,
      task,
      timeoutMs: options.sdlHttpTimeoutMs ?? 120_000,
    });
    const observability = await startObservabilityPolling(baseUrl, authToken, task.repoId, options);
    return {
      baseUrl,
    configPath,
      mcpUrl: baseUrl + "/mcp",
      repoId: task.repoId,
      evidence: {
        ...evidence,
        configPath,
        dbPath,
        server: { port, logTail: logs.join("").slice(-4000) },
      },
      get observability() { return observability.getDelta(); },
      finishObservation: () => observability.stop(),
      stop: async () => { await observability.stop(); await stopChild(child); },
    };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

export function createSdlHttpConfig({ task, runRoot, dbPath, repoMeta }) {
  const config = JSON.parse(readFileSync(new URL("../../config/sdlmcp.config.example.json", import.meta.url), "utf8"));
  const templateRepo = config.repos?.[0] ?? {};
  const languages = languagesForRepo(repoMeta, templateRepo.languages ?? []);

  return {
    ...config,
    repos: [{
      ...templateRepo,
      repoId: task.repoId,
      rootPath: runRoot,
      ignore: [
        ...new Set([
          ...(templateRepo.ignore ?? []),
          ...(repoMeta?.ignoreGlobs ?? []),
          "**/.sdlbench/**",
        ]),
      ],
      languages,
    }],
    graphDatabase: { ...(config.graphDatabase ?? {}), path: dbPath },
    indexing: { ...(config.indexing ?? {}), enableFileWatching: false },
    http: { ...(config.http ?? {}), allowRemote: false },
    httpAuth: { enabled: false },
  };
}

function languagesForRepo(repoMeta, defaultLanguages) {
  const map = {
    javascript: ["js", "jsx"],
    typescript: ["ts", "tsx", "js", "jsx"],
    python: ["py"],
    go: ["go"],
    java: ["java"],
    kotlin: ["kt"],
    rust: ["rs"],
    csharp: ["cs"],
    "c#": ["cs"],
    c: ["c"],
    cpp: ["cpp"],
    "c++": ["cpp"],
    php: ["php"],
    shell: ["sh"],
    bash: ["sh"],
  };
  const wanted = new Set((repoMeta?.languageTags ?? []).flatMap((tag) => map[String(tag).toLowerCase()] ?? []));
  if (wanted.size === 0) return defaultLanguages;
  const selected = defaultLanguages.filter((language) => wanted.has(language));
  return selected.length > 0 ? selected : defaultLanguages;
}

export async function startObservabilityPolling(baseUrl, authToken, repoId, options = {}) {
  const intervalMs = options.sdlObservabilityPollMs ?? 2000;
  let first = null;
  let last = null;
  let pending = null;
  let stopped = false;
  let failures = 0;
  let samples = 0;
  let finalSucceeded = false;
  async function poll() {
    try {
      const snapshot = await getJson(`${trimSlash(baseUrl)}/api/observability/snapshot?repoId=${encodeURIComponent(repoId)}`, authToken, 5000);
      last = snapshot;
      samples++;
      return snapshot;
    } catch { failures++; return null; }
  }
  first = await poll();
  const timer = setInterval(() => {
    // Slow endpoints must not accumulate a queue of stale snapshots.
    if (!stopped && !pending) pending = poll().finally(() => { pending = null; });
  }, intervalMs);
  timer.unref?.();
  return {
    async stop() {
      if (stopped) return pending;
      stopped = true;
      clearInterval(timer);
      await pending;
      finalSucceeded = Boolean(await poll());
    },
    getDelta() {
      return first && finalSucceeded ? { ...computeObservabilityDelta(first, last), sampleCount: samples, failedSamples: failures } : null;
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

async function prepareSdlHttpEvidence({ baseUrl, authToken, task, timeoutMs }) {
  const started = performance.now();
  const repoId = encodeURIComponent(task.repoId);
  const index = await postSseJson(trimSlash(baseUrl) + "/api/repo/" + repoId + "/reindex-stream", { mode: "full" }, authToken, timeoutMs);
  const context = [
    "SDL HTTP indexed " + task.repoId + " for " + task.taskId,
    "providerFirst=" + (index.providerFirstExecution ? "yes" : "unknown"),
  ].join("\n");
  return {
    transport: "http",
    repoId: task.repoId,
    durationMs: Math.round(performance.now() - started),
    index,
    retrieval: {
      queries: [],
      resultCount: 0,
      results: [],
    },
    context,
  };
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
      await fetchWithTimeout(baseUrl + "/health", {}, 1000);
      return;
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

export function trimSlash(value) {
  const text = String(value);
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 47) end--;
  return text.slice(0, end);
}

function countSessionTokens(task, variant, tokenizerCommand, sdlContext, outputOverride, tokenizerOptions = {}) {
  const outputText = outputOverride ?? Object.values(task.solution?.files ?? {}).join("\n");
  const activeContext = sdlContext;
  const counted = runTokenizer(tokenizerCommand, {
    input: `${tokenizerOptions.promptText ?? task.prompt}\n\n${activeContext}`,
    output: outputText ?? "",
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

  matches.sort((a, b) => String(a.sessionFile).localeCompare(String(b.sessionFile)));
  if (!matches.length) return null;
  const usage = {};
  for (const match of matches) {
    for (const [key, value] of Object.entries(match.usage)) {
      if (typeof value === "number") usage[key] = (usage[key] ?? 0) + value;
    }
  }
  return {
    ...matches[0], usage, sessionFiles: matches.map(match => match.sessionFile),
    attribution: { toolCalls: matches.flatMap(match => match.attribution?.toolCalls ?? []) },
  };
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

  if (!metadata?.cwd || normalizeSessionPath(metadata.cwd) !== normalizedRunRoot) return null;
  const usage = tokenInfo?.total_token_usage;
  if (!usage || !["input_tokens", "output_tokens", "total_tokens"].every(key => typeof usage[key] === "number" && Number.isFinite(usage[key]) && usage[key] >= 0)
    || usage.total_tokens !== usage.input_tokens + usage.output_tokens) {
    throw new Error(`Incomplete provider usage in matching Codex session ${sessionFile.path}`);
  }

  const toolCalls = tokenizerCommand
    ? tokenizeFunctionCalls(functionCalls, functionOutputs, tokenizerCommand)
    : functionCalls.map((fc) => {
        const output = functionOutputs.get(fc.callId) ?? "";
        return {
          toolName: fc.toolName,
          tokensIn: 0,
          tokensOut: 0,
          ts: fc.ts,
          arguments: boundAttributionText(fc.arguments),
          output: boundAttributionText(output),
        };
      });

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
    return calls.map((call) => ({
      toolName: call.toolName,
      tokensIn: null,
      tokensOut: null,
      ts: call.ts,
      arguments: boundAttributionText(call.arguments),
      output: boundAttributionText(outputs.get(call.callId) ?? ""),
    }));
  }
  return calls.map((call, i) => ({
    toolName: call.toolName,
    tokensIn: counted.counts[`in_${i}`] ?? 0,
    tokensOut: counted.counts[`out_${i}`] ?? 0,
    ts: call.ts,
    arguments: boundAttributionText(call.arguments),
    output: boundAttributionText(outputs.get(call.callId) ?? ""),
  }));
}

function boundAttributionText(value) {
  const text = String(value ?? "");
  return text.length > ATTRIBUTION_TEXT_LIMIT
    ? text.slice(0, ATTRIBUTION_TEXT_LIMIT) + "..."
    : text;
}

export function extractRetrievedSymbolsFromAttribution(attribution, contextTargets) {
  const targetSymbols = (contextTargets?.symbols ?? []).map(String).filter(Boolean);
  if (targetSymbols.length === 0) return [];

  const sdlCalls = (attribution?.toolCalls ?? [])
    .filter((call) => String(call.toolName ?? "").startsWith("sdl."));
  if (sdlCalls.length === 0) return [];

  const outputText = sdlCalls
    .map((call) => call.output ?? "")
    .join("\n")
    .toLowerCase();

  return targetSymbols.filter((symbol) => outputText.includes(symbol.toLowerCase()));
}

function normalizeSessionPath(value) {
  return resolve(String(value).replace(/^\\\\\?\\/, "")).replace(/\\/g, "/").toLowerCase();
}

function buildAttribution(rawAttribution, tokens) {
  const toolCalls = rawAttribution.toolCalls ?? [];
  const retrievalCalls = toolCalls.filter((tc) => /(?:^|[._])sdl(?:[._]|$)|sdl_mcp/i.test(tc.toolName ?? ""));
  const retrievalTokens = retrievalCalls.every(tc => Number.isFinite(tc.tokensIn) && Number.isFinite(tc.tokensOut))
    ? retrievalCalls.reduce((sum, tc) => sum + tc.tokensIn + tc.tokensOut, 0) : null;
  return {
    toolCalls,
    // Retrieval counts visible tool text; it is not a disjoint billing bucket.
    phaseBreakdownOverlapsProviderUsage: true,
    phaseBreakdown: {
      coldIndex: null,
      retrieval: retrievalTokens,
      reasoning: tokens.reasoningOutput ?? 0,
      output: Math.max(0, (tokens.output ?? 0) - (tokens.reasoningOutput ?? 0)),
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
    encoding: null,
    modelHint: estimatedTokens.modelHint,
    tokenizerResolution: "provider_usage",
    tokenizerVersion: null,
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

function codexSessionArtifact(sessionCounts) {
  return {
    sessionId: sessionCounts.sessionId,
    sessionFile: sessionCounts.sessionFile,
    sessionFiles: sessionCounts.sessionFiles,
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


function pct(part, whole) {
  return whole ? Math.round((part / whole) * 10000) / 100 : 0;
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

export function estimateCost(tokens, pricing = DEFAULT_PRICING) {
  const rates = { ...DEFAULT_PRICING, ...pricing };
  const input = nonNegativeNumber(tokens.input);
  const output = nonNegativeNumber(tokens.output);
  const productContext = nonNegativeNumber(tokens.productContext);
  const cachedInput = Math.min(input, nonNegativeNumber(tokens.cachedInput));
  const cachedWriteInput = Math.min(input - cachedInput, nonNegativeNumber(tokens.cachedWriteInput));
  const reasoningOutput = Math.min(output, nonNegativeNumber(tokens.reasoningOutput));
  const uncachedInput = input - cachedInput - cachedWriteInput;
  const nonReasoningOutput = output - reasoningOutput;
  const inputPerMTok = nonNegativeNumber(rates.inputPerMTok);
  const outputPerMTok = nonNegativeNumber(rates.outputPerMTok);
  const contextPerMTok = nonNegativeNumber(rates.contextPerMTok);
  const cachedInputPerMTok = nonNegativeNumber(rates.cachedInputPerMTok ?? inputPerMTok);
  const cacheWriteInputPerMTok = nonNegativeNumber(rates.cacheWriteInputPerMTok ?? inputPerMTok);
  const reasoningOutputPerMTok = nonNegativeNumber(rates.reasoningOutputPerMTok ?? outputPerMTok);

  const cachedInputUsd = (cachedInput / 1_000_000) * cachedInputPerMTok;
  const cacheWriteInputUsd = (cachedWriteInput / 1_000_000) * cacheWriteInputPerMTok;
  const uncachedInputUsd = (uncachedInput / 1_000_000) * inputPerMTok;
  const nonReasoningOutputUsd = (nonReasoningOutput / 1_000_000) * outputPerMTok;
  const reasoningOutputUsd = (reasoningOutput / 1_000_000) * reasoningOutputPerMTok;
  const contextUsd = (productContext / 1_000_000) * contextPerMTok;
  const inputUsd = (input / 1_000_000) * inputPerMTok;
  const outputUsd = (output / 1_000_000) * outputPerMTok;

  return {
    inputUsd: round4(inputUsd),
    outputUsd: round4(outputUsd),
    cachedInputUsd: round4(cachedInputUsd),
    cacheWriteInputUsd: round4(cacheWriteInputUsd),
    uncachedInputUsd: round4(uncachedInputUsd),
    nonReasoningOutputUsd: round4(nonReasoningOutputUsd),
    reasoningOutputUsd: round4(reasoningOutputUsd),
    contextUsd: round4(contextUsd),
    totalUsd: round4(cachedInputUsd + cacheWriteInputUsd + uncachedInputUsd + nonReasoningOutputUsd + reasoningOutputUsd + contextUsd),
    pricingModel: rates.model ?? tokens.model ?? DEFAULT_MODEL,
    inputPerMTok,
    outputPerMTok,
    contextPerMTok,
    cachedInputPerMTok,
    cacheWriteInputPerMTok,
    reasoningOutputPerMTok,
    pricingSource: rates.pricingSource ?? "default",
  };
}

export function computeCacheMetrics({ tokens = {}, cost = {} } = {}) {
  const hasProviderCacheUsage = Boolean(tokens.usageSource)
    && (Object.hasOwn(tokens, "cachedInput") || Object.hasOwn(tokens, "cachedWriteInput"));
  if (!hasProviderCacheUsage) {
    return { available: false, reason: "provider-usage-unavailable" };
  }

  const inputTokens = nonNegativeNumber(tokens.input);
  const readTokens = Math.min(inputTokens, nonNegativeNumber(tokens.cachedInput));
  const writeTokens = Math.min(inputTokens - readTokens, nonNegativeNumber(tokens.cachedWriteInput));
  const uncachedTokens = inputTokens - readTokens - writeTokens;
  const inputPerMTok = nonNegativeNumber(cost.inputPerMTok);
  const cachedInputPerMTok = nonNegativeNumber(cost.cachedInputPerMTok ?? inputPerMTok);
  const cacheWriteInputPerMTok = nonNegativeNumber(cost.cacheWriteInputPerMTok ?? inputPerMTok);
  const uncachedEquivalentInputUsd = (inputTokens / 1_000_000) * inputPerMTok;
  const billedInputUsd = (
    readTokens * cachedInputPerMTok
    + writeTokens * cacheWriteInputPerMTok
    + uncachedTokens * inputPerMTok
  ) / 1_000_000;
  const discountSavingsUsd = Math.max(0, uncachedEquivalentInputUsd - billedInputUsd);

  return {
    available: true,
    source: tokens.usageSource,
    inputTokens,
    readTokens,
    writeTokens,
    uncachedTokens,
    hitPercent: pct(readTokens, inputTokens),
    uncachedEquivalentInputUsd: round4(uncachedEquivalentInputUsd),
    billedInputUsd: round4(billedInputUsd),
    discountSavingsUsd: round4(discountSavingsUsd),
    discountSavingsPercent: pct(discountSavingsUsd, uncachedEquivalentInputUsd),
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
  if (!entry) return { sizeClass: null, languageTags: [], ignoreGlobs: [] };
  return {
    sizeClass: entry.sizeClass ?? null,
    languageTags: entry.languageTags ?? [],
    ignoreGlobs: entry.ignoreGlobs ?? [],
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


export function assertSdlBehaviorIntegrity({
  variant,
  executionMode,
  attribution,
  observability,
  claimGrade,
}) {
  if (variant !== "sdl" || executionMode !== "behavior" || claimGrade !== "primary") return;

  const attributed = (attribution?.toolCalls ?? []).some((call) =>
    /(?:^|[._])sdl(?:[._]|$)|sdl_mcp/i.test(call?.name ?? call?.toolName ?? ""),
  );
  const observed = [
    observability?.toolVolume_totalCalls,
    observability?.retrieval_totalRetrievals,
  ].some((value) => Number(value) > 0);

  if (!attributed && !observed) {
    throw new Error(
      "SDL behavior run recorded zero SDL tool activity; benchmark evidence is invalid.",
    );
  }
}


export async function installCodexEnforcementAssets({
  runRoot,
  repoId,
  configPath,
}) {
  if (!configPath) {
    throw new Error("SDL Codex behavior runs require the SDL server config path.");
  }

  const { buildEnforcementAssets } = await import(
    new URL("../../dist/cli/commands/init.js", import.meta.url)
  );
  const { dirname } = await import("node:path");
  const { chmod } = await import("node:fs/promises");
  const assets = buildEnforcementAssets(runRoot, repoId, configPath, "codex");

  for (const asset of assets) {
    if (existsSync(asset.path)) continue;
    await mkdir(dirname(asset.path), { recursive: true });
    await writeFile(
      asset.path,
      asset.content.endsWith("\n") ? asset.content : `${asset.content}\n`,
      "utf8",
    );
    if (asset.executable) {
      await chmod(asset.path, 0o755);
    }
  }
}


export function analyzeSessions(records) {
  const summary = analyzeSessionsCore(records);
  const byPromptSpecificity = {};

  for (const promptSpecificity of [
    "sparse",
    "normal",
    "explicit",
    "unspecified",
  ]) {
    const matching = records.filter(
      (record) =>
        (record.promptSpecificity ?? "unspecified") === promptSpecificity,
    );
    if (matching.length === 0) continue;

    const tierSummary = analyzeSessionsCore(matching);
    byPromptSpecificity[promptSpecificity] = {
      sessions: tierSummary.totals.sessions,
      paired: tierSummary.totals.paired,
      pairedMedianDeltaPct: tierSummary.pairedMedianDeltaPct,
      byVariant: tierSummary.byVariant,
      deltas: tierSummary.deltas,
    };
  }

  return { ...summary, byPromptSpecificity };
}
