import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";

const root = process.cwd();
const sourceDir = resolve(root, "src", "ui");
const targetDir = resolve(root, "dist", "ui");
const assetExtensions = new Set([".css", ".html", ".js"]);

await mkdir(targetDir, { recursive: true });

async function copyAssets(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const sourcePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await copyAssets(sourcePath);
        return;
      }
      if (!entry.isFile() || !assetExtensions.has(extname(entry.name))) {
        return;
      }
      const targetPath = join(targetDir, relative(sourceDir, sourcePath));
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
    }),
  );
}

await copyAssets(sourceDir);
