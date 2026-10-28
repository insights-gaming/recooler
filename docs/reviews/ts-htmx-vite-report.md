# Phase 4b: server htmx in recooler()

Implementation branch: `ssttevee/ts-htmx-vite`, based on `ac17235`.
Worktree: `/Users/steve/.t3/worktrees/farm-plugin-recooler/t3-b14570d3`.
No Rust sources changed; no consumer sources copied; no push.

## Decisions and implementation

- Automatic entries accept `recooler({ htmx: { secretBinding: 'RECOOLER_SECRET' } })`.
  The default binding name is `RECOOLER_SECRET`; request bindings take precedence
  over Node's `process.env`. No literal-secret option is accepted by the plugin.
  Missing/empty values throw on the first request needing a signer. Integration
  builds set a sentinel in process.env and Worker local bindings, then grep the
  actual server JS to prove it was not inlined. Custom entries pass `secret` to
  `htmx()` themselves and can import `table` and `namespace` from
  `virtual:recooler/htmx`.
- Every `vite build` defines the production flag, including builds with mode
  `development`. The runtime rejects `unsafeUnsigned` at startup unless
  `allowUnsignedInProduction: true` is explicit. This covers custom entries and
  avoids evaluating a Worker bundle in Node to inspect a runtime-only marker.
  The warning and exported marker remain. This replaces the earlier Phase 4a
  README's proposed marker-inspection hook; the task explicitly allowed a startup
  guard (§3.5). Standalone runtime consumers supply their own production policy.
- An hx-content-filtered pre transform runs in server mode before
  `recooler:jsx-defaults`. It returns code/maps, reports located diagnostics, uses
  srcDir-relative action IDs, and emits the same stable project namespace into
  registrations and extension configuration. Transport `v`/`t` queries are
  canonicalized; meaningful variants remain distinct. Explicit environment
  selection is enforced and tested with the non-default Cloudflare v1 Worker.
- D5 build tables use cached Rolldown adjacency at renderChunk, only static
  imports, route/layout/root seeds, page routes, and action-bearing IDs. The
  placeholder replacement returns a map. Dev uses lowered transformResult.deps,
  one parallel discovery per graph pass, cached resolutions/adjacency and reverse
  action propagation. Concurrent walks are deduped and retried to a stable epoch.
  Every source module registers, including empty registrations after a restart.
  Changes perform invalidateAll/full SSR reloads. Unchanged pure transforms are
  cached, but modules still evaluate and replace their registrations.
- The table import precedes the manifest, allowing parallel pretransforms before
  the module runner's serial import evaluation. Route generation has an early
  configureServer hook because Cloudflare can import the Worker during startup.
  Generation failures retain the existing deduplicated overlay/recovery path.
- Framework-declaring action dependencies are crawled, bundled, and excluded
  from the selected server optimizer. `htmx.actionDependencies` supplies packages
  lacking that declaration and overrides Vite external/include entries for them.
  Both forms have real dispatch coverage. Arbitrary user Rolldown external
  callbacks remain outside Vite's resolver policy; this is documented.
- Client environments, chunks, onLoad delivery and page.scripts remain Phase 5.
  The virtual graph module and separate plugin keep that integration possible
  without changing the platform builder.

## Correctness and conformance

Final verification commands:

```sh
pnpm --filter recooler build
pnpm --filter recooler typecheck
pnpm --filter recooler test
pnpm --filter recooler-conformance typecheck
CONFORMANCE_TARGETS=ts,farm-0.0.27 pnpm --filter recooler-conformance test
pnpm --filter recooler exec node test/vite/htmx-bench.mjs
pnpm --filter recooler exec node test/vite/htmx-bench.mjs --cloudflare
```

- Package: **1,381 passed**, 45 files. Package and conformance typechecks/build pass.
- Conformance: **TS 516 passed / 3 skipped**, **Farm 512 passed / 7 skipped**.
  With 23 shared harness checks: **1,051 passed / 10 skipped**, no failures.
  Of the former 134 htmx skips, **131 are now enabled**. The three client-tagged
  Phase 5 checks cover handler chunks, handler-free client entry exclusion and
  root external script delivery. Every server action, CSRF, signing/tamper/replay,
  barrel and mount check runs on TS.
- Plain Vite and Cloudflare **1.65.0** / **2.0.0-beta.v.5** pass real builds,
  production import/preview requests, dev signed dispatch, CSRF/tamper rejection,
  static-edge graph assertions, edits and action removal. Cloudflare v1 uses
  nodejs_als; v2 uses nodejs_compat. V2 requires its native secret declaration
  (`worker.env`) and absolute Build Output API outDir handling.
- The graph fixture covers roots/layouts, re-exports/barrels, side effects,
  cycles, erased import type, surviving mixed type imports, outside-src modules,
  dependencies, dynamic-import exclusion, handler-only route exclusion, project
  namespaces, concurrent cold requests, and clearing a seeded stale registration
  after a dev-server restart.
- A thrown error inside a built hoisted action maps to the original
  **src/routes/index.tsx:10**, with exact original sourcesContent. Existing
  non-action built source-map and JSX configuration regressions still pass.
- Custom-entry unsigned mode fails at startup in both production/development
  build modes; the explicit production override and htmx:false/custom-entry guard
  are tested. Located transform errors and root onLoad warnings are asserted.
  A real Rolldown watch rebuild preserves unchanged page actions while removing
  changed dependency actions and then the final action from a module.

Failure analysis:

1. **Harness bug fixed:** mounted Hono route tables did not inherit the adapter's
   request-time secret. BuiltApp.env now also reaches the outer mount's fetch;
   the route/basePath/mount suite passes with real signing.
2. **Wrong TS expectation corrected:** s4b's unauthenticated unknown public action
   falls through to the later admin catch-all. Its guard runs before action
   verification and returns **401**, with public-group then admin-group trace.
   The old TS expectation of an early 404 contradicted §3.5/D6. The replacement
   now asserts the guard trace and excludes action execution; Farm is unchanged.
3. **Implementation bugs fixed with regressions:** eager workerd imports saw an
   empty initial table before route generation; unconditional reloads repeated
   invalid-generation diagnostics. Early generation and htmx-aware reload/error
   handling fix these while retaining invalidateAll for active htmx apps.
4. **Performance issue fixed:** manifest-first evaluation and repeated per-route
   promise walks inflated edit latency. Table-first imports, shared discovery,
   reverse propagation and pure-transform caching reduced the 400-route Node
   measurement from roughly 1.54 s to roughly 0.75 s.
5. **Watch lifecycle bug fixed:** clearing all build metadata at buildStart would
   lose actions when Rolldown reuses cached, unchanged modules. Metadata now
   survives rebuilds; watchChange clears only changed source identities, even if
   removing the last hx attribute makes the filtered transform stop matching.

There are no remaining server conformance failures or unannotated semantic
changes. The three client skips reference §3.4/Phase 5. Module-precision barrel
reachability and exclusion of dynamic imports are the intended §3.2 behavior.

## Performance methodology and gates

The checked-in gen-app.mjs generates 100/400/1,000 pages, each retaining all three
real actions and its handler. Both variants use the full routes/JSX app plugin;
only htmx:false differs for the build baseline. Server builds include maps, no
minification and all page namespaces (not a tree-shaken stub). One warmup per
variant/size is excluded; three measured builds are interleaved, reversing order
in alternate rounds. Gzip size is tracked. The grouped variant has four groups,
each with group and directory middleware; relative imports are adjusted for depth.

Edit measurements use a probe page after a marker dependency changes, median of
three watcher edits. Every generated page remains in the manifest/reload graph.
Both dev variants use the mandated full SSR reload/invalidateAll: comparing
incremental no-htmx HMR with a full reload was an invalid control. The htmx cache
retains only pure transforms, not module evaluation or action registrations.

Gates: full/no-htmx build ratio <6; 400/100 full-build and Node dev ratios <5.5;
Node edit median <2,500 ms; edit overhead over the matched full-reload control
<max(500 ms, 50% of baseline), plus a normalized ratio <6. Workerd uses the
relative/overhead gates because its no-htmx 1,000-route full reload alone exceeds
4 seconds. Its raw response time is explicitly reported below, not hidden by
subtracting the control. All final gates pass.

Raw samples, load averages and output sizes:
[Node build/dev](ts-htmx-vite-bench.json),
[workerd dev](ts-htmx-vite-bench-cloudflare.json).

## Final measurements

Build medians in milliseconds (baseline → full plugin), with full-plugin gzip size:

- 100 routes, plain: **57.6 → 141.8 ms**, **2.46×**; gzip **31,647 bytes** (baseline 18,713).
- 400 routes, plain: **191.7 → 479.8 ms**, **2.50×**; gzip **70,198 bytes** (baseline 37,132).
- 1,000 routes, plain: **450.8 → 1179.9 ms**, **2.62×**; gzip **146,798 bytes** (baseline 71,810).
- 100 routes, four groups: **67.2 → 150.6 ms**, **2.24×**; gzip **32,941 bytes** (baseline 19,432).
- 400 routes, four groups: **203.1 → 485.4 ms**, **2.39×**; gzip **72,780 bytes** (baseline 38,100).
- 1,000 routes, four groups: **485.3 → 1142.8 ms**, **2.35×**; gzip **152,199 bytes** (baseline 73,344).

100→400 full-build growth: 3.38× plain, 3.22× grouped, for 4× as many generated pages.

Edit-to-response medians in milliseconds, baseline → full plugin. Both controls use full SSR reloads:

- Node, 100 routes, plain: **219.7 → 371.5 ms** (1.69×).
- Node, 400 routes, plain: **606.3 → 811.4 ms** (1.34×).
- Node, 1,000 routes, plain: **1431.1 → 1810.5 ms** (1.27×).
- Node, 100 routes, four groups: **304.9 → 294.6 ms** (0.97×).
- Node, 400 routes, four groups: **602.9 → 895.8 ms** (1.49×).
- Node, 1,000 routes, four groups: **1675.2 → 1846.1 ms** (1.10×).
- workerd, 400 routes, plain: **1732.2 → 1886.9 ms** (1.09×).
- workerd, 1,000 routes, plain: **4320.6 → 4140.4 ms** (0.96×).

Load-average ranges (1 / 5 / 15 minutes):

- Node builds/dev: **5.82–7.32 / 4.99–5.51 / 5.49–5.65**.
- workerd dev: **5.17–6.33 / 5.45–5.66 / 6.20–6.31**.

The workerd 1,000-route full reload remains about four seconds on this machine.
Its htmx/control difference is within run-to-run noise; this is not a claimed
speedup. D5 intentionally requires invalidateAll; scoped invalidation is deferred.
Vite 8.3.5, Rolldown 1.2.15 and Node v22.22.2 were used.

