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

// Module augmentation types every default RouteProps/RouteHeadFn context.
declare module 'recooler/jsx' {
  interface RouteEnv { Bindings: { DB: string }; Variables: { user: string } }
}
export const bindings = (props: RouteProps) => {
  const params: Readonly<Record<string, string>> = props.params;
  // @ts-expect-error params are a readonly request-time snapshot
  props.params.id = 'changed';
  const db: string = props.ctx.env.DB;
  const user: string = props.ctx.get('user');
  // @ts-expect-error bindings are typed, not any
  const invalid: number = props.ctx.env.DB;
  return <div ctx="user data">{db}{user}{invalid}{params.id}</div>;
};
export const keyed = (props: RouteProps) => <li {...{ title: 'item' }} ctx={props.ctx} key="id">item</li>;
