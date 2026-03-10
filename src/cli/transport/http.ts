import { existsSync, readFileSync } from "fs";
import { randomUUID } from "crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { join } from "path";
import { fileURLToPath } from "url";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  EventStore,
  StreamId,
  EventId,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  createMCPServer,
  MCPServer,
  type MCPServerServices,
} from "../../server.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import { computeDelta } from "../../delta/diff.js";
import { runGovernorLoop } from "../../delta/blastRadius.js";
import { getLadybugConn, initLadybugDb } from "../../db/ladybug.js";
import { indexRepo } from "../../indexer/indexer.js";
import {
  BufferCheckpointRequestSchema,
  BufferPushRequestSchema,
} from "../../mcp/tools.js";
import {
  handleSymbolGetCard,
  handleSymbolSearch,
} from "../../mcp/tools/symbol.js";
import { getDefaultLiveIndexCoordinator } from "../../live-index/coordinator.js";
import type { LiveIndexCoordinator } from "../../live-index/types.js";
import { SessionManager } from "../../mcp/session-manager.js";
import type { Connection } from "kuzu";

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
  sessionManager?: SessionManager;
};

const LOCALHOST_ORIGIN_RE =
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function setCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin ?? "";
  // Always set Vary: Origin so caches correctly differentiate responses
  // by origin, even when the origin doesn't match the allow-list.
  res.setHeader("Vary", "Origin");
  if (LOCALHOST_ORIGIN_RE.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Mcp-Session-Id",
  );
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
      // Consume and discard remaining data to avoid ECONNRESET on
      // keep-alive connections, then signal the error.
      req.resume();
      throw new Error(
        `Request body too large (limit: ${MAX_BODY_BYTES} bytes)`,
      );
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

// ---------------------------------------------------------------------------
// In-memory EventStore for StreamableHTTP resumability
// ---------------------------------------------------------------------------

class InMemoryEventStore implements EventStore {
  private events: Map<
    EventId,
    { streamId: StreamId; message: JSONRPCMessage }
  > = new Map();
  private counter = 0;
  private readonly maxEvents: number;

  constructor(maxEvents = 1000) {
    this.maxEvents = maxEvents;
  }

  async storeEvent(
    streamId: StreamId,
    message: JSONRPCMessage,
  ): Promise<EventId> {
    const eventId = `evt_${streamId}_${++this.counter}`;
    this.events.set(eventId, { streamId, message });

    // FIFO eviction when over capacity
    if (this.events.size > this.maxEvents) {
      const firstKey = this.events.keys().next().value;
      if (firstKey !== undefined) {
        this.events.delete(firstKey);
      }
    }
    return eventId;
  }

  async replayEventsAfter(
    lastEventId: EventId,
    {
      send,
    }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> },
  ): Promise<StreamId> {
    const entry = this.events.get(lastEventId);
    if (!entry) {
      // Event was evicted by FIFO — return an empty replay rather than
      // throwing, which would crash the SDK's resumability path (M4).
      return "" as StreamId;
    }

    const targetStreamId = entry.streamId;
    let found = false;

    for (const [id, evt] of this.events) {
      if (!found) {
        if (id === lastEventId) {
          found = true;
        }
        continue;
      }
      if (evt.streamId === targetStreamId) {
        await send(id, evt.message);
      }
    }

    return targetStreamId;
  }
}

// ---------------------------------------------------------------------------
// Live Index API routes
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Graph visualization helpers
// ---------------------------------------------------------------------------

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
  const symbolMap = await ladybugDb.getSymbolsByIds(conn, symbolIds);
  const metricsMap = await ladybugDb.getMetricsBySymbolIds(conn, symbolIds);

  const fileIds = new Set<string>();
  for (const symbol of symbolMap.values()) {
    fileIds.add(symbol.fileId);
  }
  const fileMap = await ladybugDb.getFilesByIds(conn, Array.from(fileIds));

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
  const edgeMap = await ladybugDb.getEdgesFromSymbolsForSlice(conn, idList);

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

  for (const edge of await ladybugDb.getEdgesFrom(conn, symbolId)) {
    ids.add(edge.toSymbolId);
  }
  const edgesTo = await ladybugDb.getEdgesToSymbols(conn, [symbolId]);
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
  const top = await ladybugDb.getTopSymbolsByFanIn(conn, repoId, maxNodes);
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
  const changedSymbolIds = delta.changedSymbols.map(
    (change) => change.symbolId,
  );
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

// ---------------------------------------------------------------------------
// Static UI assets
// ---------------------------------------------------------------------------

function serveUiAsset(pathname: string, res: ServerResponse): boolean {
  const map: Record<string, { file: string; type: string }> = {
    "/ui/graph": { file: "graph.html", type: "text/html; charset=utf-8" },
    "/ui/graph.js": {
      file: "graph.js",
      type: "application/javascript; charset=utf-8",
    },
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

// ---------------------------------------------------------------------------
// REST API handler
// ---------------------------------------------------------------------------

async function handleRestRequest(
  req: IncomingMessage,
  res: ServerResponse,
  host: string,
  port: number,
  checkHealth: () => Promise<boolean>,
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

  // Session stats endpoint
  if (req.method === "GET" && pathname === "/api/sessions") {
    const sessionManager = services.sessionManager;
    if (sessionManager) {
      json(res, 200, sessionManager.getStats());
    } else {
      json(res, 200, { activeSessions: 0, maxSessions: 0, sessions: [] });
    }
    return true;
  }

  if (
    /^\/api\/repo\/[^/]+\/(?:buffer|checkpoint|live-status)$/.test(pathname)
  ) {
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

  // DB-dependent REST API routes — wrapped in try/catch for structured errors.
  // Connection is acquired lazily per-route to avoid unnecessary pool checkouts.
  try {
    const graphSliceMatch = pathname.match(
      /^\/api\/graph\/([^/]+)\/slice\/([^/]+)$/,
    );
    if (req.method === "GET" && graphSliceMatch) {
      const conn = await getLadybugConn();
      const [, repoId, handle] = graphSliceMatch;
      const maxNodes = Number(url.searchParams.get("maxNodes") ?? "200");
      const graph = await buildRepoPreview(
        conn,
        repoId,
        Math.min(500, Math.max(10, maxNodes)),
      );
      const handleRow = await ladybugDb.getSliceHandle(conn, handle);
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
      const conn = await getLadybugConn();
      const [, repoId, symbolId] = graphNeighborhoodMatch;
      const maxNodes = Number(url.searchParams.get("maxNodes") ?? "200");
      const graph = await buildNeighborhood(
        conn,
        decodeURIComponent(symbolId),
        Math.min(500, Math.max(10, maxNodes)),
      );
      json(res, 200, {
        repoId,
        symbolId: decodeURIComponent(symbolId),
        ...graph,
      });
      return true;
    }

    const graphBlastMatch = pathname.match(
      /^\/api\/graph\/([^/]+)\/blast-radius\/([^/]+)\/([^/]+)$/,
    );
    if (req.method === "GET" && graphBlastMatch) {
      const conn = await getLadybugConn();
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

    const symbolSearchMatch = pathname.match(
      /^\/api\/symbol\/([^/]+)\/search$/,
    );
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

    const symbolCardMatch = pathname.match(
      /^\/api\/symbol\/([^/]+)\/card\/([^/]+)$/,
    );
    if (req.method === "GET" && symbolCardMatch) {
      const [, repoId, symbolIdRaw] = symbolCardMatch;
      const symbolId = decodeURIComponent(symbolIdRaw);
      const response = await handleSymbolGetCard({
        repoId,
        symbolId,
      });
      if ("notModified" in response) {
        res.writeHead(304);
        res.end();
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
      const conn = await getLadybugConn();
      const [, repoId] = repoStatusMatch;
      const repo = await ladybugDb.getRepo(conn, repoId);
      if (!repo) {
        json(res, 404, { error: `Repository not found: ${repoId}` });
        return true;
      }
      const latestVersion = await ladybugDb.getLatestVersion(conn, repoId);
      json(res, 200, {
        repoId,
        latestVersionId: latestVersion?.versionId ?? null,
        symbolCount: await ladybugDb.getSymbolCount(conn, repoId),
        fileCount: await ladybugDb.getFileCount(conn, repoId),
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[sdl-mcp] REST API error: ${message}`);
    setCorsHeaders(req, res);
    json(res, 500, { error: message });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Main HTTP transport setup — multi-session SSE + Streamable HTTP
// ---------------------------------------------------------------------------

export interface HttpServerHandle {
  /** Resolves when the server closes. */
  serverClosed: Promise<void>;
  /** Gracefully close the HTTP server and stop the idle reaper. */
  close: () => Promise<void>;
}

export async function setupHttpTransport(
  host: string,
  port: number,
  graphDbPath: string,
  services: HttpTransportServices & MCPServerServices = {},
): Promise<HttpServerHandle> {
  // Unified transport map: sessionId -> Transport (SSE or StreamableHTTP)
  const transports = new Map<string, Transport>();
  // Per-session MCP servers for lifecycle cleanup
  const mcpServers = new Map<string, MCPServer>();
  // Guard against double-cleanup per session
  const cleanedUp = new Set<string>();

  const sessionManager = services.sessionManager ?? new SessionManager(8);

  /**
   * Idempotent session cleanup — safe to call from onclose, idle reaper,
   * error handlers, or graceful shutdown. Cleans transport, MCPServer, and
   * session manager state exactly once per session.
   */
  function cleanupSession(
    sessionId: string,
    opts?: { closeTransport?: boolean },
  ): void {
    if (cleanedUp.has(sessionId)) return;
    cleanedUp.add(sessionId);

    const transport = transports.get(sessionId);
    if (opts?.closeTransport && transport) {
      if ("close" in transport && typeof transport.close === "function") {
        void (transport.close as () => Promise<void>)();
      }
    }
    transports.delete(sessionId);

    const server = mcpServers.get(sessionId);
    if (server) {
      void server.stop().catch(() => {});
      mcpServers.delete(sessionId);
    }

    sessionManager.unregisterSession(sessionId);
    console.error(`[sdl-mcp] Session cleaned up: ${sessionId}`);
  }

  // Start idle reaper to clean up stale sessions
  sessionManager.startIdleReaper({}, (sessionId) => {
    console.error(`[sdl-mcp] Session expired (idle): ${sessionId}`);
    cleanupSession(sessionId, { closeTransport: true });
  });

  // Merge sessionManager into services for REST handlers
  const effectiveServices: HttpTransportServices & MCPServerServices = {
    ...services,
    sessionManager,
  };

  await initLadybugDb(graphDbPath);

  const checkHealth = async (): Promise<boolean> => {
    try {
      const conn = await getLadybugConn();
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

  const httpServer = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const url = new URL(req.url ?? "/", `http://${host}:${port}`);
        const pathname = url.pathname;

        // ---------------------------------------------------------------
        // CORS preflight for /mcp endpoint
        // ---------------------------------------------------------------
        if (req.method === "OPTIONS" && pathname === "/mcp") {
          setCorsHeaders(req, res);
          res.writeHead(204);
          res.end();
          return;
        }

        // ---------------------------------------------------------------
        // REST API and static assets
        // ---------------------------------------------------------------
        const handled = await handleRestRequest(
          req,
          res,
          host,
          port,
          checkHealth,
          effectiveServices,
        );
        if (handled) {
          return;
        }

        // ---------------------------------------------------------------
        // Streamable HTTP Transport — /mcp (POST, GET, DELETE)
        // ---------------------------------------------------------------
        if (pathname === "/mcp") {
          setCorsHeaders(req, res);

          try {
            const sessionId = req.headers["mcp-session-id"] as
              | string
              | undefined;
            let transport: StreamableHTTPServerTransport | undefined;

            if (sessionId && transports.has(sessionId)) {
              const existing = transports.get(sessionId)!;
              if (existing instanceof StreamableHTTPServerTransport) {
                transport = existing;
              } else {
                json(res, 400, {
                  jsonrpc: "2.0",
                  error: {
                    code: -32000,
                    message:
                      "Bad Request: Session uses a different transport protocol",
                  },
                  id: null,
                });
                return;
              }
            } else if (!sessionId && req.method === "POST") {
              // Read body to check if initialize request
              const body = await readJsonBody(req);
              if (isInitializeRequest(body)) {
                // Atomically reserve a session slot before allocating resources
                if (!sessionManager.reserveSession()) {
                  json(res, 503, {
                    jsonrpc: "2.0",
                    error: {
                      code: -32000,
                      message: `Service unavailable: maximum session limit (${sessionManager.getMaxSessions()}) reached`,
                    },
                    id: null,
                  });
                  return;
                }

                let reservationHeld = true;
                // Track the MCPServer outside onsessioninitialized so
                // it is available to the callback closure.
                const mcpServer = createMCPServer({
                  liveIndex: effectiveServices.liveIndex,
                });
                // Capture the session ID set by onsessioninitialized
                // so onclose can use a stable reference.
                let registeredSessionId: string | undefined;

                try {
                  const eventStore = new InMemoryEventStore();
                  transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    eventStore,
                    onsessioninitialized: (newSessionId: string) => {
                      console.error(
                        `[sdl-mcp] StreamableHTTP session initialized: ${newSessionId}`,
                      );
                      registeredSessionId = newSessionId;
                      transports.set(newSessionId, transport!);
                      // Track MCPServer immediately so onclose/reaper can find it
                      mcpServers.set(newSessionId, mcpServer);
                      // registerSession internally releases the reservation
                      sessionManager.registerSession(
                        newSessionId,
                        "streamable-http",
                      );
                      reservationHeld = false;
                    },
                  });

                  transport.onclose = () => {
                    const sid = registeredSessionId ?? transport!.sessionId;
                    if (sid) {
                      cleanupSession(sid);
                    } else {
                      console.error(
                        "[sdl-mcp] StreamableHTTP transport closed before session ID was assigned",
                      );
                    }
                  };

                  await mcpServer.getServer().connect(transport);

                  // Handle the initialize request with pre-parsed body
                  await transport.handleRequest(req, res, body);
                  return;
                } catch (initError) {
                  // If session was partially registered but connect/handleRequest
                  // failed, clean up the broken session to avoid slot leak (C2).
                  if (registeredSessionId) {
                    cleanupSession(registeredSessionId);
                  } else {
                    // MCPServer was created but never connected — stop it directly
                    void mcpServer.stop().catch(() => {});
                  }
                  throw initError;
                } finally {
                  // If reservation was never consumed (registerSession not called), release it
                  if (reservationHeld) {
                    sessionManager.releaseReservation();
                  }
                }
              } else {
                json(res, 400, {
                  jsonrpc: "2.0",
                  error: {
                    code: -32000,
                    message:
                      "Bad Request: First request must be an initialize request",
                  },
                  id: null,
                });
                return;
              }
            } else if (sessionId && !transports.has(sessionId)) {
              // Unknown session ID
              res.writeHead(404);
              res.end("Session not found");
              return;
            } else {
              json(res, 400, {
                jsonrpc: "2.0",
                error: {
                  code: -32000,
                  message: "Bad Request: No valid session ID provided",
                },
                id: null,
              });
              return;
            }

            // For GET (SSE stream) and DELETE (session termination)
            // and subsequent POST requests with session ID
            await transport.handleRequest(req, res);
          } catch (error) {
            console.error(`[sdl-mcp] Error handling /mcp request: ${error}`);
            if (!res.headersSent) {
              json(res, 500, {
                jsonrpc: "2.0",
                error: {
                  code: -32603,
                  message: "Internal server error",
                },
                id: null,
              });
            }
          }
          return;
        }

        // ---------------------------------------------------------------
        // Deprecated SSE Transport — /sse (GET) + /message (POST)
        // Supports multiple concurrent SSE sessions (no singleton)
        // ---------------------------------------------------------------
        if (req.method === "GET" && pathname === "/sse") {
          setCorsHeaders(req, res);

          const accept = Array.isArray(req.headers.accept)
            ? req.headers.accept.join(",")
            : (req.headers.accept ?? "");
          if (!accept.toLowerCase().includes("text/event-stream")) {
            res.writeHead(406);
            res.end("Accept header must include text/event-stream");
            return;
          }

          // Atomically reserve a session slot before allocating resources
          if (!sessionManager.reserveSession()) {
            res.writeHead(503);
            res.end(
              `Maximum session limit (${sessionManager.getMaxSessions()}) reached`,
            );
            return;
          }

          let sseReservationHeld = true;
          try {
            const sseTransport = new SSEServerTransport("/message", res);
            const sseSessionId = sseTransport.sessionId;
            transports.set(sseSessionId, sseTransport);
            // registerSession internally releases the reservation
            sessionManager.registerSession(sseSessionId, "sse");
            sseReservationHeld = false;

            sseTransport.onclose = () => {
              cleanupSession(sseSessionId);
            };

            // Create per-session MCP server via factory
            const mcpServer = createMCPServer({
              liveIndex: effectiveServices.liveIndex,
            });
            mcpServers.set(sseSessionId, mcpServer);

            void mcpServer
              .getServer()
              .connect(sseTransport)
              .catch((error) => {
                console.error(
                  `[sdl-mcp] Failed to establish SSE transport: ${error}`,
                );
                cleanupSession(sseSessionId);
                if (!res.headersSent) {
                  res.writeHead(500);
                  res.end("Failed to establish SSE transport");
                }
              });
          } finally {
            if (sseReservationHeld) {
              sessionManager.releaseReservation();
            }
          }
          return;
        }

        if (req.method === "POST" && pathname === "/message") {
          const sessionId = url.searchParams.get("sessionId");
          if (!sessionId) {
            res.writeHead(400);
            res.end("Missing sessionId");
            return;
          }

          const transport = transports.get(sessionId);
          if (!transport || !(transport instanceof SSEServerTransport)) {
            res.writeHead(404);
            res.end("Unknown sessionId");
            return;
          }

          void transport.handlePostMessage(req, res).catch((error) => {
            console.error(
              `[sdl-mcp] Failed to process SSE POST message: ${error}`,
            );
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
        console.error(`[sdl-mcp] HTTP transport error: ${String(error)}`);
        if (!res.headersSent) {
          res.writeHead(500);
        }
        res.end("Internal server error");
      });
    },
  );

  httpServer.listen(port, host, () => {
    console.error(`HTTP server listening on http://${host}:${port}`);
    console.error(`  - Streamable HTTP: http://${host}:${port}/mcp`);
    console.error(`  - SSE endpoint:    http://${host}:${port}/sse`);
    console.error(`  - Sessions:        http://${host}:${port}/api/sessions`);
    console.error(`  - Health check:    http://${host}:${port}/health`);
    console.error(`  - Graph UI:        http://${host}:${port}/ui/graph`);
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
      console.error(
        `\n  WARNING: Server is listening on ${host} over plaintext HTTP.` +
          `\n  Traffic (including code content) is NOT encrypted.` +
          `\n  Use localhost or add a TLS reverse proxy for production use.\n`,
      );
    }
  });

  const serverClosed = new Promise<void>((resolve_) => {
    httpServer.on("close", resolve_);
  });

  return {
    serverClosed,
    close: async () => {
      sessionManager.stopIdleReaper();
      // Clean up all active sessions via idempotent cleanup
      for (const sid of [...transports.keys()]) {
        cleanupSession(sid);
      }
      // Wait briefly for async stop() calls to settle
      await new Promise((r) => setTimeout(r, 50));
      // Close keep-alive connections to ensure serverClosed resolves (H3)
      if (typeof httpServer.closeAllConnections === "function") {
        httpServer.closeAllConnections();
      }
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
