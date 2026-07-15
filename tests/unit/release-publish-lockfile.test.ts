import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(join(process.cwd(), path), "utf8"));
}

function readSource(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("release publish lockfile guards", () => {
  it("keeps package-lock native package versions aligned with release manifests", () => {
    const rootPkg = readJson("package.json") as {
      version: string;
      optionalDependencies?: Record<string, string>;
    };
    const nativePkg = readJson("native/package.json") as {
      version: string;
      optionalDependencies?: Record<string, string>;
    };
    const lockfile = readJson("package-lock.json") as {
      packages?: Record<
        string,
        {
          version?: string;
          optionalDependencies?: Record<string, string>;
        }
      >;
    };

    const expectedVersion = rootPkg.version;
    const lockPackages = lockfile.packages ?? {};
    const lockRoot = lockPackages[""];
    const lockNative = lockPackages["node_modules/sdl-mcp-native"];

    assert.equal(nativePkg.version, expectedVersion);
    assert.equal(
      rootPkg.optionalDependencies?.["sdl-mcp-native"],
      expectedVersion,
      "package.json should pin sdl-mcp-native to the release version",
    );
    assert.equal(lockRoot?.version, expectedVersion);
    assert.equal(
      lockRoot?.optionalDependencies?.["sdl-mcp-native"],
      expectedVersion,
      "package-lock root package should pin sdl-mcp-native to the release version",
    );
    for (const depName of [
      "sdl-mcp-watchman",
      "sdl-mcp-watchman-linux-x64",
      "sdl-mcp-watchman-win32-x64",
    ]) {
      assert.equal(
        rootPkg.optionalDependencies?.[depName],
        expectedVersion,
        `package.json should pin ${depName} to the release version`,
      );
      assert.equal(
        lockRoot?.optionalDependencies?.[depName],
        expectedVersion,
        `package-lock root package should pin ${depName} to the release version`,
      );
    }

    assert.equal(
      lockNative?.version,
      expectedVersion,
      "package-lock should include a resolved sdl-mcp-native package entry",
    );

    for (const [name, version] of Object.entries(
      nativePkg.optionalDependencies ?? {},
    )) {
      assert.equal(
        version,
        expectedVersion,
        `native/package.json should pin ${name} to the release version`,
      );
      assert.equal(
        lockNative?.optionalDependencies?.[name],
        expectedVersion,
        `package-lock should pin ${name} under sdl-mcp-native optionalDependencies`,
      );
      assert.equal(
        lockPackages[`node_modules/${name}`]?.version,
        expectedVersion,
        `package-lock should include a ${name} package entry`,
      );
    }
  });

  it("refreshes the lockfile before npm ci in the release publish job", () => {
    const workflow = readSource(".github/workflows/release-publish.yml");
    const publishJob = workflow.match(/publish:\s*[\s\S]*$/)?.[0] ?? "";

    assert.ok(
      publishJob,
      "publish job section should be present in release-publish workflow",
    );
    assert.match(
      publishJob,
      /name:\s*Refresh package-lock for release publish[\s\S]*npm install --package-lock-only --ignore-scripts --legacy-peer-deps[\s\S]*name:\s*Install dependencies[\s\S]*npm ci --ignore-scripts --legacy-peer-deps/s,
      "publish job should repair package-lock before npm ci under npm 11+",
    );
  });

  it("verifies the required packed-install matrix before publishing", () => {
    const workflow = readSource(".github/workflows/release-publish.yml");
    const verifyJob = workflow.match(/verify-packed-install:\s*[\s\S]*?\n  publish:/)?.[0] ?? "";
    const publishJob = workflow.match(/publish:\s*[\s\S]*$/)?.[0] ?? "";

    assert.ok(
      verifyJob,
      "verify-packed-install job section should be present in release-publish workflow",
    );
    assert.match(
      verifyJob,
      /runs-on:\s*\$\{\{\s*matrix\.os\s*\}\}/,
      "packed install smoke should run across an OS matrix",
    );
    assert.match(
      verifyJob,
      /os:\s*windows-latest[\s\S]*accelerators:\s*included[\s\S]*os:\s*windows-latest[\s\S]*accelerators:\s*disabled[\s\S]*os:\s*ubuntu-latest[\s\S]*accelerators:\s*included[\s\S]*os:\s*macos-latest[\s\S]*accelerators:\s*included/s,
      "packed install smoke should cover Windows enabled/disabled accelerators plus Linux and macOS normal installs",
    );
    assert.match(
      verifyJob,
      /SDL_MCP_STRICT_TREE_SITTER_POSTINSTALL:\s*"1"/,
      "packed install smoke should fail fast when grammar bindings cannot be verified",
    );
    assert.match(
      verifyJob,
      /needs:\s*[\s\S]*- build-native[\s\S]*npm pack \.\/native\/npm\/win32-x64-msvc[\s\S]*npm pack \.\/native/s,
      "Windows normal-install proof should use native tarballs built by the same release run",
    );
    assert.match(
      verifyJob,
      /npm pack --pack-destination release-pack[\s\S]*npm install "\$\{install_args\[@\]\}"[\s\S]*node node_modules\/sdl-mcp\/scripts\/postinstall-tree-sitter\.mjs --verify-only/s,
      "release workflow should install the packed tarball and verify bundled grammar bindings",
    );
    assert.match(
      verifyJob,
      /SDL_LADYBUG_WINDOWS_FTS_TEST_MODE=fixed-regression[\s\S]*live-index-symbol-fts-crash\.test\.ts/s,
      "normal Windows packed installs should run the real FTS and patchSavedFile regression",
    );
    assert.match(
      verifyJob,
      /SDL_MCP_DISABLE_NATIVE_ADDON=1[\s\S]*--test-name-pattern="probes upstream"[\s\S]*live-index-symbol-fts-crash\.test\.ts/s,
      "disabled Windows accelerators should prove graceful FTS unavailability",
    );
    assert.match(
      verifyJob,
      /matrix\.accelerators[^\n]*disabled[\s\S]*StdioClientTransport[\s\S]*SDL_MCP_DISABLE_NATIVE_ADDON:\s*"1"[\s\S]*client\.listTools\(\)[\s\S]*client\.callTool[\s\S]*native\?\.disabledByEnv/s,
      "disabled Windows accelerators should complete an MCP startup handshake and report disabled native status",
    );
    assert.doesNotMatch(
      verifyJob,
      /--omit=optional/,
      "Ladybug's recursively optional platform binary makes raw optional omission unsupported",
    );
    assert.doesNotMatch(
      verifyJob,
      /installed_root="\$\{smoke_dir\}\/node_modules\/sdl-mcp"/,
      "Node 24 cannot strip TypeScript test files copied under node_modules",
    );
    assert.match(
      verifyJob,
      /cp -R node_modules\/sdl-mcp\/dist "\$\{smoke_dir\}\/dist"/,
      "the temporary harness should use the installed package build outside node_modules",
    );
    assert.match(
      verifyJob,
      /npm init -y > \/dev\/null[\s\S]*npm pkg set type=module/,
      "the temporary TypeScript harness should run as ESM",
    );
    assert.match(
      publishJob,
      /needs:\s*[\s\S]*- verify-packed-install/,
      "publish job should wait for packed install verification",
    );
  });

  it("bootstraps the publish job on Node 24 with registry URL for trusted publishing", () => {
    const workflow = readSource(".github/workflows/release-publish.yml");
    const publishJob = workflow.match(/publish:\s*[\s\S]*$/)?.[0] ?? "";

    assert.ok(
      publishJob,
      "publish job section should be present in release-publish workflow",
    );
    assert.match(
      publishJob,
      /name:\s*Setup Node\.js[\s\S]*node-version:\s*24\.x[\s\S]*registry-url:\s*https:\/\/registry\.npmjs\.org/s,
      "publish job should use the Node 24 bootstrap path with npm registry URL for trusted publishing",
    );
  });

  it("publishes the create-sdl-mcp wrapper after the main package", () => {
    const workflow = readSource(".github/workflows/release-publish.yml");
    const publishJob = workflow.match(/publish:\s*[\s\S]*$/)?.[0] ?? "";

    assert.match(
      publishJob,
      /if \(createPackage\.version !== expected\) throw new Error\('packages\/create-sdl-mcp\/package\.json version mismatch'\);/,
      "release validation should fail if create-sdl-mcp is not versioned with the release",
    );
    assert.match(
      publishJob,
      /name:\s*Publish main package[\s\S]*name:\s*Publish create-sdl-mcp wrapper package/s,
      "wrapper should publish only after the main sdl-mcp package succeeds",
    );
    assert.match(
      publishJob,
      /npm view "create-sdl-mcp@\$\{VERSION\}" version/,
      "wrapper publish should be idempotent against existing registry versions",
    );
    assert.match(
      publishJob,
      /npm publish packages\/create-sdl-mcp\/ --access public --tag "\$\{NPM_DIST_TAG\}"/,
      "wrapper package should be published to npm",
    );
  });
});
