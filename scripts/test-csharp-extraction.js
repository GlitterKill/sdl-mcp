import fs from "fs";
import path from "path";
import { CSharpAdapter } from "./dist/indexer/adapter/csharp.js";

const fixturesDir = "tests/fixtures/csharp";
const adapter = new CSharpAdapter();

function testExtraction(fileName, testName) {
  const filePath = path.join(fixturesDir, fileName);
  const content = fs.readFileSync(filePath, "utf-8");

  const tree = adapter.parse(content, filePath);
  if (!tree) {
    console.error(`Failed to parse ${fileName}`);
    process.exit(1);
  }

  if (testName === "symbols") {
    const symbols = adapter.extractSymbols(tree, content, filePath);
    console.log(JSON.stringify(symbols, null, 2));
  } else if (testName === "imports") {
    const imports = adapter.extractImports(tree, content, filePath);
    console.log(JSON.stringify(imports, null, 2));
  } else if (testName === "calls") {
    const symbols = adapter.extractSymbols(tree, content, filePath);
    const calls = adapter.extractCalls(tree, content, filePath, symbols);
    console.log(JSON.stringify(calls, null, 2));
  }
}

const testName = process.argv[2];
const fileName = process.argv[3] || `${testName}.cs`;

if (!testName) {
  console.error(
    "Usage: node test-extraction.js <symbols|imports|calls> [file.cs]",
  );
  process.exit(1);
}

testExtraction(fileName, testName);
