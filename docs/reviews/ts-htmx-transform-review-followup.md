# TypeScript htmx transform review follow-up

Date: 2026-10-27. Branch: `ssttevee/ts-htmx-transform`.
Review base: `1ee19c5`; implementation checkpoint: `84f91e2`.
The branch tip contains the final execution regression, verification and report.
No push was made. Rust 0.0.27 remains unchanged.

## Findings

- **B1:** Hoisted action references are independent server roots. They do not
  expand the client closure, and they preserve imports and transitive server
  dependencies even when the containing helper/component is pruned. Covered by
  raw server output and an executed exported action using its retained import.
- **B2:** A reachable client action site now produces `action-in-client-slice`
  naming the handler or `onLoad`, action ID/export and dependency chain. The real
  consumer check below found no occurrences before this decision was committed.
  Valid slices contain no action bodies or server runtime helpers. As with all
  transform errors, diagnostic results contain unchanged input and must be
  rejected by the adapter, never emitted as executable slices.
- **B3:** Only imports with at least one value reference, all in removed client
  code, are pruned. Unused, JSX pragma, metadata-type and side-effect imports
  remain. The old `unused` assertion was corrected.
- **B4:** Identifier props use `props?.ctx`, preserving ambient fallback for
  omitted/null props. Both full and server outputs are executed with nullish
  props. The optional compatibility heuristic remains available across module
  kinds, since the pure transform does not know route parameterization; callers
  can disable it with `componentContext: false`.
- **B5:** Dynamic function-key errors are limited to JSX spread/attribute-value
  objects and objects with existing htmx keys. Ordinary computed function maps
  and iterator implementations remain untouched. Static template keys work.
- **B6:** TS type ancestors, including `TSTypeQuery`, exclude references from
  value captures, server uses and slice/banned-import reachability. Regression
  cases cover data/function queries and `Parameters<typeof db.query>`.
- **M1:** Kept ESTree ordering and documented both ID differences. The oracle
  confirms class body before `extends`, but `do…while` test before body; the
  review's body-first description for the latter was reversed. TS uses extends
  before body and loop body before test. No special cases were added.
- **M2:** Action-bearing object literals consume their explicit `ctx`, including
  nested props. Direct object spreads into components retain it. Raw snapshots
  and execution verify that nested `ctx` does not leak while URL context works.
- **M3:** Local enums are captured as plain data. Execution verifies both action
  and handler serialization, including numeric reverse mappings. Documented.
- **M4:** Handler-only declarations are removed only when safe to evaluate:
  literals, functions, arrows and safe classes. Calls, effectful initializers,
  static blocks/fields, decorators, computed class keys, extends and destructuring
  remain conservatively, along with their dependencies. README and tests updated.
- **Wrapped functions:** Parenthesized, `as` and `satisfies` forms remain supported
  and are documented as an intentional improvement over Rust.
- **T1:** Added raw assertions for dropped db/type imports, exact partial import
  lines, the faunadb/fql closure exclusions, `__recooler_props: RouteProps` and
  `this: unknown`; these run before any lowering can erase evidence.
- **T2:** Added B1–B6 regressions, execution cases and generated large modules.
- **T3:** README explicitly assigns `%40`, `encodeURIComponent(param)`, catch-all
  splitting and `user-id`/`a$b`/`口` URL tests to the runtime phase. No encoding is
  emitted by this transform, so runtime work remains outside this change.
- **T4:** Maps assert embedded `sourcesContent`, exact moved-props/type/source
  literal positions, and the generated import rewrite's original anchor.
- **P1:** Per-base alias counters, binary-searched reference/binding indexes,
  interval ownership and deletion indexes, and graph-based server/client
  reachability replace repeated whole-module scans. Slice reporting visits only
  reachable nodes. Added median ratio tests at 1,000 and 8,000 lines in every mode.
- **P2:** Parse diagnostics use the original oxc label spans, verified against a
  syntax error away from offset zero.
- **Nits:** Arrow actions diagnose lexical `this`/`arguments` like handlers.
  `my_node_modules` remains an ordinary path segment, documented and tested.

## Consumer corpus

The committed generic runner is `scripts/transform-corpus.mjs <dir> [<dir> ...]`.
It uses the built package, reads every `.ts`/`.tsx` module, runs all three modes,
re-parses every output and emits JSON. It never writes into a corpus directory.
External source content and names are not included in this repository.

The two requested source trees contained **226 modules**, yielding **678 mode
transforms**. Diagnostics by kind: one module with an `ignored-onload` warning
in each mode; **zero error modules**, including **zero B2 occurrences**. Every
output re-parsed successfully. Therefore the B2 build error was safe to ship
against this consumer snapshot.

Final measured transform times (parsing output and file I/O excluded):

- Full: **313.97 ms total**, **38.78 ms maximum**.
- Server: **277.43 ms total**, **16.92 ms maximum**.
- Client slice: **239.20 ms total**, **10.99 ms maximum**.
- Combined: **830.60 ms**, global maximum **38.78 ms**.

Detailed external results remain in `/private/tmp/recooler-consumer-final.json`.
The module kind is inferred from index/layout/root filenames; other modules use
component semantics. This is a module transform check, not a bundled app test.

## Scaling

Node 22.22.2, macOS arm64. Five interleaved samples per size, after warming both,
using the committed performance test. Eightfold input growth:

- Full: **15.07 → 119.44 ms**, **7.92x**.
- Server: **13.06 → 111.50 ms**, **8.54x**.
- Client slice: **12.01 → 113.04 ms**, **9.41x**.

All ratios pass the <18x bound (quadratic growth would be 64x). These measure
whole transforms with source maps, captures, imports and handler dependencies.
They are not a Vite build-time gate. The reviewer's 14,402-line benchmark also
completed in **525.8 / 459.4 / 302.1 ms** for full/server/slice during a run with
other verification work active, versus its original reported 17–35 seconds.
Raw timing logs are `/private/tmp/recooler-scaling-final.log` and
`/private/tmp/recooler-perf-final.log`.

## Verification and differential results

- `pnpm --filter recooler test`: **144 tests, 11 files passed**.
- `pnpm --filter recooler exec tsc --noEmit`: passed.
- `pnpm exec tsc --noEmit`: passed (root configuration).
- `pnpm --filter recooler build`: passed.
- `/private/tmp/audit-tests/verify.mjs`: **79 matched, 0 mismatches**. Also reran
  its source-output, fixture-origin and unused-import-elision runners. Source
  runners use Node's `--experimental-transform-types` and their supplied loader.
- Rust oracle rerun with
  `CARGO_TARGET_DIR=/private/tmp/recooler-oracle-target cargo test --lib oracle_dump`:
  **1 passed**, 101 filtered out.
- Reviewer's `runall.mjs` and `cmpslice.mjs` rerun against the rebuilt TS package:
  **50 identical, 19 reported slice differences**, with one Rust panic case
  excluded by the runner. Fifteen differences are redundant function-expression
  parentheses. Four are intentional diagnostics: recognizing wrapped local
  functions, rejecting direct handler actions, rejecting indirectly reached
  actions (B2), and correctly distinguishing shadowed from global `require`.
- ID comparison: **61 matched, 4 differences, 5 skipped**. Differences are direct
  handler action rejection, computed literal-key support, and the two documented
  traversal orders. Capture comparison: **63 matched, 1 difference**, the approved
  local enum capture. Cross-mode metadata check: **132 inputs, 0 differences**.
- All **70 reviewer modules / 210 mode outputs** re-parsed successfully.
- Reviewer's robustness and mapping probes rerun: no transform throws; retained
  capture references resolve to original source positions. Newly generated
  factory bindings are intentionally unmapped.

Detailed comparison/audit logs remain under `/private/tmp/recooler-*`. Remaining
runtime URL encoding, signing, and bundler integration work belongs to the
separate rewrite phases; no requested transform finding remains unresolved.
