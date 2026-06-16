import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type { LanguageAdapter } from "./adapter/LanguageAdapter.js";
import {
  createGenericTreeSitterAdapterFactory,
  type GenericTreeSitterAdapterOptions,
} from "./adapter/generic-tree-sitter.js";
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
const INSTALL_COMMAND_CACHE_PLACEHOLDER = "<sdl-cache>/language-packs";

export type LanguagePackInstallMode = "builtin" | "onDemand";

export interface LanguagePackManifest {
  languageId: string;
  aliases: readonly string[];
  extensions: readonly string[];
  parserPackage: string;
  parserPackageSpec: string;
  adapterModule?: string;
  genericAdapter?: GenericTreeSitterAdapterOptions;
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
      "npm install --prefix <sdl-cache>/language-packs --legacy-peer-deps tree-sitter-php@npm:sdl-mcp-tree-sitter-php@^1.0.1",
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
      "npm install --prefix <sdl-cache>/language-packs --legacy-peer-deps tree-sitter-bash@npm:sdl-mcp-tree-sitter-bash@^1.0.1",
    lspServerId: "bash-language-server",
    installMode: "onDemand",
  },
  {
    languageId: "powershell",
    aliases: ["powershell", "pwsh", "ps1", "psm1", "psd1"],
    extensions: [".ps1", ".psm1", ".psd1"],
    parserPackage: "tree-sitter-powershell",
    parserPackageSpec: "tree-sitter-powershell@^0.26.4",
    genericAdapter: {
      languageId: "powershell",
      grammarLanguage: "powershell",
      fileExtensions: [".ps1", ".psm1", ".psd1"],
      symbolRules: [
        {
          nodeTypes: [
            "function_statement",
            "function_definition",
            "function_declaration",
          ],
          kind: "function",
        },
        {
          nodeTypes: [
            "class_statement",
            "class_definition",
            "class_declaration",
          ],
          kind: "class",
        },
      ],
    },
    installCommand:
      "npm install --prefix <sdl-cache>/language-packs --legacy-peer-deps tree-sitter-powershell@^0.26.4",
    lspServerId: "powershell-editor-services",
    installMode: "onDemand",
  },
  {
    languageId: "ruby",
    aliases: ["ruby", "rb", "rake"],
    extensions: [".rb", ".rake"],
    parserPackage: "tree-sitter-ruby",
    parserPackageSpec: "tree-sitter-ruby@^0.23.1",
    genericAdapter: {
      languageId: "ruby",
      grammarLanguage: "ruby",
      fileExtensions: [".rb", ".rake"],
      symbolRules: [
        { nodeTypes: ["class"], kind: "class" },
        { nodeTypes: ["module"], kind: "module" },
        { nodeTypes: ["method", "singleton_method"], kind: "method" },
      ],
    },
    installCommand:
      "npm install --prefix <sdl-cache>/language-packs --legacy-peer-deps tree-sitter-ruby@^0.23.1",
    lspServerId: "ruby-lsp",
    installMode: "onDemand",
  },
  {
    languageId: "lua",
    aliases: ["lua"],
    extensions: [".lua"],
    parserPackage: "tree-sitter-lua",
    parserPackageSpec: "tree-sitter-lua@^2.1.3",
    genericAdapter: {
      languageId: "lua",
      grammarLanguage: "lua",
      fileExtensions: [".lua"],
      symbolRules: [
        {
          nodeTypes: [
            "function_declaration",
            "function_definition",
            "local_function",
          ],
          kind: "function",
        },
      ],
    },
    installCommand:
      "npm install --prefix <sdl-cache>/language-packs --legacy-peer-deps tree-sitter-lua@^2.1.3",
    lspServerId: "lua-language-server",
    installMode: "onDemand",
  },
  {
    languageId: "dart",
    aliases: ["dart"],
    extensions: [".dart"],
    parserPackage: "tree-sitter-dart",
    parserPackageSpec: "tree-sitter-dart@^1.0.0",
    genericAdapter: {
      languageId: "dart",
      grammarLanguage: "dart",
      fileExtensions: [".dart"],
      symbolRules: [
        { nodeTypes: ["class_definition"], kind: "class" },
        {
          nodeTypes: [
            "mixin_declaration",
            "enum_declaration",
            "extension_declaration",
            "typedef",
          ],
          kind: "type",
        },
        {
          nodeTypes: ["function_signature", "function_body"],
          kind: "function",
        },
      ],
    },
    installCommand:
      "npm install --prefix <sdl-cache>/language-packs --legacy-peer-deps tree-sitter-dart@^1.0.0",
    lspServerId: "dart-sdk-lsp",
    installMode: "onDemand",
  },
  {
    languageId: "swift",
    aliases: ["swift"],
    extensions: [".swift"],
    parserPackage: "tree-sitter-swift",
    parserPackageSpec: "tree-sitter-swift@^0.7.1",
    genericAdapter: {
      languageId: "swift",
      grammarLanguage: "swift",
      fileExtensions: [".swift"],
      symbolRules: [
        {
          nodeTypes: [
            "class_declaration",
            "struct_declaration",
            "actor_declaration",
          ],
          kind: "class",
        },
        { nodeTypes: ["protocol_declaration"], kind: "interface" },
        {
          nodeTypes: ["enum_declaration", "extension_declaration"],
          kind: "type",
        },
        { nodeTypes: ["function_declaration"], kind: "function" },
      ],
    },
    installCommand:
      "npm install --prefix <sdl-cache>/language-packs --legacy-peer-deps tree-sitter-swift@^0.7.1",
    lspServerId: "sourcekit-lsp",
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
  const npmInstall = createNpmInstallCommand(pack);
  try {
    await execFileAsync(npmInstall.command, npmInstall.args, {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      `Missing parser package for configured language ${pack.languageId}. ` +
        `Install ${pack.parserPackage} or disable the language. ` +
        `Suggested command: ${formatInstallCommand(pack)}. ` +
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

function createNpmInstallCommand(pack: LanguagePackManifest): {
  command: string;
  args: string[];
} {
  const args = [
    "install",
    "--prefix",
    DEFAULT_LANGUAGE_PACK_CACHE_DIR,
    "--no-audit",
    "--fund=false",
    "--legacy-peer-deps",
    pack.parserPackageSpec,
  ];
  if (process.platform !== "win32") {
    return { command: "npm", args };
  }

  // Windows nvm installs expose npm through .cmd/.ps1 shims. Node's execFile can
  // fail on those shims with spawn EINVAL, so route through cmd.exe explicitly.
  return { command: "cmd.exe", args: ["/d", "/s", "/c", "npm.cmd", ...args] };
}

function formatInstallCommand(pack: LanguagePackManifest): string {
  return pack.installCommand
    .replace(INSTALL_COMMAND_CACHE_PLACEHOLDER, DEFAULT_LANGUAGE_PACK_CACHE_DIR)
    .replace("<sdl-cache>", dirname(DEFAULT_LANGUAGE_PACK_CACHE_DIR));
}

async function loadLanguagePackAdapter(
  pack: LanguagePackManifest,
): Promise<() => LanguageAdapter> {
  if (pack.genericAdapter) {
    return createGenericTreeSitterAdapterFactory(pack.genericAdapter);
  }
  if (!pack.adapterModule) {
    throw new Error(
      `Language pack ${pack.languageId} does not declare an adapter module. ` +
        `Install ${pack.parserPackage} with: ${pack.installCommand}`,
    );
  }

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
