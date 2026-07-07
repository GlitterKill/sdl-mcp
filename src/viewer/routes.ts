import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, resolve, relative, isAbsolute } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { ObservabilityService } from "../observability/service.js";

import { getLadybugConn } from "../db/ladybug.js";
import { computeDelta } from "../delta/diff.js";
import { handleSymbolSearch } from "../mcp/tools/symbol.js";
import { getLayout } from "../graph/layout/layout-service.js";
import {
  getClusterEdges,
  getClusterIdsForSymbols,
  getClusters,
  getSymbolCard,
  getSymbolEdges,
  getUniverse,
} from "./service.js";
import { getViewerRuntimeConfig, resolveSkinsDir } from "./viewer-config.js";

const SKIN_ID_RE = /^[A-Za-z0-9._-]+$/;

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function safeSkinPath(skinsDir: string, id: string): string | null {
  if (!SKIN_ID_RE.test(id)) return null;
  const root = resolve(skinsDir);
  const file = resolve(root, `${id}.zip`);
  const relativePath = relative(root, file);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) return null;
  return file;
}

type SearchEventService = Pick<ObservabilityService, "recordGraphEvent">;
type SearchEventResult = { symbolId: string };

function recordSearchGraphEvent(
  observabilityService: SearchEventService | null | undefined,
  repoId: string,
  query: string,
  results: SearchEventResult[],
): void {
  try {
    observabilityService?.recordGraphEvent({
      type: "graph.search.executed",
      repoId,
      query,
      topSymbolIds: results.slice(0, 50).map((result) => result.symbolId),
    });
  } catch {
    // Viewer event taps must never affect read-only graph API responses.
  }
}

export function _recordSearchGraphEventForTesting(
  observabilityService: SearchEventService | null,
  repoId: string,
  query: string,
  results: SearchEventResult[],
): void {
  recordSearchGraphEvent(observabilityService, repoId, query, results);
}

export async function handleViewerApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
  observabilityService?: ObservabilityService | null,
): Promise<boolean> {
  if (!pathname.startsWith("/api/graph/")) return false;
  if (req.method !== "GET") return false;

  if (pathname === "/api/graph/skins") {
    const config = getViewerRuntimeConfig();
    const skinsDir = resolveSkinsDir();
    let entries: string[] = [];
    try {
      entries = await readdir(skinsDir);
    } catch {
      json(res, 200, { skins: [] });
      return true;
    }
    const skins = [];
    for (const fileName of entries.filter((entry) => entry.endsWith(".zip")).sort()) {
      const id = basename(fileName, ".zip");
      if (!SKIN_ID_RE.test(id)) continue;
      const file = safeSkinPath(skinsDir, id);
      if (!file) continue;
      const info = await stat(file);
      if (info.size <= config.skins.maxZipBytes) skins.push({ id, fileName, bytes: info.size });
    }
    json(res, 200, { skins });
    return true;
  }

  const skinMatch = pathname.match(/^\/api\/graph\/skins\/([^/]+)$/);
  if (skinMatch) {
    const config = getViewerRuntimeConfig();
    const skinsDir = resolveSkinsDir();
    const file = safeSkinPath(skinsDir, decodeURIComponent(skinMatch[1] ?? ""));
    if (!file) {
      json(res, 400, { error: "invalid skin id" });
      return true;
    }
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > config.skins.maxZipBytes) {
        json(res, 404, { error: "skin not found" });
        return true;
      }
    } catch {
      json(res, 404, { error: "skin not found" });
      return true;
    }
    res.writeHead(200, { "Content-Type": "application/zip" });
    createReadStream(file).pipe(res);
    return true;
  }

  if (pathname === "/api/graph/events/recent") {
    json(res, 200, { events: observabilityService?.getRecentGraphEvents(200) ?? [] });
    return true;
  }

  const conn = await getLadybugConn();

  if (pathname === "/api/graph/universe") {
    json(res, 200, await getUniverse(conn));
    return true;
  }

  const clustersMatch = pathname.match(/^\/api\/graph\/repo\/([^/]+)\/clusters$/);
  if (clustersMatch) {
    json(res, 200, await getClusters(conn, decodeURIComponent(clustersMatch[1] ?? "")));
    return true;
  }

  const layoutMatch = pathname.match(/^\/api\/graph\/repo\/([^/]+)\/layout$/);
  if (layoutMatch) {
    const repoId = decodeURIComponent(layoutMatch[1] ?? "");
    const lod = url.searchParams.get("lod") ?? "cluster";
    if (lod !== "cluster" && lod !== "symbol") {
      json(res, 400, { error: "invalid lod" });
      return true;
    }
    const clusterId = url.searchParams.get("clusterId") ?? undefined;
    if (lod === "symbol" && !clusterId) {
      json(res, 400, { error: "clusterId is required" });
      return true;
    }
    const viewerConfig = getViewerRuntimeConfig();
    try {
      json(res, 200, await getLayout(conn, repoId, lod, clusterId, {
        engine: viewerConfig.layout.engine,
        iterations: viewerConfig.layout.iterations,
        maxSymbolsPerClusterExpand: viewerConfig.layout.maxSymbolsPerClusterExpand,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "layout failed";
      json(res, message.includes("limit") ? 413 : 500, { error: message });
    }
    return true;
  }

  const edgesMatch = pathname.match(/^\/api\/graph\/repo\/([^/]+)\/edges$/);
  if (edgesMatch) {
    const repoId = decodeURIComponent(edgesMatch[1] ?? "");
    if (url.searchParams.get("scope") === "clusters") {
      json(res, 200, await getClusterEdges(conn, repoId));
      return true;
    }
    const clusterId = url.searchParams.get("clusterId");
    if (!clusterId) {
      json(res, 400, { error: "clusterId is required" });
      return true;
    }
    const kinds = (url.searchParams.get("kinds") ?? "").split(",").map((kind) => kind.trim()).filter(Boolean);
    const minConfidence = Math.min(1, Math.max(0, Number(url.searchParams.get("minConfidence") ?? "0")));
    const limit = Math.min(10000, Math.max(1, Number(url.searchParams.get("limit") ?? "5000")));
    json(res, 200, await getSymbolEdges(conn, repoId, clusterId, kinds, minConfidence, limit));
    return true;
  }

  const searchMatch = pathname.match(/^\/api\/graph\/repo\/([^/]+)\/search$/);
  if (searchMatch) {
    const repoId = decodeURIComponent(searchMatch[1] ?? "");
    const query = (url.searchParams.get("q") ?? "").trim();
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? "20")));
    if (!query) {
      json(res, 200, { results: [] });
      return true;
    }
    const response = await handleSymbolSearch({ repoId, query, limit });
    const raw = Array.isArray(response.results) ? response.results : [];
    const clusterIds = await getClusterIdsForSymbols(conn, raw.map((result) => result.symbolId));
    recordSearchGraphEvent(observabilityService, repoId, query, raw);
    json(res, 200, {
      results: raw.map((result) => ({
        symbolId: result.symbolId,
        name: result.name,
        kind: result.kind,
        relPath: result.file ?? null,
        score: result.relevance ?? null,
        clusterId: clusterIds.get(result.symbolId) ?? null,
      })),
    });
    return true;
  }

  const cardMatch = pathname.match(/^\/api\/graph\/repo\/([^/]+)\/symbol\/([^/]+)\/card$/);
  if (cardMatch) {
    const card = await getSymbolCard(conn, decodeURIComponent(cardMatch[1] ?? ""), decodeURIComponent(cardMatch[2] ?? ""));
    if (!card) {
      json(res, 404, { error: "symbol not found" });
      return true;
    }
    json(res, 200, card);
    return true;
  }

  const impactMatch = pathname.match(/^\/api\/graph\/repo\/([^/]+)\/impact$/);
  if (impactMatch) {
    const repoId = decodeURIComponent(impactMatch[1] ?? "");
    const fromVersion = (url.searchParams.get("fromVersion") ?? "").trim();
    const toVersion = (url.searchParams.get("toVersion") ?? "").trim();
    if (!fromVersion || !toVersion) {
      json(res, 400, { error: "fromVersion and toVersion are required" });
      return true;
    }
    try {
      const delta = await computeDelta(repoId, fromVersion, toVersion);
      json(res, 200, {
        changed: delta.changedSymbols.map((change) => change.symbolId),
        blastRadius: delta.blastRadius.map((item) => ({
          symbolId: item.symbolId,
          name: item.name ?? null,
          score: round6(1 / (1 + item.distance)),
          rank: item.rank,
        })),
      });
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : "impact computation failed" });
    }
    return true;
  }

  return false;
}
