export interface ClusterAssignment {
  symbolId: string;
  clusterId: string;
  membershipScore: number;
}

export interface ProcessTraceStep {
  symbolId: string;
  stepOrder: number;
}

export interface ProcessTrace {
  processId: string;
  entrySymbolId: string;
  steps: ProcessTraceStep[];
  depth: number;
}

