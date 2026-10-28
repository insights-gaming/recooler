import * as page from "./page.js";
import * as noagg from "./plain.js";
export function collect(roots) {
  const seen = new Set(), table = {}, order = [];
  const stack = roots.map((ns) => ns.__recooler).filter((f) => typeof f === "function");
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const node = f();
    order.push(node.name);
    Object.assign(table, node.actions);
    for (const dep of node.deps) {
      const g = typeof dep === "function" ? dep() : dep?.__recooler;
      if (typeof g === "function") stack.push(g);
    }
  }
  return { table, order };
}
export const result = collect([page]);
export const missing = typeof noagg.__recooler;
