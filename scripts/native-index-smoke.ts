import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { getRustEngineStatus } from "../dist/indexer/rustIndexer.js";

const REPO_ID = "ci-native-index-smoke";
const FILE_COUNT = 240;

function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function writeFixtureRepo(root: string): void {
  const srcDir = join(root, "src");
  mkdirSync(srcDir, { recursive: true });

  const exports: string[] = [];
  for (let i = 0; i < FILE_COUNT; i++) {
    const id = i.toString().padStart(3, "0");
    const symbolName = `feature${id}`;
    exports.push(`export { ${symbolName} } from "./${symbolName}.js";`);
    writeFileSync(
      join(srcDir, `${symbolName}.ts`),
      [
        `export interface Feature${id} {`,
        "  readonly label: string;",
        "  readonly value: number;",
        "}",
        "",
        `export function ${symbolName}(value: number): Feature${id} {`,
        `  return { label: "feature-${id}", value };`,
        "}",
        "",
        `export function describe${id}(value: number): string {`,
        `  const item = ${symbolName}(value);`,
        "  return `${item.label}:${item.value}`;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  writeFileSync(join(srcDir, "index.ts"), exports.join("\n") + "\n", "utf8");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ type: "module", private: true }, null, 2) + "\n",
    "utf8",
  );
}

function writeSmokeConfig(configPath: string, fixtureRoot: string, dbPath: string): void {
  const config = {
    repos: [
      {
        repoId: REPO_ID,
        rootPath: toPosixPath(fixtureRoot),
        ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**"],
        languages: ["ts"],
      },
    ],
    graphDatabase: {
      path: toPosixPath(dbPath),
    },
    indexing: {
      engine: "rust",
      concurrency: 4,
      enableFileWatching: false,
    },
    policy: {
      maxWindowLines: 180,
      maxWindowTokens: 1400,
      requireIdentifiers: true,
      allowBreakGlass: true,
    },
    semantic: {
      enabled: false,
      generateSummaries: false,
    },
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

function main(): void {
  const workspaceRoot = resolve(process.cwd());
  const cliPath = join(workspaceRoot, "dist", "cli", "index.js");
  if (!existsSync(cliPath)) {
    throw new Error("dist/cli/index.js is missing; run npm run build first");
  }

  const status = getRustEngineStatus();
  if (!status.available) {
    throw new Error(
      `Native addon is required for this smoke test (${status.reason})`,
    );
  }

  const tempRoot = mkdtempSync(join(tmpdir(), "sdl-native-index-smoke-"));
  const fixtureRoot = join(tempRoot, "repo");
  const graphDir = join(tempRoot, "graph");
  const graphDbPath = join(graphDir, "sdl-mcp-graph.lbug");
  const configPath = join(tempRoot, "sdlmcp.config.json");

  try {
    mkdirSync(graphDir, { recursive: true });
    writeFixtureRepo(fixtureRoot);
    writeSmokeConfig(configPath, fixtureRoot, graphDbPath);

    const env = {
      ...process.env,
      SDL_CONFIG: configPath,
      SDL_GRAPH_DB_PATH: graphDbPath,
    };
    delete env.SDL_MCP_DISABLE_NATIVE_ADDON;
    delete env.SDL_MCP_NATIVE_PASS1_SERIAL;

    console.log(
      `[native-index-smoke] indexing ${FILE_COUNT + 1} files with ${status.sourcePath ?? "native addon"}`,
    );

    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "--config",
        configPath,
        "index",
        "--repo-id",
        REPO_ID,
        "--force",
      ],
      {
        cwd: workspaceRoot,
        env,
        stdio: "inherit",
      },
    );

    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(`native index smoke failed with exit code ${result.status}`);
    }

    console.log("[native-index-smoke] completed");
  } catch (error) {
    console.error(`[native-index-smoke] preserved temp workspace: ${tempRoot}`);
    throw error;
  }

  rmSync(tempRoot, { recursive: true, force: true });
}

main();
