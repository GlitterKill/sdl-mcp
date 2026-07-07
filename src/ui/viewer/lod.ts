import * as THREE from "three";
import type { ViewerApi, SymbolNode } from "./api.js";
import { createSymbolEdges } from "./edges.js";
import type { ViewerScene } from "./scene.js";
import { touchExpandedCluster, removeExpandedCluster, state } from "./state.js";
import { KIND_COLORS } from "./theme.js";
import type { UniverseRenderer } from "./universe.js";

type Expanded = { key: string; group: THREE.Group; positions: Map<string, THREE.Vector3>; nodes: SymbolNode[] };

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
    const material = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.25, vertexColors: true, emissive: new THREE.Color("#000000") });
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
      mesh.setColorAt(index, color.set(KIND_COLORS[node.kind ?? "function"] ?? "#e5e7eb"));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    const group = new THREE.Group();
    group.add(mesh);
    group.add(createSymbolEdges(edgeResponse.edges, positions));
    this.viewer.root.add(group);
    this.expanded.set(key, { key, group, positions, nodes });
  }

  collapse(key: string, expanded = this.expanded.get(key)): void {
    if (!expanded) return;
    this.viewer.disposeObject(expanded.group);
    this.expanded.delete(key);
    removeExpandedCluster(key);
  }

  getExpanded(): Expanded[] { return [...this.expanded.values()]; }
}
