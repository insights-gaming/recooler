import { expect, it, vi } from 'vitest';
import { Hono, type Context, type Handler } from 'hono';
import { mount as mount5 } from 'hono-5/mount';
import { createApp } from '../../src/router/index.js';
import { createElement as h, jsxPages } from '../../src/jsx/index.js';
import { htmx, type ActionTable } from '../../src/htmx/index.js';
import { actionUrl, registerActions } from '../../src/htmx/runtime.js';
import { actionApp, app, errors, extract, headers, manifest, Page, register, render, secret, submit, url } from './helpers.js';
const text = (value: string): Handler => c => c.text(value);

it('passes ordinary requests through onRequest/onPost but reserves unknown and unsigned actions', async () => {
  let calls = 0;
  const a = actionApp(c => { calls++; return c.text('action'); }, 'POST', { onRequest: text('normal') });
  expect(await (await a.request('/', { method: 'POST' })).text()).toBe('normal');
  for (const id of ['bogus', '', 'null', 'constructor', 'toString', '__proto__']) {
    expect((await submit(a, `/?action=${id}`)).status).toBe(404);
  }
  expect((await submit(a, '/?action=test-result%400')).status).toBe(404);
  expect(await (await submit(a)).text()).toBe('action');
  expect(calls).toBe(1);
});

it('uses the first of repeated action, scope and signature parameters', async () => {
  const a = actionApp(() => 'yes');
  expect((await submit(a, url() + '&action=bogus&scope=bad&sig=bad')).status).toBe(200);
  expect((await submit(a, '/?action=bogus&' + url().split('?')[1])).status).toBe(404);
});

it('only reserves action on page routes with actions for the receiving method', async () => {
  register('reserve', { get: { a: () => 'action' } });
  const a = app(manifest({
    'with/index.tsx': { default: Page },
    'without/index.tsx': { default: Page, onGet: (c: Context) => c.text(`page ${c.req.query('action')}`), onPost: (c: Context) => c.text(`onPost ${c.req.query('action')}`) },
    'api/index.ts': { onGet: text('api'), onPost: text('api-post') },
  }), { 'routes/with/index.tsx': ['reserve'], 'routes/api/index.ts': ['reserve'] });
  expect((await submit(a, '/with?action=edit', 'GET')).status).toBe(404);
  expect(await render(a, '/with')).toContain('page');
  expect(await render(a, '/without?action=edit')).toBe('page edit');
  expect(await (await a.request('/without?action=edit', { method: 'POST' })).text()).toBe('onPost edit');
  expect(await render(a, '/api?action=edit')).toBe('api');
  expect(await (await a.request('/api?action=edit', { method: 'POST' })).text()).toBe('api-post');
});

it('falls through invalid signatures to later registrations and their group middleware', async () => {
  register('fallthrough', { post: { a: () => 'first', b: () => 'later' } });
  const trace: string[] = [];
  const guard = (name: string) => ({ default: async (_c: Context, next: () => Promise<void>) => { trace.push(name); await next(); } });
  const a = app(manifest({
    '(a)/middleware.ts': guard('public'), '(a)/page/index.tsx': { default: Page, onPost: text('must skip') },
    '(b)/middleware.ts': guard('admin'), '(b)/[[rest]]/index.tsx': { default: Page },
  }), { 'routes/(a)/page/index.tsx': ['fallthrough'], 'routes/(b)/[[rest]]/index.tsx': ['fallthrough'] });
  expect(await (await submit(a, url('/page', 'b', 'POST', {}, 'routes/(b)/[[rest]]/index.tsx'))).text()).toBe('later');
  expect(trace.splice(0)).toEqual(['public', 'admin']);
  expect((await submit(a, '/page?action=nope')).status).toBe(404);
  expect(trace).toEqual(['public', 'admin']);
});

it('binds signatures to the exact pathname, action, method, route file and serialized captures', async () => {
  let calls = 0;
  register('secure', { post: { a: () => { calls++; return 'post'; }, b: () => { calls++; return 'b'; } }, get: { a: () => { calls++; return 'get'; } } });
  const a = app(manifest({ 'users/[id]/index.tsx': { default: Page } }), { 'routes/users/[id]/index.tsx': ['secure'] });
  const original = url('/users/1', 'a', 'POST', { count: 1 }, 'routes/users/[id]/index.tsx');
  expect((await submit(a, original)).status).toBe(200);
  for (const alter of [
    (u: URL) => u.searchParams.delete('sig'), (u: URL) => u.searchParams.set('sig', 'x'.repeat(43)),
    (u: URL) => u.searchParams.set('scope', '{"count":2}'), (u: URL) => u.searchParams.delete('scope'),
    (u: URL) => u.searchParams.set('action', 'b'), (u: URL) => { u.pathname = '/users/2'; },
  ]) {
    const changed = new URL(original, 'http://localhost'); alter(changed);
    expect((await submit(a, changed.href)).status).toBe(404);
  }
  expect((await submit(a, original, 'GET')).status).toBe(404);
  expect((await submit(a, url('/users/1', 'a', 'POST', { count: 1 }, 'foreign-route'))).status).toBe(404);
  expect(calls).toBe(1);
});

it('restricts dispatch to reachable modules even with a valid signature', async () => {
  let calls = 0;
  register('foreign', { post: { foreign: () => { calls++; return 'foreign'; } } });
  const a = actionApp(() => 'local');
  expect((await submit(a, url('/', 'foreign'))).status).toBe(404);
  expect(calls).toBe(0);
});

it('fixes the barrel case: importing an unused admin re-export does not authorize an admin URL on public', async () => {
  let calls = 0;
  register('barrel/admin', { post: { admin: () => { calls++; return 'unsafe'; } } });
  const a = app(manifest({
    'public/index.tsx': { default: () => 'no admin form rendered' },
    '(admin)/secret/index.tsx': { default: () => h('button', { 'hx-post': actionUrl('admin', {}) }) },
  }), { 'routes/public/index.tsx': ['barrel/admin'], 'routes/(admin)/secret/index.tsx': ['barrel/admin'] });
  const adminUrl = extract(await render(a, '/secret'));
  expect((await submit(a, '/public?' + adminUrl.split('?')[1])).status).toBe(404);
  expect((await submit(a, '/public?action=admin')).status).toBe(404);
  expect(calls).toBe(0);
  expect((await submit(a, adminUrl)).status).toBe(200);
});

it('runs guards before CSRF and signature checks, including guarded fall-through', async () => {
  const trace: string[] = [];
  register('guarded', { post: { a: () => { trace.push('action'); return 'action'; } } });
  const a = app(manifest({
    '(a-public)/x/index.tsx': { default: Page },
    '(z-admin)/middleware.ts': { default: (c: Context, next: () => Promise<void>) => { trace.push('guard'); return c.req.header('x-auth') ? next() : c.text('guard', 401); } },
    '(z-admin)/[[rest]]/index.tsx': { default: Page },
  }), { 'routes/(a-public)/x/index.tsx': ['guarded'], 'routes/(z-admin)/[[rest]]/index.tsx': ['guarded'] });
  const replay = url('/x', 'a', 'POST', {}, 'routes/something-else.tsx');
  expect((await submit(a, replay)).status).toBe(401);
  expect((await submit(a, replay, 'POST', { 'x-auth': 'yes' })).status).toBe(404);
  // Direct guard rejection precedes even missing CSRF headers.
  expect((await a.request('/secret?action=a', { method: 'POST' })).status).toBe(401);
  expect(trace).toEqual(['guard', 'guard', 'guard']);
});

it.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])('enforces CSRF for %s, including JSON and safe-method actions', async method => {
  let calls = 0;
  const a = actionApp(() => { calls++; return 'action'; }, method);
  for (const bad of [
    {}, { 'HX-Request': 'true' }, { ...headers, 'HX-Request': 'false' },
    { ...headers, 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' },
    { 'HX-Request': 'true', 'Sec-Fetch-Site': 'same-site' },
    { 'HX-Request': 'true', Origin: 'null' },
    { 'HX-Request': 'true', 'Sec-Fetch-Site': 'invalid' },
  ]) {
    const response = await a.request(url('/', 'test-result@0', method), { method, headers: { 'content-type': 'application/json', ...bad } as Record<string, string> });
    expect(response.status).toBe(403);
  }
  for (const good of [headers, { 'HX-Request': 'true', Origin: 'http://localhost' }, { 'HX-Request': 'true', 'Sec-Fetch-Site': 'same-origin' }]) {
    expect((await a.request(url('/', 'test-result@0', method), { method, headers: good as Record<string, string> })).status).toBe(200);
  }
  expect(calls).toBe(3);
});

it('accepts trusted origins using Hono OR semantics without bypassing HX-Request', async () => {
  register('trusted', { get: { a: () => 'trusted' } });
  for (const trustedOrigins of [['https://friend.example'], async (origin: string, c: Context) => origin === 'https://friend.example' && c.req.method === 'GET']) {
    const a = app(manifest({ 'index.tsx': { default: Page } }), { 'routes/index.tsx': ['trusted'] }, { trustedOrigins });
    expect((await a.request(url('/', 'a', 'GET'), { headers: { 'HX-Request': 'true', Origin: 'https://friend.example', 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(200);
    expect((await a.request(url('/', 'a', 'GET'), { headers: { Origin: 'https://friend.example' } })).status).toBe(403);
  }
});

it.each(['route', 'basePath', 'mount'] as const)('renders and submits under %s, retaining exact encodings', async mount => {
  register('mounted', { post: { a: () => 'mounted' } });
  const a = app(manifest({ '[[rest]]/index.tsx': { default: () => h('form', { 'hx-post': actionUrl('a', {}) }) } }),
    { 'routes/[[rest]]/index.tsx': ['mounted'] }, { base: mount === 'mount' ? '/app' : '' });
  const parent = new Hono();
  if (mount === 'route') parent.route('/app', a);
  else if (mount === 'basePath') parent.basePath('/app').route('/', a);
  else if (typeof parent.mount === 'function') parent.mount('/app', a.fetch);
  else parent.use('/app/*', mount5(a.fetch) as unknown as Handler);
  const target = extract(await render(parent, '/app/a%2Fb/%40/%E5%8F%A3'));
  expect(target).toMatch(/^\/app\/a%2Fb\/%40\/%E5%8F%A3\?action=/);
  expect(await (await submit(parent, target)).text()).toBe('mounted');
});

it('keeps root catch-all //evil action URLs on the rendering origin', async () => {
  register('evil', { post: { a: () => 'safe' } });
  const a = app(manifest({ '[[rest]]/index.tsx': { default: () => h('form', { 'hx-post': actionUrl('a', {}) }) } }), { 'routes/[[rest]]/index.tsx': ['evil'] });
  const target = extract(await render(a, 'http://localhost//evil.example/x'));
  expect(target).toMatch(/^\/\.\/\/evil\.example\/x\?/);
  expect(new URL(target, 'http://localhost').origin).toBe('http://localhost');
  expect(await (await submit(a, new URL(target, 'http://localhost').href)).text()).toBe('safe');
});

it('requires secrets only for reachable page actions and caches env resolution once', async () => {
  register('secret', { post: { a: () => 'action' } });
  const input = manifest({ 'index.tsx': { default: () => h('form', { 'hx-post': actionUrl('a', {}) }) } });
  const table = { 'routes/index.tsx': ['secret'] };
  expect(() => app(input, table, { secret: undefined })).toThrow('nonempty secret');
  expect(() => app(input, table, { secret: '' })).toThrow('nonempty secret');
  expect(() => app(input, {}, { secret: undefined })).not.toThrow();
  expect(() => app(manifest({ 'index.ts': { onPost: text('api') } }), table, { secret: undefined })).not.toThrow();
  const resolve = vi.fn((env: { KEY: string }) => env.KEY);
  const a = createApp<{ Bindings: { KEY: string } }>(input, { pages: jsxPages(), extensions: [htmx<{ Bindings: { KEY: string } }>({ table, secret: resolve })] });
  const first = extract(await (await a.request('/', {}, { KEY: secret })).text());
  expect(first).toBe(url('/', 'a'));
  expect(extract(await (await a.request('/', {}, { KEY: 'rotated' })).text())).toBe(first);
  expect(resolve).toHaveBeenCalledTimes(1);
  const bad = errors(app(input, table, { secret: () => '' }));
  expect((await bad.request('/')).status).toBe(500);
});

it('supports getter tables and module replacement/clearing across dev edits', async () => {
  let table: ActionTable = {};
  const a = app(manifest({ 'index.tsx': { default: Page, onPost: text('normal') } }), () => table);
  register('dev', { post: { a: () => 'old' } });
  expect(await (await submit(a, url('/', 'a'))).text()).toBe('normal');
  table = { 'routes/index.tsx': ['dev'] };
  expect(await (await submit(a, url('/', 'a'))).text()).toBe('old');
  register('dev', { post: { a: () => 'new' }, put: { b: () => 'added method' } });
  expect(await (await submit(a, url('/', 'a'))).text()).toBe('new');
  expect(await (await submit(a, url('/', 'b', 'PUT'), 'PUT')).text()).toBe('added method');
  register('dev', {});
  expect(await (await submit(a, url('/', 'a'))).text()).toBe('normal');
});

it('persists registrations across runtime module reloads', async () => {
  registerActions('persistent', { post: { a: () => 'cached dependency' } });
  // @ts-expect-error Vite query creates a new runtime module instance, as in SSR HMR.
  const reloaded = await import('../../src/htmx/runtime.ts?reload');
  expect(reloaded.actionRegistry.get('persistent').POST.a()).toBe('cached dependency');
  reloaded.registerActions('persistent', {});
  expect(reloaded.actionRegistry.get('persistent')).toEqual({});
});

it('makes secret:false explicitly unsigned while retaining CSRF and reachability', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    register('unsigned', { post: { a: () => 'dev' } });
    const a = app(manifest({ 'index.tsx': { default: () => h('form', { 'hx-post': actionUrl('a', {}) }) } }), { 'routes/index.tsx': ['unsigned'] }, { secret: false });
    const target = extract(await render(a));
    expect(target).not.toContain('sig=');
    expect(await (await submit(a, target)).text()).toBe('dev');
    expect((await a.request(target, { method: 'POST' })).status).toBe(403);
    expect((await submit(a, '/?action=foreign')).status).toBe(404);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('replay protection'));
  } finally { warn.mockRestore(); }
});

it.each(['https://evil.example', '//evil', '/\\evil', '/a?b', '/a#b', '/a/../b'])('rejects invalid base %s', base => {
  expect(() => htmx({ table: {}, secret, base })).toThrow('local path prefix');
});
