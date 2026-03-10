import { existsSync } from "fs";
import { dirname, resolve } from "path";
import { pathToFileURL } from "url";
import { DatabaseSync } from "node:sqlite";

import { resolveCliConfigPath } from "../src/config/configPath.js";
import { loadConfig } from "../src/config/loadConfig.js";
import {
  initLadybugDb,
  closeLadybugDb,
  getLadybugConn,
} from "../src/db/ladybug.js";
import * as ladybugDb from "../src/db/ladybug-queries.js";
import { normalizePath } from "../src/util/paths.js";

export interface SqliteToLadybugMigrationOptions {
  configPath?: string;
  sqlitePath?: string;
  ladybugPath?: string;
  quiet?: boolean;
}

interface CliArgs {
  config?: string;
  sqlite?: string;
  ladybug?: string;
  quiet: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { quiet: false };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--config") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args.config = next;
        i++;
      }
      continue;
    }

    if (arg === "--sqlite") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args.sqlite = next;
        i++;
      }
      continue;
    }

    if (arg === "--ladybug") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args.ladybug = next;
        i++;
      }
      continue;
    }

    if (arg === "--quiet") {
      args.quiet = true;
      continue;
    }
  }

  return args;
}

function log(message: string, options?: { quiet?: boolean }): void {
  if (options?.quiet) return;
  // eslint-disable-next-line no-console
  console.log(message);
}

function getSqliteTables(db: DatabaseSync): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function sqliteCount(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as
    | { count: number }
    | undefined;
  return Number(row?.count ?? 0);
}

async function ladybugCount(
  conn: import("kuzu").Connection,
  statement: string,
  params: Record<string, unknown> = {},
): Promise<number> {
  const prepared = await (conn as any).prepare(statement);
  const result = await (conn as any).execute(prepared, params);
  const queryResult = Array.isArray(result)
    ? result[result.length - 1]
    : result;
  try {
    const rows = (await queryResult.getAll()) as Array<Record<string, unknown>>;
    const count = rows[0]?.count ?? rows[0]?.c ?? 0;
    return typeof count === "bigint" ? Number(count) : Number(count);
  } finally {
    queryResult.close();
  }
}

export async function migrateSqliteToLadybug(
  options: SqliteToLadybugMigrationOptions = {},
): Promise<void> {
  const resolvedConfigPath = options.configPath
    ? resolveCliConfigPath(options.configPath, "read")
    : undefined;

  const config = resolvedConfigPath ? loadConfig(resolvedConfigPath) : null;

  const sqlitePath = resolve(
    options.sqlitePath ?? config?.dbPath ?? "./data/sdlmcp.sqlite",
  );

  const ladybugPath = resolve(
    options.ladybugPath ??
      config?.graphDatabase?.path ??
      (resolvedConfigPath
        ? resolve(dirname(resolvedConfigPath), "sdl-mcp-graph")
        : "./data/sdlmcp.lbug"),
  );

  if (!existsSync(sqlitePath)) {
    throw new Error(`SQLite DB not found: ${normalizePath(sqlitePath)}`);
  }

  await closeLadybugDb();
  await initLadybugDb(ladybugPath);
  const conn = await getLadybugConn();

  const sqlite = new DatabaseSync(sqlitePath);
  const tables = getSqliteTables(sqlite);

  const quiet = options.quiet ?? false;

  try {
    log(`SQLite: ${normalizePath(sqlitePath)}`, { quiet });
    log(`Ladybug: ${normalizePath(ladybugPath)}`, { quiet });

    if (tables.has("repos")) {
      log(`\nMigrating repos (${sqliteCount(sqlite, "repos")})...`, { quiet });
      const stmt = sqlite.prepare("SELECT * FROM repos");
      let migrated = 0;
      for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) {
        await ladybugDb.upsertRepo(conn, {
          repoId: String(row.repo_id),
          rootPath: String(row.root_path),
          configJson: String(row.config_json),
          createdAt: String(row.created_at),
        });
        migrated++;
        if (migrated % 100 === 0) log(`  repos: ${migrated}`, { quiet });
      }
      log(`  repos: ${migrated} (done)`, { quiet });
    }

    if (tables.has("files")) {
      log(`\nMigrating files (${sqliteCount(sqlite, "files")})...`, { quiet });
      const stmt = sqlite.prepare("SELECT * FROM files");
      let migrated = 0;
      for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) {
        await ladybugDb.upsertFile(conn, {
          fileId: String(row.file_id),
          repoId: String(row.repo_id),
          relPath: String(row.rel_path),
          contentHash: String(row.content_hash),
          language: String(row.language),
          byteSize: Number(row.byte_size),
          lastIndexedAt: row.last_indexed_at
            ? String(row.last_indexed_at)
            : null,
        });
        migrated++;
        if (migrated % 500 === 0) log(`  files: ${migrated}`, { quiet });
      }
      log(`  files: ${migrated} (done)`, { quiet });
    }

    if (tables.has("symbols")) {
      log(`\nMigrating symbols (${sqliteCount(sqlite, "symbols")})...`, {
        quiet,
      });
      const stmt = sqlite.prepare("SELECT * FROM symbols");
      let migrated = 0;
      for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) {
        await ladybugDb.upsertSymbol(conn, {
          symbolId: String(row.symbol_id),
          repoId: String(row.repo_id),
          fileId: String(row.file_id),
          kind: String(row.kind),
          name: String(row.name),
          exported: Number(row.exported) === 1,
          visibility: row.visibility ? String(row.visibility) : null,
          language: row.language ? String(row.language) : "unknown",
          rangeStartLine: Number(row.range_start_line),
          rangeStartCol: Number(row.range_start_col),
          rangeEndLine: Number(row.range_end_line),
          rangeEndCol: Number(row.range_end_col),
          astFingerprint: String(row.ast_fingerprint),
          signatureJson: row.signature_json ? String(row.signature_json) : null,
          summary: row.summary ? String(row.summary) : null,
          invariantsJson: row.invariants_json
            ? String(row.invariants_json)
            : null,
          sideEffectsJson: row.side_effects_json
            ? String(row.side_effects_json)
            : null,
          updatedAt: String(row.updated_at),
        });
        migrated++;
        if (migrated % 1000 === 0) log(`  symbols: ${migrated}`, { quiet });
      }
      log(`  symbols: ${migrated} (done)`, { quiet });
    }

    if (tables.has("edges")) {
      log(`\nMigrating edges (${sqliteCount(sqlite, "edges")})...`, { quiet });
      const stmt = sqlite.prepare("SELECT * FROM edges");
      const batch: ladybugDb.EdgeRow[] = [];
      const BATCH_SIZE = 1000;
      let migrated = 0;

      const flush = async (): Promise<void> => {
        if (batch.length === 0) return;
        await ladybugDb.insertEdges(conn, batch.splice(0, batch.length));
      };

      for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) {
        batch.push({
          repoId: String(row.repo_id),
          fromSymbolId: String(row.from_symbol_id),
          toSymbolId: String(row.to_symbol_id),
          edgeType: String(row.type),
          weight: Number(row.weight),
          confidence:
            row.confidence === undefined || row.confidence === null
              ? 1
              : Number(row.confidence),
          resolution: row.resolution_strategy
            ? String(row.resolution_strategy)
            : "exact",
          provenance: row.provenance ? String(row.provenance) : null,
          createdAt: String(row.created_at),
        });
        migrated++;
        if (batch.length >= BATCH_SIZE) {
          await flush();
          log(`  edges: ${migrated}`, { quiet });
        }
      }

      await flush();
      log(`  edges: ${migrated} (done)`, { quiet });
    }

    if (tables.has("versions")) {
      log(`\nMigrating versions (${sqliteCount(sqlite, "versions")})...`, {
        quiet,
      });
      const stmt = sqlite.prepare("SELECT * FROM versions");
      let migrated = 0;
      for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) {
        await ladybugDb.createVersion(conn, {
          versionId: String(row.version_id),
          repoId: String(row.repo_id),
          createdAt: String(row.created_at),
          reason: row.reason ? String(row.reason) : null,
          prevVersionHash: row.prev_version_hash
            ? String(row.prev_version_hash)
            : null,
          versionHash: row.version_hash ? String(row.version_hash) : null,
        });
        migrated++;
        if (migrated % 200 === 0) log(`  versions: ${migrated}`, { quiet });
      }
      log(`  versions: ${migrated} (done)`, { quiet });
    }

    if (tables.has("symbol_versions")) {
      log(
        `\nMigrating symbol_versions (${sqliteCount(sqlite, "symbol_versions")})...`,
        { quiet },
      );
      const stmt = sqlite.prepare("SELECT * FROM symbol_versions");
      let migrated = 0;
      for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) {
        await ladybugDb.snapshotSymbolVersion(conn, {
          versionId: String(row.version_id),
          symbolId: String(row.symbol_id),
          astFingerprint: String(row.ast_fingerprint),
          signatureJson: row.signature_json ? String(row.signature_json) : null,
          summary: row.summary ? String(row.summary) : null,
          invariantsJson: row.invariants_json
            ? String(row.invariants_json)
            : null,
          sideEffectsJson: row.side_effects_json
            ? String(row.side_effects_json)
            : null,
        });
        migrated++;
        if (migrated % 1000 === 0)
          log(`  symbol_versions: ${migrated}`, { quiet });
      }
      log(`  symbol_versions: ${migrated} (done)`, { quiet });
    }

    if (tables.has("metrics")) {
      log(`\nMigrating metrics (${sqliteCount(sqlite, "metrics")})...`, {
        quiet,
      });
      const stmt = sqlite.prepare("SELECT * FROM metrics");
      let migrated = 0;
      for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) {
        await ladybugDb.upsertMetrics(conn, {
          symbolId: String(row.symbol_id),
          fanIn: Number(row.fan_in ?? 0),
          fanOut: Number(row.fan_out ?? 0),
          churn30d: Number(row.churn_30d ?? 0),
          testRefsJson: row.test_refs_json ? String(row.test_refs_json) : null,
          canonicalTestJson: row.canonical_test_json
            ? String(row.canonical_test_json)
            : null,
          updatedAt: String(row.updated_at),
        });
        migrated++;
        if (migrated % 1000 === 0) log(`  metrics: ${migrated}`, { quiet });
      }
      log(`  metrics: ${migrated} (done)`, { quiet });
    }

    if (tables.has("slice_handles")) {
      log(
        `\nMigrating slice_handles (${sqliteCount(sqlite, "slice_handles")})...`,
        { quiet },
      );
      const stmt = sqlite.prepare("SELECT * FROM slice_handles");
      let migrated = 0;
      for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) {
        await ladybugDb.upsertSliceHandle(conn, {
          handle: String(row.handle),
          repoId: String(row.repo_id),
          createdAt: String(row.created_at),
          expiresAt: String(row.expires_at),
          minVersion: row.min_version ? String(row.min_version) : null,
          maxVersion: row.max_version ? String(row.max_version) : null,
          sliceHash: String(row.slice_hash),
          spilloverRef: row.spillover_ref ? String(row.spillover_ref) : null,
        });
        migrated++;
        if (migrated % 200 === 0)
          log(`  slice_handles: ${migrated}`, { quiet });
      }
      log(`  slice_handles: ${migrated} (done)`, { quiet });
    }

    if (tables.has("card_hashes")) {
      log(
        `\nMigrating card_hashes (${sqliteCount(sqlite, "card_hashes")})...`,
        { quiet },
      );
      const stmt = sqlite.prepare("SELECT * FROM card_hashes");
      let migrated = 0;
      for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) {
        await ladybugDb.upsertCardHash(conn, {
          cardHash: String(row.card_hash),
          cardBlob: String(row.card_blob),
          createdAt: String(row.created_at),
        });
        migrated++;
        if (migrated % 200 === 0) log(`  card_hashes: ${migrated}`, { quiet });
      }
      log(`  card_hashes: ${migrated} (done)`, { quiet });
    }

    if (tables.has("tool_policy_hashes")) {
      log(
        `\nMigrating tool_policy_hashes (${sqliteCount(sqlite, "tool_policy_hashes")})...`,
        { quiet },
      );
      const stmt = sqlite.prepare("SELECT * FROM tool_policy_hashes");
      let migrated = 0;
      for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) {
        await ladybugDb.upsertToolPolicyHash(conn, {
          policyHash: String(row.policy_hash),
          policyBlob: String(row.policy_blob),
          createdAt: String(row.created_at),
        });
        migrated++;
        if (migrated % 200 === 0)
          log(`  tool_policy_hashes: ${migrated}`, { quiet });
      }
      log(`  tool_policy_hashes: ${migrated} (done)`, { quiet });
    }

    if (tables.has("tsconfig_hashes")) {
      log(
        `\nMigrating tsconfig_hashes (${sqliteCount(sqlite, "tsconfig_hashes")})...`,
        { quiet },
      );
      const stmt = sqlite.prepare("SELECT * FROM tsconfig_hashes");
      let migrated = 0;
      for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) {
        await ladybugDb.upsertTsconfigHash(conn, {
          tsconfigHash: String(row.tsconfig_hash),
          tsconfigBlob: String(row.tsconfig_blob),
          createdAt: String(row.created_at),
        });
        migrated++;
        if (migrated % 200 === 0)
          log(`  tsconfig_hashes: ${migrated}`, { quiet });
      }
      log(`  tsconfig_hashes: ${migrated} (done)`, { quiet });
    }

    if (tables.has("audit")) {
      log(`\nMigrating audit (${sqliteCount(sqlite, "audit")})...`, { quiet });
      const stmt = sqlite.prepare("SELECT * FROM audit");
      let migrated = 0;
      for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) {
        await ladybugDb.insertAuditEvent(conn, {
          eventId: String(row.event_id),
          timestamp: String(row.timestamp),
          tool: String(row.tool),
          decision: String(row.decision),
          repoId: row.repo_id ? String(row.repo_id) : null,
          symbolId: row.symbol_id ? String(row.symbol_id) : null,
          detailsJson: String(row.details_json),
        });
        migrated++;
        if (migrated % 500 === 0) log(`  audit: ${migrated}`, { quiet });
      }
      log(`  audit: ${migrated} (done)`, { quiet });
    }

    if (tables.has("agent_feedback")) {
      log(
        `\nMigrating agent_feedback (${sqliteCount(sqlite, "agent_feedback")})...`,
        { quiet },
      );
      const stmt = sqlite.prepare("SELECT * FROM agent_feedback");
      let migrated = 0;
      for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) {
        await ladybugDb.upsertAgentFeedback(conn, {
          feedbackId: String(row.feedback_id),
          repoId: String(row.repo_id),
          versionId: String(row.version_id),
          sliceHandle: String(row.slice_handle),
          usefulSymbolsJson: String(row.useful_symbols_json ?? "[]"),
          missingSymbolsJson: String(row.missing_symbols_json ?? "[]"),
          taskTagsJson: row.task_tags_json ? String(row.task_tags_json) : null,
          taskType: row.task_type ? String(row.task_type) : null,
          taskText: row.task_text ? String(row.task_text) : null,
          createdAt: String(row.created_at),
        });
        migrated++;
        if (migrated % 200 === 0)
          log(`  agent_feedback: ${migrated}`, { quiet });
      }
      log(`  agent_feedback: ${migrated} (done)`, { quiet });
    }

    if (tables.has("symbol_embeddings")) {
      log(
        `\nMigrating symbol_embeddings (${sqliteCount(sqlite, "symbol_embeddings")})...`,
        { quiet },
      );
      const stmt = sqlite.prepare("SELECT * FROM symbol_embeddings");
      let migrated = 0;
      for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) {
        const vector =
          row.embedding_vector && row.embedding_vector instanceof Uint8Array
            ? Buffer.from(row.embedding_vector).toString("base64")
            : row.embedding_vector
              ? String(row.embedding_vector)
              : "";
        await ladybugDb.upsertSymbolEmbedding(conn, {
          symbolId: String(row.symbol_id),
          model: String(row.model),
          embeddingVector: vector,
          version: String(row.version),
          cardHash: String(row.card_hash),
          createdAt: String(row.created_at),
          updatedAt: String(row.updated_at),
        });
        migrated++;
        if (migrated % 200 === 0)
          log(`  symbol_embeddings: ${migrated}`, { quiet });
      }
      log(`  symbol_embeddings: ${migrated} (done)`, { quiet });
    }

    if (tables.has("symbol_summary_cache")) {
      log(
        `\nMigrating symbol_summary_cache (${sqliteCount(sqlite, "symbol_summary_cache")})...`,
        { quiet },
      );
      const stmt = sqlite.prepare("SELECT * FROM symbol_summary_cache");
      let migrated = 0;
      for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) {
        await ladybugDb.upsertSummaryCache(conn, {
          symbolId: String(row.symbol_id),
          summary: String(row.summary),
          provider: String(row.provider),
          model: String(row.model),
          cardHash: String(row.card_hash),
          costUsd: Number(row.cost_usd ?? 0),
          createdAt: String(row.created_at),
          updatedAt: String(row.updated_at),
        });
        migrated++;
        if (migrated % 200 === 0)
          log(`  symbol_summary_cache: ${migrated}`, { quiet });
      }
      log(`  symbol_summary_cache: ${migrated} (done)`, { quiet });
    }

    if (tables.has("sync_artifacts")) {
      log(
        `\nMigrating sync_artifacts (${sqliteCount(sqlite, "sync_artifacts")})...`,
        { quiet },
      );
      const stmt = sqlite.prepare("SELECT * FROM sync_artifacts");
      let migrated = 0;
      for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) {
        await ladybugDb.upsertSyncArtifact(conn, {
          artifactId: String(row.artifact_id),
          repoId: String(row.repo_id),
          versionId: String(row.version_id),
          commitSha: row.commit_sha ? String(row.commit_sha) : null,
          branch: row.branch ? String(row.branch) : null,
          artifactHash: String(row.artifact_hash),
          compressedData: String(row.compressed_data),
          createdAt: String(row.created_at),
          sizeBytes: Number(row.size_bytes),
        });
        migrated++;
        if (migrated % 200 === 0)
          log(`  sync_artifacts: ${migrated}`, { quiet });
      }
      log(`  sync_artifacts: ${migrated} (done)`, { quiet });
    }

    if (tables.has("symbol_references")) {
      log(
        `\nMigrating symbol_references (${sqliteCount(sqlite, "symbol_references")})...`,
        { quiet },
      );
      const stmt = sqlite.prepare("SELECT * FROM symbol_references");
      let migrated = 0;
      for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) {
        await ladybugDb.insertSymbolReference(conn, {
          refId: String(row.ref_id),
          repoId: String(row.repo_id),
          symbolName: String(row.symbol_name),
          fileId: String(row.file_id),
          lineNumber: row.line_number === null ? null : Number(row.line_number),
          createdAt: String(row.created_at),
        });
        migrated++;
        if (migrated % 500 === 0)
          log(`  symbol_references: ${migrated}`, { quiet });
      }
      log(`  symbol_references: ${migrated} (done)`, { quiet });
    }

    if (
      tables.has("repos") &&
      tables.has("files") &&
      tables.has("symbols") &&
      tables.has("edges")
    ) {
      log("\nVerifying core counts...", { quiet });
      const sqliteCounts = {
        repos: sqliteCount(sqlite, "repos"),
        files: sqliteCount(sqlite, "files"),
        symbols: sqliteCount(sqlite, "symbols"),
        edges: sqliteCount(sqlite, "edges"),
        versions: tables.has("versions") ? sqliteCount(sqlite, "versions") : 0,
        metrics: tables.has("metrics") ? sqliteCount(sqlite, "metrics") : 0,
      };

      const ladybugCounts = {
        repos: await ladybugCount(
          conn,
          "MATCH (r:Repo) RETURN COUNT(r) AS count",
        ),
        files: await ladybugCount(
          conn,
          "MATCH (f:File) RETURN COUNT(f) AS count",
        ),
        symbols: await ladybugCount(
          conn,
          "MATCH (s:Symbol) RETURN COUNT(s) AS count",
        ),
        edges: await ladybugCount(
          conn,
          "MATCH ()-[d:DEPENDS_ON]->() RETURN COUNT(d) AS count",
        ),
        versions: await ladybugCount(
          conn,
          "MATCH (v:Version) RETURN COUNT(v) AS count",
        ),
        metrics: await ladybugCount(
          conn,
          "MATCH (m:Metrics) RETURN COUNT(m) AS count",
        ),
      };

      for (const [key, sqliteValue] of Object.entries(sqliteCounts)) {
        const ladybugValue =
          (ladybugCounts as Record<string, number>)[key] ?? 0;
        if (sqliteValue !== ladybugValue) {
          throw new Error(
            `Count mismatch for ${key}: sqlite=${sqliteValue} ladybug=${ladybugValue}`,
          );
        }
      }

      log("  Verification: PASS", { quiet });
    }
  } finally {
    sqlite.close();
    await closeLadybugDb();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  await migrateSqliteToLadybug({
    configPath: args.config,
    sqlitePath: args.sqlite,
    ladybugPath: args.ladybug,
    quiet: args.quiet,
  });
}

const isEntrypoint =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isEntrypoint) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
