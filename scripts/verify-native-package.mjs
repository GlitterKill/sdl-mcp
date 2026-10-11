import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const root = realpathSync(resolve(process.argv[2] ?? "."));
const expectedVersion = process.argv[3];
for (const key of ["SDL_MCP_NATIVE_ADDON_PATH", "SDL_LADYBUG_WINDOWS_FTS_NATIVE_ADDON_PATH", "SDL_MCP_DISABLE_NATIVE_ADDON", "NODE_PATH"]) {
  assert.ok(!process.env[key], `packed verification forbids ${key}`);
}
const require = createRequire(join(root, "package.json"));
function inside(path, parent) {
  const rel = relative(realpathSync(parent), realpathSync(path));
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
const manifestPath = require.resolve("sdl-mcp-native/package.json");
assert.ok(inside(manifestPath, join(root, "node_modules")), "umbrella must be installed inside the clean consumer");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (expectedVersion) assert.equal(manifest.version, expectedVersion);
const addon = require("sdl-mcp-native");
const required = ["parseFiles", "parseFilesAsync", "parseContent", "parserIdentityContractVersion", "hashContentNative", "generateSymbolIdNative"];
if (process.platform === "win32") required.push("preloadWindowsLibrary", "releaseWindowsLibrary");
for (const name of required) assert.equal(typeof addon[name], "function", `umbrella package missing ${name}`);
assert.equal(addon.parserIdentityContractVersion(), 1, "unsupported parser identity contract");
const binaries = Object.keys(require.cache).filter(path => path.endsWith(".node") && inside(path, join(root, "node_modules")));
assert.equal(binaries.length, 1, "exactly one installed native binary must be loaded");
const binaryPath = binaries[0];
assert.ok(!inside(binaryPath, dirname(manifestPath)), "must use the platform dependency, not an umbrella-local binary");
const platformManifest = JSON.parse(readFileSync(join(dirname(binaryPath), "package.json"), "utf8"));
assert.equal(manifest.optionalDependencies[platformManifest.name], manifest.version);
assert.equal(platformManifest.version, manifest.version);
const raw = require(binaryPath);
for (const name of required) assert.equal(addon[name], raw[name], `${name} must forward the packaged binding`);

const relPath = "native-package-fixture.js";
const absolutePath = join(root, relPath);
const content = "export function greet(name) { return name; }\n";
const input = { repoId: "package-contract", relPath, language: "js", content };
// This file belongs to the disposable consumer, not the source checkout.
mkdirSync(root, { recursive: true });
writeFileSync(absolutePath, content, { flag: "wx" });
try {
  const pending = addon.parseContent(input);
  assert.equal(typeof pending?.then, "function", "content parser must be asynchronous");
  const parsed = await pending;
  assert.equal(parsed.parseError, undefined);
  assert.equal(parsed.contentHash, createHash("sha256").update(content).digest("hex"));
  assert.equal(parsed.content, content);
  assert.equal(parsed.relPath, relPath);
  const symbol = parsed.symbols.find(item => item.name === "greet");
  assert.ok(symbol?.nodeId && symbol.symbolId && symbol.astFingerprint);
  assert.equal(symbol.symbolId, addon.generateSymbolIdNative(input.repoId, relPath, symbol.kind, symbol.name, symbol.astFingerprint));
  const files = [{ repoId: input.repoId, relPath, language: input.language, absolutePath }];
  assert.deepEqual(addon.parseFiles(files, 1), [parsed]);
  const batch = addon.parseFilesAsync(files, 1);
  assert.equal(typeof batch?.then, "function", "batch parser must be asynchronous");
  assert.deepEqual(await batch, [parsed]);
  console.log(JSON.stringify({ packageVersion: manifest.version, platformPackage: platformManifest.name, binaryPath, binarySha256: createHash("sha256").update(readFileSync(binaryPath)).digest("hex"), parserContract: "native:1", exports: required, contentDiskAsyncParity: true, localAddonOverride: false }));
} finally {
  rmSync(absolutePath);
}
