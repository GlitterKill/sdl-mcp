import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";
import type { RepoConfig } from "../config/types.js";
import { getAbsolutePathFromRepoRoot } from "../util/paths.js";
import { TS_DIAGNOSTICS_MAX_ERRORS } from "../config/constants.js";

export interface DiagnosticSeverity {
  error: number;
  warning: number;
  info: number;
}

export interface DiagnosticSummary {
  totalErrors: number;
  totalWarnings: number;
  totalInfo: number;
  topFiles: Array<{ file: string; errorCount: number }>;
}

export interface Diagnostic {
  filePath: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  code: string | number;
  message: string;
  severity: "error" | "warning" | "info";
}

export interface DiagnosticOptions {
  maxErrors?: number;
  timeoutMs?: number;
  scope?: "changedFiles" | "workspace";
  changedFiles?: string[];
}

interface LanguageServiceInstance {
  service: ts.LanguageService;
  program: ts.Program;
  tsConfigPath: string;
  projectRoot: string;
}

class DiagnosticsManager {
  private servicesCache = new Map<string, LanguageServiceInstance>();

  async getLanguageService(repo: RepoConfig): Promise<LanguageServiceInstance> {
    const cacheKey = repo.repoId;

    if (this.servicesCache.has(cacheKey)) {
      return this.servicesCache.get(cacheKey)!;
    }

    const tsConfigPath = this.findTsConfig(repo.rootPath, repo.tsconfigPath);
    const projectRoot = path.dirname(tsConfigPath);

    const parsedConfig = this.readTsConfig(tsConfigPath);

    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => parsedConfig.options,
      getScriptFileNames: () => this.getScriptFileNames(repo),
      getScriptVersion: (fileName) => this.getScriptVersion(fileName),
      getScriptSnapshot: (fileName) => this.getScriptSnapshot(fileName),
      getCurrentDirectory: () => repo.rootPath,
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      readFile: ts.sys.readFile,
      fileExists: ts.sys.fileExists,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      readDirectory: ts.sys.readDirectory,
    };

    const languageService = ts.createLanguageService(host);
    const program = languageService.getProgram();

    if (!program) {
      throw new Error(
        `Failed to create TypeScript program for repo ${repo.repoId}`,
      );
    }

    const instance: LanguageServiceInstance = {
      service: languageService,
      program,
      tsConfigPath,
      projectRoot,
    };

    this.servicesCache.set(cacheKey, instance);
    return instance;
  }

  async getDiagnostics(
    repo: RepoConfig,
    options?: DiagnosticOptions,
  ): Promise<{ diagnostics: Diagnostic[]; summary: DiagnosticSummary }> {
    const maxErrors = options?.maxErrors ?? TS_DIAGNOSTICS_MAX_ERRORS;
    const scope = options?.scope ?? "changedFiles";
    const changedFiles = options?.changedFiles ?? [];

    const lsInstance = await this.getLanguageService(repo);

    let fileNames: string[] = [];

    if (scope === "changedFiles" && changedFiles.length > 0) {
      fileNames = changedFiles
        .filter((file) => this.isTypeScriptFile(file))
        .map((file) => getAbsolutePathFromRepoRoot(repo.rootPath, file));
    } else {
      fileNames = this.getScriptFileNames(repo);
    }

    const allDiagnostics: Diagnostic[] = [];
    let errorCount = 0;

    for (const fileName of fileNames) {
      if (errorCount >= maxErrors) break;

      try {
        const diagnostics = [
          ...lsInstance.service.getSyntacticDiagnostics(fileName),
          ...lsInstance.service.getSemanticDiagnostics(fileName),
        ];

        for (const diag of diagnostics) {
          if (errorCount >= maxErrors) break;

          const diagnostic = this.convertDiagnostic(diag, fileName);
          if (diagnostic) {
            allDiagnostics.push(diagnostic);
            if (diagnostic.severity === "error") {
              errorCount++;
            }
          }
        }
      } catch (error) {
        process.stderr.write(
          `[sdl-mcp] Failed to get diagnostics for ${fileName}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        continue;
      }
    }

    const summary = this.buildSummary(allDiagnostics);

    return {
      diagnostics: allDiagnostics,
      summary,
    };
  }

  private findTsConfig(repoRoot: string, tsconfigPath?: string): string {
    if (tsconfigPath) {
      const absolutePath = getAbsolutePathFromRepoRoot(repoRoot, tsconfigPath);
      if (fs.existsSync(absolutePath)) {
        return absolutePath;
      }
      throw new Error(`Specified tsconfig not found: ${absolutePath}`);
    }

    const defaultTsconfig = path.join(repoRoot, "tsconfig.json");
    if (fs.existsSync(defaultTsconfig)) {
      return defaultTsconfig;
    }

    throw new Error(
      `No tsconfig.json found in ${repoRoot}. Please specify tsconfigPath in repo config.`,
    );
  }

  private readTsConfig(tsConfigPath: string): ts.ParsedCommandLine {
    const { config, error } = ts.readConfigFile(tsConfigPath, ts.sys.readFile);

    if (error) {
      throw new Error(`Failed to read tsconfig: ${error.messageText}`);
    }

    const parsed = ts.parseJsonConfigFileContent(
      config,
      ts.sys,
      path.dirname(tsConfigPath),
    );

    if (parsed.errors.length > 0) {
      throw new Error(
        `Failed to parse tsconfig: ${parsed.errors.map((e) => e.messageText).join(", ")}`,
      );
    }

    return parsed;
  }

  private getScriptFileNames(repo: RepoConfig): string[] {
    const rootPath = repo.rootPath;
    const ignorePatterns = repo.ignore ?? [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/build/**",
    ];

    const scriptFileNames: string[] = [];

    const walkDir = (dir: string) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            if (!this.shouldIgnoreDir(fullPath, ignorePatterns)) {
              walkDir(fullPath);
            }
          } else if (entry.isFile()) {
            if (
              this.isTypeScriptFile(fullPath) &&
              !this.shouldIgnoreFile(fullPath, ignorePatterns)
            ) {
              scriptFileNames.push(fullPath);
            }
          }
        }
      } catch {
        return;
      }
    };

    walkDir(rootPath);

    return scriptFileNames;
  }

  private isTypeScriptFile(filePath: string): boolean {
    return [".ts", ".tsx", ".js", ".jsx"].includes(path.extname(filePath));
  }

  private shouldIgnoreFile(
    filePath: string,
    ignorePatterns: string[],
  ): boolean {
    const normalizedPath = filePath.replace(/\\/g, "/");
    return ignorePatterns.some((pattern) => {
      const regex = new RegExp(
        pattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*"),
      );
      return regex.test(normalizedPath);
    });
  }

  private shouldIgnoreDir(dirPath: string, ignorePatterns: string[]): boolean {
    const normalizedPath = dirPath.replace(/\\/g, "/");
    return ignorePatterns.some((pattern) => {
      const regex = new RegExp(
        pattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*"),
      );
      return regex.test(normalizedPath);
    });
  }

  private getScriptVersion(fileName: string): string {
    try {
      const stats = fs.statSync(fileName);
      return stats.mtimeMs.toString();
    } catch {
      return "0";
    }
  }

  private getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
    try {
      const content = fs.readFileSync(fileName, "utf-8");
      return ts.ScriptSnapshot.fromString(content);
    } catch {
      return undefined;
    }
  }

  private convertDiagnostic(
    diagnostic: ts.Diagnostic,
    fileName: string,
  ): Diagnostic | null {
    if (!diagnostic.file || diagnostic.start === undefined) {
      return null;
    }

    const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(
      diagnostic.start,
    );
    const endLineAndChar = diagnostic.file.getLineAndCharacterOfPosition(
      diagnostic.start + (diagnostic.length ?? 0),
    );

    const code = diagnostic.code;
    const messageText = this.flattenMessageText(diagnostic.messageText);

    const severity: "error" | "warning" | "info" =
      diagnostic.category === ts.DiagnosticCategory.Error
        ? "error"
        : diagnostic.category === ts.DiagnosticCategory.Warning
          ? "warning"
          : "info";

    return {
      filePath: fileName,
      startLine: line + 1,
      startCol: character + 1,
      endLine: endLineAndChar.line + 1,
      endCol: endLineAndChar.character + 1,
      code,
      message: messageText,
      severity,
    };
  }

  private flattenMessageText(
    messageText: ts.DiagnosticMessageChain | string,
  ): string {
    if (typeof messageText === "string") {
      return messageText;
    }

    let result = messageText.messageText;

    if (messageText.next) {
      const nextMessages = messageText.next
        .map((n) => this.flattenMessageText(n))
        .join("  ");
      result += "  " + nextMessages;
    }

    return result;
  }

  private buildSummary(diagnostics: Diagnostic[]): DiagnosticSummary {
    const errorsByFile = new Map<string, number>();

    let totalErrors = 0;
    let totalWarnings = 0;
    let totalInfo = 0;

    for (const diag of diagnostics) {
      if (diag.severity === "error") {
        totalErrors++;
        errorsByFile.set(
          diag.filePath,
          (errorsByFile.get(diag.filePath) ?? 0) + 1,
        );
      } else if (diag.severity === "warning") {
        totalWarnings++;
      } else {
        totalInfo++;
      }
    }

    const topFiles = Array.from(errorsByFile.entries())
      .map(([file, count]) => ({ file, errorCount: count }))
      .sort((a, b) => b.errorCount - a.errorCount)
      .slice(0, 5);

    return {
      totalErrors,
      totalWarnings,
      totalInfo,
      topFiles,
    };
  }

  clearCache(repoId?: string): void {
    if (repoId) {
      this.servicesCache.delete(repoId);
    } else {
      this.servicesCache.clear();
    }
  }
}

export const diagnosticsManager = new DiagnosticsManager();
