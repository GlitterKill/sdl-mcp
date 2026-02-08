import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { writeFileSync, rmSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import {
  parseFile,
  extractSkeletonFromNode,
  trimSkeletonToBounds,
} from "../dist/code/skeleton.js";

describe("Skeleton Generator Unit Tests", () => {
  const testDir = join(process.cwd(), "test-fixtures");

  beforeEach(() => {
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }

    const functionFile = `
export function calculateSum(a: number, b: number): number {
  const result = a + b;
  console.log("Adding", a, "and", b);
  return result;
}

export async function fetchData(url: string): Promise<any> {
  try {
    const response = await fetch(url);
    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Failed to fetch:", error);
    throw error;
  }
}

export function complexLogic(items: Item[]): Item[] {
  const results: Item[] = [];
  
  for (const item of items) {
    if (item.isValid) {
      const processed = processItem(item);
      results.push(processed);
    } else {
      console.warn("Invalid item:", item);
    }
  }
  
  return results;
}
    `.trim();

    const classFile = `
export class UserService {
  private userRepository: UserRepository;
  
  constructor(repo: UserRepository) {
    this.userRepository = repo;
  }
  
  async getUser(id: string): Promise<User> {
    const user = await this.userRepository.findById(id);
    if (!user) {
      throw new Error("User not found");
    }
    return user;
  }
  
  async createUser(data: CreateUserDto): Promise<User> {
    const hashedPassword = await hashPassword(data.password);
    const user = await this.userRepository.create({
      ...data,
      password: hashedPassword,
    });
    return user;
  }
}
    `.trim();

    const interfaceFile = `
export interface Item {
  id: string;
  isValid: boolean;
}

export type ItemStatus = "pending" | "completed" | "failed";

export enum Priority {
  Low = 1,
  Medium = 2,
  High = 3,
}
    `.trim();

    writeFileSync(join(testDir, "functions.ts"), functionFile);
    writeFileSync(join(testDir, "class.ts"), classFile);
    writeFileSync(join(testDir, "types.ts"), interfaceFile);
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("skeleton file parsing", () => {
    it("should be able to parse TypeScript files", () => {
      const content = `export function test() { return 42; }`;
      const tree = parseFile(content, ".ts");
      assert.ok(tree, "Should parse TypeScript file");
      assert.ok(tree.rootNode, "Should have root node");
    });

    it("should handle parse errors gracefully", () => {
      const content = `export function test( { return 42; }`;
      const tree = parseFile(content, ".ts");
      assert.ok(
        tree === null || tree.rootNode.hasError,
        "Should handle parse errors",
      );
    });

    it("should support multiple file extensions", () => {
      const content = `export const x = 1;`;

      const tsTree = parseFile(content, ".ts");
      const jsTree = parseFile(content, ".js");
      const tsxTree = parseFile(content, ".tsx");
      const jsxTree = parseFile(content, ".jsx");

      assert.ok(tsTree, "Should parse .ts files");
      assert.ok(jsTree, "Should parse .js files");
      assert.ok(tsxTree, "Should parse .tsx files");
      assert.ok(jsxTree, "Should parse .jsx files");
    });
  });

  describe("skeleton extraction logic", () => {
    it("should preserve export statements", () => {
      const content = `export interface Test {}\nexport type TestType = string;`;
      const tree = parseFile(content, ".ts");
      assert.ok(tree);

      const skeleton = extractSkeletonFromNode(tree.rootNode, content, []);
      assert.ok(
        skeleton.includes("export"),
        "Should preserve export statements",
      );
      assert.ok(
        skeleton.includes("interface"),
        "Should preserve interface declarations",
      );
      assert.ok(skeleton.includes("type"), "Should preserve type declarations");
    });

    it("should preserve function signatures", () => {
      const content = `export function test(a: number, b: string): boolean {\n  return a > 0;\n}`;
      const tree = parseFile(content, ".ts");
      assert.ok(tree);

      const skeleton = extractSkeletonFromNode(tree.rootNode, content, []);
      assert.ok(skeleton.includes("function"), "Should have function keyword");
      assert.ok(skeleton.includes("test"), "Should have function name");
      assert.ok(skeleton.includes("a: number"), "Should have parameter types");
      assert.ok(skeleton.includes("boolean"), "Should have return type");
    });

    it("should preserve control flow statements", () => {
      const content = `export function test(x: number) {\n  if (x > 0) {\n    return true;\n  } else {\n    return false;\n  }\n}`;
      const tree = parseFile(content, ".ts");
      assert.ok(tree);

      const skeleton = extractSkeletonFromNode(tree.rootNode, content, []);
      const skeletonLower = skeleton.toLowerCase();
      assert.ok(skeletonLower.includes("if"), "Should preserve if statement");
      assert.ok(
        skeletonLower.includes("else"),
        "Should preserve else statement",
      );
      assert.ok(
        skeletonLower.includes("return"),
        "Should preserve return statements",
      );
    });

    it("should elide dense function bodies with // …", () => {
      const content = `export function test() {\n  const x = 1;\n  const y = 2;\n  const z = 3;\n  const w = 4;\n  const v = 5;\n  const u = 6;\n  return x + y + z + w + v + u;\n}`;
      const tree = parseFile(content, ".ts");
      assert.ok(tree);

      const skeleton = extractSkeletonFromNode(tree.rootNode, content, []);
      assert.ok(
        skeleton.includes("// …") || skeleton.length < content.length,
        "Should elide or shorten body",
      );
    });

    it("should preserve try-catch-finally blocks", () => {
      const content = `export function test() {\n  try {\n    doWork();\n  } catch (err) {\n    handleError(err);\n  } finally {\n    cleanup();\n  }\n}`;
      const tree = parseFile(content, ".ts");
      assert.ok(tree);

      const skeleton = extractSkeletonFromNode(tree.rootNode, content, []);
      const skeletonLower = skeleton.toLowerCase();
      assert.ok(skeletonLower.includes("try"), "Should preserve try");
      assert.ok(skeletonLower.includes("catch"), "Should preserve catch");
      assert.ok(skeletonLower.includes("finally"), "Should preserve finally");
    });

    it("should preserve for and while loops", () => {
      const content = `export function test(items: any[]) {\n  for (const item of items) {\n    process(item);\n  }\n  let i = 0;\n  while (i < 10) {\n    i++;\n  }\n}`;
      const tree = parseFile(content, ".ts");
      assert.ok(tree);

      const skeleton = extractSkeletonFromNode(tree.rootNode, content, []);
      const skeletonLower = skeleton.toLowerCase();
      assert.ok(skeletonLower.includes("for"), "Should preserve for loop");
      assert.ok(skeletonLower.includes("while"), "Should preserve while loop");
    });

    it("should handle class declarations", () => {
      const content = `export class Test {\n  constructor(private x: number) {}\n  method() { return this.x; }\n}`;
      const tree = parseFile(content, ".ts");
      assert.ok(tree);

      const skeleton = extractSkeletonFromNode(tree.rootNode, content, []);
      assert.ok(
        skeleton.includes("class"),
        "Should preserve class declaration",
      );
      assert.ok(skeleton.includes("Test"), "Should preserve class name");
      assert.ok(
        skeleton.includes("constructor"),
        "Should preserve constructor",
      );
    });

    it("should be deterministic for same input", () => {
      const content = `export function test(a: number) {\n  if (a > 0) return true;\n  return false;\n}`;
      const tree1 = parseFile(content, ".ts");
      const tree2 = parseFile(content, ".ts");

      const skeleton1 = extractSkeletonFromNode(tree1!.rootNode, content, []);
      const skeleton2 = extractSkeletonFromNode(tree2!.rootNode, content, []);

      assert.strictEqual(
        skeleton1,
        skeleton2,
        "Skeleton should be deterministic",
      );
    });

    it("should include return and throw statements", () => {
      const content = `export function test(x: number) {\n  if (x < 0) throw new Error("negative");\n  return x * 2;\n}`;
      const tree = parseFile(content, ".ts");
      assert.ok(tree);

      const skeleton = extractSkeletonFromNode(tree.rootNode, content, []);
      const skeletonLower = skeleton.toLowerCase();
      assert.ok(skeletonLower.includes("throw"), "Should preserve throw");
      assert.ok(skeletonLower.includes("return"), "Should preserve return");
    });
  });

  describe("skeleton truncation", () => {
    it("should respect maxLines limit", () => {
      const content = Array(20).fill("line 1").join("\n");
      const { code, truncated } = trimSkeletonToBounds(content, 5, 10000);

      const lines = code.split("\n");
      assert.ok(
        lines.length <= 5,
        `Should respect maxLines: got ${lines.length}`,
      );
      assert.ok(truncated, "Should be marked as truncated");
    });

    it("should respect maxTokens limit", () => {
      const longLine = "a".repeat(1000);
      const content = `${longLine}\n${longLine}\n${longLine}`;
      const { code, truncated } = trimSkeletonToBounds(content, 10000, 100);

      assert.ok(code.length < content.length, "Should shorten content");
      assert.ok(truncated, "Should be marked as truncated");
    });

    it("should not truncate when within limits", () => {
      const content = "line 1\nline 2\nline 3";
      const { code, truncated } = trimSkeletonToBounds(content, 10, 1000);

      assert.strictEqual(code, content, "Should not modify content");
      assert.strictEqual(truncated, false, "Should not be marked as truncated");
    });
  });

  describe("acceptance criteria", () => {
    it("should be deterministic for same input (AC1)", () => {
      const content = `export function test(a: number, b: number) {\n  return a + b;\n}`;
      const tree1 = parseFile(content, ".ts");
      const tree2 = parseFile(content, ".ts");

      const skeleton1 = extractSkeletonFromNode(tree1!.rootNode, content, []);
      const skeleton2 = extractSkeletonFromNode(tree2!.rootNode, content, []);

      assert.strictEqual(
        skeleton1,
        skeleton2,
        "AC1: Skeleton should be deterministic",
      );
    });

    it("should be cheaper than raw code (AC2)", () => {
      const content = `export function test() {\n  const x = 1;\n  const y = 2;\n  const z = 3;\n  const w = 4;\n  const v = 5;\n  const u = 6;\n  return x + y + z + w + v + u;\n}`;
      const tree = parseFile(content, ".ts");
      assert.ok(tree);

      const skeleton = extractSkeletonFromNode(tree.rootNode, content, []);

      const rawLength = content.length;
      const skeletonLength = skeleton.length;
      const ratio = skeletonLength / rawLength;

      assert.ok(
        ratio <= 0.5,
        `AC2: Skeleton should be cheaper than raw: ${(ratio * 100).toFixed(1)}%`,
      );
    });

    it("should preserve important identifiers when requested (AC3)", () => {
      const content = `export function test() {\n  const fetchUrl = "http://example.com";\n  const processItem = (x) => x;\n  return processItem(fetchUrl);\n}`;
      const tree = parseFile(content, ".ts");
      assert.ok(tree);

      const skeleton = extractSkeletonFromNode(tree.rootNode, content, [
        "fetchUrl",
        "processItem",
      ]);

      assert.ok(
        skeleton.includes("fetchUrl") || skeleton.includes("processItem"),
        "AC3: Should include at least one important identifier",
      );
    });
  });
});
