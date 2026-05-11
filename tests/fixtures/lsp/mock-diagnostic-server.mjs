import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node.js";

const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
);

const openDocuments = new Set();
let sawDiagnosticCapability = false;

connection.onRequest("initialize", (params) => {
  sawDiagnosticCapability = Boolean(
    params.capabilities?.textDocument?.diagnostic,
  );
  return {
    capabilities: {
      textDocumentSync: 1,
      diagnosticProvider: {
        interFileDependencies: false,
        workspaceDiagnostics: false,
      },
    },
    serverInfo: {
      name: "sdl-mcp-mock-diagnostic-server",
      version: "1.0.0",
    },
  };
});

connection.onNotification("initialized", () => undefined);
connection.onNotification("textDocument/didOpen", (params) => {
  openDocuments.add(params.textDocument.uri);
});

connection.onRequest("textDocument/diagnostic", (params) => ({
  kind: "full",
  items: [
    {
      range: {
        start: { line: 0, character: 4 },
        end: { line: 0, character: 11 },
      },
      severity: 2,
      code: "PULL001",
      source: sawDiagnosticCapability
        ? "client-capability-advertised"
        : "client-capability-missing",
      message: openDocuments.has(params.textDocument.uri)
        ? "Pulled diagnostic"
        : "Document was not opened",
    },
  ],
}));

connection.onRequest("shutdown", () => null);
connection.onNotification("exit", () => process.exit(0));

connection.listen();
