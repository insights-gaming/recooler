import { DefaultRootHOC, ErrorBoundary, Suspense, jsxPages, type RouteHead, type RouteHeadFn, type RouteProps } from 'recooler/jsx';
import type { Context } from 'hono';

export const head: RouteHead = { title: 'typed', metas: [{ charset: 'utf-8' }] };
export const headFn: RouteHeadFn = (ctx, prev) => ({ ...prev, title: ctx.req.path });
export const root = DefaultRootHOC((props) => <main><p>{props.url.pathname}</p></main>);
export const Page = (props: RouteProps) => <div ctx={props.ctx}><ErrorBoundary catch={<p>failed</p>}><Suspense rid={props.rid} fallback="loading">{Promise.resolve('ok')}</Suspense></ErrorBoundary></div>;
export const pages = jsxPages({ ResolvedTemplate: ({ id, children }) => <div data-id={id}>{children}</div> });
export const context: Context = {} as Context;
// @ts-expect-error ordinary HTML title still requires a string
export const invalid = <p title={123}>bad</p>;
