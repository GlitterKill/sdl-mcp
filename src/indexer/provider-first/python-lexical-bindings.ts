import type { SyntaxNode } from "tree-sitter";
import type { ScipDocument, ScipOccurrence } from "../../scip/types.js";

export type PythonBindingProof = Map<string, string[]>;
export interface PythonModuleBindings {
  exports: Map<string, string>;
  members: Array<{
    key: string;
    moduleSymbol: string;
    name: string;
    target: string;
  }>;
  mutatedModules: string[];
  mutatedMembers: string[];
}

type BindingTargets = Set<string> & { mayBeUnbound?: boolean };
// undefined is an unbound local that masks outer bindings; null is unknown.
type Bindings = Map<string, BindingTargets | null | undefined>;

// Python 3.14.4 dir(builtins), plus WindowsError for Windows Python.
// All dunder names are rejected separately to cover implicit module bindings.
const PYTHON_FALLBACK_NAMES = new Set(
  `
ArithmeticError AssertionError AttributeError BaseException BaseExceptionGroup
BlockingIOError BrokenPipeError BufferError BytesWarning ChildProcessError
ConnectionAbortedError ConnectionError ConnectionRefusedError ConnectionResetError
DeprecationWarning EOFError Ellipsis EncodingWarning EnvironmentError Exception
ExceptionGroup False FileExistsError FileNotFoundError FloatingPointError
FutureWarning GeneratorExit IOError ImportError ImportWarning IndentationError
IndexError InterruptedError IsADirectoryError KeyError KeyboardInterrupt LookupError
MemoryError ModuleNotFoundError NameError None NotADirectoryError NotImplemented
NotImplementedError OSError OverflowError PendingDeprecationWarning PermissionError
ProcessLookupError PythonFinalizationError RecursionError ReferenceError ResourceWarning
RuntimeError RuntimeWarning StopAsyncIteration StopIteration SyntaxError SyntaxWarning
SystemError SystemExit TabError TimeoutError True TypeError UnboundLocalError
UnicodeDecodeError UnicodeEncodeError UnicodeError UnicodeTranslateError UnicodeWarning
UserWarning ValueError Warning WindowsError ZeroDivisionError _IncompleteInputError
abs aiter all anext any ascii bin bool breakpoint bytearray bytes callable chr
classmethod compile complex copyright credits delattr dict dir divmod enumerate
eval exec exit filter float format frozenset getattr globals hasattr hash help hex
id input int isinstance issubclass iter len license list locals map max memoryview
min next object oct open ord pow print property quit range repr reversed round set
setattr slice sorted staticmethod str sum super tuple type vars zip
`
    .trim()
    .split(/\s+/),
);
type Writes = Map<string, SyntaxNode[]>;

export function pythonOccurrenceKey(o: ScipOccurrence): string {
  const r = o.range;
  return JSON.stringify([
    r.startLine,
    r.startCol,
    r.endLine,
    r.endCol,
    o.symbol,
  ]);
}

// Called only in a parser worker. Proof supplies a spelling for an existing
// provider reference; it neither chooses a runtime branch nor creates targets.
export function provePythonLexicalBindings(
  document: ScipDocument,
  root: SyntaxNode,
  moduleBindings?: PythonModuleBindings,
): PythonBindingProof {
  const proof: PythonBindingProof = new Map();
  if (root.hasError || !/^python$/i.test(document.language)) return proof;
  const references = new Map<string, ScipOccurrence[]>();
  for (const o of document.occurrences) {
    const local = /^local \d+$/.test(o.symbol);
    if (
      (!local && o.symbolRoles & 1) ||
      (!local && !o.symbol.startsWith("scip-python "))
    )
      continue;
    const r = o.range;
    const key = `${r.startLine}:${r.startCol}:${r.endLine}:${r.endCol}`;
    references.set(key, [...(references.get(key) ?? []), o]);
  }
  const at = (n: SyntaxNode): ScipOccurrence[] =>
    references.get(
      `${n.startPosition.row}:${n.startPosition.column}:${n.endPosition.row}:${n.endPosition.column}`,
    ) ?? [];
  // Native node IDs are stable within this tree; JS wrappers may be recreated.
  const field = (n: SyntaxNode, name: string): SyntaxNode | null =>
    n.childForFieldName(name);
  const isScope = (n: SyntaxNode): boolean =>
    ["function_definition", "class_definition", "lambda"].includes(n.type);
  const isComprehension = (n: SyntaxNode): boolean =>
    [
      "list_comprehension",
      "set_comprehension",
      "dictionary_comprehension",
      "generator_expression",
    ].includes(n.type);
  const names = (n: SyntaxNode | null): string[] => {
    if (!n) return [];
    if (n.type === "identifier") return [n.text];
    // Attribute/subscript writes do not rebind the object name.
    if (["attribute", "subscript"].includes(n.type)) return [];
    return n.namedChildren.flatMap(names);
  };
  const imported = (n: SyntaxNode): SyntaxNode[] =>
    n.childrenForFieldName("name");
  const boundName = (n: SyntaxNode): string =>
    field(n, "alias")?.text ?? n.text.split(".")[0];
  const writes = (scope: SyntaxNode): Writes => {
    const result: Writes = new Map();
    const add = (name: string, n: SyntaxNode): void => {
      result.set(name, [...(result.get(name) ?? []), n]);
    };
    const scan = (n: SyntaxNode): void => {
      if (isScope(n)) {
        const name = field(n, "name");
        if (name) add(name.text, n);
        // Defaults, decorators and bases execute in the enclosing scope.
        for (const child of n.namedChildren)
          if (child.id !== field(n, "body")?.id && child.id !== name?.id)
            scan(child);
        return;
      }
      if (isComprehension(n)) {
        // Walrus targets escape comprehension scope; loop targets do not.
        for (const assignment of n.descendantsOfType("named_expression"))
          for (const name of names(field(assignment, "name")))
            add(name, assignment);
        return;
      }
      if (["import_from_statement", "import_statement"].includes(n.type)) {
        for (const item of imported(n)) add(boundName(item), n);
        if (n.namedChildren.some((child) => child.type === "wildcard_import"))
          add("*", n);
        return;
      }
      if (
        [
          "assignment",
          "augmented_assignment",
          "for_statement",
          "for_in_clause",
        ].includes(n.type)
      )
        for (const name of names(field(n, "left"))) add(name, n);
      if (n.type === "named_expression")
        for (const name of names(field(n, "name"))) add(name, n);
      if (n.type === "delete_statement" || n.type === "case_pattern")
        for (const name of names(n)) add(name, n);
      if (n.type === "as_pattern") {
        for (const name of names(field(n, "alias"))) add(name, n);
      }
      for (const child of n.namedChildren) scan(child);
    };
    for (const child of scope.namedChildren) scan(child);
    return result;
  };
  // ponytail: dynamic global/nonlocal mutation fails closed for that name in
  // this document; interprocedural execution proof would be needed to relax it.
  const mutable = new Set(
    root
      .descendantsOfType(["global_statement", "nonlocal_statement"])
      .flatMap(names),
  );
  const clearedExceptionNames = new Set(
    root
      .descendantsOfType("except_clause")
      .flatMap((clause) =>
        clause.namedChildren.filter((n) => n.type === "as_pattern"),
      )
      .flatMap((pattern) => names(field(pattern, "alias"))),
  );
  // Conservatively invalidate module-member proof for any local member write,
  // including writes through another imported spelling of the same module.
  const importedModules = new Map<string, Set<string>>();
  for (const statement of root.descendantsOfType([
    "import_from_statement",
    "import_statement",
  ])) {
    for (const item of imported(statement)) {
      const ids = importedModules.get(boundName(item)) ?? new Set<string>();
      for (const o of [
        item,
        ...item.descendantsOfType(["identifier", "dotted_name"]),
      ].flatMap(at))
        if (o.symbol.endsWith("/__init__:")) ids.add(o.symbol);
      importedModules.set(boundName(item), ids);
    }
  }
  const mutatedNames = new Set<string>();
  const mutatedModules = new Set<string>();
  const mutatedMembers = new Set<string>();
  const memberKey = (symbol: string, name: string): string =>
    JSON.stringify([symbol, name]);
  const mutation = (node: SyntaxNode | null, member?: string): void => {
    if (!node) return;
    if (node.type === "attribute") {
      const name = field(node, "attribute")?.text;
      mutation(field(node, "object"), name === "__dict__" ? undefined : name);
    } else if (node.type === "subscript") {
      mutation(field(node, "value"));
    } else if (node.type === "identifier") {
      mutatedNames.add(memberKey(node.text, member ?? "*"));
      const ids = new Set([
        ...(importedModules.get(node.text) ?? []),
        ...at(node).map((o) => o.symbol),
      ]);
      for (const id of ids)
        if (id.endsWith("/__init__:")) {
          if (member) mutatedMembers.add(memberKey(id, member));
          else mutatedModules.add(id);
        }
    } else for (const child of node.namedChildren) mutation(child, member);
  };
  // Exposing a module dictionary permits writes through aliases or dict methods.
  for (const node of root.descendantsOfType("attribute"))
    if (field(node, "attribute")?.text === "__dict__")
      mutation(field(node, "object"));
  const copied = (node: SyntaxNode | null): void => {
    if (!node) return;
    if (node.type === "identifier") mutation(node);
    else if (
      [
        "parenthesized_expression",
        "tuple",
        "list",
        "set",
        "dictionary",
        "pair",
        "expression_list",
        "conditional_expression",
      ].includes(node.type)
    )
      for (const child of node.namedChildren) copied(child);
  };
  for (const node of root.descendantsOfType([
    "assignment",
    "augmented_assignment",
    "delete_statement",
    "for_statement",
    "for_in_clause",
    "as_pattern",
    "named_expression",
    "call",
  ])) {
    if (node.type === "call") {
      if (["setattr", "delattr"].includes(field(node, "function")?.text ?? ""))
        mutation(field(node, "arguments")?.namedChildren[0] ?? null);
    } else {
      // ponytail: copied module objects fail closed instead of tracking alias
      // lifetimes across scopes. Add escape analysis only if coverage needs it.
      if (node.type === "assignment" || node.type === "named_expression") {
        const value = field(node, "right") ?? field(node, "value");
        copied(value);
      }
      const target =
        node.type === "delete_statement"
          ? node
          : node.type === "as_pattern"
            ? field(node, "alias")
            : field(node, "left");
      for (const attr of target
        ? [target, ...target.descendantsOfType(["attribute", "subscript"])]
        : [])
        if (attr.type === "attribute" || attr.type === "subscript")
          mutation(attr);
    }
  }
  if (moduleBindings) {
    moduleBindings.mutatedModules = [...mutatedModules];
    moduleBindings.mutatedMembers = [...mutatedMembers];
  }
  // ponytail: any wildcard in the document disables partial-binding proof.
  // A scope-aware wildcard poison state can narrow this if coverage needs it.
  const hasWildcard = root.descendantsOfType("wildcard_import").length > 0;
  const join = (branches: Bindings[], allowUnbound = false): Bindings => {
    const merged: Bindings = new Map();
    for (const name of new Set(branches.flatMap((b) => [...b.keys()]))) {
      const values = branches.map((b) => b.get(name));
      if (values.every((v) => v === undefined)) {
        merged.set(name, undefined);
        continue;
      }
      const targets: BindingTargets = new Set(
        values.flatMap((v) => [...(v ?? [])]),
      );
      const mayBeUnbound = values.some(
        (v) => v === undefined || v?.mayBeUnbound,
      );
      if (
        values.some((v) => v === null) ||
        (mayBeUnbound &&
          ((!allowUnbound && values.some((v) => v === undefined)) ||
            hasWildcard ||
            name.startsWith("__") ||
            PYTHON_FALLBACK_NAMES.has(name) ||
            targets.size !== 1 ||
            [...targets].some((id) => !id.startsWith("scip-python "))))
      ) {
        merged.set(name, null);
        continue;
      }
      if (mayBeUnbound) targets.mayBeUnbound = true;
      merged.set(name, targets);
    }
    return merged;
  };
  const replace = (env: Bindings, next: Bindings): void => {
    env.clear();
    for (const [name, value] of next) env.set(name, value);
  };
  const kill = (env: Bindings, n: SyntaxNode | null): void => {
    for (const name of names(n)) env.set(name, null);
  };
  interface Scope {
    node: SyntaxNode;
    writes: Writes;
    closure: Bindings;
  }
  const captured = (
    env: Bindings,
    scope: Scope,
    creation: SyntaxNode,
  ): Bindings => {
    const result = new Map(env);
    for (const [name] of result) {
      if (
        mutable.has(name) ||
        clearedExceptionNames.has(name) ||
        [
          ...(scope.writes.get(name) ?? []),
          ...(scope.writes.get("*") ?? []),
        ].some((n) => n.endIndex > creation.startIndex)
      )
        result.set(name, null);
    }
    return result;
  };
  // Import-site keys travel through the existing scope/branch environment.
  // Local SCIP IDs alone cannot identify a module, even within one document.
  const plainImports = new Map<
    string,
    {
      moduleSymbol: string;
      receiverSymbol: string;
    }
  >();
  const walk = (n: SyntaxNode, env: Bindings, scope: Scope): void => {
    if (n.type === "identifier") {
      const targets = mutable.has(n.text) ? null : env.get(n.text);
      if (targets)
        for (const occurrence of at(n)) {
          if (
            !(occurrence.symbolRoles & 1) &&
            [...targets].some(
              (id) =>
                (plainImports.get(id)?.receiverSymbol ?? id) ===
                occurrence.symbol,
            )
          )
            proof.set(pythonOccurrenceKey(occurrence), [n.text]);
        }
      return;
    }
    if (n.type === "attribute" || n.type === "keyword_argument") {
      const value = field(n, n.type === "attribute" ? "object" : "value");
      if (value) walk(value, env, scope);
      const member = field(n, "attribute");
      const targets = value?.type === "identifier" ? env.get(value.text) : null;
      if (
        moduleBindings &&
        member &&
        value &&
        targets?.size === 1 &&
        !mutable.has(value.text) &&
        !mutatedNames.has(memberKey(value.text, "*")) &&
        !mutatedNames.has(memberKey(value.text, member.text))
      ) {
        const binding = [...targets][0];
        const plain = plainImports.get(binding);
        const moduleSymbol = plain?.moduleSymbol ?? binding;
        if (
          moduleSymbol.endsWith("/__init__:") &&
          new Set(at(value).map((o) => o.symbol)).size === 1 &&
          !mutatedModules.has(moduleSymbol) &&
          !mutatedMembers.has(memberKey(moduleSymbol, member.text)) &&
          at(value).some(
            (o) =>
              o.symbol === (plain?.receiverSymbol ?? moduleSymbol) &&
              proof.has(pythonOccurrenceKey(o)),
          )
        ) {
          for (const o of at(member))
            moduleBindings.members.push({
              key: pythonOccurrenceKey(o),
              moduleSymbol,
              name: member.text,
              target: o.symbol,
            });
        }
      }
      return;
    }
    if (n.type === "conditional_expression") {
      const [yes, condition, no] = n.namedChildren;
      if (condition) walk(condition, env, scope);
      const first = new Map(env),
        second = new Map(env);
      if (yes) walk(yes, first, scope);
      if (no) walk(no, second, scope);
      replace(env, join([first, second]));
      return;
    }
    if (n.type === "import_from_statement") {
      const items = imported(n);
      const counts = new Map<string, number>();
      for (const item of items)
        counts.set(boundName(item), (counts.get(boundName(item)) ?? 0) + 1);
      for (const item of items) {
        const ids = new Set(
          [item, ...item.descendantsOfType(["identifier", "dotted_name"])]
            .flatMap(at)
            .filter((o) => o.symbol.startsWith("scip-python "))
            .map((o) => o.symbol),
        );
        env.set(
          boundName(item),
          ids.size === 1 && counts.get(boundName(item)) === 1 ? ids : null,
        );
      }
      // Wildcard imports can replace any existing binding.
      if (n.namedChildren.some((c) => c.type === "wildcard_import"))
        for (const name of env.keys()) env.set(name, null);
      return;
    }
    if (n.type === "import_statement") {
      const items = imported(n);
      for (const item of items) {
        const name = boundName(item);
        env.set(name, null);
        const alias = field(item, "alias");
        const importedName = field(item, "name") ?? item;
        // An unaliased dotted import binds its root, not the leaf module.
        if (
          (!alias && importedName.text.includes(".")) ||
          items.filter((other) => boundName(other) === name).length !== 1
        )
          continue;
        const modules = new Set(at(importedName).map((o) => o.symbol));
        const receivers = new Set(
          at(alias ?? importedName).map((o) => o.symbol),
        );
        if (modules.size !== 1 || receivers.size !== 1) continue;
        const moduleSymbol = [...modules][0],
          receiverSymbol = [...receivers][0];
        if (
          !moduleSymbol.startsWith("scip-python ") ||
          !moduleSymbol.endsWith("/__init__:") ||
          (receiverSymbol !== moduleSymbol &&
            !/^local \d+$/.test(receiverSymbol))
        )
          continue;
        const key = `plain-import:${item.startIndex}`;
        plainImports.set(key, { moduleSymbol, receiverSymbol });
        env.set(name, new Set([key]));
      }
      return;
    }
    if (isScope(n)) {
      const body = field(n, "body");
      if (!body) return;
      const params = field(n, "parameters");
      // Defaults, annotations, and bases execute outside the new scope.
      for (const child of n.namedChildren)
        if (child.id !== body?.id && child.id !== field(n, "name")?.id)
          walk(child, env, scope);
      const base =
        scope.node.type === "class_definition"
          ? scope.closure
          : captured(env, scope, n);
      const local = new Map(base);
      const localWrites = writes(body);
      if (n.type !== "class_definition") {
        for (const name of localWrites.keys()) local.set(name, undefined);
        if (params)
          for (const param of params.namedChildren) {
            const target =
              field(param, "name") ??
              (param.type === "typed_parameter"
                ? param.namedChildren[0]
                : param);
            kill(local, target);
          }
      }
      walk(body, local, { node: n, writes: localWrites, closure: base });
      const name = field(n, "name");
      if (name) env.set(name.text, null);
      return;
    }
    if (isComprehension(n)) {
      const clauses = n.namedChildren.filter((c) => c.type === "for_in_clause");
      const first = clauses[0];
      if (first) {
        const right = field(first, "right");
        if (right) walk(right, env, scope);
      }
      const local =
        scope.node.type === "class_definition"
          ? new Map(scope.closure)
          : n.type === "generator_expression"
            ? captured(env, scope, n)
            : new Map(env);
      for (const clause of clauses) kill(local, field(clause, "left"));
      for (const assignment of n.descendantsOfType("named_expression"))
        kill(local, field(assignment, "name"));
      for (const child of n.namedChildren) {
        if (child.type === "for_in_clause") {
          if (child.id !== first?.id) {
            const right = field(child, "right");
            if (right) walk(right, local, scope);
          }
        } else if (child.type === "if_clause") walk(child, local, scope);
      }
      const body = field(n, "body");
      if (body) walk(body, local, scope);
      for (const assignment of n.descendantsOfType("named_expression"))
        kill(env, field(assignment, "name"));
      return;
    }
    if (n.type === "if_statement") {
      const branches: Bindings[] = [];
      const condition = field(n, "condition");
      if (condition) walk(condition, env, scope);
      const body = field(n, "consequence");
      const branch = new Map(env);
      if (body) walk(body, branch, scope);
      branches.push(branch);
      let exhaustive = false;
      for (const clause of n.namedChildren.filter((c) =>
        ["elif_clause", "else_clause"].includes(c.type),
      )) {
        const alternative = new Map(env);
        const clauseCondition = field(clause, "condition");
        if (clauseCondition) {
          walk(clauseCondition, env, scope);
          replace(alternative, env);
        }
        for (const child of clause.namedChildren)
          if (child.id !== clauseCondition?.id) walk(child, alternative, scope);
        branches.push(alternative);
        exhaustive ||= clause.type === "else_clause";
      }
      if (!exhaustive) branches.push(new Map(env));
      replace(env, join(branches, true));
      return;
    }
    if (
      ["assignment", "augmented_assignment", "named_expression"].includes(
        n.type,
      )
    ) {
      const right = field(n, "right") ?? field(n, "value");
      if (right) walk(right, env, scope);
      kill(env, field(n, "left") ?? field(n, "name"));
      return;
    }
    if (n.type === "delete_statement") {
      kill(env, n);
      return;
    }
    if (n.type === "for_statement" || n.type === "while_statement") {
      const right = field(n, "right") ?? field(n, "condition");
      if (right && n.type === "for_statement") walk(right, env, scope);
      const loop = new Map(env);
      for (const name of writes(n).keys()) loop.set(name, null);
      kill(loop, field(n, "left"));
      if (right && n.type === "while_statement") walk(right, loop, scope);
      for (const child of n.namedChildren)
        if (child.id !== right?.id && child.id !== field(n, "left")?.id)
          walk(child, loop, scope);
      replace(env, join([env, loop]));
      return;
    }
    if (n.type === "with_statement") {
      const body = field(n, "body");
      for (const child of n.namedChildren)
        if (child.id !== body?.id) walk(child, env, scope);
      const completed = new Map(env);
      if (body) walk(body, completed, scope);
      // A context manager can suppress an exception before any body statement.
      const interrupted = new Map(env);
      if (body)
        for (const name of writes(body).keys()) interrupted.set(name, null);
      replace(env, join([interrupted, completed]));
      return;
    }
    if (n.type === "try_statement") {
      const body = field(n, "body");
      const normal = new Map(env);
      if (body) walk(body, normal, scope);
      const interrupted = new Map(env);
      if (body)
        for (const name of writes(body).keys()) interrupted.set(name, null);
      const branches = [interrupted];
      for (const child of n.namedChildren) {
        if (child.type === "except_clause") {
          const handler = new Map(interrupted);
          walk(child, handler, scope);
          // Python clears the exception name on leaving its handler.
          for (const pattern of child.namedChildren.filter(
            (part) => part.type === "as_pattern",
          ))
            kill(handler, field(pattern, "alias"));
          branches.push(handler);
        } else if (child.type === "else_clause") walk(child, normal, scope);
      }
      branches.push(normal);
      replace(env, join(branches));
      for (const child of n.namedChildren)
        if (child.type === "finally_clause") walk(child, env, scope);
      return;
    }
    if (n.type === "as_pattern") {
      for (const child of n.namedChildren)
        if (child.id !== field(n, "alias")?.id) walk(child, env, scope);
      kill(env, field(n, "alias"));
      return;
    }
    if (n.type === "match_statement") {
      // Pattern captures and branch reachability are not import proof.
      for (const pattern of n.descendantsOfType("case_pattern"))
        kill(env, pattern);
      for (const assignment of n.descendantsOfType("named_expression"))
        kill(env, field(assignment, "name"));
      const branches = [new Map(env)];
      const body = field(n, "body");
      for (const child of n.namedChildren)
        if (child.id !== body?.id) walk(child, env, scope);
      for (const clause of body?.namedChildren ?? []) {
        const branch = new Map(env);
        walk(clause, branch, scope);
        branches.push(branch);
      }
      replace(env, join(branches));
      return;
    }
    for (const child of n.namedChildren) walk(child, env, scope);
  };
  const moduleEnv: Bindings = new Map();
  const moduleWrites = writes(root);
  walk(root, moduleEnv, {
    node: root,
    writes: moduleWrites,
    closure: new Map(),
  });
  if (moduleBindings) {
    // Only a single direct from-import surviving module execution is an export.
    // Ambiguous/conditional exports need a stronger cross-module contract.
    for (const statement of root.namedChildren.filter(
      (n) => n.type === "import_from_statement",
    )) {
      for (const item of imported(statement)) {
        const name = boundName(item),
          ids = moduleEnv.get(name);
        if (
          ids?.size === 1 &&
          !ids.mayBeUnbound &&
          moduleWrites.get(name)?.length === 1 &&
          !mutable.has(name)
        )
          moduleBindings.exports.set(name, [...ids][0]);
      }
    }
  }
  return proof;
}

/** Join worker-proven member sites to unique, stable exports without changing provider targets. */
export function resolvePythonModuleBindings(
  documents: readonly ScipDocument[],
  lexical: ReadonlyMap<string, PythonBindingProof>,
  evidence: ReadonlyMap<string, PythonModuleBindings>,
): Map<string, PythonBindingProof> {
  const owners = new Map<string, string | null>();
  for (const document of documents) {
    for (const o of document.occurrences) {
      if (
        !(o.symbolRoles & 1) ||
        !o.symbol.startsWith("scip-python ") ||
        !o.symbol.endsWith("/__init__:")
      )
        continue;
      const previous = owners.get(o.symbol);
      owners.set(
        o.symbol,
        previous === undefined || previous === document.relativePath
          ? document.relativePath
          : null,
      );
    }
  }
  const mutated = new Set(
    [...evidence.values()].flatMap((e) => e.mutatedModules),
  );
  const changedMembers = new Set(
    [...evidence.values()].flatMap((e) => e.mutatedMembers),
  );
  const result = new Map(lexical);
  for (const [path, sites] of evidence) {
    const proof = new Map(lexical.get(path));
    for (const site of sites.members) {
      const owner = owners.get(site.moduleSymbol);
      if (
        owner &&
        !mutated.has(site.moduleSymbol) &&
        !changedMembers.has(JSON.stringify([site.moduleSymbol, site.name])) &&
        evidence.get(owner)?.exports.get(site.name) === site.target
      )
        proof.set(site.key, [site.name]);
    }
    result.set(path, proof);
  }
  return result;
}
