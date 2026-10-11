import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { target: { type: "string" }, binary: { type: "string" }, output: { type: "string" }, version: { type: "string" } } });
assert.ok(values.target && values.binary && values.output, "requires --target, --binary and a fresh --output directory");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const platformDirectory = resolve(root, "native/npm", values.target);
assert.equal(dirname(platformDirectory), resolve(root, "native/npm"));
const output = resolve(values.output);
assert.ok(!existsSync(output), "qualification output must be fresh");
const umbrella = JSON.parse(readFileSync(join(root, "native/package.json"), "utf8"));
const platform = JSON.parse(readFileSync(join(platformDirectory, "package.json"), "utf8"));
const version = values.version ?? umbrella.version;
assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
assert.equal(umbrella.optionalDependencies[platform.name], umbrella.version);
assert.ok(platform.os.includes(process.platform) && platform.cpu.includes(process.arch), "run qualification on a matching target host");
umbrella.version = version;
for (const name of Object.keys(umbrella.optionalDependencies)) umbrella.optionalDependencies[name] = version;
platform.version = version;
const wrapperStage = join(output, "umbrella");
const platformStage = join(output, "platform");
const pack = join(output, "pack");
const consumer = join(output, "consumer");
for (const dir of [wrapperStage, platformStage, pack, consumer]) mkdirSync(dir, { recursive: true });
writeFileSync(join(wrapperStage, "package.json"), JSON.stringify(umbrella, null, 2) + "\n");
for (const name of umbrella.files) copyFileSync(join(root, "native", name), join(wrapperStage, name));
writeFileSync(join(platformStage, "package.json"), JSON.stringify(platform, null, 2) + "\n");
copyFileSync(resolve(values.binary), join(platformStage, platform.main));
writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "native-package-contract-consumer", version: "1.0.0", private: true }));
const env = { ...process.env };
for (const key of ["SDL_MCP_NATIVE_ADDON_PATH", "SDL_LADYBUG_WINDOWS_FTS_NATIVE_ADDON_PATH", "SDL_MCP_DISABLE_NATIVE_ADDON", "NODE_PATH", "NODE_OPTIONS"]) delete env[key];
const npmCli = [
  process.env.npm_execpath,
  join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
  resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
].find(path => path && existsSync(path));
assert.ok(npmCli, "npm CLI must be available alongside the configured Node runtime");
function run(command, args, cwd) {
  const executable = command === "npm" ? process.execPath : command;
  const argumentsList = command === "npm" ? [npmCli, ...args] : args;
  const result = spawnSync(executable, argumentsList, { cwd, env, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
const tarballs = [];
for (const dir of [wrapperStage, platformStage]) {
  const packed = JSON.parse(run("npm", ["pack", dir, "--ignore-scripts", "--json", "--pack-destination", pack], root));
  tarballs.push(join(pack, packed[0].filename));
}
writeFileSync(join(output, "install.log"), run("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], consumer));
const report = run(process.execPath, [join(root, "scripts/verify-native-package.mjs"), consumer, version], consumer);
writeFileSync(join(output, "contract.json"), report);
console.log(report.trim());
console.log(`Qualified packed native artifacts: ${pack}`);
