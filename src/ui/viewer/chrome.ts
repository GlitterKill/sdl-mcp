import type { SkinListEntry, UniverseRepo, ViewerSettings } from "./api.js";
import { setActiveLens, setVisibleRepos, state, subscribe } from "./state.js";

export class ViewerChrome {
  readonly searchInput: HTMLInputElement;
  readonly lensSelect: HTMLSelectElement;
  readonly skinSelect: HTMLSelectElement;
  readonly fpsSelect: HTMLSelectElement;
  readonly ambientButton: HTMLButtonElement;
  readonly status: HTMLElement;
  readonly repoHost: HTMLElement;

  constructor(host: HTMLElement) {
    host.innerHTML = '<div class="brand"><span class="mark"></span><div><h1>SDL Galaxy</h1><p>graph viewer</p></div></div>' +
      '<div class="toolbar"><div class="repo-filter"></div><input class="search" type="search" placeholder="Search symbols" aria-label="Search symbols" />' +
      '<select class="lens" aria-label="Lens"><option value="none">Normal</option><option value="community">Community</option><option value="impact">Impact</option><option value="edges">Edges</option></select>' +
      '<select class="skin" aria-label="Skin"><option value="default">Default</option></select>' +
      '<select class="fps" aria-label="FPS"><option>15</option><option>30</option><option selected>60</option><option>90</option><option>120</option></select>' +
      '<button class="ambient" type="button" aria-pressed="false">Ambient</button><span class="status">booting</span></div>';
    this.searchInput = host.querySelector<HTMLInputElement>(".search")!;
    this.lensSelect = host.querySelector<HTMLSelectElement>(".lens")!;
    this.skinSelect = host.querySelector<HTMLSelectElement>(".skin")!;
    this.fpsSelect = host.querySelector<HTMLSelectElement>(".fps")!;
    this.ambientButton = host.querySelector<HTMLButtonElement>(".ambient")!;
    this.status = host.querySelector<HTMLElement>(".status")!;
    this.repoHost = host.querySelector<HTMLElement>(".repo-filter")!;
    this.lensSelect.addEventListener("change", () => setActiveLens(this.lensSelect.value as typeof state.activeLens));
    subscribe((snapshot) => { this.ambientButton.setAttribute("aria-pressed", String(snapshot.ambient)); });
  }

  setRepos(repos: UniverseRepo[]): void {
    this.repoHost.innerHTML = repos.map((repo) => '<label><input type="checkbox" value="' + repo.repoId + '" checked />' + repo.repoId + '</label>').join("");
    this.repoHost.addEventListener("change", () => {
      setVisibleRepos([...this.repoHost.querySelectorAll<HTMLInputElement>('input:checked')].map((input) => input.value));
    });
  }

  setSettings(settings: ViewerSettings): void { this.fpsSelect.value = String(settings.fps); }
  setSkins(skins: SkinListEntry[]): void { this.skinSelect.innerHTML = '<option value="default">Default</option>' + skins.map((skin) => '<option value="' + skin.id + '">' + skin.id + '</option>').join(""); }
  setStatus(value: string): void { this.status.textContent = value; }
}
