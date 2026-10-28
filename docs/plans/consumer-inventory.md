# Consumer inventory for the 0.1.0 rewrite

Read-only audit of the two consumer packages on 2026-10-27. All descriptions and
fixtures here are synthetic; consumer paths, source, response bodies, dependency
logs and action IDs remain under `/private/tmp/consumer-equivalence/`. Counts describe
non-test JS/TS source in each package's `src`, not generated declarations or shared
workspace dependencies. Directory counts below are unique route-bearing directory
nodes, not occurrences in route paths. Physical depth counts group directories;
URL depth excludes them.

The published `farm-plugin-recooler@0.0.27` is the oracle. The audit combined AST
counts, review of the package configs/entrypoints/components, and actual Farm
builds. The fixtures deliberately compress repeated siblings; they preserve the
kinds of topology and syntax, rather than the consumer's full tree or business
logic. Zero counts are intentional and should not become inferred requirements.

## Configuration and entrypoints

| Convention | Router | Admin | Rewrite coverage / migration requirement |
|---|---|---|---|
| Farm configs used by package builds | 1 | 1 | Parts 1.5 and 3.4, Phase 6: replace Farm with Vite server/client environments. A separate workspace-root config is not implicitly inherited by these package builds. |
| Locked Farm / recooler versions | 1.7.11 / 0.0.27 | 1.7.11 / 0.0.27 | Manifest Farm ranges are older; use the lockfile, not the manifest range, for the oracle. |
| Input and output | `src/main.ts`; ESM library; one enforced main resource | Same | Part 1.5: preserve the user-owned Worker entry, exports and `fetch` shape. Vite must retain platform externals. |
| Common compilation settings | minify off, source maps `all`, two Workers module externals, no automatic Node externals; path polyfill alias; exports/browser/module/main resolution | Same | Part 3.4 does not replace unrelated bundler configuration automatically. Phase 6 must map aliases, conditions, defines, CSS and externals. |
| JSX / CSS plugins | No JSX-producing pages and no JSX plugin | Automatic JSX from `easy-jsx-html-engine`, React refresh/development off; PostCSS | Part 2: preserve the engine's async components and HOCs. CSS migration needs explicit Vite/PostCSS instructions. |
| Recooler options | Plugin by package name, all defaults | Custom default-export renderer module; 8 `client_banned_imports` patterns | Parts 2 and 3.4 cover replacements. `route_handler_factory` resolution is tied to Farm's compiled-config location; do not copy that relative path into Vite. |
| `src_dir` / `routes_dir` overrides | 0 / 0 | 0 / 0 | Part 1.1 defaults suffice. |
| Cache / decorators | Cache option not explicitly set; no decorator dependency | Same | Oracle harness forces `persistentCache: false` and removes decorator parser options because of the frozen ABI limitation. |
| App export | Default Hono instance imported from `recooler::app`; installs `app.onError` | Default object spreads the imported app; installs `app.onError`; 1 named Durable Object class re-export | Part 1.5 permits explicit entrypoints. Preserve the object export's fetch behavior and named class; the virtual app must export only default for Workers. |
| Other Worker entry exports | 0 | 0 besides that class | No scheduled/queue/email handler is exported by these two main modules. Route `onRequest` is distinct from the generated Pages adapter. |

The router Farm config has no defines. Deployment is a two-stage build:
Wrangler's generated config runs `npx farm build`, reads `dist/main.js`, then
re-bundles with esbuild. Wrangler applies all seven environment macros, including
an object-valued macro; deploy adds an additional CLI define override. Preserve
the separate local and deployment constant profiles.
Cloudflare Vite plugin 1.65.0 deletes Wrangler `build` and `define` configuration;
see the explicit per-mode Vite recipe in [the migration guide](../migration-0.1.md).
The workspace catalog currently pins `vite: ^7.3.6` alongside Vitest 4.1.10;
upgrade the catalog and validate that pair when adopting the Vite 8 target.

Admin CSS is a string import served by a route, not a side-effect stylesheet.
A patched `@farmfe/js-plugin-postcss@1.12.0` emits `export default "<css>"`
after Tailwind processing. Ambient declarations treat `*.css`, `*.html`, `*.txt`
and `*.sql` imports as strings. Vite 8 needs `*.css?inline` for processed CSS,
and `?raw` for plain text/SQL/HTML strings; do not replace processed CSS with raw
Tailwind input. Map the exact `path$` polyfill alias to a Vite alias with
`find: /^path$/`, and map Farm's exports/browser resolution to Vite
`resolve.conditions` and `resolve.mainFields` (exports resolution takes priority).

Across the workspace, 34 modules import `env` from `cloudflare:workers`, including
route handlers and middleware. Keep Workers modules external in the server build
and reject them in browser slices using both raw and resolved import checks.
The synthetic CSS handler uses that import; Node checks install an explicit stub,
while private consumer tracing runs in Miniflare/workerd with the consumer's
Wrangler compatibility date and flags.

## Routes and middleware

| Shape / convention | Router | Admin | Rewrite coverage / gap |
|---|---:|---:|---|
| Route modules | 66 | 55 | Part 1.1 scanning and 1.3 registration. |
| Default page exports | 0 | 51 | Parts 1.3 and 2; router is API/proxy-only despite one `.tsx` route filename. |
| `onGet` / `onPost` / `onRequest` exports, including named re-exports | 30 / 22 / 15 | 4 / 0 / 0 | Part 1.3; one router route has both `onRequest` and `onGet`, so these are not disjoint counts. Other method exports: 0 in both packages. |
| Maximum physical / URL depth | 5 / 4 | 4 / 4 | Part 1.1. Router depth histogram: 0:1, 1:9, 2:30, 3:19, 4:6, 5:1. Admin: 1:1, 2:23, 3:29, 4:2. |
| Parenthesized group nodes | 1 | 0 | Parts 1.1/1.3: flatten onto the same strict Hono app. |
| Single-segment param nodes | 13 | 18 | Parts 1.1 and 3.1/3.3. |
| Catch-all nodes | 10 | 1 | Part 1.1: `[[...]]` requires at least one segment. Router has root and nested catch-alls and static siblings; admin has a fallback page below its plain prefix. |
| Explicit regex / colon-form directory nodes | 0 | 0 | No consumer-specific requirement. |
| Dot-hidden route directories | 0 | 0 | Reference behavior still requires support; fixtures do not invent usage. |
| Underscore-prefixed route-bearing nodes | 3 | 1 | These are literal URL segments, not groups or ignored directories. One extra router underscore directory contains documentation only. |
| Middleware modules | 5 | 2 | Part 1.3 and reference middleware rules. |
| Plain-directory middleware outside groups | 4, all at route root | 2, both at one plain prefix | Register before routes with prefix semantics, including unmatched requests. Admin auth must also protect catch-all and method-only routes. |
| Direct group middleware | 1 | 0 | Group guard applies to its 3 route modules, once per dispatch. |
| Plain-directory middleware inside groups | 0 | 0 | Still a framework conformance requirement; absent from this consumer. |
| `@name` ordering | 4 numerically prefixed names | 2 lexical names, auth before error handling | Part 1.1 sorting / 1.3 registration. Preserve before/after-next behavior, not just invocation counts. |
| Layout modules | 0 | 1 plain-prefix HOC | Part 2 composes it around all pages under the prefix. Handler-only endpoints do not render through it. |

Router request handlers include named re-exports and a re-export that aliases
`onRequest` to `onGet`. Six route modules use named request-handler re-exports;
there is also one non-route utility barrel using `export *` inside the routes directory, beside other helper files that the route scanner must ignore. Two routes delegate
all methods to a service binding. The group middleware reads a single-segment route parameter and returns not-found when it is absent; it must run inside the matched route chain after parameters are available. The root catch-all's `onRequest` can call
`next()` into its `onGet`; root `/` is a separate alias, because a catch-all does
not match the parent. Parts 1.1–1.3 must preserve these exports, fall-through and
handler order. Returning `undefined` and forwarding an unmodified Request are
used in proxy-style code; tests should exercise real Hono behavior.

Route modules also import other route modules. An admin detail page renders the
default exports of two other pages. A handler-only export route imports a data
helper from a page module containing one action and two handlers. Admin has three
route modules with non-handler exports; the router has eight non-handler exports
and its root catch-all imports a helper from another route. **Only routes with a
page register actions**, matching 0.0.27; importing an action-bearing page from a
handler-only route must not create an action endpoint (Part 3.2 clarified).

## JSX, heads and helpers

| Feature | Router | Admin | Rewrite coverage / migration requirement |
|---|---:|---:|---|
| Custom root | 0 | 1 | Part 2's one-release `clientScript` compatibility is needed. The root awaits content, renders its own html/head/body, emits `renderHeadElements`, and embeds the inline script after content. |
| Root head exports | 0 | 0 | No root head entry to migrate. |
| Layout head exports | 0 | 1 function declaration | Part 2 resolves it at request time. |
| Route head exports | 0 | 3: 1 function declaration, 2 const arrow functions | Parts 1.1/2 must recognize all these forms. No head object, local export specifier, source re-export, star head, async head or factory initializer is used. |
| Helper import sites | 0 | 5 modules / 6 named imports | `CreateJSXRouteHandlerFactory` once; `renderHeadElements` once; `Suspense` in 3 modules; `ErrorBoundary` once. Phase 6 must map these to `recooler/jsx`. |
| Suspense JSX uses | 0 | 3 | Part 2; request `rid`, fallback, catch behavior and asynchronous streaming are required. |
| ErrorBoundary JSX uses | 0 | 5 | 1 uses the helper wrapper; 4 import the engine primitive directly. Preserve direct-engine compatibility as well as the response-rethrowing helper. |
| Custom renderer | 0 | 1 | Part 2 promises both `ResolvedTemplate` and `suspenseCleanupScriptMiddleware`; retain the engine's `resolvedScriptMiddleware` integration for processing resolved fragments and the custom cleanup event. |

The admin layout branches on `hx-request` and supplies `catch={errorHandler}` to
Suspense and ErrorBoundary. The admin layout head also emits external script URLs, a stylesheet link and an
inline data-URL script. Part 3.4's external module scripts remove the framework's
inline handler bundle; they do not make a consumer's own head scripts or event
attribute evaluation CSP-compatible automatically. Keep custom head elements and
the htmx-before-client initialization order working. The plan needs an explicit
contract for legacy roots receiving inline `clientScript` while new roots receive
script URLs; a promise to accept both is not enough to define what is passed.

## Actions and browser code

| Feature | Router | Admin | Rewrite coverage / migration requirement |
|---|---:|---:|---|
| Inline form actions | 0 | 112: 107 POST, 5 DELETE, all arrow functions | Part 3.1 transform and 3.5 dispatch. No inline GET/PUT/PATCH actions. |
| Modules defining actions | 0 | 37: 33 route modules and 4 components outside routes | Part 3.2 must follow imports from page and component modules, including HOCs and shared components. One component action site is unreachable (no importers), leaving 111 registered IDs. |
| Capturing actions | 0 | 2 source sites: component-props object and loop-local scalar | Parts 3.1/3.5 scope capture and serialization.  |
| `actionScope` / `handlerScope` calls | 0 / 0 | 0 / 0 | Public helpers are not directly imported/called by this consumer; generated calls still matter. |
| Nested actions | 0 | 0 | Do not infer nested server actions from nested async callbacks. Framework conformance still covers them. |
| Explicit JSX `ctx` props | 0 | 67, all on components | Part 3.1 must keep ctx on components and drop it when spread onto intrinsic elements. No direct intrinsic `ctx` attributes or object-literal htmx props were found. |
| URL-valued `hx-get` | 0 | 1 dynamic URL expression | Leave URL-valued attributes untouched; it is pagination/navigation, not a server action. |
| Inline browser handlers | 0 | 66: 64 function expressions, 2 arrows | Part 3.1/3.4. 63 function handlers have an explicit TypeScript `this` parameter; no lexical captures found. |
| Modules defining handlers | 0 | 23: 15 routes, 1 layout, 7 other modules | Preserve components outside routes and layout reachability, with server-only imports removed. |
| Browser attribute forms | 0 | Dash and colon forms; 1 `hx-on--confirm`; 5 string-valued colon attributes (`hx-on:change`, `hx-on:paste`), plus 1 string-valued `data-hx-on--before-swap` | Part 3.1 preserves both separators and double-dash htmx events. Existing string code stays string code. |
| Route `onLoad` | 0 | 2: one const arrow and one function declaration | Part 3.4 includes both in their route's client slice. |
| Layout/root `onLoad` | 0 | 1 layout const arrow; 0 root | It never runs in 0.0.27 and warns. Part 3.4 correctly preserves that behavior; migration should mention moving it to route modules if execution was intended. |
| Source re-export declarations / star barrels in package source | 7 / 1 | 1 / 0 | Router count includes its star barrel; admin's source re-export is its Worker class. Admin has no local component barrel today. Shared workspace packages also supply server-side barrels; graph handling is still required by 3.2. |

Actions read the action request context, route params, typed form fields and
`payload.__formData`; they return JSX, Responses and undefined, and call shared
server utilities. A plain-prefix after-next middleware reads `ctx.error` and `ctx.finalized`, then throws `HTTPException(200 | 204, { res })` to turn action errors into UI responses and add refresh/push headers to empty action responses. The shared `app.onError` returns that exception's response. That behavior belongs to user middleware and must survive the Part
1.3 registration rewrite. **Undefined alone does not set a refresh header in the
0.0.27 runtime**; an existing consumer comment attributes that behavior to the
framework, but its own middleware supplies it.

Browser code uses `this`, event arguments, module-level functions and imports,
component prop spreads, string-valued htmx attributes and an eval-based wrapper
that forwards a parent's transformed event attribute through another data
attribute. PURE annotations on HOC calls are significant to existing client
slicing. Parts 3.1/3.4 must retain the referenced declarations and keep server
initializers out of client slices; simply tree-shaking unused exports is not an
equivalent implementation.

The eight banned-import patterns cover platform modules, a database SDK, Hono,
the JSX engine, a workflow package, shared database modules, a JWT library and
shared session/storage/crypto/network helpers. They use both package names and
relative paths. Part 3.4 covers raw-specifier and resolved-path checks; Phase 6
must document the new option spelling and retain protections across workspace
aliases and packages outside `srcDir`.

## Other usage and gaps to resolve

- Neither package uses SSG, `recooler::metadata`, the generated Pages `onRequest`
  adapter, a custom routes directory, dynamic action imports, root actions or root
  event handlers. Parts 1.5, 3.2 and Phase 6 cover these as general migration work.
- Part 1.5 explicitly preserves named Worker exports, which is necessary for the
  admin Durable Object. The application default export and named class need a
  Workers-runtime test, not only `app.request()` under Node.
- Part 3.3 changes component action URLs from relative URLs to absolute URLs and
  requires AsyncLocalStorage compatibility flags on Workers. Document those
  flags, the explicit ctx override, mount prefixes and fragment/history behavior.
- Parts 3.4/3.5 intentionally change inline scripts, signatures and CSRF. Existing
  htmx requests set `HX-Request`; direct/manual action clients must do so too.
  Deploy-time binding secrets replace inlined config secrets. Stale cached pages
  and manually constructed action URLs need the Phase 6 guidance already planned.
- Part 3.2's module graph can over-approximate action reachability through shared
  barrels. Signed URLs intentionally tighten route authorization. Keep baseline
  registered action IDs separate from rendered action URLs in equivalence reports.
- Parts 1–3 do not specify migration of consumer-controlled CSS bundling,
  deployment defines, alias/condition resolution or platform service bindings.
  These need a practical build recipe in Phase 6; they are not new router options.
- The short fixture paths in the opening summary and Parts 3.4/4 fallback
  commands (the original plan lines 21, 354, 448 and 450) need the prefix
  `docs/plans/fixtures/`. The Appendix paths already have that prefix; they do
  not need correction.
- The legacy-root contract remains open for the htmx phase: (1) explicit opt-in
  detection, because both legacy and new roots take two arguments `(Content, x)`;
  argument count cannot distinguish a script string from a URL array; (2) the
  exact compatibility string, for example inline `import("<entry>")`; and (3) the
  route marker through `props.head`, because the root renders its own `<body>`.
  Settle ordering relative to the classic htmx script and the layout head's
  deferred data-URL script. Passing a URL array to a legacy inline-script root
  would serialize it as JavaScript rather than load the entry.

## Reproduction and evidence

Synthetic oracle instructions and request format are in
[`fixtures/consumer-shape/README.md`](../../fixtures/consumer-shape/README.md).
The local-only build/snapshot adapter is documented in
[`scripts/consumer-equivalence/README.md`](../../scripts/consumer-equivalence/README.md).
Private snapshots must never be added to this public repository.


The actual private 0.0.27 builds and Workers snapshots yielded:

| Snapshot fact | Router | Admin |
|---|---:|---:|
| Ordered Hono handler/middleware entries | 74 | 95 |
| Method/path pairs, including middleware prefix registrations | 68 | 94 |
| Unique registered paths, including middleware prefixes | 67 | 56 |
| Page renderers | 0 | 51 |
| Distinct registered action IDs | 0 | 111 |
| Method/path/action combinations | 0 | 121 |
| Reviewed response probes | 2 redirects (301, 302) | 2 pages (200), unknown action (404), rendered action (200) |

The schema-3 dispatch matrix uses four private client profiles (same-origin
htmx, plain, non-local and cross-site), explicit service/KV stubs, a fixed test
clock/entropy seed and synthetic KV key material. It records:

| Dispatch fact | Router | Admin |
|---|---:|---:|
| Generated logical cases (methods, two param samples, slash/encoding variants, parents, misses and actions) | 16,856 | 13,760 |
| Ordered middleware/handler/action/render invocations | 69,452 | 38,220 |
| Known action-route cases / action invocations | 0 / 0 | 1,748 / 948 |
| Unknown-action cases | 6,160 | 5,152 |
| Non-Response returns | 237 | 0 |
| Thrown HEAD stream failures | 57 | 0 |
| Baseline-vs-instrumented status checks | 16,856 | 13,760 |
| Rejection responses (403) | 4,214 cross-site | 3,426 non-local |
| Compared normalized HTML digests | 0 | 2,457 |
| Runtime root / layout / head calls | 0 / 0 / 0 | 2,436 / 2,436 / 3,432 |

A router handler can produce a **non-Response return** through root middleware
that does `return await next()`. The shared wrapper classifies this before
reading response fields and records its JavaScript type/object tag plus a
private constructor diagnostic. HEAD can instead throw a RangeError; thrown
errors preserve their messages and nullable statuses. These outcomes are not
successful responses or omitted cases. The synthetic router now reproduces
this exact return chain.

Both packages use the configured Workers compatibility date `2026-02-24`.
Registration diagnostics above audit 0.0.27 and do not constrain future composed
registration. Replay compares actual runtime invocation order, selected headers,
exact non-HTML bytes, normalized HTML digests, statuses and error details using
the baseline's exact logical cases. The README documents every HTML substitution
and the unsigned/signed action URL adapter hook. Intentional differences need
exact case/field entries with a reason; stale or unlisted exceptions fail.

The 112-to-111 source/action difference is an unimported component module with
one action site; it is not reachable from any page. Both ordinary and instrumented
builds succeed, and every compared case is dispatched against both builds in
separate instances of the shared runtime. The four profiles exercise full-page
rendering, auth rejection and CSRF rejection as well as fragment/action dispatch.
Fetch-only service stubs reproduce workerd's native missing-RPC-handler noise;
explicit deterministic RPC failure stubs remove that noise in the verified
profile while preserving application error responses. Stable virtual module
paths and the private test clock/entropy/KV profile make error and nonce bodies
reproducible without stripping non-HTML content.

Empty local bindings, synthetic parameters, test key material and disabled
upstream networking limit business-response coverage. The six diagnostic probes
supplement the compared matrix; they are not production-equivalence evidence.
A fresh independent 0.0.27 replay against the new baseline has zero differences
for all 30,616 logical cases, with zero expected-difference allowances. All
baseline-vs-instrumented status checks pass, and native missing-handler logs are
absent. Private snapshots, logs, bindings and security profiles remain outside
this public repository.
