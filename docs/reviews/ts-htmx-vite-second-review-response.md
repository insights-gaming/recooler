# Phase 4b second review response

Implementation checkpoint: `2bcf8dd` on `ssttevee/ts-htmx-vite`, based on
`a44b078`, in `/Users/steve/.t3/worktrees/farm-plugin-recooler/t3-b14570d3`.
No push. This response supersedes the first response's absolute-path namespace
and `server.fs.strict: false` fixture workaround.

## Resolutions

1. The action transform runs before the action table loads, including Vite dev
   warmup and manifest-first custom entries. Only empty dev registrations retain
   the table-load gate. The new startup fixture awaits cached warmup transforms,
   checks the complete table, and dispatches actions in both entry orders. The
   auxiliary Worker still receives no empty runtime registration imports.
2. The route plugin loads only exact generated-manifest source inputs whose path
   contains `:` (excluding a Windows drive prefix). It preserves strict fs,
   watches those inputs, and replaces the permission set after generation.
   Neighboring files, query variants, ordinary paths, and removed inputs are not
   handled by this hook. The Cloudflare edit fixture no longer changes fs.strict.
   Cloudflare v1/v2 integration now includes a colon-directory route. The
   generator returns a Windows portability warning; docs recommend `[id]`.
3. Build namespaces hash the nearest package.json name and package-relative
   srcDir, then append the environment. `htmx.namespace` overrides app identity;
   the dev nonce remains. Regressions cover different named apps at the same
   absolute path with an identical component and secret, checkout relocation,
   source directories, environments, the nearest package boundary, and explicit
   overrides. Apps need distinct package names or namespace overrides; unnamed
   apps must supply an override for reliable isolation. Distinct apps and distinct
   deployments such as staging/production must not share a signing secret.
4. Module hashes are SHA-256 over JSON `[actionTransformVersion, source]`.
   The exported constant starts at 1. Its declaration and transform/Vite docs
   require a bump whenever action collection or numbering semantics change.
   The startup regression checks the emitted hash against this contract.

## Verification

- Package tests: **1,425 passed**, 48 files. Includes Node, Cloudflare v1 and v2
  builds/dev, strict colon paths, action maps, watch builds, edit matrices,
  warmup, manifest-first entry, stable identities, and the auxiliary Worker.
- Package build, package typecheck and conformance typecheck: passed.
- `CONFORMANCE_REBUILD=1 CONFORMANCE_TARGETS=ts,farm-0.0.27` conformance:
  **1,051 passed, 10 expected skips**, both targets rebuilt.
- Reviewer scripts in `/private/tmp/r4b`:
  - `warm.mjs` pY: default, warmup and custom-entry requests all 200 with the full
    table. `warmng.mjs` was copied with only its package path redirected from the
    historical nogate checkout to this implementation; warmup/custom entry pass.
  - `cf-colonfix.mjs` pX passes. More importantly, unmodified `cf.mjs` (without
    its broad scratch load hook) serves `/` and `/test` on Cloudflare v1/v2 with
    default fs policy. Both also pass with htmx:false and a plain colon page.
    The original action-valued page intentionally raises the untransformed
    diagnostic when htmx is disabled; it no longer prevents Worker startup.
  - `cf-aux.mjs` pW: `/aux` and `/` both 200.
  - `samepath.mjs` was copied with distinct package names assigned to A and B,
    as required by the app-identity decision, and its first page reset to app A.
    A's action returns 200; replay on B returns **404**.
  - `shift.mjs`: own action 200; shifted-module replay **404**; unchanged-module
    URL survives a route-only edit (200); cross-base replay **404**.

Raw verification logs are `/private/tmp/r4b/implementation-*.log`.

## Benchmark gates

Both isolated gates pass. The [raw artifact](ts-htmx-vite-second-review-bench.json)
retains samples, build sizes, load averages, runtime version and exact limits.
The control remains stock incremental HMR, as in the first review response.

- Node full-plugin/baseline build ratios: **1.80–2.10×** across flat/grouped
  100/400/1,000-route fixtures. The 100-to-400 build and edit growth gates pass.
- 1,000-route Node edit medians: **347 ms** flat and **361 ms** grouped,
  against stock-HMR controls of **166 ms** and **170 ms**. Both pass the 1 s cap
  and the relative/overhead gates.
- Workerd edit medians: **1,069 ms** at 400 routes and **2,509 ms** at 1,000,
  against controls of **299 ms** and **515 ms**. Both pass the 3.5 s cap.

The workerd full-runner reload remains substantially slower than stock HMR;
this change does not alter that performance contract.
