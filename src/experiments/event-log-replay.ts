import type {
  RepoId,
  SymbolId,
  VersionId,
  SymbolKind,
  Visibility,
  EdgeType,
  EdgeResolutionStrategy,
} from "../db/schema.js";
import type { SymbolCard, Range, SymbolSignature } from "../mcp/types.js";

export type EventType =
  | "SYMBOL_UPSERTED"
  | "SYMBOL_REMOVED"
  | "EDGE_CREATED"
  | "EDGE_REMOVED";

export interface SymbolUpsertedEvent {
  eventType: "SYMBOL_UPSERTED";
  timestamp: string;
  repoId: RepoId;
  versionId: VersionId;
  payload: {
    symbolId: SymbolId;
    fileId: number;
    kind: SymbolKind;
    name: string;
    exported: boolean;
    visibility: Visibility | null;
    language: string;
    range: Range;
    astFingerprint: string;
    signature: SymbolSignature | null;
    summary: string | null;
    invariants: string[] | null;
    sideEffects: string[] | null;
  };
}

export interface SymbolRemovedEvent {
  eventType: "SYMBOL_REMOVED";
  timestamp: string;
  repoId: RepoId;
  versionId: VersionId;
  payload: {
    symbolId: SymbolId;
  };
}

export interface EdgeCreatedEvent {
  eventType: "EDGE_CREATED";
  timestamp: string;
  repoId: RepoId;
  versionId: VersionId;
  payload: {
    fromSymbolId: SymbolId;
    toSymbolId: SymbolId;
    type: EdgeType;
    weight: number;
    confidence: number;
    resolutionStrategy: EdgeResolutionStrategy;
  };
}

export interface EdgeRemovedEvent {
  eventType: "EDGE_REMOVED";
  timestamp: string;
  repoId: RepoId;
  versionId: VersionId;
  payload: {
    fromSymbolId: SymbolId;
    toSymbolId: SymbolId;
    type: EdgeType;
  };
}

export type DomainEvent =
  | SymbolUpsertedEvent
  | SymbolRemovedEvent
  | EdgeCreatedEvent
  | EdgeRemovedEvent;

export interface ProjectedSymbol {
  symbolId: SymbolId;
  repoId: RepoId;
  fileId: number;
  kind: SymbolKind;
  name: string;
  exported: boolean;
  visibility: Visibility | null;
  language: string;
  range: Range;
  astFingerprint: string;
  signature: SymbolSignature | null;
  summary: string | null;
  invariants: string[] | null;
  sideEffects: string[] | null;
  updatedAt: string;
}

export interface ProjectedEdge {
  fromSymbolId: SymbolId;
  toSymbolId: SymbolId;
  repoId: RepoId;
  type: EdgeType;
  weight: number;
  confidence: number;
  resolutionStrategy: EdgeResolutionStrategy;
  createdAt: string;
}

export interface ProjectedState {
  symbols: Map<SymbolId, ProjectedSymbol>;
  edges: Map<string, ProjectedEdge>;
  versionId: VersionId;
}

function makeEdgeKey(
  fromSymbolId: SymbolId,
  toSymbolId: SymbolId,
  type: EdgeType,
): string {
  return `${fromSymbolId}:${toSymbolId}:${type}`;
}

export class EventLogReplayer {
  private events: DomainEvent[] = [];
  private eventCounter = 0;

  append(event: Omit<DomainEvent, "timestamp">): void {
    const fullEvent = {
      ...event,
      timestamp: new Date().toISOString(),
    } as DomainEvent;
    this.events.push(fullEvent);
    this.eventCounter++;
  }

  appendSymbolUpsert(
    repoId: RepoId,
    versionId: VersionId,
    payload: SymbolUpsertedEvent["payload"],
  ): void {
    this.append({
      eventType: "SYMBOL_UPSERTED",
      repoId,
      versionId,
      payload,
    });
  }

  appendSymbolRemove(
    repoId: RepoId,
    versionId: VersionId,
    symbolId: SymbolId,
  ): void {
    this.append({
      eventType: "SYMBOL_REMOVED",
      repoId,
      versionId,
      payload: { symbolId },
    });
  }

  appendEdgeCreate(
    repoId: RepoId,
    versionId: VersionId,
    payload: EdgeCreatedEvent["payload"],
  ): void {
    this.append({
      eventType: "EDGE_CREATED",
      repoId,
      versionId,
      payload,
    });
  }

  appendEdgeRemove(
    repoId: RepoId,
    versionId: VersionId,
    fromSymbolId: SymbolId,
    toSymbolId: SymbolId,
    type: EdgeType,
  ): void {
    this.append({
      eventType: "EDGE_REMOVED",
      repoId,
      versionId,
      payload: { fromSymbolId, toSymbolId, type },
    });
  }

  getEventCount(): number {
    return this.eventCounter;
  }

  getEvents(): DomainEvent[] {
    return [...this.events];
  }

  replay(repoId: RepoId, toVersion?: VersionId): ProjectedState {
    const state: ProjectedState = {
      symbols: new Map(),
      edges: new Map(),
      versionId: "" as VersionId,
    };

    const relevantEvents = this.events.filter((e) => {
      if (e.repoId !== repoId) return false;
      if (toVersion && e.versionId > toVersion) return false;
      return true;
    });

    for (const event of relevantEvents) {
      state.versionId = event.versionId;

      switch (event.eventType) {
        case "SYMBOL_UPSERTED":
          state.symbols.set(event.payload.symbolId, {
            ...event.payload,
            repoId: event.repoId,
            updatedAt: event.timestamp,
          });
          break;

        case "SYMBOL_REMOVED":
          state.symbols.delete(event.payload.symbolId);
          for (const [key, edge] of state.edges) {
            if (
              edge.fromSymbolId === event.payload.symbolId ||
              edge.toSymbolId === event.payload.symbolId
            ) {
              state.edges.delete(key);
            }
          }
          break;

        case "EDGE_CREATED": {
          const key = makeEdgeKey(
            event.payload.fromSymbolId,
            event.payload.toSymbolId,
            event.payload.type,
          );
          state.edges.set(key, {
            ...event.payload,
            repoId: event.repoId,
            createdAt: event.timestamp,
          });
          break;
        }

        case "EDGE_REMOVED": {
          const key = makeEdgeKey(
            event.payload.fromSymbolId,
            event.payload.toSymbolId,
            event.payload.type,
          );
          state.edges.delete(key);
          break;
        }
      }
    }

    return state;
  }

  validateParity(
    repoId: RepoId,
    expectedSymbols: Map<SymbolId, SymbolCard>,
    expectedEdges: Map<
      string,
      { from: SymbolId; to: SymbolId; type: EdgeType }
    >,
  ): {
    passed: boolean;
    symbolMatch: number;
    symbolTotal: number;
    edgeMatch: number;
    edgeTotal: number;
    mismatches: string[];
  } {
    const projected = this.replay(repoId);
    const mismatches: string[] = [];

    let symbolMatch = 0;
    for (const [symbolId, expected] of expectedSymbols) {
      const actual = projected.symbols.get(symbolId);
      if (!actual) {
        mismatches.push(`Missing symbol: ${symbolId}`);
        continue;
      }
      if (
        actual.name !== expected.name ||
        actual.kind !== expected.kind ||
        actual.exported !== expected.exported
      ) {
        mismatches.push(
          `Symbol mismatch ${symbolId}: expected ${expected.name}/${expected.kind}, got ${actual.name}/${actual.kind}`,
        );
        continue;
      }
      symbolMatch++;
    }

    let edgeMatch = 0;
    for (const [key, expected] of expectedEdges) {
      const actual = projected.edges.get(key);
      if (!actual) {
        mismatches.push(`Missing edge: ${key}`);
        continue;
      }
      if (
        actual.fromSymbolId !== expected.from ||
        actual.toSymbolId !== expected.to ||
        actual.type !== expected.type
      ) {
        mismatches.push(`Edge mismatch: ${key}`);
        continue;
      }
      edgeMatch++;
    }

    const extraSymbols = projected.symbols.size - expectedSymbols.size;
    if (extraSymbols > 0) {
      mismatches.push(`Extra symbols in projection: ${extraSymbols}`);
    }

    const extraEdges = projected.edges.size - expectedEdges.size;
    if (extraEdges > 0) {
      mismatches.push(`Extra edges in projection: ${extraEdges}`);
    }

    return {
      passed: mismatches.length === 0,
      symbolMatch,
      symbolTotal: expectedSymbols.size,
      edgeMatch,
      edgeTotal: expectedEdges.size,
      mismatches,
    };
  }

  clear(): void {
    this.events = [];
    this.eventCounter = 0;
  }
}

export function createEventLogReplayer(): EventLogReplayer {
  return new EventLogReplayer();
}
