import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node.js";

const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
);

connection.onRequest("initialize", () => ({
  capabilities: {
    documentSymbolProvider: true,
  },
  serverInfo: {
    name: "cancel-sensitive",
    version: "1.0.0",
  },
}));

connection.onNotification("initialized", () => undefined);
connection.onNotification("textDocument/didOpen", () => undefined);
connection.onNotification("$/cancelRequest", () => process.exit(42));
connection.onRequest(
  "textDocument/documentSymbol",
  () => new Promise(() => undefined),
);
connection.onRequest("shutdown", () => undefined);
connection.onNotification("exit", () => process.exit(0));

connection.listen();
