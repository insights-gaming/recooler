# TypeScript htmx transform second review follow-up

Date: 2026-10-27. Branch: `ssttevee/ts-htmx-transform`.
Review base: `c36470d`; implementation checkpoint: `cfb1864`.
The final report checkpoint contains this document and the completed verification.
No push was made. No consumer files were modified or committed.

## Resolutions

1. **Client aliases and containers:** server pruning now treats identifiers,
   static-key object literals, arrays without spreads, templates with safe
   expressions, and static import-namespace property access as removable when
   used exclusively by client code. Safe nested values are handled recursively.
   Spreads, dynamic keys, getters, calls, ordinary property access and other
   possibly effectful initializers remain server roots. The reviewer's `a1.tsx`
   drops both browser imports in server mode; full and slice imports stay.
2. **Wrapped dynamic keys:** the htmx-position search follows parentheses, `as`,
   `satisfies`, non-null/type-assertion wrappers and conditional/logical branches.
   Regression cases reject dynamic function keys through nested combinations in
   every mode, preventing unhoisted function values from reaching HTML output.
3. **Qualified import aliases:** runtime `TSImportEqualsDeclaration` name chains
   are excluded from type-only ancestry filtering. Slices retain the namespace,
   and banned-import diagnostics again report `_handler$0 → X → ns`. An executed
   slice verifies a multi-level alias resolves; type queries still create no
   runtime dependencies.
4. **Computed-key scope:** JSX position errors apply only to intrinsic lowercase
   elements. Explicit `hx-`/`data-hx-` keys still establish htmx intent anywhere.
   Component prop maps, including wrapped/conditional forms, pass. The former
   broad regression now asserts both sides of this boundary.
5. **Deep reachability:** each BFS path stores its name and parent pointer;
   diagnostic strings reconstruct the path only when reporting. BFS shortest
   paths and source-order ties are unchanged. A new median ratio test grows both
   handler count and chain depth from 250 to 2,000: **15.22 → 852.05 ms, 55.98x**,
   below the 100x bound for 64x graph work. Copying full paths adds a third growth
   factor (512x). The reviewer's original 2,000-by-2,000 case took 24.8 seconds.
6. **Server onLoad:** shared export detection covers function declarations,
   variable declarations and named local/re-export forms, plus namespace
   re-exports. Route server output removes the runtime export and its private
   client-only closure. Other exports, shared server dependencies and initializer
   effects remain. Tests exercise all three forms, partial declarations/exports,
   shared bindings and effectful initializers. Execution verifies throwing
   browser-only imports are never evaluated by the server. Full/slice behavior
   and root/layout warning spans remain unchanged.

## Verification

- `pnpm --filter recooler test`: **154 tests, 11 files passed**.
- `pnpm --filter recooler typecheck`: passed.
- `pnpm exec tsc --noEmit`: root configuration passed.
- `pnpm --filter recooler build`: passed.
- Performance tests with verbose output: **4 passed**. Eightfold ordinary-module
  growth measured **8.99x / 9.59x / 9.59x** for full/server/slice (bound <18x).
  The depth case passed at **55.98x** (bound <100x).
- `/private/tmp/audit-tests/verify.mjs`: **79 matched, 0 mismatches**. Also reran
  source-output, fixture-origin and unused-import-lowering audit probes.
- Rust oracle: `CARGO_TARGET_DIR=/private/tmp/recooler-oracle-target cargo test
  --lib oracle_dump` in `/private/tmp/rust-ref`: **1 passed**, 101 filtered out.
- Reviewer's `/private/tmp/rr/runall.mjs` and comparisons rerun against the rebuilt
  package. Slice: **50 identical, 19 differences**; IDs: **61 identical, 4
  differences, 5 skipped**; captures: **63 identical, 1 difference**. All three
  comparison logs are byte-for-byte identical to the prior final logs. Those
  existing differences remain documented in the first follow-up: redundant
  parentheses, approved diagnostics, static computed-key support, traversal order
  and enum captures. No new oracle differences appeared.
- Cross-mode metadata: **132 inputs, 0 differences**. All **79 reviewer modules /
  237 mode outputs** (including the nine round-two repros) re-parsed successfully.
  Robustness probes produced no throws. Source-map probes were also rerun.

Detailed external logs are `/private/tmp/recooler-rr3-{tests,scaling,audit,
cmpslice,cmpids,cmpcap,ids,review-probes,rust-oracle}.log`.

## Consumer corpus delta

Reran `scripts/transform-corpus.mjs` against the requested consumer's
`packages/{admin,router}/src`: **226 modules, 678 transforms**. Compared diagnostics
and parse results with `/private/tmp/rr2/corpus.json`, and output code with the
saved pre-change compiled transform from the same review checkpoint.

- Diagnostics are identical: **one `ignored-onload` warning per mode**, **zero
  error modules**, **zero action-in-client-slice diagnostics**.
- **Zero parse failures**, and no parse-result changes.
- **Zero full-output changes**, **zero client-slice changes**, **zero metadata
  changes**.
- Exactly **two server outputs changed**, both explained entirely by dropping
  route `onLoad` and its private dependency closure. One loses a DOM update helper
  and its three value imports (retaining the metadata type import); the other
  loses four private helpers and the browser-only stream-transform import.
- Consumer git status remains clean. Corpus sources were only read.

Transform times (excluding output parsing and file I/O): full **298.24 ms**,
server **267.77 ms**, slice **228.44 ms**; combined **794.45 ms**.
Detailed results: `/private/tmp/recooler-rr3-corpus.json`; comparison:
`/private/tmp/recooler-rr3-corpus-delta.json`. Source/output details remain outside
this repository.
