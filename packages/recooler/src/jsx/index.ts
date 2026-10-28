/// <reference types="easy-jsx-html-engine/jsx-runtime" preserve="true" />
import {
  dangerouslyPreventEscaping, Fragment, Suspense as EngineSuspense,
} from 'easy-jsx-html-engine';
import { renderToStream } from 'easy-jsx-html-engine/stream-webapi';
import type { Context, Env, Handler } from 'hono';
import { createElement } from './jsx-runtime.js';
import type { Children, Component, ErrorBoundaryProps, ResolvedTemplateProps, SuspenseProps } from './types.js';
import { mergePageExtras, type PageAdapter, type ResolvedRoute } from '../router/index.js';
export { createElement } from './jsx-runtime.js';

/** Augment this interface in recooler/jsx to type route bindings and variables. */
export interface RouteEnv extends Env {}
export type RouteContext = Context<RouteEnv>;

export interface RouteProps<TContext = RouteContext> {
  rid: string | number;
  url: URL;
  ctx: TContext;
  head: RouteHead;
  /** Matched manifest pattern, with route groups removed. */
  route: string;
  scripts: string[];
  /** @deprecated Migrate custom roots to scripts (external module URLs). */
  clientScript?: string;
}

export interface RouteHead {
  title?: string;
  base?: string | JSX.IntrinsicElements['base'];
  metas?: JSX.IntrinsicElements['meta'][];
  links?: JSX.IntrinsicElements['link'][];
  scripts?: JSX.IntrinsicElements['script'][];
}

export interface RouteHeadFn<TContext = RouteContext> {
  (ctx: TContext, prev: RouteHead): RouteHead | null | undefined | PromiseLike<RouteHead | null | undefined>;
}

/** The string argument is retained for one release for legacy clientScript users. */
export type RootHOC = (Content: Component<RouteProps>, clientScript?: string) => Component<RouteProps>;
export type LayoutHOC = (Content: Component<RouteProps>) => Component<RouteProps>;

export interface JSXPage {
  route: ResolvedRoute;
  Content: Component<RouteProps>;
  Root: RootHOC;
  head(ctx: RouteContext): Promise<RouteHead>;
  scripts: string[];
  /** @deprecated */
  clientScript?: string;
}

export interface JSXPagesOptions {
  ResolvedTemplate?: Component<ResolvedTemplateProps>;
  suspenseCleanupScriptMiddleware?: (script: string) => string;
  /** Replaces the old route_handler_factory customization point. */
  handlerFactory?: (page: JSXPage, render: Handler) => Handler;
}

function isPlainObject(value: unknown): value is RouteHead {
  if (value === null || typeof value !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Copy only plain containers; promises, URLs, engine elements and instances keep their semantics. */
function copyContainers(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (!Array.isArray(value) && !isPlainObject(value)) return value;
  if (seen.has(value)) return seen.get(value);
  const copy: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
  seen.set(value, copy);
  for (const key of Object.keys(value)) {
    Object.defineProperty(copy, key, { value: copyContainers((value as Record<string, unknown>)[key], seen),
      enumerable: true, configurable: true, writable: true });
  }
  return copy;
}

function copyHead(value: unknown, source: string): RouteHead {
  if (!isPlainObject(value) || typeof (value as { then?: unknown }).then === 'function') {
    throw new TypeError(`Invalid head in ${source}: expected a function, plain object, or nullish value`);
  }
  return copyContainers(value) as RouteHead;
}

/** Resolve live namespace exports, starting at the last replacing object. */
async function resolveHead(route: ResolvedRoute, ctx: RouteContext): Promise<RouteHead> {
  // TODO: use required router source metadata once the router branch lands.
  const files = route as ResolvedRoute & { rootFile?: string; layoutFiles?: (string | undefined)[] };
  const entries = [
    { module: route.root, source: files.rootFile ?? `root (used by ${route.file})` },
    ...route.layouts.map((module, i) => ({ module, source: files.layoutFiles?.[i] ?? `layout ${i + 1} (used by ${route.file})` })),
    { module: route.module, source: route.file },
  ].map(({ module, source }) => ({ entry: module?.head, source }));
  let start = 0;
  for (const [i, { entry }] of entries.entries()) {
    if (entry != null && typeof entry !== 'function') start = i;
  }
  let head: RouteHead = {};
  for (const { entry, source } of entries.slice(start)) {
    if (entry == null) continue;
    try {
      const result: unknown = typeof entry === 'function' ? await (entry as RouteHeadFn)(ctx, head) : entry;
      head = result == null ? {} : copyHead(result, source);
    } catch (error) {
      if (error instanceof Response) throw error;
      const message = `Head in ${source}: ${error instanceof Error ? error.message : String(error)}`;
      throw error instanceof TypeError ? new TypeError(message, { cause: error }) : new Error(message, { cause: error });
    }
  }
  return head;
}

const markedRequests = new WeakSet<object>();

export function jsxPages(options: JSXPagesOptions = {}): PageAdapter {
  return {
    handler(route, extras) {
      if (typeof route.module.default !== 'function') return undefined;
      let Content = route.module.default as Component<RouteProps>;
      for (const layout of [...route.layouts].reverse()) {
        if (layout.default == null) continue;
        if (typeof layout.default !== 'function') throw new TypeError(`Invalid layout for ${route.file}`);
        Content = (layout.default as LayoutHOC)(Content);
      }
      const Root = (route.root?.default ?? DefaultRootHOC) as RootHOC;
      if (typeof Root !== 'function') throw new TypeError(`Invalid root for ${route.file}`);
      // Custom roots may render their own body without using renderHeadElements. Put a
      // discoverable meta in the content slot, which works for those roots as well.
      if (Root !== DefaultRootHOC) {
        const Page = Content;
        Content = (props: RouteProps) => createElement(Fragment, {},
          !markedRequests.has(props.ctx) && createElement('meta', { name: 'recooler-route', content: props.route }),
          createElement(Page, props));
      }
      const extra = mergePageExtras(extras);
      const scripts = extra.scripts ?? [];
      if (!Array.isArray(scripts) || scripts.some(script => typeof script !== 'string')) {
        throw new TypeError(`Invalid page scripts for ${route.file}: expected URL strings`);
      }
      if (extra.clientScript != null && typeof extra.clientScript !== 'string') {
        throw new TypeError(`Invalid clientScript for ${route.file}: expected a string`);
      }
      const page: JSXPage = {
        route, Root, Content, scripts: [...scripts],
        clientScript: extra.clientScript as string | undefined,
        head: ctx => resolveHead(route, ctx),
      };
      const render: Handler = async ctx => {
        let ctxWaitUntil: ((promise: Promise<unknown>) => void) | undefined;
        try { ctxWaitUntil = ctx.executionCtx.waitUntil?.bind(ctx.executionCtx); } catch { /* Node has no executionCtx. */ }
        let body: string | ReadableStream<Uint8Array> | undefined;
        try {
          const head = await page.head(ctx);
          const requestScripts = [...page.scripts];
          let shell: JSX.Element | undefined;
          body = await renderToStream(
            (rid: RouteProps['rid']) => shell = createElement(page.Root(page.Content, page.clientScript), {
              rid, url: new URL(ctx.req.url), ctx, head, route: route.path,
              scripts: requestScripts, clientScript: page.clientScript,
            }),
            { waitUntil: promise => {
              const handled = promise.catch(error => { console.error(error); });
              ctxWaitUntil?.(handled);
            }, ResolvedTemplate: options.ResolvedTemplate,
              cleanupScriptMiddleware: options.suspenseCleanupScriptMiddleware },
          );
          // The engine already awaits the shell before writing. Await it here too,
          // so async status changes and thrown Responses precede response creation.
          await shell;
          if (ctx.req.method === 'HEAD' && body instanceof ReadableStream) await body.cancel();
          return ctx.newResponse(body, { headers: { 'content-type': 'text/html' } });
        } catch (error) {
          if (body instanceof ReadableStream) await body.cancel().catch(cancelError => { console.error(cancelError); });
          if (error instanceof Response) return error;
          throw error;
        }
      };
      const handler = options.handlerFactory?.(page, render) ?? render;
      return async (ctx, next) => {
        try { return await handler(ctx, next); }
        catch (error) {
          if (error instanceof Response) return error;
          throw error;
        }
      };
    },
  };
}

export function renderHeadElements(head: RouteHead): JSX.Element {
  return createElement(Fragment, {},
    head.title ? createElement('title', {}, head.title) : null,
    head.base && createElement('base', typeof head.base === 'string' ? { href: head.base } : head.base),
    head.metas?.map(props => createElement('meta', props)),
    head.links?.map(props => createElement('link', props)),
    head.scripts?.map(props => createElement('script', props)));
}

function hasCharsetMeta(head: RouteHead): boolean {
  return !!head.metas?.some(meta => Object.entries(meta ?? {}).some(
    ([key, value]) => key.toLowerCase() === 'charset' && (!!value || value === 0)));
}

export const DefaultRootHOC: RootHOC = Content => (props: RouteProps) => {
  markedRequests.add(props.ctx);
  return createElement(Fragment, {},
    dangerouslyPreventEscaping('<!DOCTYPE html>'),
    createElement('html', {},
      createElement('head', {},
        !hasCharsetMeta(props.head) && createElement('meta', { charset: 'utf-8' }),
        renderHeadElements(props.head)),
      createElement('body', { 'data-recooler-route': props.route },
        createElement(Content, props),
        props.scripts.map(src => createElement('script', { type: 'module', src })))));
};

/** Logs the error; stack traces in HTML require an explicit opt-in. */
export function defaultCatch(error: unknown, options: { showStack?: boolean } = {}): JSX.Element {
  console.error(error);
  return createElement('pre', {}, options.showStack && error instanceof Error ? error.stack ?? error.message : 'Internal Server Error');
}

/** Like the engine boundary, but a Response escapes every catch, including the default catch. */
export function ErrorBoundary(props: ErrorBoundaryProps): JSX.Element {
  return boundary(props, true);
}

function boundary(props: ErrorBoundaryProps, escapeResponses: boolean): JSX.Element {
  const children = props.children;
  let result: JSX.Element;
  try {
    if (Array.isArray(children) && children.length === 1 && typeof children[0] === 'function') {
      const render = children[0];
      result = Promise.resolve().then(() => createElement(Fragment, {}, render()));
    } else { result = createElement(Fragment, {}, children as Children); }
  } catch (error) { result = Promise.reject(error); }
  // Preserve synchronous Suspense children: they need no fallback or stream.
  if (!('then' in result)) return result;
  return Promise.resolve(result).catch(error => {
    if (escapeResponses && error instanceof Response) throw error;
    if (props.catch == null) return defaultCatch(error, props);
    if (error instanceof Response) console.error(error);
    return typeof props.catch === 'function' ? props.catch(error) : createElement(Fragment, {}, props.catch);
  }).catch(error => {
    if (escapeResponses && error instanceof Response) throw error;
    return defaultCatch(error, props);
  });
}

export function Suspense(props: SuspenseProps): JSX.Element {
  const root = (globalThis as typeof globalThis & { SUSPENSE_ROOT?: { requests: Map<string | number, unknown> } }).SUSPENSE_ROOT;
  if (!props.rid || !root?.requests.has(props.rid)) return ErrorBoundary(props);
  return EngineSuspense({ ...props, children: boundary(props, false),
    catch: (error: unknown) => defaultCatch(error, props) });
}
export type { ErrorBoundaryProps, SuspenseProps, ResolvedTemplateProps } from './types.js';
