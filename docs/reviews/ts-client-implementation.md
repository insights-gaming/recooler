# Phase 5 client scripts: implementation and review fixes

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
