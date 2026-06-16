import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type { LanguageAdapter } from "./adapter/LanguageAdapter.js";
import { registerAdapter } from "./adapter/registry.js";
import { registerGrammarPackageRoot } from "./treesitter/grammarLoader.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const DEFAULT_LANGUAGE_PACK_CACHE_DIR = join(
  homedir(),
  ".sdl-mcp",
  "cache",
  "language-packs",
);

export type LanguagePackInstallMode = "builtin" | "onDemand";

export interface LanguagePackManifest {
  languageId: string;
  aliases: readonly string[];
  extensions: readonly string[];
  parserPackage: string;
  parserPackageSpec: string;
  adapterModule: string;
  installCommand: string;
  lspServerId: string;
  installMode: LanguagePackInstallMode;
}

type AdapterFactoryModule = {
  PhpAdapter?: new () => LanguageAdapter;
  ShellAdapter?: new () => LanguageAdapter;
};

const LANGUAGE_PACKS: readonly LanguagePackManifest[] = [
  {
    languageId: "php",
    aliases: ["php"],
    extensions: [".php", ".phtml"],
    parserPackage: "tree-sitter-php",
    parserPackageSpec: "tree-sitter-php@npm:sdl-mcp-tree-sitter-php@^1.0.1",
    adapterModule: "./adapter/php.js",
    installCommand:
      "npm install --prefix <sdl-cache>/language-packs tree-sitter-php@npm:sdl-mcp-tree-sitter-php@^1.0.1",
    lspServerId: "phpactor",
    installMode: "onDemand",
  },
  {
    languageId: "shell",
    aliases: ["sh", "shell", "bash"],
    extensions: [".sh", ".bash", ".zsh"],
    parserPackage: "tree-sitter-bash",
    parserPackageSpec:
      "tree-sitter-bash@npm:sdl-mcp-tree-sitter-bash@^1.0.1",
    adapterModule: "./adapter/shell.js",
    installCommand:
      "npm install --prefix <sdl-cache>/language-packs tree-sitter-bash@npm:sdl-mcp-tree-sitter-bash@^1.0.1",
    lspServerId: "bash-language-server",
    installMode: "onDemand",
  },
] as const;

const packsByLanguage = new Map<string, LanguagePackManifest>();
for (const pack of LANGUAGE_PACKS) {
  packsByLanguage.set(pack.languageId, pack);
  for (const alias of pack.aliases) {
    packsByLanguage.set(alias, pack);
  }
}

const activatedPacks = new Set<string>();

export function resolveLanguagePack(
  language: string,
): LanguagePackManifest | null {
  return packsByLanguage.get(language.toLowerCase()) ?? null;
}

export function resolveConfiguredLanguagePacks(
  languages: readonly string[],
): LanguagePackManifest[] {
  const resolved = new Map<string, LanguagePackManifest>();
  for (const language of languages) {
    const pack = resolveLanguagePack(language);
    if (pack) resolved.set(pack.languageId, pack);
  }
  return [...resolved.values()];
}

export async function ensureConfiguredLanguagePackAdapters(
  languages: readonly string[],
): Promise<void> {
  for (const pack of resolveConfiguredLanguagePacks(languages)) {
    if (activatedPacks.has(pack.languageId)) continue;
    await ensureLanguagePackParserPackage(pack);
    const adapterFactory = await loadLanguagePackAdapter(pack);
    for (const extension of pack.extensions) {
      registerAdapter(extension, pack.languageId, adapterFactory, "builtin");
    }
    activatedPacks.add(pack.languageId);
  }
}

async function ensureLanguagePackParserPackage(
  pack: LanguagePackManifest,
): Promise<void> {
  const existingPackageRoot = resolveInstalledPackageRoot(pack.parserPackage);
  if (existingPackageRoot) {
    registerGrammarPackageRoot(pack.parserPackage, existingPackageRoot);
    return;
  }

  const cachePackageRoot = cachedPackageRoot(pack.parserPackage);
  if (existsSync(join(cachePackageRoot, "package.json"))) {
    registerGrammarPackageRoot(pack.parserPackage, cachePackageRoot);
    return;
  }

  await mkdir(DEFAULT_LANGUAGE_PACK_CACHE_DIR, { recursive: true });
  const npmBinary = process.platform === "win32" ? "npm.cmd" : "npm";
  try {
    await execFileAsync(
      npmBinary,
      [
        "install",
        "--prefix",
        DEFAULT_LANGUAGE_PACK_CACHE_DIR,
        "--no-audit",
        "--fund=false",
        pack.parserPackageSpec,
      ],
      {
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
    );
  } catch (error) {
    throw new Error(
      `Missing parser package for configured language ${pack.languageId}. ` +
        `Install ${pack.parserPackage} or disable the language. ` +
        `Suggested command: ${pack.installCommand.replace(
          "<sdl-cache>",
          DEFAULT_LANGUAGE_PACK_CACHE_DIR,
        )}. ` +
        `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!existsSync(join(cachePackageRoot, "package.json"))) {
    throw new Error(
      `Installed parser package ${pack.parserPackage} was not found in ${cachePackageRoot}`,
    );
  }
  registerGrammarPackageRoot(pack.parserPackage, cachePackageRoot);
}

function resolveInstalledPackageRoot(packageName: string): string | null {
  try {
    return dirname(require.resolve(`${packageName}/package.json`));
  } catch {
    return null;
  }
}

function cachedPackageRoot(packageName: string): string {
  return join(DEFAULT_LANGUAGE_PACK_CACHE_DIR, "node_modules", packageName);
}

async function loadLanguagePackAdapter(
  pack: LanguagePackManifest,
): Promise<() => LanguageAdapter> {
  const module = (await import(pack.adapterModule)) as AdapterFactoryModule;
  if (pack.languageId === "php" && module.PhpAdapter) {
    return () => new module.PhpAdapter!();
  }
  if (pack.languageId === "shell" && module.ShellAdapter) {
    return () => new module.ShellAdapter!();
  }
  throw new Error(
    `Language pack ${pack.languageId} did not export a compatible adapter. ` +
      `Install ${pack.parserPackage} with: ${pack.installCommand}`,
  );
}
