import * as THREE from "three";
import type { ViewerApi } from "./api.js";
import type { ViewerScene } from "./scene.js";
import { setHovered, setSelection } from "./state.js";
import type { UniverseRenderer } from "./universe.js";

export class PickingController {
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();

  constructor(_api: ViewerApi, private viewer: ViewerScene, private universe: UniverseRenderer) {
    viewer.renderer.domElement.addEventListener("pointermove", this.onMove);
    viewer.renderer.domElement.addEventListener("click", this.onClick);
  }

  private pick(event: PointerEvent): THREE.Intersection | null {
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.viewer.camera);
    return this.raycaster.intersectObjects(this.viewer.root.children, true)[0] ?? null;
  }

  private onMove = (event: PointerEvent): void => {
    const hit = this.pick(event);
    setHovered(hit?.object.name ?? null);
  };

  private onClick = async (event: PointerEvent): Promise<void> => {
    const hit = this.pick(event);
    if (!hit) { setSelection(null); return; }
    if (hit.object.name.startsWith("clusters:")) {
      const repoId = hit.object.name.slice("clusters:".length);
      const instanceId = hit.instanceId ?? 0;
      const cluster = this.universe.getClusters().filter((item) => item.repoId === repoId)[instanceId];
      if (cluster) {
        this.viewer.flyTo(cluster.position);
        setSelection({ repoId, clusterId: cluster.clusterId });
      }
    }
  };

  dispose(): void {
    this.viewer.renderer.domElement.removeEventListener("pointermove", this.onMove);
    this.viewer.renderer.domElement.removeEventListener("click", this.onClick);
  }
}
