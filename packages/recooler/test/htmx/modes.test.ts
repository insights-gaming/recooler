import { expect, it } from 'vitest';
import { parseSync } from 'oxc-parser';
import { transform } from '../../src/htmx/transform/index.js';
import type { TransformOptions } from '../../src/htmx/transform/index.js';
const options: TransformOptions = { id: 'test.tsx', relativePath: 'test.tsx', mode: 'client-slice', moduleKind: 'route' };
const check = (source: string, override: Partial<TransformOptions> = {}) => {
  const result = transform(source, { ...options, ...override });
  expect(result.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
  expect(parseSync(options.id, result.code).errors, result.code).toEqual([]);
  return result;
};

it('drops pure handler-only declarations and retains effectful initializers on the server', () => {
  const result = check(`
    import { browser } from 'browser-only';
    import { shared, usedByServer } from 'shared';
    import 'keep-side-effect.css';
    const state = browser.create();
    const helper = () => shared(state);
    function unusedClientHelper() { return browser.read(); }
    export function serverApi() { return usedByServer(); }
    export default function Page() { return <b hx-on:click={() => [helper(), unusedClientHelper()]} />; }
  `, { mode: 'server' });
  expect(result.code).toContain('browser-only');
  expect(result.code).toContain('const state = browser.create();');
  expect(result.code).not.toContain('const helper');
  expect(result.code).not.toContain('unusedClientHelper');
  expect(result.code).not.toContain('export const _handler$');
  expect(result.code).toContain("import { usedByServer } from 'shared'");
  expect(result.code).toContain('keep-side-effect.css');
});

it('keeps dependencies with server uses, exports, cycles and top-level effects', () => {
  const result = check(`
    import { api } from 'shared';
    function a(n) { return n ? b(n-1) : api(); }
    function b(n) { return a(n); }
    export const publicFn = () => b(2);
    const run = () => a(1);
    run();
    export default function Page() { return <b hx-on:click={() => a(3)} />; }
  `, { mode: 'server' });
  for (const token of ["from 'shared'", 'function a', 'function b', 'publicFn', 'const run', 'run();']) expect(result.code).toContain(token);
});

it('slices cycles, merged declarations, enum values and import-equals bindings', () => {
  const result = check(`
    import api = require('safe');
    enum E { Value = 2 }
    function a(n) { return n ? b(n-1) : api(E.Value); }
    function b(n) { return a(n); }
    export default function Page() { return <b hx-on:click={() => a(3)} />; }
  `);
  for (const token of ["require('safe')", 'enum E', 'function a', 'function b']) expect(result.code).toContain(token);
  expect(transform(`import api = require('banned'); export const onLoad = () => api();`, { ...options, clientBannedImports: ['banned'] }).diagnostics[0]?.message)
    .toContain('onLoad → api');
});

it('keeps only runtime onLoad exports, including namespace re-exports', () => {
  for (const source of [
    `export function onLoad() { return 1; }`,
    `export const onLoad = () => 1;`,
    `function local() { return 1; } export { local as onLoad };`,
    `import { load } from './load'; export { load as onLoad };`,
    `export { load as onLoad } from './load';`,
    `export * as onLoad from './load';`,
  ]) {
    expect(check(source).code).toContain('onLoad');
    for (const moduleKind of ['layout', 'root'] as const) {
      const result = check(source, { moduleKind });
      expect(result.code.trim()).toBe('');
      expect(result.diagnostics.map(d => d.code)).toEqual(['ignored-onload']);
    }
  }
  for (const source of [
    `export declare function onLoad(): void;`,
    `export declare const onLoad: () => void;`,
    `export type { onLoad } from './types';`,
    `export { type onLoad } from './types';`,
    `type T = string; export { T as onLoad };`,
    `import type { T } from './types'; export { T as onLoad };`,
    `import { type T } from './types'; export { T as onLoad };`,
  ]) expect(check(source).code.trim()).toBe('');
});

it('uses a shortest reference chain for each handler, with stable regex matching', () => {
  const result = transform(`
    import { db } from 'banned';
    const long = () => middle();
    const middle = () => db();
    const short = () => db();
    export default function C() { return <i hx-on:click={() => [long(), short()]} hx-on:load={() => short()} />; }
  `, { ...options, clientBannedImports: [/banned/g] });
  expect(result.diagnostics.map(d => d.message)).toEqual([
    'event handler test.tsx@0 imports banned module "banned" via _handler$0 → short → db',
    'event handler test.tsx@1 imports banned module "banned" via _handler$1 → short → db',
  ]);
});
