#!/usr/bin/env node
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeSessions,
  importTranscript,
  readJsonl,
  runBenchmark,
  setupBenchmark,
  writeAnalysis,
} from "./sdlbench.mjs";
import { runScalingCurve } from "./scaling.mjs";
import { validateClaims } from "./claim-gates.mjs";

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

export async function serveViewer({ port, resultsPath }) {
  const root = resolve("sdlbench/viewer");
  const assetRoot = resolve("sdlbench/assets");
  const resultsRoot = resolve(dirname(resultsPath));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const isResult = url.pathname === "/results/sessions.jsonl";
    const isList = url.pathname === "/results/list.json";
    const isSidecar = url.pathname.startsWith("/results/");
    const isAsset = url.pathname.startsWith("/assets/");
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);

    if (isList) {
      try {
        const entries = await readdir(resultsRoot);
        const files = entries.filter((name) => name.endsWith(".jsonl")).sort();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ files, resultsRoot: dirname(resultsPath) }));
      } catch {
        res.writeHead(404).end("not found");
      }
      return;
    }

    let target;
    if (isResult) {
      target = resolve(resultsPath);
    } else if (isSidecar) {
      const sidecarName = url.pathname.slice("/results/".length);
      target = resolve(resultsRoot, decodeURIComponent(sidecarName));
    } else if (isAsset) {
      target = resolve(assetRoot, url.pathname.slice("/assets/".length));
    } else {
      target = resolve(root, file);
    }

    const allowed = isResult || isSidecar
      ? target.startsWith(resultsRoot)
      : isAsset
        ? target.startsWith(assetRoot)
        : target.startsWith(root);
    if (!allowed) {
      res.writeHead(403).end("forbidden");
      return;
    }
    try {
      await stat(target);
      res.writeHead(200, { "content-type": contentType(target) });
      createReadStream(target).pipe(res);
    } catch {
      res.writeHead(404).end("not found");
    }
  });

  const httpServer = await new Promise((resolveListen) => server.listen(port, resolveListen));
  const addressPort = server.address().port;
  console.log(`SDLBench viewer: http://127.0.0.1:${addressPort}`);
  return {
    port: addressPort,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

async function dispatch() {
  const args = process.argv.slice(2);
  const command = args.shift();
  const opts = parseArgs(args);

  if (command === "setup") {
    await setupBenchmark({});
    console.log("sdlbench setup complete");
  } else if (command === "run") {
    const result = await runBenchmark({
      agent: opts.agent ?? "codex",
      matrixPath: opts.matrix ?? "sdlbench/tasks/matrix.json",
      resultsPath: opts.out ?? "sdlbench/results/sessions.jsonl",
      variant: opts.variant ?? "baseline",
      workDir: opts.workDir ?? "sdlbench/.work/repos",
      executionMode: opts.behavior ? "behavior" : opts.executionMode ?? opts["execution-mode"],
      agentCommand: opts.agentCommand ?? opts["agent-command"],
      agentConfigPath: opts.agentConfig ?? opts["agent-config"],
      model: opts.model,
      pricingPath: opts.pricing ?? opts["pricing-path"],
      warmSession: opts["warm-session"] === true || opts.warmSession === true,
      reposLockPath: opts.repos ?? opts["repos-lock"],
      repoIdFilter: opts["repo-id"],
      agentTimeoutMs: opts.agentTimeoutMs || opts["agent-timeout-ms"] ? Number(opts.agentTimeoutMs ?? opts["agent-timeout-ms"]) : undefined,
    });
    console.log(JSON.stringify({ records: result.records.length, resultsPath: result.resultsPath }, null, 2));
  } else if (command === "import") {
    const transcriptPath = must(opts.transcript, "--transcript is required");
    const record = importTranscript({
      agent: opts.agent ?? "codex",
      repoId: opts.repoId,
      taskId: opts.taskId,
      text: await readFile(transcriptPath, "utf8"),
      variant: opts.variant ?? "baseline",
    });
    const out = opts.out ?? "sdlbench/results/sessions.jsonl";
    await mkdir(dirname(resolve(out)), { recursive: true }).catch(() => {});
    await writeFile(out, `${JSON.stringify(record)}\n`, { flag: "a" });
    console.log(JSON.stringify(record, null, 2));
  } else if (command === "analyze") {
    const inPath = opts.in ?? "sdlbench/results/sessions.jsonl";
    const outPath = opts.out ?? "sdlbench/results/summary.json";
    const summary = await writeAnalysis({ inPath, outPath });
    console.log(JSON.stringify(summary, null, 2));
  } else if (command === "scaling") {
    const sizes = (opts.sizes ?? "tiny,small").split(",").map((s) => s.trim());
    const result = await runScalingCurve({
      root: process.cwd(),
      matrixPath: opts.matrix ?? "sdlbench/tasks/matrix.json",
      sizeClasses: sizes,
      agent: opts.agent ?? "codex",
      model: opts.model,
      variant: opts.variant ?? "baseline,sdl",
      reposLockPath: opts.repos ?? opts["repos-lock"],
      tokenizerCommand: opts["tokenizer-command"],
      iUnderstandCost: opts["i-understand-cost"] === true,
    });
    console.log(JSON.stringify({ scalingRows: result.scalingRows.length, outputPath: result.outputPath }, null, 2));
  } else if (command === "claims") {
    const inPath = opts.in ?? "sdlbench/results/sessions.jsonl";
    const records = await readJsonl(inPath);
    const summary = analyzeSessions(records);
    const result = validateClaims({ paired: summary.paired, profile: opts.profile ?? "realism" });
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "view") {
    if (opts.check) {
      const records = await readJsonl(opts.results ?? "sdlbench/results/sessions.jsonl");
      const summary = analyzeSessions(records);
      await stat("sdlbench/viewer/index.html");
      await stat("sdlbench/assets/agent-trace.png");
      await stat("sdlbench/assets/report-card.png");
      console.log(JSON.stringify({ ok: true, sessions: summary.totals.sessions, variants: summary.totals.variants }, null, 2));
    } else {
      await serveViewer({ port: Number(opts.port ?? 4177), resultsPath: opts.results ?? "sdlbench/results/sessions.jsonl" });
    }
  } else {
    usage();
    process.exitCode = 1;
  }
}

if (isMain) {
  dispatch().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

function parseArgs(items) {
  const parsed = {};
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    parsed[key] = items[i + 1]?.startsWith("--") || items[i + 1] == null ? true : items[++i];
  }
  return parsed;
}

function must(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function contentType(path) {
  return {
    ".css": "text/css",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".json": "application/json",
    ".jsonl": "application/x-ndjson",
    ".png": "image/png",
    ".svg": "image/svg+xml",
  }[extname(path)] ?? "text/html";
}

function usage() {
  console.log(`Usage:
  sdlbench setup repos|products|all
  sdlbench run --matrix sdlbench/tasks/matrix.json --agent codex|claude --variant baseline|sdl [--model gpt-5.5] [--pricing sdlbench/config/pricing.json] [--repos sdlbench/config/repos.lock.json] [--repo-id fixture-js] [--warm-session] [--behavior] [--agent-command "cmd {repo} {prompt}"]
  sdlbench scaling --sizes tiny,small --agent codex --variant baseline,sdl [--i-understand-cost]
  sdlbench claims --in sdlbench/results/sessions.jsonl --profile realism|efficient|smoke
  sdlbench import --agent codex|claude --variant baseline --transcript transcript.jsonl
  sdlbench analyze --in sdlbench/results/sessions.jsonl
  sdlbench view [--port 4177]`);
}
