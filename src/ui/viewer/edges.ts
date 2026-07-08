import * as THREE from "three";
import type { SymbolEdge } from "./api.js";
import { KIND_COLORS } from "./theme.js";

export function createSymbolEdges(edges: SymbolEdge[], positions: Map<string, THREE.Vector3>, minConfidence = 0, exactOnly = false, kinds = new Set<string>()): THREE.LineSegments {
  const points: number[] = [];
  const colors: number[] = [];
  for (const edge of edges) {
    const confidence = edge.confidence ?? 1;
    const kind = edge.kind ?? "call";
    if (confidence < minConfidence) continue;
    if (exactOnly && edge.resolution && edge.resolution !== "exact") continue;
    if (kinds.size > 0 && !kinds.has(kind)) continue;
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) continue;
    const color = new THREE.Color(KIND_COLORS[kind] ?? "#93a7c8").multiplyScalar(Math.max(0.65, confidence));
    points.push(from.x, from.y, from.z, to.x, to.y, to.z);
    colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  return new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
}

export function edgeCounts(edges: SymbolEdge[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const edge of edges) counts.set(edge.kind ?? "call", (counts.get(edge.kind ?? "call") ?? 0) + 1);
  return counts;
}
