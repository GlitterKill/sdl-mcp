import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export async function extractClaudeSessionUsage({ sessionDir }) {
  const files = await findJsonlFiles(sessionDir);
  let input = 0;
  let output = 0;
  let total = 0;

  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === "usage" && entry.usage) {
          input += entry.usage.input_tokens ?? 0;
          output += entry.usage.output_tokens ?? 0;
          total += entry.usage.total_tokens ?? (input + output);
        }
      } catch {
        continue;
      }
    }
  }

  return {
    input,
    output,
    total: total || input + output,
    tokenizerSource: "claude-session",
    sessionFiles: files,
  };
}

async function findJsonlFiles(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        files.push(...await findJsonlFiles(path));
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(path);
      }
    }
    return files;
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}
