import { spawnSync } from "node:child_process";
import { platform } from "node:os";

export interface LspRecommendation {
  language: string;
  command: string;
  installCommand?: string[];
  manualCommand: string;
  safeAutoInstall: boolean;
}

const LSP_REGISTRY: Record<string, LspRecommendation> = {
  ts: {
    language: "TypeScript/JavaScript",
    command: "typescript-language-server",
    installCommand: ["npm", "install", "-g", "typescript", "typescript-language-server"],
    manualCommand: "npm install -g typescript typescript-language-server",
    safeAutoInstall: true,
  },
  js: {
    language: "TypeScript/JavaScript",
    command: "typescript-language-server",
    installCommand: ["npm", "install", "-g", "typescript", "typescript-language-server"],
    manualCommand: "npm install -g typescript typescript-language-server",
    safeAutoInstall: true,
  },
  py: {
    language: "Python",
    command: "pyright-langserver",
    installCommand: ["npm", "install", "-g", "pyright"],
    manualCommand: "npm install -g pyright",
    safeAutoInstall: true,
  },
  go: {
    language: "Go",
    command: "gopls",
    installCommand: ["go", "install", "golang.org/x/tools/gopls@latest"],
    manualCommand: "go install golang.org/x/tools/gopls@latest",
    safeAutoInstall: true,
  },
  rs: {
    language: "Rust",
    command: "rust-analyzer",
    installCommand: ["rustup", "component", "add", "rust-analyzer"],
    manualCommand: "rustup component add rust-analyzer",
    safeAutoInstall: true,
  },
  cpp: {
    language: "C/C++",
    command: "clangd",
    manualCommand: "Install clangd with your platform package manager, then ensure clangd is on PATH.",
    safeAutoInstall: false,
  },
  c: {
    language: "C/C++",
    command: "clangd",
    manualCommand: "Install clangd with your platform package manager, then ensure clangd is on PATH.",
    safeAutoInstall: false,
  },
  java: {
    language: "Java",
    command: "jdtls",
    manualCommand: "Install JDTLS from Eclipse and ensure jdtls is on PATH.",
    safeAutoInstall: false,
  },
};

export function lspRecommendationForLanguage(language: string): LspRecommendation | undefined {
  return LSP_REGISTRY[language];
}

export function isCommandAvailable(command: string): boolean {
  const checker = platform() === "win32" ? "where" : "command";
  const args = platform() === "win32" ? [command] : ["-v", command];
  return spawnSync(checker, args, { stdio: "ignore", shell: platform() !== "win32" }).status === 0;
}

export function missingLspManualCommands(languages: readonly string[]): string[] {
  const commands = new Set<string>();
  for (const language of languages) {
    const recommendation = lspRecommendationForLanguage(language);
    if (recommendation && !isCommandAvailable(recommendation.command)) {
      commands.add(recommendation.manualCommand);
    }
  }
  return [...commands];
}
