import { afterAll, expect, it } from 'vitest';
import { transformWithOxc } from 'vite';
import * as jsxRuntime from '../../src/jsx/jsx-runtime.js';
import type { Context } from 'hono';
import { createElement, Suspense } from '../../src/jsx/index.js';
import * as runtime from '../../src/htmx/runtime.js';
import { transform, type TransformOptions } from '../../src/htmx/transform/index.js';
import { app, extract, manifest, render, submit } from './helpers.js';

const dataUrl = (source: string) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
// Native data: modules cannot resolve package names. This bridge exports the actual
// runtime/JSX functions loaded by each Hono-version Vitest project, with no stubs.
const key = `__recooler_runtime_integration_${Math.random().toString(36).slice(2)}`;
Object.defineProperty(globalThis, key, { value: { runtime, jsxRuntime, Suspense }, configurable: true });
afterAll(() => Reflect.deleteProperty(globalThis, key));
const bridge = dataUrl(`const bridge = globalThis[${JSON.stringify(key)}];
  export const { actionUrl, registerActions, wrapAction, wrapActionWithPayload, actionScope, handlerScope } = bridge.runtime;
  export const { jsx, jsxs, jsxDEV, Fragment, createElement } = bridge.jsxRuntime;
  export const { Suspense } = bridge;`);
let serial = 0;
async function evaluate(source: string, relativePath: string, options: Partial<TransformOptions> = {}, imports: Record<string, string> = {}) {
  const output = transform(source, { id: relativePath, relativePath, moduleKind: 'route', mode: 'server', ...options });
  expect(output.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
  let lowered = (await transformWithOxc(output.code, relativePath, {
    jsx: { runtime: 'automatic', importSource: '@insights-gaming/recooler/jsx' },
  })).code.replaceAll('"@insights-gaming/recooler/htmx/runtime"', JSON.stringify(bridge))
    .replaceAll('"@insights-gaming/recooler/jsx/jsx-runtime"', JSON.stringify(bridge))
    .replaceAll('"@insights-gaming/recooler/jsx"', JSON.stringify(bridge));
  for (const [specifier, resolved] of Object.entries(imports)) lowered = lowered.replaceAll(JSON.stringify(specifier), JSON.stringify(resolved));
  const url = dataUrl(`// evaluation ${serial++}\n${lowered}`);
  return { module: await import(/* @vite-ignore */ url), url, output };
}

it('renders transformed actions from pages, root, layouts and shared statically imported components', async () => {
  const shared = await evaluate(`export function Shared() { return <form hx-put={() => 'shared'} />; }`, 'components/Shared.tsx', { moduleKind: 'component' });
  const root = await evaluate(`export default Content => props => <html><body><button hx-post={() => 'root'} /><Content {...props} /></body></html>;`, 'root.tsx', { moduleKind: 'root' });
  const layout = await evaluate(`export default Content => props => <section><button hx-delete={() => 'layout'} /><Content {...props} /></section>;`, 'routes/layout.tsx', { moduleKind: 'layout' });
  const page = await evaluate(`import { Shared } from "./Shared";
    export default function Page() { return <><button hx-patch={() => 'page'} /><Shared /></>; }`, 'routes/index.tsx', {}, { './Shared': shared.url });
  const a = app(manifest({ 'layout.tsx': layout.module, 'index.tsx': page.module }, root.module), {
    'routes/index.tsx': ['routes/index.tsx', 'routes/layout.tsx', 'root.tsx', 'components/Shared.tsx'],
  });
  const html = await render(a);
  for (const [attribute, method, text] of [['hx-post', 'POST', 'root'], ['hx-delete', 'DELETE', 'layout'], ['hx-patch', 'PATCH', 'page'], ['hx-put', 'PUT', 'shared']]) {
    const target = extract(html, attribute);
    expect(target).toMatch(/^\/\?action=/);
    expect(await (await submit(a, target, method)).text()).toBe(text);
  }
  expect(html).not.toContain('<script'); // Phase 5 owns page.scripts and client loading.
});

it('dispatches real transformed nested captures, payloads and handler scopes', async () => {
  const component = await evaluate(`export function Counter({ initial }) {
    let count = initial;
    return <form hx-post={(ctx, payload) => {
      count += Number(payload.amount);
      return <button hx-get={() => count} hx-on:click={() => count} />;
    }} />;
  }`, 'components/Counter.tsx', { moduleKind: 'component' });
  const page = await evaluate(`import { Counter } from "./Counter";
    export default () => <Counter initial={3} />;`, 'routes/counter/index.tsx', {}, { './Counter': component.url });
  const a = app(manifest({ 'counter/index.tsx': page.module }), { 'routes/counter/index.tsx': ['components/Counter.tsx'] });
  const target = extract(await render(a, '/counter'));
  const response = await a.request(target, { method: 'POST', headers: {
    'HX-Request': 'true', Origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded',
  }, body: 'amount=4' });
  expect(response.status).toBe(200);
  const fragment = await response.text();
  expect(fragment).toContain('{&quot;count&quot;:7}');
  const nested = extract(fragment, 'hx-get');
  expect(nested).toMatch(/^\/counter\?action=/);
  expect(await (await submit(a, nested, 'GET')).text()).toBe('7');
});

it('uses the rendering route for a component defined in a foreign guarded route module', async () => {
  const foreign = await evaluate(`export function Shared() { return <button hx-post={() => 'rendering route'} />; }
    export default () => <Shared />;`, 'routes/(admin)/secret/index.tsx');
  const page = await evaluate(`import { Shared } from "./foreign";
    export default () => <Shared />;`, 'routes/public/index.tsx', {}, { './foreign': foreign.url });
  const a = app(manifest({
    'public/index.tsx': page.module,
    '(admin)/secret/index.tsx': foreign.module,
    '(admin)/middleware.ts': { default: (c: Context) => c.text('admin guard', 401) },
  }), {
    'routes/public/index.tsx': ['routes/(admin)/secret/index.tsx'],
    'routes/(admin)/secret/index.tsx': ['routes/(admin)/secret/index.tsx'],
  });
  const target = extract(await render(a, '/public'));
  expect(target).toMatch(/^\/public\?/);
  expect(await (await submit(a, target)).text()).toBe('rendering route');
  expect((await submit(a, '/secret?' + target.split('?')[1])).status).toBe(401);
});

it('evaluates a real barrel over-approximation but rejects unsigned foreign actions', async () => {
  const admin = await evaluate(`export function AdminButton() { return <button hx-post={() => { globalThis.${key}.ran = true; return 'admin'; }} />; }`, 'barrel/admin.tsx', { moduleKind: 'component' });
  const barrel = dataUrl(`export { AdminButton } from ${JSON.stringify(admin.url)}; export const title = 'public';`);
  const page = await evaluate(`import { title } from "./barrel"; export default () => <h1>{title}</h1>;`, 'routes/barrel/index.tsx', {}, { './barrel': barrel });
  const a = app(manifest({ 'barrel/index.tsx': page.module }), { 'routes/barrel/index.tsx': ['barrel/admin.tsx'] });
  expect(await render(a, '/barrel')).toContain('public');
  expect((await submit(a, '/barrel?action=' + encodeURIComponent(admin.output.actions[0]!.id))).status).toBe(404);
  expect((globalThis as any)[key].ran).toBeUndefined();
});

it('supports explicit ctx overrides as well as ambient contexts in onGet/onRequest rendering', async () => {
  const page = await evaluate(`export function Form({ ctx }) { return <form ctx={ctx} hx-post={() => 'override'} />; }
    export default () => <Form />;`, 'routes/ctx/index.tsx');
  const contexts: Context[] = [];
  const a = app(manifest({ 'ctx/[id]/index.tsx': { ...page.module,
    onGet: async (c: Context, next: () => Promise<void>) => { contexts.push(c); await next(); },
  } }), { 'routes/ctx/[id]/index.tsx': ['routes/ctx/index.tsx'] });
  const first = extract(await render(a, '/ctx/one'));
  await render(a, '/ctx/two');
  const explicit = await createElement(page.module.Form, { ctx: contexts[0] });
  expect(extract(explicit.toHTML())).toBe(first);
  const b = app(manifest({ 'ctx/index.tsx': { default: () => '',
    onRequest: async (c: Context) => c.html((await createElement(page.module.Form, {})).toHTML()),
  } }), { 'routes/ctx/index.tsx': ['routes/ctx/index.tsx'] });
  expect(extract(await render(b, '/ctx'))).toMatch(/^\/ctx\?action=/);
});

it.each(['user-id', 'a$b', '口'])('preserves the incoming encoded path for parameter %s', async parameter => {
  const page = await evaluate(`export default () => <button hx-get={() => 'encoded'} />;`, `routes/encoding-${parameter}.tsx`);
  const a = app(manifest({ [`[${parameter}]/index.tsx`]: page.module }), { [`routes/[${parameter}]/index.tsx`]: [`routes/encoding-${parameter}.tsx`] });
  const target = extract(await render(a, '/a%2Fb%40%E5%8F%A3'), 'hx-get');
  expect(target).toMatch(/^\/a%2Fb%40%E5%8F%A3\?action=/);
  expect(await (await submit(a, target, 'GET')).text()).toBe('encoded');
});

it('generates transformed action URLs in deferred Suspense children after Hono returns the shell', async () => {
  const page = await evaluate(`import { Suspense } from "test:suspense";
    async function Delayed() {
      await new Promise(resolve => setTimeout(resolve, 15));
      return <button hx-post={() => 'deferred'} />;
    }
    export default function Page({ rid }) { return <Suspense rid={rid} fallback={<i>loading</i>}><Delayed /></Suspense>; }
  `, 'routes/suspense.tsx', {}, { 'test:suspense': bridge });
  const a = app(manifest({ '[[rest]]/index.tsx': page.module }), { 'routes/[[rest]]/index.tsx': ['routes/suspense.tsx'] });
  const response = await a.request('/a%2Fb/child');
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain('loading');
  const target = extract(html);
  expect(target).toMatch(/^\/a%2Fb\/child\?action=/);
  expect(await (await submit(a, target)).text()).toBe('deferred');
});
