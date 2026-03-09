import { existsSync, readFileSync } from "fs";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { join } from "path";
import { fileURLToPath } from "url";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { Connection } from "kuzu";
import { MCPServer } from "../../server.js";
import * as kuzuDb from "../../db/kuzu-queries.js";
import { computeDelta } from "../../delta/diff.js";
import { runGovernorLoop } from "../../delta/blastRadius.js";
import { getKuzuConn, initKuzuDb } from "../../db/kuzu.js";
import { indexRepo } from "../../indexer/indexer.js";
import {
  BufferCheckpointRequestSchema,
  BufferPushRequestSchema,
} from "../../mcp/tools.js";
import {
  handleSymbolGetCard,
  handleSymbolSearch,
} from "../../mcp/tools/symbol.js";
import {
  getDefaultLiveIndexCoordinator,
} from "../../live-index/coordinator.js";
import type { LiveIndexCoordinator } from "../../live-index/types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const UI_DIR = join(__dirname, "..", "..", "ui");

type GraphNode = {
  id: string;
  label: string;
  kind: string;
  file?: string;
  fanIn?: number;
  fanOut?: number;
  size?: number;
  cluster?: string;
};

type GraphLink = {
  source: string;
  target: string;
  type: string;
  weight: number;
};

export type LiveIndexApiRequest = {
  method?: string;
  pathname: string;
  body?: unknown;
};

type LiveIndexApiResponse = {
  status: number;
  payload: unknown;
};

type HttpTransportServices = {
  liveIndex?: LiveIndexCoordinator;
};

const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function setCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin ?? "";
  if (LOCALHOST_ORIGIN_RE.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    totalBytes += buf.length;
    if (totalBytes > MAX_BODY_BYTES) {
      // Drain remaining chunks to prevent connection issues
      req.destroy();
      throw new Error(`Request body too large (limit: ${MAX_BODY_BYTES} bytes)`);
    }
    chunks.push(buf);
  }

  if (chunks.length === 0) {
    return {};
  }

  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (!body) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Invalid JSON in request body");
  }
}

export async function routeLiveIndexApiRequest(
  request: LiveIndexApiRequest,
  services: HttpTransportServices = {},
): Promise<LiveIndexApiResponse | null> {
  const method = request.method ?? "GET";
  const liveIndex = services.liveIndex ?? getDefaultLiveIndexCoordinator();
  const bufferMatch = request.pathname.match(/^\/api\/repo\/([^/]+)\/buffer$/);
  if (method === "POST" && bufferMatch) {
    try {
      const [, repoId] = bufferMatch;
      const parsed = BufferPushRequestSchema.parse({
        ...(request.body as Record<string, unknown> | undefined),
        repoId: decodeURIComponent(repoId),
      });
      const result = await liveIndex.pushBufferUpdate(parsed);
      return {
        status: 202,
        payload: result,
      };
    } catch (error) {
      return {
        status: 400,
        payload: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  const checkpointMatch = request.pathname.match(
    /^\/api\/repo\/([^/]+)\/checkpoint$/,
  );
  if (method === "POST" && checkpointMatch) {
    try {
      const [, repoId] = checkpointMatch;
      const parsed = BufferCheckpointRequestSchema.parse({
        ...(request.body as Record<string, unknown> | undefined),
        repoId: decodeURIComponent(repoId),
      });
      const result = await liveIndex.checkpointRepo(parsed);
      return {
        status: 202,
        payload: result,
      };
    } catch (error) {
      return {
        status: 400,
        payload: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  const liveStatusMatch = request.pathname.match(
    /^\/api\/repo\/([^/]+)\/live-status$/,
  );
  if (method === "GET" && liveStatusMatch) {
    const [, repoId] = liveStatusMatch;
    return {
      status: 200,
      payload: await liveIndex.getLiveStatus(decodeURIComponent(repoId)),
    };
  }

  return null;
}

function toClusterPath(filePath: string): string {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (slash === -1) {
    return "root";
  }
  return filePath.slice(0, slash) || "root";
}

async function buildNodes(
  conn: Connection,
  symbolIds: string[],
): Promise<GraphNode[]> {
  const symbolMap = await kuzuDb.getSymbolsByIds(conn, symbolIds);
  const metricsMap = await kuzuDb.getMetricsBySymbolIds(conn, symbolIds);

  const fileIds = new Set<string>();
  for (const symbol of symbolMap.values()) {
    fileIds.add(symbol.fileId);
  }
  const fileMap = await kuzuDb.getFilesByIds(conn, Array.from(fileIds));

  const nodes: GraphNode[] = [];
  for (const symbolId of symbolIds) {
    const symbol = symbolMap.get(symbolId);
    if (!symbol) continue;
    const file = fileMap.get(symbol.fileId);
    const metrics = metricsMap.get(symbolId);

    nodes.push({
      id: symbolId,
      label: symbol.name,
      kind: symbol.kind,
      file: file?.relPath,
      fanIn: metrics?.fanIn,
      fanOut: metrics?.fanOut,
      size: Math.max(5, Math.min(40, (metrics?.fanIn ?? 0) + 6)),
      cluster: toClusterPath(file?.relPath ?? ""),
    });
  }

  return nodes;
}

async function buildLinksForNodes(
  conn: Connection,
  ids: Set<string>,
): Promise<GraphLink[]> {
  const idList = Array.from(ids);
  const edgeMap = await kuzuDb.getEdgesFromSymbolsForSlice(conn, idList);

  const links: GraphLink[] = [];
  for (const fromSymbolId of idList) {
    const edges = edgeMap.get(fromSymbolId) ?? [];
    for (const edge of edges) {
      if (!ids.has(edge.toSymbolId)) continue;
      links.push({
        source: fromSymbolId,
        target: edge.toSymbolId,
        type: edge.edgeType,
        weight: edge.weight,
      });
    }
  }
  return links;
}

function collapseClusters(
  nodes: GraphNode[],
  maxChildrenPerCluster = 10,
): GraphNode[] {
  const byCluster = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const key = node.cluster ?? "root";
    const list = byCluster.get(key) ?? [];
    list.push(node);
    byCluster.set(key, list);
  }

  const collapsed: GraphNode[] = [];
  for (const [cluster, list] of byCluster) {
    if (list.length <= maxChildrenPerCluster) {
      collapsed.push(...list);
      continue;
    }
    const sorted = [...list].sort((a, b) => (b.fanIn ?? 0) - (a.fanIn ?? 0));
    collapsed.push(...sorted.slice(0, maxChildrenPerCluster));
    collapsed.push({
      id: `cluster:${cluster}`,
      label: `${cluster} (+${list.length - maxChildrenPerCluster})`,
      kind: "module",
      cluster,
      size: 10,
    });
  }

  return collapsed;
}

async function buildNeighborhood(
  conn: Connection,
  symbolId: string,
  maxNodes: number,
): Promise<{
  nodes: GraphNode[];
  links: GraphLink[];
}> {
  const ids = new Set<string>();
  ids.add(symbolId);

  for (const edge of await kuzuDb.getEdgesFrom(conn, symbolId)) {
    ids.add(edge.toSymbolId);
  }
  const edgesTo = await kuzuDb.getEdgesToSymbols(conn, [symbolId]);
  for (const edge of edgesTo.get(symbolId) ?? []) {
    ids.add(edge.fromSymbolId);
  }

  const limited = new Set(Array.from(ids).slice(0, maxNodes));
  const nodes = await buildNodes(conn, Array.from(limited));
  const links = await buildLinksForNodes(conn, limited);

  return {
    nodes: collapseClusters(nodes),
    links,
  };
}

async function buildRepoPreview(
  conn: Connection,
  repoId: string,
  maxNodes: number,
): Promise<{
  nodes: GraphNode[];
  links: GraphLink[];
}> {
  const top = await kuzuDb.getTopSymbolsByFanIn(conn, repoId, maxNodes);
  const symbolIds = top.map((row) => row.symbolId);
  const ids = new Set(symbolIds);
  const nodes = await buildNodes(conn, symbolIds);
  const links = await buildLinksForNodes(conn, ids);

  return {
    nodes: collapseClusters(nodes),
    links,
  };
}

async function buildBlastRadiusGraph(
  conn: Connection,
  repoId: string,
  fromVersion: string,
  toVersion: string,
  maxNodes: number,
): Promise<{ nodes: GraphNode[]; links: GraphLink[] }> {
  const delta = await computeDelta(repoId, fromVersion, toVersion);
  const changedSymbolIds = delta.changedSymbols.map((change) => change.symbolId);
  const governor = await runGovernorLoop(conn, changedSymbolIds, {
    repoId,
    budget: { maxCards: maxNodes, maxEstimatedTokens: 4000 },
    runDiagnostics: false,
  });

  const ids = new Set<string>();
  for (const changed of delta.changedSymbols) {
    ids.add(changed.symbolId);
  }
  for (const affected of governor.blastRadius) {
    ids.add(affected.symbolId);
  }

  const limited = new Set(Array.from(ids).slice(0, maxNodes));
  const nodes = await buildNodes(conn, Array.from(limited));
  const links = await buildLinksForNodes(conn, limited);

  return {
    nodes: collapseClusters(nodes),
    links,
  };
}

function serveUiAsset(pathname: string, res: ServerResponse): boolean {
  const map: Record<string, { file: string; type: string }> = {
    "/ui/graph": { file: "graph.html", type: "text/html; charset=utf-8" },
    "/ui/graph.js": { file: "graph.js", type: "application/javascript; charset=utf-8" },
    "/ui/graph.css": { file: "graph.css", type: "text/css; charset=utf-8" },
  };

  const asset = map[pathname];
  if (!asset) {
    return false;
  }

  const fullPath = join(UI_DIR, asset.file);
  if (!existsSync(fullPath)) {
    json(res, 404, { error: `UI asset not found: ${asset.file}` });
    return true;
  }

  res.writeHead(200, { "Content-Type": asset.type });
  res.end(readFileSync(fullPath));
  return true;
}

async function handleRestRequest(
  req: IncomingMessage,
  res: ServerResponse,
  host: string,
  port: number,
  checkHealth: () => Promise<boolean>,
  conn: Connection,
  services: HttpTransportServices,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${host}:${port}`);
  const pathname = url.pathname;

  if (pathname.startsWith("/api/")) {
    setCorsHeaders(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return true;
    }
  }

  if (req.method === "GET" && pathname === "/health") {
    const isHealthy = await checkHealth();
    json(res, isHealthy ? 200 : 503, {
      status: isHealthy ? "ok" : "unhealthy",
      timestamp: Date.now(),
    });
    return true;
  }

  if (req.method === "GET" && serveUiAsset(pathname, res)) {
    return true;
  }

  if (/^\/api\/repo\/[^/]+\/(?:buffer|checkpoint|live-status)$/.test(pathname)) {
    const body = req.method === "POST" ? await readJsonBody(req) : undefined;
    const response = await routeLiveIndexApiRequest(
      {
        method: req.method,
        pathname,
        body,
      },
      services,
    );
    if (response) {
      json(res, response.status, response.payload);
      return true;
    }
  }

  const graphSliceMatch = pathname.match(/^\/api\/graph\/([^/]+)\/slice\/([^/]+)$/);
  if (req.method === "GET" && graphSliceMatch) {
    const [, repoId, handle] = graphSliceMatch;
    const maxNodes = Number(url.searchParams.get("maxNodes") ?? "200");
    const graph = await buildRepoPreview(
      conn,
      repoId,
      Math.min(500, Math.max(10, maxNodes)),
    );
    const handleRow = await kuzuDb.getSliceHandle(conn, handle);
    json(res, 200, {
      repoId,
      handle,
      handleMetadata: handleRow
        ? {
            createdAt: handleRow.createdAt,
            expiresAt: handleRow.expiresAt,
            minVersion: handleRow.minVersion,
            maxVersion: handleRow.maxVersion,
          }
        : null,
      ...graph,
    });
    return true;
  }

  const graphNeighborhoodMatch = pathname.match(
    /^\/api\/graph\/([^/]+)\/symbol\/([^/]+)\/neighborhood$/,
  );
  if (req.method === "GET" && graphNeighborhoodMatch) {
    const [, repoId, symbolId] = graphNeighborhoodMatch;
    const maxNodes = Number(url.searchParams.get("maxNodes") ?? "200");
    const graph = await buildNeighborhood(
      conn,
      decodeURIComponent(symbolId),
      Math.min(500, Math.max(10, maxNodes)),
    );
    json(res, 200, { repoId, symbolId: decodeURIComponent(symbolId), ...graph });
    return true;
  }

  const graphBlastMatch = pathname.match(
    /^\/api\/graph\/([^/]+)\/blast-radius\/([^/]+)\/([^/]+)$/,
  );
  if (req.method === "GET" && graphBlastMatch) {
    const [, repoId, fromVersion, toVersion] = graphBlastMatch;
    const maxNodes = Number(url.searchParams.get("maxNodes") ?? "200");
    const graph = await buildBlastRadiusGraph(
      conn,
      repoId,
      decodeURIComponent(fromVersion),
      decodeURIComponent(toVersion),
      Math.min(500, Math.max(10, maxNodes)),
    );
    json(res, 200, { repoId, fromVersion, toVersion, ...graph });
    return true;
  }

  const symbolSearchMatch = pathname.match(/^\/api\/symbol\/([^/]+)\/search$/);
  if (req.method === "GET" && symbolSearchMatch) {
    const [, repoId] = symbolSearchMatch;
    const query = (url.searchParams.get("q") ?? "").trim();
    const limit = Number(url.searchParams.get("limit") ?? "20");
    if (!query) {
      json(res, 200, { repoId, results: [] });
      return true;
    }
    const response = await handleSymbolSearch({
      repoId,
      query,
      limit: Math.min(100, Math.max(1, limit)),
    });
    json(res, 200, {
      repoId,
      results: response.results,
    });
    return true;
  }

  const symbolCardMatch = pathname.match(/^\/api\/symbol\/([^/]+)\/card\/([^/]+)$/);
  if (req.method === "GET" && symbolCardMatch) {
    const [, repoId, symbolIdRaw] = symbolCardMatch;
    const symbolId = decodeURIComponent(symbolIdRaw);
    const response = await handleSymbolGetCard({
      repoId,
      symbolId,
    });
    if ("notModified" in response) {
      json(res, 304, response);
      return true;
    }
    if (!response.card) {
      json(res, 404, { error: `Symbol not found: ${symbolId}` });
      return true;
    }
    json(res, 200, {
      symbolId,
      name: response.card.name,
      kind: response.card.kind,
      summary: response.card.summary,
      file: response.card.file,
      fanIn: response.card.metrics?.fanIn ?? 0,
      fanOut: response.card.metrics?.fanOut ?? 0,
    });
    return true;
  }

  const repoStatusMatch = pathname.match(/^\/api\/repo\/([^/]+)\/status$/);
  if (req.method === "GET" && repoStatusMatch) {
    const [, repoId] = repoStatusMatch;
    const repo = await kuzuDb.getRepo(conn, repoId);
    if (!repo) {
      json(res, 404, { error: `Repository not found: ${repoId}` });
      return true;
    }
    const latestVersion = await kuzuDb.getLatestVersion(conn, repoId);
    json(res, 200, {
      repoId,
      latestVersionId: latestVersion?.versionId ?? null,
      symbolCount: await kuzuDb.getSymbolCount(conn, repoId),
      fileCount: await kuzuDb.getFileCount(conn, repoId),
    });
    return true;
  }

  const repoReindexMatch = pathname.match(/^\/api\/repo\/([^/]+)\/reindex$/);
  if (req.method === "POST" && repoReindexMatch) {
    const [, repoId] = repoReindexMatch;
    const result = await indexRepo(repoId, "incremental");
    json(res, 200, {
      repoId,
      ok: true,
      versionId: result.versionId,
      changedFiles: result.changedFiles,
      durationMs: result.durationMs,
    });
    return true;
  }

  return false;
}

export async function setupHttpTransport(
  server: MCPServer,
  host: string,
  port: number,
  graphDbPath: string,
  services: HttpTransportServices = {},
): Promise<void> {
  const sessions = new Map<string, SSEServerTransport>();
  let activeSseTransport: SSEServerTransport | null = null;

  await initKuzuDb(graphDbPath);
  const conn = await getKuzuConn();

  const checkHealth = async (): Promise<boolean> => {
    try {
      const result = await conn.query("RETURN 1 AS ok");
      if (Array.isArray(result)) {
        for (const r of result) r.close();
      } else {
        result.close();
      }
      return true;
    } catch {
      return false;
    }
  };

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const handled = await handleRestRequest(
        req,
        res,
        host,
        port,
        checkHealth,
        conn,
        services,
      );
      if (handled) {
        return;
      }

      const url = new URL(req.url ?? "/", `http://${host}:${port}`);
      const pathname = url.pathname;

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
    })().catch((error) => {
      console.error(`HTTP transport error: ${String(error)}`);
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end("Internal server error");
    });
  });

  httpServer.listen(port, host, () => {
    console.error(`HTTP server listening on http://${host}:${port}`);
    console.error(`  - SSE endpoint: http://${host}:${port}/sse`);
    console.error(`  - Health check: http://${host}:${port}/health`);
    console.error(`  - Graph UI: http://${host}:${port}/ui/graph`);
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
      console.error(
        `\n  WARNING: Server is listening on ${host} over plaintext HTTP.` +
        `\n  Traffic (including code content) is NOT encrypted.` +
        `\n  Use localhost or add a TLS reverse proxy for production use.\n`,
      );
    }
  });

  return new Promise((resolve_) => {
    httpServer.on("close", resolve_);
  });
}
