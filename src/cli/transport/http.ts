import { existsSync, readFileSync } from "fs";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { join } from "path";
import { fileURLToPath } from "url";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { MCPServer } from "../../server.js";
import { getDb } from "../../db/db.js";
import * as db from "../../db/queries.js";
import { computeDelta } from "../../delta/diff.js";
import { runGovernorLoop } from "../../delta/blastRadius.js";
import { loadGraphForRepo } from "../../graph/buildGraph.js";
import { indexRepo } from "../../indexer/indexer.js";

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

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function toClusterPath(filePath: string): string {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (slash === -1) {
    return "root";
  }
  return filePath.slice(0, slash) || "root";
}

function buildNode(symbolId: string): GraphNode | null {
  const symbol = db.getSymbol(symbolId);
  if (!symbol) {
    return null;
  }
  const file = db.getFile(symbol.file_id);
  const metrics = db.getMetrics(symbolId);
  return {
    id: symbolId,
    label: symbol.name,
    kind: symbol.kind,
    file: file?.rel_path,
    fanIn: metrics?.fan_in,
    fanOut: metrics?.fan_out,
    size: Math.max(5, Math.min(40, (metrics?.fan_in ?? 0) + 6)),
    cluster: toClusterPath(file?.rel_path ?? ""),
  };
}

function buildLinksForNodes(repoId: string, ids: Set<string>): GraphLink[] {
  const links: GraphLink[] = [];
  for (const edge of db.getEdgesByRepo(repoId)) {
    if (!ids.has(edge.from_symbol_id) || !ids.has(edge.to_symbol_id)) {
      continue;
    }
    links.push({
      source: edge.from_symbol_id,
      target: edge.to_symbol_id,
      type: edge.type,
      weight: edge.weight,
    });
  }
  return links;
}

function collapseClusters(nodes: GraphNode[], maxChildrenPerCluster = 10): GraphNode[] {
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

function buildNeighborhood(repoId: string, symbolId: string, maxNodes: number): {
  nodes: GraphNode[];
  links: GraphLink[];
} {
  const ids = new Set<string>();
  ids.add(symbolId);

  for (const edge of db.getEdgesFrom(symbolId)) {
    ids.add(edge.to_symbol_id);
  }
  for (const edge of db.getEdgesTo(symbolId)) {
    ids.add(edge.from_symbol_id);
  }

  const limited = new Set(Array.from(ids).slice(0, maxNodes));
  const nodes = Array.from(limited)
    .map((id) => buildNode(id))
    .filter((node): node is GraphNode => Boolean(node));
  const links = buildLinksForNodes(repoId, limited);

  return {
    nodes: collapseClusters(nodes),
    links,
  };
}

function buildRepoPreview(repoId: string, maxNodes: number): {
  nodes: GraphNode[];
  links: GraphLink[];
} {
  const top = db.getTopSymbolsByFanIn(repoId, maxNodes);
  const ids = new Set(top.map((row) => row.symbol_id));
  const nodes = top
    .map((row) => buildNode(row.symbol_id))
    .filter((node): node is GraphNode => Boolean(node));
  const links = buildLinksForNodes(repoId, ids);

  return {
    nodes: collapseClusters(nodes),
    links,
  };
}

async function buildBlastRadiusGraph(
  repoId: string,
  fromVersion: string,
  toVersion: string,
  maxNodes: number,
): Promise<{ nodes: GraphNode[]; links: GraphLink[] }> {
  const delta = computeDelta(repoId, fromVersion, toVersion);
  const changedSymbolIds = delta.changedSymbols.map((change) => change.symbolId);
  const graph = loadGraphForRepo(repoId);
  const governor = await runGovernorLoop(changedSymbolIds, graph, {
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
  const nodes = Array.from(limited)
    .map((id) => buildNode(id))
    .filter((node): node is GraphNode => Boolean(node));
  const links = buildLinksForNodes(repoId, limited);

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
  checkHealth: () => boolean,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${host}:${port}`);
  const pathname = url.pathname;

  if (pathname.startsWith("/api/")) {
    setCorsHeaders(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return true;
    }
  }

  if (req.method === "GET" && pathname === "/health") {
    const isHealthy = checkHealth();
    json(res, isHealthy ? 200 : 503, {
      status: isHealthy ? "ok" : "unhealthy",
      timestamp: Date.now(),
    });
    return true;
  }

  if (req.method === "GET" && serveUiAsset(pathname, res)) {
    return true;
  }

  const graphSliceMatch = pathname.match(/^\/api\/graph\/([^/]+)\/slice\/([^/]+)$/);
  if (req.method === "GET" && graphSliceMatch) {
    const [, repoId, handle] = graphSliceMatch;
    const maxNodes = Number(url.searchParams.get("maxNodes") ?? "200");
    const graph = buildRepoPreview(repoId, Math.min(500, Math.max(10, maxNodes)));
    const handleRow = db.getSliceHandle(handle);
    json(res, 200, {
      repoId,
      handle,
      handleMetadata: handleRow
        ? {
            createdAt: handleRow.created_at,
            expiresAt: handleRow.expires_at,
            minVersion: handleRow.min_version,
            maxVersion: handleRow.max_version,
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
    const graph = buildNeighborhood(repoId, decodeURIComponent(symbolId), Math.min(500, Math.max(10, maxNodes)));
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
    const results = db.searchSymbolsLite(repoId, query, Math.min(100, Math.max(1, limit)));
    json(res, 200, {
      repoId,
      results: results.map((row) => ({
        symbolId: row.symbol_id,
        name: row.name,
        kind: row.kind,
        file: db.getFile(row.file_id)?.rel_path ?? "",
      })),
    });
    return true;
  }

  const symbolCardMatch = pathname.match(/^\/api\/symbol\/([^/]+)\/card\/([^/]+)$/);
  if (req.method === "GET" && symbolCardMatch) {
    const [, _repoId, symbolIdRaw] = symbolCardMatch;
    const symbolId = decodeURIComponent(symbolIdRaw);
    const symbol = db.getSymbol(symbolId);
    if (!symbol) {
      json(res, 404, { error: `Symbol not found: ${symbolId}` });
      return true;
    }
    const file = db.getFile(symbol.file_id);
    const metrics = db.getMetrics(symbolId);
    json(res, 200, {
      symbolId,
      name: symbol.name,
      kind: symbol.kind,
      summary: symbol.summary,
      file: file?.rel_path,
      fanIn: metrics?.fan_in ?? 0,
      fanOut: metrics?.fan_out ?? 0,
    });
    return true;
  }

  const repoStatusMatch = pathname.match(/^\/api\/repo\/([^/]+)\/status$/);
  if (req.method === "GET" && repoStatusMatch) {
    const [, repoId] = repoStatusMatch;
    const repo = db.getRepo(repoId);
    if (!repo) {
      json(res, 404, { error: `Repository not found: ${repoId}` });
      return true;
    }
    const latestVersion = db.getLatestVersion(repoId);
    json(res, 200, {
      repoId,
      latestVersionId: latestVersion?.version_id ?? null,
      symbolCount: db.countSymbolsByRepo(repoId),
      fileCount: db.getFilesByRepo(repoId).length,
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
  dbPath: string,
): Promise<void> {
  const sessions = new Map<string, SSEServerTransport>();
  let activeSseTransport: SSEServerTransport | null = null;

  const checkHealth = (): boolean => {
    try {
      const dbInstance = getDb(dbPath);
      dbInstance.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  };

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const handled = await handleRestRequest(req, res, host, port, checkHealth);
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
  });

  return new Promise((resolve_) => {
    httpServer.on("close", resolve_);
  });
}
