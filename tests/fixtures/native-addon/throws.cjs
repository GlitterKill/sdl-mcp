module.exports = {
  parseFiles() {
    throw new Error("synthetic native parse failure");
  },
  hashContentNative() {
    return "stub-hash";
  },
  generateSymbolIdNative() {
    return "stub-id";
  },
};

