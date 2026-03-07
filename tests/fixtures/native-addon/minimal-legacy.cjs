module.exports = {
  parseFiles(files) {
    return files.map((file) => ({
      relPath: file.relPath,
      contentHash: "stub-hash",
      symbols: [
        {
          symbolId: "legacy-symbol",
          astFingerprint: "legacy-fingerprint",
          kind: "function",
          name: "handleLegacy",
          exported: true,
          visibility: "public",
          range: {
            startLine: 1,
            startCol: 0,
            endLine: 2,
            endCol: 0,
          },
          signature: undefined,
          summary: "Legacy handler",
          invariants: [],
          sideEffects: [],
          roleTags: [],
          searchText: "",
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
