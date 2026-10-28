import { describe, expect, it, vi } from 'vitest';
import { createElement as h, dangerouslyPreventEscaping, Fragment, type Component, type ResolvedTemplateProps } from 'easy-jsx-html-engine';
import { Hono, type Context } from 'hono';
import { createApp, type DirNode, type Manifest, type ModuleNs, type RouterExtension, RouteValidationError } from '../../src/router/index.js';
import { createElement, DefaultRootHOC, ErrorBoundary, jsxPages, renderHeadElements, Suspense, type JSXPagesOptions, type RouteHead, type RouteProps } from '../../src/jsx/index.js';
import { jsx, jsxs } from '../../src/jsx/jsx-runtime.js';
import { SpreadWrapper, NestedSpreadWrapper } from './fixtures/runtime-wrapper.js';
import { jsxDEV } from '../../src/jsx/jsx-dev-runtime.js';

const Page = () => h('p', {}, 'page');
function node(module: ModuleNs, layouts: ModuleNs[] = [], path = '/'): DirNode {
  let tree: DirNode = { segment: '(page)', path, group: true, middleware: [], children: [], route: { file: 'routes/index.tsx', module } };
  for (const [i, layout] of [...layouts.entries()].reverse()) {
    tree = { segment: `(layout${i})`, path, group: true, middleware: [], children: [tree], layout };
  }
  if (path !== '/') tree = { segment: '[id]', path, group: false, middleware: [], children: [tree] };
  return { segment: '', path: '/', group: false, middleware: [], children: [tree] };
}
function app(module: ModuleNs = { default: Page }, root?: ModuleNs, layouts: ModuleNs[] = [], options: JSXPagesOptions = {}, extras: Record<string, unknown>[] = []) {
  const extensions: RouterExtension[] = extras.map(page => ({ name: 'test', route: () => ({ page }) }));
  return createApp({ version: 1, root, tree: node(module, layouts) }, { pages: jsxPages(options), extensions });
}
async function html(a: Hono, path = '/') {
  const res = await a.request(path);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/html');
  return res.text();
}
function onPageError(a: Hono, handler: (error: Error) => Response) {
  a.onError((first, second) => {
    // Same compatibility rule as the router tests: Hono 5 uses Context, Next.
    const error = typeof second === 'function' ? (first as unknown as Context).error! : first;
    return handler(error);
  });
}
const hoc = (name: string) => (Content: Component<RouteProps>) => (props: RouteProps) => h(name, {}, h(Content, props));

describe('jsxPages', () => {
  it('wraps layouts innermost outward, skipping head-only layouts, and uses namespace heads root to leaf', async () => {
    const calls: string[] = [];
    const extend = (name: string) => (_ctx: Context, prev: RouteHead) => { calls.push(name); return { title: `${prev.title}/${name}` }; };
    const result = await html(app({ default: Page, head: extend('page') },
      { default: hoc('root'), head: { title: 'root' } },
      [{ default: hoc('outer'), head: extend('outer') }, { head: extend('head-only') }, { default: hoc('inner'), head: extend('inner') }]));
    expect(calls).toEqual(['outer', 'head-only', 'inner', 'page']);
    expect(result).toBe('<root><meta name="recooler-route" content="/"/><outer><inner><p>page</p></inner></outer></root>');
  });

  it.each([undefined, null])('uses the default root when root.default is %s', async defaultExport => {
    const result = await html(app({ default: Page }, { default: defaultExport, head: { title: 'head-only root' } }));
    expect(result).toBe('<!DOCTYPE html><html><head><meta charset="utf-8"/><title>head-only root</title></head><body data-recooler-route="/"><p>page</p></body></html>');
  });

  it('leaves API-only modules to the router without calling the page adapter', () => {
    const manifest: Manifest = { version: 1, tree: node({ onGet: (c: Context) => c.text('api') }) };
    const pages = jsxPages();
    const handler = vi.spyOn(pages, 'handler');
    const a = createApp(manifest, { pages });
    expect(handler).not.toHaveBeenCalled();
    return expect(Promise.resolve(a.request('/')).then(r => r.text())).resolves.toBe('api');
  });

  it.each([undefined, null, 42, {}])('rejects an own non-function page default %s at router startup', value => {
    expect(() => app({ default: value })).toThrow(RouteValidationError);
    expect(() => app({ default: value })).toThrow('page default export in routes/index.tsx is not a function');
  });

  it('objects replace prior heads, nullish entries skip, function nullish results reset', async () => {
    const a = app({ default: Page, head: (_c: Context, prev: RouteHead) => ({ ...prev, title: `${prev.title}!` }) },
      { head: { title: 'root', links: [{ href: '/old' }] } }, [{ head: { title: 'replace' } }, { head: null }, {}]);
    expect(await html(a)).toContain('<title>replace!</title>');
    expect(await html(a)).not.toContain('/old');
    expect(await html(app({ default: Page, head: () => undefined }, { head: { title: 'old' } }))).not.toContain('<title>');
  });

  it.each([Promise.resolve({}), [], new Date(), 'bad', 7, true, { then() {} }])('rejects invalid head exports (%s)', async head => {
    const a = app({ default: Page, head });
    onPageError(a, err => { expect(err).toBeInstanceOf(TypeError); return new Response(err.message, { status: 500 }); });
    const res = await a.request('/');
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('Invalid head in routes/index.tsx');
  });

  it('rejects invalid head function results', async () => {
    for (const head of [() => 'bad']) {
      const a = app({ default: Page, head });
      onPageError(a, err => new Response(err.name, { status: 500 }));
      const response = await a.request('/');
      expect(response.status).toBe(500);
      expect(await response.text()).toBe('TypeError');
    }
  });

  it('isolates deeply nested head attributes and function-returned constants for concurrent requests', async () => {
    const exported = { title: 'base', metas: [{ name: 'x', content: 'a' }], links: [{ href: '/a' }], scripts: [{ src: '/a.js' }], base: { href: '/base' } };
    const snapshot = structuredClone(exported);
    const a = app({ default: Page, head: async (_ctx: Context, prev: RouteHead) => {
      await Promise.resolve();
      prev.metas![0]!.content += '!';
      prev.links![0]!.href += '!';
      prev.scripts![0]!.src += '!';
      (prev.base as { href: string }).href += '!';
      return prev;
    } }, { head: exported });
    const results = await Promise.all(Array.from({ length: 5 }, () => html(a)));
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toContain('content="a!"');
    expect(exported).toEqual(snapshot);
    const b = app({ default: Page, head: (_c: Context, prev: RouteHead) => { prev.metas![0]!.content += '!'; return prev; } }, { head: () => exported });
    expect(await html(b)).toBe(await html(b));
    expect(exported).toEqual(snapshot);
  });

  it('skips discarded head functions before the last replacing object, including live changes', async () => {
    const discarded = vi.fn(() => { throw new Response('must not run', { status: 418 }); });
    const layout: ModuleNs = { head: { title: 'replacement' } };
    const a = app({ default: Page }, { head: discarded }, [layout]);
    expect(await html(a)).toContain('<title>replacement</title>');
    expect(discarded).not.toHaveBeenCalled();
    layout.head = null;
    expect((await a.request('/')).status).toBe(418);
    expect(discarded).toHaveBeenCalledTimes(1);
  });

  it('retains non-plain head values and native ESM namespaces', async () => {
    class Version { toString() { return 'v42'; } }
    const a = app({ default: Page, head: { title: dangerouslyPreventEscaping('A &amp; B'),
      base: { href: new URL('https://example.com/') },
      metas: [{ name: 'promise', content: Promise.resolve('async-value') }, { name: 'version', content: new Version() }],
      scripts: [{ src: '/a.js', onload: function go() {} }],
    } });
    const result = await html(a);
    expect(result).toContain('<title>A &amp; B</title>');
    expect(result).toContain('href="https://example.com/"');
    expect(result).toContain('content="async-value"');
    expect(result).toContain('content="v42"');
    // Vite leaves dynamic data-URL imports to native ESM.
    const namespaceURL = 'data:text/javascript,export const title = "namespace"';
    const namespace = await import(/* @vite-ignore */ namespaceURL);
    expect(await html(app({ default: Page, head: namespace }))).toContain('<title>namespace</title>');
  });

  it('identifies head sources and wraps access/function failures with their cause', async () => {
    const bad = { get title() { throw new Error('getter failed'); } };
    for (const [module, root, layouts, source] of [
      [{ default: Page, head: bad }, undefined, [], 'routes/index.tsx'],
      [{ default: Page }, { head: bad }, [], 'root (used by routes/index.tsx)'],
      [{ default: Page }, undefined, [{ head: () => { throw new Error('function failed'); } }], 'layout 1 (used by routes/index.tsx)'],
    ] as const) {
      const a = app(module, root, [...layouts]);
      onPageError(a, error => {
        expect(error.cause).toBeInstanceOf(Error);
        return new Response(error.message, { status: 500 });
      });
      const response = await a.request('/');
      expect(response.status).toBe(500);
      expect(await response.text()).toContain(source);
    }
  });

  it('uses router-provided root/layout filenames for head access and validation errors', async () => {
    for (const source of ['src/root.tsx', 'src/routes/layout.tsx']) {
      for (const entry of [
        { get head() { throw new Error('export getter'); } },
        { head: 42 },
        { head: () => { throw new Error('head function'); } },
      ]) {
        const tree = node({ default: Page });
        if (source === 'src/routes/layout.tsx') {
          tree.layout = entry;
          tree.layoutFile = source;
        }
        const a = createApp({ version: 1, tree,
          root: source === 'src/root.tsx' ? entry : undefined, rootFile: 'src/root.tsx',
        }, { pages: jsxPages({ handlerFactory(page, render) {
          expect(Object.isFrozen(page.route)).toBe(true);
          expect(Object.isFrozen(page.route.layouts)).toBe(true);
          expect(Object.isFrozen(page.route.layoutFiles)).toBe(true);
          return render;
        } }) });
        onPageError(a, error => new Response(error.message, { status: 500 }));
        const response = await a.request('/');
        expect(response.status).toBe(500);
        expect(await response.text()).toContain(`Head in ${source}:`);
      }
    }
  });

  it('reads live namespace exports at request time', async () => {
    const module = { default: Page, head: { title: 'before' } };
    const a = app(module);
    expect(await html(a)).toContain('before');
    module.head = { title: 'after' };
    expect(await html(a)).toContain('after');
  });

  it.each([{ charset: 'utf-8' }, { charSet: 'utf-8' }, { CHARSET: 'iso-8859-1' }, { charset: 0 }])('does not duplicate a rendered charset %s', async meta => {
    const result = await html(app({ default: Page, head: { metas: [meta] } }));
    expect(result.match(/charset/gi)).toHaveLength(1);
  });

  it.each([undefined, { charset: undefined }, { charset: false }, { charset: '' }])('adds charset for an omitted attribute %s', async meta => {
    expect(await html(app({ default: Page, head: { metas: [meta] } }))).toContain('<meta charset="utf-8"/>');
  });

  it('renders every head element in reference order', async () => {
    expect((await renderHeadElements({ title: 'a & b', base: { href: '/base' }, metas: [{ name: 'x', content: 'y' }], links: [{ rel: 'icon', href: '/icon' }], scripts: [{ src: '/head.js' }] })).toHTML()).toBe('<title>a &amp; b</title><base href="/base"/><meta name="x" content="y"/><link rel="icon" href="/icon"/><script src="/head.js"></script>');
  });

  it('passes request props, preserves response headers/status and supports a handler factory', async () => {
    let seen: RouteProps | undefined;
    const a = app({ default: (props: RouteProps) => { seen = props; return h('p', {}, props.url.search); } }, undefined, [], {
      handlerFactory(page, render) {
        expect(page.route.path).toBe('/');
        return (c, next) => { c.header('x-custom', 'yes'); c.status(202); return render(c, next); };
      },
    });
    const res = await a.request('/?foo=1');
    expect(res.status).toBe(202);
    expect(res.headers.get('x-custom')).toBe('yes');
    expect(await res.text()).toContain('?foo=1');
    expect(seen?.ctx).toBeDefined();
    expect(seen?.rid).toBeDefined();
    expect(seen?.url.href).toBe('http://localhost/?foo=1');
  });
});

describe('client script URLs and route metadata', () => {
  it('concatenates extras in extension order and renders external module scripts', async () => {
    const scripts = ['/one.js'];
    const result = await html(app({ default: Page }, undefined, [], {}, [{ scripts }, { scripts: ['/two.js'] }]));
    expect(result).toContain('<body data-recooler-route="/">');
    expect(result).toContain('<script type="module" src="/one.js"></script><script type="module" src="/two.js"></script>');
    expect(scripts).toEqual(['/one.js']);
  });

  it('uses props.scripts per request and emits only one marker when a root wraps DefaultRootHOC', async () => {
    const received: string[][] = [];
    const Root = (Content: Component<RouteProps>, clientScript?: string) => {
      expect(clientScript).toBeUndefined();
      const Default = DefaultRootHOC(Content);
      return (props: RouteProps) => {
        received.push(props.scripts);
        props.scripts.push('/root.js');
        return Default(props);
      };
    };
    const a = app({ default: Page }, { default: Root }, [], {}, [{ scripts: ['/entry.js'] }]);
    const result = await html(a);
    expect(result).toBe(await html(a));
    expect(result).toContain('<body data-recooler-route="/"><p>page</p>');
    expect(result).not.toContain('name="recooler-route"');
    expect(received[0]).not.toBe(received[1]);
    expect(received[0]).toEqual(['/entry.js', '/root.js']);
  });

  it('passes undefined to a verbatim legacy root even when extensions supply URL scripts', async () => {
    const { default: Root } = await import('./fixtures/custom-root/src/root.js');
    for (const extras of [[], [{ scripts: ['/one.js'] }]]) {
      const result = await html(app({ default: Page }, { default: Root }, [], {}, extras));
      expect(result).not.toContain('<script>');
      expect(result).not.toContain('/one.js');
    }
  });

  it('keeps the legacy string available to custom roots without inlining it in the default root', async () => {
    let legacy: string | undefined;
    const Root = (Content: Component<RouteProps>, script?: string) => { legacy = script; return DefaultRootHOC(Content, script); };
    const source = 'window.legacy = true';
    expect(await html(app({ default: Page }, { default: Root }, [], {}, [{ clientScript: source }]))).not.toContain(source);
    expect(legacy).toBe(source);
    expect(await html(app({ default: Page }, undefined, [], {}, [{ clientScript: source }, { scripts: ['/entry.js'] }]))).toContain('src="/entry.js"');
  });

  it('emits a route-pattern meta for custom bodies even without renderHeadElements', async () => {
    const manifest: Manifest = { version: 1, root: { default: hoc('body') }, tree: node({ default: Page }, [], '/:id') };
    const a = new Hono().route('/mount', createApp(manifest, { pages: jsxPages() }));
    expect(await html(a, '/mount/42')).toBe('<body><meta name="recooler-route" content="/:id"/><p>page</p></body>');
  });

  it('has no legacy ?script endpoint', async () => {
    expect(await html(app(), '/?script')).toContain('<p>page</p>');
  });

  it('rejects malformed extras early', () => {
    for (const extra of [{ scripts: 'bad' }, { scripts: [1] }, { clientScript: {} }]) {
      expect(() => app({ default: Page }, undefined, [], {}, [extra])).toThrow(TypeError);
    }
  });
});

describe('Context attributes', () => {
  it('filters spreads in real TSX wrappers without any transform', async () => {
    const a = app({ default: ({ ctx }: RouteProps) => h(Fragment, {},
      h(SpreadWrapper, { ctx, title: 'plain' }), h(NestedSpreadWrapper, { ctx, title: 'outer' })) });
    const result = await html(a);
    expect(result).toContain('<button title="plain">spread</button><button title="nested">nested</button>');
    expect(result).not.toContain('[object Object]');
  });
  it.each([jsx, jsxs, jsxDEV])('filters any intrinsic Context-valued attribute, preserving components and ordinary ctx values', async runtime => {
    let received: Context | undefined;
    const Wrapper = (props: { ctx: Context; title: string }) => {
      received = props.ctx;
      return runtime('button', { ...{ ...props, title: 'nested' }, 'data-context': props.ctx, children: 'go' });
    };
    const result = await html(app({ default: ({ ctx }: RouteProps) => runtime(Wrapper, { ctx, title: 'outer' }) }));
    expect(received).toBeDefined();
    expect(result).toContain('<button title="nested">go</button>');
    expect(result).not.toContain('[object Object]');
    expect((await runtime('div', { ctx: 'user data', title: 'ok' })).toHTML()).toBe('<div ctx="user data" title="ok"></div>');
  });

  it('filters classic createElement and Contexts from other Hono copies', async () => {
    const { Context: OtherContext } = await import('hono-412');
    const ctx = new OtherContext(new Request('http://localhost'));
    expect((await createElement('li', { ctx, 'data-context': ctx, title: 'ok' }, 'item')).toHTML()).toBe('<li title="ok">item</li>');
    expect((await jsx('div', { ctx, children: 'ok' })).toHTML()).toBe('<div>ok</div>');
    expect((await jsx('div', { ctx: { get() {}, set() {} } })).toHTML()).toContain('ctx="[object Object]"');
  });

  it('does not mutate frozen props and removes attributes entirely without stray whitespace', async () => {
    const ctx = new (await import('hono')).Context(new Request('http://localhost'));
    const props = Object.freeze({ ctx });
    expect((await jsx('div', props)).toHTML()).toBe('<div></div>');
    expect(props.ctx).toBe(ctx);
  });
});

describe('ErrorBoundary and Responses', () => {
  it('renders custom catches for async errors and lazy synchronous errors', async () => {
    const error = new Error('failure');
    for (const children of [Promise.reject(error), [() => { throw error; }]]) {
      const boundary = ErrorBoundary({ children: children as [() => never], catch: () => h('b', {}, 'caught') });
      expect((await boundary).toHTML()).toBe('<b>caught</b>');
    }
    expect((await ErrorBoundary({ children: Promise.reject(error), catch: 'fallback' })).toHTML()).toBe('fallback');
  });

  it('uses the default catch for ordinary errors', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await ErrorBoundary({ children: [() => { throw new Error('secret failure'); }] })).toHTML()).toBe('<pre>Internal Server Error</pre>');
      expect((await ErrorBoundary({ children: [() => { throw new Error('failure'); }], showStack: true })).toHTML()).toContain('<pre>Error: failure');
    }
    finally { log.mockRestore(); }
  });

  it('returns a Response thrown by a handlerFactory wrapper', async () => {
    const a = app({ default: Page }, undefined, [], { handlerFactory: () => async () => {
      throw new Response('wrapped', { status: 401 });
    } });
    const response = await a.request('/');
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('wrapped');
  });

  it('lets Responses escape Suspense without a streaming request', async () => {
    const a = app({ default: () => Suspense({ children: Promise.reject(new Response('redirect', { status: 303 })),
      catch: () => h('p', {}, 'must not catch') }) });
    const response = await a.request('/');
    expect(response.status).toBe(303);
    expect(await response.text()).toBe('redirect');
  });

  it('returns Responses thrown by head, root, layout, page, async page, or a boundary', async () => {
    const response = () => new Response('redirect', { status: 303, headers: { location: '/elsewhere' } });
    const Throw = () => { throw response(); };
    const AsyncThrow = async () => { throw response(); };
    const cases = [app({ default: Throw }), app({ default: AsyncThrow }), app({ default: Page, head: Throw }),
      app({ default: Page }, { default: () => Throw }), app({ default: Page }, undefined, [{ default: () => Throw }]),
      app({ default: () => ErrorBoundary({ children: [Throw], catch: () => h('p', {}, 'must not catch') }) }),
      app({ default: () => ErrorBoundary({ children: Promise.reject(new Error()), catch: Throw }) })];
    for (const a of cases) {
      const res = await a.request('/');
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/elsewhere');
      expect(await res.text()).toBe('redirect');
    }
  });
});

describe('Suspense streaming', () => {
  it('keeps params available to a Suspense child after the page handler returns', async ({ task }) => {
    let release!: () => void;
    const deferred = new Promise<void>(resolve => { release = resolve; });
    let childFinished = false;
    const Child = async (props: RouteProps) => {
      await deferred;
      childFinished = true;
      expect(props.params).toEqual({ id: '42' });
      expect(Object.isFrozen(props.params)).toBe(true);
      // Hono 5 loses the active route match after dispatch. The snapshot survives.
      expect(props.ctx.req.param()).toEqual(task.file.projectName === 'hono-5' ? {} : { id: '42' });
      return h('p', {}, props.params.id);
    };
    const manifest: Manifest = { version: 1, tree: node({ default: (props: RouteProps) =>
      h(Suspense, { rid: props.rid, fallback: 'loading' }, h(Child, props)) }, [], '/:id') };
    const a = new Hono().use('*', async (_ctx, next) => { await next(); })
      .route('/mount', createApp(manifest, { pages: jsxPages() }));
    const response = await a.request('/mount/42');
    expect(response.status).toBe(200);
    expect(childFinished).toBe(false);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let result = decoder.decode((await reader.read()).value);
    expect(result).toContain('loading');
    release();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      result += decoder.decode(chunk.value);
    }
    expect(childFinished).toBe(true);
    expect(result).toContain('<p>42</p>');
    expect(result).not.toContain('Internal Server Error');
  });

  it('renders synchronous Suspense children without a fallback or streaming scripts', async () => {
    const result = await html(app({ default: ({ rid }: RouteProps) => h(Suspense, { rid, fallback: 'loading' }, 'ready') }));
    expect(result).toContain('<body data-recooler-route="/">ready</body>');
    expect(result).not.toContain('data-suspense');
  });

  it('awaits async shell status and handles a shell Response after Suspense registers', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const fail of [false, true]) {
        const tasks: Promise<unknown>[] = [];
        const Shell = async ({ ctx }: RouteProps) => {
          await Promise.resolve();
          if (fail) throw new Response('shell redirect', { status: 303 });
          ctx.status(404);
          return h('p', {}, 'missing');
        };
        const a = app({ default: (props: RouteProps) => h(Fragment, {},
          h(Suspense, { rid: props.rid, fallback: 'loading' }, Promise.resolve('done')), h(Shell, props)) });
        const response = await a.request('/', undefined, undefined, { waitUntil: p => { tasks.push(p); }, passThroughOnException() {}, props: {} });
        expect(response.status).toBe(fail ? 303 : 404);
        const body = await response.text();
        expect(body).toContain(fail ? 'shell redirect' : '<p>missing</p>');
        await Promise.all(tasks);
        expect(log).not.toHaveBeenCalled();
      }
      await vi.waitFor(() => expect((globalThis as any).SUSPENSE_ROOT.requests.size).toBe(0));
    } finally { log.mockRestore(); }
  });

  it('cleans up cancelled streams and HEAD requests without logging errors or unhandled rejections', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const a = app({ default: ({ rid }: RouteProps) => h(Suspense, { rid, fallback: 'loading' }, Promise.resolve('done')) });
      const tasks: Promise<unknown>[] = [];
      const executionCtx = { waitUntil: (p: Promise<unknown>) => { tasks.push(p); }, passThroughOnException() {}, props: {} };
      const response = await a.request('/', undefined, undefined, executionCtx);
      const reader = response.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      await reader.cancel('disconnected');
      for (let i = 0; i < 5; i++) {
        const head = await a.request('/', { method: 'HEAD' }, undefined, executionCtx);
        expect(head.status).toBe(200);
        expect(await head.text()).toBe('');
      }
      await Promise.all(tasks);
      expect((globalThis as any).SUSPENSE_ROOT.requests.size).toBe(0);
      expect(log).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });

  it('lets Hono handle a shell Error once after Suspense registers', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('shell failure');
    const tasks: Promise<unknown>[] = [];
    try {
      const Shell = async () => { await Promise.resolve(); throw error; };
      const a = app({ default: ({ rid }: RouteProps) => h(Fragment, {},
        h(Suspense, { rid, fallback: 'loading' }, Promise.resolve('done')), h(Shell, {})) });
      onPageError(a, error => { console.error(error); return new Response('failed', { status: 500 }); });
      const response = await a.request('/', undefined, undefined, { waitUntil: p => { tasks.push(p); }, passThroughOnException() {}, props: {} });
      expect(response.status).toBe(500);
      expect(await response.text()).toBe('failed');
      await Promise.all(tasks);
      expect(log).toHaveBeenCalledExactlyOnceWith(error);
      expect((globalThis as any).SUSPENSE_ROOT.requests.size).toBe(0);
    } finally { log.mockRestore(); }
  });

  it('still logs deferred stream failures after the shell succeeds', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('template failure');
    const tasks: Promise<unknown>[] = [];
    try {
      const a = app({ default: ({ rid }: RouteProps) => h(Suspense, { rid, fallback: 'loading' }, Promise.resolve('done')) }, undefined, [], {
        ResolvedTemplate: () => { throw error; },
      });
      const response = await a.request('/', undefined, undefined, { waitUntil: p => { tasks.push(p); }, passThroughOnException() {}, props: {} });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('loading');
      await Promise.all(tasks);
      expect(log).toHaveBeenCalledExactlyOnceWith(error);
    } finally { log.mockRestore(); }
  });

  it('logs streaming Responses and renders catch content without exposing stack traces', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const custom of [false, true]) {
        const responseError = new Response('redirect', { status: 303 });
        const a = app({ default: ({ rid }: RouteProps) => Suspense({ rid, fallback: 'loading',
          children: Promise.reject(responseError), catch: custom ? () => h('b', {}, 'caught') : undefined }) });
        const response = await a.request('/');
        expect(response.status).toBe(200);
        const body = await response.text();
        expect(body).toContain(custom ? '<b>caught</b>' : '<pre>Internal Server Error</pre>');
        expect(body).not.toContain('[object Response]');
        expect(log).toHaveBeenCalledWith(responseError);
      }
    } finally { log.mockRestore(); }
  });

  it('sends fallbacks first and resolved children in completion order, with template/cleanup hooks and waitUntil', async () => {
    let finishSlow!: (value: string) => void;
    let finishFast!: (value: string) => void;
    const slow = new Promise<string>(resolve => { finishSlow = resolve; });
    const fast = new Promise<string>(resolve => { finishFast = resolve; });
    const a = app({ default: ({ rid }: RouteProps) => h(Fragment, {},
      h(Suspense, { rid, fallback: 'slow fallback' }, slow), h(Suspense, { rid, fallback: 'fast fallback' }, fast)) }, undefined, [], {
      ResolvedTemplate: ({ id, children }: ResolvedTemplateProps) => h('aside', { 'data-resolved': id }, children),
      suspenseCleanupScriptMiddleware: script => `custom(${JSON.stringify(script)})`,
    });
    const tasks: Promise<unknown>[] = [];
    const response = await a.request('/', undefined, undefined, { waitUntil: p => { tasks.push(p); }, passThroughOnException() {}, props: {} });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const initial = decoder.decode((await reader.read()).value);
    expect(initial).toContain('slow fallback');
    expect(initial).toContain('fast fallback');
    expect(initial).not.toContain('data-resolved');
    const loader = decoder.decode((await reader.read()).value);
    expect(loader).toContain('window.suspense');
    finishFast('FAST');
    expect(decoder.decode((await reader.read()).value)).toBe('<aside data-resolved="1">FAST</aside>');
    finishSlow('SLOW');
    expect(decoder.decode((await reader.read()).value)).toBe('<aside data-resolved="0">SLOW</aside>');
    expect(decoder.decode((await reader.read()).value)).toContain('custom("suspense.cleanup()")');
    expect((await reader.read()).done).toBe(true);
    await Promise.all(tasks);
    expect(tasks).toHaveLength(1);
  });
});
