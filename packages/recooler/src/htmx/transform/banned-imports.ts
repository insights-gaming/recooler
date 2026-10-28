import { patternsMatch } from "./slice.js";

/** Resolved client graph check for the bundler adapter. Queries are ignored;
 * patterns also see the package path after the last node_modules segment. */
export function moduleIdForms(id: string): string[] {
  const path = id.split("?")[0]!;
  const matches = [...path.matchAll(/(?:^|[/\\])node_modules(?=[/\\])/g)];
  const last = matches.at(-1);
  return last ? [path, path.slice(last.index! + last[0].length + 1)] : [path];
}

export function isBannedModule(patterns: readonly (RegExp | string)[], id: string): boolean {
  return moduleIdForms(id).some(form => patternsMatch(patterns, form));
}

/** Adjacency lists must be in import order. Reports shortest paths, including
 * disconnected banned modules, without depending on Farm/Rolldown graph types. */
export function bannedClientModules(
  graph: ReadonlyMap<string, readonly string[]>, entry: string, banned: (id: string) => boolean,
): string[] {
  const ids = new Set([...graph.keys(), ...[...graph.values()].flat()]);
  const importers = new Map<string, string>();
  const queue = [entry];
  for (let i = 0; i < queue.length; i++) for (const dep of graph.get(queue[i]!) ?? []) {
    if (dep === entry || importers.has(dep)) continue;
    importers.set(dep, queue[i]!); queue.push(dep);
  }
  return [...ids].filter(id => id !== entry && banned(id)).sort().map(id => {
    const chain: string[] = [];
    let current = importers.get(id);
    while (current && current !== entry) {
      chain.push(moduleIdForms(current)[0]!); current = importers.get(current);
    }
    const path = moduleIdForms(id)[0]!;
    return chain.length ? `${path} via ${chain.reverse().join(" → ")}` : path;
  });
}
