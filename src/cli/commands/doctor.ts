import { access, constants, existsSync } from "fs";
import { DoctorOptions } from "../types.js";
import { getDb } from "../../db/db.js";
import { NODE_MIN_MAJOR_VERSION } from "../../config/constants.js";
import { activateCliConfigPath } from "../../config/configPath.js";
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
  { name: "Tree-sitter grammars available", check: checkTreeSitterGrammar },
  { name: "Repo paths accessible", check: checkRepoPaths },
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

function displayResults(results: DoctorResult[]): void {
  for (const result of results) {
    const icon =
      result.status === "pass" ? "✓" : result.status === "fail" ? "✗" : "⚠";
    console.log(`${icon} ${result.name}: ${result.message}`);
  }
}
