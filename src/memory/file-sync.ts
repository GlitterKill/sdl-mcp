/**
 * file-sync.ts - File-backed memory storage (.sdl-memory/ directory)
 * Reads and writes memory files with YAML frontmatter + markdown body.
 * Uses simple regex parser — no external YAML dependency.
 */
import fs from "node:fs";
import path from "node:path";
import { normalizePath } from "../util/paths.js";

export interface MemoryFileData {
  memoryId: string;
  type: string;
  title: string;
  content: string;
  tags: string[];
  confidence: number;
  symbols: string[];
  files: string[];
  createdAt: string;
  deleted: boolean;
}

/** Map memory type to subdirectory name */
function typeToDir(type: string): string {
  switch (type) {
    case "decision":
      return "decisions";
    case "bugfix":
      return "bugfixes";
    case "task_context":
      return "task_context";
    default:
      return type;
  }
}

/** Serialize a string array to YAML inline format: [a, b, c] */
function serializeYamlArray(arr: string[]): string {
  if (arr.length === 0) return "[]";
  return `[${arr.join(", ")}]`;
}

/** Parse a YAML inline array string: [a, b, c] → ["a", "b", "c"] */
function parseYamlArray(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed === "[]" || trimmed === "") return [];
  const match = trimmed.match(/^\[(.*)\]$/s);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s.replace(/^["']|["']$/g, ""));
}

/** Serialize memory data to YAML frontmatter + markdown body */
function serializeMemoryFile(data: MemoryFileData): string {
  const lines = [
    "---",
    `memoryId: ${data.memoryId}`,
    `type: ${data.type}`,
    `title: ${escapeYamlString(data.title)}`,
    `tags: ${serializeYamlArray(data.tags)}`,
    `confidence: ${data.confidence}`,
    `symbols: ${serializeYamlArray(data.symbols)}`,
    `files: ${serializeYamlArray(data.files)}`,
    `createdAt: ${data.createdAt}`,
    `deleted: ${data.deleted}`,
    "---",
    "",
  ];

  return lines.join("\n") + data.content;
}

/** Escape a YAML string value if it contains special chars */
function escapeYamlString(value: string): string {
  if (/[:#\[\]{}&*!|>'"%@`]/.test(value) || value.includes("\n")) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

/**
 * Write a memory to `.sdl-memory/<type>/<memoryId>.md`
 * Uses atomic write (temp file + rename).
 * @returns Relative path to the file from repoRoot (forward slashes).
 */
export async function writeMemoryFile(
  repoRoot: string,
  memory: MemoryFileData,
): Promise<string> {
  const subDir = typeToDir(memory.type);
  const dirPath = path.join(repoRoot, ".sdl-memory", subDir);
  const filePath = path.join(dirPath, `${memory.memoryId}.md`);
  const tmpPath = path.join(dirPath, `${memory.memoryId}.md.tmp`);

  fs.mkdirSync(dirPath, { recursive: true });

  const content = serializeMemoryFile(memory);
  fs.writeFileSync(tmpPath, content, "utf-8");
  fs.renameSync(tmpPath, filePath);

  const relPath = path.relative(repoRoot, filePath);
  return normalizePath(relPath);
}

/**
 * Read and parse a `.sdl-memory/*.md` file.
 * @returns Parsed data, or null if file doesn't exist or has malformed frontmatter.
 */
export async function readMemoryFile(
  filePath: string,
): Promise<MemoryFileData | null> {
  try {
    let raw = fs.readFileSync(filePath, "utf-8");
    // Strip BOM
    if (raw.charCodeAt(0) === 0xfeff) {
      raw = raw.slice(1);
    }

    return parseMemoryFileContent(raw);
  } catch {
    return null;
  }
}

/**
 * Parse raw file content into MemoryFileData.
 * Exported for testing.
 */
export function parseMemoryFileContent(raw: string): MemoryFileData | null {
  // Split on --- delimiters
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!fmMatch) {
    console.warn("Malformed frontmatter: missing --- delimiters");
    return null;
  }

  const frontmatterBlock = fmMatch[1];
  const bodyContent = fmMatch[2].trim();

  const fields = new Map<string, string>();
  for (const line of frontmatterBlock.split(/\r?\n/)) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    fields.set(key, value);
  }

  const memoryId = fields.get("memoryId");
  const type = fields.get("type");
  if (!memoryId || !type) {
    console.warn("Malformed frontmatter: missing memoryId or type");
    return null;
  }

  const title = unescapeYamlString(fields.get("title") ?? "");
  const confidence = parseFloat(fields.get("confidence") ?? "0.8");
  const createdAt = fields.get("createdAt") ?? new Date().toISOString();
  const deletedStr = fields.get("deleted") ?? "false";
  const deleted = deletedStr === "true";

  return {
    memoryId,
    type,
    title,
    content: bodyContent,
    tags: parseYamlArray(fields.get("tags") ?? "[]"),
    confidence: isNaN(confidence) ? 0.8 : confidence,
    symbols: parseYamlArray(fields.get("symbols") ?? "[]"),
    files: parseYamlArray(fields.get("files") ?? "[]"),
    createdAt,
    deleted,
  };
}

/** Unescape a YAML-quoted string */
function unescapeYamlString(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return value;
}

/**
 * Scan .sdl-memory directory for *.md files recursively.
 * @returns Absolute file paths, or empty array if directory doesn't exist.
 */
export async function scanMemoryFiles(repoRoot: string): Promise<string[]> {
  const memDir = path.join(repoRoot, ".sdl-memory");

  if (!fs.existsSync(memDir)) {
    return [];
  }

  const results: string[] = [];
  scanDirRecursive(memDir, results);
  return results;
}

function scanDirRecursive(dir: string, results: string[]): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDirRecursive(fullPath, results);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }
}

/**
 * Delete a backing file.
 * @returns true if file existed and was deleted.
 */
export async function deleteMemoryFile(
  repoRoot: string,
  type: string,
  memoryId: string,
): Promise<boolean> {
  const subDir = typeToDir(type);
  const filePath = path.join(repoRoot, ".sdl-memory", subDir, `${memoryId}.md`);

  if (!fs.existsSync(filePath)) {
    return false;
  }

  fs.unlinkSync(filePath);
  return true;
}

/**
 * Update specific frontmatter fields in a memory file without changing the body.
 */
export async function updateMemoryFileFrontmatter(
  filePath: string,
  updates: Partial<Pick<MemoryFileData, "deleted" | "confidence" | "tags">>,
): Promise<void> {
  const data = await readMemoryFile(filePath);
  if (!data) return;

  if (updates.deleted !== undefined) data.deleted = updates.deleted;
  if (updates.confidence !== undefined) data.confidence = updates.confidence;
  if (updates.tags !== undefined) data.tags = updates.tags;

  const content = serializeMemoryFile(data);
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, content, "utf-8");
  fs.renameSync(tmpPath, filePath);
}
