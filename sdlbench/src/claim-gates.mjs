import { percentile } from "./stats.mjs";

const PROFILES = {
  smoke: { p50Floor: 30, p25Floor: 20, minTaskFloor: 5 },
  efficient: { p50Floor: 45, p25Floor: 35, minTaskFloor: 0 },
  realism: { p50Floor: 50, p25Floor: 40, minTaskFloor: 20 },
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
  const deltaPcts = selected.map((row) => row.deltaPct).filter(Number.isFinite).sort((a, b) => a - b);
  const p50 = percentile(deltaPcts, 50);
  const p25 = percentile(deltaPcts, 25);
  const minVal = deltaPcts.length > 0 ? deltaPcts[0] : null;
  const complete = selected.length > 0 && deltaPcts.length === selected.length;
  const performanceGates = [
    { name: "p50_paired_savings", threshold: thresholds.p50Floor, actual: p50, passed: complete && p50 >= thresholds.p50Floor },
    { name: "p25_paired_savings", threshold: thresholds.p25Floor, actual: p25, passed: complete && p25 >= thresholds.p25Floor },
    { name: "min_task_savings", threshold: thresholds.minTaskFloor, actual: minVal, passed: complete && minVal >= thresholds.minTaskFloor },
  ];
  // Savings targets describe product performance; validity requires independent evidence.
  const missingCount = selected.filter((row) => row.fairness?.available !== true).length;
  const experimentalValidity = {
    available: selected.length > 0 && missingCount === 0,
    passed: selected.length > 0 && selected.every((row) => row.fairness?.available === true && row.fairness.passed === true),
    missingCount,
  };
  const performancePassed = performanceGates.every((gate) => gate.passed);
  const gates = [...performanceGates, {
    name: "experimental_validity",
    threshold: true,
    actual: experimentalValidity.available ? experimentalValidity.passed : null,
    passed: experimentalValidity.passed,
  }];

  return {
    profile,
    variant,
    passed: performancePassed && experimentalValidity.passed,
    performancePassed,
    experimentalValidity,
    gates,
    pairedCount: selected.length,
  };
}

export function listProfiles() {
  return Object.keys(PROFILES).map((name) => ({ name, ...PROFILES[name] }));
}
