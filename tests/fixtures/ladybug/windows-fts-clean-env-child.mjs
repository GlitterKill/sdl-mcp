import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const MODES = new Set([
  "missing-runtime-baseline",
  "fixed-regression",
]);
const [mode, ...extraArgs] = process.argv.slice(2);
assert.ok(
  MODES.has(mode) && extraArgs.length === 0,
  "expected exactly one supported mode",
);

const require = createRequire(import.meta.url);
const disableOpenSslProvisioning =
  process.env.SDL_TEST_DISABLE_OPENSSL_PROVISIONING === "1";
const home = process.env.USERPROFILE;
assert.ok(home && home === process.env.HOME, "clean USERPROFILE/HOME mismatch");

function packageJson(name) {
  try {
    return require.resolve(name + "/package.json");
  } catch {
    let cursor = dirname(require.resolve(name));
    for (;;) {
      const candidate = join(cursor, "package.json");
      if (existsSync(candidate)) return candidate;
      const parent = dirname(cursor);
      if (parent === cursor) throw new Error("package.json not found for " + name);
      cursor = parent;
    }
  }
}

function packageVersion(name) {
  try {
    return JSON.parse(readFileSync(packageJson(name), "utf8")).version;
  } catch {
    return undefined;
  }
}

function dependencyUnavailable(missing) {
  console.error(
    JSON.stringify({ classification: "mode-dependency-unavailable", missing }),
  );
  process.exit(69);
}

function requireVersion(name, expected) {
  const actual = packageVersion(name);
  if (actual !== expected) {
    dependencyUnavailable([
      name + "@" + expected + " (found " + (actual ?? "absent") + ")",
    ]);
  }
}

async function execute(conn, query, rows = false) {
  const result = await conn.query(query);
  const results = Array.isArray(result) ? result : [result];
  try {
    return rows ? await results[0].getAll() : undefined;
  } finally {
    for (const item of results) item.close();
  }
}

async function queryFtsIds(conn, term) {
  const rows = await execute(
    conn,
    "CALL QUERY_FTS_INDEX('A', 'a_idx', '" +
      term +
      "') RETURN node.id AS id",
    true,
  );
  return rows.map((row) => Number(row.id)).sort((left, right) => left - right);
}

function findExtension(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = findExtension(path);
      if (found) return found;
    } else if (entry.name.toLowerCase() === "libfts.lbug_extension") {
      return path;
    }
  }
  return undefined;
}

function dumpbinImports(extensionPath) {
  const vswhereCandidates = [
    process.env["ProgramFiles(x86)"]
      ? join(
          process.env["ProgramFiles(x86)"],
          "Microsoft",
          "Visual Studio",
          "Installer",
          "vswhere.exe",
        )
      : undefined,
    "C:/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe",
    process.env.ProgramFiles
      ? join(
          process.env.ProgramFiles,
          "Microsoft",
          "Visual Studio",
          "Installer",
          "vswhere.exe",
        )
      : undefined,
    "C:/Program Files/Microsoft Visual Studio/Installer/vswhere.exe",
  ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
  const vswhere = vswhereCandidates.find((candidate) => existsSync(candidate));
  if (!vswhere) {
    dependencyUnavailable(["Visual Studio vswhere.exe for PE import evidence"]);
  }
  const install = spawnSync(
    vswhere,
    [
      "-latest",
      "-products",
      "*",
      "-requires",
      "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "-property",
      "installationPath",
    ],
    { encoding: "utf8" },
  );
  assert.equal(install.status, 0, install.stderr);
  const toolsRoot = join(install.stdout.trim(), "VC", "Tools", "MSVC");
  const toolset = readdirSync(toolsRoot).sort().at(-1);
  assert.ok(toolset, "MSVC toolset not found");
  const dumpbin = join(toolsRoot, toolset, "bin", "Hostx64", "x64", "dumpbin.exe");
  if (!existsSync(dumpbin)) {
    dependencyUnavailable(["MSVC dumpbin.exe for PE import evidence"]);
  }
  const result = spawnSync(dumpbin, ["/nologo", "/dependents", extensionPath], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.toLowerCase();
}

async function missingRuntimeBaseline() {
  requireVersion("kuzu", "0.18.1");
  const kuzu = await import("kuzu");
  const db = new kuzu.Database(join(home, "missing-runtime.lbug"));
  const conn = new kuzu.Connection(db);
  try {
    await execute(conn, "INSTALL fts");
    const extensionRoot = join(home, ".lbdb", "extension", "0.18.1");
    const extensionPath = findExtension(extensionRoot);
    assert.ok(extensionPath, "official FTS extension not found under " + extensionRoot);
    const imports = dumpbinImports(extensionPath);
    for (const dll of ["libcrypto-3-x64.dll", "libssl-3-x64.dll"]) {
      assert.match(imports, new RegExp("\\b" + dll.replaceAll(".", "\\.") + "\\b"));
    }
    let loadError;
    try {
      await execute(conn, "LOAD fts");
    } catch (error) {
      loadError = error;
    }
    assert.ok(loadError, "FTS unexpectedly loaded without the SDL runtime");
    console.log(
      JSON.stringify({
        mode,
        phase: "load",
        classification: "missing-openssl-runtime",
        exitCode: 1,
        imports: ["libcrypto-3-x64.dll", "libssl-3-x64.dll"],
      }),
    );
  } finally {
    await conn.close();
    await db.close();
  }
}

function assertPackageOrigin(loadedPath, binPath, dll) {
  const origin = resolve(stripWindowsExtendedPathPrefix(loadedPath));
  const expectedRoot = (resolve(binPath) + sep).toLowerCase();
  assert.ok(
    origin.toLowerCase().startsWith(expectedRoot),
    dll + " loaded from " + origin,
  );
  assert.equal(basename(origin).toLowerCase(), dll);
}

function stripWindowsExtendedPathPrefix(filePath) {
  if (filePath.startsWith("\\\\?\\UNC\\")) {
    return "\\\\" + filePath.slice("\\\\?\\UNC\\".length);
  }
  if (filePath.startsWith("\\\\?\\")) {
    return filePath.slice("\\\\?\\".length);
  }
  return filePath;
}

async function runRealPatch() {
  const repoId = "windows-fts-fixed-regression";
  const repoDir = join(home, "fixture-repo");
  const sourceDir = join(repoDir, "src", "agent");
  const dbPath = join(home, "fixed-patch.lbug");
  mkdirSync(sourceDir, { recursive: true });
  const original = readFileSync("src/agent/planner.ts", "utf8");
  const patched =
    original +
    "\nexport function legacyFtsPatchProbe(value: number): number { return value + 1; }\n";
  const filePath = join(sourceDir, "planner.ts");
  writeFileSync(filePath, original, "utf8");
  process.env.SDL_GRAPH_DB_PATH = dbPath;

  const { closeLadybugDb, getLadybugConn, initLadybugDb } = await import(
    "../../../dist/db/ladybug.js"
  );
  const ladybugDb = await import("../../../dist/db/ladybug-queries.js");
  const { indexRepo } = await import("../../../dist/indexer/indexer.js");
  const { patchSavedFile } = await import(
    "../../../dist/live-index/file-patcher.js"
  );
  const {
    indexExistsForTable,
    showIndexes,
    SYMBOL_FTS_INDEX_NAME,
  } = await import("../../../dist/retrieval/index-lifecycle.js");
  await initLadybugDb(dbPath);
  try {
    const conn = await getLadybugConn();
    await ladybugDb.upsertRepo(conn, {
      repoId,
      rootPath: repoDir,
      configJson: JSON.stringify({
        repoId,
        rootPath: repoDir,
        ignore: [],
        languages: ["ts"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: true,
      }),
      createdAt: "2026-07-14T00:00:00.000Z",
    });
    await indexRepo(repoId, "full");
    let indexes = await showIndexes(conn);
    if (!indexExistsForTable(indexes, "Symbol", SYMBOL_FTS_INDEX_NAME, "fts")) {
      await execute(conn, "INSTALL fts");
      await execute(conn, "LOAD fts");
      await execute(
        conn,
        "CALL CREATE_FTS_INDEX('Symbol', '" +
          SYMBOL_FTS_INDEX_NAME +
          "', ['searchText'])",
      );
      indexes = await showIndexes(conn);
    }
    assert.ok(
      indexExistsForTable(indexes, "Symbol", SYMBOL_FTS_INDEX_NAME, "fts"),
      "generated fixture is missing active Symbol FTS index",
    );
    await patchSavedFile({
      repoId,
      filePath: relative(repoDir, filePath).replaceAll("\\", "/"),
      content: patched,
      language: "typescript",
      version: 2,
    });
  } finally {
    await closeLadybugDb();
  }
}

async function fixedRegression() {
  const missing = [];
  if (packageVersion("kuzu") !== "0.18.1") missing.push("kuzu@0.18.1");
  let addon;
  if (!disableOpenSslProvisioning) {
    if (
      packageVersion("@sdl-mcp/ladybug-openssl-win32-x64") !== "3.5.7-sdl.2"
    ) {
      missing.push("@sdl-mcp/ladybug-openssl-win32-x64@3.5.7-sdl.2");
    }
    try {
      const imported = await import("sdl-mcp-native");
      addon = imported.default ?? imported;
    } catch {
      missing.push("published sdl-mcp-native Windows loader shim");
    }
    if (
      addon &&
      (typeof addon.preloadWindowsLibrary !== "function" ||
        typeof addon.releaseWindowsLibrary !== "function")
    ) {
      missing.push("published sdl-mcp-native Windows loader shim");
    }
  }
  if (missing.length > 0) dependencyUnavailable([...new Set(missing)]);

  const binPath = disableOpenSslProvisioning
    ? undefined
    : join(dirname(packageJson("@sdl-mcp/ladybug-openssl-win32-x64")), "bin");
  const dlls = ["libcrypto-3-x64.dll", "libssl-3-x64.dll"];
  const whereExe = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "where.exe",
  );
  const pathDlls = dlls.filter(
    (dll) =>
      spawnSync(whereExe, ["/Q", dll], { encoding: "utf8" }).status === 0,
  );
  assert.deepEqual(pathDlls, []);
  console.log(JSON.stringify({ phase: "environment", pathDlls }));

  let kuzu;
  try {
    kuzu = await import("kuzu");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("lbugjs.node") || message.includes("lbug_native")) {
      dependencyUnavailable(["kuzu@0.18.1 native lbugjs.node"]);
    }
    throw error;
  }
  const db = new kuzu.Database(join(home, "fixed-raw.lbug"));
  const conn = new kuzu.Connection(db);
  const handles = [];
  try {
    await execute(conn, "INSTALL fts");
    console.log(JSON.stringify({ phase: "install", extension: "fts" }));
    if (!disableOpenSslProvisioning) {
      for (const dll of dlls) {
        const loaded = addon.preloadWindowsLibrary(join(binPath, dll));
        assertPackageOrigin(loaded.loadedPath, binPath, dll);
        handles.push(loaded.token);
      }
      console.log(JSON.stringify({ phase: "preload", modules: dlls }));
    }
    try {
      await execute(conn, "LOAD fts");
    } catch (error) {
      if (!disableOpenSslProvisioning) throw error;
      await conn.close();
      await db.close();
      console.log(
        JSON.stringify({
          mode,
          phase: "load",
          classification: "upstream-runtime-unavailable",
          provisioning: "disabled",
          exitCode: 1,
        }),
      );
      return;
    }
    console.log(JSON.stringify({ phase: "load", extension: "fts" }));
    await execute(
      conn,
      "CREATE NODE TABLE A(id INT64, name STRING, PRIMARY KEY(id))",
    );
    await execute(
      conn,
      "CALL CREATE_FTS_INDEX('A', 'a_idx', ['name'], stemmer := 'none')",
    );
    for (let index = 0; index < 25; index += 1) {
      await execute(
        conn,
        "CREATE (:A {id: " + index + ", name: 'before_" + index + "'})",
      );
      await execute(
        conn,
        "MATCH (a:A) WHERE a.id = " +
          index +
          " SET a.name = 'after_" +
          index +
          "'",
      );
      const rows = await execute(
        conn,
        "MATCH (a:A) WHERE a.id = " + index + " RETURN a.name AS name",
        true,
      );
      assert.equal(rows[0]?.name, "after_" + index);
      assert.deepEqual(await queryFtsIds(conn, "after_" + index), [index]);
      await execute(conn, "MATCH (a:A) WHERE a.id = " + index + " DELETE a");
      assert.deepEqual(await queryFtsIds(conn, "after_" + index), []);
    }
    console.log(JSON.stringify({ phase: "mutation", iterations: 25 }));
    await conn.close();
    await db.close();
    await runRealPatch();
    console.log(JSON.stringify({ phase: "patchSavedFile", activeFts: true }));
  } finally {
    for (const token of handles.reverse()) addon.releaseWindowsLibrary(token);
  }
  console.log(JSON.stringify({ phase: "shutdown", ok: true }));
}

if (mode === "missing-runtime-baseline") await missingRuntimeBaseline();
else await fixedRegression();
