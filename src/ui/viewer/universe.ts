import * as THREE from "three";
import type { Cluster, ClusterEdge, LayoutResponse, UniverseRepo } from "./api.js";
import { hashColor } from "./theme.js";
import type { ViewerScene } from "./scene.js";
import type { ActiveLens } from "./state.js";

export type ClusterInstance = { repoId: string; clusterId: string; index: number; position: THREE.Vector3; symbolCount: number; object: THREE.InstancedMesh; halo: THREE.InstancedMesh };

const BASE_COLOR = "#cfe4ff";
const IMPACT_COLD = "#38bdf8";
const IMPACT_HOT = "#fb7185";
const HALO_SCALE = 1.55;

export class UniverseRenderer {
  readonly group = new THREE.Group();
  private clusters = new Map<string, ClusterInstance>();
  private labels: THREE.Sprite[] = [];
  private edgeLines: THREE.LineSegments[] = [];
  private activeLens: ActiveLens = "none";

  constructor(private viewer: ViewerScene) { this.viewer.root.add(this.group); }

  renderRepo(repo: UniverseRepo, clusters: Cluster[], layout: LayoutResponse): void {
    const repoGroup = new THREE.Group();
    repoGroup.name = "repo:" + repo.repoId;
    repoGroup.position.set(repo.galaxy.position[0], repo.galaxy.position[1], repo.galaxy.position[2]);
    const geometry = new THREE.SphereGeometry(10, 16, 12);
    const material = new THREE.MeshBasicMaterial();
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(clusters.length, 1));
    mesh.name = "clusters:" + repo.repoId;
    const haloMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide });
    const halo = new THREE.InstancedMesh(geometry, haloMaterial, Math.max(clusters.length, 1));
    halo.name = "cluster-halos:" + repo.repoId;
    halo.raycast = () => {};
    const color = new THREE.Color();
    const matrix = new THREE.Matrix4();
    const positions = new Map(layout.positions.map((item) => [item.id, item]));
    clusters.forEach((cluster, index) => {
      const p = positions.get(cluster.clusterId);
      const v = new THREE.Vector3(p?.x ?? 0, p?.y ?? 0, p?.z ?? 0);
      const scale = 1.4 + Math.log2(1 + Math.max(cluster.memberCount, 1)) * 0.45;
      matrix.compose(v, new THREE.Quaternion(), new THREE.Vector3(scale, scale, scale));
      mesh.setMatrixAt(index, matrix);
      const haloScale = scale * HALO_SCALE;
      matrix.compose(v, new THREE.Quaternion(), new THREE.Vector3(haloScale, haloScale, haloScale));
      halo.setMatrixAt(index, matrix);
      const instance: ClusterInstance = { repoId: repo.repoId, clusterId: cluster.clusterId, index, position: v.clone().add(repoGroup.position), symbolCount: cluster.memberCount, object: mesh, halo };
      this.clusters.set(repo.repoId + ":" + cluster.clusterId, instance);
      this.lensColor(instance, color);
      mesh.setColorAt(index, color);
      halo.setColorAt(index, color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    halo.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    if (halo.instanceColor) halo.instanceColor.needsUpdate = true;
    repoGroup.add(mesh);
    repoGroup.add(halo);
    repoGroup.add(this.makeLabel(repo.repoId, new THREE.Vector3(0, -72, 0)));
    this.group.add(repoGroup);
  }

  renderClusterEdges(repoId: string, edges: ClusterEdge[]): THREE.LineSegments {
    const points: number[] = [];
    const colors: number[] = [];
    const color = new THREE.Color("#5f82c4");
    for (const edge of edges) {
      const from = this.clusters.get(repoId + ":" + edge.from)?.position;
      const to = this.clusters.get(repoId + ":" + edge.to)?.position;
      if (!from || !to) continue;
      points.push(from.x, from.y, from.z, to.x, to.y, to.z);
      colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    const material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false });
    const lines = new THREE.LineSegments(geometry, material);
    lines.name = "cluster-edges:" + repoId;
    this.group.add(lines);
    this.edgeLines.push(lines);
    return lines;
  }

  getCluster(key: string): ClusterInstance | undefined { return this.clusters.get(key); }
  getClusters(): ClusterInstance[] { return [...this.clusters.values()]; }

  pulseCluster(repoId: string, clusterId: string): void {
    const cluster = this.clusters.get(repoId + ":" + clusterId);
    if (!cluster) return;
    cluster.object.scale.setScalar(1.12);
    cluster.halo.scale.setScalar(1.12);
    setTimeout(() => { cluster.object.scale.setScalar(1); cluster.halo.scale.setScalar(1); }, 350);
  }

  applyLens(lens: ActiveLens): void {
    this.activeLens = lens;
    const color = new THREE.Color();
    const touched = new Set<THREE.InstancedMesh>();
    for (const cluster of this.clusters.values()) {
      this.lensColor(cluster, color);
      cluster.object.setColorAt(cluster.index, color);
      cluster.halo.setColorAt(cluster.index, color);
      (cluster.halo.material as THREE.MeshBasicMaterial).opacity = lens === "edges" ? 0.15 : 0.4;
      touched.add(cluster.object);
      touched.add(cluster.halo);
    }
    for (const mesh of touched) if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    const emphasize = lens === "edges";
    for (const line of this.edgeLines) (line.material as THREE.LineBasicMaterial).opacity = emphasize ? 0.95 : 0.6;
  }

  clear(): void {
    for (const label of this.labels) label.material.map?.dispose();
    this.labels = [];
    this.edgeLines = [];
    while (this.group.children.length > 0) this.viewer.disposeObject(this.group.children[0]);
    this.clusters.clear();
  }

  private lensColor(cluster: Pick<ClusterInstance, "clusterId" | "symbolCount">, target: THREE.Color): THREE.Color {
    if (this.activeLens === "community") return target.set(hashColor(cluster.clusterId));
    if (this.activeLens === "impact") {
      const heat = Math.min(1, Math.log2(1 + Math.max(cluster.symbolCount, 1)) / 12);
      return target.set(IMPACT_COLD).lerp(new THREE.Color(IMPACT_HOT), heat);
    }
    if (this.activeLens === "edges") return target.set(BASE_COLOR).multiplyScalar(0.35);
    return target.set(BASE_COLOR);
  }

  private makeLabel(text: string, position: THREE.Vector3): THREE.Sprite {
    const canvas = document.createElement("canvas");
    canvas.width = 384;
    canvas.height = 96;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "rgba(3,7,18,.72)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = "rgba(127,208,255,.65)";
      ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
      ctx.font = "bold 30px Consolas, monospace";
      ctx.fillStyle = "#e5f2ff";
      ctx.fillText(text, 24, 58);
    }
    const texture = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true }));
    sprite.position.copy(position);
    sprite.scale.set(220, 55, 1);
    this.labels.push(sprite);
    return sprite;
  }
}
