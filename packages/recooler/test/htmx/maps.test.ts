import { expect, it } from "vitest";
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import { transform } from "../../src/htmx/transform/index.js";

function position(code: string, offset: number) {
  const before = code.slice(0, offset).split("\n");
  return { line: before.length, column: before.at(-1)!.length };
}

for (const mode of ["full", "server", "client-slice"] as const) it(`maps original text and renamed captures after hoisting: ${mode}`, () => {
  const input = `import { format } from './format';
export const untouched = 42;
export function onLoad() { console.log(untouched); }
export default function Page({ count }) {
  return <form hx-post={(ctx) => {
    console.log("outer action");
    return <button hx-post={() => format(count)} />;
  }} hx-on:click={function (event) {
    console.log("handler body", count);
    return format(event.type);
  }} />;
}`;
  const result = transform(input, { id: 'page.tsx', relativePath: 'page.tsx', moduleKind: 'route', mode });
  expect(result.diagnostics).toEqual([]);
  const map = new TraceMap(JSON.parse(result.map.toString()));
  const check = (generated: string, original: string, originalOffset = 0) => {
    const offset = result.code.indexOf(generated);
    expect(offset, result.code).toBeGreaterThanOrEqual(0);
    const traced = originalPositionFor(map, position(result.code, offset));
    expect(traced).toMatchObject({ source: 'page.tsx', ...position(input, input.indexOf(original) + originalOffset) });
  };
  check('untouched = 42', 'untouched = 42');
  check('console.log(untouched)', 'console.log(untouched)');
  if (mode !== 'client-slice') {
    check('console.log("outer action")', 'console.log("outer action")');
    // The identifier itself is rewritten; the generated alias still maps to
    // the original capture reference, not the factory's generated binding.
    const alias = result.code.match(/format\((__recooler_capture[^)]*)\)/)![1]!;
    check(`${alias})`, 'format(count)', 'format('.length);
  }
  if (mode !== 'server') {
    check('function (event)', 'function (event)');
    check('console.log("handler body"', 'console.log("handler body"');
    const alias = result.code.match(/"handler body", (__recooler_capture[^)]*)\)/)![1]!;
    check(`${alias});`, '"handler body", count', '"handler body", '.length);
  }
});
