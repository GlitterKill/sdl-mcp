import { z } from "zod";
import { collectInfoReport } from "../../info/report.js";

export const InfoRequestSchema = z.object({}).passthrough();

export async function handleInfo(): Promise<unknown> {
  return collectInfoReport();
}
