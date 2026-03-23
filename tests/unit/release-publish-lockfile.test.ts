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
});
