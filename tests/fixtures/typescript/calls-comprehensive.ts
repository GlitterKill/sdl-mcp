// Comprehensive fixture for TypeScript call extraction (Task 1.8).
//
// Exercises all 12 features enumerated in Task 1.7. Kept small and real-
// parseable so the engine-parity harness can diff TS vs Rust output.

import { externalFn } from "./externals.js";

// (1) Plain function calls + dynamic (require/import)
function plainCalls(): void {
  helperOne();
  helperTwo(1, 2);
  const mod = require("./mod.js");
  const pending = import("./lazy.js");
  externalFn();
}

function helperOne(): void {}
function helperTwo(_a: number, _b: number): number { return _a + _b; }

// (2) Member calls (obj.prop()), (3) new expressions, (8) chained calls
class Service {
  inner = { compute(): number { return 1; } };

  doWork(): number {
    this.prepare();            // this.* → method, resolves to Service.prepare
    const v = this.inner.compute(); // nested member, identifier="compute"
    const user = new User("alice"); // new expression
    const ns = new Mod.Builder();   // new member expression
    return helperTwo(v, user.age()).valueOf(); // chained
  }

  private prepare(): void {}
}

// (4) Super calls
class Admin extends Service {
  constructor() {
    super();                   // super() → "super"
  }
  override doWork(): number {
    super.doWork();            // super.doWork → method, resolved via super
    return 42;
  }
}

class User {
  constructor(public name: string) {}
  age(): number { return 30; }
}

namespace Mod {
  export class Builder {}
}

// (5) Optional chaining calls
function optionalChain(svc?: Service): void {
  svc?.doWork();               // obj?.prop → identifier "svc?.doWork"
  svc?.inner?.compute();       // deep optional chain
}

// (6) Computed property calls
function computedCalls(svc: Service): void {
  const key = "doWork";
  (svc as any)["doWork"]();    // string index → identifier "svc.doWork"
  (svc as any)[key]();         // dynamic index → identifier "svc[key]"
}

// (7) Tagged templates
function tag(_strs: TemplateStringsArray, ..._vals: unknown[]): string {
  return _strs.join("");
}

const obj = { fmt(_s: TemplateStringsArray): string { return ""; } };

function taggedTemplates(): void {
  const a = tag`hello ${1}`;           // identifier tag
  const b = obj.fmt`pattern ${a}`;     // member tag
}

// (9) Nested / arrow-body calls (with findEnclosingSymbol attribution)
async function awaitAndArrows(): Promise<void> {
  const result = await helperTwo(1, 2);           // await + call
  const arr = [1, 2, 3].map((x) => helperOne());  // arrow body
  const pipe = arr
    .map((x) => x + 1)
    .filter((x) => x > 0)                         // chained + arrows
    .reduce((acc, x) => acc + x, 0);
}

// (10) walkForCalls semantics: arrow inside arrow — inner arrow calls get
// attributed to the inner arrow's parent, not the outer one. `walkForCalls`
// stops at nested arrow_function boundaries.
function nestedArrows(): number[] {
  return [1, 2, 3].map((x) => {
    const inner = (y: number) => helperTwo(x, y);
    return inner(x);
  });
}

// Exports / module unresolved receivers
function exportsPath(): void {
  (exports as any).thing?.();
  (module as any).foo();
}
