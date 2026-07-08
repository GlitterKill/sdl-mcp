import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export type FrameCallback = (deltaMs: number, now: number) => void;

export class ViewerScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly root = new THREE.Group();
  private callbacks = new Set<FrameCallback>();
  private lastFrame = 0;
  private frameCap = 60;
  private disposed = false;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(host.clientWidth, host.clientHeight, false);
    this.renderer.setClearColor(0x030712, 1);
    host.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x030712, 0.00006);
    this.camera = new THREE.PerspectiveCamera(52, 1, 0.1, 100000);
    this.camera.position.set(0, 700, 1200);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    const ambient = new THREE.AmbientLight(0xb8d7ff, 1.15);
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(600, 900, 500);
    this.scene.add(ambient, key, this.root);
    window.addEventListener("resize", this.resize);
    this.resize();
    requestAnimationFrame(this.tick);
  }

  setFpsCap(fps: number): void { this.frameCap = Math.max(1, fps); }
  onFrame(callback: FrameCallback): () => void { this.callbacks.add(callback); return () => this.callbacks.delete(callback); }

  private resize = (): void => {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  };

  private tick = (now: number): void => {
    if (this.disposed) return;
    requestAnimationFrame(this.tick);
    if (document.visibilityState === "hidden") return;
    const budget = 1000 / this.frameCap;
    if (now - this.lastFrame < budget) return;
    const delta = this.lastFrame === 0 ? budget : now - this.lastFrame;
    this.lastFrame = now;
    for (const callback of this.callbacks) callback(delta, now);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  flyTo(target: THREE.Vector3, distance = 420): void {
    this.controls.target.copy(target);
    this.camera.position.copy(target.clone().add(new THREE.Vector3(distance, distance * 0.7, distance)));
    this.controls.update();
  }

  disposeObject(object: THREE.Object3D): void {
    object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
      else material?.dispose();
    });
    object.removeFromParent();
  }

  dispose(): void {
    this.disposed = true;
    window.removeEventListener("resize", this.resize);
    this.disposeObject(this.root);
    this.controls.dispose();
    this.renderer.dispose();
  }
}
