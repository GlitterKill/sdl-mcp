import path from "path";

export interface RedactionPattern {
  name: string;
  pattern: RegExp;
}

export interface RedactionPatternInput {
  name?: string;
  pattern: string;
  flags?: string;
}

export interface RedactionConfig {
  enabled?: boolean;
  includeDefaults?: boolean;
  patterns?: RedactionPatternInput[];
}

const DEFAULT_PATTERNS: RedactionPattern[] = [
  {
    name: "aws-access-key",
    pattern: /\bAKIA[0-9A-Z]{16,32}\b/gi,
  },
  {
    name: "github-token",
    pattern: /\bghp_[a-zA-Z0-9]{36}\b/gi,
  },
  {
    name: "api-key",
    pattern: /\bapi[_-]?key\s*[=:]\s*["']?[a-zA-Z0-9]{20,}["']?\b/gi,
  },
  {
    name: "password",
    pattern: /\bpassword\s*[=:]\s*["']?[^"'\s]{8,}["']?\b/gi,
  },
  {
    name: "connection-string",
    pattern:
      /\b(mongodb:\/\/|postgres:\/\/|mysql:\/\/)[a-zA-Z0-9_\-\.:@\/]+\b/gi,
  },
  {
    name: "jwt-token",
    pattern:
      /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/gi,
  },
  {
    name: "private-key",
    pattern: /-----BEGIN\s+[A-Z\s]+PRIVATE\s+KEY-----/gi,
  },
  {
    name: "env-variable",
    pattern: /\b[A-Z_]{2,}\s*[=:]\s*["']?[a-zA-Z0-9_\-]{16,}["']?\b/gi,
  },
];

const EXCLUDED_FILES = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".env.test",
  ".key",
  ".pem",
  "credentials.json",
  "secrets.yaml",
  "secrets.yml",
  ".secrets",
  "config/secrets.json",
  ".aws/credentials",
];

export function compilePatterns(
  inputs: RedactionPatternInput[],
): RedactionPattern[] {
  const compiled: RedactionPattern[] = [];

  inputs.forEach((input, index) => {
    try {
      compiled.push({
        name: input.name ?? `custom-${index}`,
        pattern: new RegExp(input.pattern, input.flags ?? "g"),
      });
    } catch (error) {
      process.stderr.write(
        `[WARN] Invalid redaction pattern skipped: ${input.name ?? input.pattern}\n`,
      );
    }
  });

  return compiled;
}

export function buildRedactionPatterns(
  config?: RedactionConfig,
): RedactionPattern[] {
  const includeDefaults = config?.includeDefaults ?? true;
  const custom = config?.patterns ? compilePatterns(config.patterns) : [];
  if (includeDefaults) {
    return [...custom, ...DEFAULT_PATTERNS];
  }
  return custom;
}

export function redactSecrets(
  code: string,
  patterns?: RedactionPattern[],
): string {
  const patternsToUse = patterns ?? DEFAULT_PATTERNS;

  let redacted = code;

  for (const { name, pattern } of patternsToUse) {
    redacted = redacted.replace(pattern, `[REDACTED:${name}]`);
  }

  return redacted;
}

export function shouldRedactFile(filePath: string): boolean {
  const fileName = path.basename(filePath);
  const normalizedPath = filePath.replace(/\\/g, "/");

  for (const excluded of EXCLUDED_FILES) {
    if (fileName === excluded || normalizedPath.endsWith(excluded)) {
      return true;
    }
  }

  return false;
}
