import type { Context, Env, Handler } from 'hono';
import { contextStorage } from 'hono/context-storage';
import { Fragment, type Children } from 'easy-jsx-html-engine';
import { createElement } from '../jsx/jsx-runtime.js';
import type { RouterExtension } from '../router/index.js';
import { getActionRegistry, bindingKey, findAction, getActionBinding } from './runtime.js';
import { createActionSigner, type ActionSigner } from './signing.js';
import { timingSafeEqual } from './crypto.js';

/** Keys are manifest route.file ids; values include action-bearing route, root, layout and static dependency modules. */
export type ActionTable = Readonly<Record<string, readonly string[]>>;
export interface HtmxOptions<E extends Env = Env> {
  /** Static reachability table. Dev reloads must recreate the app. Dynamic imports are not followed. */
  table: ActionTable;
  /** Env functions are resolved synchronously and cached by env object identity. */
  secret?: string | { unsafeUnsigned: true } | ((env: E['Bindings']) => string);
  /** Per-project registry namespace; Phase 4b must supply the same value to registerActions. */
  namespace?: string;
  /** Additional origins (or a predicate) accepted regardless of Sec-Fetch-Site. */
  trustedOrigins?: readonly string[] | ((origin: string, context: Context<E>) => boolean | Promise<boolean>);
  /** External prefix hidden by mount() or a prefix-stripping proxy, e.g. /app. */
  base?: string;
}
/** Phase 4b production-build hook: reject an extension whose marker is true. */
export const unsafeUnsignedMarker = Symbol.for('recooler.htmx.unsafeUnsigned.v1');
export interface HtmxExtension extends RouterExtension {
  readonly [unsafeUnsignedMarker]: boolean;
}
const actionMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export function htmx<E extends Env = Env>(options: HtmxOptions<E>): HtmxExtension {
  if ((options.secret as unknown) === false) {
    throw new TypeError('secret: false was replaced by secret: { unsafeUnsigned: true }; unsigned actions are unsafe outside local development');
  }
  if (!options.table || typeof options.table !== 'object' || Array.isArray(options.table)) {
    throw new TypeError('htmx table must be a static ActionTable; recreate createApp after an SSR reload');
  }
  const base = (options.base ?? '').replace(/\/$/, '');
  if (base && (!base.startsWith('/') || /^\/[\\/]/.test(base) || /[\\?#]/.test(base)
    || /[\u0000- \u007f]/.test(base) || new URL(base, 'http://x').pathname !== base
    || base.split('/').some(segment => segment === '.' || segment === '..'))) {
    throw new TypeError('htmx base must be a local path prefix without query, hash or dot segments');
  }
  const unsafeUnsigned = typeof options.secret === 'object' && options.secret?.unsafeUnsigned === true;
  if (unsafeUnsigned) console.warn('htmx: unsafeUnsigned disables action signing and replay protection; use only for local development');
  const envSigners = new WeakMap<object, ActionSigner>();
  let fallbackSigner: ActionSigner | undefined;
  const signer = (context?: Context): ActionSigner => {
    if (unsafeUnsigned) return () => undefined;
    const env: unknown = context?.env;
    const objectEnv = env !== null && (typeof env === 'object' || typeof env === 'function') ? env as object : undefined;
    const cached = typeof options.secret === 'function' && objectEnv ? envSigners.get(objectEnv) : fallbackSigner;
    if (cached) return cached;
    const value = typeof options.secret === 'function' ? options.secret(context!.env) : options.secret;
    if (typeof value !== 'string' || !value) throw new Error('htmx actions require a nonempty secret');
    const sign = createActionSigner(value);
    if (typeof options.secret === 'function' && objectEnv) envSigners.set(objectEnv, sign);
    else fallbackSigner = sign;
    return sign;
  };
  const modulesFor = (file: string): readonly string[] => Object.hasOwn(options.table, file) ? options.table[file]! : [];
  const registry = getActionRegistry(options.namespace);
  const methodsFor = (modules: readonly string[]) => actionMethods.filter(method => modules.some(
    id => Object.keys(registry.get(id)?.[method] ?? {}).length > 0));
  const storage = contextStorage();
  return {
    name: 'htmx',
    [unsafeUnsignedMarker]: unsafeUnsigned,
    route(route) {
      const hasPage = Object.hasOwn(route.module, 'default') && typeof route.module.default === 'function';
      const modules = Object.freeze([...(hasPage ? modulesFor(route.file) : [])]);
      const methods = Object.freeze(methodsFor(modules));
      if (methods.length && typeof options.secret !== 'function') signer();
      const reservedRequests = new WeakSet<Context>();
      const reserves = (c: Context) => reservedRequests.has(c);
      const binding: Handler = async (c, next) => {
        if (c.req.query('action') !== undefined && methods.includes(c.req.method)) reservedRequests.add(c);
        c.set(bindingKey, Object.freeze({ routeId: route.file, pathname: new URL(c.req.url).pathname,
          modules, methods, base, namespace: options.namespace, sign: methods.length ? signer(c) : () => {
            throw new Error('No htmx action methods were reserved; recreate createApp after registering actions');
          } }));
        return storage(c, next);
      };
      const dispatch: Handler = async (c, next) => {
        if (!reserves(c)) return next();
        if (c.req.header('HX-Request') !== 'true') return c.text('Forbidden', 403);
        const site = c.req.header('Sec-Fetch-Site');
        const origin = c.req.header('Origin');
        const allowed = site === 'same-origin' || (origin !== undefined
          && ((site === undefined && origin === new URL(c.req.url).origin) || (typeof options.trustedOrigins === 'function'
            ? await options.trustedOrigins(origin, c as Context<E>) : options.trustedOrigins?.includes(origin) ?? false)));
        if (!allowed) return c.text('Forbidden', 403);
        const bound = getActionBinding(c);
        const actionId = c.req.query('action')!;
        const json = c.req.query('scope');
        const signature = bound.sign({ routeId: bound.routeId, pathname: bound.pathname,
          method: c.req.method, actionId }, json ?? '');
        if (signature !== undefined && (json === undefined || !timingSafeEqual(c.req.query('sig') ?? '', signature))) return next();
        const action = findAction(bound.modules, c.req.method, actionId, bound.namespace);
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
      return {
        methods: [...methods],
        middleware: [binding, dispatch], reserved: reserves, page: { scripts: [] },
      };
    },
  };
}
