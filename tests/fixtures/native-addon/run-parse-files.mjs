import { parseFilesRust } from "../../../src/indexer/rustIndexer.js";

const result = parseFilesRust(
  "chaos-test-repo",
  process.cwd(),
  [{ path: "src/foo.ts", size: 1, mtime: 0 }],
  0,
);

process.stdout.write(JSON.stringify(result));

