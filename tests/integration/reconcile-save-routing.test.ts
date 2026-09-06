import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { initLadybugDb, closeLadybugDb, getLadybugConn } from "../../dist/db/ladybug.js";
import { upsertRepo } from "../../dist/db/ladybug-queries.js";
import { RepoConfigSchema, CodeModeConfigSchema } from "../../dist/config/types.js";
import { createActionHandlerMap } from "../../dist/gateway/router.js";
import { buildFlatToolDescriptors } from "../../dist/mcp/tools/tool-descriptors.js";
import { handleFileWrite } from "../../dist/mcp/tools/file-write.js";
import { handleFileGateway } from "../../dist/mcp/tools/file-gateway.js";
import { registerCodeModeTools } from "../../dist/code-mode/index.js";
import type { LiveIndexCoordinator } from "../../dist/live-index/types.js";

it("all file-write registrations use the selected save coordinator", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "sdl-save-routing-"));
  const repoRoot = join(root, "repo");
  const repoId = "save-routing";
  const previousConfig = process.env.SDL_CONFIG;
  let admissions = 0;
  try {
    await mkdir(repoRoot);
    process.env.SDL_CONFIG = join(root, "config.json");
    await writeFile(process.env.SDL_CONFIG, JSON.stringify({
      repos: [], policy: {}, indexing: { engine: "typescript", enableFileWatching: false },
      scip: { enabled: false },
      semanticEnrichment: { providers: { scip: { enabled: false }, lsp: { enabled: false } } },
    }));
    await initLadybugDb(join(root, "graph.lbug"));
    await upsertRepo(await getLadybugConn(), {
      repoId, rootPath: repoRoot,
      configJson: JSON.stringify(RepoConfigSchema.parse({ repoId, rootPath: repoRoot, languages: ["ts"] })),
      createdAt: "fixture",
    });
    const liveIndex = {
      async runSavedFileMutation() {
        admissions++;
        throw new Error("selected coordinator refused mutation");
      },
    } as unknown as LiveIndexCoordinator;
    const services = { liveIndex, actionAvailability: { memoryTools: false } };
    const registered = new Map<string, (args: unknown) => Promise<unknown>>();
    registerCodeModeTools({
      registerTool(name: string, _description: string, _schema: unknown, handler: (args: unknown) => Promise<unknown>) {
        registered.set(name, handler);
      },
    } as never, services, CodeModeConfigSchema.parse({}));
    const request = { repoId, filePath: "source.test.ts", content: "export const after = 2;\n", createBackup: false };
    const before = "export const before = 1;\n";
    await writeFile(join(repoRoot, request.filePath), before);
    const action = createActionHandlerMap(liveIndex)["file.write"];
    const flat = buildFlatToolDescriptors(services).find((tool) => tool.name === "sdl.file.write")!;
    assert.ok(flat);
    const routes = [
      () => handleFileWrite(request, undefined, liveIndex),
      () => action(request),
      () => flat.handler(request),
      () => handleFileGateway({ op: "write", ...request }, undefined, liveIndex),
      () => registered.get("sdl.file")!({ op: "write", ...request }),
    ];
    for (const [index, route] of routes.entries()) {
      await assert.rejects(route, /selected coordinator refused mutation/);
      assert.equal(admissions, index + 1);
      assert.equal(await readFile(join(repoRoot, request.filePath), "utf8"), before);
    }
  } finally {
    await closeLadybugDb();
    if (previousConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = previousConfig;
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("sdl-save-routing-"));
    await rm(root, { recursive: true, force: true });
  }
});
