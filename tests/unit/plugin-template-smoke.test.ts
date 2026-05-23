import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const TEMPLATE_ROOT = "templates/plugin-template";

interface TemplatePackageJson {
  files?: string[];
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function readTemplateFile(fileName: string): Promise<string> {
  return readFile(join(TEMPLATE_ROOT, fileName), "utf-8");
}

async function readPackageJson(): Promise<TemplatePackageJson> {
  return JSON.parse(await readTemplateFile("package.json")) as TemplatePackageJson;
}

describe("plugin template smoke coverage", () => {
  it("ships structural matcher guidance and keeps scripts package-friendly", async () => {
    const packageJson = await readPackageJson();
    assert.equal(packageJson.scripts?.build, "tsc");
    assert.equal(
      packageJson.scripts?.test,
      "npm run build && node --test dist/test/*.test.js",
    );
    assert.equal(packageJson.devDependencies?.["sdl-mcp"], "*");
    assert.ok(packageJson.files?.includes("STRUCTURAL_MATCHER.md"));

    const readme = await readTemplateFile("README.md");
    assert.match(readme, /STRUCTURAL_MATCHER\.md/);
    assert.match(readme, /structuralMatcher/);

    const structuralGuide = await readTemplateFile("STRUCTURAL_MATCHER.md");
    assert.match(
      structuralGuide,
      /sdl-mcp\/dist\/indexer\/adapter\/LanguageAdapter\.js/,
    );
    assert.match(
      structuralGuide,
      /sdl-mcp\/dist\/indexer\/adapter\/plugin\/types\.js/,
    );
    assert.match(structuralGuide, /identifierNodeTypes: \["identifier"\]/);
    assert.match(structuralGuide, /createQuery\(queryString: string\)/);
  });
});
