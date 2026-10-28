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
  if (segment.startsWith('[[') && segment.endsWith(']]')) {
    const name = segment.slice(2, -2);
    if (name && !name.includes(']')) return `:${name}{.+}`;
  }
  if (!segment.startsWith('[') || !segment.endsWith(']')) return segment;
  const value = segment.slice(1, -1);
  const brace = value.indexOf('{');
  const name = brace < 0 ? value : value.slice(0, brace);
  if (!name || /[\[\]{}]/.test(name)) return segment;
  if (brace < 0) return `:${name}`;
  let depth = 0;
  for (let i = brace; i < value.length; i++) {
    if (value[i] === '\\') { i++; continue; }
    if (value[i] === '{') depth++;
    if (value[i] === '}' && --depth === 0 && i !== value.length - 1) return segment;
    if (depth < 0) return segment;
  }
  return depth === 0 && value.endsWith('}') ? `:${value}` : segment;
}
export function routePathWithoutGroups(path: string): string {
  return '/' + path.split('/').filter(s => s && !isGroupSegment(s)).join('/');
}
function kind(s: string): number {
  return !s.startsWith(':') ? 0 : s.endsWith('{.+}') || s.endsWith('{.*}') ? 3 : s.includes('{') ? 1 : 2;
}
/** 0.1.0 specificity: static, custom pattern, plain param, catch-all. */
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
    afterCatchAll = k === 3;
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
  if (has(ns, 'onRequest') && typeof ns.onRequest === 'function') return [['every method', 'onRequest']];
  const result: [string, string][] = has(ns, 'default') && typeof ns.default === 'function' ? [['GET', 'the page']] : [];
  for (const [name, method] of Object.entries(methodExports)) if (has(ns, name) && typeof ns[name] === 'function') result.push([method, name]);
  return result.sort((a, b) => lexical(a.join(), b.join()));
}

/** Pure planning and diagnostics; never constructs or imports a Hono app. */
export function resolveRoutes(manifest: Manifest): RoutePlan {
  const plan: RoutePlan = { routes: [], middlewares: [], lateMiddlewares: [], errors: [], warnings: [] };
  if (manifest.version !== 1) plan.errors.push(`unsupported manifest version ${manifest.version}`);
  const dirs: { node: DirNode; directory: string; canonical: string; depth: number; inside: boolean }[] = [];
  type Directory = (typeof dirs)[number];
  type LocatedMiddleware = ResolvedMiddleware & { dir: Directory; index: number };
  const allMiddleware: LocatedMiddleware[] = [];
  const routesByDir = new Map<string, string>();
  const layoutsByDir = new Map<string, string>();
  function sourceFile(node: DirNode): string | undefined {
    const file = node.route?.file ?? node.layoutFile ?? node.middlewareFiles?.[0];
    if (file) return file;
    for (const child of node.children) { const file = sourceFile(child); if (file) return file; }
  }
  function walk(node: DirNode, segments: string[], inside: boolean) {
    const directory = '/' + segments.join('/');
    const canonical = '/' + segments.map(routeSegment).join('/');
    const path = routePathWithoutGroups(canonical);
    inside ||= node.group;
    const dir = { node, directory, canonical, depth: segments.length, inside };
    dirs.push(dir);
    const invalid = (reason: string) => plan.errors.push(`invalid route directory ${directory} (${sourceFile(node) ?? directory}): ${reason}`);
    const segment = node.segment;
    const converted = routeSegment(segment);
    if (segment.startsWith('[[') && segment.endsWith(']]') && segment.slice(2, -2).includes('{')) {
      invalid('catch-all parameter names cannot contain {; use [[rest]]');
    } else if (segment.startsWith('[') && segment.endsWith(']') && converted === segment) {
      invalid('could not convert bracket parameter; use a name and a balanced pattern, e.g. [n{[0-9]+}]');
    } else if (converted.startsWith(':') && converted.includes('{')) {
      const pattern = converted.slice(converted.indexOf('{') + 1, -1);
      if (!pattern) invalid('parameter patterns cannot be empty');
      else {
        try { new RegExp(pattern); }
        catch (error) { invalid(`invalid parameter pattern ${JSON.stringify(pattern)}: ${String(error)}`); }
      }
    }
    if (node.group !== isGroupSegment(node.segment)) plan.errors.push(`directory ${directory} has inconsistent group metadata`);
    if (node.path !== path) plan.errors.push(`directory ${directory} has path ${node.path}, expected ${path}`);
    if (node.layout) {
      const file = node.layoutFile ?? `${directory}/layout`;
      const other = layoutsByDir.get(canonical);
      if (other) plan.errors.push(`only one layout may be used per path, found ${other} and ${file} for ${canonical}`);
      layoutsByDir.set(canonical, file);
    }
    const middleware = node.middleware.map((module, i): LocatedMiddleware => {
      const file = node.middlewareFiles?.[i] ?? `${directory}/middleware[${i}]`;
      if (!has(module, 'default')) plan.errors.push(`middleware ${file} has no default export`);
      else if (typeof module.default !== 'function' || /^\s*class\b/.test(Function.prototype.toString.call(module.default))) {
        plan.errors.push(`middleware ${file} must export a middleware function (default export is not a callable middleware)`);
      }
      return { dir, index: i, path: usePath(path), file, module, handler: module.default as MiddlewareHandler };
    });
    allMiddleware.push(...middleware);
    if (inside) {
      if (!node.group) plan.lateMiddlewares.push(...middleware);
    } else plan.middlewares.push(...middleware);
    if (node.route) {
      const { file, module } = node.route;
      if (has(module, 'default') && typeof module.default !== 'function') plan.errors.push(`page default export in ${file} is not a function`);
      const other = routesByDir.get(canonical);
      if (other) plan.errors.push(`only one route may be used per path, found ${other} and ${file} for ${canonical}`);
      routesByDir.set(canonical, file);
      for (const name of Object.keys(module)) {
        const expected = [...Object.keys(methodExports), 'onRequest'].find(k => k.toLowerCase() === name.toLowerCase());
        if (expected && expected !== name) plan.warnings.push(`WARNING: found export ${name} but expected ${expected} in ${file}`);
        if ((expected === name) && typeof module[name] !== 'function') plan.errors.push(`handler ${name} in ${file} is not a function`);
      }
      plan.routes.push({ path, file, module, layouts: [], layoutFiles: [], root: manifest.root, rootFile: manifest.rootFile, middleware: [], middlewareModules: [], middlewareFiles: [], directory: canonical });
    }
    for (const child of [...node.children].sort((a, b) => lexical(a.segment, b.segment))) walk(child, [...segments, child.segment], inside);
  }
  walk(manifest.tree, [], false);
  const compareMiddleware = (a: ResolvedMiddleware, b: ResolvedMiddleware) => {
    const { dir: x, index: i } = a as LocatedMiddleware, { dir: y, index: j } = b as LocatedMiddleware;
    return x.depth - y.depth || compareRoutePaths(routePathWithoutGroups(x.canonical), routePathWithoutGroups(y.canonical)) || lexical(x.canonical, y.canonical) || i - j;
  };
  allMiddleware.sort(compareMiddleware);
  const ancestor = (parent: string, child: string) => parent === '/' || parent === child || child.startsWith(parent + '/');
  // Alias directories such as [id] and :id share the reference's normalized layout/middleware
  // path, even when their files occupy distinct filesystem branches.
  for (const route of plan.routes) {
    const layouts = dirs.filter(d => d.node.layout && ancestor(d.canonical, route.directory))
      .sort((a, b) => a.depth - b.depth);
    route.layouts = layouts.map(d => d.node.layout!);
    route.layoutFiles = layouts.map(d => d.node.layoutFile);
    const scoped = allMiddleware.filter(m => { const dir = m.dir; return dir.inside && ancestor(dir.canonical, route.directory); });
    route.middleware = scoped.map(m => m.handler);
    route.middlewareModules = scoped.map(m => m.module);
    route.middlewareFiles = scoped.map(m => m.dir.node.middlewareFiles?.[m.index]);
  }
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
  plan.routes.sort((a, b) => compareRouteShapes(a.path, b.path) || Number(typeof b.module.default === 'function') - Number(typeof a.module.default === 'function') || lexical(a.path, b.path) || lexical(a.directory, b.directory));
  return plan;
}

export class RouteValidationError extends Error {
  constructor(public readonly errors: string[]) { super(errors.join('\n')); this.name = 'RouteValidationError'; }
}
