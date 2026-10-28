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
Colon parameter directories such as `routes/:id/` work in Cloudflare dev with
Vite's default strict filesystem policy. The route plugin reads only exact known
manifest inputs containing `:`; it does not disable the filesystem allow-list.
These directory names cannot be checked out on Windows; prefer `routes/[id]/`.
The generator returns a portability warning for names containing `:`.

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
pragmas are added. Dev always installs the htmx extension so adding the first
action through an import works immediately. Builds install it when a loaded
source module contains `hx-`. Set `htmx: {}` to enable it explicitly or
`htmx: false` to disable the transform and automatic extension. Handler strings
are emitted with a pre-load queue; client chunks, route `onLoad` and `page.scripts` are wired automatically.

```ts
recooler({
  serverEnvironment: 'my_worker', // Cloudflare v1 Worker environment, if restricted
  htmx: {
    secretBinding: 'RECOOLER_SECRET', // default
    namespace: 'my-app',            // required if nearest package.json has no name
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
Cloudflare copies `.dev.vars` into `dist/<worker>/` for local build preview; that
file contains secrets, so keep build output private and out of source control.
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

Always pass that namespace: its app identity hashes the nearest `package.json`
name and the POSIX `srcDir` path relative to that package root. The environment
name is appended, along with a per-server nonce in dev. Moving a checkout leaves
build identity unchanged; named apps built at the same Docker path remain
separate. `htmx.namespace` overrides the app identity while retaining environment
and dev isolation. Give every app a distinct package name or explicit namespace;
build and dev startup reject a nearest package.json with no name unless an
explicit namespace is set.
Distinct apps, and separate deployments of one app such as staging and production,
**must not share a signing secret**, even when their namespaces differ.
It matches all registrations and isolates concurrent dev servers with identical
relative module IDs. Module/action IDs are **srcDir-relative**, with POSIX separators (including
`../` for outside-source modules), exactly matching 0.0.27. Only Vite transport
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
page route, its router-resolved layouts (including canonical alias directories)
and the root. It emits only action-bearing module IDs.
Dynamic imports are not action roots. Barrels intentionally over-approximate at
module precision; D6 signatures prevent foreign-route/path authorization. Routes
without a page never receive table entries. Both build and dev propagate action
identities through reverse static edges, discovering shared closures once. Table
replacement returns `map: null` when later mapped code does not move; combined
lines use a boundary source map. Dev uses the selected
server environment's lowered `transformResult.deps`, parallel discovery with cached
adjacency, reverse-edge action propagation, stable graph epochs and deduped
concurrent computations. Unchanged pure htmx transforms are cached across full
reloads; source changes still re-evaluate every registration. Action transforms also run during warmup and before the table is imported, so
manifest-first custom entries work. Empty dev registration
starts only after that environment loads `virtual:recooler/htmx`. Reset hooks cover
`srcDir`, declared action packages, and previously transformed action modules,
including `{}` when actions are absent. Idle and auxiliary environments receive no
empty-registration imports before they load the table. Changes invalidate only the virtual table and use a full SSR runner reload. Route generation runs before platform
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

Each registration includes a SHA-256 hash of the JSON tuple
`[actionTransformVersion, definingModuleSource]` through the codegen contract.
The transform exports `actionTransformVersion`; maintainers must bump it whenever
action collection or numbering semantics change, even for unchanged source. V2 signed URLs bind that hash, namespace and mount base;
editing a module invalidates old positional action IDs from that module.
Function-valued action and `hx-on*` attributes reaching the JSX runtime throw a
“module was not transformed” diagnostic instead of rendering server source.

Verification fixtures: `test/vite/htmx-integration.mjs` (plain, Cloudflare v1,
v2 beta), `htmx-options.mjs` (production guard and located diagnostics),
`htmx-startup.mjs` (warmup, manifest-first entries, stable app identity,
namespace overrides and same-path replay), `htmx-regressions.mjs` (alias layouts, table parity, map paths, edit matrix, shifted
IDs and server/environment isolation; add `--cloudflare` for workerd), and
`htmx-bench.mjs` (interleaved full-plugin/no-htmx build and edit-response gates).
Run them with `pnpm --filter recooler exec node test/vite/<script>.mjs`; add
`--cloudflare` to the benchmark for the 400/1,000-route workerd dev gate.


## Client scripts (Phase 5)

Run `vite build`, or use `createBuilder(config).buildApp()`. Recooler adds
`virtual:recooler/client` to `environments.client` while preserving user entries
and an existing default `index.html`. Only Recooler's entry gets the reserved
`assets/recooler-client.js` filename. Plain Vite builds server then client;
Cloudflare retains its own builder, asset movement and bindings. Client outDir
defaults to `dist/client`; read resolved environment outDirs on platform builders.

The entry URL is `assets/recooler-client.js?v=<content hash>` under Vite's base.
The generated entry embeds that version and refuses to dispatch a mismatched
page, reloading it. Identical graph/source-tree inputs, runtime, configuration and package/lock
metadata produce the same version, including helpers pruned from server code. Versioned opaque slice filenames avoid stale lazy-chunk collisions.
Keep old slices available during rolling deployments. Relative Vite bases warn
and use `/`. Server output needs no client manifest.

Client source maps default to **off**, and minification to **on**, independently
of the top-level server build. Override with `environments.client.build.sourcemap`
and `.minify`. Slices use the exact input seen by the server transform, including
preceding plugins, and assert matching handler IDs. Their sourcesContent blanks
dropped ranges and comments while preserving UTF-16 positions and newlines.
Unsliced dependencies retain mappings without embedded source contents, including
when they have tree-shaken server exports. Public entry lookup keys are opaque.
Client chunks are public performance units; bans remain an application boundary.

The entry exports `init()`, initializes on startup and observes
`htmx:afterSettle` for changed route markers (HX-Location, hx-push-url or boost) and `htmx:historyRestore`.
It imports missing slices, runs the owning route's `onLoad`, then replays early
events. Content includes a route/version meta marker inside the swapped body for
both default and custom roots. Preserve the Content slot. Root/layout onLoad
exports warn and do not run. Repeated init calls for one content marker share
one initialization; swapped content and history restoration rerun onLoad.

New roots render `props.scripts` as external module scripts and optional
`props.preloads` as `<link rel="modulepreload" href={url}/>` in their head.
DefaultRootHOC handles both. A custom `createApp` entry should pass `clientPreloads`
alongside `clients` and `clientEntry` from `virtual:recooler/htmx` to `htmx()`.
`htmx.legacyClientScript: true` supplies the one-release inline string
`import("<entry URL>").then(m=>m.init())`, so htmx re-execution works even when
imports are cached. Load real htmx before the client entry. The entry waits for
DOMContentLoaded, including when the legacy script runs during streaming.

Early function handlers use a compact queue stub and immediately prevent the
original event's default. Replay preserves this, event data and captured scope;
it presents a fresh cancellation state to the handler. If the handler does not
cancel, confirm continues through `detail.issueRequest()`, submit through
`form.requestSubmit(submitter)`, and anchor/button clicks through `click()`.
A handler that invokes issueRequest itself is never resumed a second time.
Config-request/before-request can restart through `htmx.ajax` using the exposed
request config. Other cancelable htmx events without request config or a
continuation remain cancelled and warn; they cannot resume an internal htmx
stack. Transient properties such as currentTarget are unavailable after the
original event dispatch. Detached elements are skipped. Each handler/onLoad
failure is reported independently, so one error does not drop later events.
`globalThis.__recooler_ready` tracks the latest initialization; import failures
reject it. Already-string hx-on attributes keep their existing behavior/CSP needs.

Banned imports are checked in retained handler/onLoad references, raw client
resolution specifiers (including transitive helpers), and emitted resolved
module IDs with importer chains. Browser-external stubs are always rejected.
Dev slice requests must belong to discovered clients or source files under
srcDir with a script extension; arbitrary `/@fs` slice requests cannot bypass
that boundary. Dev changes refresh the server input before slicing, invalidate
the virtual entry and send a full reload. A dev Content watchdog warns when a
root omits the entry or it fails to load; if CSP blocks that inline watchdog,
the browser's CSP diagnostics apply. Build watch uses one server watcher and
orders a fresh client build after each server output, avoiding stale route maps.

`test/vite/client-htmx.mjs` loads real htmx 2.x and 1.9.12 in jsdom over HTTP and executes
unmodified legacy imports through native ESM. It covers delayed load events,
confirm, submit, links, replay errors, HX-Location, hx-push-url, real history
restore, boosted swaps and cached imports. For 1.9.12, load-triggered requests
need `load delay:1ms` when their wildcard hx-on listeners must cancel them.
`client-proxy.mjs` runs two Workers in Miniflare with separate assets and a
service-binding proxy, checking Vite base on entries, preloads, lazy slices and
legacy imports.
`client-security.mjs` covers maps, user/HTML entries, preloads, transform drift,
version skew and fs.allow; `client-watch.mjs` covers adding/removing handlers.
The plain, Cloudflare v1 and v2 integrations scan JS and maps, check original
positions, execute native ESM with Happy DOM, and verify real HMR websocket reloads.
