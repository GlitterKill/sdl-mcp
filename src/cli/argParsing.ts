import type {
  CLIOptions,
  IndexOptions,
  InitOptions,
  SummaryOptions,
  HealthOptions,
  ServeOptions,
} from "./types.js";

export type ParsedOptionValues = Record<string, unknown>;

function parsePort(portValue: unknown): number {
  const portStr = String(portValue);
  const port = parseInt(portStr, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error("--port must be a number between 1 and 65535");
  }
  return port;
}

export interface ExportCommandOptions {
  config?: string;
  repoId?: string;
  versionId?: string;
  commitSha?: string;
  branch?: string;
  output?: string;
  list?: boolean;
}

export interface ImportCommandOptions {
  config?: string;
  artifactPath?: string;
  repoId?: string;
  force?: boolean;
  verify?: boolean;
}

export interface PullCommandOptions {
  config?: string;
  repoId?: string;
  versionId?: string;
  commitSha?: string;
  fallback?: boolean;
  retries?: number;
}

export function parseInitOptions(
  args: string[],
  global: CLIOptions,
  values: ParsedOptionValues,
): InitOptions {
  const options: InitOptions = { ...global };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--client") {
      if (i + 1 >= args.length) {
        throw new Error("--client requires a value");
      }
      options.client = args[++i] as
        | "claude-code"
        | "codex"
        | "gemini"
        | "opencode";
    } else if (arg === "--repo-path") {
      if (i + 1 >= args.length) {
        throw new Error("--repo-path requires a value");
      }
      const repoPath = args[++i];
      if (repoPath.includes("..") || repoPath.includes("~")) {
        throw new Error("--repo-path cannot contain path traversal sequences");
      }
      options.repoPath = repoPath;
    } else if (arg === "--languages") {
      if (i + 1 >= args.length) {
        throw new Error("--languages requires a value");
      }
      options.languages = args[++i].split(",").map((lang) => lang.trim());
    } else if (arg === "--force" || arg === "-f") {
      options.force = true;
    } else if (arg === "--yes" || arg === "-y") {
      options.yes = true;
    } else if (arg === "--auto-index") {
      options.autoIndex = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    }
  }

  if (typeof values.client === "string") {
    options.client = values.client;
  }

  const repoPathValue =
    typeof values["repo-path"] === "string"
      ? values["repo-path"]
      : typeof values.repoPath === "string"
        ? values.repoPath
        : undefined;
  if (repoPathValue) {
    if (repoPathValue.includes("..") || repoPathValue.includes("~")) {
      throw new Error("--repo-path cannot contain path traversal sequences");
    }
    options.repoPath = repoPathValue;
  }

  if (typeof values.languages === "string") {
    options.languages = values.languages
      .split(",")
      .map((lang: string) => lang.trim());
  }
  if (values.force === true) {
    options.force = true;
  }
  if (values.yes === true) {
    options.yes = true;
  }
  if (values["auto-index"] === true) {
    options.autoIndex = true;
  }
  if (values["dry-run"] === true) {
    options.dryRun = true;
  }

  return options;
}

export function parseIndexOptions(
  args: string[],
  global: CLIOptions,
  values: ParsedOptionValues,
): IndexOptions {
  const options: IndexOptions = { ...global };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--watch" || arg === "-w") {
      options.watch = true;
    } else if (arg === "--force" || arg === "-f") {
      options.force = true;
    } else if (arg === "--repo-id") {
      if (i + 1 >= args.length) {
        throw new Error("--repo-id requires a value");
      }
      options.repoId = args[++i];
    }
  }

  if (values.watch === true) {
    options.watch = true;
  }
  if (values.force === true) {
    options.force = true;
  }
  if (typeof values["repo-id"] === "string") {
    options.repoId = values["repo-id"];
  }

  return options;
}

export function parseExportOptions(
  args: string[],
  global: CLIOptions,
  values: ParsedOptionValues,
): ExportCommandOptions {
  const options: ExportCommandOptions = { ...global };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--repo-id") {
      if (i + 1 >= args.length) {
        throw new Error("--repo-id requires a value");
      }
      options.repoId = args[++i];
    } else if (arg === "--version-id") {
      if (i + 1 >= args.length) {
        throw new Error("--version-id requires a value");
      }
      options.versionId = args[++i];
    } else if (arg === "--commit-sha") {
      if (i + 1 >= args.length) {
        throw new Error("--commit-sha requires a value");
      }
      options.commitSha = args[++i];
    } else if (arg === "--branch") {
      if (i + 1 >= args.length) {
        throw new Error("--branch requires a value");
      }
      options.branch = args[++i];
    } else if (arg === "--output" || arg === "-o") {
      if (i + 1 >= args.length) {
        throw new Error("--output requires a value");
      }
      options.output = args[++i];
    } else if (arg === "--list") {
      options.list = true;
    }
  }

  if (typeof values["repo-id"] === "string") {
    options.repoId = values["repo-id"];
  }
  if (typeof values["version-id"] === "string") {
    options.versionId = values["version-id"];
  }
  if (typeof values["commit-sha"] === "string") {
    options.commitSha = values["commit-sha"];
  }
  if (typeof values.branch === "string") {
    options.branch = values.branch;
  }
  if (typeof values.output === "string") {
    options.output = values.output;
  }
  if (values.list === true) {
    options.list = true;
  }

  return options;
}

export function parseImportOptions(
  args: string[],
  global: CLIOptions,
  values: ParsedOptionValues,
): ImportCommandOptions {
  const options: ImportCommandOptions = { ...global };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--artifact-path") {
      if (i + 1 >= args.length) {
        throw new Error("--artifact-path requires a value");
      }
      options.artifactPath = args[++i];
    } else if (arg === "--repo-id") {
      if (i + 1 >= args.length) {
        throw new Error("--repo-id requires a value");
      }
      options.repoId = args[++i];
    } else if (arg === "--force" || arg === "-f") {
      options.force = true;
    } else if (arg === "--verify") {
      options.verify = true;
    }
  }

  if (typeof values["artifact-path"] === "string") {
    options.artifactPath = values["artifact-path"];
  }
  if (typeof values["repo-id"] === "string") {
    options.repoId = values["repo-id"];
  }
  if (values.force === true) {
    options.force = true;
  }
  if (values.verify === true) {
    options.verify = true;
  }

  return options;
}

export function parsePullOptions(
  args: string[],
  global: CLIOptions,
  values: ParsedOptionValues,
): PullCommandOptions {
  const options: PullCommandOptions = { ...global };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--repo-id") {
      if (i + 1 >= args.length) {
        throw new Error("--repo-id requires a value");
      }
      options.repoId = args[++i];
    } else if (arg === "--version-id") {
      if (i + 1 >= args.length) {
        throw new Error("--version-id requires a value");
      }
      options.versionId = args[++i];
    } else if (arg === "--commit-sha") {
      if (i + 1 >= args.length) {
        throw new Error("--commit-sha requires a value");
      }
      options.commitSha = args[++i];
    } else if (arg === "--fallback") {
      options.fallback = true;
    } else if (arg === "--retries") {
      if (i + 1 >= args.length) {
        throw new Error("--retries requires a value");
      }
      options.retries = parseInt(args[++i], 10);
    }
  }

  if (typeof values["repo-id"] === "string") {
    options.repoId = values["repo-id"];
  }
  if (typeof values["version-id"] === "string") {
    options.versionId = values["version-id"];
  }
  if (typeof values["commit-sha"] === "string") {
    options.commitSha = values["commit-sha"];
  }
  if (values.fallback === true) {
    options.fallback = true;
  }
  if (typeof values.retries === "string") {
    options.retries = parseInt(values.retries, 10);
  }

  return options;
}

export function parseServeOptions(
  args: string[],
  global: CLIOptions,
  values: ParsedOptionValues,
): ServeOptions {
  const options: ServeOptions = { ...global, transport: "stdio" };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--stdio") {
      options.transport = "stdio";
    } else if (arg === "--http") {
      options.transport = "http";
    } else if (arg === "--port") {
      if (i + 1 >= args.length) {
        throw new Error("--port requires a value");
      }
      options.port = parsePort(args[++i]);
    } else if (arg === "--host") {
      if (i + 1 >= args.length) {
        throw new Error("--host requires a value");
      }
      options.host = args[++i];
    } else if (arg === "--no-watch") {
      options.noWatch = true;
    }
  }

  if (values.stdio === true) {
    options.transport = "stdio";
  } else if (values.http === true) {
    options.transport = "http";
  }

  if (values.port !== undefined) {
    options.port = parsePort(values.port);
  }
  if (typeof values.host === "string" && values.host.length > 0) {
    options.host = values.host;
  }
  if (values["no-watch"] === true) {
    options.noWatch = true;
  }

  return options;
}

export function parseSummaryOptions(
  args: string[],
  global: CLIOptions,
  values: ParsedOptionValues,
): SummaryOptions {
  let query = "";
  const options: SummaryOptions = {
    ...global,
    query,
    budget: 2000,
    format: "markdown",
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-") && !query) {
      query = arg;
      continue;
    }
    if (arg === "--budget") {
      if (i + 1 >= args.length) {
        throw new Error("--budget requires a value");
      }
      const budget = parseInt(args[++i], 10);
      if (!Number.isFinite(budget) || budget < 1) {
        throw new Error("--budget must be a positive integer");
      }
      options.budget = budget;
    } else if (arg === "--short") {
      options.budget = 500;
    } else if (arg === "--medium") {
      options.budget = 2000;
    } else if (arg === "--long") {
      options.budget = 5000;
    } else if (arg === "--format") {
      if (i + 1 >= args.length) {
        throw new Error("--format requires a value");
      }
      const format = args[++i];
      if (format !== "markdown" && format !== "json" && format !== "clipboard") {
        throw new Error("--format must be one of: markdown, json, clipboard");
      }
      options.format = format;
    } else if (arg === "--scope") {
      if (i + 1 >= args.length) {
        throw new Error("--scope requires a value");
      }
      const scope = args[++i];
      if (scope !== "symbol" && scope !== "file" && scope !== "task") {
        throw new Error("--scope must be one of: symbol, file, task");
      }
      options.scope = scope;
    } else if (arg === "--output" || arg === "-o") {
      if (i + 1 >= args.length) {
        throw new Error("--output requires a value");
      }
      options.output = args[++i];
    } else if (arg === "--repo" || arg === "--repo-id") {
      if (i + 1 >= args.length) {
        throw new Error(`${arg} requires a value`);
      }
      options.repoId = args[++i];
    }
  }

  if (typeof values.query === "string" && values.query.trim().length > 0) {
    query = values.query.trim();
  }
  if (!query && args.length > 0) {
    query = args.filter((arg) => !arg.startsWith("-")).join(" ").trim();
  }
  if (typeof values.budget === "string") {
    const budget = parseInt(values.budget, 10);
    if (!Number.isFinite(budget) || budget < 1) {
      throw new Error("--budget must be a positive integer");
    }
    options.budget = budget;
  }
  if (values.short === true) {
    options.budget = 500;
  }
  if (values.medium === true) {
    options.budget = 2000;
  }
  if (values.long === true) {
    options.budget = 5000;
  }
  if (typeof values.format === "string") {
    const format = values.format;
    if (format !== "markdown" && format !== "json" && format !== "clipboard") {
      throw new Error("--format must be one of: markdown, json, clipboard");
    }
    options.format = format;
  }
  if (typeof values.scope === "string") {
    const scope = values.scope;
    if (scope !== "symbol" && scope !== "file" && scope !== "task") {
      throw new Error("--scope must be one of: symbol, file, task");
    }
    options.scope = scope;
  }
  if (typeof values.output === "string") {
    options.output = values.output;
  }
  if (typeof values.repo === "string") {
    options.repoId = values.repo;
  }
  if (typeof values["repo-id"] === "string") {
    options.repoId = values["repo-id"];
  }

  options.query = query.trim();
  if (!options.query) {
    throw new Error("summary command requires a query");
  }

  return options;
}

export function parseHealthOptions(
  args: string[],
  global: CLIOptions,
  values: ParsedOptionValues,
): HealthOptions {
  const options: HealthOptions = { ...global };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--repo-id") {
      if (i + 1 >= args.length) {
        throw new Error("--repo-id requires a value");
      }
      options.repoId = args[++i];
    } else if (arg === "--json") {
      options.jsonOutput = true;
    } else if (arg === "--badge") {
      options.badge = true;
    }
  }

  if (typeof values["repo-id"] === "string") {
    options.repoId = values["repo-id"];
  }
  if (values.json === true) {
    options.jsonOutput = true;
  }
  if (values.badge === true) {
    options.badge = true;
  }

  return options;
}

export function parseBenchmarkOptions(
  args: string[],
  global: CLIOptions,
  values: ParsedOptionValues,
): import("./commands/benchmark.js").BenchmarkOptions {
  const options: import("./commands/benchmark.js").BenchmarkOptions = {
    ...global,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--repo-id") {
      if (i + 1 >= args.length) {
        throw new Error("--repo-id requires a value");
      }
      options.repoId = args[++i];
    } else if (arg === "--baseline-path") {
      if (i + 1 >= args.length) {
        throw new Error("--baseline-path requires a value");
      }
      options.baselinePath = args[++i];
    } else if (arg === "--threshold-path") {
      if (i + 1 >= args.length) {
        throw new Error("--threshold-path requires a value");
      }
      options.thresholdPath = args[++i];
    } else if (arg === "--out") {
      if (i + 1 >= args.length) {
        throw new Error("--out requires a value");
      }
      options.outputPath = args[++i];
    } else if (arg === "--json") {
      options.jsonOutput = true;
    } else if (arg === "--update-baseline") {
      options.updateBaseline = true;
    } else if (arg === "--skip-indexing") {
      options.skipIndexing = true;
    }
  }

  if (typeof values["repo-id"] === "string") {
    options.repoId = values["repo-id"];
  }
  if (typeof values["baseline-path"] === "string") {
    options.baselinePath = values["baseline-path"];
  }
  if (typeof values["threshold-path"] === "string") {
    options.thresholdPath = values["threshold-path"];
  }
  if (typeof values.out === "string") {
    options.outputPath = values.out;
  }
  if (values.json === true) {
    options.jsonOutput = true;
  }
  if (values["update-baseline"] === true) {
    options.updateBaseline = true;
  }
  if (values["skip-indexing"] === true) {
    options.skipIndexing = true;
  }

  return options;
}
