import { access, constants, existsSync } from "fs";
import { DoctorOptions } from "../types.js";
import { getDb } from "../../db/db.js";
import { NODE_MIN_MAJOR_VERSION } from "../../config/constants.js";
import { activateCliConfigPath } from "../../config/configPath.js";
import { getAllWatcherHealth } from "../../indexer/indexer.js";
import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";
import C from "tree-sitter-c";
import Cpp from "tree-sitter-cpp";
import PHP from "tree-sitter-php";
import Rust from "tree-sitter-rust";
import Kotlin from "tree-sitter-kotlin";
import Bash from "tree-sitter-bash";

const DOCTOR_CHECKS = [
  { name: "Node.js version", check: checkNodeVersion },
  { name: "Config file exists", check: checkConfigExists },
  { name: "Config file readable", check: checkConfigReadable },
  { name: "Database path writable", check: checkDatabaseWritable },
  { name: "Database integrity", check: checkDatabaseIntegrity },
  { name: "Tree-sitter grammars available", check: checkTreeSitterGrammar },
  { name: "Repo paths accessible", check: checkRepoPaths },
  { name: "Stale index detection", check: checkStaleIndex },
  { name: "Watcher health telemetry", check: checkWatcherHealth },
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

async function checkDatabaseWritable(
  _options: DoctorOptions,
): Promise<Omit<DoctorResult, "name">> {
  try {
    const db = getDb(":memory:");
    db.close();
    return { status: "pass", message: "SQLite database initialization works" };
  } catch (error) {
    return {
      status: "fail",
      message: `SQLite error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function checkTreeSitterGrammar(
  _options: DoctorOptions,
): Promise<Omit<DoctorResult, "name">> {
  const grammars = [
    { name: "TypeScript", module: TypeScript, langProp: "typescript" },
    { name: "C", module: C, langProp: null },
    { name: "C++", module: Cpp, langProp: null },
    { name: "PHP", module: PHP, langProp: "php" },
    { name: "Rust", module: Rust, langProp: null },
    { name: "Kotlin", module: Kotlin, langProp: null },
    { name: "Bash", module: Bash, langProp: null },
  ];

  const results: { name: string; success: boolean; error?: string }[] = [];

  try {
    for (const grammar of grammars) {
      try {
        let language: any;

        if (grammar.langProp) {
          language = grammar.module[grammar.langProp];
        } else {
          language = grammar.module;
        }

        const parser = new Parser();
        parser.setLanguage(language);

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
        const pkgMap: Record<string, string> = {
          TypeScript: "tree-sitter-typescript",
          C: "tree-sitter-c",
          "C++": "tree-sitter-cpp",
          PHP: "tree-sitter-php",
          Rust: "tree-sitter-rust",
          Kotlin: "tree-sitter-kotlin",
          Bash: "tree-sitter-bash",
        };
        return grammar ? pkgMap[grammar.name] : "";
      })
      .filter(Boolean);
    return {
      status: "fail",
      message: `Failed to load ${failed.length} grammar(s):\n  ${failedList}\n\n  Install missing grammars: npm install ${failedPkgs.join(" ")}`,
    };
  } catch (error) {
    return {
      status: "fail",
      message: `Cannot load tree-sitter: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function checkDatabaseIntegrity(
  _options: DoctorOptions,
): Promise<Omit<DoctorResult, "name">> {
  try {
    const db = getDb();
    const result = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    const status = result[0]?.integrity_check;
    if (status === "ok") {
      return { status: "pass", message: "PRAGMA integrity_check passed" };
    }
    return {
      status: "fail",
      message: `Database integrity check failed: ${status}`,
    };
  } catch (error) {
    return {
      status: "warn",
      message: `Cannot check database integrity: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function checkStaleIndex(
  options: DoctorOptions,
): Promise<Omit<DoctorResult, "name">> {
  const configPath = options.config ?? activateCliConfigPath();
  if (!existsSync(configPath)) {
    return { status: "warn", message: "Config not found (skip stale index check)" };
  }

  try {
    const { loadConfig } = await import("../../config/loadConfig.js");
    const config = loadConfig(configPath);
    const db = getDb();

    const staleRepos: string[] = [];
    const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

    for (const repo of config.repos) {
      const row = db
        .prepare(
          `SELECT MAX(last_indexed_at) as last_indexed FROM files WHERE repo_id = (SELECT repo_id FROM repos WHERE repo_id = ?)`,
        )
        .get(repo.repoId) as { last_indexed: string | null } | undefined;

      if (!row?.last_indexed) {
        staleRepos.push(`${repo.repoId} (never indexed)`);
        continue;
      }

      const lastIndexed = new Date(row.last_indexed).getTime();
      const age = Date.now() - lastIndexed;
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
  }
}

async function checkRepoPaths(
  options: DoctorOptions,
): Promise<Omit<DoctorResult, "name">> {
  const configPath = options.config ?? activateCliConfigPath();

  if (!existsSync(configPath)) {
    return { status: "warn", message: "Config not found (skip repo checks)" };
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
    return { status: "warn", message: "Config not found (skip watcher health)" };
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
        message: "No active watcher telemetry in this process (start `sdl-mcp serve` to observe runtime watcher health)",
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

function displayResults(results: DoctorResult[]): void {
  for (const result of results) {
    const icon =
      result.status === "pass" ? "✓" : result.status === "fail" ? "✗" : "⚠";
    console.log(`${icon} ${result.name}: ${result.message}`);
  }
}
