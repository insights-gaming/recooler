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
async, but exporting a Promise as `head` is an error. Head objects must be plain
(including ESM namespace objects).
The chain starts at the last non-null object export: earlier functions are never
called because that object would replace their result. The adapter copies plain
objects and arrays in each object and function result, including nested
meta/link/script props. Promises, URLs, engine elements and class instances are
shared by reference so their rendering behavior is preserved. Copies isolate
mutations made by later head functions through `prev`; a function that mutates
its own module constant or a shared non-plain value can still leak state.

`RouteProps<TContext = RouteContext>` supplies `rid`, `url`, `ctx`, `head`, `route`
(the manifest pattern), `scripts`, and the deprecated `clientScript`.
`RouteHead` and `RouteHeadFn<TContext>` are exported types; import these types
explicitly rather than depending on the old ambient declarations. The old global
`RouteProps`, `RouteHead`, and `RouteHeadFn` declarations are no longer installed.
Augment `RouteEnv` to type the default route context (or pass a Context type as
the generic argument):

```ts
import type { RouteProps } from 'recooler/jsx';
declare module 'recooler/jsx' {
  interface RouteEnv {
    Bindings: { DB: Database };
    Variables: { user: string };
  }
}
// RouteProps['ctx'].env.DB is Database; ctx.get('user') is string.
```

`renderHeadElements`, `DefaultRootHOC`, `Suspense`, `ErrorBoundary`, and their
prop types are also exported. `ErrorBoundary` always rethrows a `Response`, even
if its catch callback throws one. The page handler sends Responses thrown during
head or initial page rendering as-is. Once a Suspense response starts streaming,
its HTTP status and headers have already been sent; deferred work cannot redirect
that response. Without a streaming request, Suspense delegates to ErrorBoundary
and Responses escape. While streaming, a thrown Response is logged and the catch
content is rendered instead. Default catches log the error and render only
`Internal Server Error`; pass `showStack` to a boundary or Suspense (or
`defaultCatch(error, { showStack: true })`) to expose server stack traces in HTML.

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
values in an attribute named `ctx` are preserved. Context values are detected as
Hono-shaped objects; the structural check works across Hono copies and the JSX
runtime has no Hono runtime import.

A dependency already compiled against the engine runtime does not consult your
tsconfig. Recompile it with this import source, or use Vite aliases for its
runtime imports when that dependency is bundled:

```ts
resolve: {
  alias: {
    'easy-jsx-html-engine/jsx-runtime': 'recooler/jsx/jsx-runtime',
    'easy-jsx-html-engine/jsx-dev-runtime': 'recooler/jsx/jsx-dev-runtime',
  },
}
```

These aliases do not rewrite externalized dependencies. Bundle dependencies that
need this adaptation (for example with `ssr.noExternal`), or recompile them.
Engine 0.1.13 also has extensionless ESM imports and cannot be loaded directly by
Node's native ESM loader; it must be bundled for that deployment.

`createElement` from `recooler/jsx` applies the same Context filtering, including
the classic JSX fallback used for `<li {...item} key={id}>`. Calls directly to
the engine's `createElement` bypass filtering.
No global engine or Context prototype is modified.

## Root and client scripts

The root is `manifest.root?.default ?? DefaultRootHOC`. Root HOCs receive
`(Content, clientScript?: string)` for 0.1.x compatibility with 0.0.27 roots.
The second argument is always a legacy source string or `undefined`, never a URL
array. Extensions supply URLs via `page: { scripts }`; roots read `props.scripts`.
Arrays concatenate in extension order using the router's public merge rule.
Each request gets its own script array. The default root emits external module
scripts after content, adds `<body data-recooler-route="/pattern/:id">`, and adds
UTF-8 charset only when head metas declare no rendered charset attribute.
Custom roots should render those URLs themselves, for example:

```tsx
import { renderHeadElements, type RouteProps } from 'recooler/jsx';
import type { Component } from 'easy-jsx-html-engine';

export default function Root(Content: Component<RouteProps>) {
  return (props: RouteProps) => <html>
    <head>{renderHeadElements(props.head)}</head>
    <body><Content {...props} />{props.scripts.map(src => <script type="module" src={src} />)}</body>
  </html>;
}
```

For a custom root, the adapter puts `<meta name="recooler-route" content="…">`
at the beginning of the Content slot. This remains discoverable even if the root
renders its own body and does not call `renderHeadElements`. The value is the
manifest pattern, not the concrete request URL or mount prefix. Roots wrapping
`DefaultRootHOC` use its body attribute and do not get a second meta marker.

For one release an extension may still provide `page.clientScript: string`.
It is passed to legacy custom roots as the second argument, and is available as
`props.clientScript`; `props.scripts` contains only URL strings. The default root
accepts the legacy string but emits only external URLs from `props.scripts`.
Migrate custom roots to `props.scripts`; adapter-generated client code is never inlined. A custom root that inlines the legacy source must
be updated by its owner. The old `?script` endpoint is gone; URLs belong to the
extension. Suspense's engine-generated inline scripts are separate from client
entry scripts. The resolved template and cleanup script are configurable through
the options below; the engine loader script is fixed.

Phase 5 concern: external module scripts run only after the entire Suspense
stream finishes, whereas the 0.0.27 inline onLoad script could run immediately.
Client entry loading and onLoad timing must account for this during Phase 5.

## Rendering options

`jsxPages({ ResolvedTemplate, suspenseCleanupScriptMiddleware, handlerFactory })`
replaces `CreateJSXRouteHandlerFactory` and the Farm `route_handler_factory`
option. `ResolvedTemplate` and `suspenseCleanupScriptMiddleware` are passed to
`renderToStream`; background stream errors are always caught and logged, and the
handled promise is forwarded to the request execution context's `waitUntil` when
available. The adapter waits for the initial shell before sending status and
headers, and cancels streams discarded by HEAD requests.
`handlerFactory(page, render)` receives the resolved `JSXPage` descriptor and
default Hono `Handler`, and returns a handler:

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
