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
import { deploymentProfiles } from './build-profiles'; // private, explicit maps

export default defineConfig(({ mode }) => {
  const profile = deploymentProfiles[mode];
  if (!profile) throw new Error(`Unknown deployment mode: ${mode}`);
  return {
    plugins: [cloudflare()], // add the recooler plugin when porting the app
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

See the action URL and CSRF migration below for manual action requests. Client
entry loading remains Phase 5 work; the JSX root compatibility contract is
documented below.

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

Until the `recooler/vite` plugin is implemented, explicitly set Vite's JSX
transform import source too:

```ts
export default {
  oxc: { jsx: { runtime: 'automatic', importSource: 'recooler/jsx' } },
};
```

The Vite plugin must default `oxc.jsx.importSource` to `recooler/jsx` or warn when
a different runtime is selected. The htmx transform relies on this runtime to
remove Context values from intrinsic attributes, including props spreads.
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

External module scripts execute after the entire Suspense stream finishes. Phase
5 must account for this onLoad timing difference from the old inline script.


## htmx action URLs and security (D3/D6/D7)

Configure `htmx({ table, secret })` from `recooler/htmx` as a `createApp` extension
alongside `jsxPages()`. The reachability table maps manifest `route.file` IDs to
registered action-bearing module IDs, including roots, layouts and shared static
imports. The table is static; D5 development uses `invalidateAll` and a full SSR
reload to re-evaluate the virtual table and recreate `createApp`. Getter mode is
unsupported. The Vite integration will provide this table later; see the [runtime interface](../packages/recooler/src/htmx/README.md).

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
while retaining CSRF and reachability checks. The Phase 4b Vite plugin must reject
this mode in production using the exported `unsafeUnsignedMarker` on the extension.
The plugin must also provide a stable per-project namespace to both
`registerActions(moduleId, methods, namespace)` and `htmx({ namespace, ... })`; the
default namespace remains shared for compatibility with current transform output.

**D7: action requests require `HX-Request: true`**, including mutating GET actions.
They also require acceptable Fetch Metadata or Origin. Manual requests should
send `HX-Request: true`, `Origin` equal to the destination origin, and
`Sec-Fetch-Site: same-origin`. An allowed Origin is accepted only when
`Sec-Fetch-Site` is absent; `same-site` alone is insufficient. Configure
`trustedOrigins` for additional exact origins or an origin predicate. Missing or
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
`configureActions` is replaced by per-extension secrets. `page.scripts` is empty
until Phase 5 supplies the client entry. Client handler slices already register
their own handlers; loading those slices and invoking onLoad remain Phase 5 work.
