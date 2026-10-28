import { contains } from "./analysis.js";
import type { Analysis, Node, Reference, Variable } from "./analysis.js";
import type { Candidate } from "./types.js";

/** Private declarations reachable exclusively from handlers are client code too.
 * Removing that closure prevents a handler-only helper's browser import from
 * being evaluated on the server. Exports and ordinary module side effects are
 * server roots. Unrelated declarations are left alone.
 */
export function handlerOnlyDeclarations(analysis: Analysis, candidates: Candidate[]): Set<Node> {
  const handlers = candidates.filter(c => c.kind === "handler");
  const inHandler = (ref: Reference) => handlers.some(h => contains(h, {
    start: ref.identifier.range[0], end: ref.identifier.range[1],
  }));
  const nodes: { node: Node; exported: boolean; variables: Variable[] }[] = [];
  for (const item of analysis.program.body) {
    const declaration = item.type === "ExportNamedDeclaration" || item.type === "ExportDefaultDeclaration" ? item.declaration : item;
    if (!declaration) continue;
    const parts = declaration.type === "VariableDeclaration" ? declaration.declarations
      : declaration.type === "ImportDeclaration" ? declaration.specifiers
      : ["FunctionDeclaration", "ClassDeclaration", "TSEnumDeclaration", "TSModuleDeclaration", "TSImportEqualsDeclaration"].includes(declaration.type) ? [declaration] : [];
    for (const node of parts) nodes.push({
      node, exported: item.type === "ExportNamedDeclaration" || item.type === "ExportDefaultDeclaration",
      variables: analysis.variables.filter(v => v.scope.type === "module" && v.identifiers.some(id => contains(node, { start: id.range[0], end: id.range[1] }))),
    });
  }
  const bindings = new Map<Variable, number[]>();
  nodes.forEach((node, i) => node.variables.forEach(v => bindings.set(v, [...bindings.get(v) ?? [], i])));
  const client = new Set<number>();
  const queue: number[] = [];
  const reach = (ref: Reference) => {
    if (!ref.resolved) return;
    for (const index of bindings.get(ref.resolved) ?? []) if (!client.has(index)) { client.add(index); queue.push(index); }
  };
  analysis.references.filter(ref => ref.isValueReference && inHandler(ref)).forEach(reach);
  for (let i = 0; i < queue.length; i++) analysis.refs(nodes[queue[i]!]!.node).forEach(reach);
  // Peel server roots and then their dependencies out of the client closure.
  let changed: boolean;
  do {
    changed = false;
    for (const index of client) {
      const node = nodes[index]!;
      const serverUsed = node.exported || node.variables.some(v => v.references.some(ref => {
        if (!ref.isValueReference || inHandler(ref)) return false;
        if (ref.init && ref.isWriteOnly()) return false;
        return ![...client].some(i => analysis.inside(nodes[i]!.node, ref));
      }));
      if (serverUsed) { client.delete(index); changed = true; }
    }
  } while (changed);
  return new Set([...client].map(i => nodes[i]!.node));
}
