import {
  confirm as promptConfirm,
  isCancel,
  multiselect as promptMultiselect,
  type Option,
  select as promptSelect,
  text as promptText,
} from "@clack/prompts";
import { createInterface } from "node:readline/promises";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";

const ANSI = {
  cyan: "\u001b[36m",
  gray: "\u001b[90m",
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

export interface ChoiceOption<T extends string> {
  value: T;
  label?: string;
  hint?: string;
}

type ChoiceInput<T extends string> = T | ChoiceOption<T>;

export function colorize(
  color: Color,
  text: string,
  options: ColorOptions = {},
): string {
  if (options.noColor || process.env.NO_COLOR) {
    return text;
  }
  return `${ANSI[color]}${text}${ANSI.reset}`;
}

export function parseConfirmAnswer(
  answer: string,
  defaultValue: boolean,
): boolean {
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

export function parseSingleSelectAnswer<T extends string>(
  answer: string,
  choices: readonly T[],
  defaultValue: T,
): T {
  return (
    parseMultiSelectAnswer(answer, choices, [defaultValue])[0] ?? defaultValue
  );
}

export function parseOptionalTextAnswer(answer: unknown): string {
  return typeof answer === "string" ? answer.trim() : "";
}

export interface TimeoutConfirmOptions {
  question: string;
  defaultValue: boolean;
  timeoutMs: number;
  ask?: (question: string) => Promise<string>;
}

export async function timeoutConfirm(
  options: TimeoutConfirmOptions,
): Promise<boolean> {
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
  const input = defaultInput;
  const output = defaultOutput;
  output.write(question);
  const rl = createInterface({ input, output });
  try {
    return await rl.question("");
  } finally {
    rl.close();
  }
}

export async function confirm(
  question: string,
  defaultValue: boolean,
): Promise<boolean> {
  if (canUseInteractivePrompt()) {
    return unwrapPrompt(
      await promptConfirm({
        message: question,
        initialValue: defaultValue,
      }),
    );
  }

  const suffix = defaultValue ? " [Y/n] " : " [y/N] ";
  return parseConfirmAnswer(
    await askLine(`${question}${suffix}`),
    defaultValue,
  );
}

export async function inputText(
  question: string,
  defaultValue: string,
): Promise<string> {
  if (canUseInteractivePrompt()) {
    const answer = unwrapPrompt(
      await promptText({
        message: question,
        placeholder: defaultValue,
        defaultValue,
      }),
    );
    return answer.trim() || defaultValue;
  }

  const answer = await askLine(`${question} (${defaultValue}): `);
  return answer.trim() || defaultValue;
}

export async function inputOptionalText(
  question: string,
  placeholder: string,
): Promise<string> {
  if (canUseInteractivePrompt()) {
    const answer = unwrapPrompt(
      await promptText({
        message: question,
        placeholder,
      }),
    );
    return parseOptionalTextAnswer(answer);
  }

  return parseOptionalTextAnswer(await askLine(`${question}: `));
}

export async function selectOne<T extends string>(
  question: string,
  choices: readonly ChoiceInput<T>[],
  defaultValue: T,
): Promise<T> {
  const items = toChoiceOptions(choices);
  if (canUseInteractivePrompt()) {
    return unwrapPrompt(
      await promptSelect({
        message: question,
        options: items,
        initialValue: defaultValue,
      }),
    );
  }

  const values = items.map((item) => item.value) as T[];
  console.log(question);
  items.forEach((item, index) =>
    console.log(`  ${index + 1}. ${item.label ?? item.value}`),
  );
  return parseSingleSelectAnswer(
    await askLine(`Select value (${defaultValue}): `),
    values,
    defaultValue,
  );
}

export async function multiSelect<T extends string>(
  question: string,
  choices: readonly ChoiceInput<T>[],
  defaults: readonly T[],
): Promise<T[]> {
  const items = toChoiceOptions(choices);
  if (canUseInteractivePrompt()) {
    return unwrapPrompt(
      await promptMultiselect({
        message: `${question} ${colorize("gray", "(space to toggle)")}`,
        options: items,
        initialValues: [...defaults],
        required: true,
      }),
    );
  }

  const values = items.map((item) => item.value) as T[];
  console.log(question);
  items.forEach((item, index) =>
    console.log(`  ${index + 1}. ${item.label ?? item.value}`),
  );
  const answer = await askLine(
    `Select comma-separated values (${defaults.join(", ")}): `,
  );
  return parseMultiSelectAnswer(answer, values, defaults);
}

export function renderBanner(): void {
  console.log(colorize("cyan", "SDL-MCP Setup Wizard"));
  console.log(
    colorize("gray", "| configure repo -> providers -> embeddings -> index"),
  );
}

function toChoiceOptions<T extends string>(
  choices: readonly ChoiceInput<T>[],
): Option<T>[] {
  return choices.map((choice) =>
    typeof choice === "string"
      ? { value: choice, label: choice }
      : { value: choice.value, label: choice.label, hint: choice.hint },
  ) as Option<T>[];
}

function unwrapPrompt<T>(value: T | symbol): T {
  if (isCancel(value)) {
    throw new Error("Setup wizard cancelled");
  }
  return value;
}

function canUseInteractivePrompt(): boolean {
  return Boolean(defaultInput.isTTY && defaultOutput.isTTY);
}
