import type {
  RepoId,
  SymbolId,
  VersionId,
  EdgeType,
  EdgeResolutionStrategy,
} from "../../db/schema.js";
import type { SymbolDeps, Range, SymbolSignature } from "../../mcp/types.js";

export interface SymbolReadModel {
  symbolId: SymbolId;
  repoId: RepoId;
  file: string;
  range: Range;
  kind: string;
  name: string;
  exported: boolean;
  visibility?: string;
  signature?: SymbolSignature;
  summary?: string;
  invariants?: string[];
  sideEffects?: string[];
  version: {
    ledgerVersion: VersionId;
    astFingerprint: string;
  };
}

export interface EdgeReadModel {
  fromSymbolId: SymbolId;
  toSymbolId: SymbolId;
  repoId: RepoId;
  type: EdgeType;
  weight: number;
  confidence: number;
  resolutionStrategy: EdgeResolutionStrategy;
}

export interface SymbolSearchResult {
  symbolId: SymbolId;
  name: string;
  kind: string;
  file: string;
  summary?: string;
  score: number;
}

export interface SymbolRepository {
  getSymbol(
    repoId: RepoId,
    symbolId: SymbolId,
  ): Promise<SymbolReadModel | null>;

  getSymbolsByIds(
    repoId: RepoId,
    symbolIds: SymbolId[],
  ): Promise<Map<SymbolId, SymbolReadModel>>;

  getEdgesFrom(repoId: RepoId, symbolId: SymbolId): Promise<EdgeReadModel[]>;

  getEdgesTo(repoId: RepoId, symbolId: SymbolId): Promise<EdgeReadModel[]>;

  getEdgesByRepo(repoId: RepoId): Promise<EdgeReadModel[]>;

  searchSymbols(
    repoId: RepoId,
    query: string,
    limit: number,
  ): Promise<SymbolSearchResult[]>;

  getSymbolDeps(repoId: RepoId, symbolId: SymbolId): Promise<SymbolDeps>;

  getSymbolsByFile(
    repoId: RepoId,
    filePath: string,
  ): Promise<SymbolReadModel[]>;

  countSymbols(repoId: RepoId): Promise<number>;

  countEdges(repoId: RepoId): Promise<number>;
}

export class InMemorySymbolRepository implements SymbolRepository {
  private symbols = new Map<string, Map<SymbolId, SymbolReadModel>>();
  private edges = new Map<string, EdgeReadModel[]>();
  private fileIndex = new Map<string, Map<string, SymbolReadModel[]>>();

  addSymbol(repoId: RepoId, symbol: SymbolReadModel): void {
    if (!this.symbols.has(repoId)) {
      this.symbols.set(repoId, new Map());
    }
    this.symbols.get(repoId)!.set(symbol.symbolId, symbol);

    if (!this.fileIndex.has(repoId)) {
      this.fileIndex.set(repoId, new Map());
    }
    const fileMap = this.fileIndex.get(repoId)!;
    if (!fileMap.has(symbol.file)) {
      fileMap.set(symbol.file, []);
    }
    fileMap.get(symbol.file)!.push(symbol);
  }

  addEdge(repoId: RepoId, edge: EdgeReadModel): void {
    if (!this.edges.has(repoId)) {
      this.edges.set(repoId, []);
    }
    const existing = this.edges.get(repoId)!;
    const idx = existing.findIndex(
      (e) =>
        e.fromSymbolId === edge.fromSymbolId &&
        e.toSymbolId === edge.toSymbolId &&
        e.type === edge.type,
    );
    if (idx >= 0) {
      existing[idx] = edge;
    } else {
      existing.push(edge);
    }
  }

  removeSymbol(repoId: RepoId, symbolId: SymbolId): void {
    const repoSymbols = this.symbols.get(repoId);
    if (!repoSymbols) return;

    const symbol = repoSymbols.get(symbolId);
    if (symbol) {
      const fileMap = this.fileIndex.get(repoId);
      if (fileMap && fileMap.has(symbol.file)) {
        const fileSymbols = fileMap.get(symbol.file)!;
        const idx = fileSymbols.findIndex((s) => s.symbolId === symbolId);
        if (idx >= 0) fileSymbols.splice(idx, 1);
      }
    }

    repoSymbols.delete(symbolId);

    const repoEdges = this.edges.get(repoId);
    if (repoEdges) {
      const filtered = repoEdges.filter(
        (e) => e.fromSymbolId !== symbolId && e.toSymbolId !== symbolId,
      );
      this.edges.set(repoId, filtered);
    }
  }

  clear(repoId: RepoId): void {
    this.symbols.delete(repoId);
    this.edges.delete(repoId);
    this.fileIndex.delete(repoId);
  }

  async getSymbol(
    repoId: RepoId,
    symbolId: SymbolId,
  ): Promise<SymbolReadModel | null> {
    const repoSymbols = this.symbols.get(repoId);
    if (!repoSymbols) return null;
    return repoSymbols.get(symbolId) ?? null;
  }

  async getSymbolsByIds(
    repoId: RepoId,
    symbolIds: SymbolId[],
  ): Promise<Map<SymbolId, SymbolReadModel>> {
    const result = new Map<SymbolId, SymbolReadModel>();
    const repoSymbols = this.symbols.get(repoId);
    if (!repoSymbols) return result;

    for (const id of symbolIds) {
      const symbol = repoSymbols.get(id);
      if (symbol) result.set(id, symbol);
    }
    return result;
  }

  async getEdgesFrom(
    repoId: RepoId,
    symbolId: SymbolId,
  ): Promise<EdgeReadModel[]> {
    const repoEdges = this.edges.get(repoId);
    if (!repoEdges) return [];
    return repoEdges.filter((e) => e.fromSymbolId === symbolId);
  }

  async getEdgesTo(
    repoId: RepoId,
    symbolId: SymbolId,
  ): Promise<EdgeReadModel[]> {
    const repoEdges = this.edges.get(repoId);
    if (!repoEdges) return [];
    return repoEdges.filter((e) => e.toSymbolId === symbolId);
  }

  async getEdgesByRepo(repoId: RepoId): Promise<EdgeReadModel[]> {
    return this.edges.get(repoId) ?? [];
  }

  async searchSymbols(
    repoId: RepoId,
    query: string,
    limit: number,
  ): Promise<SymbolSearchResult[]> {
    const repoSymbols = this.symbols.get(repoId);
    if (!repoSymbols) return [];

    const q = query.toLowerCase();
    const results: SymbolSearchResult[] = [];

    for (const symbol of repoSymbols.values()) {
      if (symbol.name.toLowerCase().includes(q)) {
        results.push({
          symbolId: symbol.symbolId,
          name: symbol.name,
          kind: symbol.kind,
          file: symbol.file,
          summary: symbol.summary,
          score: symbol.name.toLowerCase() === q ? 1.0 : 0.5,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  async getSymbolDeps(repoId: RepoId, symbolId: SymbolId): Promise<SymbolDeps> {
    const edges = await this.getEdgesFrom(repoId, symbolId);
    const imports: string[] = [];
    const calls: string[] = [];

    for (const edge of edges) {
      if (edge.type === "import") {
        imports.push(edge.toSymbolId);
      } else if (edge.type === "call") {
        calls.push(edge.toSymbolId);
      }
    }

    return { imports, calls };
  }

  async getSymbolsByFile(
    repoId: RepoId,
    filePath: string,
  ): Promise<SymbolReadModel[]> {
    const fileMap = this.fileIndex.get(repoId);
    if (!fileMap) return [];
    return fileMap.get(filePath) ?? [];
  }

  async countSymbols(repoId: RepoId): Promise<number> {
    const repoSymbols = this.symbols.get(repoId);
    return repoSymbols?.size ?? 0;
  }

  async countEdges(repoId: RepoId): Promise<number> {
    const repoEdges = this.edges.get(repoId);
    return repoEdges?.length ?? 0;
  }
}

export function createInMemoryRepository(): InMemorySymbolRepository {
  return new InMemorySymbolRepository();
}
