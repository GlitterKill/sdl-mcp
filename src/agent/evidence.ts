import type { Evidence } from "./types.js";

export class EvidenceCapture {
  private evidence: Map<string, Evidence[]> = new Map();

  captureSymbolCard(symbolId: string, summary: string): Evidence {
    const evidence: Evidence = {
      type: "symbolCard",
      reference: `symbol:${symbolId}`,
      summary,
      timestamp: Date.now(),
    };

    this.addEvidence(evidence);
    return evidence;
  }

  captureSkeleton(filePath: string, summary: string): Evidence {
    const evidence: Evidence = {
      type: "skeleton",
      reference: `file:${filePath}`,
      summary,
      timestamp: Date.now(),
    };

    this.addEvidence(evidence);
    return evidence;
  }

  captureHotPath(symbolId: string, summary: string): Evidence {
    const evidence: Evidence = {
      type: "hotPath",
      reference: `hotpath:${symbolId}`,
      summary,
      timestamp: Date.now(),
    };

    this.addEvidence(evidence);
    return evidence;
  }

  captureCodeWindow(
    filePath: string,
    lines: number,
    summary: string,
  ): Evidence {
    const evidence: Evidence = {
      type: "codeWindow",
      reference: `window:${filePath}:${lines}`,
      summary,
      timestamp: Date.now(),
    };

    this.addEvidence(evidence);
    return evidence;
  }

  captureDelta(
    fromVersion: string,
    toVersion: string,
    summary: string,
  ): Evidence {
    const evidence: Evidence = {
      type: "delta",
      reference: `delta:${fromVersion}:${toVersion}`,
      summary,
      timestamp: Date.now(),
    };

    this.addEvidence(evidence);
    return evidence;
  }

  captureDiagnostic(filePath: string, line: number, message: string): Evidence {
    const evidence: Evidence = {
      type: "diagnostic",
      reference: `diagnostic:${filePath}:${line}`,
      summary: message,
      timestamp: Date.now(),
    };

    this.addEvidence(evidence);
    return evidence;
  }

  captureSearchResult(query: string, count: number): Evidence {
    const evidence: Evidence = {
      type: "searchResult",
      reference: `search:${query}`,
      summary: `Found ${count} results`,
      timestamp: Date.now(),
    };

    this.addEvidence(evidence);
    return evidence;
  }

  addEvidence(evidence: Evidence): void {
    const key = evidence.type;
    if (!this.evidence.has(key)) {
      this.evidence.set(key, []);
    }
    this.evidence.get(key)!.push(evidence);
  }

  getAllEvidence(): Evidence[] {
    const all: Evidence[] = [];
    for (const evidenceList of this.evidence.values()) {
      all.push(...evidenceList);
    }
    return all.sort((a, b) => a.timestamp - b.timestamp);
  }

  getEvidenceByType(type: Evidence["type"]): Evidence[] {
    return this.evidence.get(type) ?? [];
  }

  getEvidenceCount(type?: Evidence["type"]): number {
    if (type) {
      return this.getEvidenceByType(type).length;
    }
    return this.getAllEvidence().length;
  }

  reset(): void {
    this.evidence.clear();
  }

  getEvidenceSummary(): Record<string, number> {
    const summary: Record<string, number> = {};
    for (const [type, evidenceList] of this.evidence.entries()) {
      summary[type] = evidenceList.length;
    }
    return summary;
  }
}
