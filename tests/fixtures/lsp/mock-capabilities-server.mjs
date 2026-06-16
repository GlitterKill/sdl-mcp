import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node.js";

const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
);

connection.onRequest("initialize", (params) => {
  const capabilities = params.capabilities ?? {};
  const textDocument = capabilities.textDocument ?? {};
  const hasStandardCapabilities = Boolean(
    textDocument.rename &&
      textDocument.documentSymbol &&
      textDocument.definition &&
      textDocument.references &&
      capabilities.workspace?.workspaceFolders === true &&
      capabilities.general?.positionEncodings?.includes("utf-16"),
  );

  return {
    capabilities: {},
    serverInfo: {
      name: "capabilities-server",
      version: hasStandardCapabilities ? "standard" : "sparse",
    },
  };
});

connection.onNotification("initialized", () => undefined);
connection.onRequest("shutdown", () => null);
connection.onNotification("exit", () => process.exit(0));
connection.listen();
