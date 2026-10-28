import { describe, expect, it } from "vitest";
import { parseAndAnalyze, walk } from "../../src/htmx/transform/analysis.js";
import type { Node } from "../../src/htmx/transform/analysis.js";

describe("oxc / scope-manager boundary", () => {
  for (const raw of [true, false]) it(`resolves TSX scopes (raw transfer: ${raw})`, () => {
    const analysis = parseAndAnalyze(`import { db } from './db';
      export default function C({ count }: Props) {
        const fmt = (n: number) => n;
        return <i hx-post={(() => { const count1 = 1; return db(count + count1, fmt); })} />;
      }`, "test.tsx", raw);
    let action: Node | undefined;
    walk(analysis.program, node => {
      if (node.type === "JSXAttribute" && node.value?.type === "JSXExpressionContainer") {
        action = node.value.expression;
      }
    });
    const captures = analysis.captures(action!);
    expect(captures.map(v => [v.name, analysis.kind(v)])).toEqual([
      ["count", "value"], ["fmt", "function"],
    ]);
  });
});
