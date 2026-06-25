#!/usr/bin/env node
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import {
  analyzeSessions,
  importTranscript,
  readJsonl,
  runBenchmark,
  setupBenchmark,
  writeAnalysis,
} from "./sdlbench.mjs";

const args = process.argv.slice(2);
const command = args.shift();
const opts = parseArgs(args);

try {
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
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}

async function serveViewer({ port, resultsPath }) {
  const root = resolve("sdlbench/viewer");
  const assetRoot = resolve("sdlbench/assets");
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const isResult = url.pathname === "/results/sessions.jsonl";
    const isAsset = url.pathname.startsWith("/assets/");
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const target = isResult
      ? resolve(resultsPath)
      : isAsset
        ? resolve(assetRoot, url.pathname.slice("/assets/".length))
        : resolve(root, file);
    const allowed = isResult || (isAsset ? target.startsWith(assetRoot) : target.startsWith(root));
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

  await new Promise((resolveListen) => server.listen(port, resolveListen));
  console.log(`SDLBench viewer: http://127.0.0.1:${port}`);
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
  sdlbench run --matrix sdlbench/tasks/matrix.json --agent codex|claude --variant baseline|sdl [--model gpt-5.5] [--pricing sdlbench/config/pricing.json] [--behavior] [--agent-command "cmd {repo} {prompt}"]
  sdlbench import --agent codex|claude --variant baseline --transcript transcript.jsonl
  sdlbench analyze --in sdlbench/results/sessions.jsonl
  sdlbench view [--port 4177]`);
}
