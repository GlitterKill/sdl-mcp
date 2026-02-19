import {
  trace,
  context,
  SpanStatusCode,
  type Span,
  type Tracer,
  type SpanOptions,
} from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  InMemorySpanExporter,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { TracingConfig } from "../config/types.js";
import { SDL_MCP_VERSION } from "../config/constants.js";

let tracer: Tracer | null = null;
let provider: NodeTracerProvider | null = null;
let memoryExporter: InMemorySpanExporter | null = null;
let isInitialized = false;

export const TRACING_SERVICE_NAME = "sdl-mcp";

export const SPAN_NAMES = {
  SLICE_BUILD: "sdl.slice.build",
  DELTA_GET: "sdl.delta.get",
  INDEX_REFRESH: "sdl.index.refresh",
  REPO_STATUS: "sdl.repo.status",
} as const;

export function isTracingEnabled(): boolean {
  return isInitialized && tracer !== null;
}

export function getMemoryExporter(): InMemorySpanExporter | null {
  return memoryExporter;
}

export function initTracing(config: TracingConfig): void {
  if (isInitialized) {
    return;
  }

  if (!config.enabled) {
    isInitialized = true;
    return;
  }

  const serviceName = config.serviceName ?? TRACING_SERVICE_NAME;
  const resource = Resource.default().merge(
    new Resource({
      [ATTR_SERVICE_NAME]: serviceName,
    }),
  );

  provider = new NodeTracerProvider({ resource });

  let exporter: SpanExporter;
  switch (config.exporterType) {
    case "console":
      exporter = new ConsoleSpanExporter();
      provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
      break;
    case "memory":
      memoryExporter = new InMemorySpanExporter();
      exporter = memoryExporter;
      provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
      break;
    case "otlp":
      throw new Error(
        "OTLP exporter requires @opentelemetry/exporter-trace-otlp-http package. " +
          "Use 'console' or 'memory' exporter instead.",
      );
    default:
      exporter = new ConsoleSpanExporter();
      provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  }

  provider.register();
  tracer = trace.getTracer(serviceName, SDL_MCP_VERSION);
  isInitialized = true;
}

export function shutdownTracing(): Promise<void> {
  if (provider) {
    return provider.shutdown();
  }
  return Promise.resolve();
}

export function getTracer(): Tracer {
  if (!tracer) {
    return trace.getTracer(TRACING_SERVICE_NAME, SDL_MCP_VERSION);
  }
  return tracer;
}

export interface SpanAttributes {
  repoId?: string;
  versionId?: string;
  budget?: {
    maxCards?: number;
    maxEstimatedTokens?: number;
  };
  counts?: {
    cards?: number;
    edges?: number;
    symbols?: number;
    files?: number;
  };
  [key: string]:
    | string
    | number
    | boolean
    | undefined
    | Record<string, unknown>;
}

function flattenAttributes(
  attrs: SpanAttributes,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};

  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;

    if (typeof value === "object" && value !== null) {
      for (const [subKey, subValue] of Object.entries(value)) {
        if (subValue !== undefined) {
          result[`${key}.${subKey}`] = subValue as string | number | boolean;
        }
      }
    } else {
      result[key] = value as string | number | boolean;
    }
  }

  return result;
}

export function startSpan(
  name: string,
  attributes?: SpanAttributes,
  options?: SpanOptions,
): { span: Span; end: (error?: Error) => void } {
  const activeTracer = getTracer();
  const flatAttrs = attributes ? flattenAttributes(attributes) : undefined;

  const span = activeTracer.startSpan(name, {
    ...options,
    attributes: flatAttrs,
  });

  const end = (error?: Error): void => {
    if (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }
    span.end();
  };

  return { span, end };
}

export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes?: SpanAttributes,
  options?: SpanOptions,
): Promise<T> {
  const { span, end } = startSpan(name, attributes, options);

  try {
    const result = await fn(span);
    end();
    return result;
  } catch (error) {
    end(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

export function withSpanSync<T>(
  name: string,
  fn: (span: Span) => T,
  attributes?: SpanAttributes,
  options?: SpanOptions,
): T {
  const { span, end } = startSpan(name, attributes, options);

  try {
    const result = fn(span);
    end();
    return result;
  } catch (error) {
    end(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

export function setSpanAttributes(
  span: Span,
  attributes: SpanAttributes,
): void {
  const flatAttrs = flattenAttributes(attributes);
  span.setAttributes(flatAttrs);
}

export function runInSpanContext<T>(span: Span, fn: () => T): T {
  return context.with(trace.setSpan(context.active(), span), fn);
}

export function resetTracingForTest(): void {
  if (provider) {
    provider.forceFlush();
  }
  tracer = null;
  provider = null;
  memoryExporter = null;
  isInitialized = false;
}
