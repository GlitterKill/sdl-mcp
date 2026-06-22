import { createInterface } from "node:readline/promises";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";

const ANSI = {
  cyan: "\u001b[36m",
  magenta: "\u001b[35m",
  gray: "\u001b[90m",
  white: "\u001b[37m",
  reset: "\u001b[0m",
};

type Color = keyof typeof ANSI extends infer Key
  ? Key extends "reset"
    ? never
    : Key
  : never;

export interface ColorOptions {
  noColor?: boolean;
}

export function colorize(color: Color, text: string, options: ColorOptions = {}): string {
  if (options.noColor || process.env.NO_COLOR) {
    return text;
  }
  return `${ANSI[color]}${text}${ANSI.reset}`;
}

export function parseConfirmAnswer(answer: string, defaultValue: boolean): boolean {
  const normalized = answer.trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }
  return ["y", "yes", "true", "1"].includes(normalized);
}

export function parseMultiSelectAnswer<T extends string>(
  answer: string,
  choices: readonly T[],
  defaults: readonly T[],
): T[] {
  const normalized = answer.trim().toLowerCase();
  if (!normalized) {
    return [...defaults];
  }
  if (normalized === "all" || normalized === "*") {
    return [...choices];
  }

  const selected = new Set<T>();
  for (const part of normalized.split(",")) {
    const token = part.trim();
    const index = Number.parseInt(token, 10);
    if (Number.isInteger(index) && index >= 1 && index <= choices.length) {
      selected.add(choices[index - 1]);
      continue;
    }
    const match = choices.find((choice) => choice.toLowerCase() === token);
    if (match) {
      selected.add(match);
    }
  }
  return [...selected];
}

export interface TimeoutConfirmOptions {
  question: string;
  defaultValue: boolean;
  timeoutMs: number;
  ask?: (question: string) => Promise<string>;
}

export async function timeoutConfirm(options: TimeoutConfirmOptions): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(options.defaultValue), options.timeoutMs);
  });
  const asked = (options.ask ?? askLine)(options.question).then((answer) =>
    parseConfirmAnswer(answer, options.defaultValue),
  );

  try {
    return await Promise.race([asked, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function askLine(question: string): Promise<string> {
  const rl = createInterface({ input: defaultInput, output: defaultOutput });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export async function confirm(question: string, defaultValue: boolean): Promise<boolean> {
  const suffix = defaultValue ? " [Y/n] " : " [y/N] ";
  return parseConfirmAnswer(await askLine(`${question}${suffix}`), defaultValue);
}

export async function inputText(question: string, defaultValue: string): Promise<string> {
  const answer = await askLine(`${question} (${defaultValue}): `);
  return answer.trim() || defaultValue;
}

export async function multiSelect<T extends string>(
  question: string,
  choices: readonly T[],
  defaults: readonly T[],
): Promise<T[]> {
  console.log(question);
  choices.forEach((choice, index) => console.log(`  ${index + 1}. ${choice}`));
  const answer = await askLine(`Select comma-separated values (${defaults.join(", ")}): `);
  return parseMultiSelectAnswer(answer, choices, defaults);
}

export function renderBanner(): void {
  console.log(colorize("cyan", "SDL-MCP Setup Wizard"));
  console.log(colorize("gray", "| configure repo -> providers -> embeddings -> index"));
}
