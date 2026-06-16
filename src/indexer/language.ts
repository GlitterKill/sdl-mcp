import { extname } from "node:path";

import { getLanguageIdForExtension } from "./adapter/registry.js";
import { normalizePath } from "../util/paths.js";

const LANGUAGE_ALIASES = new Map<string, string>([
  ["typescript", "typescript"],
  ["typescriptreact", "typescript"],
  ["ts", "typescript"],
  ["tsx", "typescript"],
  // Internal graph language is the adapter/resolver key, not a display label.
  // JavaScript files are parsed by the TypeScript adapter in this codebase.
  ["javascript", "typescript"],
  ["javascriptreact", "typescript"],
  ["js", "typescript"],
  ["jsx", "typescript"],
  ["mjs", "typescript"],
  ["cjs", "typescript"],
  ["python", "python"],
  ["py", "python"],
  ["pyw", "python"],
  ["go", "go"],
  ["golang", "go"],
  ["java", "java"],
  ["rust", "rust"],
  ["rs", "rust"],
  ["csharp", "csharp"],
  ["c#", "csharp"],
  ["c-sharp", "csharp"],
  ["cs", "csharp"],
  ["cpp", "cpp"],
  ["c++", "cpp"],
  ["cxx", "cpp"],
  ["cc", "cpp"],
  ["hpp", "cpp"],
  ["hxx", "cpp"],
  ["hh", "cpp"],
  ["c", "c"],
  ["h", "c"],
  ["kotlin", "kotlin"],
  ["kt", "kotlin"],
  ["kts", "kotlin"],
  ["php", "php"],
  ["phtml", "php"],
  ["shell", "shell"],
  ["shellscript", "shell"],
  ["bash", "shell"],
  ["sh", "shell"],
  ["zsh", "shell"],
  ["powershell", "powershell"],
  ["pwsh", "powershell"],
  ["ps1", "powershell"],
  ["psm1", "powershell"],
  ["psd1", "powershell"],
  ["ruby", "ruby"],
  ["rb", "ruby"],
  ["rake", "ruby"],
  ["lua", "lua"],
  ["dart", "dart"],
  ["swift", "swift"],
  ["groovy", "groovy"],
  ["gradle", "groovy"],
  ["perl", "perl"],
  ["pl", "perl"],
  ["pm", "perl"],
  ["r", "r"],
  ["rstats", "r"],
  ["elixir", "elixir"],
  ["ex", "elixir"],
  ["exs", "elixir"],
  ["fsharp", "fsharp"],
  ["f#", "fsharp"],
  ["fs", "fsharp"],
  ["fsi", "fsharp"],
  ["fsx", "fsharp"],
  ["fortran", "fortran"],
  ["f90", "fortran"],
  ["f95", "fortran"],
  ["f03", "fortran"],
  ["f08", "fortran"],
  ["f77", "fortran"],
  ["haskell", "haskell"],
  ["hs", "haskell"],
  ["lhs", "haskell"],
]);

export function inferLanguageIdFromPath(relPath: string): string {
  const ext = extname(normalizePath(relPath)).toLowerCase();
  return getLanguageIdForExtension(ext) ?? "unknown";
}

export function canonicalizeLanguageId(
  language: string | null | undefined,
  relPath?: string | null,
): string {
  const pathLanguage = relPath ? inferLanguageIdFromPath(relPath) : "unknown";
  const raw = language?.trim();
  if (!raw || raw.toLowerCase() === "unknown") {
    return pathLanguage;
  }

  const normalized = raw.toLowerCase().replace(/^\./, "");
  if (normalized === "external") return "external";

  const alias = LANGUAGE_ALIASES.get(normalized);
  if (alias) return alias;

  return pathLanguage !== "unknown" ? pathLanguage : normalized;
}
