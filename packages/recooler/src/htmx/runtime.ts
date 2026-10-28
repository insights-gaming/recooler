import type { Context } from 'hono';
import { getContext } from 'hono/context-storage';
import { serializeScope } from './scope.js';
import { signedUrl } from './signing.js';

export type Action = (context: Context) => unknown;
export type ActionMethods = Record<string, Record<string, Action>>;

// Symbol.for survives server-runtime reloads while cached modules retain registrations.
const registryKey = Symbol.for('recooler.htmx.actions.v1');
const persistent = globalThis as typeof globalThis & { [registryKey]?: Map<string, ActionMethods> };
export const actionRegistry = persistent[registryKey] ??= new Map<string, ActionMethods>();

/** Replace one module atomically. An empty registration clears removed actions in dev. */
export function registerActions(moduleId: string, actions: ActionMethods): void {
  const methods: ActionMethods = Object.create(null);
  for (const [method, entries] of Object.entries(actions)) {
    const normalized = method.toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(normalized)) {
      throw new TypeError(`Unsupported action method ${method} in ${moduleId}`);
    }
    const table = methods[normalized] ??= Object.create(null) as Record<string, Action>;
    for (const [id, action] of Object.entries(entries)) {
      if (typeof action !== 'function') throw new TypeError(`Invalid action ${id} in ${moduleId}`);
      table[id] = action;
    }
  }
  actionRegistry.set(moduleId, methods);
}

export interface ActionBinding {
  readonly routeId: string;
  readonly pathname: string;
  readonly base: string;
  readonly modules: readonly string[];
  readonly secret: string | false;
}
export const bindingKey = 'recooler.htmx.binding.v1';

/** Internal route binding; never reconstruct it from Hono's mutable route index or params. */
export function getActionBinding(context: Context): ActionBinding {
  const binding = context.get(bindingKey) as ActionBinding | undefined;
  if (!binding) throw new Error('No htmx route binding; install htmx() on this createApp');
  return binding;
}

export function findAction(modules: readonly string[], method: string, id: string): Action | undefined {
  for (const module of modules) {
    const actions = actionRegistry.get(module)?.[method];
    if (actions && Object.hasOwn(actions, id)) return actions[id];
  }
}

export function actionUrl(id: string, scope: Record<string, unknown>, context?: Context): string {
  const binding = getActionBinding(context ?? getContext());
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    if (findAction(binding.modules, method, id)) {
      return signedUrl({ routeId: binding.routeId, pathname: binding.pathname, method, actionId: id, scope },
        binding.secret, binding.base);
    }
  }
  throw new Error(`Action ${id} is not reachable from ${binding.routeId}`);
}

/** Legacy query-fragment helper, now signed against the ambient rendering route (D6). */
export function actionScope(id: string, scope: Record<string, unknown>): string {
  const url = actionUrl(id, scope);
  return url.slice(url.indexOf('&scope='));
}

export function handlerScope(scope: Record<string, unknown>): string {
  return serializeScope(scope);
}

type ActionFn<P, C extends Context> = (context: C, payload: P) => unknown;
type Factory<P, C extends Context> = (scope: any) => ActionFn<P, C>;

function resolveAction<P, C extends Context>(context: C, action: ActionFn<P, C> | Factory<P, C>, id?: string): ActionFn<P, C> | Response {
  if (id === undefined) return action as ActionFn<P, C>;
  const json = context.req.query('scope');
  if (json === undefined) return context.text('missing action scope', 400);
  let scope: unknown;
  try { scope = JSON.parse(json); } catch { /* malformed below */ }
  if (typeof scope !== 'object' || scope === null || Array.isArray(scope)) {
    return context.text('malformed action scope', 400);
  }
  // The extension has already verified the complete D6 signature, before invoking a factory.
  return (action as Factory<P, C>)(scope);
}

export function wrapAction<C extends Context = Context>(action: ActionFn<{}, C>): (context: C) => unknown;
export function wrapAction<C extends Context = Context>(factory: Factory<{}, C>, id: string): (context: C) => unknown;
export function wrapAction<C extends Context = Context>(action: ActionFn<{}, C> | Factory<{}, C>, id?: string) {
  return (context: C) => {
    const resolved = resolveAction(context, action, id);
    return resolved instanceof Response ? resolved : resolved(context, {});
  };
}

export function wrapActionWithPayload<C extends Context = Context>(action: ActionFn<any, C>): (context: C) => Promise<unknown>;
export function wrapActionWithPayload<C extends Context = Context>(factory: Factory<any, C>, id: string): (context: C) => Promise<unknown>;
export function wrapActionWithPayload<C extends Context = Context>(action: ActionFn<any, C> | Factory<any, C>, id?: string) {
  return async (context: C) => {
    const resolved = resolveAction(context, action, id);
    if (resolved instanceof Response) return resolved;
    const formData = await context.req.formData();
    return resolved(context, { ...Object.fromEntries(formData), __formData: formData });
  };
}

/** The transform/runtime contract, also useful to custom transform evaluators. */
export interface HtmxTransformRuntime {
  actionUrl: typeof actionUrl;
  registerActions: typeof registerActions;
  wrapAction: typeof wrapAction;
  wrapActionWithPayload: typeof wrapActionWithPayload;
  actionScope: typeof actionScope;
  handlerScope: typeof handlerScope;
}
