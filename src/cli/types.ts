import type { LogLevel } from "../util/logger.js";

export type { LogLevel };

export interface CLIOptions {
  config?: string;
  logLevel?: LogLevel;
  logFormat?: LogFormat;
}

export type LogFormat = "json" | "pretty";

export interface CommandContext {
  configPath?: string;
  logLevel: LogLevel;
  logFormat: LogFormat;
}

export interface InitOptions extends CLIOptions {
  client?: string;
  repoPath?: string;
  languages?: string[];
  force?: boolean;
  yes?: boolean;
  autoIndex?: boolean;
  dryRun?: boolean;
  enforceAgentTools?: boolean;
}

export interface DoctorOptions extends CLIOptions {}

export interface InfoOptions extends CLIOptions {
  jsonOutput?: boolean;
}

export interface IndexOptions extends CLIOptions {
  watch?: boolean;
  repoId?: string;
  force?: boolean;
}

export interface VersionOptions extends CLIOptions {}

export interface ServeOptions extends CLIOptions {
  transport: "stdio" | "http";
  port?: number;
  host?: string;
  noWatch?: boolean;
}

export interface SummaryOptions extends CLIOptions {
  query: string;
  budget?: number;
  format?: "markdown" | "json" | "clipboard";
  scope?: "symbol" | "file" | "task";
  output?: string;
  repoId?: string;
}

export interface HealthOptions extends CLIOptions {
  repoId?: string;
  jsonOutput?: boolean;
  badge?: boolean;
}

export interface BenchmarkOptions extends CLIOptions {
  repoId?: string;
  baselinePath?: string;
  thresholdPath?: string;
  outputPath?: string;
  jsonOutput?: boolean;
  updateBaseline?: boolean;
  skipIndexing?: boolean;
}

export interface ToolDispatchOptions extends CLIOptions {
  /** The action name, e.g. "symbol.search" */
  action?: string;
  /** Whether to show the action list */
  list?: boolean;
  /** Whether to show action-specific help */
  showHelp?: boolean;
  /** Output format override */
  outputFormat?: string;
  /** Raw remaining args to pass to the action-specific parser */
  rawArgs: string[];
}
