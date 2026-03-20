import { getPackageVersion } from "../util/package-info.js";

export interface ToolPresentation {
  title: string;
  includeVersionInDescription?: boolean;
}

const TITLE_SEGMENT_MAP: Record<string, string> = {
  action: "Action",
  agent: "Agent",
  buffer: "Buffer",
  chain: "Chain",
  code: "Code",
  context: "Context",
  delta: "Delta",
  feedback: "Feedback",
  getcard: "Get Card",
  getcards: "Get Cards",
  gethotpath: "Get Hot Path",
  getskeleton: "Get Skeleton",
  index: "Index",
  info: "Info",
  manual: "Manual",
  memory: "Memory",
  needwindow: "Need Window",
  orchestrate: "Orchestrate",
  policy: "Policy",
  pr: "PR",
  query: "Query",
  refresh: "Refresh",
  register: "Register",
  repo: "Repository",
  risk: "Risk",
  runtime: "Runtime",
  search: "Search",
  set: "Set",
  sdl: "SDL",
  slice: "Slice",
  spillover: "Spillover",
  status: "Status",
  summary: "Summary",
  symbol: "Symbol",
  tool: "Tool",
  usage: "Usage",
};

function toTitleCase(segment: string): string {
  const compact = segment.replace(/[^a-zA-Z0-9]/g, "");
  const mapped = TITLE_SEGMENT_MAP[compact.toLowerCase()];
  if (mapped) {
    return mapped;
  }

  return segment
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

export function buildToolTitle(name: string): string {
  return name
    .split(".")
    .filter((segment) => segment.length > 0)
    .map(toTitleCase)
    .join(" ");
}

export function buildVersionedToolDescription(description?: string): string | undefined {
  if (!description) {
    return undefined;
  }

  const version = getPackageVersion();
  return `${description} [SDL-MCP v${version}]`;
}

export function buildToolPresentation(
  name: string,
  overrides: Partial<ToolPresentation> = {},
): ToolPresentation {
  return {
    title: overrides.title ?? buildToolTitle(name),
    includeVersionInDescription: overrides.includeVersionInDescription ?? true,
  };
}
