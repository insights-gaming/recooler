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
`registerActions(moduleId, methods, namespace?)`, including the route's root, layouts and
surviving static dependencies. IDs must match the transform's supplied
`relativePath`; there is no implicit prefix normalization. Missing keys mean no
actions. Only routes with their own function `default` export register actions;
handler-only routes ignore table entries.

The Vite plugin supplies this table through `virtual:recooler/htmx` (Phase 4b).
Static imports, re-exports (including barrels) and side-effect imports contribute
graph edges. Dynamic `import()` is not followed in v1. Barrels over-approximate
reachability; signing prevents a foreign URL from authorizing an unused action.
The table is trusted server configuration, never request input.

The table is static. Only reachable action methods are registered at app creation.
In development, D5 uses a full SSR reload with `invalidateAll`, re-evaluating the
virtual table module and `createApp` after edits. Getter tables are unsupported.
The persistent `Symbol.for` registry survives runtime-module reloads; each module
replaces its registration atomically, and `registerActions(id, {}, namespace)`
removes its actions. Do not clear cached modules' registrations in dispose hooks.

`registerActions(moduleId, methods, namespace?)` and `htmx({ namespace, ... })`
must use the same namespace. Phase 4b's Vite plugin **must emit a stable per-project
namespace** into both registrations and extension configuration to isolate apps
with identical relative module IDs. Omitting it retains the default namespace for
the transform's current emission; apps sharing that default also share registrations.

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
`HX-Request: true` plus either `Sec-Fetch-Site: same-origin`, an `Origin` accepted
by `trustedOrigins` regardless of Fetch Metadata, or the request URL's own origin
when `Sec-Fetch-Site` is absent. This inline check applies even to GET, bodyless
and non-form requests and returns 403 directly, without invoking `onError`.
`trustedOrigins` accepts an array of exact origins or
`(origin, context) => boolean | Promise<boolean>`. Same-site alone does not suffice.
An untrusted request with `cross-site` or an empty `Sec-Fetch-Site` is rejected
even if its Origin equals the request URL's origin.

A synchronous HMAC-SHA256 caches the keyed inner/outer pad compression states
per resolved secret and signs a versioned JSON tuple of route file, exact
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
An env function is resolved once per env object identity and cached in a WeakMap,
with one fallback slot for non-object envs. Rotation within the same env object
requires a new app/instance or a new env object. Missing/empty secrets fail app
creation for statically configured keys or the first request for env functions.
Keys and HMAC pads stay in signing closures; `c.var` contains only the signing
function and route metadata, so serializing it does not reveal the key.

`secret: false` throws a migration error. The replacement,
`secret: { unsafeUnsigned: true }`, explicitly disables signing and verification.
URLs are unsigned; CSRF and module reachability still apply, but **D6 route/path
replay protection is disabled**, including protection against unused barrel actions.
Use it only for local development. Each `htmx()` creation logs one runtime warning
for this mode. The exported `unsafeUnsignedMarker` symbol is
true on the returned extension in this mode. The Vite plugin defines a production
flag, and `htmx()` **throws at startup** in every build, including custom entries,
unless `allowUnsignedInProduction: true` is explicitly set. It need not execute
Worker bundles in Node or statically detect a runtime marker. The override retains
the warning and marker; CSRF and reachability still apply. Without the Vite plugin,
this bundler-independent runtime does not infer production from a host platform.
See [Vite integration](../vite/README.md) for automatic table/namespace wiring and
request-time `secretBinding` resolution.

Actions run after directory/group middleware but **before `onRequest`**, as in
0.0.27. Authorization in `onRequest` does not protect actions; use directory or
group middleware instead. All extension middleware runs before extension handlers,
so `htmx()` need not be the first extension.

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
`actionUrl` throws if an action uses a method that was not reserved on the route
at app creation. Register actions before `createApp` and recreate the app after
a full SSR reload; late actions on an already reserved method remain usable.
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
Suspense. The Farm conformance target retains seven intentional TS-only skips. Filesystem watcher
and Vite dev-server tests require local filesystem watching/loopback permissions.
