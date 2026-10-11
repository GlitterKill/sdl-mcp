import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { version: { type: "string" }, output: { type: "string" }, contract: { type: "string" } } });
assert.ok(values.version && values.output && values.contract);
const expected = JSON.parse(readFileSync(values.contract, "utf8"));
assert.equal(expected.packageVersion, values.version);
const output = resolve(values.output);
assert.ok(!existsSync(output), "registry consumer must be fresh");
mkdirSync(output, { recursive: true });
writeFileSync(join(output, "package.json"), JSON.stringify({ name: "native-registry-contract-consumer", version: "1.0.0", private: true }));
const env = { ...process.env };
for (const key of ["SDL_MCP_NATIVE_ADDON_PATH", "SDL_LADYBUG_WINDOWS_FTS_NATIVE_ADDON_PATH", "SDL_MCP_DISABLE_NATIVE_ADDON", "NODE_PATH", "NODE_OPTIONS"]) delete env[key];
const npmCli = [process.env.npm_execpath, join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"), resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js")].find(path => path && existsSync(path));
assert.ok(npmCli);
function run(args, name) {
  const result = spawnSync(process.execPath, args, { cwd: output, env, encoding: "utf8", windowsHide: true });
  writeFileSync(join(output, name), (result.stdout ?? "") + (result.stderr ?? ""));
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${name} failed; inspect registry evidence`);
  return result.stdout;
}
run([npmCli, "install", "--ignore-scripts", "--no-fund", `sdl-mcp-native@${values.version}`], "registry-install.log");
const actual = JSON.parse(run([join(dirname(fileURLToPath(import.meta.url)), "verify-native-package.mjs"), output, values.version], "registry-contract.json"));
assert.equal(actual.platformPackage, expected.platformPackage);
assert.equal(actual.binarySha256, expected.binarySha256, "registry binary must match the host-qualified artifact");
run([npmCli, "audit", "signatures", "--json", "--include-attestations"], "registry-signatures.json");
console.log(JSON.stringify(actual));
