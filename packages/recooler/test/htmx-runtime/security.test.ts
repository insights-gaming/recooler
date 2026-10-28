import { expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import { htmx } from '../../src/htmx/index.js';
import { actionUrl, registerActions } from '../../src/htmx/runtime.js';
import { createApp } from '../../src/router/index.js';
import { createElement as h, jsxPages } from '../../src/jsx/index.js';
import { app, actionApp, extract, headers, manifest, Page, render, secret, submit, url } from './helpers.js';

it('does not expose raw or encoded secret material through c.var', async () => {
  registerActions('private-key', { post: { a: () => 'action' } });
  const a = app(manifest({ 'index.tsx': { default: Page, onGet: (c: Context) => c.json(c.var) } }),
    { 'routes/index.tsx': ['private-key'] });
  const vars = await render(a);
  expect(vars).not.toContain(secret);
  expect(vars).not.toContain(Buffer.from(secret).toString('base64'));
  expect(vars).not.toContain('secret');
  expect((await submit(a, url('/', 'a'))).status).toBe(200);
});

it('isolates identical relative module and action ids in separate project namespaces', async () => {
  const make = (namespace: string, value: string) => {
    registerActions('src/routes/index.tsx', { post: { a: () => value } }, namespace);
    return app(manifest({ 'index.tsx': { default: () => h('form', { 'hx-post': actionUrl('a', {}) }) } }),
      { 'routes/index.tsx': ['src/routes/index.tsx'] }, { namespace });
  };
  const first = make('project-a', 'app one');
  const second = make('project-b', 'app two');
  expect(await (await submit(first, extract(await render(first)))).text()).toBe('app one');
  expect(await (await submit(second, extract(await render(second)))).text()).toBe('app two');
  // @ts-expect-error Vite query creates a separate bundled runtime instance.
  const reloaded = await import('../../src/htmx/runtime.ts?namespace-reload');
  expect(reloaded.findAction(['src/routes/index.tsx'], 'POST', 'a', 'project-a')()).toBe('app one');
  reloaded.registerActions('src/routes/index.tsx', {}, 'project-a');
  expect((await submit(first, url('/', 'a'))).status).toBe(404);
  expect(await (await submit(second, extract(await render(second)))).text()).toBe('app two');
});

it('caches one fallback signer when the request env is not an object', async () => {
  registerActions('fallback-env', { post: { a: () => 'action' } });
  const resolve = vi.fn(() => secret);
  const a = createApp(manifest({ 'index.tsx': { default: () => h('form', { 'hx-post': actionUrl('a', {}) }) } }), {
    pages: jsxPages(), extensions: [htmx({ table: { 'routes/index.tsx': ['fallback-env'] }, secret: resolve })],
  });
  const first = await a.request('/', {}, 'one' as never);
  const second = await a.request('/', {}, 'two' as never);
  expect(first.status).toBe(200);
  expect(await first.text()).toBe(await second.text());
  expect(resolve).toHaveBeenCalledTimes(1);
});

// The reviewer's twelve provenance combinations across every probed content type
// and GET. Origin is a fallback only when Sec-Fetch-Site is absent.
it.each([
  ['HX only', { 'HX-Request': 'true' }, 403],
  ['HX TRUE uppercase', { 'HX-Request': 'TRUE', 'Sec-Fetch-Site': 'same-origin' }, 403],
  ['same-site only', { 'HX-Request': 'true', 'Sec-Fetch-Site': 'same-site' }, 403],
  ['same-site + subdomain origin', { 'HX-Request': 'true', 'Sec-Fetch-Site': 'same-site', Origin: 'http://evil.localhost' }, 403],
  ['none (typed URL)', { 'HX-Request': 'true', 'Sec-Fetch-Site': 'none' }, 403],
  ['Origin null', { 'HX-Request': 'true', Origin: 'null' }, 403],
  ['Origin trailing slash', { 'HX-Request': 'true', Origin: 'http://localhost/' }, 403],
  ['Origin port', { 'HX-Request': 'true', Origin: 'http://localhost:80' }, 403],
  ['Origin https', { 'HX-Request': 'true', Origin: 'https://localhost' }, 403],
  ['cross-site + same Origin', { 'HX-Request': 'true', 'Sec-Fetch-Site': 'cross-site', Origin: 'http://localhost' }, 403],
  ['same-origin + evil Origin', { 'HX-Request': 'true', 'Sec-Fetch-Site': 'same-origin', Origin: 'https://evil.example' }, 200],
  ['Sec-Fetch-Site mixed case', { 'HX-Request': 'true', 'Sec-Fetch-Site': 'Same-Origin' }, 403],
] as const)('CSRF matrix: %s', async (_name, provenance, expected) => {
  for (const method of ['GET', 'POST']) {
    const a = actionApp(() => 'action', method);
    const onError = vi.fn(() => new Response('unexpected error', { status: 500 }));
    a.onError(onError);
    for (const contentType of ['application/x-www-form-urlencoded', 'application/json', 'text/plain;charset=utf-8', undefined]) {
      const response = await a.request(url('/', 'test-result@0', method), {
        method, headers: { ...provenance, ...(contentType ? { 'Content-Type': contentType } : {}) },
      });
      expect(response.status).toBe(expected);
    }
    expect(onError).not.toHaveBeenCalled();
  }
});

it('runs actions after group middleware and before onRequest authorization', async () => {
  const trace: string[] = [];
  registerActions('auth-order', { post: { a: () => { trace.push('action'); return 'action'; } } });
  const a = app(manifest({
    '(g)/middleware.ts': { default: async (_c: Context, next: () => Promise<void>) => { trace.push('group'); await next(); } },
    '(g)/index.tsx': { default: Page, onRequest: (c: Context) => { trace.push('onRequest'); return c.text('denied', 401); } },
  }), { 'routes/(g)/index.tsx': ['auth-order'] });
  expect(await (await submit(a, url('/', 'a', 'POST', {}, 'routes/(g)/index.tsx'))).text()).toBe('action');
  expect(trace).toEqual(['group', 'action']);
  expect((await a.request('/', { method: 'POST', headers })).status).toBe(401);
});
