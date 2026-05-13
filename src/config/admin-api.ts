import { createHash, randomUUID } from "crypto";
import { constants as fsConstants } from "fs";
import {
  access,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
} from "fs/promises";
import { homedir } from "os";
import {
  basename,
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from "path";

import { logger } from "../util/logger.js";
import { resolveCliConfigPath } from "./configPath.js";
import { invalidateConfigCache, loadConfig } from "./loadConfig.js";
import { AppConfigSchema } from "./types.js";
import {
  CONFIG_UI_FIELD_METADATA,
  CONFIG_UI_SECTIONS,
  getConfigUiMetadata,
  getImpactForPointer,
  getSectionForPointer,
  isHighRiskPointer,
  isSecretPointer,
  type ConfigImpact,
} from "./admin-metadata.js";

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface ConfigAdminApiRequest {
  method?: string;
  pathname: string;
  body?: unknown;
  isLoopback: boolean;
  remoteAddress?: string;
}

export interface ConfigAdminApiResponse {
  status: number;
  payload: unknown;
  headers?: Record<string, string>;
}

interface ValidationMessage {
  path: string;
  message: string;
  severity: "error" | "warning";
  code: string;
}

interface ConfigDiffEntry {
  path: string;
  kind: "added" | "changed" | "removed";
  before: JsonValue | undefined;
  after: JsonValue | undefined;
  impact: ConfigImpact[];
  highRisk: boolean;
  section: string;
}

interface ConfigSourceInfo {
  path: string;
  mtimeMs: number;
  sizeBytes: number;
  hash: string;
}

interface BackupSummary {
  id: string;
  path: string;
  createdAt: string;
  sizeBytes: number;
  hash: string;
}

interface ProfileSummary {
  id: string;
  name: string;
  description?: string;
  path: string;
  includesSecrets: boolean;
  patchCount: number;
}

interface ConfigSnapshot {
  source: ConfigSourceInfo;
  raw: JsonValue;
  effective: JsonValue | null;
  metadata: ReturnType<typeof getConfigUiMetadata>;
  validation: { ok: boolean; messages: ValidationMessage[] };
  backups: BackupSummary[];
  profiles: ProfileSummary[];
}

type PatchOperation =
  | { op: "set"; path: string; value: JsonValue }
  | { op: "delete"; path: string };

interface ConfigProfile {
  schemaVersion: 1;
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  sdlMcpVersion?: string;
  includesSecrets: boolean;
  patch: PatchOperation[];
}

interface SaveDraftConfigArgs {
  draft: JsonObject;
  expectedHash: string;
  highRiskAccepted: boolean;
  action: "save" | "rollback" | "profileApply";
  remoteAddress?: string;
  profileId?: string;
}

const REDACTED_SECRET: JsonObject = { __sdlSecret: true, state: "set" };
const BACKUP_DIR_NAME = ".sdl-config-backups";
const PROFILE_DIR = join(homedir(), ".sdl-mcp", "config-profiles");
const TOP_LEVEL_KNOWN_KEYS = new Set([
  "repos",
  "performanceTier",
  "graphDatabase",
  "policy",
  "redaction",
  "indexing",
  "liveIndex",
  "slice",
  "diagnostics",
  "cache",
  "plugins",
  "semantic",
  "semanticEnrichment",
  "prefetch",
  "tracing",
  "parallelScorer",
  "concurrency",
  "runtime",
  "gateway",
  "codeMode",
  "http",
  "security",
  "httpAuth",
  "memory",
  "scip",
  "wire",
  "observability",
]);
let configMutationQueue: Promise<void> = Promise.resolve();

export async function routeConfigAdminApiRequest(
  request: ConfigAdminApiRequest,
): Promise<ConfigAdminApiResponse | null> {
  if (
    request.pathname !== "/api/config" &&
    !request.pathname.startsWith("/api/config/")
  ) {
    return null;
  }

  const method = request.method ?? "GET";
  if (method !== "GET" && !request.isLoopback) {
    return {
      status: 403,
      payload: {
        error: "config_mutation_requires_loopback",
        message: "Configuration writes are only accepted from loopback clients.",
      },
    };
  }

  try {
    return await routeConfigAdminApiRequestInner(request, method);
  } catch (error) {
    logger.warn("Config admin route failed", { error });
    return {
      status: 400,
      payload: {
        error: "config_admin_error",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function readConfigAdminSnapshotForTest(): Promise<ConfigSnapshot> {
  return buildConfigSnapshot();
}

export function configAdminMetadataCoverageForTest(): {
  sections: string[];
  topLevelPaths: string[];
  secretPaths: string[];
  highRiskPaths: string[];
} {
  return {
    sections: CONFIG_UI_SECTIONS.map((section) => section.id),
    topLevelPaths: CONFIG_UI_FIELD_METADATA.map((field) => field.path),
    secretPaths: CONFIG_UI_FIELD_METADATA.filter((field) => field.secret).map(
      (field) => field.path,
    ),
    highRiskPaths: CONFIG_UI_FIELD_METADATA.filter((field) => field.highRisk).map(
      (field) => field.path,
    ),
  };
}

async function routeConfigAdminApiRequestInner(
  request: ConfigAdminApiRequest,
  method: string,
): Promise<ConfigAdminApiResponse> {
  if (method === "GET" && request.pathname === "/api/config") {
    const snapshot = await buildConfigSnapshot();
    return { status: 200, payload: snapshot, headers: { ETag: snapshot.source.hash } };
  }

  if (method === "POST" && request.pathname === "/api/config/validate") {
    const submittedDraft = readDraftFromBody(request.body);
    const current = await readRawConfig();
    const draft = restoreSecretPlaceholders(submittedDraft, current.raw);
    const validation = await validateDraft(draft);
    const diff = diffJson(current.raw, draft, "");
    return {
      status: validation.ok ? 200 : 400,
      payload: { validation, diff: redactDiff(diff), impact: summarizeImpact(diff) },
    };
  }

  if (method === "POST" && request.pathname === "/api/config/save") {
    const body = readBodyObject(request.body);
    return saveDraftConfig({
      draft: readBodyObject(body.draft, "draft"),
      expectedHash: readString(body.expectedHash, "expectedHash"),
      highRiskAccepted: body.highRiskAccepted === true,
      action: "save",
      remoteAddress: request.remoteAddress,
    });
  }

  if (method === "GET" && request.pathname === "/api/config/backups") {
    return { status: 200, payload: { backups: await listBackups() } };
  }

  if (method === "POST" && request.pathname === "/api/config/rollback") {
    const body = readBodyObject(request.body);
    const backup = await readBackupById(readString(body.backupId, "backupId"));
    if (!backup) return { status: 404, payload: { error: "backup_not_found" } };
    return saveDraftConfig({
      draft: await readJsonFile(backup.path),
      expectedHash: readString(body.expectedHash, "expectedHash"),
      highRiskAccepted: body.highRiskAccepted === true,
      action: "rollback",
      remoteAddress: request.remoteAddress,
    });
  }

  const profileResponse = await routeProfileRequest(request, method);
  if (profileResponse) return profileResponse;
  return { status: 404, payload: { error: "config_route_not_found" } };
}

async function routeProfileRequest(
  request: ConfigAdminApiRequest,
  method: string,
): Promise<ConfigAdminApiResponse | null> {
  const profileIdMatch = request.pathname.match(/^\/api\/config\/profiles\/([^/]+)$/);
  const profileApplyMatch = request.pathname.match(
    /^\/api\/config\/profiles\/([^/]+)\/apply$/,
  );
  const profilePreviewMatch = request.pathname.match(
    /^\/api\/config\/profiles\/([^/]+)\/preview$/,
  );

  if (request.pathname === "/api/config/profiles" && method === "GET") {
    return { status: 200, payload: { profiles: await listProfiles() } };
  }

  if (request.pathname === "/api/config/profiles" && method === "POST") {
    const profile = normalizeProfile(readBodyObject(request.body));
    await writeProfile(profile);
    return { status: 201, payload: { profile: profileToSummary(profile) } };
  }

  if (profileIdMatch && method === "GET") {
    const profile = await readProfile(profileIdMatch[1]);
    if (!profile) return { status: 404, payload: { error: "profile_not_found" } };
    return { status: 200, payload: { profile: redactProfile(profile) } };
  }

  if (profileIdMatch && method === "DELETE") {
    const profile = await readProfile(profileIdMatch[1]);
    if (!profile) return { status: 404, payload: { error: "profile_not_found" } };
    await unlink(profilePath(profile.id));
    return { status: 200, payload: { deleted: true, id: profile.id } };
  }

  if (profilePreviewMatch && method === "POST") {
    const profile = await readProfile(profilePreviewMatch[1]);
    if (!profile) return { status: 404, payload: { error: "profile_not_found" } };
    const body = isRecord(request.body) ? request.body : {};
    const current = await readRawConfig();
    const draft = applyPatchOperations(
      current.raw,
      filterProfilePatch(profile.patch, readOptionalStringArray(body.selectedPaths)),
    );
    const diff = diffJson(current.raw, draft, "");
    return {
      status: 200,
      payload: {
        profile: profileToSummary(profile),
        diff: redactDiff(diff),
        impact: summarizeImpact(diff),
        validation: await validateDraft(draft),
      },
    };
  }

  if (profileApplyMatch && method === "POST") {
    const profile = await readProfile(profileApplyMatch[1]);
    if (!profile) return { status: 404, payload: { error: "profile_not_found" } };
    const body = readBodyObject(request.body);
    const current = await readRawConfig();
    const draft = applyPatchOperations(
      current.raw,
      filterProfilePatch(profile.patch, readOptionalStringArray(body.selectedPaths)),
    );
    return saveDraftConfig({
      draft,
      expectedHash: readString(body.expectedHash, "expectedHash"),
      highRiskAccepted: body.highRiskAccepted === true,
      action: "profileApply",
      remoteAddress: request.remoteAddress,
      profileId: profile.id,
    });
  }

  return null;
}

async function buildConfigSnapshot(): Promise<ConfigSnapshot> {
  const current = await readRawConfig();
  const validation = await validateDraft(current.raw);
  let effective: JsonValue | null = null;
  try {
    invalidateConfigCache();
    effective = toJsonValue(loadConfig(current.source.path));
  } catch (error) {
    validation.messages.push({
      path: "/",
      message: error instanceof Error ? error.message : String(error),
      severity: "error",
      code: "effective_config_error",
    });
  }

  return {
    source: current.source,
    raw: redactSecrets(current.raw, ""),
    effective: effective ? redactSecrets(effective, "") : null,
    metadata: getConfigUiMetadata(),
    validation: {
      ok: validation.messages.every((message) => message.severity !== "error"),
      messages: validation.messages,
    },
    backups: await listBackups(),
    profiles: await listProfiles(),
  };
}

async function withConfigMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = configMutationQueue.catch(() => undefined);
  let release!: () => void;
  configMutationQueue = new Promise<void>((resolveQueue) => {
    release = resolveQueue;
  });

  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

async function saveDraftConfig(args: SaveDraftConfigArgs): Promise<ConfigAdminApiResponse> {
  return withConfigMutationLock(() => saveDraftConfigLocked(args));
}

async function saveDraftConfigLocked(args: SaveDraftConfigArgs): Promise<ConfigAdminApiResponse> {
  const current = await readRawConfig();
  if (current.source.hash !== args.expectedHash) {
    return { status: 409, payload: { error: "config_conflict", current: await buildConfigSnapshot() } };
  }

  const draft = restoreSecretPlaceholders(args.draft, current.raw);
  const validation = await validateDraft(draft);
  const diff = diffJson(current.raw, draft, "");
  if (diff.some((entry) => entry.highRisk) && !args.highRiskAccepted) {
    return {
      status: 409,
      payload: {
        error: "high_risk_confirmation_required",
        diff: redactDiff(diff),
        impact: summarizeImpact(diff),
        validation,
      },
    };
  }
  if (!validation.ok) {
    return {
      status: 400,
      payload: { error: "config_validation_failed", validation, diff: redactDiff(diff) },
    };
  }

  const backup = await writeBackup(current.source.path, current.rawText);
  await atomicWriteFile(
    current.source.path,
    `${JSON.stringify(orderConfigKeys(draft), null, 2)}\n`,
  );
  invalidateConfigCache();
  const updated = await readRawConfig();
  const impact = summarizeImpact(diff);

  logger.info("Config admin mutation applied", {
    action: args.action,
    profileId: args.profileId,
    remoteAddress: args.remoteAddress ?? "unknown",
    configPath: current.source.path,
    changedPaths: diff.map((entry) => entry.path),
    highRiskPaths: diff.filter((entry) => entry.highRisk).map((entry) => entry.path),
    backupPath: backup.path,
    impact,
  });

  return {
    status: 200,
    payload: {
      ok: true,
      source: updated.source,
      backup,
      diff: redactDiff(diff),
      impact,
      validation,
    },
  };
}

async function readRawConfig(): Promise<{
  source: ConfigSourceInfo;
  raw: JsonObject;
  rawText: string;
}> {
  const configPath = resolveCliConfigPath(undefined, "read");
  const rawText = await readFile(configPath, "utf8");
  const info = await stat(configPath);
  const parsed = JSON.parse(rawText.replace(/^\uFEFF/, "")) as unknown;
  if (!isRecord(parsed)) throw new Error("Config root must be a JSON object.");
  return {
    source: { path: configPath, mtimeMs: info.mtimeMs, sizeBytes: info.size, hash: hashText(rawText) },
    raw: toJsonObject(parsed),
    rawText,
  };
}

async function validateDraft(draft: JsonObject): Promise<{
  ok: boolean;
  messages: ValidationMessage[];
}> {
  const messages: ValidationMessage[] = [];
  const parsed = AppConfigSchema.safeParse(draft);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      messages.push({
        path: `/${issue.path.map((part) => escapePointer(String(part))).join("/")}`,
        message: issue.message,
        severity: "error",
        code: "schema",
      });
    }
  }
  messages.push(...collectUnknownTopLevelWarnings(draft));
  messages.push(...collectMissingEnvWarnings(draft, ""));
  messages.push(...(await collectSemanticMessages(draft)));
  return { ok: messages.every((message) => message.severity !== "error"), messages };
}

async function collectSemanticMessages(draft: JsonObject): Promise<ValidationMessage[]> {
  const messages: ValidationMessage[] = [];
  const repos = Array.isArray(draft.repos) ? draft.repos : [];
  await Promise.all(
    repos.map(async (repo, index) => {
      if (!isRecord(repo) || typeof repo.rootPath !== "string" || containsEnvReference(repo.rootPath)) return;
      try {
        await access(repo.rootPath, fsConstants.R_OK);
      } catch {
        messages.push({ path: `/repos/${index}/rootPath`, message: "Repository root does not exist or is not readable.", severity: "error", code: "path_unreadable" });
      }
    }),
  );

  const graphDatabase = isRecord(draft.graphDatabase) ? draft.graphDatabase : undefined;
  if (typeof graphDatabase?.path === "string" && !containsEnvReference(graphDatabase.path)) {
    try {
      await access(dirname(resolve(graphDatabase.path)), fsConstants.W_OK);
    } catch {
      messages.push({ path: "/graphDatabase/path", message: "Graph database parent directory is not writable.", severity: "error", code: "path_unwritable" });
    }
  }

  await collectCommandWarnings(draft, "", messages);
  return messages;
}

async function collectCommandWarnings(
  value: JsonValue,
  pointer: string,
  messages: ValidationMessage[],
): Promise<void> {
  if (Array.isArray(value)) {
    await Promise.all(value.map((item, index) => collectCommandWarnings(item, `${pointer}/${index}`, messages)));
    return;
  }
  if (!isJsonObject(value)) return;
  await Promise.all(
    Object.entries(value).map(async ([key, child]) => {
      const childPointer = `${pointer}/${escapePointer(key)}`;
      if (typeof child === "string" && /^(command|binary)$/i.test(key) && child.trim() && !containsEnvReference(child) && !(await commandExists(child))) {
        messages.push({ path: childPointer, message: "Command is not currently discoverable on PATH or by absolute path.", severity: "warning", code: "command_not_found" });
      }
      await collectCommandWarnings(child, childPointer, messages);
    }),
  );
}

function collectUnknownTopLevelWarnings(draft: JsonObject): ValidationMessage[] {
  return Object.keys(draft)
    .filter((key) => !TOP_LEVEL_KNOWN_KEYS.has(key))
    .map((key) => ({
      path: `/${escapePointer(key)}`,
      message: "Unknown top-level key is preserved but ignored by this SDL-MCP version.",
      severity: "warning" as const,
      code: "unknown_key",
    }));
}

function collectMissingEnvWarnings(value: JsonValue, pointer: string): ValidationMessage[] {
  if (typeof value === "string") {
    return extractEnvReferences(value)
      .filter((name) => process.env[name] === undefined)
      .map((name) => ({ path: pointer || "/", message: `Environment variable "${name}" is not set.`, severity: "warning" as const, code: "missing_env" }));
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectMissingEnvWarnings(item, `${pointer}/${index}`));
  }
  if (isJsonObject(value)) {
    return Object.entries(value).flatMap(([key, child]) => collectMissingEnvWarnings(child, `${pointer}/${escapePointer(key)}`));
  }
  return [];
}

function diffJson(before: JsonValue | undefined, after: JsonValue | undefined, pointer: string): ConfigDiffEntry[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (isJsonObject(before) && isJsonObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap((key) => diffJson(before[key], after[key], `${pointer}/${escapePointer(key)}`));
  }
  const path = pointer || "/";
  return [{
    path,
    kind: before === undefined ? "added" : after === undefined ? "removed" : "changed",
    before,
    after,
    impact: getImpactForPointer(path),
    highRisk: isHighRiskPointer(path),
    section: getSectionForPointer(path).id,
  }];
}

function summarizeImpact(diff: ConfigDiffEntry[]): ConfigImpact[] {
  const order: ConfigImpact[] = ["appliesImmediately", "restartRequired", "reindexRequired", "reconnectClients"];
  const seen = new Set(diff.flatMap((entry) => entry.impact));
  return order.filter((impact) => seen.has(impact));
}

function redactDiff(diff: ConfigDiffEntry[]): ConfigDiffEntry[] {
  return diff.map((entry) => ({
    ...entry,
    before: entry.before === undefined ? undefined : redactSecrets(entry.before, entry.path),
    after: entry.after === undefined ? undefined : redactSecrets(entry.after, entry.path),
  }));
}

function redactSecrets(value: JsonValue, pointer: string): JsonValue {
  const key = pointer.split("/").pop();
  if (isSecretPointer(pointer, key) && value !== null && value !== undefined) return REDACTED_SECRET;
  if (Array.isArray(value)) return value.map((item, index) => redactSecrets(item, `${pointer}/${index}`));
  if (!isJsonObject(value)) return value;
  const redacted: JsonObject = {};
  for (const [childKey, child] of Object.entries(value)) {
    redacted[childKey] = redactSecrets(child, `${pointer}/${escapePointer(childKey)}`);
  }
  return redacted;
}

function restoreSecretPlaceholders(draft: JsonObject, current: JsonObject): JsonObject {
  return restoreSecretValue(draft, current) as JsonObject;
}

function restoreSecretValue(draft: JsonValue, current: JsonValue | undefined): JsonValue {
  if (isSecretPlaceholder(draft)) return current ?? null;
  if (Array.isArray(draft)) {
    const currentArray = Array.isArray(current) ? current : [];
    return draft.map((item, index) => restoreSecretValue(item, currentArray[index]));
  }
  if (!isJsonObject(draft)) return draft;
  const currentObject = isJsonObject(current) ? current : {};
  const merged: JsonObject = {};
  for (const [key, value] of Object.entries(draft)) {
    merged[key] = restoreSecretValue(value, currentObject[key]);
  }
  return merged;
}

async function listBackups(): Promise<BackupSummary[]> {
  const backupDir = backupDirectory(resolveCliConfigPath(undefined, "read"));
  try {
    const entries = await readdir(backupDir, { withFileTypes: true });
    const backups = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => backupSummary(join(backupDir, entry.name))));
    return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

async function readBackupById(id: string): Promise<BackupSummary | null> {
  return (await listBackups()).find((backup) => backup.id === id) ?? null;
}

async function writeBackup(configPath: string, rawText: string): Promise<BackupSummary> {
  const backupDir = backupDirectory(configPath);
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = join(backupDir, `${stamp}-${basename(configPath)}`);
  await atomicWriteFile(target, rawText, 0o600);
  return backupSummary(target);
}

async function backupSummary(path: string): Promise<BackupSummary> {
  const info = await stat(path);
  const text = await readFile(path, "utf8");
  return { id: basename(path, extname(path)), path, createdAt: info.birthtime.toISOString(), sizeBytes: info.size, hash: hashText(text) };
}

function backupDirectory(configPath: string): string {
  return join(dirname(configPath), BACKUP_DIR_NAME);
}

async function atomicWriteFile(path: string, content: string, mode = 0o600): Promise<void> {
  const directory = dirname(path);
  const tempPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  const handle = await open(tempPath, "w", mode);
  let renamed = false;
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    await rename(tempPath, path);
    renamed = true;
    await fsyncDirectory(directory);
  } finally {
    if (!renamed) {
      await handle.close().catch(() => undefined);
      await unlink(tempPath).catch(() => undefined);
    }
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is unavailable on some platforms/filesystems. The file
    // itself has already been fsynced; this is a best-effort durability step.
  }
}

async function listProfiles(): Promise<ProfileSummary[]> {
  try {
    const entries = await readdir(PROFILE_DIR, { withFileTypes: true });
    const profiles = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => readProfile(basename(entry.name, ".json"))));
    return profiles.filter((profile): profile is ConfigProfile => profile !== null).map(profileToSummary).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

async function readProfile(id: string): Promise<ConfigProfile | null> {
  try {
    return normalizeProfile(await readJsonFile(profilePath(id)));
  } catch {
    return null;
  }
}

async function writeProfile(profile: ConfigProfile): Promise<void> {
  await mkdir(PROFILE_DIR, { recursive: true, mode: 0o700 });
  await atomicWriteFile(
    profilePath(profile.id),
    `${JSON.stringify(redactProfile(profile), null, 2)}\n`,
    0o600,
  );
}

function profilePath(id: string): string {
  return resolve(PROFILE_DIR, `${id.replace(/[^a-zA-Z0-9_.-]/g, "-")}.json`);
}

function normalizeProfile(value: unknown): ConfigProfile {
  const obj = readBodyObject(value, "profile");
  const now = new Date().toISOString();
  const id = typeof obj.id === "string" && obj.id.trim() ? obj.id.trim().replace(/[^a-zA-Z0-9_.-]/g, "-") : randomUUID();
  const patch = sanitizeProfilePatch((Array.isArray(obj.patch) ? obj.patch : []).map(normalizePatchOperation));
  return {
    schemaVersion: 1,
    id,
    name: typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : id,
    description: typeof obj.description === "string" ? obj.description.trim() : undefined,
    createdAt: typeof obj.createdAt === "string" ? obj.createdAt : now,
    updatedAt: now,
    sdlMcpVersion: typeof obj.sdlMcpVersion === "string" ? obj.sdlMcpVersion : undefined,
    includesSecrets: false,
    patch,
  };
}

function normalizePatchOperation(value: unknown): PatchOperation {
  const obj = readBodyObject(value, "patch entry");
  const op = readString(obj.op, "op");
  const path = readString(obj.path, "path");
  if (!path.startsWith("/")) throw new Error("Patch path must be a JSON Pointer.");
  if (op === "delete") return { op, path };
  if (op === "set") return { op, path, value: toJsonValue(obj.value) };
  throw new Error(`Unsupported patch operation: ${op}`);
}

function sanitizeProfilePatch(patch: PatchOperation[]): PatchOperation[] {
  return patch.filter((op) => !patchOperationTouchesSecret(op));
}

function patchOperationTouchesSecret(op: PatchOperation): boolean {
  if (isSecretPointer(op.path)) return true;
  return op.op === "set" && valueContainsSecret(op.value, op.path);
}

function valueContainsSecret(value: JsonValue, pointer: string): boolean {
  const key = pointer.split("/").pop();
  if (isSecretPointer(pointer, key)) return true;
  if (Array.isArray(value)) {
    return value.some((item, index) => valueContainsSecret(item, `${pointer}/${index}`));
  }
  if (!isJsonObject(value)) return false;
  return Object.entries(value).some(([childKey, child]) => valueContainsSecret(child, `${pointer}/${escapePointer(childKey)}`));
}

function profileToSummary(profile: ConfigProfile): ProfileSummary {
  return { id: profile.id, name: profile.name, description: profile.description, path: profilePath(profile.id), includesSecrets: profile.includesSecrets, patchCount: profile.patch.length };
}

function redactProfile(profile: ConfigProfile): ConfigProfile {
  return { ...profile, patch: sanitizeProfilePatch(profile.patch), includesSecrets: false };
}

function filterProfilePatch(patch: PatchOperation[], selectedPaths: string[] | undefined): PatchOperation[] {
  if (!selectedPaths || selectedPaths.length === 0) return patch;
  const selected = new Set(selectedPaths);
  return patch.filter((op) => selected.has(op.path));
}

function applyPatchOperations(raw: JsonObject, patch: PatchOperation[]): JsonObject {
  let next = cloneJson(raw) as JsonObject;
  for (const op of patch) next = applyPatchOperation(next, op);
  return next;
}

function applyPatchOperation(raw: JsonObject, op: PatchOperation): JsonObject {
  const next = cloneJson(raw) as JsonObject;
  const parts = decodePointer(op.path);
  if (parts.length === 0) {
    if (op.op === "delete") return {};
    if (!isJsonObject(op.value)) throw new Error("Root patch value must be an object.");
    return op.value;
  }
  const parent = ensurePointerParent(next, parts);
  const key = parts[parts.length - 1];
  if (Array.isArray(parent)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0) throw new Error(`Invalid array index in patch path: ${op.path}`);
    if (op.op === "delete") parent.splice(index, 1);
    else parent[index] = cloneJson(op.value);
  } else if (op.op === "delete") {
    delete parent[key];
  } else {
    parent[key] = cloneJson(op.value);
  }
  return next;
}

function ensurePointerParent(root: JsonObject, parts: string[]): JsonObject | JsonValue[] {
  let current: JsonObject | JsonValue[] = root;
  for (let index = 0; index < parts.length - 1; index++) {
    const part = parts[index];
    const shouldBeArray = /^\d+$/.test(parts[index + 1]);
    if (Array.isArray(current)) {
      const arrayIndex = Number(part);
      if (!isJsonObject(current[arrayIndex]) && !Array.isArray(current[arrayIndex])) current[arrayIndex] = shouldBeArray ? [] : {};
      current = current[arrayIndex] as JsonObject | JsonValue[];
    } else {
      if (!isJsonObject(current[part]) && !Array.isArray(current[part])) current[part] = shouldBeArray ? [] : {};
      current = current[part] as JsonObject | JsonValue[];
    }
  }
  return current;
}

function orderConfigKeys(value: JsonObject): JsonObject {
  const ordered: JsonObject = {};
  for (const key of TOP_LEVEL_KNOWN_KEYS) {
    if (key in value) ordered[key] = value[key];
  }
  for (const key of Object.keys(value)) {
    if (!(key in ordered)) ordered[key] = value[key];
  }
  return ordered;
}

async function readJsonFile(path: string): Promise<JsonObject> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error(`Expected JSON object in ${path}`);
  return toJsonObject(parsed);
}

async function commandExists(command: string): Promise<boolean> {
  if (command.includes("/") || command.includes("\\") || isAbsolute(command)) {
    return (await canAccess(command, fsConstants.X_OK)) || (await canAccess(command, fsConstants.R_OK));
  }
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const ext of extensions) {
      if (await canAccess(join(dir, `${command}${ext}`), fsConstants.X_OK)) return true;
    }
  }
  return false;
}

async function canAccess(path: string, mode: number): Promise<boolean> {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

function readDraftFromBody(body: unknown): JsonObject {
  if (isRecord(body) && isRecord(body.draft)) return toJsonObject(body.draft);
  return readBodyObject(body, "draft");
}

function readBodyObject(value: unknown, name = "body"): JsonObject {
  if (!isRecord(value)) throw new Error(`Expected ${name} to be an object.`);
  return toJsonObject(value);
}

function readString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Expected ${name} to be a non-empty string.`);
  return value;
}

function readOptionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function containsEnvReference(value: string): boolean {
  return /\$\{([^}]+)\}/.test(value);
}

function extractEnvReferences(value: string): string[] {
  return [...value.matchAll(/\$\{([^}]+)\}/g)].map((match) => {
    const captured = match[1];
    const sepIndex = captured.indexOf(":-");
    return sepIndex >= 0 ? captured.slice(0, sepIndex) : captured;
  });
}

function escapePointer(value: string | number): string {
  return String(value).replace(/~/g, "~0").replace(/\//g, "~1");
}

function decodePointer(pointer: string): string[] {
  if (pointer === "" || pointer === "/") return [];
  return pointer.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function isSecretPlaceholder(value: JsonValue): boolean {
  return isJsonObject(value) && value.__sdlSecret === true && value.state === "set";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value);
}

function toJsonObject(value: unknown): JsonObject {
  if (!isRecord(value)) throw new Error("Expected JSON object.");
  const result: JsonObject = {};
  for (const [key, child] of Object.entries(value)) result[key] = toJsonValue(child);
  return result;
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (isRecord(value)) return toJsonObject(value);
  return String(value);
}

function cloneJson(value: JsonValue): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
