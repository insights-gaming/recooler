# 0.0.27 fixture provenance

`reference.json` contains the source inputs of all **39** tests in
`src/htmx/transform.rs` at base commit `cf56726`. Multiple raw source inputs are
kept as separate cases. The formatted Rust object-props loop is expanded into two
literal TSX inputs. The onLoad export-form test's inline strings are also expanded.
The test harness additionally preserves its negative banned-import and non-route
onLoad assertions.

`output/` holds the corresponding expected output/diagnostic fixtures. Successful
outputs are normalized with Vite's `transformWithOxc` with JSX preserved, stripping
types and stabilizing formatting. `reference.test.ts` checks raw TSX syntax before
normalization and independently checks capture sets and important diagnostics.

The old output cannot be copied literally because the task intentionally changes:

- D3 URL templates become `actionUrl(id, scope, ctx)` calls. Thus the route-encoding
  cases check context emission here; URL construction/encoding belongs to the
  runtime worker. The missing-context test now succeeds with ambient context.
- D5 appends a grouped `registerActions` side effect.
- Captures are renamed hygienically while keeping original scope object keys.
- `ctx` and spreads stay for render-time Context filtering; `omitCtx` disappears.
- Client slices register their own handlers in the global table.
- Full-mode cases also run in server mode, asserting handler exports are absent.

`banned-imports.json` ports all **four** test groups from `src/banned_imports.rs`,
using a plain adjacency map instead of Farm's graph objects. Disconnected modules,
import cycles, query stripping, pnpm paths and Windows paths retain their original
expected results. No Farm cache/export-replay, compiler-host or nested-compile
tests were ported.

The sibling `gaps`, `modes`, `maps`, `execute`, `analysis` and `corpus` tests cover
the requested fixes and the new API. These fixtures are reviewed expectations;
use `pnpm --filter recooler test --update` only when deliberately changing output.
