import { describe, expect, it } from 'vitest';
import type { ModuleNs } from '../../src/router/index.js';
import { compareRoutePaths, createApp, resolveRoutes, routePathShape, routeSegment, isGroupSegment } from '../../src/router/index.js';
import { manifest } from './helpers.js';
const page = { default: () => null };
const mw = () => ({ default: async (_c: unknown, next: () => Promise<void>) => next() });
const handler = () => undefined;

describe('reference path ordering', () => {
  const paths = ['/', '/:other{.+}', '/:rest{.+}', '/:rest{.+}/x', '/:id', '/:a/:b', '/:a/new', '/about', '/blog', '/blog/:post', '/blog/:slug', '/top/:id', '/top/new', '/top/:rest{.+}'];
  it('ports the total deterministic order from routes.rs', () => {
    const expected = ['/', '/about', '/blog', '/blog/:post', '/blog/:slug', '/top/new', '/top/:id', '/top/:rest{.+}', '/:id', '/:a/new', '/:a/:b', '/:rest{.+}/x', '/:other{.+}', '/:rest{.+}'];
    expect([...paths].sort(compareRoutePaths)).toEqual(expected);
    expect([...paths].reverse().sort(compareRoutePaths)).toEqual(expected);
    for (const a of paths) for (const b of paths) {
      expect(Math.sign(compareRoutePaths(a, b)) + Math.sign(compareRoutePaths(b, a))).toBe(0);
      expect(compareRoutePaths(a, b) === 0).toBe(a === b);
    }
  });
  it.each([
    ['/new', '/:id'], ['/:id', '/:rest{.+}'], ['/top/:id', '/:a/new'], ['/:b/x', '/:a/:c'],
    ['/', '/about'], ['/blog', '/blog/:post'], ['/a/:rest{.+}', '/:rest{.+}'],
    ['/:a/:rest{.+}', '/:rest{.+}'], ['/:rest{.+}/x', '/:rest{.+}'], ['/re/:id/edit', '/re/:p{.*}'], ['/re/:id', '/re/:p{.*}'],
  ])('%s precedes %s', (a, b) => expect(compareRoutePaths(a, b)).toBeLessThan(0));
  it('prioritizes custom patterns regardless of param names', () => {
    expect(compareRoutePaths('/:a{[0-9]+}', '/:z')).toBeLessThan(0);
    expect(compareRoutePaths('/:z{[0-9]+}', '/:a')).toBeLessThan(0);
  });
  it('keeps custom patterns in conflict shapes', () => {
    expect(routePathShape('/:id/x')).toBe('/:/x');
    expect(routePathShape('/a/:n{\\d+}')).toBe('/a/:{\\d+}');
    expect(routePathShape('/a/:rest{.+}')).toBe('/a/:{.+}');
  });
  it.each([
    ['[n{[0-9]+}]', ':n{[0-9]+}'], ['[n{a{2}}]', ':n{a{2}}'], ['[n{a]', '[n{a]'], ['[n{a}x]', '[n{a}x]'], ['[id]', ':id'], ['[p{regex}]', ':p{regex}'], ['[[rest]]', ':rest{.+}'],
    ['[]', '[]'], ['[[]]', '[[]]'], ['[id', '[id'], ['[a]]', '[a]]'], ['[post-id]', ':post-id'], ['[[a[b]]', ':a[b{.+}'],
  ])('converts %s exactly like the reference', (input, output) => expect(routeSegment(input)).toBe(output));
  it.each(['(a.b)', '(v2.0)', '(a(b)', '(日本語)'])('recognizes group %s', s => expect(isGroupSegment(s)).toBe(true));
  it.each(['()', '(', '(a)b)', 'plain'])('preserves literal directory %s', s => expect(isGroupSegment(s)).toBe(false));
});

it('orders all groups together, chains scoped middleware, and leaves plain prefixes first', () => {
  const routes = ['/', '/top/new', '/top/:id', '/(a)/docs/:slug', '/(m)/docs/new', '/(a)/:rest{.+}', '/(a)/(b)/nested', '/(z)/zed', '/plain', '/foo/(g)', '/foo/(g)/bar'];
  const middlewares = ['/', '/(a)', '/(a)/(b)', '/(m)/docs', '/foo/(g)'];
  const files: Record<string, ModuleNs> = {};
  for (const r of routes) files[(r === '/' ? '' : r.slice(1) + '/') + 'index.tsx'] = page;
  for (const r of middlewares) files[(r === '/' ? '' : r.slice(1) + '/') + 'middleware.ts'] = mw();
  const plan = resolveRoutes(manifest(files));
  expect(plan.errors).toEqual([]);
  expect(plan.routes.map(r => r.path)).toEqual(['/', '/docs/new', '/docs/:slug', '/foo', '/foo/bar', '/nested', '/plain', '/top/new', '/top/:id', '/zed', '/:rest{.+}']);
  expect(plan.middlewares.map(m => m.path)).toEqual(['*']);
  expect(plan.lateMiddlewares.map(m => m.path)).toEqual(['/docs/*']);
  expect(plan.routes.map(r => r.middleware.length)).toEqual([0, 1, 1, 1, 1, 2, 0, 0, 0, 0, 1]);
});

it('orders directory middleware shallowest first, then by path and filename', () => {
  const plan = resolveRoutes(manifest({
    'admin/sub/index.ts': {}, 'middleware.ts': mw(), '[id]/middleware.ts': mw(),
    'admin/sub/middleware.ts': mw(), '(s)/admin/middleware.ts': mw(),
    'admin/middleware@20.ts': mw(), 'admin/middleware@10.ts': mw(),
  }));
  expect(plan.middlewares.map(m => m.file)).toEqual(['routes/middleware.ts', 'routes/admin/middleware@10.ts', 'routes/admin/middleware@20.ts', 'routes/[id]/middleware.ts', 'routes/admin/sub/middleware.ts']);
  expect(plan.routes[0]!.middleware).toEqual([]);
});

it('orders pages ahead of same-shaped routes, then by path and group', () => {
  const plan = resolveRoutes(manifest({
    '(a)/posts/[id]/index.ts': { onPost: handler }, '(z)/posts/[slug]/index.tsx': page,
    '(b)/about/index.ts': { onPost: handler }, '(a)/about/index.ts': { onPut: handler },
  }));
  expect(plan.errors).toEqual([]);
  expect(plan.routes.map(r => r.file)).toEqual(['routes/(a)/about/index.ts', 'routes/(b)/about/index.ts', 'routes/(z)/posts/[slug]/index.tsx', 'routes/(a)/posts/[id]/index.ts']);
});

it('preserves the full root-to-leaf layout chain, even head-only layouts', () => {
  const outer = { head: {} }, inner = { default: handler }, root = { default: handler };
  const plan = resolveRoutes(manifest({ 'layout.ts': outer, '(g)/layout.ts': inner, '(g)/index.tsx': page }, root));
  expect(plan.routes[0]!.layouts).toEqual([outer, inner]);
  expect(plan.routes[0]!.root).toBe(root);
});

it.each([
  [{ '[id]/index.tsx': page, '[slug]/index.tsx': page }, 'both respond to GET'],
  [{ '(a)/about/index.tsx': page, '(b)/about/index.tsx': page }, 'both respond to GET'],
  [{ '(a)/index.tsx': page, '(b)/index.ts': { onGet: handler } }, 'onGet (GET)'],
  [{ '(a)/index.tsx': page, '(b)/index.ts': { onRequest: handler } }, 'onRequest (every method)'],
  [{ '(a)/index.ts': { onPut: handler }, '(b)/index.ts': { onPut: handler } }, 'both respond to PUT'],
  [{ '[id]/index.ts': {}, ':id/index.ts': {} }, 'only one route may be used per path'],
  [{ '[id]/layout.ts': {}, ':id/layout.ts': {} }, 'only one layout may be used per path'],
  [{ 'middleware.ts': {} }, 'middleware routes/middleware.ts has no default export'],
] as [Record<string, ModuleNs>, string][])('validates terminal conflicts and metadata: %s', (files, expected) => {
  const input = manifest(files);
  const errors = resolveRoutes(input).errors.join('\n');
  expect(errors).toContain(expected);
  for (const name of Object.keys(files)) expect(errors).toContain(name);
  expect(() => createApp(input)).toThrow(expected);
});

it('allows distinct regex patterns and methods, and action-only routes', () => {
  expect(resolveRoutes(manifest({
    '(pub)/[id]/index.tsx': page, '(admin)/[slug]/index.ts': { onPost: handler },
    '[n{[0-9]+}]/index.tsx': page, '(empty)/[id]/index.ts': {},
  })).errors).toEqual([]);
});

it('warns for near misses without invoking them', () => {
  const warnings: string[] = [];
  createApp(manifest({ 'index.ts': { onget: handler, OnPost: handler, onrequest: handler, onLoad: handler } }), { warn: w => warnings.push(w) });
  expect(warnings).toEqual(['WARNING: found export onget but expected onGet in routes/index.ts', 'WARNING: found export OnPost but expected onPost in routes/index.ts', 'WARNING: found export onrequest but expected onRequest in routes/index.ts']);
});

it('shares layouts and group middleware across [id] and :id directory aliases', () => {
  const layout = { head: {} }, middleware = mw();
  const plan = resolveRoutes(manifest({
    '(g)/[id]/layout.ts': layout, '(g)/[id]/middleware.ts': middleware,
    '(g)/:id/index.tsx': page,
  }));
  expect(plan.errors).toEqual([]);
  expect(plan.routes[0]!.layouts).toEqual([layout]);
  expect(plan.routes[0]!.middlewareModules).toEqual([middleware]);
});

it('orders late prefix middleware by directory paths, before appending /*', () => {
  const plan = resolveRoutes(manifest({
    '(a)/(b)/[[rest]]/middleware.ts': mw(), '(g)/[[rest]]/x/middleware.ts': mw(),
  }));
  expect(plan.lateMiddlewares.map(m => m.path)).toEqual(['/:rest{.+}/x/*', '/:rest{.+}/*']);
});


it('preserves source ids alongside root, layouts and scoped middleware', () => {
  const input = manifest({ 'layout.ts': {}, '(g)/layout.ts': {}, '(g)/middleware.ts': mw(), '(g)/index.tsx': page }, {});
  input.rootFile = 'root.tsx';
  const route = resolveRoutes(input).routes[0]!;
  expect(route.layoutFiles).toEqual(['routes/layout.ts', 'routes/(g)/layout.ts']);
  expect(route.rootFile).toBe('root.tsx');
  expect(route.middlewareFiles).toEqual(['routes/(g)/middleware.ts']);
});
