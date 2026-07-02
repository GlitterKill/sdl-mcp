import { randomBytes } from "crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import { gzip, gunzip } from "zlib";

import {
  RUNTIME_DEFAULT_MAX_ARTIFACT_BYTES,
  RUNTIME_DEFAULT_MAX_RESPONSE_ARTIFACTS_PER_REPO,
  RUNTIME_DEFAULT_MAX_RESPONSE_ARTIFACT_BYTES_PER_REPO,
  RUNTIME_DEFAULT_MAX_RESPONSE_ARTIFACT_BYTES_TOTAL,
  RUNTIME_DEFAULT_MAX_RESPONSE_ARTIFACTS_TOTAL,
} from "../config/constants.js";
import { hashContent } from "../util/hashing.js";
import { getArtifactBaseDir } from "./artifacts.js";

const gzipAsync = promisify(gzip) as (buffer: Buffer) => Promise<Buffer>;
const gunzipAsync = promisify(gunzip) as (
  buffer: Buffer,
  options?: { maxOutputLength?: number },
) => Promise<Buffer>;

export type ResponseMode = "inline" | "auto" | "handle";
export type ResponseContentKind = "json" | "text";

export const DEFAULT_RESPONSE_ARTIFACT_TTL_HOURS = 24;
export const DEFAULT_RESPONSE_ARTIFACT_THRESHOLD_TOKENS = 8_000;
export const DEFAULT_RESPONSE_EXCERPT_BYTES = 8 * 1024;
export const MAX_RESPONSE_EXCERPT_BYTES = 1024 * 1024;
export const DEFAULT_RESPONSE_MAX_ARTIFACT_BYTES =
  RUNTIME_DEFAULT_MAX_ARTIFACT_BYTES;
export const DEFAULT_RESPONSE_MAX_ARTIFACTS_PER_REPO =
  RUNTIME_DEFAULT_MAX_RESPONSE_ARTIFACTS_PER_REPO;
export const DEFAULT_RESPONSE_MAX_REPO_STORED_BYTES =
  RUNTIME_DEFAULT_MAX_RESPONSE_ARTIFACT_BYTES_PER_REPO;
export const DEFAULT_RESPONSE_MAX_TOTAL_STORED_BYTES =
  RUNTIME_DEFAULT_MAX_RESPONSE_ARTIFACT_BYTES_TOTAL;
export const DEFAULT_RESPONSE_MAX_ARTIFACTS_TOTAL =
  RUNTIME_DEFAULT_MAX_RESPONSE_ARTIFACTS_TOTAL;
const DEFAULT_RESPONSE_SWEEP_DELETE_LIMIT = 64;

const RESPONSE_DIR_NAME = "responses";
const RESPONSE_HANDLE_RE = /^response-[A-Za-z0-9_-]+-\d{13}-[a-f0-9]{16}$/;
const responseArtifactWriteLocks = new Map<string, Promise<void>>();

export interface ResponseArtifactMetadata {
  id: string;
  handle: string;
  repoId: string;
  toolName: string;
  createdAt: string;
  expiresAt: string;
  estimatedOriginalTokens: number;
  originalBytes: number;
  storedBytes: number;
  sha256: string;
  etag: string;
  contentKind: ResponseContentKind;
  requiresSameSession?: boolean;
  sessionKeyHash?: string;
}

export type ResponseArtifactPublicMetadata = Pick<ResponseArtifactMetadata, "toolName">;

export interface ResponseArtifactSavings {
  originalTokens: number;
  returnedTokens: number;
  savedTokens: number;
  originalBytes: number;
  returnedBytes: number;
  savedBytes: number;
}

export interface ResponseArtifactReference {
  responseMode: "handle";
  kind: "responseArtifact";
  handle: string;
  action: "response.get";
  metadata?: ResponseArtifactPublicMetadata;
}

export type MaybeStoreLargeResponseResult<T> =
  | {
      responseMode: "inline";
      payload: T;
      metadata: Pick<
        ResponseArtifactMetadata,
        "contentKind" | "estimatedOriginalTokens" | "originalBytes"
      >;
    }
  | {
      responseMode: "handle";
      payload: ResponseArtifactReference;
      metadata: ResponseArtifactMetadata;
    };

export interface MaybeStoreLargeResponseOptions<T> {
  repoId: string;
  toolName: string;
  payload: T;
  responseMode?: ResponseMode;
  threshold?: number;
  contentKind?: ResponseContentKind;
  artifactBaseDir?: string | null;
  artifactTtlHours?: number;
  maxArtifactBytes?: number;
  maxArtifactsPerRepo?: number;
  maxStoredBytesPerRepo?: number;
  maxStoredBytesTotal?: number;
  maxArtifactsTotal?: number;
  sessionId?: string;
  requiresSameSession?: boolean;
  now?: () => Date;
  entropy?: () => string;
}

export interface ResponseArtifactReadOptions {
  repoId: string;
  handle: string;
  full?: boolean;
  maxBytes?: number;
  maxTokens?: number;
  offsetBytes?: number;
  jsonPath?: string;
  raw?: boolean;
  offset?: number;
  limit?: number;
  artifactBaseDir?: string | null;
  maxFullBytes?: number;
  sessionId?: string;
  now?: () => Date;
}

export interface ResponseArtifactPagination {
  offset: number;
  limit: number;
  total: number;
  returned: number;
  hasMore: boolean;
  nextOffset?: number;
}

export interface ResponseArtifactReadResult {
  handle: string;
  full: boolean;
  truncated: boolean;
  contentKind: ResponseContentKind;
  content: unknown;
  metadata: ResponseArtifactPublicMetadata;
  range: {
    offsetBytes: number;
    returnedBytes: number;
    totalBytes: number;
    estimatedReturnedTokens: number;
  };
  pagination?: ResponseArtifactPagination;
  savings: ResponseArtifactSavings;
}

function estimateTokensFromBytes(bytes: number): number {
  return Math.ceil(bytes / 4);
}

const BLOCKED_JSON_PATH_SEGMENTS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

function normalizeJsonPathSegments(keyPath: string): string[] | undefined {
  const withoutRoot = keyPath.startsWith("$.")
    ? keyPath.slice(2)
    : keyPath.startsWith("$")
      ? keyPath.slice(1)
      : keyPath;
  const normalized = withoutRoot.replace(/\[(\d+)\]/g, ".$1");
  if (normalized.includes("[") || normalized.includes("]")) return undefined;
  const segments = normalized.split(".");
  return segments.length > 0 ? segments : undefined;
}

function extractJsonPath(obj: unknown, keyPath: string): unknown {
  const segments = normalizeJsonPathSegments(keyPath);
  if (!segments) return undefined;

  let current: unknown = obj;
  for (const segment of segments) {
    if (!segment || BLOCKED_JSON_PATH_SEGMENTS.has(segment)) return undefined;
    if (current == null || typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0) return undefined;
      current = current[index];
    } else {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}

function safeRepoId(repoId: string): string {
  return repoId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function normalizeSessionScope(sessionId: string | undefined): string {
  const trimmed = sessionId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "stdio";
}

function hashSessionScope(sessionId: string | undefined): string {
  return hashContent(`response-artifact-session:${normalizeSessionScope(sessionId)}`);
}

function serializePayload(
  payload: unknown,
  requestedKind?: ResponseContentKind,
): { content: string; contentKind: ResponseContentKind } {
  const contentKind = requestedKind ?? (typeof payload === "string" ? "text" : "json");
  if (contentKind === "text") {
    return {
      content:
        typeof payload === "string"
          ? payload
          : (JSON.stringify(payload) ?? String(payload)),
      contentKind,
    };
  }
  return {
    content: JSON.stringify(payload) ?? "null",
    contentKind,
  };
}

export function isValidResponseArtifactHandle(handle: string): boolean {
  return RESPONSE_HANDLE_RE.test(handle);
}

export function getResponseArtifactBaseDir(baseDir?: string | null): string {
  return join(getArtifactBaseDir(baseDir), RESPONSE_DIR_NAME);
}

export function generateResponseArtifactHandle(
  repoId: string,
  now: Date = new Date(),
  entropy: string = randomBytes(8).toString("hex"),
): string {
  return `response-${safeRepoId(repoId)}-${now.getTime()}-${entropy}`;
}

function metadataPath(baseDir: string, handle: string): string {
  return join(baseDir, handle, "manifest.json");
}

function contentPath(baseDir: string, handle: string): string {
  return join(baseDir, handle, "content.gz");
}

interface ResponseArtifactManifestEntry {
  handle: string;
  metadata: ResponseArtifactMetadata;
}

async function withResponseArtifactWriteLock<T>(
  baseDir: string,
  body: () => Promise<T>,
): Promise<T> {
  const lockKey = baseDir;
  const previous = responseArtifactWriteLocks.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.catch(() => undefined).then(() => current);
  responseArtifactWriteLocks.set(lockKey, chained);

  await previous.catch(() => undefined);
  try {
    return await body();
  } finally {
    release();
    if (responseArtifactWriteLocks.get(lockKey) === chained) {
      responseArtifactWriteLocks.delete(lockKey);
    }
  }
}

function createSavings(
  metadata: ResponseArtifactMetadata,
  returnedBytes: number,
): ResponseArtifactSavings {
  const returnedTokens = estimateTokensFromBytes(returnedBytes);
  return {
    originalTokens: metadata.estimatedOriginalTokens,
    returnedTokens,
    savedTokens: Math.max(0, metadata.estimatedOriginalTokens - returnedTokens),
    originalBytes: metadata.originalBytes,
    returnedBytes,
    savedBytes: Math.max(0, metadata.originalBytes - returnedBytes),
  };
}

function createReference(metadata: ResponseArtifactMetadata): ResponseArtifactReference {
  return {
    responseMode: "handle",
    kind: "responseArtifact",
    handle: metadata.handle,
    action: "response.get",
  };
}

function toPublicMetadata(metadata: ResponseArtifactMetadata): ResponseArtifactPublicMetadata {
  return { toolName: metadata.toolName };
}

function stripTimestampFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripTimestampFields);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "timestamp")
      .map(([key, entry]) => [key, stripTimestampFields(entry)]),
  );
}


export async function maybeStoreLargeResponse<T>(
  opts: MaybeStoreLargeResponseOptions<T>,
): Promise<MaybeStoreLargeResponseResult<T>> {
  const responseMode = opts.responseMode ?? "inline";
  const { content, contentKind } = serializePayload(opts.payload, opts.contentKind);
  const originalBytes = Buffer.byteLength(content, "utf-8");
  const estimatedOriginalTokens = estimateTokensFromBytes(originalBytes);
  const threshold = opts.threshold ?? DEFAULT_RESPONSE_ARTIFACT_THRESHOLD_TOKENS;
  const maxArtifactBytes =
    opts.maxArtifactBytes ?? DEFAULT_RESPONSE_MAX_ARTIFACT_BYTES;

  if (
    responseMode === "inline" ||
    (responseMode === "auto" && estimatedOriginalTokens <= threshold)
  ) {
    return {
      responseMode: "inline",
      payload: opts.payload,
      metadata: { contentKind, estimatedOriginalTokens, originalBytes },
    };
  }

  const now = opts.now?.() ?? new Date();
  const handle = generateResponseArtifactHandle(
    opts.repoId,
    now,
    opts.entropy?.() ?? randomBytes(8).toString("hex"),
  );
  const baseDir = getResponseArtifactBaseDir(opts.artifactBaseDir);
  const artifactDir = join(baseDir, handle);
  if (originalBytes > maxArtifactBytes) {
    throw new Error(
      `Response artifact exceeds maxArtifactBytes (${originalBytes} > ${maxArtifactBytes})`,
    );
  }
  const compressed = await gzipAsync(Buffer.from(content, "utf-8"));
  if (compressed.length > maxArtifactBytes) {
    throw new Error(
      `Compressed response artifact exceeds maxArtifactBytes (${compressed.length} > ${maxArtifactBytes})`,
    );
  }
  const sha256 = hashContent(content);
  const ttlHours = opts.artifactTtlHours ?? DEFAULT_RESPONSE_ARTIFACT_TTL_HOURS;
  const metadata: ResponseArtifactMetadata = {
    id: handle,
    handle,
    repoId: opts.repoId,
    toolName: opts.toolName,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlHours * 3600_000).toISOString(),
    estimatedOriginalTokens,
    originalBytes,
    storedBytes: compressed.length,
    sha256,
    etag: sha256,
    contentKind,
    requiresSameSession: opts.requiresSameSession === true,
    ...(opts.requiresSameSession === true
      ? { sessionKeyHash: hashSessionScope(opts.sessionId) }
      : {}),
  };

  await withResponseArtifactWriteLock(baseDir, async () => {
    await mkdir(baseDir, { recursive: true });
    await sweepExpiredResponseArtifacts(baseDir, now);
    await enforceResponseArtifactQuota(baseDir, opts.repoId, {
      incomingStoredBytes: compressed.length,
      maxArtifactsPerRepo: opts.maxArtifactsPerRepo,
      maxStoredBytesPerRepo: opts.maxStoredBytesPerRepo,
      maxStoredBytesTotal: opts.maxStoredBytesTotal,
      maxArtifactsTotal: opts.maxArtifactsTotal,
    });
    await mkdir(artifactDir, { recursive: true });
    await Promise.all([
      writeFile(contentPath(baseDir, handle), compressed),
      writeFile(metadataPath(baseDir, handle), JSON.stringify(metadata, null, 2), "utf-8"),
    ]);
  });

  return {
    responseMode: "handle",
    payload: createReference(metadata),
    metadata,
  };
}

async function readMetadata(
  handle: string,
  baseDir: string,
): Promise<ResponseArtifactMetadata> {
  if (!isValidResponseArtifactHandle(handle)) {
    throw new Error("Invalid response artifact handle");
  }
  const raw = await readFile(metadataPath(baseDir, handle), "utf-8");
  return JSON.parse(raw) as ResponseArtifactMetadata;
}

async function readManifestEntries(
  baseDir: string,
): Promise<ResponseArtifactManifestEntry[]> {
  let dirs;
  try {
    dirs = await readdir(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const manifests: ResponseArtifactManifestEntry[] = [];
  for (const dir of dirs) {
    if (!dir.isDirectory() || !isValidResponseArtifactHandle(dir.name)) continue;
    try {
      const metadata = await readMetadata(dir.name, baseDir);
      manifests.push({ handle: dir.name, metadata });
    } catch {
      // Ignore malformed or concurrently removed artifact directories.
    }
  }
  return manifests;
}

async function sweepExpiredResponseArtifacts(
  baseDir: string,
  now: Date,
  maxDeletes = DEFAULT_RESPONSE_SWEEP_DELETE_LIMIT,
): Promise<void> {
  const entries = await readManifestEntries(baseDir);
  const nowMs = now.getTime();
  let deleted = 0;
  for (const entry of entries) {
    if (deleted >= maxDeletes) break;
    if (new Date(entry.metadata.expiresAt).getTime() > nowMs) continue;
    await rm(join(baseDir, entry.handle), { recursive: true, force: true });
    deleted += 1;
  }
}

async function enforceResponseArtifactQuota(
  baseDir: string,
  repoId: string,
  opts: {
    incomingStoredBytes: number;
    maxArtifactsPerRepo?: number;
    maxStoredBytesPerRepo?: number;
    maxStoredBytesTotal?: number;
    maxArtifactsTotal?: number;
  },
): Promise<void> {
  const maxArtifactsPerRepo =
    opts.maxArtifactsPerRepo ?? RUNTIME_DEFAULT_MAX_RESPONSE_ARTIFACTS_PER_REPO;
  const maxStoredBytesPerRepo =
    opts.maxStoredBytesPerRepo ??
    RUNTIME_DEFAULT_MAX_RESPONSE_ARTIFACT_BYTES_PER_REPO;
  const maxStoredBytesTotal =
    opts.maxStoredBytesTotal ?? DEFAULT_RESPONSE_MAX_TOTAL_STORED_BYTES;
  const maxArtifactsTotal =
    opts.maxArtifactsTotal ?? DEFAULT_RESPONSE_MAX_ARTIFACTS_TOTAL;
  let allEntries = (await readManifestEntries(baseDir))
    .sort(
      (a, b) =>
        new Date(a.metadata.createdAt).getTime() -
        new Date(b.metadata.createdAt).getTime(),
    );
  const entries = allEntries.filter((entry) => entry.metadata.repoId === repoId);
  let storedBytes = entries.reduce(
    (sum, entry) => sum + Math.max(0, entry.metadata.storedBytes),
    0,
  );
  let totalStoredBytes = allEntries.reduce(
    (sum, entry) => sum + Math.max(0, entry.metadata.storedBytes),
    0,
  );
  const removedHandles = new Set<string>();

  while (
    entries.length > 0 &&
    (entries.length >= maxArtifactsPerRepo ||
      storedBytes + opts.incomingStoredBytes > maxStoredBytesPerRepo)
  ) {
    const oldest = entries.shift();
    if (!oldest) break;
    await rm(join(baseDir, oldest.handle), { recursive: true, force: true });
    removedHandles.add(oldest.handle);
    storedBytes -= Math.max(0, oldest.metadata.storedBytes);
    totalStoredBytes -= Math.max(0, oldest.metadata.storedBytes);
  }

  if (
    entries.length >= maxArtifactsPerRepo ||
    storedBytes + opts.incomingStoredBytes > maxStoredBytesPerRepo
  ) {
    throw new Error("Response artifact quota exceeded");
  }

  allEntries = allEntries.filter((entry) => !removedHandles.has(entry.handle));

  while (
    allEntries.length > 0 &&
    (allEntries.length >= maxArtifactsTotal ||
      totalStoredBytes + opts.incomingStoredBytes > maxStoredBytesTotal)
  ) {
    const oldest = allEntries.shift();
    if (!oldest) break;
    await rm(join(baseDir, oldest.handle), { recursive: true, force: true });
    totalStoredBytes -= Math.max(0, oldest.metadata.storedBytes);
  }

  if (
    allEntries.length >= maxArtifactsTotal ||
    totalStoredBytes + opts.incomingStoredBytes > maxStoredBytesTotal
  ) {
    throw new Error("Response artifact total quota exceeded");
  }
}

export async function readResponseArtifact(
  opts: ResponseArtifactReadOptions,
): Promise<ResponseArtifactReadResult> {
  const baseDir = getResponseArtifactBaseDir(opts.artifactBaseDir);
  const metadata = await readMetadata(opts.handle, baseDir);
  if (metadata.repoId !== opts.repoId) {
    throw new Error("Response artifact belongs to a different repository");
  }
  if (
    metadata.requiresSameSession === true &&
    metadata.sessionKeyHash !== hashSessionScope(opts.sessionId)
  ) {
    throw new Error("Response artifact is not available in this session");
  }

  const now = opts.now?.() ?? new Date();
  if (new Date(metadata.expiresAt).getTime() <= now.getTime()) {
    await rm(join(baseDir, opts.handle), { recursive: true, force: true });
    throw new Error("Response artifact expired");
  }

  const maxFullBytes = opts.maxFullBytes ?? DEFAULT_RESPONSE_MAX_ARTIFACT_BYTES;
  if (metadata.originalBytes > maxFullBytes) {
    throw new Error(
      `Response artifact exceeds retrieval size limit (${metadata.originalBytes} > ${maxFullBytes})`,
    );
  }

  const compressed = await readFile(contentPath(baseDir, opts.handle));
  let decompressed: Buffer;
  try {
    decompressed = await gunzipAsync(compressed, {
      maxOutputLength: maxFullBytes,
    });
  } catch (err) {
    throw new Error(
      `Response artifact exceeds retrieval size limit: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (decompressed.length > maxFullBytes) {
    throw new Error(
      `Response artifact exceeds retrieval size limit (${decompressed.length} > ${maxFullBytes})`,
    );
  }

  if (opts.jsonPath !== undefined) {
    if (metadata.contentKind !== "json") {
      throw new Error("jsonPath is only supported for JSON response artifacts");
    }
    const parsed = JSON.parse(decompressed.toString("utf-8")) as unknown;
    const extractedContent = extractJsonPath(parsed, opts.jsonPath);
    if (extractedContent === undefined) {
      throw new Error(`jsonPath not found: ${opts.jsonPath}`);
    }

    let content = extractedContent;
    let pagination: ResponseArtifactPagination | undefined;
    if (Array.isArray(extractedContent) && (opts.offset !== undefined || opts.limit !== undefined)) {
      const offset = Math.min(Math.max(0, opts.offset ?? 0), extractedContent.length);
      const limit = Math.max(1, opts.limit ?? extractedContent.length);
      const page = extractedContent.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      const hasMore = nextOffset < extractedContent.length;
      content = page;
      pagination = {
        offset,
        limit,
        total: extractedContent.length,
        returned: page.length,
        hasMore,
        ...(hasMore ? { nextOffset } : {}),
      };
    }

    const returnedText = JSON.stringify(content);
    const returnedBytes = Buffer.byteLength(returnedText, "utf-8");
    if (Array.isArray(extractedContent)) {
      const tokenBoundBytes =
        opts.maxTokens === undefined ? undefined : Math.max(1, opts.maxTokens * 4);
      const requestedMaxBytes = opts.maxBytes ?? tokenBoundBytes;
      if (requestedMaxBytes !== undefined && returnedBytes > requestedMaxBytes) {
        throw new Error(
          "JSON path result exceeds requested byte/token bound; use offset/limit to page array results.",
        );
      }
    }

    return {
      handle: opts.handle,
      full: false,
      truncated: pagination?.hasMore ?? false,
      contentKind: metadata.contentKind,
      content: stripTimestampFields(content),
      metadata: toPublicMetadata(metadata),
      range: {
        offsetBytes: 0,
        returnedBytes,
        totalBytes: metadata.originalBytes,
        estimatedReturnedTokens: estimateTokensFromBytes(returnedBytes),
      },
      ...(pagination ? { pagination } : {}),
      savings: createSavings(metadata, returnedBytes),
    };
  }

  const offsetBytes = Math.min(
    Math.max(0, opts.offsetBytes ?? 0),
    decompressed.length,
  );
  const tokenBoundBytes =
    opts.maxTokens === undefined ? undefined : Math.max(1, opts.maxTokens * 4);
  const requestedMaxBytes = opts.maxBytes ?? tokenBoundBytes ?? DEFAULT_RESPONSE_EXCERPT_BYTES;
  const boundedMaxBytes = Math.min(
    Math.max(1, requestedMaxBytes),
    MAX_RESPONSE_EXCERPT_BYTES,
    tokenBoundBytes ?? MAX_RESPONSE_EXCERPT_BYTES,
  );
  const full = opts.full ?? false;
  const returnedBuffer = full
    ? decompressed
    : decompressed.subarray(offsetBytes, offsetBytes + boundedMaxBytes);
  const returnedText = returnedBuffer.toString("utf-8");
  const truncated = !full && offsetBytes + returnedBuffer.length < decompressed.length;
  const content =
    full && metadata.contentKind === "json"
      ? (JSON.parse(returnedText) as unknown)
      : returnedText;
  const returnedBytes = Buffer.byteLength(returnedText, "utf-8");

  return {
    handle: opts.handle,
    full,
    truncated,
    contentKind: metadata.contentKind,
    content: stripTimestampFields(content),
    metadata: toPublicMetadata(metadata),
    range: {
      offsetBytes: full ? 0 : offsetBytes,
      returnedBytes,
      totalBytes: metadata.originalBytes,
      estimatedReturnedTokens: estimateTokensFromBytes(returnedBytes),
    },
    savings: createSavings(metadata, returnedBytes),
  };
}
