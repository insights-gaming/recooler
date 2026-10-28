# Plan: rewrite recooler in TypeScript on Vite 8 / Rolldown

Status: in progress (0.1.0, branch `ssttevee/typescript-rewrite-0-1-0`) · Last updated: 2026-10-27 · Baseline: Farm plugin 0.0.27 (published; `d284b32`)

## Summary

Rewrite recooler as TypeScript packages on Vite 8 (Rolldown), dropping Farm and the Rust plugin. There is no interim native step: the htmx transform is ported straight to TypeScript.

The rewrite splits recooler into three layers that can be used on their own:

1. **Router.** A file-based routing code generator that writes `src/routes.gen.ts`, plus a `createApp(manifest, options)` runtime for Hono. It is bundler-agnostic.
2. **JSX pages.** A page adapter for the router: layouts, head, root, Suspense and ErrorBoundary on `easy-jsx-html-engine`.
3. **htmx.** A Vite plugin with the form action and event handler transform, plus a router extension for action dispatch and client scripts.

The Farm plugin ends at 0.0.27, which is the reference implementation. The TypeScript packages port its behaviour (§ "Reference behaviour"), and a conformance suite built from the 0.0.27 playground and review scenarios checks that they match.

## Why

### Build time was dominated by nested compiles, not the transform

Synthetic app: N routes, each with 3 form actions and 1 event handler (`docs/plans/fixtures/bench/gen-app.mjs`). Farm 1.7.11, `persistentCache: false`, "Build completed in", medians of 3 interleaved runs at load average 7–14 (re-measured 2026-10-16):

| Farm 1.7.11, with event handlers | 100 routes | 400 routes |
|---|---|---|
| 0.0.25 | 5.2 s | 72.1 s |
| 0.0.25 + a fresh `FarmPluginDefine` per nested compile | 0.53 s | 1.98 s |
| 0.0.26 | 0.30 s | 1.20 s |
| 0.0.27 branch (`8684457`, interleaved with 0.0.26 at load 6) | 0.30 s | 1.12 s |
| 0.0.25 without event handlers (no client compiles) | 0.08 s | 0.31 s |

- 0.0.25 was quadratic: `farmfe_plugin_define`'s `config` hook appended to internal state on every nested `Compiler::new`. 0.0.26 is linear to 400 routes (3.0 ms per route) and mildly superlinear past 800 (4.3 ms per route at 1,600).
- In 0.0.26 the client compiles take about 2 ms each and about 65% of a 400-route build. The htmx transform costs 37–55 µs per call, about 5% of the build.
- "Build completed in" excludes 0.55–0.7 s of startup. The persistent cache gives no speedup at 400 routes.

### Native code buys nothing once the transform runs inside Vite

Vite 8.3.4, SSR build, source maps, no minify, median of 5 in-process builds, re-measured 2026-10-16 at load 12–14:

| | 100 routes | 400 routes | 1000 routes |
|---|---|---|---|
| No htmx plugin | 25 ms | 55 ms | 118 ms |
| Existing Rust transform via napi | 44 ms | 143 ms | 353 ms |
| JS stand-in (oxc-parser raw transfer + magic-string) | 41 ms | 135 ms | 272 ms |

- A napi call costs 155–167 µs. Vite adds about another 40 µs per module to parse the returned source map, so the table gives 195–210 µs per module.
- The JS stand-in did no scope analysis, and its output was semantically broken. It shows parity at best, not a speedup.
- The decision rests on maintenance, not speed:
  - Native code means a nine-binary release matrix.
  - The Rust plugin crosses the Farm ABI by raw layout. hstr had to be pinned to match the host, or builds segfaulted.
  - The host's `config.script` reads as garbage through the plugin's farmfe_core. With `decorators: true`, about 75% of builds fail. This can't be fixed from the plugin side.
- The TS transform's real cost is scope analysis plus the action-registration pass. Both are measured in the Phase 1 spikes before anything is committed (Part 5).

### Ecosystem

- **Vite:** `vite@8.0.0` was released 2026-03-12, with Rolldown as its only bundler. esbuild remains an optional peer, used only for legacy minify and transform options. The latest is 8.3.4 (2026-10-08), which depends on `rolldown ~1.2.12`.
- **Rolldown:** 1.0.0 shipped on 2026-05-07; the latest is 1.2.14.
- **Farm:** v2 is still `2.0.0-beta.11` (2026-05-28), with nothing published since. The latest stable is 1.7.11, from 2025-08-04.
- **Cloudflare:** `@cloudflare/vite-plugin` 1.64.0 runs the worker under workerd with HMR on Vite 8.3.4 (verified with a Hono worker). Its v2 beta (2026-10-15) moves config to `cloudflare.config.ts`, deploys with `cf deploy`, and renames the worker environment to `ssr`. Detect the server environment by `consumer === "server"`, never by name.
- **Hono:** 4.13.13 is the latest and 5.0 is in RC. The router is tested against 4.12, 4.13 and 5.x (D12).

## Target architecture

```
recooler/htmx      Vite plugin (transform, client environment) + router extension
      │
recooler/jsx       page adapter: layouts, head, root, Suspense/ErrorBoundary
      │
recooler/router    createApp(manifest, options), manifest types, extension API   (depends on hono only)
recooler/gen       CLI + watch: routes dir → src/routes.gen.ts
recooler/vite      thin routes() Vite plugin using recooler/gen
```

Dependencies only point downward. The router never imports JSX or htmx code.

Packaging (D1): one npm package with subpath exports (`recooler/router`, `recooler/gen`, `recooler/jsx`, `recooler/htmx`, `recooler/vite`) and a new name. This must be settled before the first publish.

## Reference behaviour (0.0.27)

The Farm plugin's 0.0.27 behaviour was settled through several rounds of adversarial review. The TS packages match it unless a decision below says otherwise. Each item has a conformance scenario (Part 4).

**Routing**
- One flat Hono app with `strict: true`. Groups never become sub-apps.
- **Route order:**
  - Routes are compared segment by segment, and the earlier segment decides. For 0.1.0, a segment sorts static < custom pattern < plain `:param` < catch-all; `{.+}` and `{.*}` count as catch-alls. This deliberately changes 0.0.27, which put custom patterns and plain params in the same class and could silently shadow a regex route depending on parameter names.
  - Routes that match the same requests (the same path in several groups, or paths differing only in param names) are ordered with pages first, then by path, then by group directory.
- **Build errors:**
  - two layout or route files in one directory
  - `[id]` next to `:id`
  - middleware without a default export
  - routes that match the same requests where both respond to one method with a terminal handler: the page (GET), an `on{Method}`, or `onRequest` (every method). Form actions don't count, because their registrations pass unmatched requests along.
- **Directories:** hidden directories are routed. A group name is any parenthesized directory name, and one rule strips groups from paths everywhere (routes, action URLs, metadata).
- **Params:** `[[rest]]` becomes `:rest{.+}`, which matches one or more segments but not the parent path.
- **Fall-through is defined behaviour.** A registration that doesn't handle a request passes it along with `next()`, e.g. a page's form-action registration receiving a POST without a matching `action`. The next route that matches runs its own chain, middleware included. Requests nothing answers get 404.

**Middleware**
- **Plain directories (no group ancestor):** `app.use(prefix === "/" ? "*" : prefix + "/*")`, registered before all routes, shallowest first, ordered by file name within a directory. These run for every request under the prefix, matched or not. `/admin/*` also matches `/admin`.
- **Group directories, and plain directories inside a group:**
  - Their middleware are the first handlers of each of their subtree's routes' registrations. They run whenever one of those routes' handlers runs: after fall-through from another route, and under any mount prefix (`route`, `basePath`, `mount`).
  - Each runs at most once per dispatch per middleware module, keyed on the Hono `Context` and the module id. A re-dispatched `Request` runs them again.
  - They never run for other groups' routes or for ungrouped routes under the same prefix.
  - Plain directories inside a group also get an `app.use` after all routes, for requests no route answers.
- **Order:** within a route chain, shallowest to deepest counting group directories. Plain-directory middleware outside groups always runs first (D9).

**Handlers**
- Order: middleware → form actions (only for `?action=` requests; they end there) → `onRequest` → `on{Method}` / `onGet` → page.
- An `?action=` naming no action of the app returns 404, so the `action` query parameter is reserved on every route with form actions for that method.
- Action results:
  - Anything JSX-renderable is rendered as children: strings (escaped), arrays, promises, `hono/html`, and objects with a sync or async `toHTML`.
  - A returned or thrown `Response` is sent as is.
  - `undefined` or `null` gives 204.
- `HEAD` is answered by GET handlers, and `OPTIONS` only by `onOptions` or `onRequest`.

**Pages**
- **Head chain:** root, then layouts from root to leaf, then the route. Each entry is resolved at runtime: a function extends the head so far, an object replaces it, and nullish is skipped. Every export form is recognised, because the TS runtime reads module namespaces.
- **Head isolation:** head data is isolated per request. 0.0.27's shallow copy still lets deep mutations accumulate (§2).
- **Default root:** `root?.default ?? DefaultRootHOC`. The default `<meta charset="utf-8">` is added only when no head meta declares a charset.

**htmx transform**: §3.1 lists the behaviours to preserve, including the 0.0.27 additions.

`docs/reviews/0.0.27.md` on the 0.0.27 branch records each of these with its commit and test, plus the 0.0.27 known issues. The TS design removes most of those issues structurally; the remaining ones are listed with their fix in the relevant section.

---

## Part 1: Router

### 1.1 Generator (`recooler-routes generate [--watch] [--check]`)

The generator walks `routesDir` and reads each module's export names with `oxc-parser`'s `module.staticExports`, without walking the AST.

Conventions:

- `index.[jt]sx?` is a route
- `layout.[jt]sx?` is a layout
- `middleware[@name].[jt]sx?` is middleware, sorted by file name
- `src/root.tsx` is the root component
- `(group)` directories are dropped from the path
- `[param]` becomes `:param`, `[p{regex}]` becomes `:p{regex}`, and `[[rest]]` becomes `:rest{.+}`
- 0.1.0 supports `]` inside balanced pattern braces, e.g. `[n{[0-9]+}]`; unconvertible `[`…`]` directories are build errors
- directory names containing `\`, `%`, `#` or `?` are build errors; use `[0-9]` instead of `\d`
- warn on unrecognized `middleware*` files; middleware names accept Unicode Alphabetic, M, Nd, Pc and Join_Control plus `-`

Output is `src/routes.gen.ts`. Every file is imported as a namespace with a path-derived identifier and hash suffix for collision handling, so the generated file only changes when files are added, removed or renamed. Existing identifiers stay stable on insertion. Source ids are srcDir-relative POSIX paths, shared with the Vite plugin.

```ts
// generated by recooler-routes; do not edit
import type { Manifest } from "recooler/router";
import * as root from "./root";
import * as r_index from "./routes/index";
import * as l_admin from "./routes/(admin)/layout";
import * as mw_admin from "./routes/(admin)/middleware";
import * as mw_admin_db from "./routes/(admin)/admin/middleware@10-db";
import * as r_admin from "./routes/(admin)/admin/index";

export const manifest = {
  version: 1,
  root,
  tree: {
    segment: "", path: "/", group: false, middleware: [],
    route: { file: "routes/index.tsx", module: r_index },
    children: [
      { segment: "(admin)", path: "/", group: true, middleware: [mw_admin], layout: l_admin, children: [
        { segment: "admin", path: "/admin", group: false, middleware: [mw_admin_db],
          route: { file: "routes/(admin)/admin/index.tsx", module: r_admin },
          children: [] },
      ] },
    ],
  },
} satisfies Manifest;

export type RoutePath = "/" | "/admin";
```

The generator reports every build error in the reference list. `createApp` re-checks them at startup against the real module namespaces, which are authoritative and also cover `export *`.

Generator options:

- `routesDir`, `srcDir`, `out`
- `importExtension`: `""`, `".js"` or `"source"` (preserve source extensions); `.js` mode preserves `.jsx` imports
- whether to emit route types

`--check` normalizes CRLF and fails if `routes.gen.ts` is stale, for CI when the file is committed (D2).

Typed routes are optional and come after Phase 3: `RoutePath` plus a `declare module "recooler/router" { interface Register { … } }` augmentation for typed params, e.g. `RouteProps<"/blog/:post">`.

### 1.2 Manifest types

```ts
export interface Manifest {
  version: 1;
  root?: ModuleNs;
  rootFile?: string;
  tree: DirNode;
}

export interface DirNode {
  segment: string;              // for errors and debugging
  path: string;                 // computed by the generator, groups stripped
  group: boolean;
  layout?: ModuleNs;
  layoutFile?: string;
  middleware: ModuleNs[];       // sorted; runtime reads .default
  middlewareFiles?: string[];   // source metadata; never identity
  route?: { file: string; module: ModuleNs };
  children: DirNode[];
}

type ModuleNs = Record<string, unknown>;
```

### 1.3 `createApp(manifest, options)`

There are two pure steps:
1. `resolveRoutes(manifest)` walks the tree and touches no Hono. It produces the ordered route list, each route's middleware chain, and validation errors.
2. A second step registers the result on one flat app (`new Hono({ strict: true, ...options.hono })`).

Registration, in order:

1. Plain-directory middleware via `app.use`, shallowest first.
2. Each route, in reference order, as one registration:
   ```
   app.on(methods, path, ...chainMiddleware, ...extensionHandlers, onRequest?, methodDispatch)
   ```
   - `chainMiddleware`: the middleware of the group directories and the plain directories inside groups on the route's path, each wrapped in `once(mw, moduleId)`.
   - `methods`: GET if the route has a page or `onGet`; every `on*` method; every method an extension declares (e.g. form-action methods from the page, its layouts and the root); and all methods if it has `onRequest`.
   - `methodDispatch` runs `[onGet, page]` for GET and `[onX]` for other methods, using a ~10-line compose (Hono exports none publicly). It calls `next()` for a method it doesn't handle, so fall-through reaches a same-shaped route registered later.
3. The trailing `app.use` for plain directories inside groups.

One registration per route means middleware never runs twice when `onRequest` calls `next()` into `onGet`. With `once`, it also doesn't matter when a request passes through several registrations.

The router logs a warning at startup for near-miss exports, e.g. `onget` or `OnPost`. 0.0.27 printed these to stdout only.

### 1.4 Extension and page-adapter APIs

```ts
interface ResolvedRoute {
  path: string; file: string;
  module: ModuleNs; layouts: ModuleNs[]; root?: ModuleNs;
  layoutFiles: (string | undefined)[]; rootFile?: string;
  middleware: MiddlewareHandler[];
  middlewareModules: ModuleNs[]; middlewareFiles: (string | undefined)[];
  directory: string;
}

interface RouterExtension {
  name: string;
  route?(route: ResolvedRoute): {
    methods?: string[];
    handlers?: Handler[] | Record<string, Handler[]>; // scoped to declared methods/map keys
    page?: Record<string, unknown>;     // passed to the page adapter
  } | void;
}

interface PageAdapter {
  handler(route: ResolvedRoute, extras: Record<string, unknown>[],
    contributions: { extension: string; page: Record<string, unknown> }[]): Handler | undefined;
}

interface CreateAppOptions<E extends Env = Env> {
  pages?: PageAdapter;                  // without one, routes are on* handlers only
  extensions?: RouterExtension[];
  hono?: HonoOptions<E>;
}
```

`createApp<E extends Env = Env>` returns `Hono<E>`. Extension and adapter hooks receive
frozen route copies with frozen array containers. Adapters run only for own default exports
and their returned handlers are validated. The original ordered extras argument is retained;
named contributions let adapters decide collisions. `mergePageExtras` concatenates arrays
and replaces scalar/object values in extension order without mutating inputs.

Extension handlers follow scoped middleware. Moving selected handlers ahead of guards is
still deferred to htmx D5 (guard-rendered forms). `ALL` collapses the registration method
set to one `ALL`. `app.use` after `createApp` cannot run for matched terminal routes.

### 1.5 Entrypoint

The entrypoint is code the user owns:

```ts
import { createApp } from "recooler/router";
import { jsxPages } from "recooler/jsx";
import { htmx } from "recooler/htmx";
import { manifest } from "./routes.gen";

export default createApp(manifest, {
  pages: jsxPages(),
  extensions: [htmx()],
});
```

A `virtual:recooler/app` module, provided by `recooler/vite`, can generate exactly this for zero-config projects. It exports only `default`, because Workers reads a main module's named exports as entrypoints and Durable Object classes.

## Part 2: JSX pages (`recooler/jsx`)

Most of this moves directly from 0.0.27's `src/helpers.ts`:

- **`jsxPages(options)`** returns a `PageAdapter`.
  - It composes layouts (HOCs, applied from the innermost directory outward), builds the head chain, and renders through `renderToStream`.
  - It handles a `Response` thrown during render.
  - Layouts without a default export don't wrap.
  - Its options replace `route_handler_factory` and `ResolvedTemplate`, and it includes `suspenseCleanupScriptMiddleware`.
- **Head chain:** as in the reference behaviour. A head that resolves to something other than a function, a plain object or nullish (e.g. a Promise) is an error, not an empty head. Each request gets its own deep copy of every object entry in the chain (`structuredClone` of plain data), so neither `prev.metas[0].content += …` nor a mutated module-level constant can leak between requests.
- **Exports:**
  - `ErrorBoundary`, which re-throws a `Response`
  - `Suspense`
  - `renderHeadElements`
  - `DefaultRootHOC`
  - the `global.d.ts` types `RouteProps`, `RouteHead` and `RouteHeadFn`
- **Client scripts:**
  - The root HOC gets `scripts: string[]` (URLs) from extensions instead of an inline `clientScript` string. *This breaks custom roots; keep accepting the string form for one release.*
  - The page adapter emits `<body data-recooler-route="…">` (or a meta tag when the root renders its own body) and never an inline script, so it stays independent of htmx and needs no CSP nonce (§3.4).

## Part 3: htmx (`recooler/htmx`)

### 3.1 Transform (Vite plugin, `enforce: "pre"`)

The transform is ported from `src/htmx/transform.rs`. Behaviour to preserve:

- hoisting `hx-{get,post,put,patch,delete}`, `hx-on:*`/`hx-on-*` and their `data-hx-*` forms into module exports
- variable capture through scope factories; errors for captured local functions and classes
- `actionScope()` / `handlerScope()`
- an explicit `ctx` attribute or object prop, which doesn't leak into nested actions; shorthand `{ ctx, "hx-post": fn }`; nested actions using the outer action's `ctx`
- `ctx` kept on components and dropped from html elements, including through a component's `{...props}` spread
- rewriting destructured props, rest first params, and skipping a TypeScript `this` param
- object-literal props (`{"hx-post": fn}`)
- a build error for arrow event handlers that use `this` or `arguments`
- route params URL-encoded in action URLs (catch-alls per segment), with any param name
- **IDs:** `${relativePath}@${base36(index)}`, with separate counters for actions and handlers. They are deterministic per module, as in 0.0.27.

0.0.27 gaps that the port fixes:

- **Computed keys:** `{["hx-post"]: fn}` is transformed, or is a build error when the key isn't a string literal. 0.0.27 rendered the function source.
- **Actions inside event handlers** are a build error. 0.0.27 shipped them untransformed to the client.
- **`ctx` through untransformed wrappers:** in 0.0.27, components in `node_modules` or outside `srcDir` that spread props onto an element render `ctx="[object Object]"`. Drop it at render time instead: the page adapter's JSX runtime skips any intrinsic-element attribute whose value is a Hono `Context`. That covers every wrapper, and the transform's `omitCtx` and spread rewriting are no longer needed. `{...{...props, title}}` is covered as well.
- **`import.meta` in handlers** works, because client scripts are module scripts (§3.4).
- **Banned imports and shadowed `require`:** a locally shadowed `require` is no longer reported. Scope analysis tells a global `require` from a shadowed one.

Implementation:

- **Parse:** `oxc-parser` with `experimentalRawTransfer`, giving a TS-ESTree AST with `start`/`end`.
  - The option isn't in the published types, so it needs a cast.
  - Check `rawTransferSupported()` and fall back to the default transfer, which gives an identical AST.
  - Don't use `this.parse`: it defaults to `lang: "js"` (TSX fails), uses JSON transfer, and drops parentheses.
- **Scope analysis (D8):** `@typescript-eslint/scope-manager`'s `analyze()` on the oxc AST, parsed with `range: true`. oxlint ships exactly this for its JS plugins.
  - On a 273-line TSX sample and a hand-made TS edge-case file, it gave zero differences from running it on typescript-estree's AST.
  - It costs about one extra parse per htmx module (0.45–0.9 ms on that sample under load) and doesn't pull in TypeScript.
  - It has three consumers: capture detection, client slicing, and server-mode import dropping.
  - Replace it with a hand-written analyzer only if profiling demands, differential-tested against it.
- **Edits with `magic-string` 1.x** (rules from the spike):
  - Move hoisted text with `ms.move(start, end, ms.original.length)`. Nested moves work in either order.
  - Wrap moved text with `prependRight(start)` and `appendLeft(end)`, which travel with the moved chunk. `prependLeft`/`appendRight` attach to the neighbours and garble the output.
  - Insert the URL or handler expression at the original site with `appendLeft(start)`. Never `overwrite` a range that contains a moved sub-range ("cannot overwrite across a split point").
  - Overwrite inner ranges before outer ones. Rename captured identifiers with `overwrite` on their own ranges, before or after a move.
  - `generateMap({ hires: true })` keeps correct mappings through moves.
- **Source maps are a requirement.** Every `transform` hook returns `{ code, map }` from magic-string, and the virtual modules (client entry, `?recooler-handlers` slices, the route table placeholder) return maps or `map: null` only when they have no source. Rolldown chains the per-plugin maps, so no extra composition should be needed; the transform tests assert that original positions of hoisted actions, handlers and untouched code map back correctly (via `@jridgewell/trace-mapping`), and the e2e fixture checks that the built server and client bundles' maps resolve stack frames to `src/` files.

### 3.2 Per-route action registration (D5, decided: registry plus module graph)

Each route must accept exactly the actions reachable from its module, its layouts and the root, at module precision as in 0.0.27.

**★ Registry plus build-time graph.**
- Every transformed htmx module registers its actions as a side effect: `registerActions("src/components/Button.tsx", { post: { "…@0": _action$post$0 } })`.
- At `renderChunk` in the SSR environment, the plugin computes route → module reachability from Rolldown's module graph (`this.getModuleInfo(id).importedIds`, static imports only). It replaces a placeholder in the htmx extension with the route → module-id table.
- In dev, the extension computes the same table lazily from the SSR environment's module graph, and invalidates it on HMR.
- This needs no extra imports or exports in user modules. So:
  - module evaluation order is unchanged
  - there are no `__recooler` names in namespaces
  - nothing leaks into the client build
  - `this.resolve` isn't called per import
  - type-only imports and `verbatimModuleSyntax` stop mattering
  - re-exports (`export * from`, `export { x } from`) and side-effect imports are followed, because they are graph edges

**Requirements from the spikes and their review:**
- **Build.** Snapshot each module's adjacency once per pass. The uncached walk was slower than aggregators and scaled poorly. Emit only the ids of modules that have actions; listing every reachable id cost +1.14 MB at 1,000 routes.
- **Dev edges and table.**
  - Static dev edges come from the server environment's lowered `transformResult.deps`, not `importedModules`, which includes dynamic imports.
  - Cache adjacency across routes and walk in parallel. The spike's per-route walk took about 2.9 s after an edit at 1,000 routes.
  - Recompute until the graph epoch is stable, and dedupe concurrent walks.
  - The table reaches the Worker through a virtual module.
- **Dev registration.** Every server-environment transform of a source module registers, even with `{}`, so an action removed after a dev-server restart can't survive in the persistent registry. Route reachability alone does not prevent stale actions.
- **Dev reloads.** For v1, a full SSR reload with `invalidateAll` on change. Scoped invalidation is a later investigation, because the Node runner kept stale route modules without it. Gate on dev time-to-response after an edit.
- **Environments and dependencies.**
  - Select the configured Worker environment; `consumer === "server"` is necessary but not sufficient.
  - Canonicalise `?v=`/`?t=` queries.
  - Exclude action-bearing dependencies from that environment's `optimizeDeps` and from SSR externals.
- **Type-only imports.** `import { type T }` under `verbatimModuleSyntax` leaves an empty import that the graph follows; `import type` disappears.
- **Which routes get registrations.** Only routes with a page, as in 0.0.27. Handler-only routes that import page modules don't get action registrations.

**Fallback (not needed): appended aggregators**, as in `docs/plans/fixtures/aggregator`, validated on Rolldown 1.2.14 and Farm 1.7.11. Use them only if the graph approach fails in dev or under the Cloudflare plugin. If used, they must be:
- emitted only in the SSR environment and never in client slices; an aggregator in a client module pulls server modules into the browser, and Rolldown keeps and evaluates side-effectful modules even after tree-shaking (`clientOnlyEvaluated: true` in the fixture)
- computed after TS/JSX lowering, from the surviving `ImportDeclaration`, `ExportAllDeclaration` and `ExportNamedDeclaration`-with-source nodes, including side-effect imports
- left out of the entry module, `routes.gen.ts` and middleware modules, with the reserved export names documented

Either way:
- Dynamic `import()` isn't followed in v1; document this.
- Barrels over-approximate, as in 0.0.27. Action signing (§3.5) is what limits an action to the routes that actually render it.

### 3.3 Action URLs (D3, decided)

**Decided: ambient request context plus a route binding** (Phase 1 spikes, `docs/plans/spikes.md`, and its review).

- **Binding.** The htmx extension's per-route handler runs first in every route registration. From its closure it sets an immutable binding with `c.set(binding, { routeId: route.file, pathname })`, where `pathname` is the request's own pathname (`new URL(c.req.url).pathname`). The binding never comes from `routePath(c)` or `c.req.param()`:
  - Hono 5 removes `c.req.routePath`.
  - Hono 5 restores the route index after the handler returns, so deferred Suspense children see `/*` and `{}`.
  - Re-encoding a decoded catch-all loses `%2F`.

  Every handler in the chain sees the binding: `onGet`/`onRequest` JSX, the page, and action responses that render nested actions.
- **Reading it.** `actionUrl(id, scope)` reads the binding through `hono/context-storage` (AsyncLocalStorage, verified on Node, Bun, Deno and workerd with `nodejs_als` and `nodejs_compat`, including inside deferred Suspense). It returns `<base><pathname>?action=…&sig=…`. The explicit `ctx` prop keeps working as an override.
- **Never emit an origin-relative URL.** A root catch-all matches `//evil.example/x`, so the emitted URL must never start with `//` (or `/\`); prefix `/.` in that case. Add a conformance case.
- **Mounts.** `route()` and `basePath()` are covered, because the pathname already contains the prefix. Hono 4's `app.mount()` and prefix-stripping proxies hide the prefix, so `htmx({ base })` supplies it. Without `base`, `mount` is documented as unsupported for actions.
- **Owner route.** Actions post to the *rendering* route, not the module that defines them. 0.0.27 posted actions defined in a route module to that module's own path, so its middleware ran. A public page that renders a component exported from an `(admin)` route module now runs that action under the public chain. Document this in the migration guide, and add a conformance scenario.
- **Hono 5 params.** The page adapter passes a params snapshot in `RouteProps`, because `c.req.param()` is empty in deferred Suspense children on Hono 5.

### 3.4 Client scripts (D4)

- **Client-slice modules.** For each source module with handlers, the plugin serves a `?recooler-handlers` variant.
  - The variant is transformed exactly like the original, so IDs match.
  - It is then sliced down to the `_handler$N` exports, the route module's `onLoad`, and the module-level declarations and imports they reference.
  - Port the slice rules from `slice_handler_module` in `src/htmx/transform.rs`: breadth-first reference walk, type-only imports trimmed, partially used imports trimmed, `onLoad` recognised in its three forms in route modules only, and a warning when a layout or the root exports `onLoad`.
  - Each slice registers its own handlers (`$handlers["…@2"] = _handler$2`), so no entry needs to know the IDs.
- **★ Per-route lazy chunks.**
  - The client entry maps a route path to `() => import(slice)` for the slices that route reaches. Rolldown dedupes shared slices.
  - This keeps per-page module side effects per page, as in 0.0.27, and stops admin-only handler code reaching public pages.
  - The entry's module list comes from the server build's graph (`buildApp`, server first), so no glob pre-scan is needed.
  - The alternative is one global bundle.
- **Loading.**
  - Pages link the entry with `<script type="module" src>` through the extension's `page.scripts`.
  - The entry reads `data-recooler-route`, loads that route's chunk, installs `window.$handlers`, and calls `onLoad` itself. There is no inline script, so no CSP nonce is needed.
  - `hx-on` attributes themselves still need `unsafe-eval`, as with htmx in general; document this.
  - Handlers triggered before the chunk loads: queue them in a tiny stub, or document it.
- **Build.** Declare `environments.client` with `build.rolldownOptions.input` set to the virtual entry, so one `vite build` builds both environments, as `@cloudflare/vite-plugin` already does.
  - The client entry has a **stable file name** with a `?v=<buildId>` query, so the server never needs the client manifest, and the Cloudflare plugin's own Worker → client order is a correct two-pass build.
  - Don't override `builder.buildApp` in `config`. The spike did, and it dropped the Cloudflare plugin's asset step and forced `sharedPlugins`.
  - Assert that the route → slice table the client build uses matches the server build's.
  - The Environment API is RC, and `createBuilder`/`buildApp` are still `@experimental`, so pin the Vite minor.
- **Isolation.** Per-route chunks are a performance measure, not a confidentiality boundary: the entry's route map and every chunk are public.
- **Source maps for slices.** `?recooler-handlers` slices are virtual modules with real source. Produce the transform and the slice from one MagicString, or compose with remapping, and test it.
- **Server mode.** The transform drops `_handler$N` exports and every import used only by handler bodies. This is required: Rolldown keeps and evaluates side-effectful modules whose importing export was tree-shaken.
- **`clientBannedImports`.** Port both checks:
  - the per-handler reference chain (`_handler$2 → updateTable → dbClient`), with `import()` and global `require` specifiers
  - a path check over every module in the client bundle, in the client environment's `generateBundle` over `chunk.moduleIds`

  Patterns match the raw specifier in the first check and resolved paths in the second; document that.
- **Dev:** the client entry is a virtual module, invalidated when a file containing `hx-on` changes.

### 3.5 Runtime and security (`recooler/htmx` extension)

Ported from `src/helpers.ts`:

- **Helpers:** `wrapAction`, `wrapActionWithPayload`, `actionScope`, `handlerScope`, scope serialization checks, and `actionsMiddleware`, with 0.0.27's result handling and 404 for unknown actions.
- **★ Sign every action URL (D6),** including actions without captures. Sign over the binding's route id (`route.file`) and exact pathname, the method, the action id and the scope. Verify against the receiving registration's own binding. On a mismatch, call `next()`, so fall-through still works and a foreign or replayed URL ends in 404. Because params are inside the pathname, a URL signed on `/users/1` doesn't replay on `/users/2`, and identical paths in different groups are distinguished by route id.
  - This limits an action to the routes that rendered it.
  - In 0.0.27, a route that merely imports a barrel re-exporting an admin component accepts that admin action under its own middleware.
  - Optionally add an expiry and a session id.
- **Secret:**
  - `htmx({ secret })` accepts a string, or a function of the env that is resolved on first use and cached.
  - The secret is never inlined in the bundle.
  - Startup fails when signed actions exist and no secret is configured, unless `secret: false`.
- **HMAC (D10):** keep the hand-rolled synchronous HMAC-SHA256, which matched `node:crypto` on 88 vectors (key lengths 0–200, messages 0–1,000); add those vectors as tests. easy-jsx awaits Promise attribute values, so WebCrypto is possible. Staying synchronous is a choice, to avoid async attributes on every action element.
- **★ CSRF (D7):** on by default, configurable with `trustedOrigins`:
  - Require `HX-Request: true` on every action request. A cross-site request can't set it without a preflight, and this also covers mutating `hx-get` actions.
  - Check `Sec-Fetch-Site`, falling back to `Origin`, reusing `hono/csrf`.
- **Middleware-rendered forms** (a login form returned by a guard) can't post to their own action, because the guard runs first. Document that such forms must live on an unguarded route, or make middleware modules action roots that register ahead of their own middleware. This is an open question in D5's spike.

## Part 4: Testing

- **Conformance suite (new, from 0.0.27).**
  - Scenarios are data: a file tree, the requests to send, and the expected status, body and middleware trace.
  - The seed set is the 0.0.27 playground tests (`playground/test/app.test.mjs`, 19 cases), plus the scenarios from the 0.0.27 reviews. Their scratch copies in `/private/tmp` were lost; they are reconstructed from the review transcripts and `docs/reviews/0.0.27.md`:
    - shadowing: s1, s2, s5, s6
    - middleware semantics and order: s3, s9
    - group-guard bypasses: s4/s4b, s7, s8 and the probe-extra mount cases
    - same-shape routes: q*, c*, e*
    - identical paths: d*
    - re-dispatch and shared middleware: x10, x11
    - export forms: m*, p*
  - Move them into `conformance/` in Phase 1.
  - Run the suite against the TS build, and against a 0.0.27 build as the oracle while Farm still builds.
- **Router:** vitest with real Hono apps built from hand-written manifests, run on Hono 4.12, 4.13 and 5.x. Beyond the conformance scenarios:
  - one registration per route (no double middleware through `onRequest` → `next()`)
  - fall-through ends in 404
  - startup validation of every reference build error
- **Generator:** snapshot tests of `routes.gen.ts` for fixture directories (groups, params, rest params, middleware ordering), error cases, and `--check`.
- **Transform:** port the transform, slice and banned-import tests from `src/htmx/transform.rs` and `src/banned_imports.rs` as input/output fixtures, normalising formatting for comparison. Add tests for:
  - server mode (handler-only imports dropped)
  - action registration (re-exports, side-effect imports, type-only imports, aliases, non-src imports)
  - action URLs under a mount prefix
  - the 0.0.27 gaps fixed in §3.1

  The Farm-only tests (export-name replay in `validate.rs`, trace stubs, `SharedHostPlugin`, nested compiles) aren't ported. Differential-test the scope analysis on a corpus if it is ever hand-written.
- **Action registration:** keep `docs/plans/fixtures/aggregator` for the fallback, and add a Vite fixture for the graph approach, in build and dev.
- **End-to-end:** the Cloudflare Workers template under Vite and workerd. Use `app.request()` to assert pages, signed and unsigned actions, CSRF rejection, client script delivery and middleware.
- **Performance:** `docs/plans/fixtures/bench/gen-app.mjs` at 400 and 1,000 routes, with the full plugin (scope analysis and action registration) and a grouped variant (4 groups, each with group and directory middleware).
  - Gate on the ratio to a no-htmx build in the same job, plus 100-vs-400 linearity, rather than absolute times, which flaked on loaded machines.
  - Also track gzipped SSR output size.
- **CI:** typecheck, vitest, conformance and e2e on pull requests. Publishing is gated on CI and the OIDC token is granted to the publish job only, as in 0.0.27.

## Part 5: Phases

### Phase 0: release Farm 0.0.27 and freeze

1. Open a PR from `ssttevee/fix-0-0-27-review-items`, so the nested release/CI workflows run on GitHub before the release push. They haven't run there yet.
2. Release 0.0.27 and mark the Farm plugin as maintenance-only in the README.
3. Run the main consumer app on 0.0.27. It built 20/20 cleanly on the branch.

Done: 0.0.27 is published.

### Phase 1: spikes (decide D3, D5, D8; freeze §1.4)

- **Transform core:** scope-manager on oxc ASTs plus the magic-string rules, against a third of the ported transform fixtures, including nested actions and captures.
- **Action registration:** the registry plus graph approach in `vite build` and `vite dev` (with and without `@cloudflare/vite-plugin`). Measure its cost against aggregators with `this.resolve` at 400 and 1,000 routes.
- **Ambient context:** `hono/context-storage` on workerd (`nodejs_als`), Node and Bun, including inside Suspense streaming after the handler returns.
- **Dev loop:** Vite 8 with the Cloudflare plugin, running the bench app with a client environment.
- **Conformance suite:** moved into the repo and running against 0.0.27.
- **The main consumer app (private; two Workers packages):** an inventory of the features it uses that the migration guide must cover.

Exit criteria: D3, D5 and D8 are decided with measurements, and the extension API shape is frozen.

### Phase 2: router and generator

`recooler/router` and `recooler/gen`. Usable without htmx or JSX, e.g. for an API-only Hono app.

Exit criteria: the router conformance scenarios (routing, middleware, fall-through, build errors) pass on Hono 4.12, 4.13 and 5.x.

### Phase 3: JSX pages

`recooler/jsx` with layouts, head, root, Suspense and ErrorBoundary.

Exit criteria: pages without htmx attributes render byte-identically to their 0.0.27 builds, and the head, root and layout conformance cases pass.

### Phase 4: htmx server

The transform (full and server modes), action registration, action URLs, signing, CSRF, the `htmx()` extension, and `recooler/vite` wiring for the server build.

Exit criteria: the ported transform tests pass, and so does the full conformance suite, including actions and every bypass scenario. The performance gates hold.

### Phase 5: client scripts

Slicing, the client environment, per-route chunks, `onLoad`, and dev invalidation.

Exit criteria: event handlers work in the template, a test asserts that no server-only code reaches the client bundle, and dev HMR works.

### Phase 6: migration and cutover

- **A migration guide**, covering:
  - config and the entrypoint
  - `clientScript` → `scripts` in custom roots
  - `route_handler_factory` → `jsxPages` options
  - imports from `farm-plugin-recooler/helpers`
  - custom entrypoints using `recooler::app`
  - the Pages `onRequest` export
  - the `?script` endpoint
  - signed action URLs: URLs in pages cached before the switch stop working
  - the CSRF requirement
- **Ports:** the template and the main consumer app (private).
- **SSG (D11):** `recooler::metadata` becomes a module derived from the manifest. farm-plugin-ssg is Farm-only, so cutover for SSG users needs a Vite replacement.
- **Archive:** the Rust sources, the `npm/*` platform packages and the native build workflows.

## Open decisions

Recommended defaults are marked ★.

| # | Decision | Options |
|---|---|---|
| D1 | Packaging | ★ one package with subpath exports and a new name (before the first publish) · separate packages |
| D2 | `routes.gen.ts` in git | ★ committed, with `generate --check` in CI · gitignored |
| D3 | Action URLs | **Decided:** ambient context plus a per-route binding `{routeId, pathname}` (§3.3) |
| D4 | Client scripts | **Decided:** per-route lazy chunks, with a stable entry file name (§3.4) |
| D5 | Action registration | **Decided:** registry plus module graph, with the dev requirements in §3.2 |
| D6 | Action signing | ★ every action URL, bound to route id, pathname and method · captured scopes only (as 0.0.27) |
| D7 | CSRF | ★ `HX-Request` plus `Sec-Fetch-Site`/`Origin` on all actions, on by default · opt-in |
| D8 | Scope analysis | ★ `@typescript-eslint/scope-manager` at runtime · hand-written analyzer |
| D9 | Middleware order across the plain/group boundary | ★ keep 0.0.27 (plain-directory middleware first; documented) · strict depth order, which loses unmatched-path semantics for plain directories |
| D10 | Action HMAC | ★ synchronous hand-rolled · WebCrypto with async attributes |
| D11 | SSG | manifest-derived metadata plus a Vite SSG step · drop SSG at cutover; decide before Phase 6 |
| D12 | Hono support | ★ 4.12+ and 5.x, tested in CI · 5.x only |

## Risks

- **Action registration in dev.** The graph approach depends on the SSR module graph being complete and current under the Cloudflare plugin. The Phase 1 spike decides it; aggregators are the fallback.
- **Transform correctness** (scope analysis, nested magic-string edits, slicing). Using scope-manager removes most of the risk. The ported fixtures and the conformance suite catch the rest.
- **Ambient context availability** on every runtime and inside streamed Suspense rendering. Route binding is the fallback.
- **Vite Environment API instability** (`@experimental` in 8.3.4) and the `@cloudflare/vite-plugin` v2 migration. Pin minors, and key on `consumer`.
- **Hono 5.** Run the router on the RC in CI from Phase 2.
- **Breaking changes for existing users:** the entrypoint, root HOC signature, signed action URLs and CSRF. Mitigate with the migration guide, 0.0.27 as a supported Farm release, and a `clientScript` compatibility shim for one release.

## Appendix

### Reproducing the measurements

- **App generator:** `node docs/plans/fixtures/bench/gen-app.mjs <dir> <routes> [--no-handlers]` writes `<dir>/src` with N routes, `lib/db.ts`, `components/card.tsx` and `root.tsx`.
- **Farm numbers:**
  - Use `@farmfe/core@1.7.11` and `@farmfe/plugin-react@1`, with `persistentCache: false`, and read "Build completed in".
  - Build each plugin variant in its own `git worktree` with its own `CARGO_TARGET_DIR`. A shared target dir silently produced a stale dylib.
  - Copy `target/release/libfarm_plugin_recooler.dylib` to a `.farm` file. Farm resolves the plugin and dependencies relative to the config's directory, so copy the config into each app.
  - Check `uptime` first and interleave the variants you compare. The same 400-route build took 4.8 s at a load average of about 65 and 1.1 s at about 50.
- **Vite numbers:**
  - Use `vite@8.3.4`. Take the median of 5 in-process `build()` calls with `build.ssr`, `sourcemap: true` and `minify: false`.
  - Use a plugin with a `{ code: /hx-(get|post|put|patch|delete|on)/ }` hook filter. The "no htmx" baseline keeps the plugin and returns `null`.
  - The first build in a process is 1.5–5× slower (cold JIT) and is excluded.

### Aggregator fixture

`docs/plans/fixtures/aggregator` contains hand-written modules in the fallback aggregator shape.
1. The build scripts import `rolldown` and `@farmfe/core` by bare name, so copy the fixture next to a `node_modules` that has them (e.g. a Vite 8.3.4 install, which brings Rolldown 1.2.14).
2. Build it with `scripts/build-rolldown.mjs <root>` or `scripts/build-farm.mjs <root>`. `build-farm.mjs` prints nothing.
3. In a fresh process, import the result and inspect `result`, `missing` and `globalThis.__CLIENT_ONLY_EVALUATED`.

Expected output on Rolldown 1.2.14:

```json
{"order":["page","cycle","button"],"actions":["page@0","cycle@0","button@0"],"missing":"undefined","clientOnlyEvaluated":true,"handlerKept":false}
```

Farm 1.7.11 is the same except `"clientOnlyEvaluated": false`.
