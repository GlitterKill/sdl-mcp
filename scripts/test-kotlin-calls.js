import { KotlinAdapter } from "../dist/indexer/adapter/kotlin.js";
import fs from "fs";

const content = fs.readFileSync("tests/fixtures/kotlin/calls.kt", "utf-8");
const adapter = new KotlinAdapter();
const tree = adapter.parse(content, "test.kt");

if (!tree) {
  console.error("Failed to parse Kotlin file");
  process.exit(1);
}

const symbols = adapter.extractSymbols(tree, content, "test.kt");
const calls = adapter.extractCalls(tree, content, "test.kt", symbols);

console.log(`\n✓ Extracted ${calls.length} calls from calls.kt\n`);

// Group by call type
const byType = { function: 0, method: 0, constructor: 0 };
calls.forEach((call) => {
  if (byType.hasOwnProperty(call.callType)) {
    byType[call.callType]++;
  }
});

console.log("By call type:");
Object.entries(byType).forEach(([type, count]) => {
  console.log(`  ${type}: ${count}`);
});

// Show resolved vs unresolved
const resolvedCount = calls.filter((c) => c.isResolved).length;
console.log(`\nResolved: ${resolvedCount}/${calls.length}`);

// Show all calls
console.log("\nAll calls:");
calls.forEach((call, i) => {
  console.log(
    `  ${i + 1}. ${call.calleeIdentifier} (${call.callType}) [${call.isResolved ? "resolved" : "unresolved"}]`,
  );
});

// Show constructor calls specifically
console.log("\nConstructor calls:");
calls
  .filter((c) => c.callType === "constructor")
  .forEach((call, i) => {
    console.log(
      `  ${i + 1}. ${call.calleeIdentifier} [${call.isResolved ? "resolved" : "unresolved"}]`,
    );
  });

// Show method calls with this
console.log("\n'this.' method calls:");
calls
  .filter((c) => c.calleeIdentifier.startsWith("this."))
  .forEach((call, i) => {
    console.log(
      `  ${i + 1}. ${call.calleeIdentifier} [${call.isResolved ? "resolved" : "unresolved"}]`,
    );
  });
