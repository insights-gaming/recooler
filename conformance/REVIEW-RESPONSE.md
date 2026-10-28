# Conformance second-round review response

Branch: `ssttevee/ts-conformance`, existing worktree `/Users/steve/.t3/worktrees/farm-plugin-recooler/t3-d1338f6e`. Started at `54fee49`; implementation checkpoint `4a061b3`. The final report checkpoint is branch HEAD. No push was performed.

The design used for this round is `git show cc32d10:docs/plans/typescript-rewrite.md`, §3.3 and §3.5. It replaces the earlier route-pattern/pre-middleware interpretation.

## Finding resolutions

1. **N1 — direct D6 probes:** added `action.tamper: "drop-sig" | "flip-sig" | "method" | "scope"` to mutate the URL extracted from the rendered page (or the request method), retaining the actual action id. `action-signing` renders on `/users/1` and tests its own action with removed/altered signature, wrong method, tampered scope, and pathname replay to `/users/2` on the same pattern. Authenticated probes require TS 404 after the `chain` trace and exclude every action-body trace. A valid control executes; an unauthenticated replay returns 401 before verification. Three additional captured-scope probes use a fixture-only signing key, which lets the oracle detect signature verification mutations. `action-barrel` imports a barrel with an unused admin re-export from a public route. The oracle runs the admin action under the public middleware (200, trace `public, action admin-barrel`); TS requires 404 and excludes the action trace.
2. **N2 — middleware precedes verification:** all existing unauthenticated foreign admin probes now expect the guard's 401 on TS, including mounted requests. s4b adds four authenticated foreign/pathname replay probes to reach verification and require 404 without executing the action. s9's foreign action body now has a trace marker, so its exclusion proves non-execution. README and this rationale explicitly state that there is no pre-middleware routing rule.
3. **N3 — method-specific reservation:** removed the TS 404 overrides for `POST /postonly?action=bogus` and `GET /pageonly?action=bogus`; both remain 200 on both targets. Only routes with actions for the receiving method reserve `action`. Unknown/unsigned values on those routes retain 404 expectations, with updated rationale.
4. **N4 — mounted action URLs:** ordinary mounted submissions use `action.oraclePath` only for the oracle's missing-prefix correction. TS submits the extracted URL unchanged, so a broken mount prefix fails. Intentional foreign probes keep the cross-target `action.path`. `mount-mount` supplies `ts: { htmxOptions: { base: "/m" } }`, which the TS adapter must pass to `htmx({ base })`. Runner checks prove the oracle override does not mask TS URL generation.
5. **N5 — middleware diagnostics and root scripts:** m14 and m15 independently require `src/routes/middleware.ts` and `must export a middleware function`. m15 remains a class probe; the contract documents rejecting the `class` prefix from `Function.prototype.toString`, despite `typeof` returning `function`. m17 moved back to known issues because its undeclared binding throws during module evaluation, before runtime namespace validation; no unreachable startup diagnostic is claimed. `root-scripts` checks the body-safe Content route marker, actual handler code in client chunks, and no inline handler code.
6. **N6 — script assertions:** removed the blanket absence-of-script rule. Handler-free TS pages use `noClientEntry` to reject script references to any emitted client chunk, requiring a nonempty chunk map even for those pages. `inlineScriptExcludes` checks script contents for known handler markers while allowing unrelated cleanup/bootstrap scripts. The playground handler case and custom root require their handler code in emitted browser chunks.
7. **N7 — target integrity and isolation:** the public target contract and README require self-contained builds with no application/dependency module state shared across scenarios (for example `ssr.noExternal: true` into a per-scenario Vite SSR directory). An entry query alone does not isolate unbundled dependencies. htmx/D4 scenarios require Vite builds of both server and client. TS availability checks all four public runtime/build entrypoints, including `recooler/htmx` and `recooler/vite`. Only a missing public entrypoint/package is skippable; syntax/evaluation failures, missing transitive dependencies and invalid exports fail. The default loader checks the resolved entry file before import because Vitest wraps some missing-file errors. Contract tests exercise absent htmx/vite entries, broken evaluation/dependencies and invalid `createApp`.

D6 signs every action URL over **route id (`route.file`), exact pathname, method, action id and scope**. The per-route extension verifies against the receiving binding **after chain middleware and before `onRequest`/handlers**. A mismatch calls `next()`; if nothing else answers, the result is 404. Sharing a catch-all route pattern does not authorize a different pathname. Guards still return 401 first for unauthenticated requests. Every foreign/replayed TS negative excludes the action-body trace.

The oracle expectations record observed 0.0.27 behavior: uncaptured actions run with no signature, an altered signature, an added scope or a different pathname; the wrong-method GET renders the page without executing an action. Captured scopes with the configured test key return **403** for missing/altered signatures or altered scope. These oracle 403s deliberately differ from the TS D6 404 contract.

## Counts and verification

- **123 scenarios:** 116 oracle scenarios and seven TS-only scenarios. Net change from round one: two security scenarios added; m17 returned to known issues.
- **519 scenario checks:** 482 requests and 37 diagnostics. Oracle: 477 requests plus 35 diagnostics. TS-only: five requests plus two startup diagnostics.
- **21 runner contract checks**, up from ten.
- Cached oracle suite: **533 passed, 7 intentionally skipped**.
- `CONFORMANCE_REBUILD=1 pnpm --filter recooler-conformance test`: **533 passed, 7 intentionally skipped**, with all oracle apps recompiled.
- `pnpm --filter recooler-conformance typecheck` and `pnpm exec tsc --noEmit`: passed.
- Explicit `CONFORMANCE_TARGET=ts`: expected nonzero unavailable-target failure.
- `CONFORMANCE_TARGET=ts CONFORMANCE_ALLOW_SKIP=1`: **21 runner checks passed, 519 target checks explicitly skipped**.
- `git diff --check`: passed. Node 22.22.2, pnpm 12.11.2.

The TS adapter remains a deliberate stub. TS acceptance behavior is specified, not claimed as executed against an implementation.

Verification logs: `/private/tmp/recooler-r3-cached.log`, `/private/tmp/recooler-r3-rebuild.log`, `/private/tmp/recooler-r3-ts-fail.log` and `/private/tmp/recooler-r3-ts-skip.log`.

## Mutation results

Re-ran the table from `/private/tmp/confreview` and `/private/tmp/r2`, using the current scenarios and oracle expectations. Reproduction: `node /private/tmp/r3/run-mutations.mts`; driver: `/private/tmp/confreview/mutate.mts`; definitions: `/private/tmp/confreview/mutants.mts`. Logs: `/private/tmp/r3/mut-<name>.log`; machine-readable results: `/private/tmp/r3/results.json`.

All **16/16 mutants are killed**. Each row covers 81 oracle runtime apps; 35 oracle diagnostic scenarios and seven TS-only scenarios are excluded. Counts below are scenario counts, not check counts.

| Mutant | Scenarios killing it | Mutated but pass | Unaffected |
|---|---:|---:|---:|
| `noOnce` | 6 | 18 | 57 |
| `onceByFunction` | 3 | 21 | 57 |
| `onceByRequest` | 3 | 21 | 57 |
| `firstChainOnly` | 9 | 15 | 57 |
| `noTrailingUse` | 5 | 2 | 74 |
| `reverseSameShape` | 26 | 18 | 37 |
| `reverseChain` | 5 | 2 | 74 |
| `reversePlain` | 3 | 0 | 78 |
| `noFallThrough` | 31 | 6 | 44 |
| `unknownActionFallsThrough` | 5 | 32 | 44 |
| `nullish200` | 2 | 35 | 44 |
| `noHead` | 20 | 61 | 0 |
| `optionsByGet` | 17 | 63 | 1 |
| `globalActions` | 7 | 74 | 0 |
| `foreignActionAccepted` | 7 | 74 | 0 |
| `signatureNotVerified` | 1 | 1 | 79 |

The new `signatureNotVerified` mutant disables the oracle's captured-scope signature condition while retaining scope parsing. `action-signing` kills it in three requests: missing/altered signatures return **200 scoped original**, and scope tampering returns **200 scoped tampered**, each with `chain, action scoped`, instead of **403** with only `chain`. It is expressible on the oracle for captured scopes with a configured key. Verification of signatures on uncaptured actions and of the route-id/pathname/method binding is new TS behavior, so mutations of those checks can only be evaluated once the TS target exists.

Both foreign-action mutants still fail in the six prior scenarios and now also in `action-signing` (the wrong-method request runs the foreign-method action). The barrel scenario intentionally accepts the oracle hole; its TS expectation is the regression gate for the rewrite.
