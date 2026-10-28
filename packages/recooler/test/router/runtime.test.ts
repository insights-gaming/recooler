import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { mount as mount5 } from 'hono-5/mount';
import type { Context, Handler, MiddlewareHandler } from 'hono';
import { createApp, mergePageExtras, RouteValidationError } from '../../src/router/index.js';
import type { PageAdapter, RouterExtension } from '../../src/router/index.js';
import { manifest } from './helpers.js';
const text = (body: string): Handler => c => c.text(body);
const pass: Handler = async (_c, next) => next();
const page = { default: () => null };
const pages: PageAdapter = { handler: route => Object.hasOwn(route.module, 'default') ? text('page') : undefined };
function traceMiddleware(trace: string[], name: string): { default: MiddlewareHandler } {
  return { default: async (_c, next) => { trace.push(name + '>'); await next(); trace.push('<' + name); } };
}
const actions: RouterExtension = { name: 'fake-actions', route: route => Object.hasOwn(route.module, 'default') ? { methods: ['POST'], handlers: [(c, next) => c.req.query('action') === 'yes' ? c.text('action') : next()] } : undefined };

it('matches static, param, catch-all, groups and hidden directories on one strict app', async () => {
  const app = createApp(manifest({
    '(first)/top/[id]/index.ts': { onGet: (c: Context) => c.text('param:' + c.req.param('id')) },
    '(last)/top/new/index.ts': { onGet: text('new') },
    '(first)/[[rest]]/index.ts': { onGet: (c: Context) => c.text('rest:' + c.req.param('rest')) },
    'index.ts': { onGet: text('home') },
    '.well-known/security.txt/index.ts': { onGet: text('hidden') },
    'foo/(g)/index.ts': { onGet: text('group root') },
  }));
  for (const [path, expected] of [['/', 'home'], ['/top/new', 'new'], ['/top/42', 'param:42'], ['/top/a/b', 'rest:top/a/b'], ['/.well-known/security.txt', 'hidden'], ['/foo', 'group root']]) {
    expect(await (await app.request(path!)).text()).toBe(expected);
  }
  const strict = createApp(manifest({ 'foo/(g)/index.ts': { onGet: text('foo') } }));
  expect((await strict.request('/foo/')).status).toBe(404);
});

it('rest params require at least one segment', async () => {
  const app = createApp(manifest({ 'docs/[[rest]]/index.ts': { onGet: text('rest') } }));
  expect((await app.request('/docs')).status).toBe(404);
  expect((await app.request('/docs/a')).status).toBe(200);
  expect((await app.request('/docs/a/b')).status).toBe(200);
});

it('orders extension handlers, onRequest, onGet and page within one chain', async () => {
  const trace: string[] = [];
  const through = (name: string): Handler => async (_c, next) => { trace.push(name); await next(); };
  const adapter: PageAdapter = { handler: () => c => { trace.push('page'); return c.text('ok'); } };
  const app = createApp(manifest({
    '(g)/middleware.ts': traceMiddleware(trace, 'group'),
    '(g)/index.tsx': { ...page, onRequest: through('onRequest'), onGet: through('onGet') },
  }), { pages: adapter, extensions: [{ name: 'a', route: () => ({ methods: ['ALL'], handlers: [through('ext-a')] }) }, { name: 'b', route: () => ({ methods: ['ALL'], handlers: [through('ext-b')] }) }] });
  expect(await (await app.request('/')).text()).toBe('ok');
  expect(trace).toEqual(['group>', 'ext-a', 'ext-b', 'onRequest', 'onGet', 'page', '<group']);
  // Hono stores one entry per handler: one ALL registration with five handlers.
  expect(app.routes.map(r => r.method)).toEqual(Array(5).fill('ALL'));
});

it('sends an action response before onRequest and method dispatch', async () => {
  const trace: string[] = [];
  const app = createApp(manifest({
    '(g)/middleware.ts': traceMiddleware(trace, 'g'),
    '(g)/index.tsx': { ...page, onRequest: () => { trace.push('onRequest'); }, onPost: text('post') },
  }), { pages, extensions: [actions] });
  expect(await (await app.request('/?action=yes', { method: 'POST' })).text()).toBe('action');
  expect(trace).toEqual(['g>', '<g']);
});

it('falls through from page actions to same-shaped protected routes with the right params', async () => {
  const trace: string[] = [];
  const app = createApp(manifest({
    '(z-public)/posts/[slug]/index.tsx': page,
    '(a-staff)/middleware.ts': traceMiddleware(trace, 'staff'),
    '(a-staff)/posts/[id]/index.ts': { onPost: (c: Context) => c.text('post:' + c.req.param('id')) },
  }), { pages, extensions: [actions] });
  expect(await (await app.request('/posts/7', { method: 'POST' })).text()).toBe('post:7');
  expect(trace).toEqual(['staff>', '<staff']);
  trace.length = 0;
  expect(await (await app.request('/posts/7?action=yes', { method: 'POST' })).text()).toBe('action');
  expect(trace).toEqual([]);
  expect(await (await app.request('/posts/7')).text()).toBe('page');
  expect(trace).toEqual([]);
});

it('runs shared group middleware once across fall-through routes and trailing uses', async () => {
  const trace: string[] = [];
  const app = createApp(manifest({
    '(g)/middleware.ts': traceMiddleware(trace, 'group'),
    '(g)/posts/middleware.ts': traceMiddleware(trace, 'dir'),
    '(g)/posts/new/index.ts': { onPost: pass },
    '(g)/posts/[id]/index.ts': { onPost: pass },
  }));
  expect((await app.request('/posts/new', { method: 'POST' })).status).toBe(404);
  expect(trace).toEqual(['group>', 'dir>', '<dir', '<group']);
});

it('reruns middleware when the same Request is dispatched again', async () => {
  let count = 0;
  const app = createApp(manifest({ '(g)/middleware.ts': { default: () => { count++; return new Response('blocked', { status: 401 }); } }, '(g)/index.ts': { onPost: text('unsafe') } }));
  const req = new Request('http://localhost/', { method: 'POST' });
  expect((await app.request(req)).status).toBe(401);
  expect((await app.request(req)).status).toBe(401);
  expect(count).toBe(2);
});

it('keys once by the middleware module, rather than its re-exported function', async () => {
  let count = 0;
  const shared: MiddlewareHandler = async (_c, next) => { count++; await next(); };
  const app = createApp(manifest({ '(g)/middleware.ts': { default: shared }, '(g)/x/middleware.ts': { default: shared }, '(g)/x/index.ts': { onGet: text('ok') } }));
  expect((await app.request('/x')).status).toBe(200);
  expect(count).toBe(2);
});

it('does not run other groups middleware or trailing uses after a terminal route', async () => {
  const trace: string[] = [];
  const app = createApp(manifest({
    '(g)/middleware.ts': traceMiddleware(trace, 'group'), '(g)/x/middleware.ts': traceMiddleware(trace, 'inside'),
    '(g)/x/private/index.ts': { onGet: text('private') },
    '(other)/middleware.ts': traceMiddleware(trace, 'other'), '(other)/x/index.ts': { onGet: text('other') },
    'x/plain/index.ts': { onGet: text('plain') },
  }));
  expect(await (await app.request('/x/plain')).text()).toBe('plain');
  expect(trace).toEqual([]);
  expect(await (await app.request('/x')).text()).toBe('other');
  expect(trace).toEqual(['other>', '<other']);
  trace.length = 0;
  expect((await app.request('/x/unmatched')).status).toBe(404);
  expect(trace).toEqual(['inside>', '<inside']);
});

it('runs plain directory middleware before scoped middleware, including unmatched prefix root', async () => {
  const trace: string[] = [];
  const app = createApp(manifest({
    'middleware.ts': traceMiddleware(trace, 'root'),
    '[id]/middleware.ts': traceMiddleware(trace, 'param'),
    'admin/sub/middleware.ts': traceMiddleware(trace, 'deep'),
    '(g)/middleware.ts': traceMiddleware(trace, 'group'),
    '(g)/admin/sub/index.ts': { onGet: text('ok') },
  }));
  await app.request('/admin/sub');
  expect(trace).toEqual(['root>', 'param>', 'deep>', 'group>', '<group', '<deep', '<param', '<root']);
  trace.length = 0;
  expect((await app.request('/admin')).status).toBe(404);
  expect(trace).toEqual(['root>', 'param>', '<param', '<root']);
});

describe.each(['route', 'basePath', 'mount'] as const)('guard remains fail-closed under %s', mount => {
  it.each(['/posts/new', '/posts/7', '/admin'])('protects fall-through at %s', async path => {
    let runs = 0;
    const guard: MiddlewareHandler = async (c, next) => { runs++; return c.req.header('x-staff') === 'yes' ? next() : c.text('staff only', 401); };
    const input = manifest({
      'posts/new/index.tsx': page, '(public)/posts/[slug]/index.tsx': page, '(public)/admin/index.tsx': page,
      '(staff)/middleware.ts': { default: guard },
      '(staff)/posts/[id]/index.ts': { onPost: text('staff') }, '(staff)/admin/index.ts': { onPost: text('staff') },
    });
    const app = createApp(input, { pages, extensions: [actions] });
    const parent = new Hono();
    if (mount === 'route') parent.route('/app', app);
    else if (mount === 'basePath') parent.basePath('/app').route('/', app);
    else if (typeof parent.mount === 'function') parent.mount('/app', app.fetch);
    else parent.use('/app/*', mount5(app.fetch) as unknown as MiddlewareHandler);
    expect((await parent.request('/app' + path, { method: 'POST' })).status).toBe(401);
    expect(await (await parent.request('/app' + path, { method: 'POST', headers: { 'x-staff': 'yes' } })).text()).toBe('staff');
    expect(runs).toBe(2);
    expect((await parent.request('/app' + path)).status).toBe(200);
    expect(runs).toBe(2);
  });
});

it('ends fall-through in 404 and respects custom notFound', async () => {
  const app = createApp(manifest({ 'index.tsx': page }), { pages, extensions: [actions] });
  expect((await app.request('/', { method: 'POST' })).status).toBe(404);
  const custom = createApp(manifest({ 'index.ts': { onPost: pass } }));
  custom.notFound(c => c.text('custom', 404));
  expect(await (await custom.request('/', { method: 'POST' })).text()).toBe('custom');
});

it('uses GET for HEAD, and registers OPTIONS only when declared', async () => {
  const calls: string[] = [];
  const app = createApp(manifest({ 'index.tsx': { ...page, onGet: (c: Context) => { calls.push(c.req.method); return c.text('get'); } }, 'options/index.ts': { onOptions: text('options') }, 'any/index.ts': { onRequest: text('any') } }), { pages });
  expect(await (await app.request('/')).text()).toBe('get');
  const head = await app.request('/', { method: 'HEAD' });
  expect(head.status).toBe(200); expect(await head.text()).toBe('');
  expect(calls).toEqual(['GET', 'HEAD']);
  expect((await app.request('/', { method: 'OPTIONS' })).status).toBe(404);
  expect(await (await app.request('/options', { method: 'OPTIONS' })).text()).toBe('options');
  expect(await (await app.request('/any', { method: 'PROPFIND' })).text()).toBe('any');
});

it.each(['onPost', 'onPut', 'onDelete', 'onPatch', 'onOptions'])('dispatches %s and falls through on other methods', async name => {
  const app = createApp(manifest({ 'index.ts': { [name]: text(name) } }));
  expect(await (await app.request('/', { method: name.slice(2).toUpperCase() })).text()).toBe(name);
  expect((await app.request('/')).status).toBe(404);
});

it('allows extensions to add arbitrary methods, handler chains and ordered page extras', async () => {
  let captured: unknown;
  const app = createApp(manifest({ 'index.tsx': page }), {
    extensions: [
      { name: 'one', route: () => ({ methods: ['PROPFIND'], handlers: [(c, next) => c.req.method === 'PROPFIND' ? c.text('found') : next()], page: { scripts: ['a'], title: 'first', meta: { a: true } } }) },
      { name: 'two', route: () => ({ page: { scripts: ['b'], title: 'last', meta: { b: true } } }) },
    ],
    pages: { handler: (_route, extras) => { captured = extras; return text('page'); } },
  });
  expect(await (await app.request('/', { method: 'PROPFIND' })).text()).toBe('found');
  expect(mergePageExtras(captured as Record<string, unknown>[])).toEqual({ scripts: ['a', 'b'], title: 'last', meta: { b: true } });
  expect(captured).toEqual([{ scripts: ['a'], title: 'first', meta: { a: true } }, { scripts: ['b'], title: 'last', meta: { b: true } }]);
});

it('does not treat a default export as a GET handler without an adapter', async () => {
  const app = createApp(manifest({ 'index.tsx': { default: () => { throw new Error('should not render'); } } }));
  expect((await app.request('/')).status).toBe(404);
});

it('permits method handlers to pass through into a page and unwind around it', async () => {
  const app = createApp(manifest({ 'index.tsx': { ...page, onGet: async (c: Context, next: () => Promise<void>) => { await next(); c.header('x-after', 'yes'); } } }), { pages });
  const response = await app.request('/');
  expect(await response.text()).toBe('page'); expect(response.headers.get('x-after')).toBe('yes');
});

it('passes handler errors through Hono error handling and rejects double next', async () => {
  const app = createApp(manifest({ 'index.ts': { onGet: async (_c: Context, next: () => Promise<void>) => { await next(); await next(); } } }));
  app.onError((first, second) => {
    // Hono 5 error handlers receive Context, Next; Hono 4 receives Error, Context.
    const error = typeof second === 'function' ? (first as unknown as Context).error! : first;
    return new Response(error.message, { status: 500 });
  });
  const response = await app.request('/');
  expect(response.status).toBe(500); expect(await response.text()).toContain('next() called multiple times');
});


it.each(['basename', 'missing'] as const)('scopes guards independently of %s middlewareFiles', async metadata => {
  const input = manifest({
    '(staff)/middleware.ts': { default: (c: Context) => c.text('blocked', 401) },
    '(staff)/admin/index.ts': { onGet: text('secret') },
    'zzz/middleware.ts': { default: pass },
  });
  for (const node of input.tree.children) node.middlewareFiles = metadata === 'basename' ? ['middleware.ts'] : undefined;
  expect((await createApp(input).request('/admin')).status).toBe(401);
});

it('keeps eleven metadata-free middleware in array order', async () => {
  const trace: number[] = [];
  const input = manifest({ '(g)/index.ts': { onGet: text('ok') } });
  const group = input.tree.children[0]!;
  delete group.middlewareFiles;
  group.middleware = Array.from({ length: 11 }, (_, i) => ({ default: async (_c: Context, next: () => Promise<void>) => { trace.push(i); await next(); } }));
  await createApp(input).request('/');
  expect(trace).toEqual(Array.from({ length: 11 }, (_, i) => i));
});

it('scopes extension arrays and per-method chains to their declared methods', async () => {
  const seen: string[] = [];
  const app = createApp(manifest({ 'index.ts': { onGet: text('get'), onPut: text('put') } }), {
    extensions: [{ name: 'actions', route: () => ({ methods: ['POST'], handlers: [(c) => { seen.push(c.req.method); return c.text('action'); }] }) },
      { name: 'other', route: () => ({ handlers: { DELETE: [text('deleted')] } }) }],
  });
  expect(await (await app.request('/?action=delete-account')).text()).toBe('get');
  expect(await (await app.request('/', { method: 'PUT' })).text()).toBe('put');
  expect((await app.request('/', { method: 'HEAD' })).status).toBe(200);
  expect(await (await app.request('/', { method: 'DELETE' })).text()).toBe('deleted');
  expect(await (await app.request('/', { method: 'POST' })).text()).toBe('action');
  expect(seen).toEqual(['POST']);
});

it('collapses ALL to one registration without duplicate native dispatch', async () => {
  let calls = 0;
  const app = createApp(manifest({ 'index.ts': { onGet: async (_c: Context, next: () => Promise<void>) => { calls++; await next(); } } }), {
    extensions: [{ name: 'any', route: () => ({ methods: ['ALL'], handlers: [pass] }) }],
  });
  expect((await app.request('/')).status).toBe(404);
  expect(calls).toBe(1);
  expect(new Set(app.routes.map(r => r.method))).toEqual(new Set(['ALL']));
});

it('calls and validates the page adapter only for own default exports', async () => {
  let calls = 0;
  const app = createApp(manifest({ '(a)/x/index.ts': { onPost: text('post') }, '(b)/x/index.ts': { onGet: text('get') } }), {
    pages: { handler: () => { calls++; return text('page'); } },
  });
  expect(await (await app.request('/x')).text()).toBe('get');
  expect(calls).toBe(0);
  expect(() => createApp(manifest({ 'index.tsx': page }), { pages: { handler: () => 42 as unknown as Handler } })).toThrow('page adapter handler');
});

it('provides frozen copies to hooks and named page contributions additively', async () => {
  let contributions: unknown;
  const app = createApp(manifest({ '(g)/middleware.ts': { default: (c: Context) => c.text('blocked', 401) }, '(g)/index.tsx': page }), {
    extensions: [{ name: 'first', route: route => {
      expect(Object.isFrozen(route)).toBe(true);
      expect(() => {
        // @ts-expect-error Hooks receive readonly containers, also frozen at runtime.
        route.middleware.pop();
      }).toThrow();
      return { page: { title: 'first' } };
    } }, { name: 'last', route: () => ({ page: { title: 'last' } }) }],
    pages: { handler: (_route, extras, named) => { expect(extras).toEqual([{ title: 'first' }, { title: 'last' }]); contributions = named; return text('page'); } },
  });
  expect((await app.request('/')).status).toBe(401);
  expect(contributions).toEqual([{ extension: 'first', page: { title: 'first' } }, { extension: 'last', page: { title: 'last' } }]);
});

it('types the returned Hono context variables with a generic Env', async () => {
  const app = createApp<{ Variables: { greeting: string } }>(manifest({ 'index.ts': { onGet: text('ok') } }));
  app.get('/typed', c => { c.set('greeting', 'hello'); return c.text(c.var.greeting); });
  expect(await (await app.request('/typed')).text()).toBe('hello');
});

it('puts custom regex params before plain params regardless of their names', async () => {
  const app = createApp(manifest({ '[n{[0-9]+}]/index.ts': { onGet: text('numeric') }, '[id]/index.ts': { onGet: text('plain') } }));
  expect(await (await app.request('/42')).text()).toBe('numeric');
  expect(await (await app.request('/abc')).text()).toBe('plain');
});


it.each([undefined, []])('rejects extension array handlers without declared methods (%j)', methods => {
  const input = manifest({ 'x/index.ts': { onGet: text('get') } });
  const create = () => createApp(input, { extensions: [{ name: 'csrf-guard', route: () => ({ methods, handlers: [pass] }) }] });
  expect(create).toThrow(RouteValidationError);
  expect(create).toThrow('extension csrf-guard for routes/x/index.ts returns array handlers without methods');
});

it.each(['array', 'map'] as const)('dispatches a HEAD-only extension %s through GET registration', async kind => {
  const seen: string[] = [];
  const head: Handler = c => { seen.push(c.req.method); return c.body(null, 204); };
  const app = createApp(manifest({ 'x/index.ts': {} }), {
    extensions: [{ name: 'head', route: () => kind === 'array'
      ? { methods: ['head'], handlers: [head] } : { handlers: { head: [head] } } }],
  });
  expect((await app.request('/x', { method: 'HEAD' })).status).toBe(204);
  expect((await app.request('/x')).status).toBe(404);
  expect((await app.request('/x', { method: 'POST' })).status).toBe(404);
  expect(seen).toEqual(['HEAD']);
  expect(new Set(app.routes.map(route => route.method))).toEqual(new Set(['GET']));
});

it('runs GET and HEAD extension chains once each for HEAD and keeps native GET dispatch', async () => {
  const seen: string[] = [];
  const record = (name: string): Handler => async (_c, next) => { seen.push(name); await next(); };
  const app = createApp(manifest({ 'index.ts': { onGet: text('get') } }), {
    extensions: [{ name: 'both', route: () => ({ handlers: { GET: [record('get')], HEAD: [record('head')] } }) }],
  });
  expect((await app.request('/', { method: 'HEAD' })).status).toBe(200);
  expect(seen).toEqual(['get', 'head']);
  seen.length = 0;
  expect(await (await app.request('/')).text()).toBe('get');
  expect(seen).toEqual(['get']);
});

it('runs extension middleware only on existing registrations and reserves fall-through from terminal handlers', async () => {
  const calls: string[] = [];
  const app = createApp(manifest({
    'x/index.tsx': { ...page, onRequest: text('onRequest'), onGet: text('onGet') },
    '(later)/[[rest]]/index.ts': { onGet: text('later') },
    'api/index.ts': { onPost: text('api') },
  }), { pages, extensions: [{ name: 'reserved', route: route => ({
    middleware: [async (_c, next) => { calls.push(route.file); await next(); }],
    reserved: c => route.file === 'routes/x/index.tsx' && c.req.query('reserved') !== undefined,
  }) }] });
  expect(await (await app.request('/x')).text()).toBe('onRequest');
  expect(await (await app.request('/x?reserved')).text()).toBe('later');
  expect((await app.request('/api', { method: 'DELETE' })).status).toBe(404);
  expect(calls).toEqual(['routes/x/index.tsx', 'routes/x/index.tsx', 'routes/(later)/[[rest]]/index.ts']);
});
