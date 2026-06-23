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

  it("verifies packed npm installs on Ubuntu and Windows before publishing", () => {
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
    assert.match(verifyJob, /- ubuntu-latest[\s\S]*- windows-latest/);
    assert.match(
      verifyJob,
      /SDL_MCP_STRICT_TREE_SITTER_POSTINSTALL:\s*"1"/,
      "packed install smoke should fail fast when grammar bindings cannot be verified",
    );
    assert.match(
      verifyJob,
      /npm pack --pack-destination release-pack[\s\S]*npm install "\$\{tarball\}" --legacy-peer-deps --omit=optional[\s\S]*node node_modules\/sdl-mcp\/scripts\/postinstall-tree-sitter\.mjs --verify-only/s,
      "release workflow should install the packed tarball and verify bundled grammar bindings",
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
