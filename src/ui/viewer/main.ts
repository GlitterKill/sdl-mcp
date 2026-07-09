import * as THREE from "three";
import type { Cluster } from "./api.js";
import { ViewerApi, type UniverseRepo } from "./api.js";
import { AmbientController } from "./ambient.js";
import { ViewerChrome } from "./chrome.js";
import { InspectorPanel } from "./inspector.js";
import { ActivityLens } from "./lenses/activity.js";
import { attachSearch } from "./lenses/search.js";
import { LodController } from "./lod.js";
import { PickingController } from "./picking.js";
import { ViewerScene } from "./scene.js";
import { setSettings, loadVisibleRepos, state, subscribe, setAmbient, setSelection } from "./state.js";
import { loadSkinZip, applySkinCssVars } from "./skins/loader.js";
import { UniverseRenderer } from "./universe.js";

const canvasHost = document.getElementById("viewerCanvas");
const chromeHost = document.getElementById("viewerChrome");
const inspectorHost = document.getElementById("viewerInspector");
const captionHost = document.getElementById("viewerCaption");
if (!canvasHost || !chromeHost || !inspectorHost || !captionHost) throw new Error("viewer shell missing required elements");

const api = new ViewerApi();
const scene = new ViewerScene(canvasHost);
const universeRenderer = new UniverseRenderer(scene);
const chrome = new ViewerChrome(chromeHost);
new InspectorPanel(inspectorHost);
new PickingController(api, scene, universeRenderer);
const lod = new LodController(api, scene, universeRenderer);
const ambient = new AmbientController(scene, universeRenderer, captionHost);
const activity = new ActivityLens(api, universeRenderer, (text) => ambient.setCaption(text));

function firstVisibleRepo(): string { return [...state.visibleRepos][0] ?? "sdl-mcp"; }
const resultsHost = document.getElementById("viewerResults") as HTMLElement;
attachSearch(chrome.searchInput, resultsHost, api, firstVisibleRepo, async (result) => {
  const repoId = firstVisibleRepo();
  const cluster = result.clusterId
    ? universeRenderer.getClusters().find((item) => item.repoId === repoId && item.clusterId === result.clusterId)
    : undefined;
  if (cluster) scene.flyTo(cluster.position);
  const card = await api.card(repoId, result.symbolId);
  setSelection({ repoId, clusterId: result.clusterId ?? undefined, symbolId: result.symbolId, card });
});
chrome.ambientButton.addEventListener("click", () => setAmbient(!state.ambient));
chrome.fpsSelect.addEventListener("change", () => scene.setFpsCap(Number(chrome.fpsSelect.value)));
chrome.skinSelect.addEventListener("change", async () => {
  if (chrome.skinSelect.value === "default") return;
  const bytes = await api.skinBytes(chrome.skinSelect.value);
  const caps = state.settings?.skins ?? { maxZipBytes: 52_428_800, maxEntries: 500, maxDecompressedBytes: 209_715_200 };
  const skin = loadSkinZip(new Uint8Array(bytes), caps);
  applySkinCssVars(canvasHost, skin.manifest);
});

let lastLens = state.activeLens;
subscribe((snapshot) => {
  chrome.lensSelect.value = snapshot.activeLens;
  if (snapshot.settings) scene.setFpsCap(snapshot.ambient ? snapshot.settings.ambient.fps : Number(chrome.fpsSelect.value));
  if (snapshot.activeLens !== lastLens) {
    lastLens = snapshot.activeLens;
    universeRenderer.applyLens(snapshot.activeLens);
    lod.applyLens();
  }
});

async function boot(): Promise<void> {
  const universe = await api.universe();
  setSettings(universe.settings);
  chrome.setSettings(universe.settings);
  chrome.setRepos(universe.repos);
  loadVisibleRepos(universe.repos.map((repo) => repo.repoId));
  const skins = await api.skins().catch(() => ({ skins: [] }));
  chrome.setSkins(skins.skins);

  const rendered: UniverseRepo[] = [];
  for (const repo of universe.repos.filter((item) => state.visibleRepos.has(item.repoId))) {
    try {
      const [clustersResponse, layout, edgeResponse] = await Promise.all([api.clusters(repo.repoId), api.layout(repo.repoId, "cluster"), api.clusterEdges(repo.repoId)]);
      const clusters: Cluster[] = clustersResponse.clusters ?? [];
      universeRenderer.renderRepo(repo, clusters, layout);
      universeRenderer.renderClusterEdges(repo.repoId, edgeResponse.edges ?? []);
      rendered.push(repo);
    } catch (error) {
      console.warn(`[viewer] skipping repo ${repo.repoId}`, error);
    }
  }
  const home = rendered.reduce<UniverseRepo | undefined>((best, repo) => (!best || repo.symbolCount > best.symbolCount ? repo : best), undefined);
  if (home) scene.flyTo(new THREE.Vector3(home.galaxy.position[0], home.galaxy.position[1], home.galaxy.position[2]), Math.max(420, home.galaxy.radius * 1.6));
  else scene.flyTo(new THREE.Vector3(0, 0, 0));
  scene.onFrame(() => { void lod.maybeExpandNearest(); });
  activity.start();
  chrome.setStatus("live");
}

boot().catch((error) => { console.error("[viewer] boot failed", error); chrome.setStatus("error"); });
