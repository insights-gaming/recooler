# Vite integration review response

Implemented on `ssttevee/ts-vite` in the existing `t3-ef92e8b8` worktree.
The integration branch at `7cfb095` merged cleanly as `ea1d14f`; all migration
sections and package exports were retained. `pnpm install` reconciled the lockfile.
The post-merge package baseline passed all 795 tests. The Vite implementation
checkpoint is `ff0770f`. No changes were pushed.

## Findings

1. **Vitest and auxiliary environments:** removed eager environment selection.
   By default all server consumers may import the virtual app. The second-round
   fix below enforces an explicit `serverEnvironment` restriction and validates
   that its name exists and is a server consumer. Vitest 5's default runner uses
   `ssr` for these imports: subprocess tests pass with defaults and `ssr`, and
   reject `__vitest__`. Cloudflare v1 Worker names replace `-` with `_`; the Vite
   README documents this.
2. **Custom server environments:** `configEnvironment` adds
   `resolve.noExternal` to every server consumer, including Vite's implicit SSR
   environment. It preserves `noExternal: true` and existing entries. A custom
   `server` build is imported with native Node ESM and serves a real page.
3. **Third-party JSX packages:** vitefu's `crawlFrameworkPkgs` marks packages
   declaring `recooler` or `easy-jsx-html-engine` in dependencies or peer
   dependencies for bundling. The regression uses an npm-shaped `ui-lib` with
   a recooler peer and verifies its custom-server bundle has no external JSX
   runtime imports and returns 200. The Vite README explains the declaration
   requirement and manual `resolve.noExternal` escape hatch. The reviewer's
   original `external-dep.mjs` fixture declares neither the app's `ui-lib`
   dependency nor the library's runtime dependency; it remains external as
   documented. A separate declared-dependency variant of that repro returns
   200 with the engine and wrapper in the app bundle.
4. **JSX settings:** a pre-transform supplies default JSX pragmas per file.
   It checks the nearest tsconfig, solution references, JSONC/extends, nested
   configs, explicit OXC settings, classic/preserved JSX and file pragmas.
   It leaves global OXC settings unset so Vite's legacy esbuild conversion
   retains `jsxImportSource` and `jsxInject`. Other selected runtimes warn.
   Dev transforms and production builds cover these settings.
5. **Dev generation failures:** retain the current error, throw it from virtual
   app loading, and invalidate affected environment module graphs on failure
   and recovery. Watch events are debounced; identical diagnostics log once
   until recovery. Connected clients receive an error overlay; late clients
   and reconnects each receive one serialized error. Recovery reloads clients.
   Regressions cover invalid startup, duplicate layouts, a new route while
   invalid, syntax errors, repair, and export-only edits.
6. **Production builds:** the conformance child receives
   `NODE_ENV=production`, and its Vite build sets `mode: 'production'`.
   Package integration subprocesses likewise use production NODE_ENV and
   explicit production mode, including the CLI. The cache hashes the actual
   production mode/NODE_ENV. Production JSX and the thrown route's SSR map
   are asserted, without absolute development `fileName` metadata.
7. **Relative diagnostics:** parse errors and duplicate-file diagnostics use
   srcDir-relative display IDs. Layout/alias expectations now require the
   specified conflicting layout files, with leading spaces rejecting absolute
   paths. The duplicate-route expectation was corrected for the same change.
   Generator tests explicitly reject the temporary absolute root in errors.
8. **Engine state:** delete `globalThis.SUSPENSE_ROOT` before each TS and Farm
   scenario import. Fresh entry queries also isolate repeated imports. A cache
   regression seeds a stale counter/map and verifies a fresh counter and empty
   map after loading an identical scenario's bundle.
9. **Root scripts:** the custom root reads `props.scripts` inside the returned
   component; its second HOC parameter remains `clientScript?: string`.
   The conformance README and scenario index describe the correct contract.
   Its browser-chunk check remains explicitly tagged as requiring htmx.
10. **Request feature tags:** replaced source/scenario-wide htmx skipping with
    individual `requires: ["htmx"]` tags. Router checks within mixed scenarios
    run; checks whose middleware trace depends on an action registration's
    fall-through remain tagged. All five `q6` checks run and pass. TS gains
    195 passes (193 newly enabled checks plus the two corrected layout
    diagnostic expectations), from 190 to 385.
11. **Cache:** hashes package.json (including exports), production mode and
    NODE_ENV alongside the implementation and existing inputs. Caches use
    implementation/source namespaces. Incompatible namespaces, missing
    scenarios and superseded unreferenced source entries are evicted, while
    identical active scenarios retain shared bytes. Regression checks verify
    reuse, forced rebuild, shared-source retention and eventual eviction.
12. **Documentation:** replaced the migration guide's unimplemented-plugin
    instructions, corrected m14/m15's target-specific diagnostic IDs, removed
    stale failing-result claims, corrected generator output descriptions, and
    documented request tags, production builds and cache eviction. All other
    integration-branch migration sections were retained.
13. **App types:** the virtual app is `Hono<RouteEnv>` using the public
    augmentable `recooler/jsx` interface. Consumer typechecks prove Bindings
    and Variables propagate to app handlers and reject incorrect types.
14. **Windows import paths:** virtual manifest imports use Vite's
    `normalizePath` before emitting the import specifier.

## Verification

- `pnpm --filter recooler test`: **795 passed**, 27 files.
- `pnpm --filter recooler typecheck`: passed, including the consuming JSX/app
  augmentation fixture.
- `pnpm --filter recooler build`: passed.
- `pnpm --filter recooler-conformance typecheck`: passed.
- `CONFORMANCE_TARGETS=farm-0.0.27,ts pnpm --filter recooler-conformance test`:
  **TS 385 passed / 134 skipped / 0 failed**;
  **Farm 512 passed / 7 skipped / 0 failed**.
  With the 23 shared runner/adapter checks, combined totals are
  **920 passed / 141 skipped / 0 failed**.
- Real plain Vite SSR CLI build, virtual-only build, dev HTTP requests,
  route watching and production source maps passed in package tests.
- Cloudflare **1.65.0**: Worker build and dev 200, including auxiliary Workers
  with automatic and explicit environment selection.
- Cloudflare **2.0.0-beta.v.5**: builder completed, Worker bundle contains the
  page, and dev returned 200. Its output lives under `.cloudflare/output/`
  rather than the v1 `dist/<worker>/` layout assumed by the repro's printout.
- Reviewer scripts ran from `/private/tmp/review-vite/scripts`: custom-env,
  external-dep (declaration limitation above), jsx-source (solution/nested/
  pragma/classic fixtures), esbuild-compat, dev-loop, dev-startup-error,
  dev-map, determinism, prod-map, cf-env and cf-env-explicit. Production map
  output reports `jsxDEV in bundle: false` and the expected original route
  position. Determinism reports identical generated manifests and maps;
  emitted bundle comments still vary with source-root location. The modern
  SSR runner maps dev stack frames correctly; legacy `ssrLoadModule` retains
  Vite's transformed-position stack behavior.

Local raw verification artifacts: `/private/tmp/recooler-package-tests.log`,
`/private/tmp/recooler-conformance-final.json`,
`/private/tmp/recooler-review-repros.log`,
`/private/tmp/recooler-dev-loop.log`,
`/private/tmp/recooler-external-declared.log`, and
`/private/tmp/recooler-cf-v2.log`.


## Second-round review resolutions

- The nearest tsconfig now uses the same files matcher as referenced projects.
  Excluded files and files outside `include` receive the recooler JSX default.
  Real Vitest renders both cases, and dev transforms/builds cover each case.
- `serverEnvironment` restricts both virtual app resolution and loading.
  A missing name or a client consumer fails configuration. Tests exercise
  accepted/rejected builds and dev transforms, and positive/negative Vitest runs.
  The README and option JSDoc describe the enforced restriction.
- JSX pragmas come from OXC's comment list, before the first non-directive
  statement. The last valid directive wins. Strings, template literals, prose
  mentioning `@jsx`, late comments and bare factories/fragments do not select
  a runtime. A bare `@jsx` selects classic only with `@jsxRuntime classic`.
- Default pragmas are inserted after a hashbang. LF and CRLF fixtures pass in
  development and production. `react-native` uses the automatic default rather
  than being classified as preserved JSX. The stable `recooler:jsx-defaults`
  plugin name has an ordering comment for Phase 4b's earlier htmx slice transform.
- A shared get-tsconfig filesystem cache, nearest-config lookup cache and project
  cache avoid repeated parsing of references/extends and glob compilation.
  JSON add/change/unlink events and build watch changes clear the caches;
  close hooks remove watcher listeners. Real dev config edits verify fresh
  compiler options and include matchers. Pragma edits use `hires: 'boundary'`.
- Failed generation invalidates the virtual app and its importers without
  requesting an eager runner reload. Requests still throw the diagnostic and
  recovery reloads. The reviewer's `dev-runner.mjs` reports initial/recovered
  200s, the invalid-tree error once, no extra full-reload error, and no unhandled
  rejection. Vite can still log its own reload error for a direct source syntax
  error racing its normal file HMR; this change deduplicates route-generation
  diagnostics without replacing Vite's logger or runner internals.

Second-round verification:

- Package: **796 passed**, 27 files; package typechecks/build and conformance
  typecheck passed.
- Both conformance targets: **TS 385 passed / 134 skipped**, **Farm 512 passed /
  7 skipped**, with **0 failures**. Including shared runner checks: **920 passed /
  141 skipped**, unchanged from the reviewed baseline.
- Reviewer `jsx2.mjs` ran across j1–j12. All affected automatic-runtime cases
  use recooler in dev/build, while explicit hono settings remain hono.
  Existing fixture limitations remain: j1 deliberately preserves JSX, j3 has
  a missing reference rejected by OXC, and j11 imports an unavailable `x` package
  during bundling (its dev runtime and the equivalent standalone regression pass).
- Original `env-select.mjs` allows both server environments by default, rejects
  SSR with explicit `edge`, builds `edge`, and then intentionally exits at the
  new missing-name config error. A copy omitting the missing-name case exercises
  dev too. Custom environment/dependency, startup-error, esbuild conversion,
  source-map, determinism, dev-loop, and Cloudflare repro scripts also ran.
  The undeclared-dependency repro retains its documented externalization limit.
- Reviewer performance scripts: **77 ms / 3,000 files** for the three-reference
  solution, **75 ms / 3,000 files** for the flat config (~0.025 ms/file), and
  **6.6 ms/transform** for the 285 KiB file on this machine.

Raw logs: `/private/tmp/recooler-package-round2.log`,
`/private/tmp/recooler-conformance-round2.json`,
`/private/tmp/recooler-review-round2.log`,
`/private/tmp/recooler-round2-runner.log`,
`/private/tmp/recooler-review-env-dev-round2.log`,
`/private/tmp/recooler-review-cf-selected-round2.log`, and
`/private/tmp/recooler-review-compat-round2.log`.
