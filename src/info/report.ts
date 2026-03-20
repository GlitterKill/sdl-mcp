import { existsSync } from "fs";
import { activateCliConfigPath } from "../config/configPath.js";
import { loadConfig } from "../config/loadConfig.js";
import {
  getLadybugDbPath,
  isLadybugAvailable,
} from "../db/ladybug.js";
import { getRustEngineStatus } from "../indexer/rustIndexer.js";
import {
  getLogFilePath,
  getLoggerDiagnostics,
} from "../util/logger.js";
import { getPackageVersion } from "../util/package-info.js";

export interface InfoReport {
  version: string;
  runtime: {
    node: string;
    platform: string;
    arch: string;
  };
  config: {
    path: string;
    exists: boolean;
    loaded: boolean;
  };
  logging: {
    path: string | null;
    consoleMirroring: boolean;
    fallbackUsed: boolean;
  };
  ladybug: {
    available: boolean;
    activePath: string | null;
  };
  native: {
    available: boolean;
    sourcePath: string | null;
    disabledByEnv: boolean;
    reason: string;
  };
  warnings: string[];
  misconfigurations: string[];
}

export interface InfoReportOptions {
  config?: string;
}

export async function collectInfoReport(
  options: InfoReportOptions = {},
): Promise<InfoReport> {
  const version = getPackageVersion();
  const configPath = activateCliConfigPath(options.config);
  const loggerDiagnostics = getLoggerDiagnostics();
  const nativeStatus = getRustEngineStatus();

  const report: InfoReport = {
    version,
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    config: {
      path: configPath,
      exists: existsSync(configPath),
      loaded: false,
    },
    logging: {
      path: getLogFilePath(),
      consoleMirroring: loggerDiagnostics.consoleMirroring,
      fallbackUsed: loggerDiagnostics.fallbackUsed,
    },
    ladybug: {
      available: isLadybugAvailable(),
      activePath: getLadybugDbPath(),
    },
    native: nativeStatus,
    warnings: [],
    misconfigurations: [],
  };

  if (!report.config.exists) {
    report.misconfigurations.push(`Config file not found: ${configPath}`);
  } else {
    try {
      loadConfig(configPath);
      report.config.loaded = true;
    } catch (error) {
      report.misconfigurations.push(
        `Config failed to load: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (!report.ladybug.available) {
    report.warnings.push("LadybugDB runtime is not available.");
  }

  if (!report.native.available) {
    report.warnings.push(
      report.native.disabledByEnv
        ? "Native Rust addon is disabled by SDL_MCP_DISABLE_NATIVE_ADDON."
        : `Native Rust addon unavailable: ${report.native.reason}`,
    );
  }

  if (!report.logging.path) {
    report.warnings.push("File logging is disabled.");
  } else if (report.logging.fallbackUsed) {
    report.warnings.push(
      `Log path fallback in use: ${report.logging.path}`,
    );
  }

  return report;
}
