import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve, sep as pathSep } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SDL_LINK_LINE =
  "> Optimized tool-use workflow for agents: see [SDL.md](./SDL.md).";

// Regex anchored on the actual markdown link form, so unrelated mentions of
// "SDL.md" in prose / code blocks don't suppress the append, and a missing
// link is always restored.
const SDL_LINK_REGEX = /\]\(\.\/SDL\.md\)/;

const ROOT_AGENT_DOCS = [
  ["AGENTS.md", "AGENTS.md.template"],
  ["CLAUDE.md", "CLAUDE.md.template"],
] as const;

const CLIENT_MD_FILES = [
  "CLAUDE.md",
  "AGENTS.md",
  "CODEX.md",
  "GEMINI.md",
  "OPENCODE.md",
] as const;

function templatesDir(): string {
  return resolve(__dirname, "../../../templates");
}

function isInsideDir(candidate: string, dir: string): boolean {
  if (candidate === dir) {
    return true;
  }
  const prefix = dir.endsWith(pathSep) ? dir : dir + pathSep;
  return candidate.startsWith(prefix);
}

function readTemplateText(name: string): string {
  const dir = templatesDir();
  const path = resolve(dir, name);
  if (!isInsideDir(path, dir)) {
    throw new Error("Template path traversal detected");
  }
  return readFileSync(path, "utf-8");
}

function renderTemplateText(
  name: string,
  values: Record<string, string>,
): string {
  let rendered = readTemplateText(name);
  for (const [key, value] of Object.entries(values)) {
    rendered = rendered.replaceAll("{{" + key + "}}", value);
  }
  return rendered;
}

function detectNewline(body: string): string {
  // Preserve whatever line ending the existing file uses so Windows CRLF
  // files don't end up with a mixed LF tail after append.
  return body.includes("\r\n") ? "\r\n" : "\n";
}

function writeIfMissing(path: string, content: string): boolean {
  if (existsSync(path)) {
    return false;
  }
  mkdirSync(dirname(path), { recursive: true });
  const body = content.endsWith("\n") ? content : `${content}\n`;
  writeFileSync(path, body, "utf-8");
  return true;
}

function appendSdlLinkIfMissing(path: string): boolean {
  const body = readFileSync(path, "utf-8");
  if (SDL_LINK_REGEX.test(body)) {
    return false;
  }
  const nl = detectNewline(body);
  const trimmed = body.replace(/(\r?\n)+$/, "");
  const next = `${trimmed}${nl}${nl}${SDL_LINK_LINE}${nl}`;
  writeFileSync(path, next, "utf-8");
  return true;
}

/**
 * Ensure the baseline SDL-MCP enforcement assets are present in a repo root.
 *
 * - Always drops `SDL.md` (from `templates/SDL.md`) if missing.
 * - Creates missing root `AGENTS.md` / `CLAUDE.md` docs from templates.
 * - If any recognized root agent doc already exists, ensures the SDL.md
 *   markdown link is present (appending if absent).
 *
 * Returns the list of absolute paths written or modified.
 */
export function ensureBaselineEnforcementAssets(
  repoRoot: string,
  repoId: string,
): string[] {
  const touched: string[] = [];

  const sdlPath = join(repoRoot, "SDL.md");
  if (writeIfMissing(sdlPath, readTemplateText("SDL.md"))) {
    touched.push(sdlPath);
  }

  const createdRootDocs = new Set<string>();
  for (const [name, template] of ROOT_AGENT_DOCS) {
    const p = join(repoRoot, name);
    if (writeIfMissing(p, renderTemplateText(template, { REPO_ID: repoId }))) {
      touched.push(p);
      createdRootDocs.add(name);
    }
  }

  const existingClientMd = CLIENT_MD_FILES.filter(
    (name) => !createdRootDocs.has(name) && existsSync(join(repoRoot, name)),
  );

  for (const name of existingClientMd) {
    const p = join(repoRoot, name);
    if (appendSdlLinkIfMissing(p)) {
      touched.push(p);
    }
  }

  return touched;
}
