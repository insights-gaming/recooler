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
call the shared dispatcher; static route modules, route `onLoad` and `page.scripts` are wired automatically.

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
page, with one guarded reload per version pair. Identical graph/source-tree inputs, runtime, configuration and package/lock
metadata produce the same version, including helpers pruned from server code. Versioned opaque slice filenames avoid stale lazy-chunk collisions.
Keep old slices available during rolling deployments. Relative Vite bases are build errors. Server output needs no client manifest.

Client source maps default to **off**, and minification to **on**, independently
of the top-level server build. Override with `environments.client.build.sourcemap`
and `.minify`. Slices use the exact input seen by the server transform, including
preceding plugins, and assert matching handler IDs. Their sourcesContent blanks
dropped ranges and comments while preserving UTF-16 positions and newlines.
Unsliced dependencies retain mappings without embedded source contents, including
when they have tree-shaken server exports. Public entry lookup keys are opaque.
Client chunks are public performance units; bans remain an application boundary.

Initial pages include `assets/recooler-route-<route hash>.js?v=<version>` modules.
Each imports its own reachable slices and shares dependencies with other entries.
Names hash route.file and are guessable; public chunks are not a confidentiality
boundary. The general entry is `assets/recooler-client.js?v=<version>`.

Full-page Content starts async and deferred copies of the same client/route
module URLs. The module map evaluates each once. Async modules register during
Suspense streaming, including consumer renderers calling `.forEach(htmx.process)`;
deferred copies still guarantee registration before DOMContentLoaded. Non-boosted
htmx fragments put module scripts after the content and omit preload links, keeping
htmx 1's table-row parsing intact. No parser-blocking gate is emitted or fetched.

Generated hx-on code calls `(self.$rc||fallback)(id,scope,this,event)`. Before the
entry arrives, the fallback prevents only htmx:confirm and stores its arguments in
`self.$rq`. The entry drains held events through its deferred path, even if their
handlers registered first, and calls the original `issueRequest()` without a skip
argument when allowed. htmx's own hx-confirm prompts therefore still accept or
cancel the request. Loaded handlers run immediately with the original event.

htmx 1.9.12 installs wildcard hx-on listeners after issuing synchronous load
requests. This also affects 0.0.27 and cold boosts from handler-free pages. Generated
confirm attributes receive a small legacy `hx-on` alias which evaluates their
canonical attribute early; htmx 1 replaces this listener during normal processing
and htmx 2 ignores it. Raw string hx-on load guards still have the upstream htmx 1
ordering limitation. The fallback and alias use htmx's existing hx-on eval permission.

Handlers run immediately when their slice registers, independent of marker
completion or onLoad. Loaded root/layout handlers therefore survive body swaps.
Route onLoad runs at DOMContentLoaded or immediately if parsing has finished,
sees the complete DOM, and is never awaited. Rejections go to reportError (with a
console.error fallback). Root/layout onLoad stays ignored.

The entry exports init() and observes afterSwap, afterSettle and historyRestore.
Only client-bearing pages get a trailing template[data-recooler-marker] with route
and version. It survives table parsing and htmx 1 history; handler-free pages emit
no marker. Body attributes are never a fallback. New markers run their own route
onLoad once; unchanged markers do not rerun, and history restoration does rerun.

Only confirm is canceled/deferred while handlers load. All other missing handlers,
including config-request/before-request, drop events and leave defaults untouched. Dev warns for dropped events. Native preventDefault guards can
be bypassed during a post-swap loading window; use htmx:confirm to gate requests.
No native click/submit replay exists. Detached targets are skipped.

__recooler_ready tracks registration and onLoad invocation, not async onLoad
completion. Failed imports retry with a fresh URL, then attempt one guarded reload
per client version. Version mismatch reloads once per HTML/client version pair.
Custom createApp entries pass clientModules/clientPreloads alongside clients and
clientEntry. legacyClientScript still supplies import(entry).then(m=>m.init()).
Load classic htmx before the module scripts. See the migration guide for details.

Bans, exact server input slicing, dev fs authorization, redacted maps, and opaque
lookup keys remain enforced. Dropped slice comments are removed even with minify:false.
Server graph edits retain SSR runner invalidation; client table changes (including onLoad metadata) trigger a
client reload, while unrelated SPA CSS/TypeScript edits keep normal Vite updates.
Build watch orders client rebuilding after server output.

`test/vite/client-htmx.mjs` uses headless Chromium through Playwright with real
htmx 1.9.12 and 2.x. Install its browser with `pnpm --filter recooler exec playwright
install chromium`. It covers static/DCL and Suspense ordering, all request replay
attacks, native defaults during swaps, body lifecycle loops, A→B→C→Back for both
root styles, HX-Location, push-url, fragments, failure retries and guarded reloads.
The jsdom proxy fixture still runs two real Workers through /_admin; Happy DOM
checks emitted ESM, sharing, maps and route isolation. client-hmr.mjs checks that
unrelated CSS and TypeScript edits send updates only.
