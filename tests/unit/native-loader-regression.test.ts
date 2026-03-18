import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

describe("native loader regression", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const originalArch = Object.getOwnPropertyDescriptor(process, "arch");
  const originalLoad = require("node:module")._load;

  afterEach(() => {
    require("node:module")._load = originalLoad;
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
    if (originalArch) {
      Object.defineProperty(process, "arch", originalArch);
    }
  });

  it("selects the musl package on linux arm64 when musl is detected", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    Object.defineProperty(process, "arch", { value: "arm64" });

    let requestedPackage: string | null = null;
    require("node:module")._load = function (
      request: string,
      parent: unknown,
      isMain: boolean,
    ) {
      if (request === "fs") {
        return {
          existsSync: () => false,
          readFileSync: (path: string) => {
            if (path === "/usr/bin/ldd") {
              return "musl";
            }
            throw new Error(`unexpected read: ${path}`);
          },
        };
      }

      if (request.startsWith("sdl-mcp-native-")) {
        requestedPackage = request;
        return {
          parseFiles() {},
          hashContentNative() {},
          generateSymbolIdNative() {},
        };
      }

      return originalLoad.call(this, request, parent, isMain);
    };

    const loader = require("../../native/index.js") as {
      parseFiles: () => void;
    };

    assert.equal(requestedPackage, "sdl-mcp-native-linux-arm64-musl");
    assert.equal(typeof loader.parseFiles, "function");
  });
});
