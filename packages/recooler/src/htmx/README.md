# htmx server runtime (Phase 4a)

```ts
import { createApp } from 'recooler/router';
import { jsxPages } from 'recooler/jsx';
import { htmx, type ActionTable } from 'recooler/htmx';
import { manifest } from './routes.gen';

const table = {
  'routes/users/[id]/index.tsx': [
    'routes/users/[id]/index.tsx', 'routes/layout.tsx', 'root.tsx',
    'components/Editor.tsx',
  ],
} satisfies ActionTable;

export default createApp<{ Bindings: { ACTION_SECRET: string } }>(manifest, {
  pages: jsxPages(),
  extensions: [htmx<{ Bindings: { ACTION_SECRET: string } }>({
    table,
    secret: env => env.ACTION_SECRET,
  })],
});
```

`ActionTable` is `Readonly<Record<string, readonly string[]>>`. Keys are exact
manifest `route.file` identities. Values are the action-bearing module IDs from
`registerActions(moduleId, methods)`, including the route's root, layouts and
surviving static dependencies. IDs must match the transform's supplied
`relativePath`; there is no implicit prefix normalization. Missing keys mean no
actions. Only routes with their own function `default` export register actions;
handler-only routes ignore table entries.

The bundler will supply this table through a virtual module in a later phase.
Static imports, re-exports (including barrels) and side-effect imports contribute
graph edges. Dynamic `import()` is not followed in v1. Barrels over-approximate
reachability; signing prevents a foreign URL from authorizing an unused action.
The table is trusted server configuration, never request input.

For development use `table: () => currentTable`. The synchronous getter is read
when registering and at each request's binding; the module list is copied and
frozen for that request. Getter mode registers the five supported action methods
on page routes so a reload can introduce a method. Static-table mode registers
only currently reachable action methods; reconstruct the app if those methods
change. A dev plugin must coordinate table refresh and SSR reloads. The persistent
`Symbol.for` registry survives runtime-module reloads; each module replaces its
registration atomically, and `registerActions(id, {})` removes all of its actions.
Do not clear cached modules' registrations in dispose hooks.

## Dispatch and security

After scoped route middleware, htmx binds `{ routeId: route.file, pathname }`
using the exact `new URL(ctx.req.url).pathname`, and enters Hono context storage
on **every existing route registration**, including handler-only registrations.
`actionUrl(id, scope, ctx?)` reads that binding; explicit `ctx` overrides ambient
context. It preserves percent encoding and works inside deferred Suspense on
Hono 5. Hono's mutable route index and decoded params are never used to form URLs.
The Worker needs AsyncLocalStorage support (`nodejs_als` or `nodejs_compat`).

Only `?action=` on a method with reachable actions is reserved. Ordinary requests
continue through `onRequest`, method handlers and pages. Action requests require
`HX-Request: true`, then Hono CSRF's origin/Fetch Metadata policy, applied even to
GET and non-form content types. Either `Sec-Fetch-Site: same-origin` or an allowed
`Origin` suffices, matching `hono/csrf`. Same-site alone does not suffice. The
request URL's origin is always allowed; `trustedOrigins` adds exact origins via
an array or `(origin, context) => boolean | Promise<boolean>`.

A synchronous HMAC-SHA256 signs a versioned JSON tuple of route file, exact
pathname, uppercase method, action ID and exact serialized scope. Every URL,
including an action without captures, is signed. Signatures are compared without
data-dependent early exit for equal-length strings. There is no expiry or session
binding in v1: anyone holding a valid URL can replay it on the same route/path
with valid CSRF headers. Authentication and authorization remain the route's job.
Unknown, unsigned, tampered, foreign-route and wrong-path actions call `next()`;
that route's terminal handlers/page are bypassed and later registrations run their
own middleware, ending in 404 when nothing answers. Guards still run first and
may return 401. `HEAD` does not run GET actions: the signature uses the actual
method, and only the five transform action methods are reserved.

`secret` accepts a nonempty string or a synchronous function of the request env.
An env function is resolved once per extension instance on the first request with
actions, then cached, so key rotation requires a new app/instance. A missing or
empty secret fails startup when reachable actions are already registered, or the
first request when actions arrive through the getter later. The secret stays in
server runtime configuration; no transform inlines it.

`secret: false` explicitly disables signing and verification and emits a warning.
URLs are unsigned; CSRF and module reachability still apply, but **D6 route/path
replay protection is disabled**. Use it only for local development. It is not a
production compatibility mode.

`base: '/app'` adds an external prefix hidden by `app.mount()` or a prefix-stripping
proxy. `route()` and `basePath()` expose the prefix in the pathname already, so
omit `base` there. Mount actions without an appropriate base are unsupported.
Root catch-all paths beginning `//` or `/\\` are prefixed with `/.` so generated
URLs stay on the rendering origin. The signed pathname remains the incoming one.

## Runtime helpers and client boundary

`recooler/htmx/runtime` implements the transform contract: `registerActions`,
`actionUrl`, `wrapAction`, `wrapActionWithPayload`, `actionScope`, `handlerScope`.
Captured factories read their JSON scope after extension signature verification.
Wrappers alone are not secure HTTP dispatchers. Missing or malformed factory
scope retains the legacy 400 response; invalid signatures fall through before a
factory runs. GET receives `{}`; other methods receive last-value form fields
plus `__formData` with all fields/files. Serialization retains 0.0.27 checks and
undefined behavior; unsupported nested values and cycles throw with their path.
`actionScope` retains the query-fragment API but now needs an ambient route binding
and includes the complete D6 signature. There is no global `configureActions`.

Renderable action results are rendered as JSX children. Returned/thrown Responses
pass through, including render-time Responses; nullish results produce 204.

Client slices already write their own functions to `globalThis.$handlers` and do
not import the server runtime. Phase 5 owns client entry loading, onLoad and lazy
chunks. This extension contributes `page.scripts: []` for now. Middleware-rendered
login forms need an unguarded route; actions are never registered before guards.

`recooler/htmx/testing` exports only the test capability helper:

```ts
signActionUrl({ routeId, pathname, method, actionId, scope }, secret): string
```

Use the receiving manifest route file as `routeId`, and the exact pathname visible
to that app (without an external mount base stripped by Hono). The helper returns
a local URL; an adapter can prepend its external mount prefix. This is for
conformance/consumer dispatch adapters. Do not expose capability minting as an
application endpoint.

## Verification

`pnpm --filter recooler test`, `pnpm --filter recooler typecheck` and
`pnpm --filter recooler build` cover this package. Runtime tests run on Hono
4.12.34, 4.13.14 and 5.0.0-rc.1, including 88 HMAC vectors per version against
`node:crypto`, real transformed modules evaluated through data URLs, and streamed
Suspense. The package currently passes 1,270 tests. The unchanged Farm conformance
target passes 533 tests with seven intentional TS-only skips. Filesystem watcher
and Vite dev-server tests require local filesystem watching/loopback permissions.
