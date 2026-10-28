# Phase 5 client scripts implementation

Implementation checkpoint: `31f6c27`, branch `ssttevee/ts-client`, based directly
on `ssttevee/ts-htmx-vite` at `98acae9`. No Rust sources or private consumer
sources changed. No branch was pushed.

## Delivery decisions

- The entry has a stable `assets/recooler-client.js` name and a per-build version
  query. The server uses no client manifest. The same surviving static server
  graph produces D5 action reachability and client-slice reachability; client
  generateBundle checks that its consumed table matches the server snapshot.
- Plain Vite uses a post plugin buildApp hook to build the selected server then
  client. Cloudflare keeps its own builder and asset step. Only Recooler's own
  plugins share build state; no global sharedPlugins or builder.buildApp override.
- Every source slice runs the transform directly on original source with one
  MagicString and sourcesContent. It registers its own handler ids. Generated
  entry maps use source-relative identities, with no embedded absolute build paths.
- Legacy roots opt in with `htmx.legacyClientScript: true`; the optional string is
  `import("<entry URL>")`. New roots use external module URLs in props.scripts.
- Function event attributes install a pre-load dispatch stub themselves. It
  retains this/event/capture scope, and replays after all route slices register.
  Replay cannot provide synchronous preventDefault/return-value semantics.
- The entry waits for DOMContentLoaded when necessary, including legacy imports
  during streamed HTML. It replays the queue before calling the owning page's
  onLoad; imported pages' onLoad exports are not called.
- Client initialization supports full-page navigation. Route-changing hx-boost or
  swaps require normal navigation / HX-Redirect. Same-route swaps can use the
  already-loaded static closure. Per-route chunks are public performance units.
- Banned patterns check raw specifiers in handler/onLoad reference chains and
  resolved module paths in every emitted client chunk, including transitive
  side-effect imports. The latter also checks package-relative module-id forms.

## Verification (2026-10-27)

| Check | Result |
| --- | --- |
| `pnpm --filter recooler test` | 45 files, **1,385 passed** |
| `pnpm --filter recooler typecheck` | pass, including JSX consumer declarations |
| `pnpm --filter recooler build` | pass |
| `pnpm --filter recooler-conformance typecheck` | pass |
| `CONFORMANCE_TARGETS=farm-0.0.27,ts pnpm --filter recooler-conformance test` | **1,054 passed, 7 expected skipped** |
| Farm scenario checks | **512 passed**, seven TS-only checks skipped |
| TS scenario checks | **519 passed**, all three client-tagged checks enabled |
| Shared runner/target contracts | **23 passed** |
| `pnpm --filter playground-vite typecheck` | pass |
| `pnpm --filter playground-vite build` | one CLI builds server + client |
| `pnpm --filter playground-vite check` | **2 passed** |

The package suite includes the new client integration on plain Vite, Cloudflare
1.65.0 and Cloudflare 2.0.0-beta.v.5. Each runs one real Vite CLI build followed
by built-app rendering, asset checks, emitted ESM execution in a native module VM
with Happy DOM, captured this/event queue replay, onLoad-only routes, the custom
root meta fallback, parsing timing, chunk isolation and a real dev HMR websocket.
Each emits five client chunks in the integration fixture. Public+entry static
closure excludes admin-only modules; shared code appears once and evaluates once.
All client chunks are checked for server runtime/database markers alongside
positive browser-handler assertions.

The fixture requests a custom client outDir. V1 respects `custom-client` and emits
its Worker under `dist/client_worker`. V2 overrides these to the resolved
`.cloudflare/output/v0/workers/default/assets` and `bundle` directories. Both
built previews serve the server-imported SVG asset, proving Cloudflare's asset
movement/binding survives. Tests read resolved outDirs rather than synthesize them.

Built slice maps resolve a moved handler to its original TSX line and token
column. Dev maps resolve relative source names against the module URL and retain
the edited source content. HMR checks prove both virtual-entry invalidation and
full-reload delivery, then fetch the edited handler slice.

`client-options.mjs` separately rejects a banned raw handler dependency chain,
a banned alias-resolved transitive side effect, and client-first orchestration.
It verifies explicit legacy opt-in, version-query changes across builds, rooted
Vite base URLs, custom-root route metadata, and default-root external scripts.

Dependencies emit their existing easy-jsx source-map warnings and Vite's
inlineDynamicImports deprecation notice. Native VM module tests require Node's
`--experimental-vm-modules` flag; the browser output itself uses ordinary ESM.
