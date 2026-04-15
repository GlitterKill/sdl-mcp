import * as os from "os";

/**
 * CPU performance tier classification based on logical core count.
 *
 * Tier mapping:
 *   - mid:     1–8 logical cores   (consumer laptops, VMs, CI)
 *   - high:    9–20 logical cores  (high-end workstations, developer machines)
 *   - extreme: 21+ logical cores   (server-class, multi-socket, HPC)
 *
 * ARM / Apple Silicon note:
 *   Apple Silicon and other ARM chips expose heterogeneous P-cores / E-cores.
 *   Node.js `os.cpus()` reports ALL logical cores (P + E), which inflates the
 *   count relative to a pure-performance core count. Until Node.js exposes core
 *   type information, we treat ARM the same as x86 by logical count. This means
 *   an M3 Pro (12 logical, 6P+6E) is classified as "high" even though only 6
 *   cores are performance-class. Users on ARM hardware can override the tier
 *   explicitly via `performanceTier` in their config.
 */
export type CpuTier = "mid" | "high" | "extreme";

export interface CpuProfile {
  /** Total logical processors reported by the OS (includes hyperthreads). */
  logicalCores: number;
  /**
   * Estimated physical cores. Best-effort: halves the logical count when
   * hyperthreading is likely active (logical count is even and > 2).
   * Returns `undefined` if detection is not meaningful on the current platform.
   */
  physicalCores?: number;
  /**
   * L2 or L3 cache size in bytes, sourced from `os.cpus()[0].cache.size` when
   * available. Most Node.js builds do not expose this field; returns `undefined`
   * if not detectable.
   */
  cacheSize?: number;
  /** Tier classification derived from `logicalCores`. */
  detectedTier: CpuTier;
}

/**
 * Classify a logical core count into a performance tier.
 */
export function classifyTier(logicalCores: number): CpuTier {
  if (logicalCores >= 21) return "extreme";
  if (logicalCores >= 9) return "high";
  return "mid";
}

/**
 * Detect CPU hardware profile for the current machine.
 *
 * This function is synchronous and fast (no subprocess or filesystem access).
 * It is safe to call at startup.
 */
export function detectCpuProfile(): CpuProfile {
  const cpus = os.cpus();
  const logicalCores = cpus.length;

  // Best-effort physical core estimation:
  // If logical count is even and > 2, assume SMT/hyperthreading halves it.
  // This is a heuristic — it will under-count on systems without SMT.
  let physicalCores: number | undefined;
  if (logicalCores > 2 && logicalCores % 2 === 0) {
    physicalCores = logicalCores / 2;
  }

  // Cache size: os.cpus() may include a `cache` property in some environments
  // (Bun, some Linux Node builds). Guard against its absence.
  let cacheSize: number | undefined;
  if (cpus.length > 0) {
    const firstCpu = cpus[0] as os.CpuInfo & { cache?: { size?: number } };
    if (typeof firstCpu?.cache?.size === "number") {
      cacheSize = firstCpu.cache.size;
    }
  }

  const detectedTier = classifyTier(logicalCores);

  return { logicalCores, physicalCores, cacheSize, detectedTier };
}
