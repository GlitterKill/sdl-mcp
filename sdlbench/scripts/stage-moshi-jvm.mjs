// Stage the verified backport as an explicit local SDLBench profile, never a release replacement.
import { cp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve, join, relative } from "node:path";

const [scipIoInput, javaPackInput, mavenInput] = process.argv.slice(2);
if (process.platform !== "win32" || !scipIoInput || !javaPackInput || !mavenInput) {
  throw new Error("Usage on Windows: node sdlbench/scripts/stage-moshi-jvm.mjs <patched-scip-io.exe> <scip-java-pack> <disposable-maven-repo>");
}
const root = resolve(".");
const bundle = join(root, "sdlbench/.work/products/moshi-kotlin-2.3.21-scripts4");
const version = "0.5.1-kotlin-2.3.21-scripts4-SNAPSHOT";
const coordinate = "com/sourcegraph/semanticdb-kotlinc/" + version;
const pluginName = "semanticdb-kotlinc-" + version + ".jar";
const expectedPlugin = "79e73306593b97ac87ab656ed072e3c3548514d32bfa1b7d8da35c056238c751";
const hash = data => createHash("sha256").update(data).digest("hex");
const pinned = "889013ec2edb8d8034902662a1dc8c4f3b3f8111";
const source = join(root, "sdlbench/.work/repos/moshi");
if (execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {encoding:"utf8"}).trim() !== pinned
  || execFileSync("git", ["-C", source, "status", "--porcelain"], {encoding:"utf8"}).trim()) {
  throw new Error("Moshi must be clean at the verified commit " + pinned);
}
if (hash(await readFile(join(resolve(mavenInput), coordinate, pluginName))) !== expectedPlugin) {
  throw new Error("Kotlin plugin does not match the verified artifact");
}
// Refuse to overwrite a staged profile: its hashes identify the benchmark input.
await mkdir(bundle);
await cp(resolve(scipIoInput), join(bundle, "scip-io.exe"), {errorOnExist:true, force:false});
await cp(resolve(javaPackInput), join(bundle, "scip-java"), {recursive:true, errorOnExist:true, force:false});
await mkdir(join(bundle, "maven", coordinate), {recursive:true});
await cp(join(resolve(mavenInput), coordinate), join(bundle, "maven", coordinate), {recursive:true});
await writeFile(join(bundle, "scip-io.cmd"), [
  "@echo off", "setlocal", 'set JAVA_TOOL_OPTIONS=-Dmaven.repo.local="%~dp0maven"',
  '"%~dp0scip-io.exe" %*', "exit /b %errorlevel%", ""
].join("\r\n"));

const portable = p => p.replaceAll("\\", "/");
const launcher = portable(join(bundle, "scip-java/bin/scip-java.bat"));
if (launcher.includes("'")) throw new Error("Bundle path cannot contain an apostrophe in TOML literal");
const scipIoConfig = ["java", "kotlin"].map(language =>
  "[indexer." + language + "]\nbinary = '" + launcher + "'\nargs = ['index', '--no-cleanup']\n"
).join("\n");
const lock = JSON.parse(await readFile(join(root, "sdlbench/config/repos.lock.json"), "utf8"));
const moshi = lock.repos.find(repo => repo.repoId === "moshi");
if (!moshi) throw new Error("Missing Moshi repository");
Object.assign(moshi, {pinnedRef:pinned, scipIoConfig, scipGenerator:{
  binary:join(bundle,"scip-io.cmd"), autoInstall:false, cacheGeneratedIndexes:false,
  // Both JVM invocations clean the same Gradle build directories.
  args:["--parallel", "1"], timeoutMs:900000,
}});
const files = [];
async function inventory(dir) {
  for(const entry of await readdir(dir,{withFileTypes:true})) {
    const path=join(dir,entry.name);
    if(entry.isDirectory()) await inventory(path);
    else files.push({path:portable(relative(bundle,path)),sha256:hash(await readFile(path))});
  }
}
await inventory(bundle);
await writeFile(join(bundle,"artifacts.json"),JSON.stringify({pinned,version,files},null,2)+"\n");
const lockPath = join(bundle,"repos.lock.json");
await writeFile(lockPath,JSON.stringify(lock,null,2)+"\n");
console.log(JSON.stringify({bundle,reposLockPath:lockPath,files:files.length,pluginSha256:expectedPlugin}));
