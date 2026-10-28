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
  const rawMap = JSON.parse(result.map.toString());
  if (mode === 'client-slice') {
    expect(rawMap.sourcesContent[0]).not.toContain('outer action');
    expect(rawMap.sourcesContent[0]).toContain('handler body');
    expect(rawMap.sourcesContent[0].length).toBe(input.length);
  } else expect(rawMap.sourcesContent).toEqual([input]);
  const map = new TraceMap(rawMap);
  const check = (generated: string, original: string, originalOffset = 0) => {
    const offset = result.code.indexOf(generated);
    expect(offset, result.code).toBeGreaterThanOrEqual(0);
    const traced = originalPositionFor(map, position(result.code, offset));
    expect(traced).toMatchObject({ source: 'page.tsx', ...position(input, input.indexOf(original) + originalOffset) });
  };
  check('untouched = 42', 'untouched = 42');
  if (mode !== 'server') check('console.log(untouched)', 'console.log(untouched)');
  else expect(result.code).not.toContain('onLoad');
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

it('maps moved destructured props and retained import specifiers', () => {
  const input = `import { browser, shared } from './lib';
export default function Page({ count }: RouteProps) {
  shared();
  return <i hx-post={() => count} hx-on:click={() => browser(count)} />;
}`;
  const result = transform(input, { id: 'props.tsx', relativePath: 'props.tsx', mode: 'server' });
  expect(result.diagnostics).toEqual([]);
  expect(result.code).toContain('import { shared }');
  expect(result.code).toContain('__recooler_props: RouteProps');
  const rawMap = JSON.parse(result.map.toString());
  expect(rawMap.sourcesContent).toEqual([input]);
  const map = new TraceMap(rawMap);
  for (const [generated, original] of [['{ count }', '{ count }'], ['RouteProps', 'RouteProps'], ["'./lib'", "'./lib'"], ['shared();', 'shared();']]) {
    const offset = result.code.indexOf(generated!);
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(originalPositionFor(map, position(result.code, offset))).toMatchObject({ source: 'props.tsx', ...position(input, input.indexOf(original!)) });
  }
  // Rebuilt import syntax/specifiers are generated text anchored to the original
  // import statement; its untouched source literal retains an exact mapping.
  const importOffset = result.code.indexOf('shared }');
  expect(originalPositionFor(map, position(result.code, importOffset))).toMatchObject({ source: 'props.tsx', line: 1, column: 0 });
});

it('redacts dropped source and comments without changing UTF-16 offsets or lines', () => {
  const input = `import { browser, SERVER_IMPORT_SECRET } from './shared';
// ROUTE_COMMENT_SECRET 😀
export const server = () => 'SQL_SECRET';
export default () => <form hx-post={() => 'ACTION_SECRET'} hx-on:click={() => browser('visible')}/>;`;
  const result = transform(input, { id: 'map.tsx', relativePath: 'map.tsx', mode: 'client-slice' });
  expect(result.diagnostics).toEqual([]);
  const content = result.map.sourcesContent![0]!;
  for (const secret of ['SERVER_IMPORT_SECRET', 'ROUTE_COMMENT_SECRET', 'SQL_SECRET', 'ACTION_SECRET']) expect(content).not.toContain(secret);
  expect(content.length).toBe(input.length);
  expect(content.split('\n').map(line => line.length)).toEqual(input.split('\n').map(line => line.length));
  expect(content.indexOf("browser('visible')")).toBe(input.indexOf("browser('visible')"));
});
