# recooler/vite

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { recooler } from 'recooler/vite';

export default defineConfig({
  plugins: recooler({ routes: { /* srcDir, routesDir, out, check, ... */ } }),
  build: { ssr: 'src/entry.ts' },
});
```

```ts
// src/entry.ts — owned by the application
import app from 'virtual:recooler/app';
export default app;
```

For TypeScript entries, add `/// <reference types="recooler/vite/client" />` to
your `env.d.ts`.

The virtual module exports **only default**, equivalent to
`createApp(manifest, { pages: jsxPages(), extensions })`. The server htmx extension
is installed as described below. For custom adapters or extensions,
use your own `createApp` entry and the generated manifest. The plugin array
keeps route generation separate from app wiring, so extension plugins can evolve
without replacing the platform's app builder.
The plugin wires server transforms/action dispatch and per-route lazy client delivery.

For a virtual-only SSR build, use `build: { ssr: true, rolldownOptions: {
input: 'virtual:recooler/app' } }`. Vite treats a string `build.ssr` as a real
filesystem path. Ordinary Vite dev users load their entry through Vite's SSR
module runner and serve its `fetch` response using their chosen HTTP adapter.
The Cloudflare plugin serves the Worker entry automatically.

`recooler()` includes `routes()` for build-time generation and dev watching.
`routes: { check: true }` compares committed output instead of writing it.
The standalone `routes(options)` export remains usable for API-only apps.

JSX defaults to the automatic `recooler/jsx` runtime per file. The plugin adds
pragmas only when the file's own tsconfig and pragmas do not select a source or
classic/preserved JSX. Solution-style tsconfig references, nested configs,
JSONC/extends and explicit `oxc.jsx` settings are respected. When `oxc` is unset,
Vite converts legacy `esbuild` options, including `jsxInject`, as usual. Any
other effective runtime warns because it bypasses request-bound Context filtering.

Every server-consumer environment gets `resolve.noExternal` entries for
`recooler` and `easy-jsx-html-engine`: the engine's extensionless internal imports
cannot run as native Node ESM. A [vitefu dependency crawl](https://github.com/svitejs/vitefu)
also bundles packages declaring either package in `dependencies` or
`peerDependencies`, keeping the JSX runtime in the same bundle. Declare consumed
packages in the app's package.json. Undeclared dependencies and packages that
hide their runtime dependency cannot be discovered; add those packages to the
server environment's `resolve.noExternal` manually. Bundling does not rewrite
precompiled imports of a different JSX runtime; recompile or alias those imports
as described in the [JSX README](../jsx/README.md).

With `@cloudflare/vite-plugin`, keep that plugin's normal configuration and
builder. By default every server consumer may import the virtual app, including
Vitest's test environments. Set `serverEnvironment` to restrict imports to one
configured server environment; other environments receive an error. A missing
name or a client consumer is a configuration error. Idle SSR and auxiliary
Worker environments do not force selection. Browser imports are rejected.
Vitest 5's default runner uses `ssr` for app imports. In Cloudflare v1, an
environment's name is its Worker name with hyphens replaced by underscores:
`main-worker` becomes `main_worker`. This does
not change `builder.buildApp` or require `sharedPlugins`.

Dev generation errors are logged once per distinct diagnostic and sent to Vite's
error overlay (including clients connecting after a startup error). Importing the
virtual app throws that diagnostic until generation succeeds; failed or recovered
generation invalidates the app so requests cannot silently use a stale route table.

The virtual app uses the same augmentable `RouteEnv` as page components:

```ts
import 'recooler/jsx';
declare module 'recooler/jsx' {
  interface RouteEnv { Bindings: { API_KEY: string } }
}
```

## Server htmx actions (Phase 4b)

`recooler()` transforms `hx-*` source attributes in server mode before the JSX
pragmas are added. It automatically installs the htmx extension when any loaded
source module contains `hx-`. Set `htmx: {}` to enable it explicitly or
`htmx: false` to disable the transform and automatic extension. Handler strings
are emitted with a pre-load queue; client chunks, route `onLoad` and `page.scripts` are wired automatically.

```ts
recooler({
  serverEnvironment: 'my_worker', // Cloudflare v1 Worker environment, if restricted
  htmx: {
    secretBinding: 'RECOOLER_SECRET', // default
    base: '/app',                   // only for prefix-stripping mounts/proxies
    trustedOrigins: ['https://app.example'],
  },
})
```

The generated entry resolves the secret from the **request env binding**, falling
back to `process.env[binding]` on Node. Configure a Worker secret (a `.dev.vars`
value locally); Cloudflare v2 also requires declaring the binding as a secret in
`worker.env`. Supply a nonempty value before the first request to an action-bearing
route. The key is never read during compilation or inlined into the JS bundle.
Rotation follows the runtime's env-identity cache; use a fresh env object or app.
The plugin intentionally accepts a binding name rather than a literal secret.

Custom entries configure `htmx({ secret })` themselves and can import the graph:

```ts
import { table, clients, clientEntry, namespace } from 'virtual:recooler/htmx';
import { htmx } from 'recooler/htmx';
// createApp(manifest, { pages: jsxPages(), extensions: [htmx({
//   table, clients, clientEntry, namespace, secret: env => env.RECOOLER_SECRET,
// })] });
```

Always pass that namespace: it is a stable hash of the absolute srcDir and matches
all generated registrations, isolating projects with identical relative module
IDs. Module/action IDs are **srcDir-relative**, with POSIX separators (including
`../` for outside-source modules). Farm compiler paths can include a different
source-root prefix; do not persist old IDs across the migration. Only Vite transport
`?v=`/`?t=` queries are removed; meaningful variants remain distinct.

Production builds define `__RECOOLER_PRODUCTION__` as true. `htmx()` throws at
startup for `secret: { unsafeUnsigned: true }`, including in custom entries.
The runtime's explicit `allowUnsignedInProduction: true` escape hatch permits an
intentional unsigned deployment and retains the warning/marker. This avoids
executing a Worker bundle in Node to inspect a runtime-only marker. The production
guard also applies to `vite build --mode development`; dev servers permit the
explicit unsafe mode. Bundler-independent consumers without this plugin must
provide their own production policy.

The D5 table follows surviving static imports/re-exports/side effects from each
page route, its layouts and the root. It emits only action-bearing module IDs.
Dynamic imports are not action roots. Barrels intentionally over-approximate at
module precision; D6 signatures prevent foreign-route/path authorization. Routes
without a page never receive table entries. Build adjacency is cached once per
`renderChunk` pass; table replacement returns a source map. Dev uses the selected
server environment's lowered `transformResult.deps`, parallel discovery with cached
adjacency, reverse-edge action propagation, stable graph epochs and deduped
concurrent computations. Unchanged pure htmx transforms are cached across full
reloads; source changes still re-evaluate every registration. Every source
transform registers, including `{}` when actions are absent. Changes use
`invalidateAll` and an SSR full reload. Route generation runs before platform
startup hooks, so eager workerd imports see the initial graph.

Action packages must remain source inputs. Packages declaring `recooler` or
`easy-jsx-html-engine` in dependencies/peerDependencies are discovered by the
framework dependency crawl, excluded from the selected server's `optimizeDeps`,
and bundled rather than SSR-externalized. For packages without such a declaration,
list them in `htmx.actionDependencies`. This also overrides explicit external or
optimizer-include entries for those packages; package subpaths are covered.
The declarations/list are needed before Vite chooses externals or prebundles;
source transforms cannot discover a package they never receive. Custom Rolldown
`external` functions that override Vite's resolver remain the application's
responsibility. `htmx.clientBannedImports` forwards raw-specifier checks to the
transform and rejects banned resolved paths in every client chunk (lazy/shared included).

Verification fixtures: `test/vite/htmx-integration.mjs` (plain, Cloudflare v1,
v2 beta), `htmx-options.mjs` (production guard and located diagnostics), and
`htmx-bench.mjs` (interleaved full-plugin/no-htmx build and edit-response gates).
Run them with `pnpm --filter recooler exec node test/vite/<script>.mjs`; add
`--cloudflare` to the benchmark for the 400/1,000-route workerd dev gate.


## Client scripts (Phase 5)

`environments.client` is a client consumer whose input is
`virtual:recooler/client`. Run `vite build`, or programmatically use
`createBuilder(config).buildApp()`. The selected server environment discovers the
same route → slice table that the client consumes; a build assertion rejects a
mismatch or client-first orchestration. A post plugin hook builds server then
client for plain Vite; it does not replace any platform's `builder.buildApp`.
Only Recooler's own plugins opt into shared build state.

The stable entry is `assets/recooler-client.js?v=<buildId>` under Vite's base.
Server output needs no client manifest. Client outDir defaults to `dist/client`;
platform overrides remain authoritative. Read the resolved environment outDirs,
particularly with Cloudflare v2's `.cloudflare/output` convention. Cloudflare
retains its Worker → client builder, manifests, asset movement and asset binding.

Each `?recooler-handlers` variant transforms/slices the original source in one
MagicString, returns its real map with original sourcesContent, and registers its
own functions. The entry reads the rendered route pattern, imports only that
route's reachable slices, and runs only that page's onLoad after registration and
queue replay. Handler-free pages emit no entry URL; onLoad-only pages do.

`htmx.clientBannedImports` patterns see raw specifiers in the scope check and
resolved module paths in the bundle check. `htmx.legacyClientScript: true` opts
legacy custom roots into an inline `import("<entry URL>")` string; the default is
undefined. New roots render `props.scripts` module URLs.

Full-page navigation initializes clients in 0.1.0. Disable hx-boost for links that
change routes. Same-route swaps can use the existing route's handlers; swapping
a new route marker does not load a new route. Early function-handler events queue
with their element, event and capture scope, including events before the module
entry starts. Queued event return values/preventDefault cannot act synchronously.
The entry waits for document parsing, so onLoad follows a completed Suspense
stream; load failures reject `globalThis.__recooler_ready`. See the
[migration guide](../../../../docs/migration-0.1.md) for timing, CSP and legacy
root details. Per-route chunks are public performance units, not a secrecy boundary.

Dev changes invalidate the client entry and send a full reload over the real HMR
channel, alongside the full server reload. `test/vite/client-integration.mjs`
checks one CLI build, assets, emitted ESM with Happy DOM, queue replay, onLoad,
shared/admin chunk separation, built/dev source maps and websocket reloads on
plain Vite, Cloudflare v1 and v2. Run it with
`node --experimental-vm-modules test/vite/client-integration.mjs [plain|cloudflare|beta]`.
`client-options.mjs` covers both banned-import checks and the legacy opt-in.
