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
          signatureJson: JSON.stringify({
            params: [{ name: "request", type: "Request" }],
            returns: "Promise<Response>",
          }),
          summary: "Handle login requests",
          invariantsJson: JSON.stringify(["@param request: must be authenticated"]),
          sideEffectsJson: JSON.stringify(["Network I/O"]),
          roleTagsJson: JSON.stringify(["handler", "entrypoint"]),
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
