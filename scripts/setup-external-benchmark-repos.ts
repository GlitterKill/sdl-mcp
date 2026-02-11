#!/usr/bin/env tsx

import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";

interface ExternalRepoSpec {
  repoId: string;
  cloneUrl: string;
  branch: string;
  languages: string[];
  ignore: string[];
}

const EXTERNAL_REPOS: ExternalRepoSpec[] = [
  {
    repoId: "zod-oss",
    cloneUrl: "https://github.com/colinhacks/zod.git",
    branch: "main",
    languages: ["ts", "tsx", "js"],
    ignore: [
      "**/node_modules/**",
      "**/dist/**",
      "**/lib/**",
      "**/coverage/**",
      "**/*.test.ts",
      "**/*.spec.ts",
    ],
  },
  {
    repoId: "preact-oss",
    cloneUrl: "https://github.com/preactjs/preact.git",
    branch: "main",
    languages: ["ts", "tsx", "js", "jsx"],
    ignore: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/*.test.ts",
      "**/*.spec.ts",
      "**/*.test.tsx",
      "**/*.spec.tsx",
    ],
  },
  {
    repoId: "flask-oss",
    cloneUrl: "https://github.com/pallets/flask.git",
    branch: "main",
    languages: ["py"],
    ignore: [
      "**/.venv/**",
      "**/venv/**",
      "**/__pycache__/**",
      "**/.pytest_cache/**",
      "**/build/**",
      "**/dist/**",
      "**/*.pyc",
      "**/tests/**",
    ],
  },
  {
    repoId: "ansible-lint-oss",
    cloneUrl: "https://github.com/ansible/ansible-lint.git",
    branch: "main",
    languages: ["py", "sh"],
    ignore: [
      "**/.venv/**",
      "**/venv/**",
      "**/__pycache__/**",
      "**/.pytest_cache/**",
      "**/build/**",
      "**/dist/**",
      "**/*.pyc",
      "**/test/**",
      "**/tests/**",
      "**/.tox/**",
    ],
  },
];

function runGit(command: string, cwd?: string): void {
  execSync(`git ${command}`, {
    cwd,
    stdio: "inherit",
  });
}

function toConfigPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function setupExternalRepo(baseDir: string, spec: ExternalRepoSpec): string {
  const repoDir = join(baseDir, spec.repoId);
  if (!existsSync(repoDir)) {
    runGit(`clone --depth 1 --branch ${spec.branch} ${spec.cloneUrl} "${repoDir}"`);
    return repoDir;
  }

  runGit("fetch --depth 1 origin", repoDir);
  runGit(`checkout ${spec.branch}`, repoDir);
  runGit(`reset --hard origin/${spec.branch}`, repoDir);
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

  mkdirSync(baseDir, { recursive: true });

  const repos = EXTERNAL_REPOS.map((spec) => {
    const rootPath = setupExternalRepo(baseDir, spec);
    return {
      repoId: spec.repoId,
      rootPath: toConfigPath(rootPath),
      languages: spec.languages,
      ignore: spec.ignore,
    };
  });

  const payload = { repos };
  writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf-8");

  console.log(`\nExternal benchmark repos are ready in: ${toConfigPath(baseDir)}`);
  console.log(`Config snippet written to: ${toConfigPath(outPath)}`);
  console.log("Merge the generated repo entries into your sdlmcp config before running benchmark:real.");
}

main();
