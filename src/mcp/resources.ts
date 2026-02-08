import * as db from "../db/queries.js";

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

export function listCardResources(repoId: string): CardResource[] {
  const symbols = db.getSymbolsByRepo(repoId);
  const latestVersion = db.getLatestVersion(repoId);

  if (!latestVersion) {
    return [];
  }

  return symbols.map((symbol) => ({
    uri: `card://${repoId}/${symbol.symbol_id}@${latestVersion.version_id}`,
    name: symbol.name,
    description: `${symbol.kind} in ${symbol.name}`,
    mimeType: "application/json",
  }));
}

export function listSliceResources(repoId: string): SliceResource[] {
  const versions = db.listVersions(repoId, 50);

  return versions.map((version) => ({
    uri: `slice://${repoId}/${version.version_id}`,
    name: `Slice v${version.version_id}`,
    description: `Graph slice for version ${version.version_id}`,
    mimeType: "application/json",
  }));
}

export function listAllResources(repoId?: string): ResourceList {
  if (repoId) {
    const cards = listCardResources(repoId);
    const slices = listSliceResources(repoId);

    return {
      resources: [...cards, ...slices],
    };
  }

  const repos = db.listRepos();
  const allResources: Array<CardResource | SliceResource> = [];

  for (const repo of repos) {
    allResources.push(...listCardResources(repo.repo_id));
    allResources.push(...listSliceResources(repo.repo_id));
  }

  return {
    resources: allResources,
  };
}

export function readCardResource(uri: string): string | null {
  const match = uri.match(/^card:\/\/([^\/]+)\/([^@]+)@(.+)$/);
  if (!match) {
    return null;
  }

  const [, , symbolId, versionId] = match;

  const symbol = db.getSymbol(symbolId);
  if (!symbol) {
    return null;
  }

  const file = db.getFile(symbol.file_id);
  if (!file) {
    return null;
  }

  const edgesFrom = db.getEdgesFrom(symbolId);
  const metrics = db.getMetrics(symbolId);

  const signature = symbol.signature_json
    ? JSON.parse(symbol.signature_json)
    : { name: symbol.name };

  const invariants = symbol.invariants_json
    ? JSON.parse(symbol.invariants_json)
    : undefined;

  const sideEffects = symbol.side_effects_json
    ? JSON.parse(symbol.side_effects_json)
    : undefined;

  const deps = {
    imports: edgesFrom
      .filter((edge) => edge.type === "import")
      .map((edge) => edge.to_symbol_id),
    calls: edgesFrom
      .filter((edge) => edge.type === "call")
      .map((edge) => edge.to_symbol_id),
  };

  const metricsData = metrics
    ? {
        fanIn: metrics.fan_in,
        fanOut: metrics.fan_out,
        churn30d: metrics.churn_30d,
        testRefs: metrics.test_refs_json
          ? JSON.parse(metrics.test_refs_json)
          : undefined,
      }
    : undefined;

  const card = {
    symbolId: symbol.symbol_id,
    repoId: symbol.repo_id,
    file: file.rel_path,
    range: {
      startLine: symbol.range_start_line,
      startCol: symbol.range_start_col,
      endLine: symbol.range_end_line,
      endCol: symbol.range_end_col,
    },
    kind: symbol.kind,
    name: symbol.name,
    exported: symbol.exported === 1,
    visibility: symbol.visibility ?? undefined,
    signature,
    summary: symbol.summary ?? undefined,
    invariants,
    sideEffects,
    deps,
    metrics: metricsData,
    version: {
      ledgerVersion: versionId,
      astFingerprint: symbol.ast_fingerprint,
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

export function readResource(uri: string): { contents: string } | null {
  if (uri.startsWith("card://")) {
    const contents = readCardResource(uri);
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
