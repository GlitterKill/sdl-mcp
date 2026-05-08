import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node.js";

const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
);

let rootUri = "";

connection.onRequest("initialize", (params) => {
  rootUri = params.rootUri ?? "";
  return {
    capabilities: {
      textDocumentSync: 1,
      definitionProvider: true,
    },
    serverInfo: {
      name: "sdl-mcp-mock-definition-server",
      version: "1.0.0",
    },
  };
});

connection.onNotification("initialized", () => undefined);
connection.onNotification("textDocument/didOpen", () => undefined);
connection.onNotification("textDocument/didChange", () => undefined);

connection.onRequest("textDocument/definition", () => {
  const normalizedRoot = rootUri.endsWith("/") ? rootUri : `${rootUri}/`;
  return {
    uri: new URL("src/target.ts", normalizedRoot).toString(),
    range: {
      start: { line: 0, character: 16 },
      end: { line: 0, character: 28 },
    },
  };
});

connection.onRequest("shutdown", () => null);
connection.onNotification("exit", () => process.exit(0));

connection.listen();
