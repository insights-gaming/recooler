import { Hono } from 'hono';
import type { Context, Env, Handler, MiddlewareHandler, Next } from 'hono';
import { methodExports, resolveRoutes, RouteValidationError } from './resolve.js';
import type { CreateAppOptions, Manifest, ResolvedRoute } from './types.js';
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

/** Minimal compose with Hono finalization semantics and double-next detection. */
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

export function createApp<E extends Env = Env>(manifest: Manifest, options: CreateAppOptions<E> = {}): Hono<E> {
  const plan = resolveRoutes(manifest);
  if (plan.errors.length) throw new RouteValidationError(plan.errors);
  for (const warning of plan.warnings) (options.warn ?? console.warn)(warning);
  const app = new Hono<E>({ strict: true, ...options.hono });
  for (const mw of plan.middlewares) app.use(mw.path, mw.handler);
  for (const route of plan.routes) {
    // Freeze copied containers so hooks cannot alter the planner's registration chains.
    const view = Object.freeze(Object.fromEntries(Object.entries(route).map(([key, value]) =>
      [key, Array.isArray(value) ? Object.freeze([...value]) : value]))) as unknown as ResolvedRoute;
    const additions = (options.extensions ?? []).flatMap(extension => {
      const addition = extension.route?.(view);
      return addition ? [{ ...addition, extension: extension.name }] : [];
    });
    for (const addition of additions) {
      if (Array.isArray(addition.handlers) && !addition.methods?.length) {
        throw new RouteValidationError([`extension ${addition.extension} for ${route.file} returns array handlers without methods; declare methods or use a handler map`]);
      }
    }
    const contributions = additions.flatMap(x => x.page ? [{ extension: x.extension, page: x.page }] : []);
    const page = Object.hasOwn(route.module, 'default')
      ? options.pages?.handler(view, contributions.map(x => x.page), contributions) : undefined;
    if (page !== undefined && typeof page !== 'function') throw new RouteValidationError([`page adapter handler for ${route.file} is not a function`]);
    const scopedAdditions = additions.map(addition => ({
      methods: new Set((addition.methods ?? []).map(m => m.toUpperCase())),
      handlers: Array.isArray(addition.handlers) ? addition.handlers : undefined,
      byMethod: Object.entries(Array.isArray(addition.handlers) ? {} : addition.handlers ?? {})
        .map(([method, handlers]) => [method.toUpperCase(), handlers] as const),
    }));
    const methods = new Set<string>();
    for (const [name, method] of Object.entries(methodExports)) if (typeof route.module[name] === 'function') methods.add(method);
    if (page) methods.add('GET');
    for (const addition of scopedAdditions) {
      for (const method of addition.methods) methods.add(method);
      for (const [method] of addition.byMethod) methods.add(method);
    }
    if (typeof route.module.onRequest === 'function') { methods.clear(); methods.add('ALL'); }
    if (methods.has('ALL')) { methods.clear(); methods.add('ALL'); }
    if (!methods.size) continue;
    const methodDispatch: Handler = async (c, next) => {
      const method = c.req.method === 'HEAD' ? 'GET' : c.req.method;
      const name = Object.entries(methodExports).find(([, value]) => value === method)?.[0];
      const handler = name ? route.module[name] as Handler | undefined : undefined;
      await dispatch([...(handler ? [handler] : []), ...(method === 'GET' && page ? [page] : [])], c, next);
    };
    const handlers: Handler[] = [
      ...route.middleware.map((mw, i) => once(mw, route.middlewareModules[i])),
      ...scopedAdditions.map(({ methods, handlers, byMethod }): Handler => (c, next) => {
        const method = c.req.method;
        const matches = (declared: string) => declared === 'ALL' || declared === method || (method === 'HEAD' && declared === 'GET');
        return dispatch([
          ...(handlers && [...methods].some(matches) ? handlers : []),
          ...byMethod.flatMap(([declared, chain]) => matches(declared) ? chain : []),
        ], c, next);
      }),
      ...(typeof route.module.onRequest === 'function' ? [route.module.onRequest as Handler] : []),
      methodDispatch];
    // Hono dispatches HEAD through GET; the extension chains above retain the actual method.
    app.on([...new Set([...methods].map(method => method === 'HEAD' ? 'GET' : method))], route.path, handlers[0]!, ...handlers.slice(1));
  }
  for (const mw of plan.lateMiddlewares) app.use(mw.path, once(mw.handler, mw.module));
  return app;
}
