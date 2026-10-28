import { parseSync, rawTransferSupported, visitorKeys } from "oxc-parser";
import type { Node, ParserOptions, Program } from "oxc-parser";
import { lowerBound } from "./spans.js";
import { analyze } from "@typescript-eslint/scope-manager";
import type { Reference, ScopeManager, Variable } from "@typescript-eslint/scope-manager";

export type { Node, Program, Reference, Variable };
export type Span = { start: number; end: number };

export function contains(outer: Span, inner: Span): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}

// oxc and typescript-eslint describe the same TS-ESTree shape with distinct TS
// types. Keep the assertion at this boundary, rather than copying the AST.
export function parseAndAnalyze(code: string, id: string, rawTransfer = true): Analysis {
  const options: ParserOptions & { experimentalRawTransfer: boolean } = {
    sourceType: "module", astType: "ts", range: true,
    experimentalRawTransfer: rawTransfer && rawTransferSupported(),
  };
  const parsed = parseSync(id.split("?")[0]!, code, options);
  if (parsed.errors.length) {
    throw new ParseError(parsed.errors.map(e => ({
      message: `${id}: ${e.message}`, start: e.labels[0]?.start ?? 0, end: e.labels[0]?.end ?? 0,
    })));
  }
  const program = parsed.program;
  const scopes = analyze(program as unknown as Parameters<typeof analyze>[0], {
    sourceType: "module", lib: [], jsxPragma: null, childVisitorKeys: visitorKeys,
  });
  return new Analysis(program, scopes);
}

export function children(node: Node): Node[] {
  const result: Node[] = [];
  const record = node as unknown as Record<string, unknown>;
  for (const key of visitorKeys[node.type] ?? []) {
    const value = record[key];
    if (Array.isArray(value)) result.push(...value.filter(isNode));
    else if (isNode(value)) result.push(value);
  }
  return result;
}

function isNode(value: unknown): value is Node {
  return !!value && typeof value === "object" && "type" in value;
}

export function walk(node: Node, visit: (node: Node) => boolean | void): void {
  if (visit(node) === false) return;
  for (const child of children(node)) walk(child, visit);
}

export function unwrap(node: Node): Node {
  switch (node.type) {
    case "ParenthesizedExpression": case "TSAsExpression":
    case "TSSatisfiesExpression": case "TSNonNullExpression": case "TSTypeAssertion":
      return unwrap(node.expression);
    default: return node;
  }
}

/** scope-manager intentionally treats type-only imports as both namespaces;
 * emission still needs the importKind/declare flags to decide runtime presence. */
export function isRuntimeVariable(variable: Variable): boolean {
  return variable.isValueVariable && variable.defs.some(def => {
    if (!def.isVariableDefinition || ("declare" in def.node && def.node.declare)) return false;
    if (def.type === "ImportBinding") {
      if (def.parent.type === "ImportDeclaration" && def.parent.importKind === "type") return false;
      if (def.node.type === "ImportSpecifier" && def.node.importKind === "type") return false;
    }
    return true;
  });
}

export class ParseError extends SyntaxError {
  constructor(readonly diagnostics: { message: string; start: number; end: number }[]) {
    super(diagnostics.map(d => d.message).join("\n"));
  }
}

export class Analysis {
  readonly references: Reference[];
  private readonly valueReferences: Reference[];
  private readonly valueSet: Set<Reference>;
  private readonly moduleBindings: { start: number; end: number; variable: Variable }[];
  readonly parents = new Map<Node, Node>();
  readonly variables: Variable[];
  readonly referenceAt = new Map<number, Reference>();
  constructor(readonly program: Program, readonly scopes: ScopeManager) {
    this.references = scopes.scopes.flatMap(scope => scope.references)
      .sort((a, b) => a.identifier.range[0] - b.identifier.range[0]);
    this.variables = scopes.scopes.flatMap(scope => scope.variables);
    for (const ref of this.references) this.referenceAt.set(ref.identifier.range[0], ref);
    const typeNodes = new Set<Node>();
    walk(program, node => {
      for (const child of children(node)) {
        this.parents.set(child, node);
        // TS expression wrappers have runtime expressions; their annotations do not.
        if (typeNodes.has(node) || (node.type.startsWith("TS")
          && !["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion",
            "TSInstantiationExpression", "TSEnumDeclaration", "TSEnumBody", "TSEnumMember",
            "TSModuleDeclaration", "TSModuleBlock", "TSImportEqualsDeclaration", "TSExportAssignment",
            "TSParameterProperty"].includes(node.type))) typeNodes.add(child);
      }
    });
    this.valueReferences = this.references.filter(ref => ref.isValueReference && !typeNodes.has(ref.identifier as unknown as Node));
    this.valueSet = new Set(this.valueReferences);
    this.moduleBindings = this.variables.filter(v => v.scope.type === "module").flatMap(variable =>
      variable.identifiers.map(id => ({ start: id.range[0], end: id.range[1], variable })))
      .sort((a, b) => a.start - b.start);

  }

  refs(node: Span): Reference[] {
    const start = lowerBound(this.valueReferences, node.start, ref => ref.identifier.range[0]);
    const end = lowerBound(this.valueReferences, node.end, ref => ref.identifier.range[0]);
    return this.valueReferences.slice(start, end).filter(ref => this.inside(node, ref));
  }

  isValueReference(ref: Reference): boolean { return this.valueSet.has(ref); }

  moduleVariables(node: Span): Variable[] {
    const start = lowerBound(this.moduleBindings, node.start, binding => binding.start);
    const end = lowerBound(this.moduleBindings, node.end, binding => binding.start);
    return [...new Set(this.moduleBindings.slice(start, end).filter(b => contains(node, b)).map(b => b.variable))];
  }

  inside(node: Span, ref: Reference): boolean {
    return contains(node, { start: ref.identifier.range[0], end: ref.identifier.range[1] });
  }

  captures(node: Span): Variable[] {
    const result = new Set<Variable>();
    for (const ref of this.refs(node)) {
      const variable = ref.resolved;
      if (!variable || ["module", "global"].includes(variable.scope.type)) continue;
      if (variable.defs.some(def => contains(node, {
        start: def.name.range[0], end: def.name.range[1],
      }))) continue;
      // `arguments` is an implicit function binding, not a serializable value.
      if (!variable.defs.length) continue;
      result.add(variable);
    }
    return [...result].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  }

  kind(variable: Variable): "value" | "function" | "class" {
    for (const def of variable.defs) {
      if (def.type === "FunctionName") return "function";
      if (def.type === "ClassName") return "class";
      if (def.type === "Variable" && def.node.init) {
        const init = unwrap(def.node.init as unknown as Node);
        if (["FunctionExpression", "ArrowFunctionExpression"].includes(init.type)) return "function";
        if (init.type === "ClassExpression") return "class";
      }
    }
    return "value";
  }
}
