import { access, constants, existsSync } from "fs";
import { DoctorOptions } from "../types.js";
import { NODE_MIN_MAJOR_VERSION } from "../../config/constants.js";
import { activateCliConfigPath } from "../../config/configPath.js";
import {
  defaultGraphDbPath,
  normalizeGraphDbPath,
} from "../../db/graph-db-path.js";
import {
  CALL_EDGE_METADATA_FIELDS,
  KUZU_SCHEMA_VERSION,
  supportsCallResolutionMetadata,
} from "../../db/kuzu-schema.js";
import { getAllWatcherHealth } from "../../indexer/indexer.js";
import { createDefaultPass2ResolverRegistry } from "../../indexer/pass2/registry.js";
import {
  closeKuzuDb,
  getKuzuConn,
  getKuzuDbPath,
  initKuzuDb,
  isKuzuAvailable,
} from "../../db/kuzu.js";
import * as kuzuDb from "../../db/kuzu-queries.js";
import { getDefaultLiveIndexCoordinator } from "../../live-index/coordinator.js";
import {
  getGrammarLoadError,
  getParser,
  type SupportedLanguage,
} from "../../indexer/treesitter/grammarLoader.js";

const DOCTOR_CHECKS = [
  { name: "Node.js version", check: checkNodeVersion },
  { name: "Config file exists", check: checkConfigExists },
  { name: "Config file readable", check: checkConfigReadable },
  { name: "Tree-sitter grammars available", check: checkTreeSitterGrammar },
  { name: "Repo paths accessible", check: checkRepoPaths },
  { name: "Stale index detection", check: checkStaleIndex },
  { name: "Watcher health telemetry", check: checkWatcherHealth },
  { name: "Live index runtime", check: checkLiveIndexRuntime },
  {
    name: "Call resolution capabilities",
    check: checkCallResolutionCapabilities,
  },
  { name: "Graph database (Ladybug)", check: checkKuzuDb },
];

interface DoctorResult {
  name: string;
  status: "pass" | "fail" | "warn";
  message: string;
}

export async function doctorCommand(options: DoctorOptions): Promise<void> {
  console.log("Running SDL-MCP environment checks...\n");

  const resolvedOptions: DoctorOptions = {
    ...options,
    config: activateCliConfigPath(options.config),
  };

  const results: DoctorResult[] = [];

  for (const { name, check } of DOCTOR_CHECKS) {
    try {
      const result = await check(resolvedOptions);
      results.push({ name, ...result });
    } catch (error) {
      results.push({
        name,
        status: "fail",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  displayResults(results);

  const failed = results.filter((r) => r.status === "fail").length;
  if (failed > 0) {
    console.log(`\n✗ ${failed} check(s) failed. Please fix the issues above.`);
    process.exit(1);
  }

  const warned = results.filter((r) => r.status === "warn").length;
  if (warned > 0) {
    console.log(
      `\n⚠ ${warned} warning(s). SDL-MCP may work but with limitations.`,
    );
  } else {
    console.log("\n✓ All checks passed!");
  }
}

async function checkNodeVersion(
  _options: DoctorOptions,
): Promise<Omit<DoctorResult, "name">> {
  const version = process.version;
  const major = parseInt(version.slice(1).split(".")[0], 10);

  if (major >= NODE_MIN_MAJOR_VERSION) {
    return {
      status: "pass",
      message: `Node.js ${version} (>= ${NODE_MIN_MAJOR_VERSION}.0.0)`,
    };
  }

  return {
    status: "fail",
    message: `Node.js ${version} (requires >= ${NODE_MIN_MAJOR_VERSION}.0.0)`,
  };
}

async function checkConfigExists(
  options: DoctorOptions,
): Promise<Omit<DoctorResult, "name">> {
  const configPath = options.config ?? activateCliConfigPath();

  if (existsSync(configPath)) {
    return { status: "pass", message: configPath };
  }

  return {
    status: "fail",
    message: `Config not found: ${configPath}\n  Run: sdl-mcp init`,
  };
}

async function checkConfigReadable(
  options: DoctorOptions,
): Promise<Omit<DoctorResult, "name">> {
  const configPath = options.config ?? activateCliConfigPath();

  if (!existsSync(configPath)) {
    return { status: "warn", message: "Config file not found (skip)" };
  }

  try {
    await new Promise<void>((resolve_, reject) => {
      access(configPath, constants.R_OK, (err) => {
        if (err) reject(err);
        else resolve_();
      });
    });

    return { status: "pass", message: configPath };
  } catch (error) {
    return {
      status: "fail",
      message: `Cannot read config: ${configPath}`,
    };
  }
}

async function checkTreeSitterGrammar(
  _options: DoctorOptions,
): Promise<Omit<DoctorResult, "name">> {
  const grammars: Array<{
    name: string;
    language: SupportedLanguage;
    pkg: string;
  }> = [
    {
      name: "TypeScript",
      language: "typescript",
      pkg: "tree-sitter-typescript",
    },
    { name: "C", language: "c", pkg: "tree-sitter-c" },
    { name: "C++", language: "cpp", pkg: "tree-sitter-cpp" },
    { name: "PHP", language: "php", pkg: "tree-sitter-php" },
    { name: "Rust", language: "rust", pkg: "tree-sitter-rust" },
    { name: "Kotlin", language: "kotlin", pkg: "tree-sitter-kotlin" },
    { name: "Bash", language: "bash", pkg: "tree-sitter-bash" },
  ];

  const results: { name: string; success: boolean; error?: string }[] = [];

  try {
    for (const grammar of grammars) {
      try {
        const parser = getParser(grammar.language);
        if (!parser) {
          throw (
            getGrammarLoadError(grammar.language) ??
            new Error(`Failed to load ${grammar.pkg}`)
          );
        }

        results.push({ name: grammar.name, success: true });
      } catch (error) {
        results.push({
          name: grammar.name,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const failed = results.filter((r) => !r.success);
    if (failed.length === 0) {
      return {
        status: "pass",
        message: `All ${grammars.length} grammars loaded (${grammars.map((g) => g.name).join(", ")})`,
      };
    }

    const failedList = failed.map((f) => `${f.name}: ${f.error}`).join("\n  ");
    const failedPkgs = failed
      .map((f) => {
        const grammar = grammars.find((g) => g.name === f.name);
        return grammar?.pkg ?? "";
      })
      .filter(Boolean);
    const platform = `${process.platform}/${process.arch}`;
    const nodeVer = process.version;
    return {
      status: failed.length === grammars.length ? "fail" : "warn",
      message:
        `Failed to load ${failed.length} grammar(s):\n  ${failedList}\n\n` +
        `  Platform: ${platform}, Node: ${nodeVer}\n` +
        `  Remediation:\n` +
        `    1. npm rebuild ${failedPkgs.join(" ")}\n` +
        `    2. If that fails, check that the native binary is compatible with Node ${nodeVer} on ${platform}\n` +
        `    3. Try: npm install ${failedPkgs.join(" ")}`,
    };
  } catch (error) {
    return {
      status: "fail",
      message: `Cannot load tree-sitter: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function resolveDoctorGraphDbPath(
  config: { graphDatabase?: { path?: string | null } },
  resolvedConfigPath: string,
): string {
  const configuredPath = config.graphDatabase?.path;
  if (configuredPath && configuredPath.trim()) {
    return normalizeGraphDbPath(configuredPath, "auto");
  }
  return defaultGraphDbPath(resolvedConfigPath);
}

async function checkStaleIndex(
  options: DoctorOptions,
): Promise<Omit<DoctorResult, "name">> {
  const configPath = options.config ?? activateCliConfigPath();
  if (!existsSync(configPath)) {
    return {
      status: "warn",
      message: "Config not found (skip stale index check)",
    };
  }

  try {
    const { loadConfig } = await import("../../config/loadConfig.js");
    const config = loadConfig(configPath);
    const kuzuDbPath = resolveDoctorGraphDbPath(config, configPath);

    await initKuzuDb(kuzuDbPath);
    const conn = await getKuzuConn();

    const staleRepos: string[] = [];
    const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

    for (const repo of config.repos) {
      const files = await kuzuDb.getFilesByRepo(conn, repo.repoId);

      const lastIndexed = files
        .map((f) => f.lastIndexedAt)
        .filter((t): t is string => typeof t === "string" && t.length > 0)
        .sort((a, b) => b.localeCompare(a))[0];

      if (!lastIndexed) {
        staleRepos.push(`${repo.repoId} (never indexed)`);
        continue;
      }

      const lastIndexedMs = new Date(lastIndexed).getTime();
      const age = Date.now() - lastIndexedMs;
      if (age > STALE_THRESHOLD_MS) {
        const hoursAgo = Math.round(age / (60 * 60 * 1000));
        staleRepos.push(`${repo.repoId} (${hoursAgo}h ago)`);
      }
    }

    if (staleRepos.length === 0) {
      return {
        status: "pass",
        message: `All ${config.repos.length} repo(s) indexed within 24h`,
      };
    }

    return {
      status: "warn",
      message: `Stale indexes:\n${staleRepos.map((r) => `  - ${r}`).join("\n")}\n  Run: sdl-mcp index --mode full`,
    };
  } catch (error) {
    return {
      status: "warn",
      message: `Cannot check index staleness: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await closeKuzuDb();
  }
}

async function checkRepoPaths(
  options: DoctorOptions,
): Promise<Omit<DoctorResult, "name">> {
  const configPath = options.config ?? activateCliConfigPath();

  if (!existsSync(configPath)) {
    return {
      status: "warn",
      message: "Config not found (skip graph database check)",
    };
  }

  if (!isKuzuAvailable()) {
    return {
      status: "warn",
      message:
        "Graph database module not installed. Ladybug-backed 'kuzu' alias should be installed automatically (via @ladybugdb/core). Try: npm install",
    };
  }

  try {
    const { loadConfig } = await import("../../config/loadConfig.js");
    const config = loadConfig(configPath);

    const inaccessible: string[] = [];
    for (const repo of config.repos) {
      if (!existsSync(repo.rootPath)) {
        inaccessible.push(repo.rootPath);
      }
    }

    if (inaccessible.length === 0) {
      return {
        status: "pass",
        message: `All ${config.repos.length} repo(s) accessible`,
      };
    }

    return {
      status: "fail",
      message: `Inaccessible repos:\n${inaccessible.map((p) => `  - ${p}`).join("\n")}`,
    };
  } catch (error) {
    return {
      status: "warn",
      message: `Cannot verify repo paths: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function checkWatcherHealth(
  options: DoctorOptions,
): Promise<Omit<DoctorResult, "name">> {
  const configPath = options.config ?? activateCliConfigPath();
  if (!existsSync(configPath)) {
    return {
      status: "warn",
      message: "Config not found (skip watcher health)",
    };
  }

  try {
    const { loadConfig } = await import("../../config/loadConfig.js");
    const config = loadConfig(configPath);
    const watchEnabled = config.indexing?.enableFileWatching ?? true;
    if (!watchEnabled) {
      return { status: "warn", message: "File watching disabled in config" };
    }

    const healthByRepo = getAllWatcherHealth();
    const repoStates = config.repos.map((repo) => ({
      repoId: repo.repoId,
      health: healthByRepo[repo.repoId],
    }));

    const active = repoStates.filter((item) => Boolean(item.health));
    if (active.length === 0) {
      return {
        status: "warn",
        message:
          "No active watcher telemetry in this process (start `sdl-mcp serve` to observe runtime watcher health)",
      };
    }

    const stale = active.filter((item) => item.health?.stale);
    const errored = active.filter((item) => (item.health?.errors ?? 0) > 0);
    if (stale.length > 0) {
      return {
        status: "fail",
        message: `Stale watchers detected: ${stale.map((item) => item.repoId).join(", ")}`,
      };
    }
    if (errored.length > 0) {
      return {
        status: "warn",
        message: `Watcher errors observed: ${errored.map((item) => item.repoId).join(", ")}`,
      };
    }

    return {
      status: "pass",
      message: `Active watcher telemetry for ${active.length} repo(s)`,
    };
  } catch (error) {
    return {
      status: "warn",
      message: `Cannot evaluate watcher health: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function checkLiveIndexRuntime(
  options: DoctorOptions,
): Promise<Omit<DoctorResult, "name">> {
  const configPath = options.config ?? activateCliConfigPath();
  if (!existsSync(configPath)) {
    return {
      status: "warn",
      message: "Config not found (skip live index runtime)",
    };
  }

  try {
    const { loadConfig } = await import("../../config/loadConfig.js");
    const config = loadConfig(configPath);
    if (config.liveIndex?.enabled === false) {
      return { status: "warn", message: "Live indexing disabled in config" };
    }

    const liveIndex = getDefaultLiveIndexCoordinator();
    const statuses = await Promise.all(
      config.repos.map((repo) => liveIndex.getLiveStatus(repo.repoId)),
    );

    const interesting = statuses.filter(
      (status) =>
        status.pendingBuffers > 0 ||
        status.parseQueueDepth > 0 ||
        status.reconcileQueueDepth !== undefined ||
        status.lastBufferEventAt !== null ||
        status.lastCheckpointAttemptAt !== null,
    );

    if (interesting.length === 0) {
      return {
        status: "warn",
        message:
          "No live index telemetry in this process (push editor buffers or start `sdl-mcp serve` to observe runtime state)",
      };
    }

    const totalPendingBuffers = interesting.reduce(
      (sum, status) => sum + status.pendingBuffers,
      0,
    );
    const totalDirtyBuffers = interesting.reduce(
      (sum, status) => sum + status.dirtyBuffers,
      0,
    );
    const pendingCheckpointRepos = interesting.filter(
      (status) => status.checkpointPending,
    ).length;
    const reconcileFailures = interesting
      .filter((status) => status.reconcileLastError)
      .map((status) => status.repoId);
    const checkpointFailures = interesting
      .filter(
        (status) =>
          status.lastCheckpointResult === "failed" ||
          status.lastCheckpointResult === "partial",
      )
      .map((status) => status.repoId);

    const status =
      reconcileFailures.length > 0 || checkpointFailures.length > 0
        ? "warn"
        : "pass";
    const message =
      `repos=${interesting.length}; ` +
      `pendingBuffers=${totalPendingBuffers}; ` +
      `dirtyBuffers=${totalDirtyBuffers}; ` +
      `checkpointPending=${pendingCheckpointRepos > 0}; ` +
      `reconcileFailures=${reconcileFailures.length}; ` +
      `checkpointFailures=${checkpointFailures.length}`;

    return { status, message };
  } catch (error) {
    return {
      status: "warn",
      message: `Cannot evaluate live index runtime: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function checkCallResolutionCapabilities(
  options: DoctorOptions,
): Promise<Omit<DoctorResult, "name">> {
  const resolverIds = createDefaultPass2ResolverRegistry()
    .listResolvers()
    .map((resolver) => resolver.id);

  let minCallConfidenceMode = "request-only";
  const configPath = options.config ?? activateCliConfigPath();

  if (existsSync(configPath)) {
    try {
      const { loadConfig } = await import("../../config/loadConfig.js");
      const config = loadConfig(configPath);
      const configuredDefault = config.policy.defaultMinCallConfidence;
      if (configuredDefault !== undefined) {
        minCallConfidenceMode = `policy default ${configuredDefault}`;
      }
    } catch (error) {
      minCallConfidenceMode = `request-only (config unreadable: ${error instanceof Error ? error.message : String(error)})`;
    }
  } else {
    minCallConfidenceMode = "request-only (config not found)";
  }

  const metadataAvailable = supportsCallResolutionMetadata(KUZU_SCHEMA_VERSION);
  const metadataFields = CALL_EDGE_METADATA_FIELDS.join(", ");

  return {
    status: "pass",
    message:
      `pass2 resolvers: ${resolverIds.join(", ")}; ` +
      `call-edge metadata: ${metadataAvailable ? "enabled" : "disabled"} ` +
      `(schema v${KUZU_SCHEMA_VERSION}: ${metadataFields}); ` +
      `minCallConfidence: ${minCallConfidenceMode}`,
  };
}

async function checkKuzuDb(
  options: DoctorOptions,
): Promise<Omit<DoctorResult, "name">> {
  const configPath = options.config ?? activateCliConfigPath();
  if (!existsSync(configPath)) {
    return {
      status: "warn",
      message: "Config not found (skip graph database check)",
    };
  }

  if (!isKuzuAvailable()) {
    return {
      status: "warn",
      message:
        "Graph database driver not installed. SDL-MCP expects the 'kuzu' alias backed by @ladybugdb/core. Try: npm install",
    };
  }

  try {
    const { loadConfig } = await import("../../config/loadConfig.js");
    const config = loadConfig(configPath);

    if (!config.graphDatabase) {
      return {
        status: "warn",
        message:
          "Graph database not configured (missing graphDatabase section)",
      };
    }

    const kuzuDbPath = resolveDoctorGraphDbPath(config, configPath);

    if (!existsSync(kuzuDbPath)) {
      return {
        status: "warn",
        message: `Graph database not found: ${kuzuDbPath}`,
      };
    }

    const toNumber = (value: unknown): number => {
      if (typeof value === "number") return value;
      if (typeof value === "bigint") return Number(value);
      if (typeof value === "string") return Number(value);
      return 0;
    };

    const closeQueryResults = (result: unknown): void => {
      if (Array.isArray(result)) {
        for (const r of result) {
          (r as { close?: () => void }).close?.();
        }
        return;
      }
      (result as { close?: () => void }).close?.();
    };

    await initKuzuDb(kuzuDbPath);
    const conn = await getKuzuConn();

    const symbolCountResult = await conn.query(
      "MATCH (s:Symbol) RETURN count(s) AS symbolCount",
    );
    let symbolCount = 0;
    try {
      const qr = Array.isArray(symbolCountResult)
        ? symbolCountResult[symbolCountResult.length - 1]
        : symbolCountResult;
      const row = await qr.getNext();
      symbolCount = toNumber(
        (row as { symbolCount?: unknown }).symbolCount ?? 0,
      );
    } finally {
      closeQueryResults(symbolCountResult);
    }

    const dependsOnCountResult = await conn.query(
      "MATCH ()-[d:DEPENDS_ON]->() RETURN count(d) AS edgeCount",
    );
    let edgeCount = 0;
    try {
      const qr = Array.isArray(dependsOnCountResult)
        ? dependsOnCountResult[dependsOnCountResult.length - 1]
        : dependsOnCountResult;
      const row = await qr.getNext();
      edgeCount = toNumber((row as { edgeCount?: unknown }).edgeCount ?? 0);
    } finally {
      closeQueryResults(dependsOnCountResult);
    }

    const currentPath = getKuzuDbPath();
    const pathInfo = currentPath ? ` (active: ${currentPath})` : "";

    return {
      status: "pass",
      message: `Ladybug OK: ${kuzuDbPath}${pathInfo} (symbols: ${symbolCount}, edges: ${edgeCount})`,
    };
  } catch (error) {
    return {
      status: "warn",
      message: `Cannot verify graph database: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await closeKuzuDb();
  }
}
function displayResults(results: DoctorResult[]): void {
  for (const result of results) {
    const icon =
      result.status === "pass" ? "✓" : result.status === "fail" ? "✗" : "⚠";
    console.log(`${icon} ${result.name}: ${result.message}`);
  }
}
