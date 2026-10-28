import { contains } from "./analysis.js";
import type { Span } from "./analysis.js";

export function lowerBound<T>(items: readonly T[], start: number, position: (item: T) => number): number {
  let lo = 0, hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (position(items[mid]!) < start) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** AST intervals nest or are disjoint. Parent links let a binary search find
 * the innermost owner without scanning every function/declaration. */
export class SpanIndex<T extends Span> {
  readonly items: T[];
  private readonly parents = new Map<T, T>();
  constructor(items: readonly T[]) {
    this.items = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
    const stack: T[] = [];
    for (const item of this.items) {
      while (stack.length && !contains(stack.at(-1)!, item)) stack.pop();
      if (stack.length) this.parents.set(item, stack.at(-1)!);
      stack.push(item);
    }
  }
  owner(span: Span): T | undefined {
    const end = lowerBound(this.items, span.start + 1, item => item.start);
    let item = this.items[end - 1];
    while (item && !contains(item, span)) item = this.parents.get(item);
    return item;
  }
  within(span: Span): T[] {
    const start = lowerBound(this.items, span.start, item => item.start);
    const end = lowerBound(this.items, span.end, item => item.start);
    return this.items.slice(start, end).filter(item => contains(span, item));
  }
}
