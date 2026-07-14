import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const rustSource = readFileSync("native/src/windows_loader.rs", "utf8");
const dtsSource = readFileSync("native/index.d.ts", "utf8");

describe("native Windows library loader contract", () => {
  it("uses scoped LoadLibraryExW flags and avoids global search-path mutation", () => {
    assert.match(rustSource, /LoadLibraryExW/u);
    assert.match(rustSource, /LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR/u);
    assert.match(rustSource, /LOAD_LIBRARY_SEARCH_DEFAULT_DIRS/u);
    assert.doesNotMatch(rustSource, /SetDllDirectory|AddDllDirectory|PATH\s*=/u);
  });

  it("keeps JS tokens separate from native module handles", () => {
    assert.match(rustSource, /HashMap<u32,\s*isize>/u);
    assert.match(rustSource, /next_token/u);
    assert.doesNotMatch(rustSource, /token\s+as\s+(?:HMODULE|isize|usize|\*)/u);
  });

  it("declares stable napi preload and release functions", () => {
    assert.match(dtsSource, /export interface PreloadedWindowsLibrary/u);
    assert.match(dtsSource, /token: number/u);
    assert.match(dtsSource, /loadedPath: string/u);
    assert.match(dtsSource, /export declare function preloadWindowsLibrary\(absolutePath: string\): PreloadedWindowsLibrary/u);
    assert.match(dtsSource, /export declare function releaseWindowsLibrary\(token: number\): void/u);
  });
});
