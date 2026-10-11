import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

it("syncs release requirements without relabeling resolved registry artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "sdl-version-sync-"));
  const previous = "1.2.2";
  const next = "1.2.3";
  const nativeName = "sdl-mcp-native-win32-x64-msvc";
  const watchmanName = "sdl-mcp-watchman-win32-x64";
  const requirements = { "sdl-mcp-native": previous, "sdl-mcp-watchman": previous, [watchmanName]: previous };
  const native = { name: "sdl-mcp-native", version: previous, optionalDependencies: { [nativeName]: previous } };
  const watchman = { name: "sdl-mcp-watchman", version: previous, optionalDependencies: { [watchmanName]: previous } };
  const packages = Object.fromEntries([native, watchman, { name: nativeName, version: previous }, { name: watchmanName, version: previous }].map(pkg => [
    `node_modules/${pkg.name}`,
    { ...pkg, resolved: `https://registry.npmjs.org/${pkg.name}/-/${pkg.name}-${previous}.tgz`, integrity: "sha512-fixture-integrity", optional: true },
  ]));
  const writeJson = (path: string, value: unknown) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify(value, null, 2) + "\n");
  };
  const readJson = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));
  try {
    writeJson("package.json", { version: next, optionalDependencies: requirements });
    writeJson("native/package.json", native);
    writeJson("native/npm/win32-x64-msvc/package.json", { name: nativeName, version: previous });
    writeJson("watchman/package.json", watchman);
    writeJson("watchman/npm/win32-x64/package.json", { name: watchmanName, version: previous });
    writeJson("packages/create-sdl-mcp/package.json", { version: previous });
    writeJson("package-lock.json", { lockfileVersion: 3, packages: { "": { optionalDependencies: requirements }, ...packages } });
    mkdirSync(join(root, "scripts"));
    copyFileSync(fileURLToPath(new URL("../../scripts/sync-native-version.mjs", import.meta.url)), join(root, "scripts/sync-native-version.mjs"));
    execFileSync(process.execPath, [join(root, "scripts/sync-native-version.mjs"), next], { cwd: root });

    const lock = readJson("package-lock.json");
    for (const [path, entry] of Object.entries(packages)) {
      assert.deepEqual(lock.packages[path], entry, `${path} must retain its complete verified artifact metadata until npm resolves the published version`);
    }
    for (const name of Object.keys(requirements)) {
      assert.equal(readJson("package.json").optionalDependencies[name], next);
      assert.equal(lock.packages[""].optionalDependencies[name], next);
    }
    assert.equal(readJson("native/package.json").optionalDependencies[nativeName], next);
    assert.equal(readJson("watchman/package.json").optionalDependencies[watchmanName], next);
    assert.equal(readJson("native/npm/win32-x64-msvc/package.json").version, next);
    assert.equal(readJson("watchman/npm/win32-x64/package.json").version, next);
    assert.equal(readJson("packages/create-sdl-mcp/package.json").version, next);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
