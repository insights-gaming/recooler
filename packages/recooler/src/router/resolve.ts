import type { MiddlewareHandler } from 'hono';
import type { DirNode, Manifest, ModuleNs, ResolvedMiddleware, ResolvedRoute, RoutePlan } from './types.js';

export const methodExports = {
  onGet: 'GET', onPost: 'POST', onPut: 'PUT', onDelete: 'DELETE', onPatch: 'PATCH', onOptions: 'OPTIONS',
} as const;
export const lexical = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export function isGroupSegment(segment: string): boolean {
  return segment.length > 2 && segment.startsWith('(') && segment.endsWith(')') && !segment.slice(1, -1).includes(')');
}
export function routeSegment(segment: string): string {
  return segment.replace(/^\[([^\[\]][^\]]*)\]$/, ':$1').replace(/^\[\[([^\]]+)\]\]$/, ':$1{.+}');
}
export function routePathWithoutGroups(path: string): string {
  return '/' + path.split('/').filter(s => s && !isGroupSegment(s)).join('/');
}
function kind(s: string): number {
  return !s.startsWith(':') ? 0 : s.endsWith('{.+}') || s.endsWith('{.*}') ? 2 : 1;
}
/** Exact 0.0.27 comparator: regex params share the ordinary-param class. */
export function compareRouteShapes(a: string, b: string): number {
  const aa = a.split('/').filter(Boolean), bb = b.split('/').filter(Boolean);
  let afterCatchAll = false;
  for (let i = 0; ; i++) {
    const x = aa[i], y = bb[i];
    if (x === undefined || y === undefined) {
      if (x === y) return 0;
      return (x === undefined ? -1 : 1) * (afterCatchAll ? -1 : 1);
    }
    const k = kind(x);
    const order = k - kind(y) || (k === 0 ? lexical(x, y) : 0);
    if (order) return order;
    afterCatchAll = k === 2;
  }
}
export function compareRoutePaths(a: string, b: string): number {
  return compareRouteShapes(a, b) || lexical(a, b);
}
export function routePathShape(path: string): string {
  return path.split('/').map(s => s.startsWith(':') ? ':' + (s.includes('{') ? s.slice(s.indexOf('{')) : '') : s).join('/');
}
const usePath = (path: string) => path === '/' ? '*' : path + '/*';
const has = (ns: ModuleNs, key: string) => Object.hasOwn(ns, key);
function terminalHandlers(ns: ModuleNs): [string, string][] {
  if (has(ns, 'onRequest')) return [['every method', 'onRequest']];
  const result: [string, string][] = has(ns, 'default') ? [['GET', 'the page']] : [];
  for (const [name, method] of Object.entries(methodExports)) if (has(ns, name)) result.push([method, name]);
  return result.sort((a, b) => lexical(a.join(), b.join()));
}

/** Pure planning and diagnostics; never constructs or imports a Hono app. */
export function resolveRoutes(manifest: Manifest): RoutePlan {
  const plan: RoutePlan = { routes: [], middlewares: [], lateMiddlewares: [], errors: [], warnings: [] };
  if (manifest.version !== 1) plan.errors.push(`unsupported manifest version ${manifest.version}`);
  const dirs: { node: DirNode; directory: string; canonical: string; depth: number; inside: boolean }[] = [];
  const routesByDir = new Map<string, string>();
  const layoutsByDir = new Map<string, string>();
  function walk(node: DirNode, segments: string[], layouts: ModuleNs[], chain: ResolvedMiddleware[], inside: boolean) {
    const directory = '/' + segments.join('/');
    const canonical = '/' + segments.map(routeSegment).join('/');
    const path = routePathWithoutGroups(canonical);
    inside ||= node.group;
    dirs.push({ node, directory, canonical, depth: segments.length, inside });
    if (node.path !== path) plan.errors.push(`directory ${directory} has path ${node.path}, expected ${path}`);
    if (node.layout) {
      const file = node.layoutFile ?? `${directory}/layout`;
      const other = layoutsByDir.get(canonical);
      if (other) plan.errors.push(`only one layout may be used per path, found ${other} and ${file} for ${canonical}`);
      layoutsByDir.set(canonical, file);
      layouts = [...layouts, node.layout];
    }
    const middleware = node.middleware.map((module, i): ResolvedMiddleware => {
      const file = node.middlewareFiles?.[i] ?? `${directory}/middleware[${i}]`;
      if (!has(module, 'default')) plan.errors.push(`middleware ${file} has no default export`);
      else if (typeof module.default !== 'function') plan.errors.push(`middleware ${file} default export is not a function`);
      return { path: usePath(path), file, module, handler: module.default as MiddlewareHandler };
    });
    if (inside) {
      chain = [...chain, ...middleware];
      if (!node.group) plan.lateMiddlewares.push(...middleware);
    } else plan.middlewares.push(...middleware);
    if (node.route) {
      const { file, module } = node.route;
      const other = routesByDir.get(canonical);
      if (other) plan.errors.push(`only one route may be used per path, found ${other} and ${file} for ${canonical}`);
      routesByDir.set(canonical, file);
      for (const name of Object.keys(module)) {
        const expected = [...Object.keys(methodExports), 'onRequest'].find(k => k.toLowerCase() === name.toLowerCase());
        if (expected && expected !== name) plan.warnings.push(`WARNING: found export ${name} but expected ${expected} in ${file}`);
        if ((expected === name) && typeof module[name] !== 'function') plan.errors.push(`handler ${name} in ${file} is not a function`);
      }
      plan.routes.push({ path, file, module, layouts, root: manifest.root, middleware: chain.map(m => m.handler), middlewareModules: chain.map(m => m.module), directory: canonical });
    }
    for (const child of [...node.children].sort((a, b) => lexical(a.segment, b.segment))) walk(child, [...segments, child.segment], layouts, chain, inside);
  }
  walk(manifest.tree, [], [], [], false);
  const dirByFile = new Map<string, (typeof dirs)[number]>();
  for (const dir of dirs) for (let i = 0; i < dir.node.middleware.length; i++) dirByFile.set(dir.node.middlewareFiles?.[i] ?? `${dir.directory}/middleware[${i}]`, dir);
  const compareMiddleware = (a: ResolvedMiddleware, b: ResolvedMiddleware) => {
    const x = dirByFile.get(a.file)!, y = dirByFile.get(b.file)!;
    return x.depth - y.depth || compareRoutePaths(a.path, b.path) || lexical(x.canonical, y.canonical) || lexical(a.file, b.file);
  };
  plan.middlewares.sort(compareMiddleware);
  plan.lateMiddlewares.sort(compareMiddleware);
  // Conflict checks retain regex patterns, unlike the ordering comparator.
  const shapes = new Map<string, ResolvedRoute[]>();
  for (const route of [...plan.routes].sort((a, b) => lexical(a.path, b.path) || lexical(a.file, b.file))) {
    const shape = routePathShape(route.path);
    for (const other of shapes.get(shape) ?? []) {
      const conflict = terminalHandlers(other.module).flatMap(([om, oh]) => terminalHandlers(route.module).filter(([m]) => m === om || m === 'every method' || om === 'every method').map(([m, h]) => ({ om, oh, m, h })))[0];
      if (conflict) {
        const { om, oh, m, h } = conflict;
        plan.errors.push(`routes ${other.path} (${other.file}) and ${route.path} (${route.file}) match the same requests, so only one of them can ever match, and both respond to ${om === 'every method' ? m : om}: ${oh} (${om}) and ${h} (${m}); rename or merge them`);
      }
    }
    shapes.set(shape, [...(shapes.get(shape) ?? []), route]);
  }
  plan.routes.sort((a, b) => compareRouteShapes(a.path, b.path) || Number(has(b.module, 'default')) - Number(has(a.module, 'default')) || lexical(a.path, b.path) || lexical(a.directory, b.directory));
  return plan;
}

export class RouteValidationError extends Error {
  constructor(public readonly errors: string[]) { super(errors.join('\n')); this.name = 'RouteValidationError'; }
}
