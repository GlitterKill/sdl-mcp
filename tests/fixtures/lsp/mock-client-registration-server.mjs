import {
  createMessageConnection,
  NotificationType,
  RequestType,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node.js";

const RegisterCapabilityRequest = new RequestType(
  "client/registerCapability",
);
const DocumentSymbolRequest = new RequestType("textDocument/documentSymbol");
const InitializedNotification = new NotificationType("initialized");

const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
);

let registered = false;

connection.onRequest("initialize", () => ({
  capabilities: {
    documentSymbolProvider: true,
  },
  serverInfo: {
    name: "client-registration",
    version: "1.0.0",
  },
}));

connection.onNotification(InitializedNotification, async () => {
  await connection.sendRequest(RegisterCapabilityRequest, {
    registrations: [
      {
        id: "symbols",
        method: DocumentSymbolRequest.method,
        registerOptions: {},
      },
    ],
  });
  registered = true;
});

connection.onNotification("textDocument/didOpen", () => undefined);
connection.onRequest(DocumentSymbolRequest, () =>
  registered
    ? [
        {
          name: "RegisteredSymbol",
          kind: 12,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 16 },
          },
          selectionRange: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 16 },
          },
        },
      ]
    : null,
);
connection.onRequest("shutdown", () => undefined);
connection.onNotification("exit", () => process.exit(0));

connection.listen();
