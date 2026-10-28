# recooler/jsx

```ts
import { createApp } from 'recooler/router';
import { jsxPages } from 'recooler/jsx';
import { manifest } from './routes.gen.js';

export default createApp(manifest, { pages: jsxPages() });
```

`jsxPages()` supplies the router's `PageAdapter`. It depends only on the router's
public exports. The router calls the adapter only for routes with an own function
`default` export; API-only routes remain ordinary Hono handlers. An own non-function
`default` is a startup validation error. Route data and its arrays are frozen; the
adapter copies layout arrays before reversing them.
Layouts are HOCs: `(Page) => (props) => <main><Page {...props} /></main>`.
The adapter applies them from the innermost directory outward. Head-only layouts
participate in the head chain without wrapping the page.

Head errors name the route, root or layout source using router metadata.
Handwritten manifests without source metadata receive a descriptive root/layout label.

Head exports are read from module namespaces on each request, in this order:
root, layouts from root to leaf, route. A function receives `(ctx, prev)` and its
return value becomes the new head; an object replaces the prior head. Nullish
exports are skipped; nullish function results reset to `{}`. Functions may be
async, but exporting a Promise as `head` is an error. Head objects must be plain
(including ESM namespace objects).
The chain starts at the last non-null object export: earlier functions are never
called because that object would replace their result. The adapter copies plain
objects and arrays in each object and function result, including nested
meta/link/script props. Promises, URLs, engine elements and class instances
(including Array subclasses) are shared by reference so their rendering behavior
is preserved. Copies isolate
mutations made by later head functions through `prev`; a function that mutates
its own module constant or a shared non-plain value can still leak state.

`RouteProps<TContext = RouteContext>` supplies `rid`, `url`, `ctx`, `params`, `head`, `route`
(the manifest pattern), `scripts`, and the deprecated `clientScript`.
`params` is a readonly copy of `ctx.req.param()` captured when the page handler
runs, before awaiting head resolution. Use `props.params` in deferred Suspense
children: Hono 5 clears the active params once the handler has returned.
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
Arrays concatenate in extension order using the router's public merge rule
(`mergePageExtras(extras)`). The router also supplies named
`{ extension, page }` contributions as the adapter's third argument. JSX does not
use those names or apply an extension-specific collision policy; it reads scripts
and the legacy clientScript from the merged extras.
Each request gets its own script array. The adapter emits Recooler's static module scripts in Content; the default root emits other external module
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

For full pages with client code, Content starts async/deferred copies of identical
client and route module URLs. The module map evaluates each URL once; async
registration works during streaming and the deferred copy guarantees registration
before DOMContentLoaded. Custom roots also get dependency modulepreloads. For
non-boosted htmx fragments, module scripts follow Content and preloads are omitted
so htmx 1 preserves table-row parsing. There is no blocking gate request. Keep
Content intact.

A trailing template[data-recooler-marker] carries route/version metadata only on
client-bearing routes. It survives tables and htmx 1's DOMParser history restore.
Handler-free pages emit no marker. Route values are manifest patterns without mount
prefixes. Initialization reads every marker, never a stale body attribute; it runs
the owning route's onLoad once per marker, including cross-route fragments.

For one release an extension may still provide `page.clientScript: string`.
It is passed to legacy custom roots as the second argument, and is available as
`props.clientScript`; `props.scripts` contains only URL strings. The default root
accepts the legacy string but emits only external URLs from `props.scripts`.
Migrate custom roots to `props.scripts`; client entry scripts stay external. Generated
hx-on dispatch attributes remain inline and use htmx's existing eval permission. A custom root that inlines the legacy source must
be updated by its owner. The old `?script` endpoint is gone; URLs belong to the
extension. Suspense's engine-generated inline scripts are separate from client
entry scripts. The resolved template and cleanup script are configurable through
the options below; the engine loader script is fixed.

Handlers become usable as soon as their slice registers. Route onLoad waits until
DOMContentLoaded (or runs immediately if parsing has finished) and sees the full
DOM. Its promise is not awaited; errors reach reportError. Root/layout handlers
already registered remain usable during body swaps. Only confirm can safely defer
its request while modules load. Generated hx-on attributes have a small inline
fallback that holds unavailable confirms and drops other events without canceling
defaults. A legacy hx-on alias for generated confirms handles htmx 1's synchronous
load-listener ordering; htmx 2 ignores the alias. Native guards may be bypassed before registration;
see the migration guide. Enable htmx.legacyClientScript explicitly for roots that
inline the second argument.

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
