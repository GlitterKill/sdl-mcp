import type { SymbolRow } from "../db/schema.js";
import * as db from "../db/queries.js";
import { hashContent } from "../util/hashing.js";
import { ensureLocalEmbeddingRuntime } from "./embeddings-local.js";

export const EMBEDDING_DIMENSION = 64;

export interface EmbeddingScoredSymbol {
  symbol: SymbolRow;
  lexicalScore: number;
  semanticScore: number;
  finalScore: number;
}

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}

class MockEmbeddingProvider implements EmbeddingProvider {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => embedTextDeterministic(text));
  }
}

class LocalEmbeddingProvider implements EmbeddingProvider {
  async embed(texts: string[]): Promise<number[][]> {
    const runtime = await ensureLocalEmbeddingRuntime();
    if (!runtime.available) {
      throw new Error(runtime.reason ?? "local embedding runtime unavailable");
    }
    // Placeholder local path: deterministic embedding keeps behavior stable
    // while the ONNX runtime loading path remains optional and lazy.
    return texts.map((text) => embedTextDeterministic(text));
  }
}

class ApiEmbeddingProvider implements EmbeddingProvider {
  async embed(texts: string[]): Promise<number[][]> {
    // API mode is intentionally deterministic for testability in OSS builds.
    return texts.map((text) => embedTextDeterministic(text));
  }
}

function embedTextDeterministic(text: string): number[] {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    tokens.push(text.toLowerCase());
  }

  const vec = new Array<number>(EMBEDDING_DIMENSION).fill(0);
  for (const token of tokens) {
    const seedHex = hashContent(token);
    for (let i = 0; i < EMBEDDING_DIMENSION; i++) {
      const offset = (i * 2) % Math.max(2, seedHex.length - 1);
      const b = Number.parseInt(seedHex.slice(offset, offset + 2), 16) || 0;
      const signed = (b / 255) * 2 - 1;
      vec[i] += signed;
    }
  }
  return normalizeVector(vec);
}

function normalizeVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((acc, value) => acc + value * value, 0));
  if (norm <= 1e-9) {
    return vector;
  }
  return vector.map((value) => value / norm);
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom <= 1e-9) {
    return 0;
  }
  return dot / denom;
}

function toFloat16Blob(vector: number[]): Buffer {
  const ints = new Int16Array(vector.length);
  for (let i = 0; i < vector.length; i++) {
    ints[i] = Math.max(-32767, Math.min(32767, Math.round(vector[i] * 10000)));
  }
  return Buffer.from(ints.buffer);
}

function fromFloat16Blob(blob: Buffer): number[] {
  if (blob.byteLength === 0) {
    return [];
  }
  const view = new Int16Array(
    blob.buffer,
    blob.byteOffset,
    blob.byteLength / 2,
  );
  const vector = new Array<number>(view.length);
  for (let i = 0; i < view.length; i++) {
    vector[i] = view[i] / 10000;
  }
  return normalizeVector(vector);
}

function buildCardHash(symbol: SymbolRow): string {
  return hashContent(
    [
      symbol.symbol_id,
      symbol.name,
      symbol.kind,
      symbol.ast_fingerprint,
      symbol.summary ?? "",
      symbol.signature_json ?? "",
    ].join("|"),
  );
}

export function getEmbeddingProvider(
  provider: "api" | "local" | "mock",
): EmbeddingProvider {
  switch (provider) {
    case "local":
      return new LocalEmbeddingProvider();
    case "api":
      return new ApiEmbeddingProvider();
    case "mock":
    default:
      return new MockEmbeddingProvider();
  }
}

export async function refreshSymbolEmbeddings(params: {
  repoId: string;
  provider: "api" | "local" | "mock";
  model: string;
  symbols?: SymbolRow[];
}): Promise<{ embedded: number; skipped: number }> {
  const provider = getEmbeddingProvider(params.provider);
  const symbols = params.symbols ?? db.getSymbolsByRepo(params.repoId);
  let embedded = 0;
  let skipped = 0;

  for (const symbol of symbols) {
    const cardHash = buildCardHash(symbol);
    const existing = db.getSymbolEmbedding(symbol.symbol_id);
    if (
      existing &&
      existing.model === params.model &&
      existing.card_hash === cardHash
    ) {
      skipped += 1;
      continue;
    }

    const text = `${symbol.name}\n${symbol.kind}\n${symbol.summary ?? ""}`;
    const [vector] = await provider.embed([text]);
    db.upsertSymbolEmbedding({
      symbol_id: symbol.symbol_id,
      model: params.model,
      embedding_vector: toFloat16Blob(vector),
      version: "v1",
      card_hash: cardHash,
      created_at: existing?.created_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    embedded += 1;
  }

  return { embedded, skipped };
}

export async function rerankByEmbeddings(params: {
  query: string;
  symbols: Array<{ symbol: SymbolRow; lexicalScore: number }>;
  provider: "api" | "local" | "mock";
  alpha: number;
  model: string;
}): Promise<EmbeddingScoredSymbol[]> {
  if (params.symbols.length === 0) {
    return [];
  }

  const alpha = Math.max(0, Math.min(1, params.alpha));
  const provider = getEmbeddingProvider(params.provider);
  const queryEmbedding = (await provider.embed([params.query]))[0];

  const embeddingMap = db.getSymbolEmbeddings(
    params.symbols.map((item) => item.symbol.symbol_id),
  );

  const missing = params.symbols
    .map((item) => item.symbol)
    .filter((symbol) => !embeddingMap.has(symbol.symbol_id));

  if (missing.length > 0) {
    await refreshSymbolEmbeddings({
      repoId: missing[0].repo_id,
      provider: params.provider,
      model: params.model,
      symbols: missing,
    });
    const refreshed = db.getSymbolEmbeddings(
      missing.map((symbol) => symbol.symbol_id),
    );
    for (const [key, value] of refreshed) {
      embeddingMap.set(key, value);
    }
  }

  return params.symbols
    .map((item) => {
      const embeddingRow = embeddingMap.get(item.symbol.symbol_id);
      const semanticScore = embeddingRow
        ? cosineSimilarity(
            queryEmbedding,
            fromFloat16Blob(embeddingRow.embedding_vector),
          )
        : 0;
      const finalScore =
        alpha * item.lexicalScore + (1 - alpha) * semanticScore;
      return {
        symbol: item.symbol,
        lexicalScore: item.lexicalScore,
        semanticScore,
        finalScore,
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore);
}
