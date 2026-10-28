/// <reference types="easy-jsx-html-engine/jsx-runtime" preserve="true" />
import {
  createElement, dangerouslyPreventEscaping, defaultCatch, Fragment, Suspense as EngineSuspense,
} from 'easy-jsx-html-engine';
import { renderToStream } from 'easy-jsx-html-engine/stream-webapi';
import type { Context, Handler } from 'hono';
import type { Children, Component, ErrorBoundaryProps, ResolvedTemplateProps, SuspenseProps } from './types.js';
import { mergePageExtras, type PageAdapter, type ResolvedRoute } from '../router/index.js';

export interface RouteProps<TContext = Context> {
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

export interface RouteHeadFn<TContext = Context> {
  (ctx: TContext, prev: RouteHead): RouteHead | null | undefined | PromiseLike<RouteHead | null | undefined>;
}

/** The string argument is retained for one release for legacy clientScript users. */
export type RootHOC = (Content: Component<RouteProps>, scripts?: string[] | string) => Component<RouteProps>;
export type LayoutHOC = (Content: Component<RouteProps>) => Component<RouteProps>;

export interface JSXPage {
  route: ResolvedRoute;
  Content: Component<RouteProps>;
  Root: RootHOC;
  head(ctx: Context): Promise<RouteHead>;
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

function copyHead(value: unknown, source: string): RouteHead {
  if (!isPlainObject(value) || typeof (value as { then?: unknown }).then === 'function') {
    throw new TypeError(`Invalid head in ${source}: expected a function, plain object, or nullish value`);
  }
  return structuredClone(value);
}

/** Resolve namespace exports on each request, including aliases and star re-exports. */
async function resolveHead(route: ResolvedRoute, ctx: Context): Promise<RouteHead> {
  let head: RouteHead = {};
  for (const module of [route.root, ...route.layouts, route.module]) {
    const entry = module?.head;
    if (entry == null) continue;
    if (typeof entry === 'function') {
      const result: unknown = await (entry as RouteHeadFn)(ctx, head);
      // Clone function results too: a function can return a module-level constant.
      head = result == null ? {} : copyHead(result, route.file);
    } else {
      head = copyHead(entry, route.file);
    }
  }
  return head;
}

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
          createElement('meta', { name: 'recooler-route', content: props.route }),
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
        let waitUntil: ((promise: Promise<unknown>) => void) | undefined;
        try { waitUntil = ctx.executionCtx.waitUntil?.bind(ctx.executionCtx); } catch { /* Node has no executionCtx. */ }
        try {
          const head = await page.head(ctx);
          const requestScripts = [...page.scripts];
          return ctx.newResponse(await renderToStream(
            (rid: RouteProps['rid']) => createElement(page.Root(page.Content, page.clientScript ?? requestScripts), {
              rid, url: new URL(ctx.req.url), ctx, head, route: route.path,
              scripts: requestScripts, clientScript: page.clientScript,
            }),
            { waitUntil, ResolvedTemplate: options.ResolvedTemplate,
              cleanupScriptMiddleware: options.suspenseCleanupScriptMiddleware },
          ), { headers: { 'content-type': 'text/html' } });
        } catch (error) {
          if (error instanceof Response) return error;
          throw error;
        }
      };
      return options.handlerFactory?.(page, render) ?? render;
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

export const DefaultRootHOC: RootHOC = (Content, scripts) => (props: RouteProps) => createElement(Fragment, {},
  dangerouslyPreventEscaping('<!DOCTYPE html>'),
  createElement('html', {},
    createElement('head', {},
      !hasCharsetMeta(props.head) && createElement('meta', { charset: 'utf-8' }),
      renderHeadElements(props.head)),
    createElement('body', { 'data-recooler-route': props.route },
      createElement(Content, props),
      // Legacy source is made available to custom roots, but never inlined here.
      (Array.isArray(scripts) ? scripts : props.scripts)?.map(src => createElement('script', { type: 'module', src })))));

/** Like the engine boundary, but a Response escapes every catch, including the default catch. */
export function ErrorBoundary(props: ErrorBoundaryProps): JSX.Element {
  const children = props.children;
  const result = Promise.resolve().then(() => createElement(Fragment, {},
    Array.isArray(children) && children.length === 1 && typeof children[0] === 'function'
      ? children[0]() : children as Children));
  return result.catch(error => {
    if (error instanceof Response) throw error;
    if (props.catch == null) return defaultCatch(error);
    return typeof props.catch === 'function' ? props.catch(error) : createElement(Fragment, {}, props.catch);
  }).catch(error => {
    if (error instanceof Response) throw error;
    return defaultCatch(error);
  });
}

export const Suspense: (props: SuspenseProps) => JSX.Element = EngineSuspense;
export { defaultCatch };
export type { ErrorBoundaryProps, SuspenseProps, ResolvedTemplateProps } from './types.js';
