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
`CLOUDFLARE_ENV=production vite build --mode production`. Keep production and local
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
imports. The table is static; D5 development uses `invalidateAll` and a full SSR
reload to re-evaluate the virtual table and recreate `createApp`. Getter mode is
unsupported. Register actions before `createApp`: `actionUrl` throws if an action uses a method
that was not reserved on the rendering route at app creation. Recreate the app
after registering a new method. The Vite integration provides this table automatically; see the [runtime interface](../packages/recooler/src/htmx/README.md).

**D6: all action URLs are now signed**, including actions without captures. The
signature covers the receiving route file, exact pathname, HTTP method, action
ID and serialized scope. Pages cached before this switch contain incompatible
URLs: invalidate those pages and have users refresh them before submitting.
Unknown, unsigned, tampered and replayed-to-another-path URLs fall through after
route middleware and normally return 404 without running an action. A guard's
401 still comes first. Supply a runtime secret string or `secret: env =>
env.ACTION_SECRET`; env functions are cached per env object identity in a WeakMap
(with one fallback slot for non-object envs), never inlined by the transform.
Use a new env object or recreate the app to rotate a key within the same env. Missing/empty secrets fail startup or the first request
with actions. `secret: false` now throws; use `secret: { unsafeUnsigned: true }` only for local
development. This disables D6 replay protection (including unused barrel actions)
while retaining CSRF and reachability checks. Production Vite builds define a flag that makes `htmx()` reject this mode at
startup, including custom entries, unless `allowUnsignedInProduction: true` is
explicitly set. Each unsigned extension logs a warning and exposes the
`unsafeUnsignedMarker` for runtime tooling; no Worker execution during the build
is required.
The plugin must also provide a stable per-project namespace to both
`registerActions(moduleId, methods, namespace)` and `htmx({ namespace, ... })`; the
default namespace remains shared for compatibility with current transform output.

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
is exactly `import("<entry URL>")`, with HTML-sensitive characters escaped; it is
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
slices, lets each register its own handlers, replays queued events, and calls only
the owning route's `onLoad`. Layout/root `onLoad` still warns and does not run.
`globalThis.__recooler_ready` is the promise for this sequence, useful for tests
or initialization that must wait for handlers. Loading failures reject it.

Function-valued event attributes now install a tiny queue on first invocation,
even before the entry itself executes. It retains the original element (`this`),
event object and captured values, and replays in order after the route's slices
load. Replay is asynchronous: `preventDefault()`, immediate return values and
transient event properties such as `currentTarget` cannot be relied on for queued
events. Disable early interactions when those semantics matter. Already-string
`hx-on:` attributes are left unchanged. htmx's evaluation of event attributes still
requires the appropriate `unsafe-eval` CSP allowance, independently of the external
module-script policy.

Client route initialization is **full-page navigation only** in 0.1.0. Same-route
htmx actions/swaps may use handlers already in that route's static closure, but
route-changing `hx-boost`/swaps do not select new slices or rerun `onLoad`. Use
`hx-boost="false"` on navigation links (including under inherited boosting) and a
normal browser navigation, or issue an htmx `HX-Redirect` response. Merely changing
a route marker after a swap does not initialize the new route. Modules reachable
only through server dynamic imports are outside the static route graph.

Rename `client_banned_imports` to
`recooler({ htmx: { clientBannedImports: [...] } })`. String patterns remain regular
expressions. The first check matches **raw specifiers** in each retained
handler/`onLoad` reference chain, including literal dynamic imports and global
`require`. The second check matches **resolved paths** from every emitted client
chunk's `moduleIds`, including lazy/shared chunks and transitive side-effect
imports; it also checks package-relative paths after the last `node_modules`
segment. Both checks fail the build. Include resolved-path patterns for aliases
that hide a server-only raw specifier. These are explicit application bans;
Recooler does not classify arbitrary dependencies as server-only automatically.

Dev edits invalidate the virtual entry and server graph and send a full reload
over Vite's HMR socket. There is no preservation of browser component state.
`playground-vite/` demonstrates this stack alongside the frozen Farm playground.

## Practical Worker port checklist

Use an ESM Vite config (`vite.config.mts`, or `.ts` inside a package with
`"type": "module"`). Pin compatible platform peers together: Cloudflare plugin
1.65.0 requires Wrangler `^4.152.0`; the verified Vite target is 8.3.5. Remove
unused Farm dependencies and their pnpm patches. Keep the package's PostCSS
configuration; Vite reads it directly without the Farm PostCSS plugin. Vite
reserves the mode name `local`, so use a name such as `preview` for a local build
profile. Update dev, build, deploy and Wrangler-manifest entry/build commands,
including any generator that owns the Wrangler JSON. Rebuild before deploying
through Vite's generated Wrangler configuration; an old `dist/main.js` reference
is no longer the source entry.

A custom Farm `route_handler_factory` becomes a `jsxPages(options)` adapter in
an application-owned entry. The virtual app does not accept custom page-adapter
options. Preserve streamed-template and cleanup hooks explicitly:

```ts
import { createApp } from 'recooler/router';
import { jsxPages, type RouteEnv } from 'recooler/jsx';
import { htmx } from 'recooler/htmx';
import { manifest } from './routes.gen';
import { table, clients, clientEntry, namespace } from 'virtual:recooler/htmx';

const pages = jsxPages({
  ResolvedTemplate: /* your existing resolved-template component */ undefined,
  suspenseCleanupScriptMiddleware: script => script,
});
export default createApp<RouteEnv>(manifest, {
  pages,
  extensions: [htmx<RouteEnv>({
    table, clients, clientEntry, namespace,
    secret: env => env.RECOOLER_SECRET,
    legacyClientScript: true, // only when the root still inlines argument two
  })],
});
```

Declare `RECOOLER_SECRET: string` in the application's Worker Bindings (and in
its `RouteEnv` augmentation). Supply `htmx<YourEnv>` explicitly when a custom
entry needs a typed binding callback; the surrounding `createApp<YourEnv>` does
not infer that generic for a nested call. Provision the binding for every Worker
that renders or dispatches actions. Do not turn it into a Vite define. Import
`Suspense`, `ErrorBoundary` and `renderHeadElements` from `recooler/jsx` in place
of the old helpers module.

The old global `HonoContext`, `FormActionFn` and `EventHandlerFn` declarations
are gone along with the ambient route types. Import `RouteContext` (or Hono's
`Context<YourEnv>`) and the callback types from `recooler/jsx`; its automatic
runtime supplies contextual types for inline htmx attributes. Tests that mock
`easy-jsx-html-engine/jsx-runtime` to inspect JSX nodes must mock
`recooler/jsx/jsx-runtime` after changing the import source. `RouteProps` gained
`params`, `route` and `scripts`; helper components that only need `ctx` and `url`
should use `Pick<RouteProps, 'ctx' | 'url'>` rather than omitting a few fields
from the full page contract.

When linking a checkout, keep Hono's resolved peer version consistent with the
application. Separate versions can have incompatible private request brands in
their TypeScript declarations. A package-manager link also retains its own
runtime dependency resolution; verify both declarations and the emitted bundle.
Absolute `link:` dependencies may be serialized as relative lockfile paths.
Check those paths after moving or cloning a temporary workspace, especially with
frozen installs.

htmx 2's normal XHR headers include `HX-Request: true` and `HX-Current-URL`.
`HX-Current-URL` is **not** a substitute for the provenance check. Browsers send
`Sec-Fetch-Site: same-origin` for same-origin requests; scripts cannot set that
Fetch Metadata header themselves. Non-browser/manual clients must send the HX
header plus a matching `Origin` (or valid Fetch Metadata in test clients).
Do not use `hx-request='{"noHeaders":true}'` for actions. A cross-origin frontend
also needs an explicit `trustedOrigins` configuration and its normal CORS setup.

The router now composes terminal handlers with Hono finalization semantics. A
handler that returns undefined without setting `ctx.res` or calling `next()`
produces Hono's "Context is not finalized" error response. In 0.0.27, outer
`return await next()` middleware could instead leak a non-Response context and
make HEAD throw a RangeError. Return a Response, set `ctx.res`, or call `next()`
explicitly. Error responses pass through the application's `onError` as usual.

Signed action URLs require an active rendering request. Do not evaluate
action-bearing JSX at module initialization (including a header passed eagerly
into a page HOC): the engine evaluates component functions immediately, and
`actionUrl` then throws "Context is not available". Change, for example,
`CollectionPage(<Header><ActionButton /></Header>, query)` to
`CollectionPage(() => <Header><ActionButton /></Header>, query)` when that HOC
accepts a component, or move the JSX into its request-time render function.
Keep action source order stable while making this mechanical change.

Diagnostic bodies containing `Error.stack` change with the Vite/Rolldown bundle,
including function names, generated line/column locations and framework frames.
This is an intended build-format change, even when the error's message, HTTP
status and application invocation sequence are identical. Review these bodies
explicitly in equivalence reports; do not normalize all text/JSON responses or
silence other byte differences. Applications that need stable diagnostic APIs
should return structured error messages instead of generated stacks.

Vite's CSS output has its own `build.cssMinify` switch, independent of JavaScript
`build.minify`. Set it explicitly when preserving readable CSS strings. Even
without minification, Vite/PostCSS may serialize whitespace/comments differently
and omit Farm's inline CSS source map; compare parsed rules and declarations
when reviewing those exact byte changes.

`signActionUrl` deliberately encodes an explicit scope object, defaulting to `{}`,
even for capture-free actions. A raw legacy captured-action probe with no `scope`
therefore changes from "missing action scope" to invoking the factory with an
empty object when minted through this helper. Such a probe supplies no business
capture data. Test real captured submissions using the complete rendered URL or
an explicit synthetic scope, and keep any raw-probe difference narrowly listed
in the private equivalence expectations. Never reuse cached 0.0.27 action IDs
or URLs: compiler source roots may also change their module-ID prefix.
