module.exports = {
  parseFiles(files) {
    return files.map((file) => ({
      relPath: file.relPath,
      contentHash: "stub-hash",
      symbols: [],
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

