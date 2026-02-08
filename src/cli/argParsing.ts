import type {
  CLIOptions,
  IndexOptions,
  InitOptions,
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
  if (typeof values["repo-id"] === "string") {
    options.repoId = values["repo-id"];
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

  return options;
}
