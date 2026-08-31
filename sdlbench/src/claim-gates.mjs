import { percentile } from "./stats.mjs";

const PROFILES = {
  smoke: {
    p50Floor: 30,
    p25Floor: 20,
    minTaskFloor: 5,
    coverageFloor: 0.5,
    fairnessFloor: 0,
  },
  efficient: {
    p50Floor: 45,
    p25Floor: 35,
    minTaskFloor: 0,
    coverageFloor: 0.4,
    fairnessFloor: 10,
  },
  realism: {
    p50Floor: 50,
    p25Floor: 40,
    minTaskFloor: 20,
    coverageFloor: 0.5,
    fairnessFloor: 20,
  },
};

export function validateClaims({ paired, profile = "realism", variant = "sdl" }) {
  const selected = paired.filter(
    (row) =>
      (row.variant ?? row.sdlVariant ?? "sdl") === variant
      && row.bothPass === true
      && row.claimGrade === "primary"
      && row.executionMode === "behavior",
  );
  const thresholds = PROFILES[profile] ?? PROFILES.realism;
  const deltaPcts = selected.map((row) => row.deltaPct).sort((a, b) => a - b);
  const coverages = selected.map((row) => (row.coverage?.fileCoverage ?? 0) / 100);
  const fairnesses = selected.map((row) => row.fairness?.netSavingsPct ?? 0);

  const p50 = percentile(deltaPcts, 50);
  const p25 = percentile(deltaPcts, 25);
  const minVal = deltaPcts.length > 0 ? deltaPcts[0] : 0;
  const avgCoverage = coverages.length > 0 ? coverages.reduce((sum, value) => sum + value, 0) / coverages.length : 0;
  const avgFairness = fairnesses.length > 0 ? fairnesses.reduce((sum, value) => sum + value, 0) / fairnesses.length : 0;

  const gates = [
    { name: "p50_paired_savings", threshold: thresholds.p50Floor, actual: p50, passed: p50 >= thresholds.p50Floor },
    { name: "p25_paired_savings", threshold: thresholds.p25Floor, actual: p25, passed: p25 >= thresholds.p25Floor },
    { name: "min_task_savings", threshold: thresholds.minTaskFloor, actual: minVal, passed: minVal >= thresholds.minTaskFloor },
    { name: "avg_coverage", threshold: thresholds.coverageFloor, actual: avgCoverage, passed: avgCoverage >= thresholds.coverageFloor },
    { name: "avg_fairness_netSavings", threshold: thresholds.fairnessFloor, actual: avgFairness, passed: avgFairness >= thresholds.fairnessFloor },
  ];

  return {
    profile,
    variant,
    passed: gates.every((gate) => gate.passed),
    gates,
    pairedCount: selected.length,
  };
}


export function listProfiles() {
  return Object.keys(PROFILES).map((name) => ({ name, ...PROFILES[name] }));
}
