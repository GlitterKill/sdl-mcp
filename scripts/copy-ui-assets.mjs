import { copyFile, mkdir, readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const root = process.cwd();
const sourceDir = resolve(root, "src", "ui");
const targetDir = resolve(root, "dist", "ui");
const assetExtensions = new Set([".css", ".html", ".js"]);

await mkdir(targetDir, { recursive: true });

const entries = await readdir(sourceDir, { withFileTypes: true });
await Promise.all(
  entries
    .filter((entry) => entry.isFile() && assetExtensions.has(extname(entry.name)))
    .map((entry) => copyFile(join(sourceDir, entry.name), join(targetDir, entry.name))),
);
