
export function greet(name: string): string {
  return `Hello, ${name}!`;
}

export function add(a: number, b: number): number {
  return a + b;
}

export class Calculator {
  private value: number = 0;

  add(n: number): void {
    this.value += n;
  }

  getValue(): number {
    return this.value;
  }
}
