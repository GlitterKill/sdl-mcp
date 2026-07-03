import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { handleFileGateway } from "../../dist/mcp/tools/file-gateway.js";
import { handleSearchEdit } from "../../dist/mcp/tools/search-edit/index.js";
import {
  SearchEditRequestSchema,
  type ResponseArtifactReference,
  type SearchEditPreviewResponse,
} from "../../dist/mcp/tools.js";
import { normalizePath } from "../../dist/util/paths.js";

const REPO_ID = "search-edit-response-mode-test";

let testRoot: string;
let repoRoot: string;

function isResponseArtifact(
  value: unknown,
): value is ResponseArtifactReference {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "responseArtifact" &&
    "action" in value &&
    value.action === "response.get"
  );
}

async function ensureRepoRegistered(root: string): Promise<void> {
  const conn = await getLadybugConn();
  const existing = await ladybugDb.getRepo(conn, REPO_ID);
  if (existing && normalizePath(existing.rootPath) === normalizePath(root)) {
    return;
  }
  await ladybugDb.upsertRepo(conn, {
    repoId: REPO_ID,
    rootPath: root,
    configJson: "{}",
    createdAt: new Date().toISOString(),
  });
}

async function writeLargeMatchSet(): Promise<void> {
  const dir = join(repoRoot, "large");
  await mkdir(dir, { recursive: true });
  const pad = "x".repeat(4_000);
  await Promise.all(
    Array.from({ length: 500 }, (_, i) =>
      writeFile(
        join(dir, `match-${i}.txt`),
        `${pad} oldName ${pad}\n`,
        "utf-8",
      ),
    ),
  );
}

describe("search.edit responseMode defaults", { concurrency: false }, () => {
  before(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "sdl-search-edit-response-mode-"));
    await initLadybugDb(join(testRoot, "graph"));
    repoRoot = join(testRoot, "repo");
    await mkdir(repoRoot, { recursive: true });
    await ensureRepoRegistered(repoRoot);
    await writeFile(join(repoRoot, "small.txt"), "hello oldName\n", "utf-8");
    await writeLargeMatchSet();
  });

  after(async () => {
    await closeLadybugDb();
    await rm(testRoot, { recursive: true, force: true });
  });

  it("defaults large previews to auto response artifacts", async () => {
    const response = await handleSearchEdit({
      mode: "preview",
      repoId: REPO_ID,
      targeting: "text",
      query: { literal: "oldName", replacement: "newName", global: true },
      editMode: "replacePattern",
      filters: { include: ["large/*.txt"] },
      maxFiles: 500,
    });

    assert.equal(isResponseArtifact(response), true);
  });

  it("keeps small default previews inline", async () => {
    const response = (await handleSearchEdit({
      mode: "preview",
      repoId: REPO_ID,
      targeting: "text",
      query: { literal: "oldName", replacement: "newName", global: true },
      editMode: "replacePattern",
      filters: { include: ["small.txt"] },
    })) as SearchEditPreviewResponse;

    assert.equal(response.mode, "preview");
    assert.equal(response.filesMatched, 1);
    assert.equal(response.matchesFound, 1);
  });

  it("respects explicit inline mode for large previews", async () => {
    const response = (await handleSearchEdit({
      mode: "preview",
      repoId: REPO_ID,
      targeting: "text",
      query: { literal: "oldName", replacement: "newName", global: true },
      editMode: "replacePattern",
      filters: { include: ["large/*.txt"] },
      maxFiles: 500,
      responseMode: "inline",
    })) as SearchEditPreviewResponse;

    assert.equal(response.mode, "preview");
    assert.equal(response.filesMatched, 500);
  });

  it("defaults to auto when dispatched with schema-parsed args (server/gateway path)", async () => {
    const parsed = SearchEditRequestSchema.parse({
      mode: "preview",
      repoId: REPO_ID,
      targeting: "text",
      query: { literal: "oldName", replacement: "newName", global: true },
      editMode: "replacePattern",
      filters: { include: ["large/*.txt"] },
      maxFiles: 500,
    });
    const response = await handleSearchEdit(parsed);

    assert.equal(isResponseArtifact(response), true);
  });

  it("schema parse does not inject a responseMode default for previews", () => {
    const parsed = SearchEditRequestSchema.parse({
      mode: "preview",
      repoId: REPO_ID,
      targeting: "text",
      query: { literal: "oldName", replacement: "newName", global: true },
      editMode: "replacePattern",
    });
    assert.equal(
      "responseMode" in parsed ? parsed.responseMode : undefined,
      undefined,
    );
  });

  it("explicit inline survives schema parse for large previews", async () => {
    const parsed = SearchEditRequestSchema.parse({
      mode: "preview",
      repoId: REPO_ID,
      targeting: "text",
      query: { literal: "oldName", replacement: "newName", global: true },
      editMode: "replacePattern",
      filters: { include: ["large/*.txt"] },
      maxFiles: 500,
      responseMode: "inline",
    });
    const response = (await handleSearchEdit(
      parsed,
    )) as SearchEditPreviewResponse;

    assert.equal(response.mode, "preview");
    assert.equal(response.filesMatched, 500);
  });

  it("uses the same default through sdl.file searchEditPreview", async () => {
    const response = await handleFileGateway({
      op: "searchEditPreview",
      repoId: REPO_ID,
      targeting: "text",
      query: { literal: "oldName", replacement: "newName", global: true },
      editMode: "replacePattern",
      filters: { include: ["large/*.txt"] },
      maxFiles: 500,
    });

    assert.equal(isResponseArtifact(response), true);
  });
});