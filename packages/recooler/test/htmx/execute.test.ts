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
