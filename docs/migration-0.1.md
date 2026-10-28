# Migrating to recooler 0.1

## Routing and the generator

- Custom-pattern parameters now always sort before plain parameters at the same position
  (static < custom pattern < plain param < catch-all). In 0.0.27, parameter names could put
  a plain parameter first and make a regex route unreachable for matching input.
  Comparison proceeds left to right: `/[id{[0-9]+}]/[x]` now beats `/[slug]/edit`
  for `/42/edit`, where 0.0.27 picked `edit`. Overlapping custom patterns are still
  ordered by parameter name when their route shapes have equal specificity. Only
  exact `{.+}` and `{.*}` patterns have catch-all priority; match-everything custom
  patterns such as `{.+?}` sort ahead of plain parameters.

- Bracket parameter names now support `]` within balanced pattern braces, for example
  `[n{[0-9]+}]`. Unconvertible `[`…`]` directory names are build errors; 0.0.27 silently
  retained them as literal URL segments.
- Directory names containing `\` are build errors. Use `[0-9]` rather than `\d` for
  portable digit patterns. 0.0.27 silently retained these directory names literally.
- Directory names containing `%`, `#`, or `?` are build errors. Encoding these characters
  in generated imports was incompatible with TypeScript, Vite and routing.
- Generator `importExtension: '.tsx'` becomes `'source'`, which keeps each source file's
  extension. The `.js` mode keeps `.jsx` source imports as `.jsx` for Vite resolution.
- Import the `routes()` Vite plugin from `recooler/vite`; `recooler/gen` is the standalone
  generator and has no Vite dependency in its declarations.
- Extension array handlers must declare their `methods`; they run only on those methods
  (`ALL` means every method, GET includes HEAD). Missing or empty `methods` for array
  handlers throws `RouteValidationError`. Handler maps declare their keys as methods.
  HEAD declarations register as GET to support Hono routing, with their handlers
  running only for HEAD requests.
  Page adapters retain ordered extras and receive named contributions as a third argument.
- Route modules with an own non-function `default` export now fail validation, even
  without a page adapter. Custom parameter patterns must be nonempty valid regular
  expressions, and `[[rest]]` names cannot contain `{`.
- Await `watchRoutes(...).close()` to finish any generation already in flight.

## Worker builds and deployment constants

The old deployment can run Farm first and then have Wrangler re-bundle its
output with esbuild. Environment `define` values and CLI `--define` overrides
apply in that second stage, even if the Farm config has no defines.

Cloudflare Vite plugin **1.65.0** removes Wrangler `build` and `define` before
building. Its [versioned source](https://github.com/cloudflare/workers-sdk/blob/%40cloudflare/vite-plugin%401.65.0/packages/vite-plugin-cloudflare/src/workers-configs.ts)
explicitly deletes both fields; Cloudflare's [migration reference](https://developers.cloudflare.com/workers/vite-plugin/reference/migrating-from-wrangler-dev/)
maps define and alias settings to Vite. Move the entry from the old compiled
output to your source Worker entry, and use `vite build` in the build script.
Deploy Vite's generated Worker configuration rather than running the old custom
Farm build command again.

Keep every existing macro in an explicit expression-valued map for each Vite
mode. Keep application-specific constants in a private map. Object-valued constants
must remain object expressions, not strings containing JSON. Preserve deploy-only
`--define` overrides. Do not equate `command === 'build'`
with deployment: local preview and deployed builds can need different profiles.

```ts
import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { recooler } from 'recooler/vite';
import { deploymentProfiles } from './build-profiles'; // private, explicit maps

export default defineConfig(({ mode }) => {
  const profile = deploymentProfiles[mode];
  if (!profile) throw new Error(`Unknown deployment mode: ${mode}`);
  return {
    plugins: [cloudflare(), ...recooler()],
    define: { ...profile.defines },
  };
});
```

Select the Wrangler environment as well as the matching Vite mode, for example
`CLOUDFLARE_ENV=production vite build --mode production`. Select `CLOUDFLARE_ENV`
for development and preview builds too, and use the matching environment when
running preview (for example `CLOUDFLARE_ENV=staging vite build --mode staging`
then `CLOUDFLARE_ENV=staging vite preview`, or `CLOUDFLARE_ENV=staging vite dev
--mode staging`). Vite mode alone does not select a Wrangler environment. Keep production and local
profiles separate and verify their emitted constants. Upgrade workspace catalog
entries to the pinned Vite target, and run the existing test suite against the new
catalog resolution.

## CSS strings, assets and resolution

Replace CSS imports that previously provided a processed string with
`import css from './styles.css?inline'`. Vite processes the CSS and
returns a string without injecting it into the document. Retain PostCSS/Tailwind
configuration. Use `?raw` for HTML, text and SQL strings that need no processing;
update ambient declarations or include `vite/client` types. A plain CSS import
has different semantics. See [Vite CSS imports](https://vite.dev/guide/features.html#disabling-css-injection-into-the-page).

Map exact-match Farm aliases to anchored regular-expression Vite aliases,
preserving their existing replacements. Vite resolves package `exports` before `mainFields`;
use environment-specific `resolve.conditions` for export conditions and
`resolve.mainFields` for fallback browser/module/main fields. Verify server and
browser resolution independently. Preserve `cloudflare:workers` and other
platform externals on the server, and banned-import checks in client slices.

## Route and middleware compatibility

Actions register only on routes that have a page, matching 0.0.27. Importing a
page's data helper into a handler-only endpoint does not expose that page's
actions there. Such endpoints continue to dispatch only their request handlers.
Cross-route imports and non-handler exports remain valid and do not create new
routes. This compatibility rule matters to callers of method-only endpoints.

Group middleware must see the matched route parameters. Plain-prefix auth must
also protect method-only routes, catch-alls and unmatched requests under its
prefix. After-next middleware must still see `ctx.error` and `ctx.finalized` and
may throw `HTTPException` with a response returned by `app.onError`.

Hono's after-next behavior remains observable: if an inner handler returns
`undefined`, middleware using `return await next()` still yields a Context object
in 0.1. Return an explicit Response when one is required; this migration does
not change that Hono behavior.

See the action URL and CSRF migration below for manual action requests, and
the browser-handler section for client loading and the legacy-root opt-in.

## JSX pages

Use `recooler/jsx` for the JSX page adapter and runtime:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "recooler/jsx"
  }
}
```

Use `plugins: recooler()` from `recooler/vite` to generate routes and import
`virtual:recooler/app` from your server entry. With Cloudflare, use
`plugins: [cloudflare(), ...recooler()]` and retain the platform builder.
The plugin defaults JSX to `recooler/jsx` per file, respects nested/referenced
tsconfigs, file pragmas and explicit OXC or legacy esbuild configuration, and
warns for other effective runtimes. The htmx transform relies on this runtime to
remove Context values from intrinsic attributes, including props spreads.
See the [Vite integration](../packages/recooler/src/vite/README.md) for environment
selection, dependency bundling and augmenting the virtual app's Bindings.
Precompiled dependencies need recompilation or aliases for their bundled engine
runtime imports; aliases do not rewrite externalized dependencies. See the
[JSX README](../packages/recooler/src/jsx/README.md) for the alias recipe and Node
ESM bundling requirements.

Import `RouteProps`, `RouteHead`, and `RouteHeadFn` explicitly from `recooler/jsx`;
these are no longer ambient global types. Augment `RouteEnv` in that module to
type the default route context's bindings and variables. `RouteProps.params` is a
readonly snapshot captured when the page handler runs. Use it in deferred
Suspense children, where Hono 5's `ctx.req.param()` is empty.

Head exports and non-nullish head function results must now be plain objects
(with `Object.prototype` or a null prototype, including ESM namespace objects).
Invalid values throw a `TypeError` identifying their route, root, or layout source.
This rejects class instances, objects created with `Object.create(proto)` for a
custom prototype, objects from another realm (for example Node's `vm`), arrays,
and strings. In 0.0.27, object exports were spread-copied and function results
were used as-is. Return a plain object explicitly when migrating these values.
Nullish exports still skip that head; nullish function results reset it to `{}`.

Plain objects and ordinary arrays nested in a head are now copied to isolate
request mutations. Nested non-plain values, including Array subclasses, remain
shared by reference to preserve their methods and rendering behavior. Mutating
these shared values or a head function's own module constants can still leak
state between requests.

A custom root's second argument remains `clientScript?: string` in 0.1.x. Read
external module URLs from `props.scripts`; URL arrays never occupy the legacy
string argument. The adapter no longer generates the inline onLoad script or
serves `?script`. Extensions own their client entry URLs.

Responses thrown inside ErrorBoundary now escape to the page handler, preserving
their status, headers, and body (for example a 303 redirect). In 0.0.27 they became
200 HTML containing `<pre>[object Response]</pre>`. Suspense follows the same rule
without streaming; once streaming begins it logs Responses and renders its catch
content because the HTTP status and headers are already sent. Default catches no
longer expose errors or stack traces in HTML. Set `showStack` on a boundary or
Suspense only when that output is desired.

External module scripts execute after the entire Suspense stream finishes. The
client entry waits for document parsing before onLoad, including legacy dynamic
imports. See the browser-handler section for early-event queue semantics.


## htmx action URLs and security (D3/D6/D7)

Configure `htmx({ table, secret })` from `recooler/htmx` as a `createApp` extension
alongside `jsxPages()`. The reachability table maps manifest `route.file` IDs to
registered action-bearing module IDs, including roots, layouts and shared static
imports. The table is static; development invalidates the virtual table and reloads the
server runner to recreate `createApp`, retaining unchanged transforms. Getter mode is
unsupported. Register actions before `createApp`: `actionUrl` throws if an action uses a method
that was not reserved on the rendering route at app creation. Recreate the app
after registering a new method. The Vite integration generates this table; see the [runtime interface](../packages/recooler/src/htmx/README.md).

**D6: all action URLs are now signed**, including actions without captures. The
signature covers the app/environment namespace, external action base, defining
module's versioned source hash, receiving route file, exact pathname, HTTP method,
action ID and serialized scope. Pages cached before this switch contain incompatible
URLs: invalidate those pages and have users refresh them before submitting.
Unknown, unsigned, tampered and replayed-to-another-path URLs fall through after
route middleware and normally return 404 without running an action. A guard's
401 still comes first. Supply a runtime secret string or `secret: env =>
env.ACTION_SECRET`; env functions are cached per env object identity in a WeakMap
(with one fallback slot for non-object envs), never inlined by the transform.
Use a new env object or recreate the app to rotate a key within the same env. Missing/empty secrets fail startup or the first request
with actions. `secret: false` now throws; use `secret: { unsafeUnsigned: true }` only for local
development. This disables D6 replay protection (including unused barrel actions)
while retaining CSRF and reachability checks. The Vite production flag enforces
the startup guard, including custom entries. Each `htmx()` creation in this mode
logs a runtime warning. The Vite plugin derives app
identity from the nearest package.json name and package-relative source directory,
then includes the server environment (plus a per-server nonce in dev). An unnamed
package must set `recooler({ htmx: { namespace: 'my-app' } })` or add a package name;
build and dev startup fail otherwise. Use distinct identities for separate apps.

The virtual app's default `RECOOLER_SECRET` must be provisioned like any other
required secret: set it in `.dev.vars` for local Workers, provision it as a Worker
secret for deployment, or set `process.env.RECOOLER_SECRET` on Node. Provision the
configured `htmx.secretBinding` instead if overridden. Cloudflare v2 also needs a
secret declaration in `worker.env`. Use separate secrets for separate apps and
deployments; the build does not generate or embed a secret.

**D7: action requests require `HX-Request: true`**, including mutating GET actions.
They also require acceptable Fetch Metadata or Origin. Manual requests should
send `HX-Request: true`, `Origin` equal to the destination origin, and
`Sec-Fetch-Site: same-origin`. The request URL's own Origin is accepted when
`Sec-Fetch-Site` is absent. Configure `trustedOrigins` for additional exact origins
or an origin predicate: these are accepted regardless of Fetch Metadata, including
`same-site` and `cross-site`. Same-site alone is insufficient. An untrusted request
with `cross-site` or an empty `Sec-Fetch-Site` is rejected even if its Origin equals
the request URL's origin. Missing or
invalid provenance and missing HX headers return 403 before action execution.
These checks also apply to bodyless, JSON and other non-form requests. Rejections
return 403 directly without entering the application's `onError`.

**D3: actions post to the rendering route.** A component imported from an admin
route and rendered on a public page now submits to the public page's middleware
chain. In 0.0.27 it submitted to the defining route module. Keep authorization in
the rendering route or action when sharing such components. Only page routes
register actions; handler-only routes keep ordinary `action` query parameters.
Forms returned by guard middleware must live on an unguarded route because the
guard always runs before action dispatch. Actions run after directory/group
middleware but before `onRequest`, as in 0.0.27: authorization in `onRequest`
does not protect actions. Move such checks into directory or group middleware.

Use `htmx({ base: '/app', ... })` when `app.mount()` or a prefix-stripping proxy
hides that external prefix. Mount actions without the appropriate base are
unsupported. Omit `base` for `route()` and `basePath()`, whose request pathname
already includes the prefix. URLs preserve exact encoded segments and stay local
even when a root catch-all matches a path starting with `//`.

The lower-level `actionScope` helper now requires the ambient rendering binding;
`configureActions` is replaced by per-extension secrets. The Phase 5 client
extension now supplies `page.scripts`, loads route slices and invokes onLoad as
described below; each slice registers its own handlers.

## Workers behind a path-prefix proxy

When a front Worker proxies `/_admin/*` to a second Worker through a service
binding and strips `/_admin`, set Vite `base: '/_admin/'` in the second app:

```ts
export default defineConfig({
  base: '/_admin/',
  plugins: [cloudflare(), ...recooler({ htmx: { base: '/_admin' } })],
});
```

Vite `base` controls the public client entry, lazy slice imports, modulepreloads
and the legacy inline `import()` URL. `htmx.base` separately restores the stripped
prefix on signed action URLs. Keep the second Worker's own client build output
attached to its asset binding. The front Worker must forward every `/_admin/*`
request, including `/_admin/assets/*`, to that Worker before serving its own
assets. The second Worker then receives `/assets/*` and serves its own entry and
chunks. Do not copy the second app's files into the front Worker's asset set.
Use a rooted base with a trailing slash; relative Vite bases fall back to `/`.

## Browser handlers and custom roots (Phase 5)

Use `...recooler()` from `recooler/vite`. One **`vite build`** now builds the
server followed by the browser environment. Programmatic integrations must use
`createBuilder(config).buildApp()`; Vite's legacy `build(config)` builds a single
environment. Recooler uses its own post `buildApp` hook for plain Vite and leaves
`builder.buildApp` intact. Cloudflare's Worker → client order and asset movement
remain owned by Cloudflare. Recooler shares only its own plugin state between
environments. Read the environments' resolved `build.outDir` values: v1 and v2
use different directories, with v2 under `.cloudflare/output/v0`.

The stable browser entry is `assets/recooler-client.js?v=<buildId>`, relative to
Vite's configured `base` (use a rooted base for nested routes). The server does
not read a client manifest. Serve client output at that base; ensure deployment
caches distinguish the version query. Keep old hashed lazy chunks available for
cached HTML during rolling deployments. The entry's route map and all chunks
are public; lazy loading is a performance choice, not a confidentiality boundary.

The htmx extension contributes `props.scripts: string[]` only for page routes
reaching function handlers or a route `onLoad`. New roots render these URLs:

```tsx
export default Content => props => <html>
  <head>{renderHeadElements(props.head)}</head>
  <body>
    <Content {...props} />
    {props.scripts.map(src => <script type="module" src={src} />)}
  </body>
</html>;
```

`DefaultRootHOC` already does this. The adapter supplies the matched route pattern
through `body[data-recooler-route]` or a `meta[name="recooler-route"]` in the
Content slot for custom roots. Preserve that slot. The marker is a pattern such
as `/users/:id`, without a mount prefix, not the concrete request pathname.

Legacy roots that inline their second `clientScript?: string` argument must
explicitly enable `recooler({ htmx: { legacyClientScript: true } })`. That string
is `import("<entry URL>").then(m=>m.init())`, with HTML-sensitive characters escaped; it is
undefined on handler-free routes. No function-arity detection is attempted. For a
custom `createApp` entry, pass `clients` and `clientEntry` from
`virtual:recooler/htmx` to `htmx({ table, clients, clientEntry, namespace, ... })`,
and set `legacyClientScript: true` there if required. Keep the argument a string;
never pass a URL array into an inline script. A root should use either its legacy
inline string or `props.scripts`. Default roots always render the external URLs.
The shim needs your existing inline-script CSP policy. Migrate off it in 0.1.x.

Load the classic htmx script before the module entry (for example, a non-async
script in the head). Keep application head scripts in their required order;
Recooler does not reorder them. Module scripts execute after the full HTML stream
has parsed, including Suspense's streamed content. The entry also waits for
`DOMContentLoaded` when imported by the legacy shim. It then loads all reachable
slices, lets each register its own handlers, calls the owning route's `onLoad`,
then replays queued events. Layout/root `onLoad` still warns and does not run.
`globalThis.__recooler_ready` is the promise for this sequence, useful for tests
or initialization that must wait for handlers. Loading failures reject it.

Function-valued event attributes install a compact queue before the entry loads.
The queue prevents the original event's default immediately. After onLoad,
handlers replay in order with their element, event data and captured values.
If the handler does not preventDefault, confirm resumes via issueRequest,
submit via requestSubmit(submitter), and anchor/button clicks via click().
Config-request/before-request can restart through htmx.ajax's exposed request
configuration. Events without a continuation/configuration stay cancelled and
warn. currentTarget and other dispatch-time state are unavailable on replay.
With htmx 1.9.12, use `hx-trigger="load delay:1ms"` when load-triggered requests
rely on `hx-on:*` cancellation: that version installs wildcard listeners after
processing synchronous load triggers. One throwing handler is reported without dropping the rest. Already-string
hx-on attributes and their unsafe-eval CSP requirements remain unchanged.

The entry exports init(), runs on start, and initializes new content on
htmx:afterSettle for any changed marker (including HX-Location, hx-push-url and
boost navigation) and htmx:historyRestore. Duplicate events for one marker share
one initialization. Both default
and custom roots include their route/version marker inside the Content slot,
so body swaps discover the new route. The legacy import explicitly calls init()
after cached imports too. Root/layout onLoad is not invoked. Modules reachable
only through server dynamic imports remain outside the static route graph.
Custom roots can render props.preloads as modulepreload links to reduce latency.

Client source maps are off by default and minification defaults on. Set
`environments.client.build.sourcemap: true` to publish maps; these expose only
the redacted client slices, with removed server source and comments blanked
without changing positions. This also applies to inline maps. Set minify in
`environments.client.build` to override it. Unsliced dependencies omit embedded
source contents. The content-derived version is reproducible, embedded in the
entry and checked against the page; mismatches reload before dispatch.

Rename `client_banned_imports` to
`recooler({ htmx: { clientBannedImports: [...] } })`. String patterns remain regular
expressions. The first check matches **raw specifiers** in each retained
handler/`onLoad` reference chain, including literal dynamic imports and global
`require`. The second check matches **resolved paths** from every emitted client
chunk's `moduleIds`, including lazy/shared chunks and transitive side-effect
imports; it also checks package-relative paths after the last `node_modules`
segment. Both checks fail the build. Include resolved-path patterns for aliases
that hide a server-only raw specifier. Raw specifiers are also observed through
transitive client helpers, and browser-external stubs are always banned. These are explicit application bans;
Recooler does not classify arbitrary dependencies as server-only automatically.

Dev edits invalidate the virtual entry and server graph and send a full reload
over Vite's HMR socket. There is no preservation of browser component state.
`playground-vite/` demonstrates this stack alongside the frozen Farm playground.
