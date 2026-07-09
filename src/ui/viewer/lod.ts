import * as THREE from "three";
import type { ViewerApi, SymbolNode } from "./api.js";
import { createSymbolEdges } from "./edges.js";
import type { ViewerScene } from "./scene.js";
import { touchExpandedCluster, removeExpandedCluster, state } from "./state.js";
import { KIND_COLORS, hashColor } from "./theme.js";
import type { UniverseRenderer } from "./universe.js";

type Expanded = { key: string; clusterId: string; group: THREE.Group; positions: Map<string, THREE.Vector3>; nodes: SymbolNode[]; mesh: THREE.InstancedMesh; lines: THREE.LineSegments };

export class LodController {
  private expanded = new Map<string, Expanded>();
  constructor(private api: ViewerApi, private viewer: ViewerScene, private universe: UniverseRenderer) {}

  async maybeExpandNearest(): Promise<void> {
    let nearest: { key: string; distance: number } | null = null;
    for (const cluster of this.universe.getClusters()) {
      const distance = cluster.position.distanceTo(this.viewer.camera.position);
      if (distance < 520 && (!nearest || distance < nearest.distance)) nearest = { key: cluster.repoId + ":" + cluster.clusterId, distance };
    }
    if (nearest && !this.expanded.has(nearest.key)) await this.expand(nearest.key);
    for (const [key, expanded] of this.expanded) {
      const cluster = this.universe.getCluster(key);
      if (!cluster || cluster.position.distanceTo(this.viewer.camera.position) > 1150 || !state.expandedClusters.has(key)) this.collapse(key, expanded);
    }
  }

  async expand(key: string): Promise<void> {
    const cluster = this.universe.getCluster(key);
    if (!cluster) return;
    touchExpandedCluster(key);
    const limit = state.settings?.layout.maxSymbolsPerClusterExpand ?? 5000;
    if (cluster.symbolCount > limit) return;
    const [layout, edgeResponse] = await Promise.all([
      this.api.layout(cluster.repoId, "symbol", cluster.clusterId),
      this.api.symbolEdges(cluster.repoId, cluster.clusterId),
    ]);
    const nodes: SymbolNode[] = edgeResponse.nodes ?? layout.positions.map((position): SymbolNode => ({ id: position.id }));
    const geometry = new THREE.SphereGeometry(3.5, 10, 8);
    const material = new THREE.MeshBasicMaterial();
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(nodes.length, 1));
    mesh.name = "symbols:" + key;
    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();
    const positions = new Map<string, THREE.Vector3>();
    const layoutPositions = new Map(layout.positions.map((position) => [position.id, position]));
    nodes.forEach((node, index) => {
      const p = layoutPositions.get(node.id);
      const position = new THREE.Vector3(p?.x ?? 0, p?.y ?? 0, p?.z ?? 0).multiplyScalar(0.45).add(cluster.position);
      positions.set(node.id, position);
      const scale = 0.5 + Math.log2(1 + (node.fanIn ?? 0)) * 0.25;
      matrix.compose(position, new THREE.Quaternion(), new THREE.Vector3(scale, scale, scale));
      mesh.setMatrixAt(index, matrix);
      mesh.setColorAt(index, this.nodeColor(node, cluster.clusterId, color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    const lines = createSymbolEdges(edgeResponse.edges, positions);
    const group = new THREE.Group();
    group.add(mesh);
    group.add(lines);
    this.viewer.root.add(group);
    this.expanded.set(key, { key, clusterId: cluster.clusterId, group, positions, nodes, mesh, lines });
  }

  collapse(key: string, expanded = this.expanded.get(key)): void {
    if (!expanded) return;
    this.viewer.disposeObject(expanded.group);
    this.expanded.delete(key);
    removeExpandedCluster(key);
  }

  applyLens(): void {
    const color = new THREE.Color();
    for (const expanded of this.expanded.values()) {
      expanded.nodes.forEach((node, index) => {
        expanded.mesh.setColorAt(index, this.nodeColor(node, expanded.clusterId, color));
      });
      if (expanded.mesh.instanceColor) expanded.mesh.instanceColor.needsUpdate = true;
      (expanded.lines.material as THREE.LineBasicMaterial).opacity = state.activeLens === "edges" ? 1 : 0.85;
    }
  }

  private nodeColor(node: SymbolNode, clusterId: string, target: THREE.Color): THREE.Color {
    const lens = state.activeLens;
    if (lens === "community") return target.set(hashColor(clusterId));
    if (lens === "impact") {
      const heat = Math.min(1, Math.log2(1 + (node.fanIn ?? 0)) / 8);
      return target.set("#38bdf8").lerp(new THREE.Color("#fb7185"), heat);
    }
    target.set(KIND_COLORS[node.kind ?? "function"] ?? "#e5e7eb");
    return lens === "edges" ? target.multiplyScalar(0.35) : target;
  }

  getExpanded(): Expanded[] { return [...this.expanded.values()]; }
}
