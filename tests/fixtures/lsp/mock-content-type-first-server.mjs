let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const separator = buffer.indexOf("\r\n\r\n");
    if (separator === -1) return;
    const header = buffer.subarray(0, separator).toString("ascii");
    const match = /content-length\s*:\s*(\d+)/iu.exec(header);
    if (!match) return;
    const length = Number.parseInt(match[1], 10);
    const bodyStart = separator + 4;
    const messageEnd = bodyStart + length;
    if (buffer.length < messageEnd) return;
    const request = JSON.parse(
      buffer.subarray(bodyStart, messageEnd).toString("utf8"),
    );
    buffer = buffer.subarray(messageEnd);
    handleMessage(request);
  }
});

function handleMessage(request) {
  if (request.method === "initialize") {
    writeResponse(request.id, {
      capabilities: {
        documentSymbolProvider: true,
      },
      serverInfo: {
        name: "content-type-first",
        version: "1.0.0",
      },
    });
    return;
  }
  if (request.method === "shutdown") {
    writeResponse(request.id, null);
    return;
  }
  if (request.method === "exit") {
    process.exit(0);
  }
}

function writeResponse(id, result) {
  const response = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(
    `Content-Type: application/vscode-jsonrpc; charset=utf8\r\nContent-Length: ${Buffer.byteLength(response)}\r\n\r\n${response}`,
  );
}
