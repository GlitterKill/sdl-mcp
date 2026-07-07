import * as THREE from "three";
import type { ViewerScene } from "./scene.js";
import { setAmbient, state } from "./state.js";
import type { UniverseRenderer } from "./universe.js";

export class AmbientController {
  private lastInput = performance.now();
  private captionTimer = 0;
  constructor(private viewer: ViewerScene, private universe: UniverseRenderer, private caption: HTMLElement) {
    for (const type of ["pointermove", "keydown", "wheel", "pointerdown"]) window.addEventListener(type, this.onInput, { passive: true });
    viewer.onFrame((delta) => this.frame(delta));
  }
  setCaption(text: string): void {
    this.caption.textContent = text;
    this.caption.classList.add("visible");
    window.clearTimeout(this.captionTimer);
    this.captionTimer = window.setTimeout(() => this.caption.classList.remove("visible"), 3500);
  }
  private onInput = (): void => { this.lastInput = performance.now(); if (state.ambient) setAmbient(false); };
  private frame(delta: number): void {
    const settings = state.settings;
    if (!settings?.ambient.enabled) return;
    if (!state.ambient && performance.now() - this.lastInput > settings.ambient.idleSeconds * 1000) setAmbient(true);
    if (!state.ambient) return;
    this.viewer.setFpsCap(settings.ambient.fps);
    const angle = (delta / 1000) * 0.02;
    this.viewer.camera.position.applyAxisAngle(new THREE.Vector3(0, 1, 0), angle);
    this.viewer.controls.target.lerp(new THREE.Vector3(0, 0, 0), 0.02);
    void this.universe;
  }
}
