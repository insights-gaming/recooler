import { expect, it } from "vitest";
import { transformWithOxc } from "vite";
import { transform } from "../../src/htmx/transform/index.js";
import type { TransformOptions } from "../../src/htmx/transform/index.js";

const url = (code: string) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
let serial = 0;
async function execute(source: string, options: Partial<TransformOptions> = {}) {
  const runtimeUrl = url(`// test runtime ${serial++}
    export const registrations = [], calls = [];
    export function actionUrl(id, scope, ctx) { calls.push({ id, scope, ctx }); return JSON.stringify({ id, scope }); }
    export const handlerScope = JSON.stringify;
    export const wrapAction = (fn, id) => ctx => (id ? fn(ctx.scope) : fn)(ctx, {});
    export const wrapActionWithPayload = (fn, id) => ctx => (id ? fn(ctx.scope) : fn)(ctx, ctx.payload);
    export const registerActions = (id, methods) => registrations.push({ id, methods });
  `);
  const result = transform(source, { id: 'test.tsx', relativePath: 'test.tsx', moduleKind: 'route', ...options });
  expect(result.diagnostics).toEqual([]);
  const js = (await transformWithOxc(result.code, 'test.tsx', {
    jsx: { runtime: 'classic', pragma: '__jsx', pragmaFrag: '__fragment' },
  })).code.replaceAll('"recooler/htmx/runtime"', JSON.stringify(runtimeUrl));
  const module = await import(/* @vite-ignore */ url(`
    function __jsx(type, props, ...children) { return { type, props: props ?? {}, children }; }
    const __fragment = 'fragment';
    ${js}
  `));
  return { result, module, runtime: await import(/* @vite-ignore */ runtimeUrl) };
}

for (const mode of ['full', 'server'] as const) it(`executes captured actions with correct nested contexts: ${mode}`, async () => {
  const { module, runtime } = await execute(`
    export default function Page({ count, request }) {
      let counter = count;
      return <form ctx={request} hx-post={(ctx, payload) => {
        counter += payload.amount;
        return <button hx-get={() => ({ counter })} hx-on:click={function (event) { return [counter, this.tag, event.type]; }} />;
      }} />;
    }
  `, { mode });
  const renderContext = { name: 'render' }, actionContext = { name: 'action' };
  const form = module.default({ count: 3, request: renderContext });
  expect(runtime.calls[0]).toEqual({ id: 'test.tsx@0', scope: { counter: 3 }, ctx: renderContext });
  expect(JSON.parse(form.props['hx-post']).scope).toEqual({ counter: 3 });
  const button = module['_action$post$0']({ ...actionContext, scope: { counter: 3 }, payload: { amount: 4 } });
  expect(runtime.calls[1]).toEqual({ id: 'test.tsx@1', scope: { counter: 7 }, ctx: { ...actionContext, scope: { counter: 3 }, payload: { amount: 4 } } });
  expect(module['_action$get$1']({ scope: { counter: 7 } })).toEqual({ counter: 7 });
  expect(runtime.registrations[0].methods.post['test.tsx@0']).toBe(module['_action$post$0']);
  expect(runtime.registrations[0].methods.get['test.tsx@1']).toBe(module['_action$get$1']);
  if (mode === 'full') {
    const run = new Function('$handlers', 'event', `return ${button.props['hx-on:click']}`);
    expect(run.call({ tag: 'BUTTON' }, { 'test.tsx@0': module['_handler$0'] }, { type: 'click' })).toEqual([7, 'BUTTON', 'click']);
  } else expect(module['_handler$0']).toBeUndefined();
});

it('executes a standalone client slice, shared helpers and onLoad', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, '$handlers');
  const table: Record<string, (scope: unknown) => (event: unknown) => unknown> = {};
  Object.defineProperty(globalThis, '$handlers', { value: table, writable: true, configurable: true });
  try {
    const { module } = await execute(`
      const multiply = (n) => n * 2;
      export function onLoad() { return multiply(4); }
      export default function C({ count }) { return <i hx-on:click={(e) => multiply(count) + e.delta} />; }
      throw new Error('server side effect must be sliced out');
    `, { mode: 'client-slice' });
    expect(module.default).toBeUndefined();
    expect(module.onLoad()).toBe(8);
    expect(table['test.tsx@0']).toBe(module['_handler$0']);
    expect(table['test.tsx@0']!({ count: 5 })({ delta: 1 })).toBe(11);
  } finally {
    if (previous) Object.defineProperty(globalThis, '$handlers', previous);
    else Reflect.deleteProperty(globalThis, '$handlers');
  }
});

it('does not capture a context supplied only to the outer element', async () => {
  const { module, runtime } = await execute(`
    export default function Page(props) {
      const rc = props.ctx;
      return <form ctx={rc} hx-post={() => <b hx-post={() => 2} />} />;
    }
  `);
  const rc = { name: 'render' }, ac = { name: 'action' };
  module.default({ ctx: rc });
  module['_action$post$0'](ac);
  expect(runtime.calls).toEqual([
    { id: 'test.tsx@0', scope: {}, ctx: rc },
    { id: 'test.tsx@1', scope: {}, ctx: ac },
  ]);
});

it('preserves shorthand capture keys in assignment defaults and ctx overrides', async () => {
  const { module, runtime } = await execute(`
    export default function Page({ count, ctx }) {
      return <i hx-post={() => {
        ({ count = 9 } = {});
        return { ctx, 'hx-post': () => count };
      }} />;
    }
  `);
  expect(runtime.calls).toEqual([]);
  module.default({ count: 1, ctx: 'serializable-test-context' });
  const value = module['_action$post$0']({ scope: { count: 1, ctx: 'serializable-test-context' } });
  expect(value.ctx).toBeUndefined();
  expect(runtime.calls[1]).toEqual({ id: 'test.tsx@1', scope: { count: 9 }, ctx: 'serializable-test-context' });
});

it('preserves defaults, rest props and the ambient context option', async () => {
  for (const signature of [
    `({ count = 2, ctx } = { count: 4, ctx: 'default' })`,
    `(...[{ count = 2, ctx }])`,
  ]) {
    const { module, runtime } = await execute(`export default ${signature} => <i hx-get={() => count} />;`);
    module.default({ count: 3, ctx: 'provided' });
    expect(runtime.calls[0]).toEqual({ id: 'test.tsx@0', scope: { count: 3 }, ctx: 'provided' });
    expect(module['_action$get$0']({ scope: { count: 3 } })).toBe(3);
  }
  const { module, runtime } = await execute(`export default function Page({ count }) { return <i hx-get={() => count} />; }`, { componentContext: false });
  module.default({ count: 3 });
  expect(runtime.calls[0]).toEqual({ id: 'test.tsx@0', scope: { count: 3 }, ctx: undefined });
});

it('escapes handler IDs in template literals, including quotes and backslashes', async () => {
  const relativePath = 'routes/a"b`c${d}\\e.tsx';
  const { module, result } = await execute(`export default function Page({ count }) { return <i hx-on:click={() => count} />; }`, { relativePath });
  const element = module.default({ count: 5 });
  const run = new Function('$handlers', 'event', `return ${element.props['hx-on:click']}`);
  expect(run({ [result.handlers[0]!.id]: module['_handler$0'] }, {})).toBe(5);
});

for (const mode of ['full', 'server'] as const) it(`renders nullish optional props using ambient context: ${mode}`, async () => {
  const { module, runtime } = await execute(`export default function Actions(opts?) { return <button hx-post={() => 1} />; }`, { mode });
  expect(() => module.default()).not.toThrow();
  expect(() => module.default(null)).not.toThrow();
  expect(runtime.calls.map((c: { ctx: unknown }) => c.ctx)).toEqual([undefined, undefined]);
});

it('serializes local TS enums as plain captured data', async () => {
  const { module, runtime } = await execute(`export default function Page() {
    enum Status { Ready = 1, Done = 'done' }
    return <i hx-post={() => Status.Ready} hx-on:click={() => Status.Done} />;
  }`);
  const element = module.default();
  const captured = { '1': 'Ready', Ready: 1, Done: 'done' };
  expect(runtime.calls[0].scope).toEqual({ Status: captured });
  expect(module['_action$post$0']({ scope: { Status: captured } })).toBe(1);
  const run = new Function('$handlers', 'event', `return ${element.props['hx-on:click']}`);
  expect(run({ 'test.tsx@0': module['_handler$0'] }, {})).toBe('done');
});

it('consumes nested object ctx while preserving direct component spread props', async () => {
  const { module, runtime } = await execute(`export default function Page(props) {
    const rc = props.ctx;
    return <Btn {...{ ctx: rc, 'hx-post': () => 1, x: { ctx: rc, 'hx-post': () => 2 } }} />;
  }
  function Btn() {}`);
  const rc = { request: true };
  const value = module.default({ ctx: rc });
  expect(value.props.ctx).toBe(rc);
  expect(value.props.x.ctx).toBeUndefined();
  expect(runtime.calls.map((c: { ctx: unknown }) => c.ctx)).toEqual([rc, rc]);
});

it('executes a hoisted action from a pruned handler-only component with its import intact', async () => {
  const dbUrl = url('export const saved = []; export const db = { save: async value => saved.push(value) };');
  const { module, result } = await execute(`import { db, saved } from ${JSON.stringify(dbUrl)};
    export { saved };
    function Row(props) { return <form hx-post={async () => { await db.save(props.id); }} />; }
    export default function Page() { return <i hx-on:click={function () { return <Row id={42} />; }} />; }
  `, { mode: 'server' });
  expect(result.code).not.toContain('function Row');
  await module['_action$post$0']({ scope: { props: { id: 42 } } });
  expect(module.saved).toEqual([42]);
});


it('loads qualified import-equals aliases in client slices', async () => {
  const namespace = url('export const deep = { Thing: { go: () => 42 } };');
  const { module } = await execute(`import * as ns from ${JSON.stringify(namespace)};
    import X = ns.deep.Thing;
    export const onLoad = () => X.go();`, { mode: 'client-slice' });
  expect(module.onLoad()).toBe(42);
});

it('loads server routes without evaluating browser-only onLoad imports', async () => {
  const browser = url(`throw new Error('browser-only import evaluated'); export const Chart = class {};`);
  for (const entry of ['export function onLoad() { return new Chart(); }',
    'export const onLoad = () => new Chart();',
    'const load = () => new Chart(); export { load as onLoad };']) {
    const { module } = await execute(`import { Chart } from ${JSON.stringify(browser)};
      ${entry} export default () => 42;`, { mode: 'server' });
    expect(module.default()).toBe(42);
    expect(module.onLoad).toBeUndefined();
  }
});
