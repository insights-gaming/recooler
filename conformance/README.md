# Recooler conformance

The checked-in source trees and JSON expectations test the published **farm-plugin-recooler 0.0.27** through **Farm 1.7.11**. They are independent of the Rust checkout. The `ts` target builds the same source trees with Vite 8 and `recooler()` for implemented non-htmx features. [SCENARIOS.md](SCENARIOS.md) indexes every runnable scenario and its provenance.

```sh
pnpm install
pnpm run test:conformance
pnpm --filter recooler-conformance typecheck

# Comma-separated substring filters on scenario directory names; Vitest -t also works.
CONFORMANCE_SCENARIOS=s8,x10,d8 pnpm --filter recooler-conformance test
CONFORMANCE_TARGET=ts pnpm --filter recooler-conformance test
CONFORMANCE_TARGETS=farm-0.0.27,ts pnpm --filter recooler-conformance test

# Add scenario directories anywhere; paths are relative to the conformance package cwd.
CONFORMANCE_DIRS=../fixtures/example/scenario CONFORMANCE_SCENARIOS=scenario pnpm --filter recooler-conformance test
```

`ts` requires built `recooler/router`, `recooler/jsx` and `recooler/vite` entrypoints. Run `pnpm --filter recooler build` first. Set `CONFORMANCE_ALLOW_SKIP=1` to opt into skipping a missing entrypoint; broken builds still fail. JSX is evaluated through its Vite bundle because the engine cannot load as native Node ESM.

The adapter uses `recooler()` and `ssr.noExternal: true`, emits a single self-contained SSR module per content hash, imports it in the runner's realm, and calls `fetch`. Before each scenario import, both targets delete the engine’s `globalThis.SUSPENSE_ROOT` (counter and request map). Every TS import receives a fresh instance query; bundled dependencies therefore reset too, even when source-identical scenarios reuse bytes or `CONFORMANCE_REBUILD=1` overwrites the same output. The TS hash includes source names/bytes, adapter/builder, compiled recooler implementation, package.json exports, lockfile, tsconfig, production mode and `NODE_ENV=production`, Node version, platform and architecture. The builder child always receives `NODE_ENV=production`, independently of Vitest’s test environment. Legacy `farm-plugin-recooler/helpers` imports map to `recooler/jsx` for the shared page/root helpers.

The Vite plugin does not yet wire the integrated htmx transform into action
dispatch or browser builds. Individual request checks carry `requires: ["htmx"]`
when they depend on extracted actions, reserved action queries, rendered action
URLs/events, client chunks, or middleware fall-through through an action
registration. `Target.requestSkipReason` exposes these as explicit skips; other
requests in the same scenario still run. Source attributes alone never skip a
scenario. Ordinary `onPost` handlers and all five `q6` requests run.

Each directory contains `src/` and `scenario.json`. The source tree follows the normal `root.tsx`, `routes/**/index.tsx`, `layout.tsx`, and `middleware[@name].ts` conventions. Imported support files live in `src/lib` or `src/components`. Recovered fixture sources preserve their original import spelling; the runner uses NodeNext and `.js` imports.

```json
{
  "name": "example: protected form",
  "source": "review document or transcript identifier",
  "requests": [
    {
      "name": "page",
      "path": "/protected",
      "expect": {
        "status": 200,
        "includes": ["<form"],
        "excludes": ["server secret"],
        "headers": { "x-guard": "yes", "x-unwanted": null },
        "trace": ["guard"]
      }
    },
    {
      "name": "submit rendered action",
      "requires": ["htmx"],
      "method": "POST",
      "action": { "page": "/protected", "attribute": "hx-post", "index": 0 },
      "headers": { "x-auth": "yes" },
      "form": { "name": "Ada" },
      "expect": { "status": 200, "body": "hello Ada", "trace": ["guard"] },
      "changes": [{ "decision": "D6", "reason": "The target may sign every rendered URL." }]
    }
  ]
}
```

Assertions support exact `body`, `includes`, `excludes`, regex `matches`, regex occurrence `counts`, selected `headers` (null means absent), and ordered `trace`. Every request specifies a status. `traceExcludes` rejects particular middleware/action trace entries. `clientIncludes` and `clientExcludes` inspect the concatenated contents of **all emitted browser chunks**, including lazy handler chunks. These require `BuiltApp.clientChunks`, keyed by served URL; an adapter cannot substitute server output or omit lazy chunks. A positive handler-code assertion accompanies the server-only exclusion, so an empty chunk map fails. `inlineScriptExcludes` forbids handler-code markers inside script elements while permitting unrelated bootstrap and cleanup scripts. `noClientEntry` rejects script references to the app's emitted client URLs and requires a nonempty chunk map, even on handler-free pages. `root-scripts` also requires route metadata (`data-recooler-route` on the body, or a `recooler-route` meta tag for a root that owns its body).

A build-error scenario replaces `requests` with `"buildError": "diagnostic substring"`, or an array of required substrings. `buildErrors: { "ts": ["src/routes/a/index.tsx", "src/routes/b/index.tsx", "GET"] }` supplies a complete target-specific diagnostic override, independent of Rust's English phrasing. Every array element is required independently, so route order is irrelevant. `BuildResult.kind = "buildError"` also represents startup validation errors. m14 (namespace object) and m15 (class) independently require `routes/middleware.ts` on TS (`src/routes/middleware.ts` on Farm) and `must export a middleware function`. Classes must be rejected despite `typeof value === "function"`, for example by checking the `class` prefix of `Function.prototype.toString.call(value)`. m17 throws during module loading before namespace validation is possible; it remains a documented known issue rather than asserting an unreachable startup diagnostic.

Action requests resolve URLs from rendered `hx-*` or `data-hx-*` attributes, including HTML entity decoding and relative resolution against the rendered page. `action.headers` authenticates the render request; the outer `headers` authenticates the action request. `action.response` reads a previously named response instead, for nested forms returned in fragments. Both rendering and submitting use `request.mount`. `action.path` retains the extracted query (including signature/scope) but sends it to another path. `action.oraclePath` corrects only the oracle's unprefixed mount URLs; TS must submit its extracted URL unchanged for ordinary mounted actions. `ts: { "htmxOptions": { "base": "/m" } }` configures `htmx({ base: "/m" })` for the prefix-stripping `mount()` scenario. `action.tamper` supports `drop-sig`, `flip-sig`, `scope` and `method`; method changes POST to GET (or another method to POST) while retaining the extracted query. A missing attribute or unsuccessful render fails the test. Known-invalid `?action=` probes deliberately specify the unknown query value directly.

The runner automatically sends **`HX-Request: true`**, **`Origin` equal to the destination URL's origin**, and **`Sec-Fetch-Site: same-origin`** for extracted actions and handwritten `?action=` requests. Explicit `headers` override defaults; `omitHeaders` removes selected defaults for negative probes. D7's cross-site POST, missing provenance headers, missing HX POST and missing HX GET cases require TS to return 403 with no action-body trace. The oracle ignores these headers.

The `action` query is reserved only on routes with actions for the receiving method, preserving 0.0.27. Unknown or unsigned values on those routes fall through to 404 on TS after chain middleware. Eleven oracle lookup probes already return 404. s5's `POST /postonly?action=bogus` and `GET /pageonly?action=bogus` remain **200 on both targets** because no applicable action dispatcher reserves the query. This is not a global routing rule.

D6 signs every action over the rendering binding's **route id (`route.file`), exact pathname, method, action id and scope**. The extension verifies against the receiving registration's binding **after its chain middleware and before `onRequest`/handlers**. A mismatch calls `next()`; if nothing answers, the result is 404. There is no pre-middleware rejection rule. Unauthenticated foreign/replayed admin URLs still return the guard's **401**, including `/admin-secret` replayed to `/x`. Once the chain passes, invalid signatures fall through to **404**; sharing a catch-all pattern does not authorize a different pathname. Every foreign/replayed or tampered TS negative probe excludes action-body traces.

`action-signing` renders a real `/users/1` action and tests missing/altered signatures, wrong method, tampered scope and replay to `/users/2`, with authenticated chain traces and TS 404. It also checks an unauthenticated replay's 401. The oracle honestly runs the uncaptured tampered/replayed POSTs, renders its page for the wrong-method GET, and returns 403 for tampered captured scopes signed with the fixture-only test key. `action-barrel` records the 0.0.27 hole: an unused admin re-export registers that action under public middleware (200); TS requires 404 with no action-body execution.

`mount: { "type": "route" | "basePath" | "mount", "prefix": "/app" }` exercises Hono mounts; `repeat: 2` re-dispatches the **same Request object**. These repeat probes use requests without consumed bodies. Multi-step scenarios execute in file order. `repeatExpect` supplies expectations for dispatches after the first when outcomes differ (for example 500 then 401); otherwise the first expectation applies to every dispatch. Retry state resets for a fresh Request and survives a repeated identical Request. `mount.also` registers the same app at a second prefix in one parent; `mount.retry` performs one bounded outer re-dispatch on 401.

The recovered middleware records ordered entries in `globalThis.__t`. The common harness resets it for each top-level dispatch and publishes the collected trace as `x-conformance-trace` in the observation headers. Nested dispatches append to the same trace. This instrumentation is independent of the target; both adapters must execute in the runner's own process and realm. **workerd and other remote/isolated runtimes cannot implement this trace interface.** Every scenario must be a self-contained build with no shared application/dependency module state across scenarios: for example, a Vite SSR build with `ssr.noExternal: true` into a per-scenario directory. Adding a query to an entry module alone does not isolate its unbundled dependencies. For htmx/D4 scenarios the TS adapter must perform a Vite build of **both server and client**, exposing every emitted client chunk. Tests deliberately run serially, with one worker, to isolate the legacy trace channel. `BuiltApp.hono` exposes the real route table only for `route`/`basePath` mount probes. The public target contract is in [src/target.ts](src/target.ts).

`changes` can annotate a scenario or individual request with a decision and reason. An annotation alone leaves assertions intact. An optional request-level `ts` object supplies a **complete replacement expectation**, such as the D7 rejection of an action without `HX-Request`. Scenario-level replacements are rejected; put HTTP differences on individual requests and diagnostic differences in `buildErrors`. Multiple replacements for one request are rejected. Targets use `expectationFamily: "ts"` to opt into these expectations independently of their display/version name. `targets: ["ts"]` makes a scenario applicable only to that family; target exclusions are intentional skips, separate from unavailable-target skips. D3/D6 action URL changes are handled through extraction, D4 changes client script expectations, and D9 preserves the plain-before-group middleware ordering. D1/D2/D5/D8/D10/D11/D12 do not require different HTTP expectations in these fixtures. Security settings and helper import remapping for the future TS build belong in its adapter.

Farm builds run in separate Node processes with `persistentCache: false`, no decorators, and a single ESM output. The npm alias `farm-recooler-oracle` prevents pnpm from resolving the oracle to the local workspace package. The adapter explicitly maps `farm-plugin-recooler/helpers` to that published package. A custom Farm logger throws after reporting errors, preserving diagnostics instead of exiting the runner. Native crashes and timeouts fail as infrastructure errors and cannot satisfy a build-error expectation.

Outputs and build diagnostics are cached in ignored `conformance/.cache/<sha256>/` (Farm) and `ts-<implementation hash>-<source hash>/` (TS). TS evicts incompatible implementation/mode caches and superseded scenario source entries; a small index preserves content reuse across identical scenarios. The key includes source paths and bytes, plugin options, builder and adapter code, lockfile, Node version, platform and architecture. Expectations are checked on every run even when the build is reused. Filenames use code-point sorting for deterministic cache keys. Imports include the scenario directory as a URL query, so identical source trees reuse bytes while getting independent module instances, including during a forced rebuild. `CONFORMANCE_REBUILD=1` forces recompilation. Keep the cache in the workspace: Farm's native resolver fails to resolve JSX dependencies from some external build roots despite `node_modules` symlinks. External scenario trees are copied into this cache before compiling and are never modified.

Oracle defects are documented under [known-issues](known-issues/README.md). Seven TS-only scenarios cover their intended 0.1.0 contracts, including the root’s `props.scripts: string[]` contract; its second HOC argument remains `clientScript?: string`; m17 remains only a known issue. They are skipped on Farm instead of freezing broken oracle behaviour. Legacy `Root(Content, clientScript)` fixtures remain to exercise the one-release compatibility shim.

The [review response](REVIEW-RESPONSE.md) records the per-finding changes, verification commands and mutation results. The source tree contains **123 scenarios**: 116 oracle scenarios (477 request checks and 35 diagnostic checks) and seven TS-only scenarios (five request checks and two startup diagnostics). The suite also has 21 request/runner contract checks and two TS adapter cache/feature checks.

## TS integration results (2026-10-27)

The Vite review fixes use production builds, source-relative diagnostics and
request-level feature tags. Duplicate-layout diagnostics name only the conflicting
`routes/layout.jsx` and `routes/layout.tsx` files; alias collisions name
`routes/:id/layout.tsx` and `routes/[id]/layout.tsx`. The unrelated page files are
not required. Leading spaces in the TS expectations reject absolute paths.

Package tests cover real Vite SSR CLI builds, custom server environments,
third-party JSX dependencies, plain dev requests and route watching, default-only
virtual exports, a production SSR source map, actual Vitest startup/imports,
per-file JSX configuration, and generation failure/overlay/recovery. Cloudflare
v1/v2 build and dev checks are recorded in the Vite review response.

Final counts and verification commands are recorded in
[the Vite review response](../docs/reviews/ts-vite-review-response.md).
