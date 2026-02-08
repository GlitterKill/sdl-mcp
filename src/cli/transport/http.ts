import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { MCPServer } from "../../server.js";
import { getDb } from "../../db/db.js";

export async function setupHttpTransport(
  server: MCPServer,
  host: string,
  port: number,
  dbPath: string,
): Promise<void> {
  const sessions = new Map<string, SSEServerTransport>();
  let activeSseTransport: SSEServerTransport | null = null;

  const checkHealth = (): boolean => {
    try {
      const db = getDb(dbPath);
      db.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  };

  const httpServer = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://${host}:${port}`);
      const pathname = url.pathname;

      if (req.method === "GET" && pathname === "/health") {
        const isHealthy = checkHealth();
        const status = isHealthy ? 200 : 503;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: isHealthy ? "ok" : "unhealthy",
            timestamp: Date.now(),
          }),
        );
        return;
      }

      if (req.method === "GET" && pathname === "/sse") {
        const accept = Array.isArray(req.headers.accept)
          ? req.headers.accept.join(",")
          : (req.headers.accept ?? "");
        if (!accept.toLowerCase().includes("text/event-stream")) {
          res.writeHead(406);
          res.end("Accept header must include text/event-stream");
          return;
        }

        if (activeSseTransport) {
          const staleTransport = activeSseTransport;
          sessions.delete(staleTransport.sessionId);
          activeSseTransport = null;
          void staleTransport.close().catch(() => {
            // Ignore stale transport close errors.
          });
        }

        const sseTransport = new SSEServerTransport("/message", res);
        activeSseTransport = sseTransport;
        sessions.set(sseTransport.sessionId, sseTransport);

        sseTransport.onclose = () => {
          sessions.delete(sseTransport.sessionId);
          if (activeSseTransport === sseTransport) {
            activeSseTransport = null;
          }
        };

        void server
          .getServer()
          .connect(sseTransport)
          .catch((error) => {
            console.error(`Failed to establish SSE transport: ${error}`);
            sessions.delete(sseTransport.sessionId);
            if (activeSseTransport === sseTransport) {
              activeSseTransport = null;
            }
            if (!res.headersSent) {
              res.writeHead(500);
              res.end("Failed to establish SSE transport");
            }
          });
        return;
      }

      if (req.method === "POST" && pathname === "/message") {
        const sessionId = url.searchParams.get("sessionId");
        if (!sessionId) {
          res.writeHead(400);
          res.end("Missing sessionId");
          return;
        }

        const transport = sessions.get(sessionId);
        if (!transport) {
          res.writeHead(404);
          res.end("Unknown sessionId");
          return;
        }

        void transport.handlePostMessage(req, res).catch((error) => {
          console.error(`Failed to process SSE POST message: ${error}`);
          if (!res.headersSent) {
            res.writeHead(500);
            res.end("Failed to process message");
          }
        });
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    },
  );

  httpServer.listen(port, host, () => {
    console.error(`HTTP server listening on http://${host}:${port}`);
    console.error(`  - SSE endpoint: http://${host}:${port}/sse`);
    console.error(`  - Health check: http://${host}:${port}/health`);
  });

  return new Promise((resolve_) => {
    httpServer.on("close", resolve_);
  });
}
