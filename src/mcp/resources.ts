import { getKuzuConn } from "../db/kuzu.js";
import * as kuzuDb from "../db/kuzu-queries.js";

export interface CardResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface SliceResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface ResourceList {
  resources: Array<CardResource | SliceResource>;
}

export async function listCardResources(repoId: string): Promise<CardResource[]> {
  const conn = await getKuzuConn();
  const symbols = await kuzuDb.getSymbolsByRepo(conn, repoId);
  const latestVersion = await kuzuDb.getLatestVersion(conn, repoId);

  if (!latestVersion) {
    return [];
  }

  return symbols.map((symbol) => ({
    uri: `card://${repoId}/${symbol.symbolId}@${latestVersion.versionId}`,
    name: symbol.name,
    description: `${symbol.kind} in ${symbol.name}`,
    mimeType: "application/json",
  }));
}

export async function listSliceResources(
  repoId: string,
): Promise<SliceResource[]> {
  const conn = await getKuzuConn();
  const versions = await kuzuDb.getVersionsByRepo(conn, repoId);

  return versions.slice(0, 50).map((version) => ({
    uri: `slice://${repoId}/${version.versionId}`,
    name: `Slice v${version.versionId}`,
    description: `Graph slice for version ${version.versionId}`,
    mimeType: "application/json",
  }));
}

export async function listAllResources(repoId?: string): Promise<ResourceList> {
  if (repoId) {
    const [cards, slices] = await Promise.all([
      listCardResources(repoId),
      listSliceResources(repoId),
    ]);

    return {
      resources: [...cards, ...slices],
    };
  }

  const conn = await getKuzuConn();
  const repos = await kuzuDb.listRepos(conn);
  const allResources: Array<CardResource | SliceResource> = [];

  for (const repo of repos) {
    allResources.push(...(await listCardResources(repo.repoId)));
    allResources.push(...(await listSliceResources(repo.repoId)));
  }

  return {
    resources: allResources,
  };
}

export async function readCardResource(uri: string): Promise<string | null> {
  const match = uri.match(/^card:\/\/([^\/]+)\/([^@]+)@(.+)$/);
  if (!match) {
    return null;
  }

  const [, , symbolId, versionId] = match;

  const conn = await getKuzuConn();
  const symbol = await kuzuDb.getSymbol(conn, symbolId);
  if (!symbol) {
    return null;
  }

  const file = (await kuzuDb.getFilesByIds(conn, [symbol.fileId])).get(
    symbol.fileId,
  );
  if (!file) {
    return null;
  }

  const edgesFrom = await kuzuDb.getEdgesFrom(conn, symbolId);
  const metrics = await kuzuDb.getMetrics(conn, symbolId);

  const signature = symbol.signatureJson
    ? (JSON.parse(symbol.signatureJson) as unknown)
    : { name: symbol.name };

  const invariants = symbol.invariantsJson
    ? (JSON.parse(symbol.invariantsJson) as unknown)
    : undefined;

  const sideEffects = symbol.sideEffectsJson
    ? (JSON.parse(symbol.sideEffectsJson) as unknown)
    : undefined;

  const deps = {
    imports: edgesFrom
      .filter((edge) => edge.edgeType === "import")
      .map((edge) => edge.toSymbolId),
    calls: edgesFrom
      .filter((edge) => edge.edgeType === "call")
      .map((edge) => edge.toSymbolId),
  };

  const metricsData = metrics
    ? {
        fanIn: metrics.fanIn,
        fanOut: metrics.fanOut,
        churn30d: metrics.churn30d,
        testRefs: metrics.testRefsJson
          ? (JSON.parse(metrics.testRefsJson) as unknown)
          : undefined,
      }
    : undefined;

  const card = {
    symbolId: symbol.symbolId,
    repoId: symbol.repoId,
    file: file.relPath,
    range: {
      startLine: symbol.rangeStartLine,
      startCol: symbol.rangeStartCol,
      endLine: symbol.rangeEndLine,
      endCol: symbol.rangeEndCol,
    },
    kind: symbol.kind,
    name: symbol.name,
    exported: symbol.exported,
    visibility: symbol.visibility ?? undefined,
    signature,
    summary: symbol.summary ?? undefined,
    invariants,
    sideEffects,
    deps,
    metrics: metricsData,
    version: {
      ledgerVersion: versionId,
      astFingerprint: symbol.astFingerprint,
    },
  };

  return JSON.stringify(card, null, 2);
}

export function readSliceResource(uri: string): string | null {
  const match = uri.match(/^slice:\/\/([^\/]+)\/(.+)$/);
  if (!match) {
    return null;
  }

  const [, _repoId, sliceId] = match;

  return JSON.stringify(
    {
      sliceId,
      message: "Slice resources require slice.build to generate content",
    } as Record<string, unknown>,
    null,
    2,
  );
}

export async function readResource(
  uri: string,
): Promise<{ contents: string } | null> {
  if (uri.startsWith("card://")) {
    const contents = await readCardResource(uri);
    if (contents === null) {
      return null;
    }
    return { contents };
  }

  if (uri.startsWith("slice://")) {
    const contents = readSliceResource(uri);
    if (contents === null) {
      return null;
    }
    return { contents };
  }

  return null;
}
