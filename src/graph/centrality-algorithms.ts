export interface CentralityInput {
  symbolIds: readonly string[];
  callEdges: readonly { callerId: string; calleeId: string }[];
}

export interface PageRankResult {
  symbolId: string;
  score: number;
}

export interface KCoreResult {
  symbolId: string;
  coreness: number;
}

class MinHeap {
  private readonly data: Array<{ id: string; degree: number }> = [];

  push(item: { id: string; degree: number }): void {
    this.data.push(item);
    this.siftUp(this.data.length - 1);
  }

  pop(): { id: string; degree: number } | undefined {
    const top = this.data[0];
    const last = this.data.pop();
    if (!top || !last) return top;
    if (this.data.length > 0) {
      this.data[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  get length(): number {
    return this.data.length;
  }

  private siftUp(index: number): void {
    let child = index;
    while (child > 0) {
      const parent = Math.floor((child - 1) / 2);
      if (this.data[parent]!.degree <= this.data[child]!.degree) break;
      [this.data[parent], this.data[child]] = [
        this.data[child]!,
        this.data[parent]!,
      ];
      child = parent;
    }
  }

  private siftDown(index: number): void {
    let parent = index;
    while (true) {
      const left = parent * 2 + 1;
      const right = left + 1;
      let smallest = parent;
      if (
        left < this.data.length &&
        this.data[left]!.degree < this.data[smallest]!.degree
      ) {
        smallest = left;
      }
      if (
        right < this.data.length &&
        this.data[right]!.degree < this.data[smallest]!.degree
      ) {
        smallest = right;
      }
      if (smallest === parent) break;
      [this.data[parent], this.data[smallest]] = [
        this.data[smallest]!,
        this.data[parent]!,
      ];
      parent = smallest;
    }
  }
}

export function computePageRank(
  input: CentralityInput,
  iterations = 20,
  damping = 0.85,
): PageRankResult[] {
  const symbolIds = [...new Set(input.symbolIds)].sort();
  const n = symbolIds.length;
  if (n === 0) return [];
  const indexById = new Map(symbolIds.map((id, index) => [id, index]));
  const outgoing = Array.from({ length: n }, () => [] as number[]);
  for (const edge of input.callEdges) {
    const from = indexById.get(edge.callerId);
    const to = indexById.get(edge.calleeId);
    if (from === undefined || to === undefined) continue;
    outgoing[from]!.push(to);
  }

  let ranks = new Array<number>(n).fill(1 / n);
  for (let iteration = 0; iteration < iterations; iteration++) {
    const next = new Array<number>(n).fill((1 - damping) / n);
    let dangling = 0;
    for (let from = 0; from < n; from++) {
      const targets = outgoing[from]!;
      if (targets.length === 0) {
        dangling += ranks[from]!;
        continue;
      }
      const share = (damping * ranks[from]!) / targets.length;
      for (const to of targets) next[to] += share;
    }
    if (dangling > 0) {
      const danglingShare = (damping * dangling) / n;
      for (let i = 0; i < n; i++) next[i] += danglingShare;
    }
    ranks = next;
  }

  return symbolIds.map((symbolId, index) => ({
    symbolId,
    score: ranks[index] ?? 0,
  }));
}

export function computeKCore(input: CentralityInput): KCoreResult[] {
  const symbolIds = [...new Set(input.symbolIds)].sort();
  const adjacency = new Map<string, Set<string>>();
  for (const symbolId of symbolIds) adjacency.set(symbolId, new Set());
  for (const edge of input.callEdges) {
    const from = adjacency.get(edge.callerId);
    const to = adjacency.get(edge.calleeId);
    if (!from || !to || edge.callerId === edge.calleeId) continue;
    from.add(edge.calleeId);
    to.add(edge.callerId);
  }

  const degree = new Map<string, number>();
  const heap = new MinHeap();
  for (const [symbolId, neighbors] of adjacency) {
    const value = neighbors.size;
    degree.set(symbolId, value);
    heap.push({ id: symbolId, degree: value });
  }

  const removed = new Set<string>();
  const coreness = new Map<string, number>();
  let currentCore = 0;
  while (heap.length > 0) {
    const item = heap.pop();
    if (!item || removed.has(item.id)) continue;
    const actualDegree = degree.get(item.id) ?? 0;
    if (item.degree !== actualDegree) continue;
    removed.add(item.id);
    currentCore = Math.max(currentCore, actualDegree);
    coreness.set(item.id, currentCore);
    for (const neighbor of adjacency.get(item.id) ?? []) {
      if (removed.has(neighbor)) continue;
      const nextDegree = Math.max(0, (degree.get(neighbor) ?? 0) - 1);
      degree.set(neighbor, nextDegree);
      heap.push({ id: neighbor, degree: nextDegree });
    }
  }

  return symbolIds.map((symbolId) => ({
    symbolId,
    coreness: coreness.get(symbolId) ?? 0,
  }));
}

