import { Hono } from 'hono';
import type { Context, Handler, MiddlewareHandler, Next } from 'hono';
import { methodExports, resolveRoutes, RouteValidationError } from './resolve.js';
import type { CreateAppOptions, Manifest } from './types.js';
export * from './types.js';
export { compareRoutePaths, compareRouteShapes, isGroupSegment, routeSegment, routePathShape, routePathWithoutGroups, resolveRoutes, RouteValidationError } from './resolve.js';

/** Context identifies one dispatch; namespace identity distinguishes re-exporting modules. */
const ranMiddleware = new WeakMap<Context, Set<unknown>>();
export function once(middleware: MiddlewareHandler, moduleId: unknown): MiddlewareHandler {
  return (c, next) => {
    let ran = ranMiddleware.get(c);
    if (!ran) ranMiddleware.set(c, ran = new Set());
    if (ran.has(moduleId)) return next();
    ran.add(moduleId);
    return middleware(c, next);
  };
}

/**
 * Standard extras merge: concatenate arrays in extension order; later scalar/object values
 * replace earlier values (no deep merge). Inputs are not mutated. Adapters receive the original
 * ordered extras so they can interpret domain-specific values before applying this rule.
 */
export function mergePageExtras(extras: Record<string, unknown>[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const extra of extras) for (const [key, value] of Object.entries(extra)) {
    Object.defineProperty(merged, key, { value: Array.isArray(value) ? [...(Array.isArray(merged[key]) ? merged[key] : []), ...value] : value, enumerable: true, configurable: true, writable: true });
  }
  return merged;
}

/** Minimal Hono-compatible compose, including after-next response replacement. */
function dispatch(handlers: Handler[], c: Context, next: Next): Promise<void> {
  let index = -1;
  async function run(i: number): Promise<void> {
    if (i <= index) throw new Error('next() called multiple times');
    index = i;
    const handler = handlers[i];
    if (!handler) return next();
    const response = await handler(c, () => run(i + 1));
    if (response && !c.finalized) c.res = response;
  }
  return run(0);
}

export function createApp(manifest: Manifest, options: CreateAppOptions = {}): Hono {
  const plan = resolveRoutes(manifest);
  if (plan.errors.length) throw new RouteValidationError(plan.errors);
  for (const warning of plan.warnings) (options.warn ?? console.warn)(warning);
  const app = new Hono({ strict: true, ...options.hono });
  for (const mw of plan.middlewares) app.use(mw.path, mw.handler);
  for (const route of plan.routes) {
    const additions = (options.extensions ?? []).map(extension => extension.route?.(route)).filter(x => x !== undefined);
    const page = options.pages?.handler(route, additions.flatMap(x => x.page ? [x.page] : []));
    const methods = new Set<string>();
    for (const [name, method] of Object.entries(methodExports)) if (typeof route.module[name] === 'function') methods.add(method);
    if (page) methods.add('GET');
    for (const addition of additions) for (const method of addition.methods ?? []) methods.add(method.toUpperCase());
    if (typeof route.module.onRequest === 'function') { methods.clear(); methods.add('ALL'); }
    if (!methods.size) continue;
    const methodDispatch: Handler = async (c, next) => {
      const method = c.req.method === 'HEAD' ? 'GET' : c.req.method;
      const name = Object.entries(methodExports).find(([, value]) => value === method)?.[0];
      const handler = name ? route.module[name] as Handler | undefined : undefined;
      await dispatch([...(handler ? [handler] : []), ...(method === 'GET' && page ? [page] : [])], c, next);
    };
    const handlers: Handler[] = [
      ...route.middleware.map((mw, i) => once(mw, route.middlewareModules[i])),
      ...additions.flatMap(x => x.handlers ?? []),
      ...(typeof route.module.onRequest === 'function' ? [route.module.onRequest as Handler] : []),
      methodDispatch];
    app.on([...methods], route.path, handlers[0]!, ...handlers.slice(1));
  }
  for (const mw of plan.lateMiddlewares) app.use(mw.path, once(mw.handler, mw.module));
  return app;
}
