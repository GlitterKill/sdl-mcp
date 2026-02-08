import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = join(process.cwd(), "tests", "fixtures");
class AdapterTestHarness {
    languages = [];
    constructor() {
        this.loadLanguageConfig();
    }
    loadLanguageConfig() {
        this.languages = [
            {
                languageId: "typescript",
                extensions: [".ts", ".tsx", ".js", ".jsx"],
                fixtureDir: join(fixturesDir, "typescript"),
                adapterClass: null,
            },
            {
                languageId: "java",
                extensions: [".java"],
                fixtureDir: join(fixturesDir, "java"),
                adapterClass: null,
            },
            {
                languageId: "go",
                extensions: [".go"],
                fixtureDir: join(fixturesDir, "go"),
                adapterClass: null,
            },
            {
                languageId: "python",
                extensions: [".py"],
                fixtureDir: join(fixturesDir, "python"),
                adapterClass: null,
            },
            {
                languageId: "csharp",
                extensions: [".cs"],
                fixtureDir: join(fixturesDir, "csharp"),
                adapterClass: null,
            },
            {
                languageId: "c",
                extensions: [".c", ".h"],
                fixtureDir: join(fixturesDir, "c"),
                adapterClass: null,
            },
            {
                languageId: "cpp",
                extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"],
                fixtureDir: join(fixturesDir, "cpp"),
                adapterClass: null,
            },
            {
                languageId: "php",
                extensions: [".php", ".phtml"],
                fixtureDir: join(fixturesDir, "php"),
                adapterClass: null,
            },
            {
                languageId: "rust",
                extensions: [".rs"],
                fixtureDir: join(fixturesDir, "rust"),
                adapterClass: null,
            },
            {
                languageId: "kotlin",
                extensions: [".kt", ".kts"],
                fixtureDir: join(fixturesDir, "kotlin"),
                adapterClass: null,
            },
            {
                languageId: "shell",
                extensions: [".sh", ".bash"],
                fixtureDir: join(fixturesDir, "shell"),
                adapterClass: null,
            },
        ];
    }
    discoverFixtures() {
        const discovered = [];
        for (const language of this.languages) {
            if (existsSync(language.fixtureDir)) {
                discovered.push(language);
            }
        }
        return discovered;
    }
    async runAdapterTests(language) {
        console.log(`\n${"=".repeat(50)}`);
        console.log(`Testing Language: ${language.languageId}`);
        console.log("=".repeat(50));
        const adapter = await this.loadAdapter(language);
        if (!adapter) {
            console.error(`❌ Failed to load adapter for ${language.languageId}`);
            return {
                languageId: language.languageId,
                passed: 0,
                failed: 0,
                duration: 0,
                tests: [],
            };
        }
        const testResults = [];
        const symbolTests = await this.runSymbolTests(language, adapter);
        testResults.push(...symbolTests);
        const importTests = await this.runImportTests(language, adapter);
        testResults.push(...importTests);
        const callTests = await this.runCallTests(language, adapter);
        testResults.push(...callTests);
        const passed = testResults.filter((t) => t.passed).length;
        const failed = testResults.filter((t) => !t.passed).length;
        const duration = testResults.reduce((sum, t) => sum + t.duration, 0);
        console.log(`\n--- Summary for ${language.languageId} ---`);
        console.log(`Passed: ${passed}`);
        console.log(`Failed: ${failed}`);
        console.log(`Duration: ${duration}ms`);
        if (failed > 0) {
            console.log("\nFailed tests:");
            testResults
                .filter((t) => !t.passed)
                .forEach((t) => {
                console.log(`  - ${t.testName}: ${t.error || "Unknown error"}`);
            });
        }
        return {
            languageId: language.languageId,
            passed,
            failed,
            duration,
            tests: testResults,
        };
    }
    async loadAdapter(language) {
        try {
            const adapterPath = join(process.cwd(), "dist", "indexer", "adapter", `${language.languageId}.js`);
            if (!existsSync(adapterPath)) {
                console.error(`Adapter not found: ${adapterPath}`);
                return null;
            }
            const adapterUrl = pathToFileURL(adapterPath).href;
            const module = await import(adapterUrl);
            const AdapterClass = module.default || module[Object.keys(module)[0]];
            return new AdapterClass();
        }
        catch (error) {
            console.error(`Failed to load adapter for ${language.languageId}:`, error instanceof Error ? error.message : String(error));
            return null;
        }
    }
    async runSymbolTests(language, adapter) {
        const results = [];
        const symbolFixtures = this.findFixtures(language, "symbols");
        for (const fixture of symbolFixtures) {
            const start = Date.now();
            const testName = `Symbol extraction: ${fixture}`;
            try {
                const content = readFileSync(fixture, "utf-8");
                const tree = adapter.parse(content, fixture);
                if (!tree) {
                    results.push({
                        languageId: language.languageId,
                        testName,
                        passed: false,
                        duration: Date.now() - start,
                        error: "Failed to parse file",
                    });
                    continue;
                }
                const symbols = adapter.extractSymbols(tree, content, fixture);
                const expectedPath = this.getExpectedPath(fixture, "symbols");
                if (existsSync(expectedPath)) {
                    const expected = JSON.parse(readFileSync(expectedPath, "utf-8"));
                    const passed = this.compareSymbols(symbols, expected);
                    results.push({
                        languageId: language.languageId,
                        testName,
                        passed,
                        duration: Date.now() - start,
                        details: passed
                            ? `Extracted ${symbols.length} symbols`
                            : `Expected ${expected.length} symbols, got ${symbols.length}`,
                    });
                    console.log(passed ? `✅ ${testName}` : `❌ ${testName} - count mismatch`);
                }
                else {
                    results.push({
                        languageId: language.languageId,
                        testName,
                        passed: true,
                        duration: Date.now() - start,
                        details: `Extracted ${symbols.length} symbols (no expected file)`,
                    });
                    console.log(`⚠️  ${testName} (no expected file)`);
                }
            }
            catch (error) {
                results.push({
                    languageId: language.languageId,
                    testName,
                    passed: false,
                    duration: Date.now() - start,
                    error: error instanceof Error ? error.message : String(error),
                });
                console.error(`❌ ${testName} - Error: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return results;
    }
    async runImportTests(language, adapter) {
        const results = [];
        const importFixtures = this.findFixtures(language, "imports");
        for (const fixture of importFixtures) {
            const start = Date.now();
            const testName = `Import extraction: ${fixture}`;
            try {
                const content = readFileSync(fixture, "utf-8");
                const tree = adapter.parse(content, fixture);
                if (!tree) {
                    results.push({
                        languageId: language.languageId,
                        testName,
                        passed: false,
                        duration: Date.now() - start,
                        error: "Failed to parse file",
                    });
                    continue;
                }
                const imports = adapter.extractImports(tree, content, fixture);
                const expectedPath = this.getExpectedPath(fixture, "imports");
                if (existsSync(expectedPath)) {
                    const expected = JSON.parse(readFileSync(expectedPath, "utf-8"));
                    const passed = this.compareImports(imports, expected);
                    results.push({
                        languageId: language.languageId,
                        testName,
                        passed,
                        duration: Date.now() - start,
                        details: passed
                            ? `Extracted ${imports.length} imports`
                            : `Expected ${expected.length} imports, got ${imports.length}`,
                    });
                    console.log(passed ? `✅ ${testName}` : `❌ ${testName} - count mismatch`);
                }
                else {
                    results.push({
                        languageId: language.languageId,
                        testName,
                        passed: true,
                        duration: Date.now() - start,
                        details: `Extracted ${imports.length} imports (no expected file)`,
                    });
                    console.log(`⚠️  ${testName} (no expected file)`);
                }
            }
            catch (error) {
                results.push({
                    languageId: language.languageId,
                    testName,
                    passed: false,
                    duration: Date.now() - start,
                    error: error instanceof Error ? error.message : String(error),
                });
                console.error(`❌ ${testName} - Error: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return results;
    }
    async runCallTests(language, adapter) {
        const results = [];
        const callFixtures = this.findFixtures(language, "calls");
        for (const fixture of callFixtures) {
            const start = Date.now();
            const testName = `Call extraction: ${fixture}`;
            try {
                const content = readFileSync(fixture, "utf-8");
                const tree = adapter.parse(content, fixture);
                if (!tree) {
                    results.push({
                        languageId: language.languageId,
                        testName,
                        passed: false,
                        duration: Date.now() - start,
                        error: "Failed to parse file",
                    });
                    continue;
                }
                const symbols = adapter.extractSymbols(tree, content, fixture);
                const calls = adapter.extractCalls(tree, content, fixture, symbols);
                const expectedPath = this.getExpectedPath(fixture, "calls");
                if (existsSync(expectedPath)) {
                    const expected = JSON.parse(readFileSync(expectedPath, "utf-8"));
                    const passed = this.compareCalls(calls, expected);
                    results.push({
                        languageId: language.languageId,
                        testName,
                        passed,
                        duration: Date.now() - start,
                        details: passed
                            ? `Extracted ${calls.length} calls`
                            : `Expected ${expected.length} calls, got ${calls.length}`,
                    });
                    console.log(passed ? `✅ ${testName}` : `❌ ${testName} - count mismatch`);
                }
                else {
                    results.push({
                        languageId: language.languageId,
                        testName,
                        passed: true,
                        duration: Date.now() - start,
                        details: `Extracted ${calls.length} calls (no expected file)`,
                    });
                    console.log(`⚠️  ${testName} (no expected file)`);
                }
            }
            catch (error) {
                results.push({
                    languageId: language.languageId,
                    testName,
                    passed: false,
                    duration: Date.now() - start,
                    error: error instanceof Error ? error.message : String(error),
                });
                console.error(`❌ ${testName} - Error: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return results;
    }
    findFixtures(language, type) {
        const fixtures = [];
        if (!existsSync(language.fixtureDir)) {
            return fixtures;
        }
        const files = readdirSync(language.fixtureDir);
        for (const file of files) {
            if (file.startsWith(`${type}.`)) {
                fixtures.push(join(language.fixtureDir, file));
            }
        }
        return fixtures;
    }
    getExpectedPath(fixture, type) {
        const dir = dirname(fixture);
        const base = basename(fixture);
        return join(dir, `expected-${type}.${base}.json`);
    }
    compareSymbols(actual, expected) {
        return actual.length === expected.length;
    }
    compareImports(actual, expected) {
        return actual.length === expected.length;
    }
    compareCalls(actual, expected) {
        return actual.length === expected.length;
    }
}
async function main() {
    const args = process.argv.slice(2);
    const languageFilter = args.find((a) => !a.startsWith("--"));
    console.log("SDL-MCP Language Adapter Test Harness v1.0.0");
    console.log("=".repeat(50));
    const harness = new AdapterTestHarness();
    const fixtures = harness.discoverFixtures();
    console.log(`\nDiscovered ${fixtures.length} language fixtures:`);
    fixtures.forEach((f) => console.log(`  - ${f.languageId}`));
    if (languageFilter) {
        const filtered = fixtures.filter((f) => f.languageId === languageFilter);
        if (filtered.length === 0) {
            console.error(`\n❌ No fixtures found for language: ${languageFilter}`);
            process.exit(1);
        }
        fixtures.length = 0;
        fixtures.push(...filtered);
        console.log(`\nFiltered to: ${languageFilter}`);
    }
    const reports = [];
    for (const fixture of fixtures) {
        const report = await harness.runAdapterTests(fixture);
        reports.push(report);
    }
    console.log(`\n${"=".repeat(50)}`);
    console.log("FINAL REPORT");
    console.log("=".repeat(50));
    let totalPassed = 0;
    let totalFailed = 0;
    for (const report of reports) {
        const allPassed = report.failed === 0;
        console.log(`${report.languageId}: ${allPassed ? "✅ PASSED" : "❌ FAILED"}`);
        console.log(`  - Passed: ${report.passed}`);
        console.log(`  - Failed: ${report.failed}`);
        console.log(`  - Duration: ${report.duration}ms`);
        totalPassed += report.passed;
        totalFailed += report.failed;
    }
    console.log(`\n${"=".repeat(50)}`);
    console.log(`Total Passed: ${totalPassed}`);
    console.log(`Total Failed: ${totalFailed}`);
    console.log("=".repeat(50));
    const allPassed = totalFailed === 0;
    process.exit(allPassed ? 0 : 1);
}
main().catch((error) => {
    console.error(`Uncaught error: ${error}`);
    process.exit(1);
});
//# sourceMappingURL=adapter-runner.js.map