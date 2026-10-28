import { contains, walk } from "./analysis.js";
import type { Analysis, Node, Span, Variable } from "./analysis.js";
import { attrName, ownerAt } from "./collect.js";
import type { Candidate, Diagnostic, TransformOptions } from "./types.js";

export interface SliceNode {
  item: Node;
  node: Node;
  refs: Variable[];
  dynamic: string[];
  source?: string;
}
interface Root { name: string; description: string; nodes: number[]; refs: Variable[]; dynamic: string[]; span: Span }
export interface Slice {
  kept: Set<Node>;
  onLoadItems: Set<Node>;
  onLoadSpecifiers: Set<Node>;
}

export function patternsMatch(patterns: readonly (RegExp | string)[], value: string): boolean {
  return patterns.some(pattern => {
    const regex = typeof pattern === "string" ? new RegExp(pattern) : pattern;
    // Don't allow caller-owned /g or /y expressions to introduce order dependence.
    return new RegExp(regex.source, regex.flags.replace(/[gy]/g, "")).test(value);
  });
}

export function dynamicImports(analysis: Analysis, node: Node, skip: (n: Node) => boolean): string[] {
  const result = new Set<string>();
  walk(node, n => {
    if (n !== node && skip(n)) return false;
    let arg: Node | undefined;
    if (n.type === "ImportExpression") arg = n.source;
    if (n.type === "CallExpression" && n.callee.type === "Identifier" && n.callee.name === "require"
      && !analysis.referenceAt.get(n.callee.start)?.resolved) arg = n.arguments[0];
    if (arg?.type === "Literal" && typeof arg.value === "string") result.add(arg.value);
    if (arg?.type === "TemplateLiteral" && arg.expressions.length === 0) {
      const value = arg.quasis[0]?.value.cooked;
      if (value != null) result.add(value);
    }
  });
  return [...result];
}

export function sliceModule(analysis: Analysis, candidates: Candidate[], options: TransformOptions, diagnostics: Diagnostic[]): Slice {
  const nodes: SliceNode[] = [];
  const bindings = new Map<Variable, number[]>();
  const roots: Root[] = [];
  const kept = new Set<Node>();
  const onLoadItems = new Set<Node>();
  const onLoadSpecifiers = new Set<Node>();
  const refs = (node: Node): Variable[] => {
    const owner = ownerAt(candidates, node);
    return [...new Set(analysis.refs(node).filter(r => {
      const inner = ownerAt(candidates, { start: r.identifier.range[0], end: r.identifier.range[1] });
      return inner === owner;
    }).map(r => r.resolved).filter((v): v is Variable => !!v))];
  };
  const dynamic = (node: Node) => dynamicImports(analysis, node, n => candidates.some(c => c.expression === n && c.expression !== node));
  const add = (item: Node, node: Node, source?: string): number => {
    const index = nodes.length;
    const nodeRefs = refs(node);
    // The original bodies are moved away. Only scope/context expressions remain
    // at their sites and may keep a module binding alive.
    for (const c of candidates.filter(c => contains(node, c.expression) && !c.parent)) {
      nodeRefs.push(...c.variables);
      if (c.explicitContext) nodeRefs.push(...analysis.refs(c.explicitContext).flatMap(r => r.resolved ? [r.resolved] : []));
    }
    nodes.push({ item, node, refs: nodeRefs, dynamic: dynamic(node), source });
    for (const v of analysis.variables) {
      if (v.scope.type === "module" && v.identifiers.some(id => contains(node, { start: id.range[0], end: id.range[1] }))) {
        const entries = bindings.get(v) ?? [];
        entries.push(index); bindings.set(v, entries);
      }
    }
    return index;
  };
  const onLoad = (span: Span, seed: Partial<Pick<Root, "nodes" | "refs" | "dynamic">>) => {
    if (options.moduleKind !== "route") return;
    roots.push({ name: "onLoad", description: `onLoad of ${options.relativePath}`, nodes: [], refs: [], dynamic: [], span, ...seed });
  };
  for (const c of candidates.filter(c => c.kind === "handler")) roots.push({
    name: c.exportName, description: `event handler ${c.id}`, nodes: [], refs: refs(c.expression), dynamic: dynamic(c.expression), span: c,
  });
  for (const item of analysis.program.body) {
    if (item.type === "ImportDeclaration") {
      if (item.importKind !== "type") for (const spec of item.specifiers) {
        if (spec.type !== "ImportSpecifier" || spec.importKind !== "type") add(item, spec, item.source.value);
      }
      continue;
    }
    if (item.type === "ExportNamedDeclaration" && item.exportKind !== "type") {
      for (const spec of item.specifiers) {
        if (spec.type !== "ExportSpecifier" || spec.exportKind !== "type") {
          if (attrName(spec.exported) === "onLoad") {
            if (item.source) onLoad(spec, { nodes: [add(item, spec, item.source.value)] });
            else if (spec.type === "ExportSpecifier") onLoad(spec, { refs: analysis.refs(spec).flatMap(r => r.resolved ? [r.resolved] : []) });
            if (options.moduleKind === "route") onLoadSpecifiers.add(spec);
          }
        }
      }
    }
    const decl = item.type === "ExportNamedDeclaration" || item.type === "ExportDefaultDeclaration" ? item.declaration : item;
    if (!decl || ("declare" in decl && decl.declare)) continue;
    if (decl.type === "VariableDeclaration") {
      if (decl.kind === "using" || decl.kind === "await using") continue;
      for (const part of decl.declarations) {
        const index = add(item, part);
        if (item.type === "ExportNamedDeclaration" && part.id.type === "Identifier" && part.id.name === "onLoad") {
          onLoad(part, { nodes: [index] });
          if (options.moduleKind === "route") onLoadItems.add(item);
        }
      }
    } else if (["FunctionDeclaration", "ClassDeclaration", "TSEnumDeclaration", "TSModuleDeclaration", "TSImportEqualsDeclaration"].includes(decl.type)) {
      if (decl.type === "TSImportEqualsDeclaration" && decl.importKind === "type") continue;
      const index = add(item, decl, decl.type === "TSImportEqualsDeclaration" && decl.moduleReference.type === "TSExternalModuleReference"
        ? decl.moduleReference.expression.value as string : undefined);
      if (item.type === "ExportNamedDeclaration" && decl.type === "FunctionDeclaration" && decl.id?.name === "onLoad") {
        onLoad(decl, { nodes: [index] });
        if (options.moduleKind === "route") onLoadItems.add(item);
      }
    }
  }
  for (const root of roots) {
    const paths = new Map<number, string[]>();
    const queue: number[] = [];
    const reach = (index: number, path: string[]) => {
      if (paths.has(index)) return;
      paths.set(index, path); queue.push(index); kept.add(nodes[index]!.node);
    };
    const reachRefs = (variables: Variable[], path: string[]) => {
      for (const variable of variables) for (const index of bindings.get(variable) ?? []) reach(index, [...path, variable.name]);
    };
    root.nodes.forEach(index => reach(index, [root.name]));
    reachRefs(root.refs, [root.name]);
    for (let i = 0; i < queue.length; i++) {
      const index = queue[i]!;
      reachRefs(nodes[index]!.refs, paths.get(index)!);
    }
    const reported = new Set<string>();
    const report = (source: string, path: string[]) => {
      if (!patternsMatch(options.clientBannedImports ?? [], source) || reported.has(source)) return;
      reported.add(source);
      diagnostics.push({ severity: "error", code: "banned-client-import", start: root.span.start, end: root.span.end,
        message: `${root.description} imports banned module ${JSON.stringify(source)} via ${path.join(" → ")}` });
    };
    root.dynamic.forEach(source => report(source, [root.name]));
    // Source order decides ties, as in the reference; BFS determines shortest paths.
    nodes.forEach((node, index) => {
      const path = paths.get(index);
      if (!path) return;
      node.dynamic.forEach(source => report(source, path));
      if (node.source) report(node.source, path);
    });
  }
  return { kept, onLoadItems, onLoadSpecifiers };
}

export function warnOnLoad(analysis: Analysis, options: TransformOptions, diagnostics: Diagnostic[]): void {
  if (options.moduleKind !== "root" && options.moduleKind !== "layout") return;
  for (const item of analysis.program.body) {
    if (item.type !== "ExportNamedDeclaration" || item.exportKind === "type") continue;
    const d = item.declaration;
    const exported = (d?.type === "FunctionDeclaration" && !d.declare && d.id?.name === "onLoad")
      || (d?.type === "VariableDeclaration" && !d.declare && d.declarations.some(p => p.id.type === "Identifier" && p.id.name === "onLoad"))
      || item.specifiers.some(s => attrName(s.exported) === "onLoad" && !(s.type === "ExportSpecifier" && s.exportKind === "type"));
    if (exported) diagnostics.push({ severity: "warning", code: "ignored-onload", start: item.start, end: item.end,
      message: `${options.relativePath}: onLoad exported by a ${options.moduleKind} never runs; export it from a route module instead` });
  }
}
