/**
 * Type shim for tree-sitter npm alias.
 *
 * The published package is aliased in package.json:
 *   "tree-sitter": "npm:@keqingmoe/tree-sitter@0.26.2"
 *
 * The fork's .d.ts declares `module "@keqingmoe/tree-sitter"`, so
 * TypeScript cannot resolve `import ... from "tree-sitter"` without
 * this ambient re-declaration.
 */
declare module "tree-sitter" {
  class Parser {
    parse(
      input: string | Parser.Input,
      oldTree?: Parser.Tree | null,
      options?: Parser.Options,
    ): Parser.Tree;
    getIncludedRanges(): Parser.Range[];
    getTimeoutMicros(): number;
    setTimeoutMicros(timeout: number): void;
    setLanguage(language: Parser.Language | null | undefined): void;
    getLanguage(): Parser.Language;
    setLogger(callback: Parser.Logger | null | false): void;
    getLogger(): Parser.Logger;
  }

  namespace Parser {
    type Options = {
      bufferSize?: number;
      includedRanges?: Range[];
    };

    type Point = {
      row: number;
      column: number;
    };

    type Range = {
      startIndex: number;
      endIndex: number;
      startPosition: Point;
      endPosition: Point;
    };

    type Edit = {
      startIndex: number;
      oldEndIndex: number;
      newEndIndex: number;
      startPosition: Point;
      oldEndPosition: Point;
      newEndPosition: Point;
    };

    type Logger = (
      message: string,
      params: { [param: string]: string },
      type: "parse" | "lex",
    ) => void;

    type Input = (
      index: number,
      position?: Point,
    ) => string | null;

    interface SyntaxNode {
      id: number;
      tree: Tree;
      type: string;
      text: string;
      startPosition: Point;
      endPosition: Point;
      startIndex: number;
      endIndex: number;
      parent: SyntaxNode | null;
      children: SyntaxNode[];
      namedChildren: SyntaxNode[];
      childCount: number;
      namedChildCount: number;
      firstChild: SyntaxNode | null;
      firstNamedChild: SyntaxNode | null;
      lastChild: SyntaxNode | null;
      lastNamedChild: SyntaxNode | null;
      nextSibling: SyntaxNode | null;
      nextNamedSibling: SyntaxNode | null;
      previousSibling: SyntaxNode | null;
      previousNamedSibling: SyntaxNode | null;
      hasChanges: boolean;
      hasError: boolean;
      isMissing: boolean;
      isNamed: boolean;
      isExtra: boolean;
      toString(): string;
      child(index: number): SyntaxNode | null;
      namedChild(index: number): SyntaxNode | null;
      childForFieldName(fieldName: string): SyntaxNode | null;
      childrenForFieldName(fieldName: string): SyntaxNode[];
      firstChildForIndex(index: number): SyntaxNode | null;
      descendantForIndex(startIndex: number, endIndex?: number): SyntaxNode;
      descendantForPosition(startPosition: Point, endPosition?: Point): SyntaxNode;
      descendantsOfType(type: string | string[], startPosition?: Point, endPosition?: Point): SyntaxNode[];
      namedDescendantForIndex(startIndex: number, endIndex?: number): SyntaxNode;
      namedDescendantForPosition(startPosition: Point, endPosition?: Point): SyntaxNode;
      closest(type: string | string[]): SyntaxNode | null;
      walk(): TreeCursor;
      equals(other: SyntaxNode): boolean;
    }

    interface TreeCursor {
      nodeType: string;
      nodeTypeId: number;
      nodeText: string;
      nodeId: number;
      nodeIsNamed: boolean;
      nodeIsMissing: boolean;
      startPosition: Point;
      endPosition: Point;
      startIndex: number;
      endIndex: number;
      currentNode: SyntaxNode;
      currentFieldName: string | null;
      currentFieldId: number;
      currentDepth: number;
      currentDescendantIndex: number;
      reset(node: SyntaxNode): void;
      resetTo(cursor: TreeCursor): void;
      gotoParent(): boolean;
      gotoFirstChild(): boolean;
      gotoLastChild(): boolean;
      gotoFirstChildForIndex(index: number): boolean;
      gotoFirstChildForPosition(position: Point): boolean;
      gotoNextSibling(): boolean;
      gotoPreviousSibling(): boolean;
      gotoDescendant(goalDescendantIndex: number): void;
    }

    interface Tree {
      rootNode: SyntaxNode;
      rootNodeWithOffset(offsetBytes: number, offsetExtent: Point): SyntaxNode;
      language: Language;
      copy(): Tree;
      delete(): void;
      edit(edit: Edit): Tree;
      walk(): TreeCursor;
      getText(node: SyntaxNode): string;
      getChangedRanges(other: Tree): Range[];
      getIncludedRanges(): Range[];
      getEditedRange(): Range;
      printDotGraph(fd?: number): void;
    }

    interface QueryCapture {
      name: string;
      node: SyntaxNode;
    }

    interface QueryMatch {
      pattern: number;
      captures: QueryCapture[];
    }

    type QueryOptions = {
      startPosition?: Point;
      endPosition?: Point;
      startIndex?: number;
      endIndex?: number;
      matchLimit?: number;
      maxStartDepth?: number;
      timeoutMicros?: number;
    };

    class Query {
      readonly matchLimit: number;
      constructor(language: Language, source: string | Buffer);
      captures(node: SyntaxNode, options?: QueryOptions): QueryCapture[];
      matches(node: SyntaxNode, options?: QueryOptions): QueryMatch[];
      disableCapture(captureName: string): void;
      disablePattern(patternIndex: number): void;
      isPatternGuaranteedAtStep(byteOffset: number): boolean;
      isPatternRooted(patternIndex: number): boolean;
      isPatternNonLocal(patternIndex: number): boolean;
      startIndexForPattern(patternIndex: number): number;
      endIndexForPattern(patternIndex: number): number;
      didExceedMatchLimit(): boolean;
    }

    interface Language {
      language: unknown;
      nodeTypeInfo: NodeInfo[];
    }

    type BaseNode = {
      type: string;
      named: boolean;
    };

    type ChildNode = {
      multiple: boolean;
      required: boolean;
      types: BaseNode[];
    };

    type NodeInfo =
      | (BaseNode & { subtypes: BaseNode[] })
      | (BaseNode & { fields: { [name: string]: ChildNode }; children: ChildNode[] });

    class LookaheadIterator {
      readonly currentTypeId: number;
      readonly currentType: string;
      constructor(language: Language, state: number);
      reset(language: Language, stateId: number): boolean;
      resetState(stateId: number): boolean;
      [Symbol.iterator](): Iterator<string>;
    }
  }

  export = Parser;
}
