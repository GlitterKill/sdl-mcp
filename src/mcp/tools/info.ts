import { z } from "zod";
import { collectInfoReport, type InfoReport } from "../../info/report.js";

export const InfoRequestSchema = z.object({}).passthrough();

/** Collects and returns the server info/diagnostics report. */
export async function handleInfo(): Promise<InfoReport> {
  return collectInfoReport();
}
