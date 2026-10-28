# TypeScript htmx transform implementation handoff

Date: 2026-10-27. Base: `cf56726`, `ssttevee/typescript-rewrite-0-1-0`.
Implementation branch: `ssttevee/ts-htmx-transform`.
Worktree: `/Users/steve/.t3/worktrees/farm-plugin-recooler/t3-6767a612`.

## Delivered

`packages/recooler/src/htmx/transform/` implements the pure synchronous
`transform(code, options)` API, exported as `recooler/htmx/transform`. See its
`README.md` and `types.ts` for the integration contract. It returns TSX, a
high-resolution source map, action/handler metadata, and structured diagnostics.
Errors must fail the adapter's build; they return unchanged source rather than
partially transformed code.

Implemented:

- Capability-checked oxc raw transfer with ordinary-transfer fallback, ranged AST,
  and scope-manager analysis. No hand-written scope resolver.
- All action methods, event attribute spellings and `data-` forms, object props,
  computed literal keys, scope factories, mutable captures, function/class capture
  errors, hygienic capture/helper names, explicit `ctx` overrides and nested action
  context frames. Destructured/default/rest props and TS `this` params are covered.
- Separate deterministic action/handler counters matching `ids.rs`: IDs use
  base36; export names use decimal counters; allocation is preorder even though
  nested functions are emitted first.
- Arrow handler lexical `this`/`arguments` errors, action-in-handler errors,
  dynamic-key errors, shadowed-require handling, and module `import.meta` support.
- D3/D5 defaults in two small codegen functions, also exposed as per-call hooks.
  Emission imports `recooler/htmx/runtime`; that subpath has declaration-only
  contracts, without a runtime implementation.
- Server mode removes handler bodies and direct/transitive handler-only imports.
  It also removes private declarations reachable only from handlers, while
  preserving shared/exported declarations and explicit module side effects.
- Client slices walk references breadth first; trim imports/declarators and type
  imports; retain route `onLoad` declarations, aliases and re-exports; warn for
  layout/root `onLoad`; and register their own handlers in the global table.
- Banned raw-specifier checks trace each handler/`onLoad` root through imports,
  static-string `import()` and global `require()`. Pure resolved-graph helpers port
  the package-path and shortest-import-chain behavior of `banned_imports.rs`.
- Magic-string moves preserve original function bodies and props bindings;
  capture references are renamed individually. Maps embed source content and use
  `hires: true`. Trace-mapping tests check exact original line and column for
  retained actions, handlers, renamed captures and untouched code in every mode
  where each entity survives.

All 39 transform test groups and all four banned-import test groups are represented
in `packages/recooler/test/htmx/fixtures/`. There are 79 normalized output/error
expectation files for the transform cases, plus the banned-graph data. The fixture
README records the intentional adaptations. Additional tests execute generated
modules with a stub runtime, exercise the requested gaps, and parse all playground
TSX files in all three modes. No Rust sources or `src/helpers.ts` were modified.

## Verification

Final commands run from the repository root:

```sh
pnpm --filter recooler test
# 9 test files passed; 122 tests passed

pnpm --filter recooler exec tsc --noEmit
# exit 0 (TypeScript 7 package configuration)

pnpm exec tsc --noEmit
# exit 0 (existing root TypeScript configuration)

pnpm --filter recooler build
# exit 0; declarations and JS emitted successfully

pnpm --filter recooler exec node test/htmx/benchmark.mjs
# exit 0; measurements below

git diff --check
# exit 0
```

`pnpm install --reporter=append-only` completed at the repo root using pnpm
12.11.2. Dependencies were already locked; `@jridgewell/trace-mapping` was already
in the base package's devDependencies, so no dependency or lockfile change was
necessary. Checkpoint commits cover parsing/scope analysis, hoisting/maps, and
fixtures/slicing/banned checks; the final commit includes API hardening and docs.
Nothing was pushed.

## D8 measurements

Node v22.22.2, macOS arm64, Apple M1 Pro, raw transfer supported. Each metric uses
2,000 warmups, then the median of seven batches of 500 operations. Units below
are microseconds per module, from the final recorded run:

| Input | Lines / bytes | Parse | Analyze | Parse + analyze | Indexed frontend | Full + map |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Playground home route | 33 / 760 | 38.8 | 32.5 | 67.6 | 130.2 | 217.3 |
| Playground article route | 18 / 569 | 16.3 | 13.9 | 45.3 | 74.6 | 121.6 |
| Manage-multipliers reference input | 42 / 1,542 | 32.9 | 39.2 | 118.9 | 261.3 | 322.6 |

“Analyze” reuses a parsed AST; “parse + analyze” parses afresh and invokes
scope-manager. The indexed frontend also builds reference and parent lookups;
“full + map” includes transformation and high-resolution map generation. Metrics
are timed independently and include JIT/GC/load variation, so columns are not
additive. These are small real TSX inputs, not the plan's 273-line sample, and do
not establish the 400/1,000-route Vite performance gate. The reproduction script
is checked in; measured parser/scope costs should not be inferred from Rust's
37–55 µs transform figure or from the plan's stand-in benchmark.

## Plan differences and integration work

1. D3 removes build-time URL templates. Route parameter encoding, catch-all
   segment handling, mount prefixes and ambient context therefore belong to the
   real `actionUrl` runtime. This transform passes the ID, scope object and
   optional context; it does not implement or validate runtime URL construction.
   `actionScope` query concatenation is similarly delegated behind `actionUrl`.
   The old missing-context build-error fixture now succeeds using ambient context.
2. The plan simultaneously says to preserve props rewriting and to remove
   ctx-prop plumbing. To preserve compatibility, `componentContext` defaults to
   true and keeps the old first-props-parameter override, including rest and
   destructuring rewrites. Setting it to false emits ambient calls without that
   heuristic. Explicit element/object overrides and enclosing action contexts
   remain supported in either configuration.
3. All `ctx` props and spreads remain for the JSX runtime's Context-valued
   intrinsic-attribute filter. The old `omitCtx` fixture is adapted accordingly.
   The filter itself is intentionally not implemented here.
4. Scope-manager's `isValueVariable` is also true for type-only import bindings.
   Emission must additionally inspect `importKind` and `declare` flags; relying
   solely on that scope-manager boolean retains invalid runtime `onLoad` exports.
5. Magic-string removals can erase moved source chunks too. Slicing removes gaps
   around retained moved ranges instead of removing whole enclosing statements.
   Destructured props bindings are moved, avoiding overwrites across nested
   action splits and keeping their mappings.
6. Shared banned dependencies are diagnosed for every affected handler/`onLoad`
   root, rather than only the first root that reaches a shared graph node.

The implementation task is complete at the transform boundary. Remaining work
belongs to the other workers: Vite environment wiring, the real htmx runtime and
registry, resolved bundle-graph provision/checking, lazy client chunk loading,
`onLoad` scheduling, JSX render-time filtering, signing/CSRF, and integrated server
and client bundle source-map checks. Rust-binary differential builds and the
full-app performance/conformance gates were not run in this worktree.
