# recooler/jsx

```ts
import { createApp } from 'recooler/router';
import { jsxPages } from 'recooler/jsx';
import { manifest } from './routes.gen.js';

export default createApp(manifest, { pages: jsxPages() });
```

`jsxPages()` supplies the router's `PageAdapter`. It depends only on the router's
public exports. Routes without a default component remain ordinary Hono handlers.
Layouts are HOCs: `(Page) => (props) => <main><Page {...props} /></main>`.
The adapter applies them from the innermost directory outward. Head-only layouts
participate in the head chain without wrapping the page.

Head exports are read from module namespaces on each request, in this order:
root, layouts from root to leaf, route. A function receives `(ctx, prev)` and its
return value becomes the new head; an object replaces the prior head. Nullish
exports are skipped; nullish function results reset to `{}`. Functions may be
async, but exporting a Promise as `head` is an error. Objects must be plain,
`structuredClone`-compatible data. The adapter deep-clones each object and each
function result for request isolation, including nested meta/link/script props.

`RouteProps<TContext = Context>` supplies `rid`, `url`, `ctx`, `head`, `route`
(the manifest pattern), `scripts`, and the deprecated `clientScript`.
`RouteHead` and `RouteHeadFn<TContext>` are exported types; import these types
explicitly rather than depending on the old ambient declarations.
`renderHeadElements`, `DefaultRootHOC`, `Suspense`, `ErrorBoundary`, and their
prop types are also exported. `ErrorBoundary` always rethrows a `Response`, even
if its catch callback throws one. The page handler sends Responses thrown during
head or initial page rendering as-is. Once a Suspense response starts streaming,
its HTTP status and headers have already been sent; deferred work cannot redirect
that response. Suspense and its streaming scripts retain engine 0.1.13 behavior.

## Context props on HTML elements

Opt in to the automatic JSX runtime:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "recooler/jsx"
  }
}
```

For development, `react-jsxdev` uses the matching `jsx-dev-runtime` export.
Configure the bundler's JSX import source as well when it overrides tsconfig.
The runtimes pass props to components unchanged, and remove every intrinsic
attribute whose value is a Hono `Context`, under any name. Both `<div {...props}>`
and `<div {...{ ...props, title }}>` work without the htmx transform. Ordinary
values in an attribute named `ctx` are preserved. Contexts must come from the
same Hono runtime as the adapter (dedupe Hono in your application).

A dependency already compiled against the engine runtime does not consult your
tsconfig. Recompile it with this import source, or use Vite aliases for its
runtime imports:

```ts
resolve: {
  alias: {
    'easy-jsx-html-engine/jsx-runtime': 'recooler/jsx/jsx-runtime',
    'easy-jsx-html-engine/jsx-dev-runtime': 'recooler/jsx/jsx-dev-runtime',
  },
}
```

Calls directly to the engine's `createElement` do not pass through the wrapped
runtimes; use the wrapped JSX runtime for wrappers that forward Context props.
No global engine or Context prototype is modified.

## Root and client scripts

The root is `manifest.root?.default ?? DefaultRootHOC`. Modern root HOCs receive
`(Content, scripts: string[])`; extensions supply URLs via `page: { scripts }`.
Arrays concatenate in extension order using the router's public merge rule.
Each request gets its own script array. The default root emits external module
scripts after content, adds `<body data-recooler-route="/pattern/:id">`, and adds
UTF-8 charset only when head metas declare no rendered charset attribute.
Custom roots should render those URLs themselves, for example:

```tsx
import { renderHeadElements, type RouteProps } from 'recooler/jsx';
import type { Component } from 'easy-jsx-html-engine';

export default function Root(Content: Component<RouteProps>, scripts: string[]) {
  return (props: RouteProps) => <html>
    <head>{renderHeadElements(props.head)}</head>
    <body><Content {...props} />{scripts.map(src => <script type="module" src={src} />)}</body>
  </html>;
}
```

For a custom root, the adapter puts `<meta name="recooler-route" content="…">`
at the beginning of the Content slot. This remains discoverable even if the root
renders its own body and does not call `renderHeadElements`. The value is the
manifest pattern, not the concrete request URL or mount prefix.

For one release an extension may still provide `page.clientScript: string`.
It is passed to legacy custom roots as the second argument, and is available as
`props.clientScript`; `props.scripts` still contains the URL array. When both
are provided, this legacy second-argument convention takes precedence. The
default root accepts the string but emits only external URLs from `props.scripts`.
Migrate custom roots to the array argument (or `props.scripts`); adapter-generated
client code is never inlined. A custom root that inlines the legacy source must
be updated by its owner. The old `?script` endpoint is gone; URLs belong to the
extension. Suspense's engine-generated inline scripts are separate from client
entry scripts and remain configurable through the options below.

## Rendering options

`jsxPages({ ResolvedTemplate, suspenseCleanupScriptMiddleware, handlerFactory })`
replaces `CreateJSXRouteHandlerFactory` and the Farm `route_handler_factory`
option. `ResolvedTemplate` and `suspenseCleanupScriptMiddleware` are passed to
`renderToStream`; the request execution context's `waitUntil` is forwarded when
available. `handlerFactory(page, render)` receives the resolved `JSXPage`
descriptor and default Hono `Handler`, and returns a handler:

```ts
jsxPages({
  handlerFactory(page, render) {
    return (ctx, next) => {
      ctx.header('x-page', page.route.path);
      return render(ctx, next);
    };
  },
});
```

The descriptor exposes `route`, `Root`, composed `Content`, `head(ctx)`, `scripts`,
and deprecated `clientScript`, so a custom factory can replace rendering entirely.
