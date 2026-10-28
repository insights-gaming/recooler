# Phase 5 client scripts: implementation and review fixes

**Current design: see the round 4 changes at the end. Earlier gate/replay and
late config/before-request descriptions are historical and superseded there.**

Implemented on `ssttevee/ts-client` in the existing `t3-dd227eee` worktree,
starting at `a8366ee` (Phase 5 based on `ssttevee/ts-htmx-vite` `98acae9`).
No push. The final HEAD is recorded in the implementation handoff.

Checkpoints keep these changes separate from the parallel server/signing fixes:

- `189ad83`: source isolation, matching server inputs, client build entries, bans.
- `95727f1`: navigation initialization, safe replay, preloads, versions and watch.
- `a210156`: inline-map payloads, multiple listeners per queued event, complete
  source-tree input hashing and asynchronous per-build memoization.
- The final test/documentation commit adds the regression suites and this report.

## Per-finding resolution

| Finding | Resolution and evidence |
| --- | --- |
| **1 — Public source maps** | Slice maps blank removed ranges, unused import specifiers and comments, preserving UTF-16 offsets/newlines. Unsliced dependency maps omit embedded contents. Final external **and inline** map payloads are sanitized. Client maps default off and minification on; explicit client environment overrides work. Leak scans now include `.map` assets; an additional test decodes inline maps. Kept handler token positions still map to the original TSX. |
| **2 — Boosts/cross-route swaps** | The entry exports `init()` and preserves entry exports through Vite. It initializes on start, boosted/marker-changing `htmx:afterSettle`, and `htmx:historyRestore`. Both root styles put the route/version marker inside swapped Content. Legacy strings call `import(url).then(m=>m.init())`, including cached imports. Real htmx HTTP tests cover legacy custom roots and modern DefaultRootHOC; the modern test asserts that the old body attribute remains `/` while the swapped meta selects `/b`. |
| **3 — User client entries** | String, array and object inputs are preserved, including default `index.html` and an entry whose key is literally `recooler-client`. Only the internal virtual entry receives the reserved filename. User naming functions/strings continue to apply to other entries. generateBundle asserts the reserved file's facade is Recooler's entry. |
| **4 — Early cancelable events** | The compact stub immediately prevents default. Replay tracks the handler's cancellation separately from the queue's cancellation, preserves descendant request sources/submitters, and resumes confirm, submit and anchor/button defaults. Explicit issueRequest calls suppress automatic continuation. Multiple listeners for one queued event share one default continuation. Config-request/before-request restart via exposed htmx request configuration and ajax. Unsupported cancelable htmx events remain canceled and warn. Current-route modulepreloads are provided in page/props.preloads and rendered by DefaultRootHOC. Real htmx tests cover delayed confirm, submit, link clicks, load-triggered confirm/config/before-request, and the consumer's boosted-body confirm listener. |
| **5 — Replay failure/order** | The owning route's onLoad runs before replay. Each onLoad/handler error is reported independently; subsequent queued handlers still run. Detached elements are skipped. The original replay checker now resolves readiness, runs B, and reports `onLoad-before=true`, including after A throws. |
| **6 — Dev fs boundary** | Both resolution and loading authorize slice identities only from discovered clients or script sources under srcDir. Arbitrary outside `.tsx` slice URLs fail without file contents. Dev loads refresh the server table/input first, preserving HMR edits and redacted maps. The supplied fs scripts show 403 for the ordinary outside URL and rejection for its slice variant (Vite reports the plugin rejection as 500); text/env files remain blocked. |
| **7 — Builtin bans** | Client resolveId observes raw specifiers, including transitive helper imports. Resolved browser-external stubs are always banned. Diagnostics include importer chains. The original helper/map fixtures now stop at `helper.ts → node:crypto`, as intended. |
| **8 — Transform drift** | Slices use the exact source input cached from the selected server transform, including preceding pre-plugins. A second assertion compares slice handler IDs against the server result. The macro fixture now dispatches DELETE_HANDLER and SAVE_HANDLER correctly, with the same shifted IDs. |
| **9 — Attribute size** | Removed the dead direct-call branch. The queue-only stub is about 80 characters; the review fixture reports 131 HTML attribute characters without capture and 144 with capture, down from about 281/294. Dispatch/replay/default-action logic lives in the entry. |
| **10 — Skew/reproducibility** | Replaced randomUUID with deterministic hashing of graph/source-tree inputs, the generated runtime, client settings and package/lock metadata. Source-tree hashing includes browser-only helpers pruned out of the server graph, and those inputs are watched. Identical builds keep the version; route/helper edits change it. The entry embeds its version and reloads/refuses stale page dispatch. Slice filenames contain the version and opaque index, protecting cached entries from overwritten positional slices. |
| **11 — Memoization/disclosure/diagnostics/watch** | A promise memoizes discovery/hash work once per server build, including parallel chunks. Entry slice keys and emitted slice names are opaque; source paths/group names disappear from the entry table. Dev Content includes a missing-entry watchdog; relative bases warn before falling back to `/`. One server watcher orders fresh client builds after server output. Tests add/remove handlers and add/delete whole routes without a stale client map. |

## Verification

| Check | Result |
| --- | --- |
| `pnpm --filter recooler test` | **45 files, 1,389 passed** |
| `pnpm --filter recooler typecheck` | pass, including consumer declarations |
| `pnpm --filter recooler build` | pass |
| `pnpm --filter recooler-conformance typecheck` | pass |
| `CONFORMANCE_TARGETS=farm-0.0.27,ts pnpm --filter recooler-conformance test` | **1,054 passed, 7 expected skips** |
| Plain Vite client CLI/ESM/maps/assets/HMR integration | pass, included in package suite |
| Cloudflare 1.65.0 client integration | pass, included in package suite |
| Cloudflare 2.0.0-beta.v.5 client integration | pass, included in package suite |
| Playground typecheck/build/check | pass; **2 tests**, including a handler on grouped `/admin` |
| Real htmx 2.0.11 + jsdom | pass; delayed defaults/load events, multiple listeners, both root styles, boosts, history event, legacy cached import and error isolation |
| Client security regression | pass; external/inline maps, defaults, reserved user key, HTML input, preloads, macro drift, stale HTML, helper version changes, builtins and fs.allow |
| Client build watch | pass; add/remove handlers and add/delete a whole route |
| Supplied review fixtures/scripts | rerun; details below |

The jsdom harness supplies missing browser primitives (XPath's optional result
argument, CSS.escape for its simple fixture identifiers, scrollIntoView, module
scripts and Node's native dynamic-import callback). It does not replace htmx,
rewrite generated scripts or call handler attribute text by hand. Real htmx owns
listener installation, requests, swaps and inline-script re-execution. Existing
Happy DOM integration still checks native emitted ESM, source maps and HMR.

## Review scratch rerun notes

All original `fx-*.mjs` fixtures and `check-replay.mjs`, `check-boost.mjs`,
`dev-fs.mjs` and `dev-fs2.mjs` were rerun against the final package.

- User/HTML inputs survive and Recooler's entry remains the reserved file.
- The macro, replay, CSS and opaque-entry cases build and behave as expected.
- Both builtin-bearing leak fixtures now fail the raw builtin ban. An isolated
  copy removes only that builtin and explicitly enables client maps: helper SQL,
  component action bodies, route action bodies and route comments are absent
  from JS/maps. Deliberately reachable side effects without a matching configured
  ban remain normal browser dependencies; map redaction does not classify them.
- The original `check-boost.mjs` manually swaps markup and re-imports a cached
  module **without calling init or emitting any htmx lifecycle event**. Its old
  reproduction still prints no B initialization because it omits the new contract.
  A separate scratch copy emits afterSettle and awaits readiness: B's handler and
  onLoad both run. The committed real-htmx tests additionally execute the actual
  new legacy string and modern default-root navigation, with no manual lifecycle
  replacement for boosted swaps.
- Replay reports readiness resolved, B runs after onLoad, and an earlier throw
  does not discard it. Outside-source slice requests do not reveal file contents.

Full local logs: `/private/tmp/rc-package-complete.log`,
`/private/tmp/rc-conformance-complete.log`, `/private/tmp/rc-review-final.log`.

## Merge notes and limits

These commits do not implement or alter the parallel signing namespace/base/hash
fixes or the JSX runtime's untransformed-function rejection. Expect merge overlap
in `src/vite/htmx.ts` around transform caching, dev invalidation and renderChunk;
preserve the exact server source snapshot, raw-specifier observation, asynchronous
per-build memo, version substitutions and ordered client watch rebuild.

Custom roots must render props.preloads to get the preload benefit. Unknown
cancelable htmx events without a continuation or request config remain safely
canceled and warn. currentTarget cannot be reconstructed after dispatch. If CSP
blocks the dev inline watchdog itself, use the browser's CSP diagnostics. Loading
failures reject the latest `globalThis.__recooler_ready` promise. Keep versioned
old slices during rolling deployments and include the entry query in cache keys.


## Integration follow-up (2026-10-28)

Continued the interrupted merge at `4934d9e` in the same worktree/branch.
`83ce40c` completes the merge of `072bf82`; `3100dd6` checkpoints the requested
integration changes. No merge abort or push. The handoff records final HEAD.
This section supersedes the earlier verification counts and merge limitations.

### Merge resolution

- `src/vite/htmx.ts` combines the client build/queue/maps/watch work with
  router-resolved layout/root seeds, shared reverse propagation, active-app-only
  empty dev registration, ungated action transforms, environment/dev namespaces,
  versioned defining-module hashes, targeted table invalidation and safe map skips.
  Both server actions and client slices propagate through the same resolved chains.
- `src/vite/index.ts` keeps client entry/preloads/legacy wiring alongside the
  exact-manifest colon-path loader, action-dependency crawl and namespace wiring.
- `test/vite/vite.test.ts` retains both branches' regression suites. The Phase 4b
  direct renderChunk test now awaits its async hook and supplies the merged hash
  context. Integration found and fixed the root client pattern becoming `/.`.
- Client slices now require the exact cached server-transform input instead of
  falling back to disk. The macro drift test and new alias-layout/root client
  execution test pass. JS/map scans assert that neither the signing namespace
  nor the defining server module hash enters browser output. Client source-map
  redaction, input preservation, early cancellation/replay, fs boundaries, bans,
  deterministic versions, memoization, opaque slices and ordered watch builds
  remain covered by the existing fixes 1–11 suites.

### Requested behavior

1. Initialization observes marker identity, route and version after every settled
   swap, covering HX-Location, plain hx-get + hx-push-url body swaps and boosts.
   Real history back restores handlers/onLoad once despite both lifecycle events.
   In-place marker changes initialize too; stale asynchronous initialization
   cannot clear the queue for another active route.
2. The full real-htmx harness runs on 2.0.11 and 1.9.12, including delayed defaults,
   legacy cached imports, modern roots, route swaps and real history. htmx 1's
   synchronous load trigger precedes wildcard listener installation; that fixture
   uses `load delay:1ms`, now documented, while the 2.x test stays synchronous.
3. Missing, empty or whitespace package names fail both build and dev startup
   unless htmx.namespace is set. The nearest unnamed package cannot borrow a
   named ancestor's identity. Override and named-app replay tests pass. Existing
   test/conformance fixture packages now declare names.
4. Vite base already supplies the required rooted asset prefix; no clientBase API
   is needed. A new Cloudflare build + Miniflare fixture runs front/admin Workers
   with separate assets and a real service binding. Both modern and legacy roots
   fetch their entry, preloads and two routes' lazy slices through `/_admin/` and
   run their own handlers. The front's conflicting entry is never executed.
5. The migration guide documents Workers behind a path-prefix proxy, public
   redacted-only client maps (off by default), provisioning RECOOLER_SECRET,
   CLOUDFLARE_ENV for dev/preview builds, and the unchanged Context result behind
   `return await next()` when an inner handler returns undefined.

### Final verification

| Check | Result |
| --- | --- |
| pnpm install | pass |
| recooler package suite | **48 files, 1,435 passed** |
| recooler typecheck and build | pass |
| conformance typecheck | pass |
| CONFORMANCE_REBUILD=1, targets ts,farm-0.0.27 | **1,054 passed, 7 expected skips** |
| Plain, Cloudflare 1.65.0 and v2 beta client integrations | pass in package suite |
| Real htmx 2.0.11 and 1.9.12 | pass in package suite |
| Two-Worker prefix proxy, modern and legacy roots | pass in package suite |
| Playground typecheck/build/check | pass, 2 tests |
| Client build watch | pass; waits for full server watch cycle before edits |
| Phase 4b warm | default/warmup/manifest-first all 200, complete table |
| Phase 4b cf-colonfix | / and /test both 200 in v1/v2 dev and build/preview |
| Phase 4b strict colon loading without scratch loader | / and /test both 200 in v1/v2 dev |
| Phase 4b samepath and cross-app | own requests 200; replays 404 |

Reviewer scripts were copied from `/private/tmp/r4b/scripts` into
`/private/tmp/ts-client-r4b/scripts`, redirecting only checkout/fixture paths.
Copies of fixtures declare package names under the new contract; the samepath
script assigns distinct A/B names and resets the initial page to A, as in the
Phase 4b implementation rerun. Original review fixtures/scripts remain untouched.
The strict-loader check additionally runs cf.mjs without cf-colonfix's broad
scratch hook. Package tests also exercise strict colon paths on both versions.

Raw local logs: `/private/tmp/ts-client-package.log`,
`/private/tmp/ts-client-conformance.log`, `/private/tmp/ts-client-typecheck.log`,
`/private/tmp/ts-client-htmx1.log`, `/private/tmp/ts-client-htmx2.log`,
`/private/tmp/ts-client-proxy.log`, and `/private/tmp/ts-client-r4b-*.log`.


## Round 2 redesign (2026-10-28)

Continued at `14d9c99` in `/Users/steve/.t3/worktrees/farm-plugin-recooler/t3-dd227eee`,
on `ssttevee/ts-client`. Checkpoints: `8711907` (loading redesign) and `9dce8d1`
(Chromium regression coverage, runtime refinements and conformance fixtures).
`ad1b32e` preserves ready parent handlers during fragment loading, exported readiness,
absolute CDN bases and client onLoad HMR metadata. The final documentation
commit/HEAD is recorded in the handoff. Nothing pushed.

### Route modules and startup

- The selected **server** graph determines the route-to-slice table, as before.
  Each handler-bearing route gets an explicit Rolldown entry named
  `assets/recooler-route-${sha256(route.file).slice(0,20)}.js?v=<contentHash>`.
  The opaque hash is stable across builds; the version changes with source and
  client settings. The server serializes these deterministic URLs alongside its
  existing table, with no client manifest read or server bundle evaluation.
- The general entry remains `assets/recooler-client.js?v=<contentHash>`. Versioned
  opaque slice files are explicit entries too, providing actual preload/retry
  targets even when Rolldown moves implementations into shared chunks. Shared
  imports are deduplicated. The static closure for one route does not fetch or
  evaluate other routes' private slices (D4 remains tested).
- JSX Content starts with a hidden `span[data-recooler-marker]` carrying the
  route pattern and version, followed by static module scripts. DefaultRootHOC
  puts dependency preloads in head; custom/legacy roots get preloads in Content.
  This works even if a legacy root renders only its inline second argument.
  Other extension scripts retain their existing rendering. Custom roots that
  also render props.scripts can emit the same module URL twice; browser module
  identity and runtime job deduplication prevent duplicate registration/onLoad.
- Static route modules import namespaces and register them synchronously, then
  initialize the route. They execute after the full stream parses and before
  DOMContentLoaded/htmx startup. Initial load has no queue. A legacy dynamic
  import during parsing waits for parsing; an already-started lazy job cannot
  delay static registration or cause onLoad to run twice.
- A shared runtime tolerates the queried entry plus its unqueried static import.
  Initialization scans **all** Content markers, never a body attribute or meta.
  Work is keyed by marker identity and route/version signature. New fragment
  markers run their own route onLoad once, matching the former inline script.
  Existing markers do not rerun. New same-route body content and history cache
  restoration do rerun. Stale async jobs cannot initialize another route's DOM.
  Function ownership tracks the opaque slice-to-route relation, so ready parent
  handlers continue to work while another fragment loads or fails.
  Sync onLoad effects precede first htmx processing; async onLoad completion is
  awaited before deferred confirm handlers. Root/layout onLoad stays ignored.

### Swap-window policy

`init()` runs afterSwap, afterSettle and historyRestore, and remains callable
explicitly (including by the legacy cached import shim).

Only `htmx:confirm` is canceled/deferred. Handlers for one original event share
its public `detail.issueRequest(true)` continuation after onLoad. A handler's
preventDefault suppresses automatic continuation; an explicit issueRequest call
also suppresses automatic continuation. Detached elements are skipped. Handler
and onLoad failures are isolated and reported.

`htmx:configRequest` and `htmx:beforeRequest` run late, without canceling the
original event or issuing another request. Their configuration changes may arrive
after the request has already used the data; preventDefault cannot cancel it.
Neither has a public continuation that safely resumes the original request.

**All other early events are dropped.** Their native/htmx defaults are untouched.
This includes click, submit, checkbox, keydown, paste, drop, response, swap and
settle callbacks. Development warns about dropped handlers, except htmx:load.
Dropping avoids stale lifecycle callbacks and cancellation-dependent side effects;
there is no claim that arbitrary callbacks are harmless to invoke late. Once the
marker initializes, handlers receive the original event normally. There is no
click/requestSubmit redispatch, htmx.ajax reconstruction, or generic event replay.
htmx itself can ignore native defaultPrevented; Recooler adds no second request.

### Per-finding resolution

| Round 2 finding | Resolution / evidence |
| --- | --- |
| Critical replay duplicates and body loop | Removed all generic cancellation/reissue. Static first-load modules restore ordering. Chromium covers hx-post, boosted form/link, preventDefault submit, response callbacks and body lifecycle handlers with delayed destination assets. Each action has one request. Both supplied settle-loop versions report exactly one GET /b at 2 and 3 seconds for after-settle, after-request, after-swap and load. |
| htmx 1 history loses leading meta / stale body fallback | Replaced meta with a hidden span; removed body fallback. Chromium A→B→C→Back for legacy and default roots on both htmx versions yields b:b, c:c, b:b and no B refetch. Supplied modern history output is `a b c | back b` on both. |
| Failed import wedges dispatch / unhandled rejections | Failed promises are evicted. One retry uses a fresh module URL because native import caches rejected URLs. A second failure attempts one sessionStorage-guarded reload per client version, then reports a console error. Later init can retry. Readiness settles after reporting; all public/internal jobs observe failures. Chromium covers transient recovery, persistent failure guard, zero unhandled rejections, and usable handlers after recovery. The supplied failure script leaves link and submit defaults uncanceled. An extended copy waits for recovery and asserts nextClickAfterReady=1 with unhandled=0 on both versions. The click that triggers recovery is deliberately dropped, never replayed. |
| Cross-route fragment fails to load handlers | Every marker participates. The fragment's own onLoad runs once per inserted marker, followed by usable handlers. Supplied init attack reports loadsEdit=1 and clickSave=1 on both versions; Chromium asserts two markers and deduplication. |
| Unrelated SPA edits trigger client full reload | hotUpdate returns immediately for empty context.modules. Client invalidation/reload happens only if the client table changes, including route onLoad metadata. Server graph edits still reload the SSR runner, preserving the Phase 4b edit matrix. New HMR regression and original reviewer script show update-only frames for CSS and TypeScript. |
| Native defaults silently canceled | No native event is canceled in a loading window. Chromium checks checkbox toggle, typed input, paste/drop cancellation state and request owners during a delayed swap. |
| hx-on::load warning noise | No continuation warning machinery exists. Dropped htmx:load deliberately emits no dev warning. Browser production fixtures assert no warnings. All supplied loop variants report zero warnings. |
| minify:false comment disclosure | All source comments are removed from client slices before bundling, including dropped-function JSDoc and /*! comments. JS, external maps and decoded inline maps are leak-scanned with minify:false. UTF-16 mappings of retained handlers remain tested. |
| Relative Vite base falls back to / | Relative/empty bases now fail configuration. Regression covers './', '' and 'relative/'. Absolute CDN bases remain supported. Rooted /_admin/ still passes the real two-Worker proxy fixture. |
| Persistent version mismatch reload loop | sessionStorage flag is keyed by HTML/client version pair. At most one reload per pair; further mismatch reports an error, refuses handler dispatch and prevents confirms so guarded requests fail closed. Non-confirm defaults are untouched. If storage is unavailable, automatic reload is disabled. Chromium serves persistently stale HTML and asserts exactly two document requests total. |

Round 1 and Phase 4b protections remain: redacted external/inline maps; user entries;
onLoad before deferred confirm; dev fs boundary; builtin bans; exact server source
input and handler IDs; compact attributes; reproducible versions; opaque keys;
rooted base prefix and absolute CDN URLs; exported entry readiness; namespace/signing and strict colon loaders; server edit matrix.

### Verification and reviewer scripts

- Package suite: **48 files, 1,436 passed**, including plain Vite, Cloudflare
  1.65.0 and 2.0.0-beta.v.5 client integrations and the /_admin two-Worker service
  binding proxy with modern/legacy roots.
- Package typecheck (including consumer declarations) and build: pass.
- Conformance typecheck: pass. Both `farm-0.0.27,ts` targets: **1,054 passed,
  7 expected skips**. The first run rebuilt all fixtures; the final pass includes the strict
  root-scripts span assertion and the final runtime.
- Playground typecheck/build/check: pass, 2 tests.
- Chromium **156.0.8078.4**, Playwright **1.64.1**, htmx **1.9.12 / 2.0.11**:
  both root styles pass initial module-before-DCL and first-process checks,
  blocked initial assets holding DCL, real streamed Suspense, all request-owner
  attacks, body events, native defaults during swaps, history, HX-Location,
  push-url, fragment onLoad, import retry and persistent reload guards.
  Playwright is a package devDependency; install Chromium before package tests
  with `pnpm --filter recooler exec playwright install chromium`.
- Original init, hist, hist-modern, replay and failure scripts, plus all four
  settle-loop event variants: exit 0 on both versions. Original hmr.mjs sends
  only update frames. These jsdom scripts cannot validate static module timing
  and their old meta diagnostics are obsolete; Chromium validates the new contract.
- Original skew.mjs assumes a meta marker and stops at that obsolete selector.
  Selector-only copies under /private/tmp/rc-review2-compat use the span marker;
  both refuse mixed-version dispatch. Chromium additionally verifies real reload
  behavior, which jsdom does not implement. Original reviewer files are untouched.

Logs: `/private/tmp/rc-package-r2-final.log`,
`/private/tmp/rc-conformance-r2-final.log`, `/private/tmp/rc-typecheck-r2-final.log`,
`/private/tmp/rc-build-r2-final.log`, `/private/tmp/rc-conformance-typecheck-r2.log`,
`/private/tmp/rc-playground-r2.log`, `/private/tmp/rc-chromium1.log`,
`/private/tmp/rc-chromium2-final.log`, `/private/tmp/rc-attacks-{1,2}.log`,
`/private/tmp/rc-hmr-review.log`, `/private/tmp/rc-skew-{1,2}.log` and
`/private/tmp/rc-failure-recovered-{1,2}.log`.

## Round 3 implementation (2026-10-28)

Worktree `/Users/steve/.t3/worktrees/farm-plugin-recooler/t3-dd227eee`, branch
`ssttevee/ts-client`, continued from `a31bf6b`. Implementation checkpoint:
`10c64d5`; asserting Chromium tests, migration notes and proxy coverage:
`122ee54`. The documentation-only commit following those checkpoints is the
handoff HEAD. Nothing pushed.

### Early registration design

Content emits a classic, parser-blocking **external** `assets/recooler-gate.js`
first, followed by both `<script type="module" async src=X>` and
`<script type="module" src=X>` for the entry and current route. The identical URLs
share browser module identity; async evaluation registers slices while Suspense
is streaming, while deferred modules still hold DOMContentLoaded. Modulepreloads
remain. This applies to legacy roots as well as default/modern roots, without
requiring them to render props.scripts themselves.

A separately emitted external gate is deliberate: an async entry alone cannot
protect a chunk that htmx.process sees before the entry fetch finishes. The gate
requires no new inline script. Its capture listener also defers confirm dispatch
by one microtask, because htmx 1.9.12 can emit a synchronous load confirm before
installing the element's hx-on listener. After dispatch it uses only htmx's public
issueRequest continuation; no native event or request is reconstructed. Pending
confirm/config/before-request dispatch is handed to the entry when it arrives.
The gate is served by Vite in development and emitted with client assets for
production, including the /_admin proxy and absolute-base paths.

Handler availability is now simply registration in $handlers, independent of
route marker completion. Route onLoad runs at DOMContentLoaded or immediately
when readyState is not loading, and its promise is never awaited. Synchronous
throws and rejected promises go to reportError (console fallback where absent).
Readiness includes invocation, not async completion. Root/layout onLoad stays
ignored. Only client-bearing routes get a trailing template marker.

### Findings and Chromium evidence

1. **Body/layout callbacks:** registered root/layout slices remain runnable
   throughout body boosts. On both htmx versions, the original body attack now
   records exactly five before-swap, after-swap, after-settle and config callbacks
   over five boosts, with and without destination onLoad; all five token headers
   are present. With 300 ms destination asset latency, the first boost records
   afterSwap=1 and afterSettle=1 and increases bodyLoads. The existing package
   Chromium test now asserts bodySwaps=3, bodySettles=3, and exactly eight root
   confirm callbacks for the boost and seven destination requests.
2. **Async onLoad:** a click during the 1.5 s callback runs and a non-boosted
   guarded link makes zero requests. Package Chromium coverage also asserts that
   never-resolving onLoad neither blocks readiness nor disables handlers, and a
   rejected callback reaches reportError while clicks remain usable.
3. **Consumer Suspense:** with `.forEach(htmx.process)`, both root styles and
   htmx 1.9.12/2.0.11 pass. The package tests add 450 ms asset latency, leave the
   external gate available, assert zero gated load requests before the async
   modules arrive, then click successfully while the stream is still open.
   onLoad is still zero at that point, runs exactly once after parsing, and sees
   the final streamed element. Original unmodified round 3 attacks also report
   susClicks=1 before DCL, susConfirms=1, susPostConfirms=1, zero gated requests,
   then two clicks and one onLoad after stream completion. Modern-root confirms
   no longer bypass the gate.
4. **Native guard window:** retained the decision to drop unavailable ordinary
   events without changing defaults. Migration guidance explicitly covers
   non-boosted links/forms, href="#", key/paste/drop guards and htmx:confirm.
   Every dropped event warns in development, including load. All three dev
   integration targets assert that the served external gate warns for a missing
   click handler while leaving preventDefault untouched. Chromium asserts the
   documented native-link/form exposure during a deliberately blocked swap.
5. **Config/before-request spelling:** both camel and kebab spellings are
   recognized. Original attacks report one of each late callback after release,
   then two of each after another ready interaction, with one request per action.
   Both package Chromium scripts now assert callback counters, not just requests.
6. **Marker/table/history:** handler-free routes emit no marker. The template
   marker trails client-bearing Content. Both versions insert both handler-free
   tr rows intact. Package Chromium covers A→B→C→Back, same-route reswaps and
   cross-route fragments for both roots. Original init reports loadsEdit=1,
   clickSave=1, and same-route onLoad delta=1; original hist/hist-modern keep B's
   DOM and onLoad on back navigation on both versions.
7. **Guessable route names:** documented the hash of route.file and that public
   client chunks are not a confidentiality boundary. No naming change.

Every scenario in `/private/tmp/rc-review3/chromium-attack.mjs` is represented
with assertions in `packages/recooler/test/vite/client-streaming.mjs`, run for
both htmx versions and both root styles. The older `client-htmx.mjs` retains
request-owner, native-default, startup, history, fragment, retry, version mismatch,
HX-Location and push-url checks. No test relies only on printing counters.

### Verification

- Full package suite: **48 files, 1,440 passed**. The subsequently added
  Cloudflare v2 /_admin test also passes through Vitest (1 pass, other tests
  intentionally filtered). The matrix includes plain Vite, Cloudflare 1.65.0 and
  2.0.0-beta.v.5, and both-root /_admin two-Worker service-binding tests with
  explicit gate asset content-type/path assertions. All four Chromium combinations
  pass their complete scenario assertions.
- Package typecheck (including consumer declarations), build, conformance
  typecheck, and playground typecheck/build/check pass (2 playground tests).
- Both conformance targets: **1,054 passed, 7 expected skips**.
- All original round 3 Chromium attacks complete on both htmx versions.
- Original round 2 init, hist, hist-modern, failure and all four settle-loop
  variants complete on both versions. Each loop makes exactly one GET /b at
  both 2 and 3 seconds. Failure deliberately logs failed imports and jsdom's
  unimplemented document navigation; browser recovery/reload assertions pass.
- Original replay times out because it gates every asset, including the new
  blocking gate, then waits for parsing before releasing assets. Original skew
  selects the removed meta marker. Compatibility copies in
  `/private/tmp/rc-review3-round2-compat` change only those harness assumptions:
  exclude recooler-gate.js from the intentional module block and select the
  template marker. Replay then completes all loaded/early cases without duplicate
  requests; skew refuses mixed-version handlers on both versions. Original
  reviewer files are unchanged.

Logs: `/private/tmp/rc-r3-package-verified.log`,
`/private/tmp/rc-r3-admin-beta-vitest.log`, `/private/tmp/rc-r3-admin-beta.log`,
`/private/tmp/rc-r3-conformance.log`, `/private/tmp/rc-r3-typecheck.log`,
`/private/tmp/rc-r3-build-final.log`,
`/private/tmp/rc-r3-conformance-typecheck.log`,
`/private/tmp/rc-r3-playground-{typecheck,build,check}.log`,
`/private/tmp/rc-r3-attacks-{1,2}.log`,
`/private/tmp/rc-r3-chromium1-final.log`,
`/private/tmp/rc-r3-r2-{init,hist,hist-modern,replay,failure,skew}-{1,2}.log`,
`/private/tmp/rc-r3-r2-settle-{after-settle,after-request,after-swap,load}-{1,2}.log`
and `/private/tmp/rc-r3-r2-compat-{replay,skew}-{1,2}.log`.


## Round 4: inline confirms and fragment parsing

Implementation checkpoint: `6d936f8`; regression/compact-fallback checkpoint:
`e21444c`. The final HEAD is recorded in the handoff. No push.

1. **Native hx-confirm and ajax promises:** removed the document-wide confirm
   listener. Only an unavailable recooler confirm listener holds a request; ready
   listeners run synchronously. Automatic continuation uses `issueRequest()` with
   no argument, preserving native prompts. Handler-free and client-bearing controls
   cover button POST, form POST and boosted-link dialog accept/dismiss, plus
   `htmx.ajax().then()` observing the completed swap, on htmx 1.9.12 and 2.0.11.
2. **Blocking gate:** removed its HTML tag, development middleware, emitted asset
   and version-hash dependency. Generated attributes call `(self.$rc||fallback)`.
   The fallback only prevents confirms and queues the listener's arguments/event
   (whose detail owns issueRequest) in `self.$rq`. Everything else drops without
   canceling defaults; development warns. Full pages retain early async and
   identical deferred module URLs. Fragment requests only receive trailing modules.
   Tests hold every module while verifying content parsing and assert zero gate
   fetches across four boosts.
3. **Lost held confirms:** queue draining always calls the deferred dispatch path,
   even when static slices registered before the entry wrapper. Both module load
   orders, concurrent pending confirms, allow/cancel, deferred native prompt
   acceptance/dismissal and subsequent ready acceptance have real Chromium assertions.
4. **htmx 1 table rows:** non-boosted HX-Request responses put modules after the
   rows and omit preload links. Links would otherwise be foster-parented ahead of
   the parser's table and defeat htmx 1's depth-based fragment extraction. Tests
   assert two intact rows, the nested button, its working handler and row onLoad,
   alongside handler-free controls, on both htmx versions.
5. **htmx 1 cold load ordering:** documented the upstream issue (also in 0.0.27).
   Removing the gate alone cannot protect streamed load guards before the async
   entry arrives: htmx 1 has not installed their wildcard listeners yet. Generated
   confirms rendered by the `recooler/jsx` runtime therefore also emit a legacy hx-on alias evaluating the canonical
   attribute. htmx 1 installs it before load requests, then replaces it during
   normal processing; htmx 2 ignores it. This additionally protects generated cold
   boost guards. Consumers retaining `jsxImportSource: easy-jsx-html-engine` lack
   the alias (the plugin warns), so their generated load guards remain unprotected
   until normal htmx 1 listener installation, as in 0.0.27. Raw string wildcard
   guards retain htmx 1's upstream limitation.

Every round 4 scenario is an asserting package Chromium regression in
`test/vite/client-confirm.mjs`: native dialogs, ajax promise ordering, six pending
load variants, gate cost, module evaluation/registration/onLoad across boosts and
history, markers/table rows, and cold boosts. The prior `client-streaming.mjs`
matrix still covers both htmx versions and root styles, including consumer Suspense
processing with slow assets. Unavailable config/before-request assertions now
expect drops, as required by the new event policy.


At the round 4 checkpoint, inline size (UTF-8, handler ID `routes/index.tsx@0`, no captured scope): the
production dispatch/fallback expression is **96 bytes**, and the full decoded
hx-on attribute value is **134 bytes** (**183 bytes** for the HTML attribute,
including its leading space, name, quotes and escaping). Development is
**169/207 bytes** (**264 bytes** for the HTML attribute), including
the dropped-event warning. A generated confirm adds a **54-byte** legacy hx-on
value (**73 bytes** as an HTML attribute including its leading space and escaped
quotes). Handler IDs and serialized scope add their actual lengths. Non-confirm
attributes do not receive the compatibility alias.


Round 4 production attribute value (superseded by round 5 cancellation tracking):

```js
(self.$rc||((...a)=>a[3].type=="htmx:confirm"&&(a[3].preventDefault(),(self.$rq??=[]).push(a))))("routes/index.tsx@0",null,this,event)
```

Final validation at `e21444c`:

- `pnpm --filter recooler test`: **1,443 passed**, 48 files. Includes all four
  htmx/root streaming combinations, native dialogs and deferred load orders,
  Cloudflare v1/v2 build/dev/HMR and both `/_admin` service-binding versions.
- Package typecheck (including JSX consumer types) and package build passed.
- `CONFORMANCE_TARGETS=farm-0.0.27,ts pnpm --filter recooler-conformance test`:
  **1,054 passed, 7 skipped**, three files.
- Playground build, two application/leak tests and typecheck passed.
- Unchanged round 3 Chromium attacks completed on both htmx versions; inspected
  streamed confirms, body lifecycle/token counts, history, retry bounds and drops.
  The asserting package matrix also passed. Unchanged round 4 attacks completed
  on both versions with **zero reported failures**.
- Every round 2 attack variant reran for both versions, with init preceding its
  dependent history script: **18/20 completed**. Both original `skew.mjs` runs
  stop at their obsolete `meta[name="recooler-route"]` selector; the existing
  round 3 template-marker-compatible copies passed for both versions. The package
  Chromium version-mismatch/reload assertions passed as well.

Attack logs: `/private/tmp/rc-round4-final-attacks/` and
`/private/tmp/rc-round4-final-r2/`. Package/conformance logs:
`/private/tmp/rc-package-final.log`, `/private/tmp/rc-conformance-final.log`.


## Round 5: confirm cancellation and fallback coverage

- Persistent version mismatch cancels confirms before returning, including after
  the single guarded reload. The regression asserts two document requests, zero
  guarded POSTs/handler calls, and an unchanged checkbox default.
- Runtime and inline fallback share one per-event hold. Already-canceled confirms
  are skipped; a wrapped event `preventDefault()` records subsequent external
  cancellations. Drain checks this state after loading and before continuation.
  Chromium covers document guards, the documented SweetAlert continuation pattern,
  inner and outer raw string guards, and capture guards in ready, streamed fallback,
  streamed runtime, warm-boost and cold-boost windows on htmx 1 and 2.
- Native-default regressions wait for actual htmx onHandlers on streamed/swapped
  controls with modules held. Checkbox toggles and native link/form requests prove
  the unavailable-handler path does not cancel defaults. Stale loading variant
  names have been replaced. The cancel-everything mutation must fail on both versions.
- The legacy alias requires `recooler/jsx`; retaining the upstream JSX runtime
  retains htmx 1's generated load-guard exposure. Documentation now states this.
- Total runtime load failure remains a documented limitation: fallback-held confirms
  stay blocked, with no recooler retry/reload/reporter available. Restore assets and
  refresh. Slice recovery still requires a loaded runtime. Cancellation through a
  cached/prototype original preventDefault or returnValue after a hold bypasses
  tracking; this limitation is documented precisely.
  The production dispatch/fallback expression is now 313 UTF-8 bytes (351 bytes
  for the decoded attribute with `routes/index.tsx@0` and no scope); development
  is 386/424 bytes. The round 4 size/example above are historical.
- Plan §3.4 and D4 now describe static per-route modules, dual startup emission,
  trailing template markers, confirm-only holding, recovery, source-map redaction
  and proxy base support, with superseded queue/replay text removed.

Round 5 verification:

- Package suite: **48 files, 1,443 passed**, including Cloudflare v1/v2
  build/dev/HMR and both `/_admin` service-binding versions. Package typecheck
  (including JSX consumer), package build and conformance typecheck passed.
- Both conformance targets (`farm-0.0.27,ts`): **1,054 passed, 7 skipped**.
- Playground typecheck/build and both application/leak tests passed.
- Unmodified round 4 `attack.mjs` and corrected round 5 `attack5b.mjs`:
  **zero reported failures** on htmx 1 and 2. Persistent skew now records two
  document requests and zero guarded POSTs. Competing cancellations remain closed
  in every loading window; normal allowing continuations still issue requests.
- Unmodified `attack5.mjs` ran on both versions. Its skew regression is fixed.
  Four pre-existing harness failures remain per version: `entry-500`/`route-500`
  expect no requests although the alternate graph path loads the runtime and
  allowing handlers execute; `multi`'s two initial-load windows click before htmx
  has processed the controls (deferred modules hold DOMContentLoaded), so no
  confirms/handlers run. These are also present in its saved pre-fix output;
  corrected `attack5b.mjs` exercises processed streamed controls and passes.
- The reviewer's `mutate.sh` ran against fresh compiled code with the production
  fallback's confirm-only condition replaced by `true`. **Both versions reject
  the mutation at the checkbox assertion (`false !== true`)** in
  `native-fallback`, after asserting actual htmx listener installation. Pending
  navigation rejections are observed so teardown cannot obscure that assertion.

Logs: `/private/tmp/rc-fix-package.log`, `/private/tmp/rc-fix-typecheck.log`,
`/private/tmp/rc-fix-build.log`, `/private/tmp/rc-fix-conformance.log`,
`/private/tmp/rc-fix-conformance-types.log`,
`/private/tmp/rc-fix-playground-{types,build,check}.log`,
`/private/tmp/rc-fix-attacks/`,
`/private/tmp/rc-review5/mut-cancel-everything-{1,2}.out`.
