import { copyFile, cp, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const root = process.cwd();
const targetDir = resolve(root, "dist", "ui", "vendor");

async function copyOne(from, to) {
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
}

await copyOne(
  resolve(root, "node_modules", "three", "build", "three.module.min.js"),
  join(targetDir, "three.module.min.js"),
);

await copyOne(
  resolve(root, "node_modules", "three", "build", "three.core.min.js"),
  join(targetDir, "three.core.min.js"),
);

for (const dir of ["controls", "loaders", "utils"]) {
  await cp(
    resolve(root, "node_modules", "three", "examples", "jsm", dir),
    join(targetDir, "jsm", dir),
    { recursive: true },
  );
}

await copyOne(
  resolve(root, "node_modules", "fflate", "esm", "browser.js"),
  join(targetDir, "fflate.js"),
);
