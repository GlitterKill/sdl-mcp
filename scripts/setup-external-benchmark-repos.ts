#!/usr/bin/env tsx

import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";

export interface ExternalRepoSpec {
  repoId: string;
  cloneUrl: string;
  ref: string;
  languages: string[];
  ignore: string[];
}

interface ExternalRepoConfigEntry {
  repoId: string;
  rootPath: string;
  languages: string[];
  ignore: string[];
}

interface ExternalRepoConfigPayload {
  repos: ExternalRepoConfigEntry[];
}

const DEFAULT_LOCK_PATH = resolve(
  fileURLToPath(new URL("./benchmark/matrix-external-repos.lock.json", import.meta.url)),
);

function runGit(command: string, cwd?: string): void {
  execSync(`git ${command}`, {
    cwd,
    stdio: "inherit",
  });
}

function toConfigPath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function loadExternalRepoSpecs(lockPath = DEFAULT_LOCK_PATH): ExternalRepoSpec[] {
  const raw = readFileSync(resolve(lockPath), "utf-8");
  const parsed = JSON.parse(raw) as { repos?: ExternalRepoSpec[] };
  const repos = parsed.repos ?? [];

  if (repos.length === 0) {
    throw new Error(`No external benchmark repos found in lockfile: ${lockPath}`);
  }

  for (const repo of repos) {
    if (!repo.repoId || !repo.cloneUrl || !repo.ref) {
      throw new Error(`Invalid external repo spec in ${lockPath}: ${JSON.stringify(repo)}`);
    }
  }

  return repos;
}

export function buildExternalRepoConfig(
  baseDir: string,
  specs: readonly ExternalRepoSpec[],
): ExternalRepoConfigPayload {
  return {
    repos: specs.map((spec) => ({
      repoId: spec.repoId,
      rootPath: toConfigPath(join(baseDir, spec.repoId)),
      languages: [...spec.languages],
      ignore: [...spec.ignore],
    })),
  };
}

function checkoutPinnedRef(repoDir: string, spec: ExternalRepoSpec): void {
  try {
    runGit(`fetch --depth 1 origin ${spec.ref}`, repoDir);
    runGit("checkout --detach --force FETCH_HEAD", repoDir);
  } catch {
    // Some providers reject direct SHA fetches on shallow clones.
    runGit("fetch --tags origin", repoDir);
    runGit(`checkout --detach --force ${spec.ref}`, repoDir);
  }
}

function setupExternalRepo(baseDir: string, spec: ExternalRepoSpec): string {
  const repoDir = join(baseDir, spec.repoId);
  if (!existsSync(repoDir)) {
    runGit(`clone --filter=blob:none --no-checkout ${spec.cloneUrl} "${repoDir}"`);
  }

  checkoutPinnedRef(repoDir, spec);
  return repoDir;
}

function getArgValue(args: string[], name: string): string | undefined {
  const direct = args.find((arg) => arg.startsWith(`--${name}=`));
  if (direct) return direct.slice(name.length + 3);
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0) return args[idx + 1];
  return undefined;
}

function main(): void {
  const args = process.argv.slice(2);
  const baseDir = resolve(getArgValue(args, "base-dir") ?? ".tmp/external-benchmarks");
  const outPath = resolve(
    getArgValue(args, "out") ?? "benchmarks/real-world/external-repos.config.json",
  );
  const lockPath = resolve(getArgValue(args, "lock") ?? DEFAULT_LOCK_PATH);

  mkdirSync(baseDir, { recursive: true });

  const specs = loadExternalRepoSpecs(lockPath);
  for (const spec of specs) {
    setupExternalRepo(baseDir, spec);
  }

  const payload = buildExternalRepoConfig(baseDir, specs);
  writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf-8");

  console.log(`\nExternal benchmark repos are ready in: ${toConfigPath(baseDir)}`);
  console.log(`Pinned refs loaded from: ${toConfigPath(lockPath)}`);
  console.log(`Config snippet written to: ${toConfigPath(outPath)}`);
  console.log("Merge the generated repo entries into your sdlmcp config before running benchmark:real.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
