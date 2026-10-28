# Private consumer dispatch equivalence

This public harness accepts a local checkout with `packages/router` and
`packages/admin`. Consumer source, identifiers, bindings, request profiles and
results stay private. It clones committed input into `/private/tmp/consumer-equivalence/run-*`
and never installs, builds or edits the input checkout. Uncommitted and ignored
files are not copied. Node 22 and pnpm 12 are required.

```sh
node scripts/consumer-equivalence/run.mjs /absolute/path/to/consumer-checkout \
  --target farm-0.0.27 --probes /private/tmp/local-profile.json
```

Runs use `git clone --local --no-hardlinks` and `pnpm install --frozen-lockfile
--ignore-scripts`. Only explicit build commands run; no lifecycle hooks, code
generators, deployments or schema uploads run. `--reuse RUN_DIR` rebuilds an
existing temporary clone without refreshing its source. Existing runs are not
deleted. Build roots outside this scratch tree (except the synthetic fixtures)
and escaping checkout/package symlinks are rejected. Never commit private
snapshots, source paths, action IDs, bodies, logs or option files.

## Adapter contract

`run.mjs` owns cloning, installation, replay and comparison. `traces.mjs` owns the
request matrix, normalization and comparison records. Adapters expose:

- `prepare({ packageRoot, packageOut, optionsFile, command, name })` builds
  uninstrumented `baseline/main.js` and instrumented `probe/main.js`, returning
  private build metadata. Use `command(program, args, cwd, logName)` for builds.
- `load({ packageRoot, packageOut, spec, mode = 'probe' })` returns `dispatch`,
  `actionUrl`, `dispose`, runtime metadata and, for probe mode, `catalog` and
  private `diagnostics`. Both modes must use `loadRuntime` from `runtime.mjs`.
  This keeps bindings, network stubs, compatibility settings and the response
  wrapper identical across targets. Optional `dispatchBatch(requests)` runs
  requests sequentially; the shared runtime supplies it to avoid exhausting
  host ports through Miniflare connection resets. Adapters own compilation and instrumentation.
- Catalog routes contain `path`, supported `methods`, `actions: [{method, id}]`,
  and nullable `page` (root, outer-to-inner layouts, page module, head chain).
  Paths use **Hono pattern syntax**, e.g. `/:id`, `/:path{.+}` or `/*`, not file
  router syntax. Middleware prefixes are diagnostic metadata.
- Source labels are `{file, export}` pairs. `file` uses package-relative forward
  slashes, no leading `./`, and the **original source extension** (`.ts`, `.tsx`,
  etc.). Resolve extensionless generated imports to their actual source file
  before labelling them; do not invent `.js` or compare generated chunk paths.
  Re-export import slots retain their own provenance even for identical functions.
- Dispatch uses the shared wrapper. It records ordered runtime `middleware`,
  `handler`, `action`, `page`, `render-page`, `root`, `layout` and `head` calls.
  `page` describes handler entry; the other rendering labels record actual
  component/head evaluation. A HOC's returned component is wrapped, so its
  build-time factory call is not mistaken for a request-time render.
- Dispatch returns status, headers, UTF-8 body, exact bytes as `bodyBase64`, and
  private console messages. Before reading response fields the wrapper checks
  `response instanceof Response`. Non-Response returns have `error: "NonResponse"`
  and `returnedType`; thrown request/stream errors have `error` (class) and
  `errorMessage`. Status is nullable when no Response was returned.
- `actionUrl(case)` is required for known actions. Cases carry
  `action: {routeId, pathname, method, actionId, scope?}`; `routeId` identifies the
  catalog's Hono template. The hook maps that template to any runtime route ID.
  The 0.0.27 hook constructs the existing unsigned `?action=<id>` URL. A 0.1
  adapter must sign at dispatch, using the htmx phase's required test-only export:
  `signActionUrl({ routeId, pathname, method, actionId, scope }, secret)`.
  The helper returns a URL string (or Promise thereof). The test secret belongs
  in private adapter options; do not bake signatures into baseline cases.
  Missing hook support fails replay. Explicit cases may provide captured scopes;
  a raw known-ID case does not invent business data for captured actions.

Use `--adapter /absolute/path/to/adapter.mjs` for another implementation (and
`--target` for its snapshot filename). The Farm adapter pins core 1.7.11 and
recooler 0.0.27, disables persistent cache, and removes unsupported decorator
parser options. AST instrumentation changes only the generated virtual app;
unknown registrations fail capture. The shared runtime resolves Miniflare from
the clone's Wrangler dependency and preserves named Worker exports. Compatibility
date/flags come from the package's generated Wrangler JSON. Outbound networking
returns a local 503; configured service bindings use local stubs. Emitted JS
modules load from a stable virtual root, so temporary run paths do not leak into
application error stacks and cause false byte differences. Named exports and
relative JS chunk imports remain intact.

## Schema, requests and comparison

Schema **3** stores target/source/runtime metadata and per-package catalog,
diagnostics, build, runtime, traces, optional response probes and summary. Each
trace includes its exact logical request, invocation sequence, status, selected
headers, normalized HTML digest or exact non-HTML body bytes, and error details.
Every generated case is also dispatched against the uninstrumented baseline in
an independent runtime with the same configuration and order. Status and outcome
type must match; otherwise capture fails. `baselineStatus` and the checked count
are evidence, excluded from cross-version comparison. Console messages and raw constructor
names are private diagnostics, also excluded because bundlers can rename classes.
`returnedType` compares the JavaScript type and object tag. This guard is not a claim
that private business responses are equivalent to production.

The matrix covers all seven methods, single params with two sample values,
multi-segment catch-alls, trailing slashes, percent-encoded paths, parent paths,
unmatched children, known actions with their methods and unknown actions for
every method. Action submissions have non-empty URL-encoded bodies. Each case
has a same-origin htmx variant and a plain variant without htmx, Origin or Fetch
Metadata headers. Private `clientVariants` add further profiles, including a
non-local client and a cross-site browser. Set their headers and build profile
privately so the consumer's auth and CSRF rejection paths actually execute;
verify 403 outcomes and middleware coverage in the private snapshot. No consumer
security constant names are part of this contract.

```sh
node scripts/consumer-equivalence/run.mjs /absolute/path/to/consumer-checkout \
  --probes /private/tmp/local-profile.json \
  --compare /private/tmp/consumer-equivalence/baseline-run/farm-0.0.27.json
```

Comparison reuses the baseline's exact logical cases. A candidate cannot shrink
coverage by dropping routes/actions. It compares invocation order and source
labels, status, error class/message/returned type, and these selected headers
exactly (presence as well as value): `location`, `content-type`,
`content-disposition`, `cache-control`, `allow`, `vary`, `hx-refresh`, `hx-push-url`,
`hx-replace-url`, `hx-redirect`, `hx-location`, `hx-trigger`,
`hx-trigger-after-settle`, `hx-trigger-after-swap`. Cookies, dates and transport
headers are outside this selected set because they can contain per-request state.
Non-HTML bodies compare byte for byte, including binary responses. A JSON or
text response is never silently normalized.

For `text/html`, SHA-256 covers the UTF-8 body after these explicit substitutions:

1. Remove `data-recooler-route` attributes and the corresponding route-marker
   meta tag. The new client loader adds this bookkeeping, absent in 0.0.27.
2. Replace only query values of `action`, `sig` and `signature` with a token.
   Preserve the URL path, parameter names, other values, scope and surrounding
   attribute/HTML. Target action encodings and per-dispatch signatures may differ;
   dispatched action identity and order still compare through runtime labels.
3. Replace numeric engine stream IDs in `id="s:pN"`, `s:rN`, `s:sN`, and
   `suspense.tp(N)` with a stream token; these are stream bookkeeping. Keep all
   Suspense placeholders, templates, scripts and resolved content.

Whitespace, business text, head elements, layout markup, root/client scripts
and external script URLs remain significant. Dropping a head, layout or script
changes the digest. Framework script-delivery changes require explicit expected
differences; normalization does not erase arbitrary script tags. `normalizeHtml`
in `traces.mjs` is the authoritative implementation.

## Explicit expected differences

`--expect-diff PRIVATE.json` requires `--compare`. The file is an array of entries:

```json
[
  {
    "package": "admin",
    "case": { "path": "/example", "method": "POST", "kind": "known-action", "variant": "plain", "headers": {}, "body": "value=sample" },
    "fields": ["status", "bodyBase64"],
    "reason": "Reviewed intentional CSRF rejection in the new runtime"
  }
]
```

Copy `case` verbatim from a private trace's `request`, including any `action`
metadata. Matching is deep exact equality; no wildcards or broad route rules.
Fields may only be `invoked`, `status`, `headers`, `bodyBase64`, `htmlDigest`,
`error`, `errorMessage`, `returnedType`. Each entry needs a non-empty reason.
Every accepted field difference and reason is saved. Unlisted differences,
unknown fields and unused/stale entries fail comparison. An empty file allows
nothing. Never use this mechanism to suppress unexplained regressions.

## Private options and probes

`--probes PRIVATE.json` contains per-package objects:

- `defines`: expression-valued build overrides. Boolean/string macros declared
  in workspace `global.d.ts` receive inert false/empty defaults. Farm defines
  override defaults; explicit values override Farm. Every declared macro,
  including object-valued declarations, must have a value or the build fails.
  Object values must be expressions, not JSON strings. Deployment profiles are
  explicit; a deployment re-bundle is not implicitly reproduced.
- `bindings`, `kvNamespaces`, `serviceBindings`: isolated runtime stubs.
- `kvInitialData`: private `{namespace: {key: stringValue}}` seed data, installed
  independently in both runtimes before dispatch. Use synthetic test key material
  for code that would otherwise generate random crypto.subtle keys in empty KV;
  the real encryption and exact encrypted response bytes remain checked.
- `rpcServiceMethods`: a private map from a configured service binding to an
  array of RPC method names. These get real local WorkerEntrypoint stubs whose
  methods throw the deterministic `RPC disabled by equivalence harness` error;
  fetch still returns the HTTP stub. This exercises application failure paths
  without native missing-handler errors or random internal-error references.
- `determinism: {epochMs, seed}`: optional, explicit test clock/entropy profile.
  Applied before app module initialization; fixes Date construction/Date.now,
  Math.random, crypto.getRandomValues and crypto.randomUUID. Entropy resets per
  logical case, independently of the adapter's signed dispatch URL. Cryptographic
  algorithms remain real; this does not control crypto.subtle key generation.
  Test-only deterministic entropy must never be used for a deployed Worker.
  Store the profile privately and use the same values in both captures. This
  makes time/nonce responses reproducible without normalizing non-HTML bodies.
- `wranglerConfig`: package-relative generated JSON configuration path.
- `clientVariants`: additional `{name, headers}` profiles applied to every case;
  names must be unique. Keep consumer-specific headers and profiles private.
- `traceRequests`: explicit cases instead of generation. `--compare` always uses
  the baseline's case list. Generated `trace-requests.json` can seed this option.
- `requests`: extra ordered diagnostic response probes with `path`, `method`,
  `headers`, string `body`, or `actionFrom` (earlier probe index), `attribute`
  (default `hx-post`) and `actionIndex` (default 0). Extracted URLs are unescaped
  and resolved against the earlier response URL. Probes keep full private bodies
  and headers; they supplement the compared automatic matrix.

Shared state and request order are part of the profile. Without explicit RPC
methods, service bindings are fetch-only. A minimal synthetic call to an RPC
method on such a binding reproduces workerd's "Failed to get handler to worker"
and a random internal-error reference. Configure `rpcServiceMethods` to replace
this missing-handler path with a deterministic failure; do not pretend RPC calls
succeed. The verified private profile produces zero native missing-handler logs.
Miniflare log levels alone do not silence native workerd diagnostics.

## Verification

```sh
pnpm --dir fixtures/consumer-shape/router build
pnpm --dir fixtures/consumer-shape/admin build
node fixtures/consumer-shape/check.mjs
node scripts/consumer-equivalence/self-test.mjs
node scripts/consumer-equivalence/self-test.mjs --adapter /absolute/path/to/adapter.mjs
```

The self-test calls the selected adapter's `prepare` and `load` for both modes,
with private `spec.fixture: true`. Fixture loading uses the shared response
wrapper in Node with the explicit Workers import loader and a synthetic service
binding. A new adapter must support this mode before private consumer replay.
Fixture HEAD responses can abandon streaming waitUntil promises; Node fixture
disposal does not wait indefinitely for detached streams, matching runtime
teardown. No such exception changes response recording or status checks.

Checks cover exact fixture response parity, both client modes, runtime rendering
calls, action exclusion, source provenance, group params, and the root
`return await next()` / undefined-handler non-Response case (plus HEAD failure).
Mutation checks show missing render calls, root scripts, layout/head HTML,
headers and unlisted response differences fail comparison. They also exercise
action URL hooks and explicit/stale expected differences. The 0.1 runtime and
its signing helper remain requirements for the implementation phases.
