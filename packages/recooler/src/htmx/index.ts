import type { Context, Env, Handler } from 'hono';
import { contextStorage } from 'hono/context-storage';
import { csrf } from 'hono/csrf';
import { Fragment, type Children } from 'easy-jsx-html-engine';
import { createElement } from '../jsx/jsx-runtime.js';
import type { RouterExtension } from '../router/index.js';
import { actionRegistry, bindingKey, findAction, getActionBinding } from './runtime.js';
import { actionSignature } from './signing.js';
import { timingSafeEqual } from './crypto.js';

/** Keys are manifest route.file ids; values include action-bearing route, root, layout and static dependency modules. */
export type ActionTable = Readonly<Record<string, readonly string[]>>;
export interface HtmxOptions<E extends Env = Env> {
  /** A getter reads the current dev table on every registration/request. Dynamic imports are not followed. */
  table: ActionTable | (() => ActionTable);
  /** Resolved synchronously once per extension instance from the first request's env, then cached. */
  secret?: string | false | ((env: E['Bindings']) => string);
  /** Additional exact origins (or a predicate) accepted alongside the request URL's origin. */
  trustedOrigins?: readonly string[] | ((origin: string, context: Context<E>) => boolean | Promise<boolean>);
  /** External prefix hidden by mount() or a prefix-stripping proxy, e.g. /app. */
  base?: string;
}
const actionMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export function htmx<E extends Env = Env>(options: HtmxOptions<E>): RouterExtension {
  const base = (options.base ?? '').replace(/\/$/, '');
  if (base && (!base.startsWith('/') || /^\/[\\/]/.test(base) || /[\\?#]/.test(base)
    || base.split('/').some(segment => segment === '.' || segment === '..'))) {
    throw new TypeError('htmx base must be a local path prefix without query, hash or dot segments');
  }
  let cachedSecret: string | false | undefined;
  const secret = (context?: Context): string | false => {
    if (cachedSecret !== undefined) return cachedSecret;
    const value = typeof options.secret === 'function'
      ? context && options.secret(context.env) : options.secret;
    if (value !== false && (typeof value !== 'string' || !value)) {
      throw new Error('htmx actions require a nonempty secret; secret: false is for local development only');
    }
    return cachedSecret = value;
  };
  if (options.secret === false) console.warn('recooler: secret: false disables action signatures and route/path replay protection; use only for local development');
  const modulesFor = (file: string): readonly string[] => {
    const table = typeof options.table === 'function' ? options.table() : options.table;
    return Object.hasOwn(table, file) ? table[file]! : [];
  };
  const methodsFor = (modules: readonly string[]) => actionMethods.filter(method => modules.some(
    id => Object.keys(actionRegistry.get(id)?.[method] ?? {}).length > 0));
  const storage = contextStorage();
  return {
    name: 'htmx',
    route(route) {
      const hasPage = Object.hasOwn(route.module, 'default') && typeof route.module.default === 'function';
      const modules = () => hasPage ? modulesFor(route.file) : [];
      const methods = methodsFor(modules());
      if (methods.length && typeof options.secret !== 'function') secret();
      const reservedRequests = new WeakSet<Context>();
      const reserves = (c: Context) => reservedRequests.has(c);
      const binding: Handler = async (c, next) => {
        const reachable = Object.freeze([...modules()]);
        const currentMethods = methodsFor(reachable);
        const hasActions = currentMethods.length > 0;
        if (c.req.query('action') !== undefined && currentMethods.includes(c.req.method)) reservedRequests.add(c);
        c.set(bindingKey, Object.freeze({ routeId: route.file, pathname: new URL(c.req.url).pathname,
          modules: reachable, base, secret: hasActions ? secret(c) : false }));
        return storage(c, next);
      };
      const dispatch: Handler = async (c, next) => {
        if (!reserves(c)) return next();
        if (c.req.header('HX-Request') !== 'true') return c.text('Forbidden', 403);
        // Hono's origin/Fetch Metadata policy applies to every action, including GET
        // and non-form content types. Adapt only the probe, never the live request.
        const probe = { req: { method: 'POST', url: c.req.url,
          header: (name: string) => name === 'content-type' ? 'application/x-www-form-urlencoded' : c.req.header(name) } } as Context;
        await csrf({ origin: (origin: string) => origin === new URL(c.req.url).origin
          || (typeof options.trustedOrigins === 'function'
            ? options.trustedOrigins(origin, c as Context<E>) : options.trustedOrigins?.includes(origin) ?? false) })(probe, async () => {});
        const bound = getActionBinding(c);
        const actionId = c.req.query('action')!;
        const json = c.req.query('scope');
        const key = secret(c);
        if (key !== false && (json === undefined || !timingSafeEqual(c.req.query('sig') ?? '',
          actionSignature({ routeId: bound.routeId, pathname: bound.pathname,
            method: c.req.method, actionId }, json, key)))) return next();
        const action = findAction(bound.modules, c.req.method, actionId);
        if (!action) return next();
        try {
          const result = await action(c);
          if (result instanceof Response) return result;
          if (result == null) return c.newResponse(null, 204);
          if (typeof result === 'object' && 'toHTML' in result && typeof result.toHTML === 'function') {
            return c.html(await result.toHTML());
          }
          const element = await createElement(Fragment, {}, result as Children);
          return c.html(element.toHTML());
        } catch (error) {
          if (error instanceof Response) return error;
          throw error;
        }
      };
      return { // Getter mode permits methods introduced by the next dev reload.
        methods: hasPage && typeof options.table === 'function' ? actionMethods : methods,
        middleware: [binding, dispatch], reserved: reserves, page: { scripts: [] },
      };
    },
  };
}
