# Conformance review response

Branch: `ssttevee/ts-conformance`, existing worktree `/Users/steve/.t3/worktrees/farm-plugin-recooler/t3-d1338f6e`. Started at `d1828c8`; runner checkpoint `c2fd1bb`; scenario checkpoint `8e59e7b`. No push was performed. The final report commit is the branch HEAD.

## Finding resolutions

1. **Foreign action IDs:** added `action.path`, preserving the rendered signed query while changing the destination path. s4b renders the admin catch-all with auth and submits without auth to `/about`, `/hook`, `/plainpage` and `/x`. Oracle verification returns 401 through the guard. Cross-route TS cases require 404 and exclude the action-body trace. Restored s9's `/p` case and mounted foreign actions. Both global-action mutants are now killed.
2. **D7 CSRF:** all extracted and handwritten action requests automatically carry HX, same-origin Origin and Sec-Fetch-Site headers. Four explicit negative cases assert TS 403 with an empty trace, proving neither action body ran. `omitHeaders` makes missing-header cases explicit.
3. **s8:** restored path encodings, strict trailing-slash and case behavior, HEAD/PUT/OPTIONS/PROPFIND, internal retries after 500/429, repeated identical Requests after failures, repeated authenticated requests preserving `user=alice`, same-group POST fall-through, direct staff guard, and unauthenticated hook-only routes. s8 now contains 48 request checks.
4. **Mounts:** rendering and submitting both use `request.mount`. Rebuilt all mount trees from s4 with its public middleware, and added `route("/")`. Public actions and foreign actions run under route/basePath/mount. Corrected provenance. Verified that the oracle emits unprefixed action paths, so mounted submissions explicitly retain the rendered query at the mounted destination.
5. **Unknown/bogus actions:** supplied valid CSRF headers and D6/D7 annotations, with TS 404 independent of lookup wording or pre-lookup middleware order. The eleven lookup probes retain oracle 404. Two additional existing s5 probes legitimately return oracle 200 because no applicable action dispatcher reserves the query; TS explicitly changes these to 404. This exception is documented rather than falsifying the oracle expectation.
6. **Build errors:** added independent `buildErrors` target overrides. All 22 conflict cases assert both source paths and `respond to METHOD` separately; c3 and c3b now distinguish GET from PUT. Route order is irrelevant. TS diagnostics assert paths and method without requiring Rust's prose.
7. **Module isolation:** Farm imports include a per-scenario query string. Identical source trees reuse build bytes but instantiate separately, including on `CONFORMANCE_REBUILD=1`.
8. **Explicit targets:** unavailable selected targets fail by default. Only `CONFORMANCE_ALLOW_SKIP=1` permits unavailable-target skipping; target applicability skips remain intentional.
9. **D4:** added emitted-browser-chunk inspection to the target contract. The TS playground case requires actual `clicked` handler code in chunks and excludes the server-only marker across all chunks. Handler-free pages exclude `<script`, including module tags.
10. **Dropped probes:** restored unauthenticated x10 hook, two registrations of one app in the same parent, bounded outer retry, outer repeated Request, r1's blocking shared auth re-exports, unauthenticated e5/e6/e7 GET/actions, e6's 401 public guard, e7's PUT directory order, s4b DELETE/OPTIONS, and the authorized playground mount.
11. **Lower-priority coverage:** q6 explicitly excludes the plain layout/form. New `layout-groups` pins root/group/plain layout ancestry. Accepted middleware in m1–m4 and m11 records `mw`. Restored HEAD/OPTIONS/PUT in successful q/c cases. Filename order now distinguishes `middleware@10` from `middleware@2`.
12. **Nits:** d11 admin blocks again; scenario-wide TS response replacements are rejected; target expectation families support versioned/custom TS names; filesystem ordering is deterministic and locale-independent; failure state survives repeated identical Requests; TS-only `root-scripts` exercises the new script-URL array signature alongside compatibility fixtures.
13. **Known issues:** added `targets`. `root-head-only`, `head-star`, `head-deep-mutation` and m16 are TS acceptance scenarios. m14/m15/m17 require startup validation errors naming middleware and its function requirement. Originals remain under known-issues for provenance, with updated documentation.
14. **Target interface:** documented in code and README that middleware traces require the runner's process and realm; workerd cannot implement this instrumentation contract.

D6 uses **404** for an invalid route signature, matching unknown actions without revealing validity. `/admin-secret` and `/x` are two URLs matching the same admin catch-all pattern, so D6 does not make that pair foreign; its TS expectation remains 401 from the guard. The body still must not run.

## Counts and verification

- **122 scenarios** (previously 110): 114 oracle scenarios plus eight TS-only scenarios.
- **505 scenario checks:** 467 request checks and 38 build/startup diagnostics. Oracle applicability is 462 requests plus 35 diagnostics; TS-only applicability is five requests plus three diagnostics.
- **10 runner contract checks** (previously four).
- Full oracle suite: **507 passed, 8 intentionally skipped** (previously 390 passed).
- `pnpm --filter recooler-conformance test`: passed, including the final cached run.
- `CONFORMANCE_REBUILD=1 pnpm --filter recooler-conformance test`: passed with all final scenarios, including the identical-source mount trees.
- `pnpm --filter recooler-conformance typecheck` and `pnpm exec tsc --noEmit`: passed.
- `CONFORMANCE_TARGET=ts pnpm --filter recooler-conformance test`: expected nonzero failure because the TS adapter remains unavailable.
- `CONFORMANCE_TARGET=ts CONFORMANCE_ALLOW_SKIP=1 pnpm --filter recooler-conformance test`: 10 runner checks pass, 505 target checks explicitly skipped.
- `git diff --check`: passed. Node 22.22.2, pnpm 12.11.2.

TS acceptance cases are specified but cannot be executed against an implementation yet; the TS target is still the explicit stub. No TypeScript implementation behavior is claimed as verified.

## Mutation results

Used the reviewer's `/private/tmp/confreview/mutate.mts` and `mutants.mts`, extending the driver to honor `targets`, `repeatExpect` and forbidden trace entries. Added `foreignActionAccepted`, which preserves local action lookup but falls back to a known foreign action. Reproduction: `node /private/tmp/run-review-mutations.mts`. Detailed logs: `/private/tmp/confreview/new-<mutant>.log`; machine-readable results: `/private/tmp/confreview/new-results.json`.

All **15/15 mutants are killed**. The counts below are scenario counts, not check counts; a mutant is killed when at least one scenario fails. A scenario in the “mutated but passes” column simply does not detect that particular mutation. The 35 build-error scenarios and eight TS-only scenarios are excluded from runtime mutation testing, leaving 79 apps per row.

| Mutant | Scenarios killing it | Mutated but pass | Unaffected |
|---|---:|---:|---:|
| `noOnce` | 5 | 17 | 57 |
| `onceByFunction` | 3 | 19 | 57 |
| `onceByRequest` | 3 | 19 | 57 |
| `firstChainOnly` | 9 | 13 | 57 |
| `noTrailingUse` | 5 | 2 | 72 |
| `reverseSameShape` | 26 | 16 | 37 |
| `reverseChain` | 5 | 2 | 72 |
| `reversePlain` | 3 | 0 | 76 |
| `noFallThrough` | 30 | 5 | 44 |
| `unknownActionFallsThrough` | 5 | 30 | 44 |
| `nullish200` | 2 | 33 | 44 |
| `noHead` | 20 | 59 | 0 |
| `optionsByGet` | 17 | 61 | 1 |
| `globalActions` | 6 | 73 | 0 |
| `foreignActionAccepted` | 6 | 73 | 0 |

The original `globalActions` mutant previously survived all 110 scenarios. It and the new `foreignActionAccepted` mutant now fail in **six**: s4b, s9, mount-route, mount-basePath, mount-mount and mount-root. On s4b's foreign `/about` probe, both return **200 `action admin-rest`** with trace **`[public-group, action admin-rest]`**, versus the real oracle's **401 `BLOCKED by admin-group`** and **`[public-group, admin-group]`**. Status, body, ordered trace and the explicit forbidden action trace all catch the bypass.
