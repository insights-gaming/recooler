# Phase 4b implementation review response

Implementation checkpoints: `4146f9d` (runtime security and JSX guard),
`8b139cc` (Vite graph, registration, reloads and regression coverage), based on
`98acae9`. The final report/benchmark checkpoint includes the updated documentation
and final assertions. Work stayed on `ssttevee/ts-htmx-vite`; nothing was pushed.

## Findings

1. **Canonical alias layouts:** `GenerateResult.routes` exposes each resolved
   `file`, `layoutFiles` and `rootFile`. D5 seeds use this plan rather than walking
   filesystem ancestors. The pA build/dev tables both include
   `routes/[id]/layout.tsx` for `routes/:id/edit/index.tsx`; `/x` and `/x/edit`
   render and dispatch successfully. The permanent regression suite checks the
   alias chains and build/dev equality.
2. **Auxiliary Workers:** an environment must load `virtual:recooler/htmx` before
   receiving dev registrations. Empty-registration hooks cover `srcDir`, discovered
   or explicitly declared action dependencies, and previously transformed action
   modules (so outside-source action removals can still be cleared). The pW
   default-selection repro serves both `/aux` and `/`. Package integration now
   exercises a real auxiliary Worker with selection unset and asserts that its
   transformed source contains no htmx runtime import.
3. **Replay protection:** the MAC uses
   `['recooler.action.v2', namespace, base, moduleHash, routeId, pathname, method, actionId, scopeJson]`.
   The defining module's incoming source is SHA-256 hashed at Vite transform time
   and emitted in its registration. Namespace/base prevent shared-secret app
   replay; the module hash rejects old positional IDs after source changes.
   Unchanged defining modules retain working URLs across rebuilds. Runtime tests
   cover namespace and base independently, shifted IDs and unchanged modules;
   the real dev matrix and watch-build test cover inserted actions. pK1 → pK2
   replay now returns 404 while the original A request returns 200. The testing
   helper's address and consumer-equivalence contract document all three identities
   and that the returned URL already includes the base.
4. **Untransformed functions:** the JSX intrinsic-attribute filter rejects
   function-valued `(data-)hx-{get,post,put,patch,delete}` and `hx-on*`, naming the
   attribute and “module was not transformed”. Classic/automatic/dev runtimes are
   covered on all supported Hono versions. The disabled-transform pL repro now
   returns 500 without rendering server source.
5. **First imported action:** dev installs the extension whenever `htmx !== false`.
   pC transitions from a plain page to importing an existing action component
   without any `hx-` text in the edited route, and its action succeeds. The Node
   and workerd edit matrices start with this transition.
6. **Server/environment isolation:** namespaces include the environment name and
   a per-server dev nonce. The two-server pJ repro renders and executes in the
   correct server instance. Tests cover two concurrent servers, two environments
   on one server, cross-server URL rejection and restart isolation. Empty resets
   remain as defense in depth.
7. **Edit latency:** hot updates invalidate only the virtual table and retain the
   full runner reload. Changed files follow Vite's normal invalidation; unchanged
   transforms are reused. Node/workerd tests exercise first action, add/remove
   actions, add/drop edges, shifted IDs, last action, deleted files and stale URL
   rejection. The original pC/pD/pM scripts pass, including syntax-error recovery.
   The benchmark control now uses stock HMR. Node gates include a 1 s absolute
   cap and incremental-HMR overhead/ratio budgets; workerd has a separate 3.5 s
   cap because its full runner fetch still dominates. Both gates pass.
8. **Build graph/maps:** build and dev call the same reverse-edge propagation
   helper. Shared static closures are discovered once per pass. A standalone
   placeholder line returns `map: null` because later mapped code retains its
   positions; combined lines use `hires: 'boundary'`. Tests cover both map paths,
   exact hoisted-frame line/column/source content in a real build, and build/dev
   table parity across the integration fixtures and canonical aliases. The
   reviewer's nullmap script maps pI's hoisted frame to `src/routes/index.tsx:7:10`
   (zero-based column 10).
9. **Diagnostics/codegen/docs:** the generated missing-secret error names the
   configured binding, `.dev.vars`, deployed Worker secrets and `process.env`.
   Tests exercise both `RECOOLER_SECRET` and `CUSTOM_ACTION_SECRET`. Namespace and
   hash are structured `RegistrationEmission` fields; the regex splice is gone.
   The reachability error explicitly mentions that dynamic `import()` is not
   followed. The Vite README documents Cloudflare copying secret-bearing
   `.dev.vars` into `dist/<worker>/`.

## Performance

Raw samples, build sizes, machine load and gate settings are preserved in
[the benchmark artifact](ts-htmx-vite-review-bench.json). All runs were serial on
Node v22.22.2. Dev figures below are medians of five edits at 1,000 routes.

- Reviewer fixture, Node: **1,944 → 413 ms** (79% lower); all action probes 200.
- Reviewer fixture, workerd: **4,269 → 2,158 ms** (49% lower); all action probes 200.
- Reviewer fixture, build: warm median **1,191 → 998 ms** (16% lower).
- `renderChunk`: four-run mean **185 → 16 ms** (91% lower).
- Updated flat full-plugin gate, Node: **427 ms htmx / 156 ms stock HMR**.
- Updated grouped gate, Node: **441 ms htmx / 178 ms stock HMR**.
- Updated workerd gate: **2,472 ms htmx / 544 ms stock HMR** at 1,000 routes;
  **1,070 / 304 ms** at 400 routes. The remaining full-runner cost is visible.
- Flat 1,000-route build: **1,006 ms htmx / 465 ms baseline** (2.16×).
  Grouped: **964 / 487 ms** (1.98×). The 100/400/1,000-route build and edit gates,
  including linearity, all pass.

The Node raw gate snapshot predates tightening the workerd-only cap from 5 s to
3.5 s; its Node gates are unchanged. The final workerd snapshot validates 3.5 s.
The pre-change stock Node measurement on the reviewer fixture was 227 ms.

## Verification

- `pnpm --filter recooler test`: **1,422 passed**, including the real Node,
  Cloudflare v1 and Cloudflare v2 beta build/dev tests, action source maps,
  auxiliary Worker, production options, build watching and edit matrices.
- `pnpm --filter recooler typecheck` and `pnpm --filter recooler build`: passed.
- `CONFORMANCE_REBUILD=1 CONFORMANCE_TARGETS=farm-0.0.27,ts pnpm --filter recooler-conformance test`:
  **1,051 passed, 10 expected skips** (Phase 5/client requirements and target
  applicability), with both targets rebuilt.
- `pnpm --filter recooler-conformance typecheck`: passed.
- `htmx-bench.mjs` and `htmx-bench.mjs --cloudflare`: passed with stock HMR control.
- Reviewer scripts re-run from `/private/tmp/r4b`: `harness.mjs` for pA/pL,
  `cf-aux.mjs` for pW, `cross-app.mjs`, `two-servers.mjs` for pJ,
  `dev-edit.mjs` for pC/pD/pM, `nullmap.mjs` for pI, `bench-dev.mjs`,
  `bench-dev-cf.mjs`, and `bench-build.mjs`.

Vite's strict filesystem loader rejects `:` in filenames through workerd's fetch
transport. The trusted alias regression fixture explicitly sets `server.fs.strict: false`
for that check; the production plugin does not relax Vite's filesystem
policy. Node alias build/dev and the ordinary Cloudflare v1/v2 integrations pass
with their normal configurations. Third-party easy-jsx sourcemaps still emit their
existing missing-source warnings; the action source-map assertions pass exactly.
