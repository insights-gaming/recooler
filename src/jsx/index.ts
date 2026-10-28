/// <reference types="easy-jsx-html-engine/jsx-runtime" preserve="true" />
import {
  dangerouslyPreventEscaping, Fragment, Suspense as EngineSuspense,
} from 'easy-jsx-html-engine';
import { renderToStream } from 'easy-jsx-html-engine/stream-webapi';
import type { Context, Env, Handler } from 'hono';
import { createElement } from './jsx-runtime.js';
import type { Children, Component, ErrorBoundaryProps, ResolvedTemplateProps, SuspenseProps } from './types.js';
import { mergePageExtras, RouteValidationError, type PageAdapter, type ResolvedRoute } from '../router/index.js';
export { createElement } from './jsx-runtime.js';

/** Augment this interface in @insights-gaming/recooler/jsx to type route bindings and variables. */
export interface RouteEnv extends Env {}
export type RouteContext = Context<RouteEnv>;

export interface RouteProps<TContext = RouteContext> {
  rid: string | number;
  url: URL;
  ctx: TContext;
  /** Request-time snapshot; remains available in deferred Hono 5 Suspense children. */
  params: Readonly<Record<string, string>>;
  head: RouteHead;
  /** Matched manifest pattern, with route groups removed. */
  route: string;
  scripts: string[];
  /** Module URLs for the current route. Render as rel="modulepreload" in custom roots. */
  preloads?: string[];
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
  /** Module URLs for the current route. Render as rel="modulepreload" in custom roots. */
  preloads?: string[];
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
  const plainArray = Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype;
  if (!plainArray && !isPlainObject(value)) return value;
  if (seen.has(value)) return seen.get(value);
  const copy: Record<string, unknown> | unknown[] = Array.isArray(value) ? new Array(value.length) : Object.create(Object.getPrototypeOf(value));
  seen.set(value, copy);
  for (const key of Object.keys(value)) {
    Object.defineProperty(copy, key, { value: copyContainers((value as Record<string, unknown>)[key], seen),
      enumerable: true, configurable: true, writable: true });
  }
  return copy;
}

function copyHead(value: unknown): RouteHead {
  if (!isPlainObject(value) || typeof (value as { then?: unknown }).then === 'function') {
    throw new TypeError('Invalid head: expected a plain object or nullish value');
  }
  return copyContainers(value) as RouteHead;
}

function throwHeadError(error: unknown, source: string): never {
  if (error instanceof Response) throw error;
  const message = `Head in ${source}: ${error instanceof Error ? error.message : String(error)}`;
  const ErrorType = [TypeError, ReferenceError, RangeError, SyntaxError, URIError, EvalError]
    .find(Type => error instanceof Type) ?? Error;
  throw new ErrorType(message, { cause: error });
}

/** Resolve live namespace exports, starting at the last replacing object. */
async function resolveHead(route: ResolvedRoute, ctx: RouteContext): Promise<RouteHead> {
  const entries = [
    { module: route.root, source: route.rootFile ?? `root (used by ${route.file})` },
    ...route.layouts.map((module, i) => ({ module, source: route.layoutFiles[i] ?? `layout ${i + 1} (used by ${route.file})` })),
    { module: route.module, source: route.file },
  ].map(({ module, source }) => {
    try { return { entry: module?.head, source }; }
    catch (error) { return throwHeadError(error, source); }
  });
  let start = 0;
  for (const [i, { entry }] of entries.entries()) {
    if (entry != null && typeof entry !== 'function') start = i;
  }
  let head: RouteHead = {};
  for (const { entry, source } of entries.slice(start)) {
    if (entry == null) continue;
    try {
      const result: unknown = typeof entry === 'function' ? await (entry as RouteHeadFn)(ctx, head) : entry;
      head = result == null ? {} : copyHead(result);
    } catch (error) {
      throwHeadError(error, source);
    }
  }
  return head;
}

const recoolerScript = (src: string) => /(?:\/assets\/recooler-(?:client|route-[a-f0-9]+)\.js|\/@id\/virtual:recooler\/(?:client|route\/))/.test(src);

export function jsxPages(options: JSXPagesOptions = {}): PageAdapter {
  return {
    handler(route, extras) {
      // The router validates own default exports before invoking the page adapter.
      let Content = route.module.default as Component<RouteProps>;
      for (const [i, layout] of [...route.layouts.entries()].reverse()) {
        if (layout.default == null) continue;
        if (typeof layout.default !== 'function') {
          const source = route.layoutFiles[i] ?? `layout ${i + 1} (used by ${route.file})`;
          throw new RouteValidationError([`Invalid layout in ${source}: default export is not a function`]);
        }
        Content = (layout.default as LayoutHOC)(Content);
      }
      const Root = (route.root?.default ?? DefaultRootHOC) as RootHOC;
      if (typeof Root !== 'function') {
        const source = route.rootFile ?? `root (used by ${route.file})`;
        throw new RouteValidationError([`Invalid root in ${source}: default export is not a function`]);
      }
      // Full documents start async modules during streaming; identical deferred
      // URLs still hold DOMContentLoaded. Fragment scripts follow the content so
      // htmx 1 chooses the correct table/select parsing context.
      {
        const Page = Content;
        Content = (props: RouteProps) => {
          const modules = props.scripts.filter(recoolerScript);
          const entry = modules.find(src => /(?:recooler-client\.js|virtual:recooler\/client)/.test(src));
          const fragment = props.ctx.req.header('hx-request') === 'true' && !props.ctx.req.header('hx-boosted');
          const startup = [
            ...(!fragment && Root !== DefaultRootHOC ? props.preloads?.map(href => createElement('link', { rel: 'modulepreload', href })) ?? [] : []),
            ...modules.map(src => createElement('script', { type: 'module', src })),
          ];
          return createElement(Fragment, {},
            ...(!fragment ? modules.map(src => createElement('script', { type: 'module', async: true, src })) : []),
            ...(!fragment ? startup : []),
            createElement(Page, props),
            ...(fragment ? startup : []),
            modules.length > 0 && createElement('template', { 'data-recooler-marker': 'true', 'data-recooler-route': props.route,
              'data-recooler-version': entry && new URL(entry, props.url).searchParams.get('v') }));
        };
      }
      // Named contributions are available to adapters for collision policies. JSX
      // uses the standard ordered extras merge and needs no extension-specific policy.
      const extra = mergePageExtras(extras);
      const scripts = extra.scripts ?? [];
      if (!Array.isArray(scripts) || scripts.some(script => typeof script !== 'string')) {
        throw new TypeError(`Invalid page scripts for ${route.file}: expected URL strings`);
      }
      const preloads = extra.preloads ?? [];
      if (!Array.isArray(preloads) || preloads.some(url => typeof url !== 'string')) {
        throw new TypeError(`Invalid page preloads for ${route.file}: expected URL strings`);
      }
      if (extra.clientScript != null && typeof extra.clientScript !== 'string') {
        throw new TypeError(`Invalid clientScript for ${route.file}: expected a string`);
      }
      const page: JSXPage = {
        route, Root, Content, scripts: [...scripts], preloads: [...preloads],
        clientScript: extra.clientScript as string | undefined,
        head: ctx => resolveHead(route, ctx),
      };
      const render: Handler = async ctx => {
        const params = Object.freeze({ ...ctx.req.param() });
        let ctxWaitUntil: ((promise: Promise<unknown>) => void) | undefined;
        try { ctxWaitUntil = ctx.executionCtx.waitUntil?.bind(ctx.executionCtx); } catch { /* Node has no executionCtx. */ }
        let body: string | ReadableStream<Uint8Array> | undefined;
        let cancelled = false;
        let shellRejected = false;
        try {
          const head = await page.head(ctx);
          const requestScripts = [...page.scripts];
          let shell: JSX.Element | undefined;
          body = await renderToStream(
            (rid: RouteProps['rid']) => shell = Promise.resolve(createElement(page.Root(page.Content, page.clientScript), {
              rid, url: new URL(ctx.req.url), ctx, params, head, route: route.path,
              scripts: requestScripts, preloads: [...page.preloads ?? []], clientScript: page.clientScript,
            })).catch(error => { shellRejected = true; throw error; }),
            { waitUntil: promise => {
              // Shell errors are handled by render below (and Hono's onError).
              // Cancelling the engine stream makes its final writer.close() reject.
              const handled = promise.catch(error => {
                if (!cancelled && !shellRejected) console.error(error);
              });
              ctxWaitUntil?.(handled);
            }, ResolvedTemplate: options.ResolvedTemplate,
              cleanupScriptMiddleware: options.suspenseCleanupScriptMiddleware },
          );
          // The engine already awaits the shell before writing. Await it here too,
          // so async status changes and thrown Responses precede response creation.
          await shell;
          if (body instanceof ReadableStream) {
            // Observe reader.cancel() from clients while retaining stream backpressure.
            const reader = body.getReader();
            body = new ReadableStream<Uint8Array>({
              async pull(controller) {
                const { done, value } = await reader.read();
                if (cancelled) return;
                if (done) { controller.close(); reader.releaseLock(); }
                else controller.enqueue(value);
              },
              cancel(reason) {
                cancelled = true;
                return reader.cancel(reason).finally(() => reader.releaseLock());
              },
            }, { highWaterMark: 0 });
          }
          if (ctx.req.method === 'HEAD' && body instanceof ReadableStream) {
            await body.cancel();
            body = '';
          }
          return ctx.newResponse(body, { headers: { 'content-type': 'text/html' } });
        } catch (error) {
          cancelled = true;
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
  return createElement(Fragment, {},
    dangerouslyPreventEscaping('<!DOCTYPE html>'),
    createElement('html', {},
      createElement('head', {},
        !hasCharsetMeta(props.head) && createElement('meta', { charset: 'utf-8' }),
        renderHeadElements(props.head),
        props.preloads?.map(href => createElement('link', { rel: 'modulepreload', href }))),
      createElement('body', { 'data-recooler-route': props.route },
        createElement(Content, props),
        props.scripts.filter(src => !recoolerScript(src)).map(src => createElement('script', { type: 'module', src })))));
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
export type { FormActionFn, EventHandlerFn } from './htmx-types.js';
