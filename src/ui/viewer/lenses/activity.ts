import type { ViewerApi, GraphEvent } from "../api.js";
import { pushGraphEvent } from "../state.js";
import type { UniverseRenderer } from "../universe.js";

export class ActivityLens {
  private abortController: AbortController | null = null;
  constructor(private api: ViewerApi, private universe: UniverseRenderer, private setCaption: (text: string) => void) {}
  start(): void {
    this.abortController?.abort();
    this.abortController = new AbortController();
    void this.api.graphStream((event) => this.handle(event), this.abortController.signal).catch((error) => console.warn("[viewer] graph stream", error));
  }
  stop(): void { this.abortController?.abort(); }
  private handle(event: GraphEvent): void {
    pushGraphEvent(event);
    if (event.repoId && event.clusterId) this.universe.pulseCluster(event.repoId, event.clusterId);
    this.setCaption(event.type + (event.count ? ": " + event.count : ""));
  }
}
