module.exports = {
  parseFiles(files) {
    return files.map((file) => ({
      relPath: file.relPath,
      contentHash: "stub-hash",
      symbols: [
        {
          symbolId: "stub-symbol",
          astFingerprint: "stub-fingerprint",
          kind: "function",
          name: "handleLogin",
          exported: true,
          visibility: "public",
          range: {
            startLine: 1,
            startCol: 0,
            endLine: 3,
            endCol: 1,
          },
          signature: {
            params: [{ name: "request", typeName: "Request" }],
            returns: "Promise<Response>",
          },
          summary: "Handle login requests",
          invariants: ["@param request: must be authenticated"],
          sideEffects: ["Network I/O"],
          roleTags: ["handler", "entrypoint"],
          searchText: "handle login requests handler entrypoint auth request",
        },
      ],
      imports: [],
      calls: [],
      parseError: null,
    }));
  },
  hashContentNative() {
    return "stub-hash";
  },
  generateSymbolIdNative() {
    return "stub-id";
  },
};
