import { isRuntimeVariable, walk } from "./analysis.js";
import type { Analysis, Node, Span, Variable } from "./analysis.js";
import { SpanIndex } from "./spans.js";
import { onLoadExports } from "./onload.js";
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
  const owners = new SpanIndex(candidates);
  const expressions = new Set(candidates.map(c => c.expression));
  const actionsAt = new Map<Node, Candidate[]>();
  const bindings = new Map<Variable, number[]>();
  const roots: Root[] = [];
  const kept = new Set<Node>();
  const exports = onLoadExports(analysis);
  const onLoadItems = new Set<Node>();
  const onLoadSpecifiers = new Set<Node>();
  const refs = (node: Node): Variable[] => {
    const owner = owners.owner(node);
    return [...new Set(analysis.refs(node).filter(r => {
      const inner = owners.owner({ start: r.identifier.range[0], end: r.identifier.range[1] });
      return inner === owner;
    }).map(r => r.resolved).filter((v): v is Variable => !!v))];
  };
  const dynamic = (node: Node) => dynamicImports(analysis, node, n => expressions.has(n) && n !== node);
  const add = (item: Node, node: Node, source?: string): number => {
    const index = nodes.length;
    const nodeRefs = refs(node);
    // The original bodies are moved away. Only scope/context expressions remain
    // at their sites and may keep a module binding alive.
    const contained = owners.within(node);
    actionsAt.set(node, contained.filter(c => c.kind === "action" && !c.parent));
    for (const c of contained.filter(c => !c.parent)) {
      nodeRefs.push(...c.variables);
      if (c.explicitContext) nodeRefs.push(...analysis.refs(c.explicitContext).flatMap(r => r.resolved ? [r.resolved] : []));
    }
    nodes.push({ item, node, refs: nodeRefs, dynamic: dynamic(node), source });
    for (const v of analysis.moduleVariables(node)) {
      const entries = bindings.get(v) ?? [];
      entries.push(index); bindings.set(v, entries);
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
    if (item.type === "ExportAllDeclaration" && exports.has(item)) {
      onLoad(item, { nodes: [add(item, item, item.source.value)] });
      if (options.moduleKind === "route") onLoadItems.add(item);
      continue;
    }
    if (item.type === "ImportDeclaration") {
      if (item.importKind !== "type") for (const spec of item.specifiers) {
        if (spec.type !== "ImportSpecifier" || spec.importKind !== "type") add(item, spec, item.source.value);
      }
      continue;
    }
    if (item.type === "ExportNamedDeclaration" && item.exportKind !== "type") {
      for (const spec of item.specifiers) {
        if (spec.type !== "ExportSpecifier" || spec.exportKind !== "type") {
          if (exports.has(spec)) {
            if (item.source) onLoad(spec, { nodes: [add(item, spec, item.source.value)] });
            else if (spec.type === "ExportSpecifier") {
              const variables = analysis.refs(spec).flatMap(r => r.resolved && isRuntimeVariable(r.resolved) ? [r.resolved] : []);
              if (!variables.length) continue;
              onLoad(spec, { refs: variables });
            }
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
        if (exports.has(part)) {
          onLoad(part, { nodes: [index] });
          if (options.moduleKind === "route") onLoadItems.add(item);
        }
      }
    } else if (["FunctionDeclaration", "ClassDeclaration", "TSEnumDeclaration", "TSModuleDeclaration", "TSImportEqualsDeclaration"].includes(decl.type)) {
      if (decl.type === "TSImportEqualsDeclaration" && decl.importKind === "type") continue;
      const index = add(item, decl, decl.type === "TSImportEqualsDeclaration" && decl.moduleReference.type === "TSExternalModuleReference"
        ? decl.moduleReference.expression.value as string : undefined);
      if (exports.has(decl)) {
        onLoad(decl, { nodes: [index] });
        if (options.moduleKind === "route") onLoadItems.add(item);
      }
    }
  }
  for (const root of roots) {
    interface Path { name: string; parent?: Path }
    const rootPath: Path = { name: root.name };
    const formatPath = (path: Path): string => {
      const names: string[] = [];
      for (let p: Path | undefined = path; p; p = p.parent) names.push(p.name);
      return names.reverse().join(" → ");
    };
    const paths = new Map<number, Path>();
    const queue: number[] = [];
    const reach = (index: number, path: Path) => {
      if (paths.has(index)) return;
      paths.set(index, path); queue.push(index); kept.add(nodes[index]!.node);
    };
    const reachRefs = (variables: Variable[], path: Path) => {
      for (const variable of variables) for (const index of bindings.get(variable) ?? []) reach(index, { name: variable.name, parent: path });
    };
    root.nodes.forEach(index => reach(index, rootPath));
    reachRefs(root.refs, rootPath);
    for (let i = 0; i < queue.length; i++) {
      const index = queue[i]!;
      reachRefs(nodes[index]!.refs, paths.get(index)!);
    }
    const reported = new Set<string>();
    const report = (source: string, path: Path) => {
      if (!patternsMatch(options.clientBannedImports ?? [], source) || reported.has(source)) return;
      reported.add(source);
      diagnostics.push({ severity: "error", code: "banned-client-import", start: root.span.start, end: root.span.end,
        message: `${root.description} imports banned module ${JSON.stringify(source)} via ${formatPath(path)}` });
    };
    root.dynamic.forEach(source => report(source, rootPath));
    // Source order decides ties, as in the reference; BFS determines shortest paths.
    for (const index of [...paths.keys()].sort((a, b) => a - b)) {
      const node = nodes[index]!;
      const path = paths.get(index)!;
      for (const action of actionsAt.get(node.node) ?? []) diagnostics.push({
        severity: "error", code: "action-in-client-slice", start: action.start, end: action.end,
        message: `${root.description} reaches form action ${action.id} (${action.exportName}) via ${formatPath(path)}; action URLs require server request context and signing`,
      });
      node.dynamic.forEach(source => report(source, path));
      if (node.source) report(node.source, path);
    }
  }
  return { kept, onLoadItems, onLoadSpecifiers };
}

export function warnOnLoad(analysis: Analysis, options: TransformOptions, diagnostics: Diagnostic[]): void {
  if (options.moduleKind !== "root" && options.moduleKind !== "layout") return;
  const exports = onLoadExports(analysis);
  for (const item of analysis.program.body) {
    const decl = item.type === "ExportNamedDeclaration" ? item.declaration : undefined;
    if (exports.has(item) || (item.type === "ExportNamedDeclaration" && item.specifiers.some(s => exports.has(s)))
      || (decl && (exports.has(decl) || (decl.type === "VariableDeclaration" && decl.declarations.some(d => exports.has(d)))))) {
      diagnostics.push({ severity: "warning", code: "ignored-onload", start: item.start, end: item.end,
        message: `${options.relativePath}: onLoad exported by a ${options.moduleKind} never runs; export it from a route module instead` });
    }
  }
}
