import type { RouteProps, RouteHead } from '../../../../../../../../src/jsx/index.js';
export function head(_ctx: unknown, prev: RouteHead) { return { ...prev, title: `${prev.title} / route` }; }
export default function Page({ ctx, url }: RouteProps) {
  return <article data-id={ctx.req.param('id')}>{url.pathname}</article>;
}
