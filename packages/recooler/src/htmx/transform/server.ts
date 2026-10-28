import { unwrap } from "./analysis.js";
import type { Analysis, Node, Reference, Variable } from "./analysis.js";
import { SpanIndex } from "./spans.js";
import type { Candidate } from "./types.js";

/** Conservative: preserve evaluation whenever it could run user code. */
function pure(node: Node | null | undefined): boolean {
  if (!node) return true;
  node = unwrap(node);
  if (["Literal", "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)) return true;
  if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
    return !node.decorators.length && !node.superClass && node.body.body.every(member =>
      member.type !== "StaticBlock" && !("decorators" in member && member.decorators.length)
      && !("computed" in member && member.computed)
      && !("static" in member && member.static && "value" in member && !pure(member.value)));
  }
  return false;
}

/** Action bodies and possibly effectful declarations are server roots, even
 * when the containing component is reachable exclusively from a handler. */
export function handlerOnlyDeclarations(analysis: Analysis, candidates: Candidate[]): Set<Node> {
  const owners = new SpanIndex(candidates);
  const nodes: { node: Node; exported: boolean; variables: Variable[]; start: number; end: number }[] = [];
  for (const item of analysis.program.body) {
    const declaration = item.type === "ExportNamedDeclaration" || item.type === "ExportDefaultDeclaration" ? item.declaration : item;
    if (!declaration) continue;
    const parts = declaration.type === "VariableDeclaration" ? declaration.declarations
      : declaration.type === "ImportDeclaration" ? declaration.specifiers
      : ["FunctionDeclaration", "ClassDeclaration", "TSEnumDeclaration", "TSModuleDeclaration", "TSImportEqualsDeclaration"].includes(declaration.type) ? [declaration] : [];
    for (const node of parts) nodes.push({ node, start: node.start, end: node.end,
      exported: item.type === "ExportNamedDeclaration" || item.type === "ExportDefaultDeclaration",
      variables: analysis.moduleVariables(node),
    });
  }
  const declarations = new SpanIndex(nodes);
  const bindings = new Map<Variable, typeof nodes>();
  for (const node of nodes) for (const variable of node.variables) {
    const entries = bindings.get(variable) ?? [];
    entries.push(node); bindings.set(variable, entries);
  }
  const dependencies = new Map(nodes.map(n => [n, new Set<typeof n>()]));
  const clientRoots = new Set<typeof nodes[number]>(), serverRoots = new Set<typeof nodes[number]>();
  for (const node of nodes) {
    const n = node.node;
    const removable = n.type.startsWith("Import") || (n.type === "VariableDeclarator" ? n.id.type === "Identifier" && pure(n.init) : pure(n));
    if (node.exported || !removable) serverRoots.add(node);
  }
  for (const ref of analysis.refs(analysis.program)) {
    if (!ref.resolved || (ref.init && ref.isWriteOnly())) continue;
    const span = { start: ref.identifier.range[0], end: ref.identifier.range[1] };
    const owner = owners.owner(span);
    const declaration = declarations.owner(span);
    for (const target of bindings.get(ref.resolved) ?? []) {
      if (owner?.kind === "action") serverRoots.add(target);
      else if (owner?.kind === "handler") clientRoots.add(target);
      else if (declaration) dependencies.get(declaration)!.add(target);
      else serverRoots.add(target);
    }
  }
  const closure = (roots: Set<typeof nodes[number]>) => {
    const queue = [...roots];
    for (let i = 0; i < queue.length; i++) for (const dep of dependencies.get(queue[i]!)!) {
      if (!roots.has(dep)) { roots.add(dep); queue.push(dep); }
    }
    return roots;
  };
  const server = closure(serverRoots);
  return new Set([...closure(clientRoots)].filter(n => !server.has(n)).map(n => n.node));
}
