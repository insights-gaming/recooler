# Synthetic consumer shape fixtures

These are small, independently authored apps. They contain no consumer source,
identifying names, data or services. Repeated route siblings are compressed; the
route shapes and feature combinations come from the generic
[inventory](../../docs/plans/consumer-inventory.md).

From the repository root, using Node 22 and pnpm 12:

```sh
pnpm install
pnpm --dir fixtures/consumer-shape/router build
pnpm --dir fixtures/consumer-shape/admin build
node fixtures/consumer-shape/check.mjs
```

Each app pins the **published** `farm-plugin-recooler@0.0.27` (not the workspace
Rust plugin), `@farmfe/core@1.7.11`, Hono 4.12.29 and the JSX engine 0.1.13. Farm
uses `persistentCache: false`, no decorators, automatic JSX, one ESM output file
and a user-owned Worker entry. It does not require a local Rust build. The root
workspace lockfile is authoritative. `pnpm --dir … check` runs just that fixture.

## Shapes

- `router`: 14 handler-only routes, physical depth 5 / URL depth 4, one group
  with a parameter-reading guard on four routes, four ordered root middleware, three literal
  underscore prefixes, a root catch-all plus nested catch-alls, static-over-rest
  precedence, named handler re-exports, an `onRequest` → `onGet` fall-through,
  service-binding delegation and a non-route star barrel inside `routes/`. No root or layout.
- `admin`: eight routes below one literal underscore prefix, maximum depth 4,
  two ordered plain-prefix middleware, a layout HOC, a custom root taking
  `clientScript`, and a custom renderer with both streaming hooks. Heads use
  exported function declarations and const arrows. Pages use POST and DELETE
  actions, typed form payloads, JSX/Response/undefined results, primitive and
  object captures, ctx on component props, prop spreads and components outside
  routes. It includes a wrapper that forwards an event handler via a data
  attribute, explicit TypeScript `this` params, dash/colon event forms, string
  double-dash events, URL-valued `hx-get`, route onLoad in both observed forms,
  an ignored layout onLoad, Suspense, helper ErrorBoundary and a named Worker
  class export. An unimported component deliberately defines an unused action. Cross-route page imports and a handler-only endpoint importing an action-bearing page exercise module-graph boundaries. A throwing action tests `ctx.error`, response exceptions and after-next middleware. The layout branches on `hx-request` and supplies boundary catch callbacks.

The admin component barrel is an **additional graph regression case**, not an
observed local consumer barrel. It exercises named re-export reachability. The
router utility barrel is made reachable by the entrypoint, so its shape
participates in the build. Neither consumer currently uses nested inline actions,
explicit `actionScope`/`handlerScope`, object-literal action props, dot-hidden
directories or middleware in a plain directory inside a group. Those absent
features belong to the general conformance suite, not an invented inventory.

Admin bans platform imports, Hono, the JSX engine and its synthetic server-only
module from handler slices. A real CSS import passes through a small synthetic plugin that reproduces the legacy patched PostCSS string export (no Tailwind required). Its handler imports `env` from `cloudflare:workers`; `node-loader.mjs` supplies an explicit Node stub while the server bundle keeps the platform import external. Port that CSS import to `?inline` in Vite. The shared server component can import the marker;
its browser script must not contain it. The expected warning about layout
`onLoad` is deliberate. Auth uses only `x-auth: yes`. A local `SERVICE.fetch`
stub supplies the router's forwarding responses. No database, deployment,
external service or credentials are required.

## Request format and capture

`requests.json` has `schemaVersion: 1`, oracle version metadata, and an ordered
`requests` array. Each request has:

- `name`: unique scenario identifier.
- `path`, optionally `method`, `headers`, and a string `body`.
- Or `actionFrom: { request, element, attribute? }`: find an HTML element by its
  `id` in an earlier response, read its htmx URL (`hx-post` by default), unescape
  `&amp;`, and resolve it relative to that response URL. The method is still
  explicit. This avoids hardcoding action IDs, serialized scopes or signatures.
- `expect.status`, with optional exact `body`, exact selected `headers`,
  `bodyIncludes` and `bodyExcludes` arrays. Header values may be null to assert
  absence. Assertions intentionally avoid full streaming bodies and random
  Suspense request IDs.

The current expectations were captured and manually checked against the pinned
0.0.27 builds: **18 router requests and 24 admin requests**, all passing. Reviewed
facts include middleware traces, auth denials, re-exported handlers, catch-all
fall-through, page/head/root structure, script slicing, ignored layout onLoad,
204 refresh headers supplied by user middleware, DELETE status, and shared
component captures on both a list route and a param route.

To save full *synthetic* observations for inspection without adding build output
to the repository:

```sh
mkdir -p /private/tmp/recooler-consumer-observations
RECOOLER_OBSERVATIONS=/private/tmp/recooler-consumer-observations node fixtures/consumer-shape/check.mjs
```

The runner sends requests to the actual built default Worker export with stub
bindings and an execution context. It does not execute browser JavaScript; script
contents are inspected as response facts. This format can be adapted to the
scenario runner in `conformance/`; these fixtures do not modify that directory.

The router also places a root `return await next()` middleware ahead of a
handler returning `undefined`. Its GET result is a non-Response Hono Context;
the equivalence self-test records that outcome before reading response fields
and records the separate HEAD error with its message.
