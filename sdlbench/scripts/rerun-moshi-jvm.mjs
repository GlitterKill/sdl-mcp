import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { runBenchmark } from "../src/sdlbench.mjs";

const root = resolve(".");
const bundle = join(root, "sdlbench/.work/products/moshi-kotlin-2.3.21-scripts4");
const manifest = JSON.parse(await readFile(join(bundle, "artifacts.json"), "utf8"));
for (const file of manifest.files) {
  const hash = createHash("sha256").update(await readFile(join(bundle, file.path))).digest("hex");
  if (hash !== file.sha256) throw new Error("Staged artifact changed: " + file.path);
}
const source = join(root,"sdlbench/.work/repos/moshi");
if (execFileSync("git",["-C",source,"rev-parse","HEAD"],{encoding:"utf8"}).trim() !== manifest.pinned
  || execFileSync("git",["-C",source,"status","--porcelain"],{encoding:"utf8"}).trim()) {
  throw new Error("Moshi source no longer matches the verified clean revision");
}
const experimentId = "moshi-jvm-" + new Date().toISOString().replace(/[:.]/g,"-");
const prefix = join(root,"sdlbench/results",experimentId);
const statePath = join(bundle,"last-run.json");
const state = {experimentId,pid:process.pid,status:"running",resultsPath:prefix+".sessions.jsonl",artifacts:manifest};
await writeFile(statePath,JSON.stringify(state,null,2));
try {
  const result = await runBenchmark({
    root, agent:"codex", model:"gpt-5.5", variant:"sdl", executionMode:"behavior",
    repoIdFilter:"moshi", reposLockPath:join(bundle,"repos.lock.json"),
    sdlHttpTimeoutMs:900000, experimentId, repetitionId:"1", resultsPath:state.resultsPath,
  });
  state.records = result.records.map(record => ({
    taskId:record.taskId,status:record.status,quality:record.quality,
    worktree:record.artifacts?.worktree,error:record.error,
    generatorFailures:record.artifacts?.sdl?.index?.scip?.failures,
  }));
  state.status = state.records.length === 2 && state.records.every(record =>
    record.quality?.passed && Array.isArray(record.generatorFailures) && record.generatorFailures.length === 0
  ) ? "passed" : "failed";
  if(state.status !== "passed") process.exitCode=1;
} catch(error) {
  state.status="failed";state.error=error.stack;process.exitCode=1;
} finally {
  state.finishedAt=new Date().toISOString();
  await writeFile(statePath,JSON.stringify(state,null,2));
  console.log(JSON.stringify({status:state.status,statePath,records:state.records,error:state.error}));
}
