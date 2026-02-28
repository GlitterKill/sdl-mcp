function tag(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.raw.join("");
}

const result = tag`hello ${"world"}`;
