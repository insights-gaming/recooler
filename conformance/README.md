# Recooler conformance

The checked-in source trees and JSON expectations test the published **farm-plugin-recooler 0.0.27** through **Farm 1.7.11**. They are independent of the Rust checkout and the future TypeScript adapter. [SCENARIOS.md](SCENARIOS.md) indexes every runnable scenario and its provenance.

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

`ts` skips while the built `recooler/router` module or its `createApp` export is absent. Once it exists, the stub fails with an explicit instruction to implement the adapter. It never substitutes the Farm adapter for the TypeScript implementation.

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
      "method": "POST",
      "action": { "page": "/protected", "attribute": "hx-post", "index": 0 },
      "headers": { "HX-Request": "true" },
      "form": { "name": "Ada" },
      "expect": { "status": 200, "body": "hello Ada", "trace": ["guard"] },
      "changes": [{ "decision": "D6", "reason": "The target may sign every rendered URL." }]
    }
  ]
}
```

Assertions support exact `body`, `includes`, `excludes`, regex `matches`, regex occurrence `counts`, selected `headers` (null means absent), and ordered `trace`. Every request specifies a status. A build-error scenario replaces `requests` with `"buildError": "diagnostic substring"`, or an array of required substrings.

Action requests resolve URLs from rendered `hx-*` or `data-hx-*` attributes, including HTML entity decoding and relative resolution against the rendered page. `action.headers` authenticates the render request; the outer `headers` authenticates the action request. `action.response` reads a previously named response instead, for nested forms returned in fragments. A missing attribute or unsuccessful render fails the test. Known-invalid `?action=` probes deliberately specify the unknown query value directly.

`mount: { "type": "route" | "basePath" | "mount", "prefix": "/app" }` exercises Hono mounts; `repeat: 2` re-dispatches the **same Request object**. These repeat probes use requests without consumed bodies. Multi-step scenarios execute in file order.

The recovered middleware records ordered entries in `globalThis.__t`. The common harness resets it for each top-level dispatch and publishes the collected trace as `x-conformance-trace` in the observation headers. Nested dispatches append to the same trace. This instrumentation is independent of the target; both adapters must execute in the runner's realm. Tests deliberately run serially, with one worker, to isolate this legacy trace channel. `BuiltApp.hono` exposes the real route table only for `route`/`basePath` mount probes. The public target contract is in [src/target.ts](src/target.ts).

`changes` can annotate a scenario or individual request with a decision and reason. An annotation alone leaves assertions intact. An optional `ts` object supplies a **complete replacement expectation**, such as the D7 rejection of an action without `HX-Request`. Multiple replacements for one request are rejected. D3/D6 action URL changes are handled through extraction, D4 changes client script expectations, and D9 preserves the plain-before-group middleware ordering. D1/D2/D5/D8/D10/D11/D12 do not require different HTTP expectations in these fixtures. Security settings and helper import remapping for the future TS build belong in its adapter.

Builds run in separate Node processes with `persistentCache: false`, no decorators, and a single ESM output. The npm alias `farm-recooler-oracle` prevents pnpm from resolving the oracle to the local workspace package. The adapter explicitly maps `farm-plugin-recooler/helpers` to that published package. A custom Farm logger throws after reporting errors, preserving diagnostics instead of exiting the runner. Native crashes and timeouts fail as infrastructure errors and cannot satisfy a build-error expectation.

Outputs and build diagnostics are cached in ignored `conformance/.cache/<sha256>/`. The key includes source paths and bytes, plugin options, builder and adapter code, lockfile, Node version, platform and architecture. Expectations are checked on every run even when the build is reused. `CONFORMANCE_REBUILD=1` forces recompilation. Keep the cache in the workspace: Farm's native resolver fails to resolve JSX dependencies from some external build roots despite `node_modules` symlinks. External scenario trees are copied into this cache before compiling and are never modified.

The oracle has defects beyond the settled reference claims. Their reproductions are retained under [known-issues](known-issues/README.md), outside the passing suite, rather than asserting that broken behaviour is required of 0.1.0. This includes four recovered middleware probes that cannot be represented honestly as successful requests or ordinary build errors. The original transcript's `m*` cases are middleware exports and `p*` are parameter shapes; head and layout export cases have descriptive names here.

Verified on 2026-10-27 with Node 22.22.2 and pnpm 12.11.2:

- `pnpm run test:conformance`: **390 passed**, comprising 110 scenarios (351 request cases and 35 build-error cases) plus 4 runner contract checks. The full build run took 83.53 s; the cached repeat took 2.27 s.
- `pnpm --filter recooler-conformance typecheck`: passed.
- `pnpm exec tsc --noEmit`: passed for the root project. Its config excludes the independently checked conformance package and intentionally invalid fixture source trees.
- `CONFORMANCE_TARGET=ts pnpm --filter recooler-conformance test`: **4 passed, 386 skipped**, as expected for the stub.
- `CONFORMANCE_DIRS=/private/tmp/<temporary-directory>/scenario-external CONFORMANCE_SCENARIOS=scenario-external pnpm --filter recooler-conformance test`: **17 passed**, using a copy of `s1` outside the workspace.
- `git diff --check`: passed.
