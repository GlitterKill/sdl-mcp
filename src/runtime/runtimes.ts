import { execFileSync } from "child_process";
import { basename } from "path";
import type { RuntimeDescriptor, RuntimeDetectionResult } from "./types.js";

// ── Table types ──────────────────────────────────────────────

interface PlatformCandidates {
  win32: string[];
  unix: string[];
}

interface PlatformExtensions {
  win32: string;
  unix: string;
}

interface CompileStepConfig {
  mode: "run-command" | "compile-then-execute";
  command: string;
  args: string[];
  outExtension?: string;
}

interface RuntimeTableEntry {
  name: string;
  aliases: string[];
  extension: string | PlatformExtensions;
  versionFlag: string;
  candidates: PlatformCandidates;
  commandBuilder: "interpreted" | "compiled" | "shell";
  compileStep?: CompileStepConfig;
  requiredEnvKeys?: string[];
}

// ── The table ────────────────────────────────────────────────

const RUNTIME_TABLE: RuntimeTableEntry[] = [
  {
    name: "node",
    aliases: ["node", "bun"],
    extension: ".js",
    versionFlag: "--version",
    candidates: { win32: ["node", "bun"], unix: ["node", "bun"] },
    commandBuilder: "interpreted",
  },
  {
    name: "typescript",
    aliases: ["tsx", "bun", "ts-node"],
    extension: ".ts",
    versionFlag: "--version",
    candidates: { win32: ["bun", "tsx"], unix: ["bun", "tsx"] },
    commandBuilder: "interpreted",
  },
  {
    name: "python",
    aliases: ["python3", "python", "py"],
    extension: ".py",
    versionFlag: "--version",
    candidates: { win32: ["python", "python3", "py"], unix: ["python3", "python"] },
    commandBuilder: "interpreted",
  },
  {
    name: "shell",
    aliases: ["bash", "sh", "cmd"],
    extension: { win32: ".cmd", unix: ".sh" },
    versionFlag: "--version",
    candidates: { win32: ["cmd.exe"], unix: ["bash", "sh"] },
    commandBuilder: "shell",
  },
  {
    name: "ruby",
    aliases: ["ruby"],
    extension: ".rb",
    versionFlag: "--version",
    candidates: { win32: ["ruby"], unix: ["ruby"] },
    commandBuilder: "interpreted",
  },
  {
    name: "php",
    aliases: ["php"],
    extension: ".php",
    versionFlag: "--version",
    candidates: { win32: ["php"], unix: ["php"] },
    commandBuilder: "interpreted",
  },
  {
    name: "perl",
    aliases: ["perl"],
    extension: ".pl",
    versionFlag: "--version",
    candidates: { win32: ["perl"], unix: ["perl"] },
    commandBuilder: "interpreted",
  },
  {
    name: "r",
    aliases: ["Rscript"],
    extension: ".R",
    versionFlag: "--version",
    candidates: { win32: ["Rscript"], unix: ["Rscript"] },
    commandBuilder: "interpreted",
    requiredEnvKeys: ["R_HOME"],
  },
  {
    name: "elixir",
    aliases: ["elixir"],
    extension: ".exs",
    versionFlag: "--version",
    candidates: { win32: ["elixir"], unix: ["elixir"] },
    commandBuilder: "interpreted",
  },
  {
    name: "go",
    aliases: ["go"],
    extension: ".go",
    versionFlag: "version",
    candidates: { win32: ["go"], unix: ["go"] },
    commandBuilder: "compiled",
    compileStep: { mode: "run-command", command: "go", args: ["run"] },
    requiredEnvKeys: ["GOPATH", "GOROOT", "GOMODCACHE"],
  },
  {
    name: "java",
    aliases: ["java"],
    extension: ".java",
    versionFlag: "--version",
    candidates: { win32: ["java"], unix: ["java"] },
    commandBuilder: "compiled",
    compileStep: { mode: "run-command", command: "java", args: [] },
    requiredEnvKeys: ["JAVA_HOME"],
  },
  {
    name: "kotlin",
    aliases: ["kotlin"],
    extension: ".kts",
    versionFlag: "-version",
    candidates: { win32: ["kotlin"], unix: ["kotlin"] },
    commandBuilder: "compiled",
    compileStep: { mode: "run-command", command: "kotlin", args: [] },
    requiredEnvKeys: ["KOTLIN_HOME"],
  },
  {
    name: "rust",
    aliases: ["rustc"],
    extension: ".rs",
    versionFlag: "--version",
    candidates: { win32: ["rustc"], unix: ["rustc"] },
    commandBuilder: "compiled",
    compileStep: { mode: "compile-then-execute", command: "rustc", args: ["$CODE", "-o", "$OUT"] },
  },
  {
    name: "c",
    aliases: ["gcc", "cc"],
    extension: ".c",
    versionFlag: "--version",
    candidates: { win32: ["gcc"], unix: ["gcc", "cc"] },
    commandBuilder: "compiled",
    compileStep: { mode: "compile-then-execute", command: "gcc", args: ["$CODE", "-o", "$OUT"] },
  },
  {
    name: "cpp",
    aliases: ["g++", "c++"],
    extension: ".cpp",
    versionFlag: "--version",
    candidates: { win32: ["g++"], unix: ["g++", "c++"] },
    commandBuilder: "compiled",
    compileStep: { mode: "compile-then-execute", command: "g++", args: ["$CODE", "-o", "$OUT"] },
  },
  {
    name: "csharp",
    aliases: ["dotnet-script"],
    extension: ".csx",
    versionFlag: "--version",
    candidates: { win32: ["dotnet-script"], unix: ["dotnet-script"] },
    commandBuilder: "compiled",
    compileStep: { mode: "run-command", command: "dotnet-script", args: [] },
    requiredEnvKeys: ["DOTNET_ROOT"],
  },
];

export const RUNTIME_NAMES = RUNTIME_TABLE.map(e => e.name) as [string, ...string[]];

const IS_WINDOWS = process.platform === "win32";

const detectionCache = new Map<string, RuntimeDetectionResult>();

function getCached(name: string): RuntimeDetectionResult | undefined {
  return detectionCache.get(name);
}

function setCached(name: string, result: RuntimeDetectionResult): void {
  detectionCache.set(name, result);
}

export function clearDetectionCache(): void {
  detectionCache.clear();
}

function buildAliasMap(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const entry of RUNTIME_TABLE) {
    const aliases = new Set<string>();
    for (const alias of entry.aliases) {
      aliases.add(alias.toLowerCase());
      if (IS_WINDOWS) {
        const lower = alias.toLowerCase();
        if (!lower.endsWith(".exe")) {
          aliases.add(`${lower}.exe`);
        }
      }
    }
    map.set(entry.name, aliases);
  }
  return map;
}

const RUNTIME_EXECUTABLE_ALIASES = buildAliasMap();

function shellEscape(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

export function normalizeExecutableName(executable: string): string {
  const trimmed = executable.replace(/^["']|["']$/g, "");
  const normalized = trimmed.replace(/\\/g, "/");
  return basename(normalized).toLowerCase();
}

export function isExecutableCompatibleWithRuntime(runtime: string, executable: string): boolean {
  const aliases = RUNTIME_EXECUTABLE_ALIASES.get(runtime);
  if (!aliases) return false;
  return aliases.has(normalizeExecutableName(executable));
}

function resolveExecutable(name: string): string | undefined {
  try {
    const [prog, ...args] = IS_WINDOWS ? ["where", name] : ["which", name];
    const result = execFileSync(prog, args, { timeout: 5000, encoding: "utf-8" }).trim();
    const firstLine = result.split(/\r?\n/)[0]?.trim();
    return firstLine || undefined;
  } catch {
    return undefined;
  }
}

function getVersion(executable: string, versionFlag: string): string | undefined {
  try {
    const raw = execFileSync(executable, [versionFlag], {
      timeout: 5000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const match = raw.match(/\d+\.\d+[\w.+-]*/);
    return match ? match[0] : raw.split(/\r?\n/)[0]?.trim();
  } catch {
    return undefined;
  }
}

function getExtension(entry: RuntimeTableEntry): string {
  if (typeof entry.extension === "string") return entry.extension;
  return IS_WINDOWS ? entry.extension.win32 : entry.extension.unix;
}

function createDescriptor(entry: RuntimeTableEntry): RuntimeDescriptor {
  const candidates = IS_WINDOWS ? entry.candidates.win32 : entry.candidates.unix;

  return {
    name: entry.name,

    async detect(): Promise<RuntimeDetectionResult> {
      const cached = getCached(entry.name);
      if (cached) return cached;

      for (const candidate of candidates) {
        const path = resolveExecutable(candidate);
        if (path) {
          const version = getVersion(path, entry.versionFlag);
          const result: RuntimeDetectionResult = { available: true, version, path };
          setCached(entry.name, result);
          return result;
        }
      }

      const result: RuntimeDetectionResult = { available: false };
      setCached(entry.name, result);
      return result;
    },

    buildCommand(
      args: string[],
      opts: { codePath?: string; executable?: string },
    ): { executable: string; args: string[] } {
      const exe = opts.executable ?? candidates[0];

      if (entry.commandBuilder === "shell") {
        if (IS_WINDOWS) {
          const cmd = opts.executable ?? "cmd.exe";
          return opts.codePath
            ? { executable: cmd, args: ["/c", opts.codePath, ...args] }
            : { executable: cmd, args: ["/c", ...args] };
        }
        const sh = opts.executable ?? "bash";
        return opts.codePath
          ? { executable: sh, args: [opts.codePath, ...args] }
          : { executable: sh, args: ["-c", args.map(shellEscape).join(" ")] };
      }

      if (entry.commandBuilder === "compiled" && entry.compileStep?.mode === "run-command") {
        const cmd = opts.executable ?? entry.compileStep.command;
        return opts.codePath
          ? { executable: cmd, args: [...entry.compileStep.args, opts.codePath, ...args] }
          : { executable: cmd, args: [...entry.compileStep.args, ...args] };
      }

      if (entry.commandBuilder === "compiled" && entry.compileStep?.mode === "compile-then-execute") {
        if (opts.codePath) {
          const outPath = opts.codePath.replace(/\.[^.]+$/, "") + (IS_WINDOWS ? ".exe" : "");
          const compileArgs = entry.compileStep.args.map(a =>
            a === "$CODE" ? opts.codePath! : a === "$OUT" ? outPath : a,
          );
          return { executable: opts.executable ?? entry.compileStep.command, args: compileArgs };
        }
        return { executable: exe, args };
      }

      return opts.codePath
        ? { executable: exe, args: [opts.codePath, ...args] }
        : { executable: exe, args };
    },
  };
}

const RUNTIME_REGISTRY = new Map<string, RuntimeDescriptor>();
for (const entry of RUNTIME_TABLE) {
  RUNTIME_REGISTRY.set(entry.name, createDescriptor(entry));
}

export function getRuntime(name: string): RuntimeDescriptor | undefined {
  return RUNTIME_REGISTRY.get(name);
}

export function getRegisteredRuntimes(): string[] {
  return [...RUNTIME_REGISTRY.keys()];
}

export async function detectAllRuntimes(): Promise<Map<string, RuntimeDetectionResult>> {
  const results = new Map<string, RuntimeDetectionResult>();
  const entries = [...RUNTIME_REGISTRY.entries()];
  const detected = await Promise.all(entries.map(([, rt]) => rt.detect()));
  for (let i = 0; i < entries.length; i++) {
    results.set(entries[i][0], detected[i]);
  }
  return results;
}

export function getRuntimeTableEntry(name: string): RuntimeTableEntry | undefined {
  return RUNTIME_TABLE.find(e => e.name === name);
}

export function getRuntimeExtension(name: string): string | undefined {
  const entry = RUNTIME_TABLE.find(e => e.name === name);
  if (!entry) return undefined;
  return getExtension(entry);
}

export function getRuntimeRequiredEnvKeys(name: string): string[] {
  const entry = RUNTIME_TABLE.find(e => e.name === name);
  return entry?.requiredEnvKeys ?? [];
}

export function isCompileThenExecute(name: string): boolean {
  const entry = RUNTIME_TABLE.find(e => e.name === name);
  return entry?.compileStep?.mode === "compile-then-execute";
}
