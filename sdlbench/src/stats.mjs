export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

export function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function stdDev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function bootstrapCI(values, { iterations = 10000, confidence = 0.95 } = {}) {
  if (values.length < 2) {
    const m = mean(values);
    return { mean: m, lower: m, upper: m };
  }
  const n = values.length;
  const means = [];
  for (let i = 0; i < iterations; i++) {
    const sample = [];
    for (let j = 0; j < n; j++) {
      sample.push(values[Math.floor(Math.random() * n)]);
    }
    means.push(mean(sample));
  }
  means.sort((a, b) => a - b);
  const alpha = (1 - confidence) / 2;
  const lowerIdx = Math.floor(alpha * means.length);
  const upperIdx = Math.floor((1 - alpha) * means.length);
  return {
    mean: mean(values),
    lower: means[lowerIdx],
    upper: means[Math.min(upperIdx, means.length - 1)],
  };
}

export function mannWhitneyU(sampleA, sampleB) {
  const all = [
    ...sampleA.map((v) => ({ value: v, group: "a" })),
    ...sampleB.map((v) => ({ value: v, group: "b" })),
  ].sort((a, b) => a.value - b.value);

  const ranks = new Map();
  let i = 0;
  while (i < all.length) {
    let j = i;
    while (j < all.length - 1 && all[j + 1].value === all[i].value) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks.set(k, avgRank);
    i = j + 1;
  }

  const rankSumA = all
    .map((item, idx) => (item.group === "a" ? (ranks.get(idx) ?? 0) : 0))
    .reduce((sum, v) => sum + v, 0);

  const n1 = sampleA.length;
  const n2 = sampleB.length;
  const uA = rankSumA - (n1 * (n1 + 1)) / 2;
  const uB = n1 * n2 - uA;
  const u = Math.min(uA, uB);

  const mu = (n1 * n2) / 2;
  const sigma = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12);
  const z = sigma > 0 ? (u - mu) / sigma : 0;
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));

  return { u, z, pValue, significant: pValue < 0.05 };
}

function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989423 * Math.exp(-z * z / 2);
  return d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
}
