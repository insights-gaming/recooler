# Phase 1 research spikes: Vite 8 / Rolldown

Date: 2026-10-27. Base: `cf56726`. Branch: `ssttevee/ts-spikes`.
Worktree: `/Users/steve/.t3/worktrees/farm-plugin-recooler/t3-9fd6447d`.

These are standalone research fixtures in `spikes/phase1`, not the recooler implementation. No Rust sources or `packages/recooler/src` were changed. They settle the five requested research questions; they do **not** satisfy all the Phase 1 exit criteria (especially D8 and freezing the extension API).

## Decisions

- **D3: adopt ambient request context, with an immutable render binding.** AsyncLocalStorage survives deferred easy-jsx Suspense rendering on every requested runtime. Snapshot the matched pattern and params inside the actual rendering handler. Use `routePath(c)` from `hono/route`, not `c.req.routePath`. Prefer the request URL's pathname for the action target: decoded catch-all params lose encoded-slash information.
- **D4: adopt per-route dynamic imports.** Shared code is emitted once; public static dependency closures exclude admin-only code. Keep the resolved-path `chunk.moduleIds` check as well as the planned source-level checks.
- **D5: adopt the registry plus module graph.** Build reachability and lazy dev reachability work in plain Vite and workerd. Use explicit SSR full reloads for v1, a persistent dev registry, and explicit empty registration when an edit removes the last action. Exclude action-bearing dependencies from SSR externalization and the relevant environment's dependency optimizer. The aggregator remains a fallback fixture, not the recommended implementation.

## Reproduction and versions

All commands below run from the repository root. Node 22, pnpm 12, Bun and Deno must be installed. No Cloudflare account or deployment is required. The integration checks open loopback ports and start local workerd processes.

```sh
pnpm install
pnpm --filter @recooler-spikes/phase1 graph
pnpm --filter @recooler-spikes/phase1 context
pnpm --filter @recooler-spikes/phase1 urls
pnpm --filter @recooler-spikes/phase1 integration
pnpm --filter @recooler-spikes/phase1 integration:bench
pnpm --filter @recooler-spikes/phase1 maps
pnpm --filter @recooler-spikes/phase1 aggregator
pnpm --filter @recooler-spikes/phase1 bench
```

`pnpm --filter @recooler-spikes/phase1 check` runs all correctness checks except the 400-route integration variant and timing benchmark. Generated apps and outputs are ignored under `spikes/phase1/.generated`; checked-in JSON evidence is under `spikes/phase1/results`. The expected banned-import failure prints `Build failed` during each integration run; the harness asserts its diagnostic and then rebuilds the valid app.

Pinned versions: Vite **8.3.5**, Rolldown **1.2.15**, Cloudflare Vite plugin **1.65.0**, beta alias **2.0.0-beta.v.5**, Wrangler **4.154.0** (the plugins also bring their own transitive toolchains), Hono **4.13.14 / 5.0.0-rc.1**, easy-jsx-html-engine **0.1.13**, magic-string **1.4.5**, trace-mapping **0.3.31**. Native runtime measurements used Node **22.22.2**, Bun **1.3.12**, Deno **2.5.6**. Worker fixtures use compatibility date `2026-10-20`.

## 1. D5: action registration from the module graph

**Verdict: pass, with dev lifecycle and dependency-handling requirements.**

`graph-plugin.mjs` appends `registerActions(moduleId, fakeActions)` for modules with a marker. It does no real htmx lowering. In the server environment, `renderChunk` walks `this.getModuleInfo(id).importedIds` from each route, root and layout; a visited set terminates cycles. It replaces a runtime placeholder with a route-to-module table and returns a map for the replacement. The client environment receives no registrations.

The small fixture has **14 reachable modules / 13 registered actions** with `verbatimModuleSyntax: true`, and **12 / 11** with it disabled. The build and dev results agree. `graph.json` records both cases and an explicitly externalized package.

| Case | Observed behavior |
|---|---|
| Static value imports; mixed type/value imports | Followed |
| `export *`, named re-exports, barrels | Followed; an unused admin re-export is reachable at module precision |
| Side-effect import | Followed |
| Root and layout supplied as additional roots | Their actions included |
| Cycle A → B → A | Both included, traversal terminates |
| `import type { T }` | Erased, no actions registered |
| `import { type T }` | With verbatim syntax, lowering preserves an empty side-effect import and the module is reachable; otherwise erased |
| Unused value import | Preserved with verbatim syntax, otherwise erased |
| `import()` | Not followed, even after the fixture actually executes the import and registers its fake action |
| `outside/component.ts` outside `src` | Included |
| Action-bearing `node_modules/spike-actions` | Included when bundled and excluded from optimization |
| Same package explicitly SSR-externalized | No source transform or action registration; omitted from the build table |

This corrects the plan's blanket statement that verbatim syntax stops mattering: the graph correctly follows **surviving lowered imports**, whose side effects still depend on that setting. No separate TS import reconstruction is needed.

### Dev graph and workerd

The same checks pass with the stable Cloudflare plugin under both `nodejs_als` and `nodejs_compat`, and the v2 beta under `nodejs_compat`. Build bundles are also exercised through production `vite preview`, not just inspected.

The dev algorithm is lazy and caches by graph generation. It transforms reachable modules on a cold request to complete the graph, and uses the server environment's `transformResult.deps` for **static** edges. `importedModules` alone is unsuitable because it also contains dynamic imports. A lazily imported virtual table transfers the Node-side result into the Worker without sharing JavaScript objects across runtimes. The `/__spike_graph` Node middleware is a test probe; it is not an action-dispatch endpoint. An attempted Worker loopback-fetch bridge failed and is not used.

Required details demonstrated by the integration fixture:

1. Select the configured Worker server environment. CF v1 leaves an unused default `ssr` environment beside the real Worker; taking the first `consumer === 'server'` is insufficient. CF v2 uses `ssr`. Do not hard-code either name.
2. Action-bearing dependencies must use the environment's `optimizeDeps.exclude` and must not be SSR externals. Root-level client optimizer settings alone did not exclude the Worker dependency. Prebundling otherwise bypasses the marker transform.
3. Canonicalize Vite's `?v=` / `?t=` transport queries consistently in registration and graph IDs. Preserve meaningful plugin variant queries in the real implementation.
4. Invalidate the table and the SSR module graph on changes, and send an explicit SSR full reload. An earlier partial-HMR version intermittently returned a new table while the Worker still evaluated an old route module.
5. Keep the dev registry across runtime-module reloads. A new local Map loses registrations from cached dependencies. An HMR dispose callback also intermittently deleted a dependency registration whose module stayed cached. The passing version keeps the Map and re-registers `{}` when a previously action-bearing module loses its final marker. This passed the full matrix and repeated 400-route runs.

The checks add an imported action module, verify its registration, remove its last action, and verify that the old action disappears. A cache-hit check verifies the graph is not recomputed on an unchanged request. Production code should further bound the lifetime of removed modules' registry entries; route reachability already prevents accepting their stale actions.

**Reproduce:** `pnpm --filter @recooler-spikes/phase1 graph`, `pnpm --filter @recooler-spikes/phase1 integration`, and `pnpm --filter @recooler-spikes/phase1 integration:bench`.

### Registration cost versus aggregators

Interleaved medians, milliseconds; load averages during this run: **56.39–63.25 / 77.87–80.55 / 101.80–103.42** (1 / 5 / 15 minutes).

| Routes | Variant | Total build ms | Reachability ms | Module-info calls | Extra `this.resolve` calls | SSR JS bytes | gzip bytes |
|---|---|---:|---:|---:|---:|---:|---:|
| 400 | Baseline | 123.9 | 0.0 | 0 | 0 | 688,831 | 24,340 |
| 400 | Graph, cached adjacency | 185.3 | 24.5 | 412 | 0 | 1,146,102 | 32,386 |
| 400 | Graph, uncached | 414.6 | 245.6 | 10,400 | 0 | 1,146,102 | 32,386 |
| 400 | Aggregator | 232.7 | 0.0 | 0 | 1,201 | 781,775 | 29,650 |
| 1,000 | Baseline | 277.6 | 0.0 | 0 | 0 | 1,712,835 | 53,351 |
| 1,000 | Graph, cached adjacency | 451.9 | 61.1 | 1,012 | 0 | 2,856,506 | 71,568 |
| 1,000 | Graph, uncached | 1606.6 | 1190.2 | 26,000 | 0 | 2,856,506 | 71,568 |
| 1,000 | Aggregator | 573.8 | 0.0 | 0 | 3,001 | 1,946,983 | 66,649 |

**The module-info cache is required.** Snapshot each module's adjacency once per build/render pass. Re-reading shared module info for every route made the naive graph slower than aggregators and gave poor scaling. Caching cuts 10,400 / 26,000 bridge calls to 412 / 1,012. Reachability then scales from **24.5 to 61.1 ms** for 2.5× the routes, and the full cached graph builds are **20.4% / 21.3% faster** than aggregators in this run. The graph adds **61.4 / 174.3 ms** over the no-registration baseline, versus **108.8 / 296.2 ms** for aggregators.

The full graph table is a size cost: gzip is **32,386 / 71,568 bytes**, versus aggregator **29,650 / 66,649**. It currently emits reachable dependency IDs even when those modules have no actions. Emitting only action-bearing IDs is a sensible production optimization, but is not included in these measurements. `bench-naive.json` preserves the earlier uncached-only comparison at load averages around 83–87 / 99–100 / 115–116; the final table above compares all four variants in the same run.

The benchmark uses the plan's `gen-app.mjs` at 400 and 1,000 routes, retaining its actual TSX page modules and imports. Each action-bearing page gets one fake registration; this isolates registration strategy, **not** the real three-action transform, scope analysis, client slicing, or runtime dispatch. The generated root's Farm helper import is replaced by a local stand-in. The baseline keeps the plugin but performs no registration. All variants retain page namespaces so this is not a tree-shaken empty-app measurement.

The aggregator variant implements the reference fixture's namespace-import / `__recooler()` graph shape, parses after TS/JSX lowering, and awaits `this.resolve` for each surviving static import/re-export. It omits the entry's aggregator. Output sizes include the route tables or per-route collection code, so they are useful implementation comparisons rather than pure traversal costs.

One warm-up per variant and size is excluded. Five measured builds per variant run in one process, interleaving baseline/cached graph/uncached graph/aggregator and reversing alternate rounds. Builds have maps, no minification, no disk output, and fresh Vite build instances. `bench.json` includes every raw sample, per-sample `uptime`, byte counts and gzip sizes. Concurrent external sessions make these timings provisional; use the relative trend and resolution counts rather than absolute gates.

The unchanged reference aggregator fixture also passes on Rolldown 1.2.15: action order `page, cycle, button`, all three actions collected, missing aggregator `undefined`, and **client-only side effects still execute despite the unused handler being removed**. This reinforces the planned server-side removal of handler-only imports and prohibition on emitting aggregators into client slices.

**Reproduce:** `pnpm --filter @recooler-spikes/phase1 bench` and `pnpm --filter @recooler-spikes/phase1 aggregator`.

## 2. D3: ambient request context and streaming

**Verdict: AsyncLocalStorage passes; raw Hono request metadata is not a safe immutable render binding.**

`context-app.mjs` uses `hono/context-storage`, real `easy-jsx-html-engine` `renderToStream`, and a Suspense boundary. Four requests overlap for each combination: two mount patterns and two encoded scalar params. Each asserts the identical Hono Context at the initial render, inside `.toHTML()`, and in the deferred child. A separate request/response gate proves native rendering continues after receiving the streaming Response. Workerd uses request-owned 100 ms timer I/O and forwards rendering work to `ExecutionContext.waitUntil`; an in-memory gate resolved by another request was rejected by Workers' request ownership / hung-request detection.

| Runtime / mode | Hono 4.13.14 | Hono 5 RC | Deferred child and mount URL |
|---|---|---|---|
| Node 22.22.2, built server | Pass | Pass | Pass with snapshot |
| Bun 1.3.12, same server bundle | Pass | Pass | Pass with snapshot |
| Deno 2.5.6, same server bundle | Pass | Pass | Pass with snapshot |
| Plain Vite dev + built server | Pass | Pass | Pass with snapshot |
| workerd, `nodejs_als`, CF v1 dev + preview | Pass | Pass | Pass with snapshot |
| workerd, `nodejs_compat`, CF v1 dev + preview | Pass | Pass | Pass with snapshot |
| workerd, `nodejs_compat`, CF v2 beta dev + preview | Pass | Pass | Pass with snapshot |

Each matrix cell runs four concurrent streams. Mount patterns are `/mount/item/:id/:rest{.+}` via `route()` and `/base/nested/item/:id/:rest{.+}` via nested `basePath()` plus `route()`. Params containing spaces, encoded `/` in the scalar `id`, and multi-segment catch-alls reconstruct correctly from the captured metadata. No extra mount prefix should be prepended: the matched pattern already includes it.

Two required corrections:

- Hono 5 RC removes `c.req.routePath`; `routePath(c)` from `hono/route` works in both tested versions. Its dispatcher restores `routeIndex` after the handler returns. The ambient Context still exists, but a late `routePath(c)` becomes `/*` and `c.req.param()` becomes `{}` in this fixture. Capture `{ routePath: routePath(c), params: { ...c.req.param() } }` inside the final rendering handler, before returning the Response. The fixture's late snapshot remains correct on all runtimes. Store this immutable binding alongside the ambient context for URL generation/signing.
- `routePath + param` cannot always reconstruct the exact requested pathname. For `/mount/nested/item/a%2Fb/one%2Ftwo/three`, the catch-all is decoded to `one/two/three`; splitting and re-encoding produces `/one/two/three`, losing the original `%2F`. `urls.json` records two normal passes and two encoded-slash counterexamples across Hono versions. Use `new URL(c.req.url).pathname` when targeting the same rendering request, and snapshot the matched pattern separately for signatures.

Node packaging finding: direct Node 22 ESM imports of easy-jsx 0.1.13 fail on its extensionless internal imports (`create-element`). The native runtime check bundles it through Vite (`ssr.noExternal: true`); no dependency files were patched. The tested runtime recommendation therefore assumes the server bundle or a compatible resolver.

**Reproduce:** `pnpm --filter @recooler-spikes/phase1 context`, `pnpm --filter @recooler-spikes/phase1 urls`, and the integration commands above. Raw evidence: `context-{node,bun,deno}.json`, `urls.json`, and the integration JSONs.

## 3. Dev loop: client environment beside a Cloudflare Worker

**Verdict: pass with explicit build orchestration and a manifest feedback step.**

The fixture declares `environments.client` with `consumer: 'client'` and virtual-module input. It builds both environments in one actual **`vite build` CLI invocation**, and also exercises `createBuilder().buildApp()`. This distinction matters: standalone programmatic `build()` is not the multi-environment app builder.

There is an ordering cycle in §3.4: server reachability supplies client slice inputs, but the final server needs client output hashes. The tested `builder.buildApp` sequence is **server discovery → client → final server** (three environment builds, one CLI command). The final built Worker returns the same entry filename that appears in the actual client `.vite/manifest.json`; the production preview endpoint asserts it. The first server pass has no final client entry. Do not claim that an ordinary server-first two-pass build can already embed the later manifest.

For production, either keep the explicit final server pass, or use a generated asset/runtime manifest lookup (or a stable entry filename). The latter alternatives are not implemented here. Arbitrary patching after output hashing would require rechecking hashes and source maps.

Dev checks fetch the virtual client entry, subscribe to Vite's real HMR WebSocket, change server imports and client handler modules, assert updated Worker registrations, and receive a client **full-reload** frame. This proves full reload delivery, not preserved browser component state. The client entry is explicitly invalidated on handler edits.

The `integration:bench` variant retains **400 generated page modules**, produces **402 route roots** (400 pages plus the two representative route cases), and renders the generator's `/p0` page with 20 items in both production preview and dev. It uses representative public/admin client slices, not the unfinished real handler slicer or htmx dispatch. Client HMR and server registration invalidation are exercised against that live Worker.

Beta differences verified with **2.0.0-beta.v.5**:

- `cloudflare.config.ts` replaces Wrangler config. The tested shape is `export default { worker: { name, entrypoint, compatibilityDate, compatibilityFlags } }`; a flat Wrangler-like object is rejected.
- The entry Worker environment defaults to `ssr`, versus `spike_worker` in this v1 fixture.
- The beta forces Build Output API directories under `.cloudflare/output/v0`, overriding requested output directories. Read each resolved environment's `build.outDir`; do not synthesize `dist/<environmentName>` or assume `dist/client`.
- The same graph, context, maps, manifest, chunk and reload checks pass after those adaptations. Deployment/migration CLI behavior was not tested.

**Reproduce:** `pnpm --filter @recooler-spikes/phase1 integration` and `pnpm --filter @recooler-spikes/phase1 integration:bench`. Each fixture writes its actual CLI config; after generation, a direct example is:

```sh
pnpm --filter @recooler-spikes/phase1 exec vite build .generated/integration-stable-compat-bench400 --config .generated/integration-stable-compat-bench400/vite.config.mjs
```

Evidence: `integration-{plain,stable-als,stable-compat,beta,stable-compat-bench400}.json`, including build order, resolved output directories, client manifest, returned server manifest, emitted chunks and WebSocket events.

## 4. Source maps through edits and bundling

**Verdict: pass; no extra composition library is required. Final printed maps have token-level column precision.**

`maps-plugin.mjs` moves an arrow function out of its original body, wraps the moved chunk with `prependRight` / `appendLeft`, and replaces its old expression site with `appendLeft`. It returns a magic-string map with `hires: true`. Another virtual module returns generated code and `map: null`.

`maps-check.mjs` verifies all **26 character positions** inside the moved/untouched marker strings in the direct transform map. After Vite lowering and Rolldown printing, it checks **six marker positions per bundle**, plus real moved and untouched exception frames in both final server and client code. It repeats with `includeContent: true` and `false`. The moved stack frame traces to **`src/map-source.ts:3:11`**, and untouched code to its original line 8. The generated virtual exception has no invented source mapping.

The integration matrix checks the final Worker and client bundles, production Worker exception frames, actual SSR dev exception stacks, and maps from **both** dev environment transforms, under plain Vite, CF v1 (both flags), and CF v2 beta. A dev map's relative `sources` must be resolved against its module URL when passed to trace-mapping.

Findings for the real transform:

- Always return `{ code, map }` for edits, including placeholder replacement; do not discard an earlier plugin's map.
- The magic-string map is character-accurate across the move. Rolldown's printer maps string literal contents to the original opening-quote column, so several character queries share a token position in the **final** bundle. Assert original file/line and known token columns there, rather than requiring every final string character to preserve its offset.
- No manual map composition was necessary. Both stages chain successfully through Vite/Rolldown.
- Vite populated final `sourcesContent` even when this transform omitted it, because it had loaded the real source file. Still generate `includeContent: true` for reliable standalone maps and sliced virtual variants whose source may otherwise be unavailable.
- `map: null` is appropriate for an entry/table with no original source. A virtual slice containing moved original handlers **does** have a source and needs a real map back to it; this spike's mapless virtual module is deliberately generated-only.
- Client dev map positions are verified programmatically; browser DevTools stack presentation is not tested.

**Reproduce:** `pnpm --filter @recooler-spikes/phase1 maps` and the integration commands. Evidence: `maps.json` and each integration JSON's `maps`, `builtChecks.frame`, `observed.crash`, `devMap` and `devClientMap`.

## 5. D4: per-route lazy client chunks

**Verdict: pass.**

The virtual client entry maps `/public` and `/admin` to separate `() => import(slice)` functions. Both slices import a shared module; only admin imports `admin-only.ts`. The build emits **four client chunks**: entry, public, admin and shared. The same representative arrangement is used in the 400-route fixture; its 400 page keys reuse the representative public slice.

`generateBundle` inventories `chunk.moduleIds`, static imports and dynamic imports. The test walks the static closure of the public slice **plus the entry** and asserts the admin-only module is absent. Shared code appears in **one** emitted chunk, imported by both route chunks. Actual evaluation of the public output does not evaluate the admin side effect; importing admin afterward evaluates shared code **once total**.

A separate failing build injects `src/server-only.ts`. The hook rejects it by its resolved module path, proving the path check catches a side-effect import even without a direct handler reference. This complements, rather than implements, the planned scope-level banned-import chain check.

Shared chunk placement is an observed bundler result, not a fixed chunk-name contract. Tests use module membership and dependency closure, not specific hash strings. Dedupe also does not imply route roots themselves have no side effects: keep the server-mode import-dropping and slice-reference analysis from the plan.

**Reproduce:** either integration command. The returned chunk inventory and `runtimeEvaluation` in each JSON are the evidence.

## Plan corrections and remaining work

1. **§3.2 / D5:** cache each module's adjacency once during build reachability; repeated module-info bridge reads made the naive graph slower and poorly scaling. Static dev edges come from lowered `deps`, not unfiltered `importedModules`. Complete the cold graph lazily, invalidate it on change, and transfer it to remote runtimes with a virtual module. v1 should use explicit SSR full reloads until partial updates have their own correctness tests.
2. **§3.2:** normalize transport version queries, select the actual Worker environment, and document the optimizer/externalization policy for action-bearing dependencies. A source-only transform cannot register code that Vite never transforms.
3. **§3.2:** document the HMR registry lifecycle. Preserve registrations from cached modules; explicitly clear modules losing their last action. The naive local-Map and dispose-only variants both failed.
4. **§3.2:** qualify the type-only/verbatim claim: `import type` disappears, while named type specifiers can leave an empty import with verbatim syntax.
5. **§3.3 / D3:** use Hono's public `routePath(c)` helper and capture route metadata inside the rendering handler; Hono 5 RC's late route index is not the rendering route. Preserve the incoming pathname when exact encoded catch-all identity matters.
6. **§3.4 build:** specify the manifest feedback mechanism. The demonstrated implementation uses three environment builds in one CLI invocation. Pin the Vite minor and retain tests for the experimental builder API.
7. **§3.4 Cloudflare v2:** read resolved output directories and update the config schema as well as the environment name. `consumer === 'server'` is necessary but not sufficient to choose among multiple server environments.
8. **§3.1 maps:** distinguish character-accurate transform maps from token-accurate final printer maps; generated-only virtual modules may be unmapped, original-source slices may not. Keep `sourcesContent` in transform maps.
9. **D5 middleware-rendered forms:** this spike does not justify registering actions ahead of their own guard middleware. Keep the documented unguarded-route solution for v1; any different middleware-action semantics need a separate conformance/security decision.
10. **Phase 1 scope:** no D8/scope-manager or real htmx transform/slicer port, complete extension-API freeze, conformance migration, consumer inventory, CSRF/signing implementation, deployment, CI integration, browser UI state preservation, or unloaded-machine performance claim is included. The banned-import reference-chain diagnostic and handler-load queue are also still implementation work. No branch was pushed.

Primary API references (implementation evidence above is from the pinned local packages): [Vite framework Environment API](https://vite.dev/guide/api-environment-frameworks), [Vite environment instances](https://vite.dev/guide/api-environment-instances), [Cloudflare environments](https://developers.cloudflare.com/workers/vite-plugin/reference/vite-environments/), [Cloudflare AsyncLocalStorage](https://developers.cloudflare.com/workers/runtime-apis/nodejs/asynclocalstorage/), and [Hono context storage](https://hono.dev/docs/middleware/builtin/context-storage).
