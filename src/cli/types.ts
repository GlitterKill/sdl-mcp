export interface CLIOptions {
  config?: string;
  logLevel?: LogLevel;
  logFormat?: LogFormat;
}

export type LogLevel = "debug" | "info" | "warn" | "error";
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
}

export interface DoctorOptions extends CLIOptions {}

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
