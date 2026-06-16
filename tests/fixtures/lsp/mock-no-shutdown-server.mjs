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
    name: "no-shutdown",
    version: "1.0.0",
  },
}));

connection.onNotification("initialized", () => undefined);
connection.onRequest("shutdown", () => new Promise(() => undefined));
connection.onNotification("exit", () => process.exit(0));

connection.listen();
