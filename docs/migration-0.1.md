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

Send `HX-Request: true`, a same-origin `Origin`, and
`Sec-Fetch-Site: same-origin` on manual action requests. Revisit CSRF and signed
URL migration when the htmx implementation lands. The legacy two-argument root
compatibility opt-in, exact script string and route marker through `props.head`
remain design work for that phase; see the inventory's plan gaps.

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

External module scripts execute after the entire Suspense stream finishes. Phase
5 must account for this onLoad timing difference from the old inline script.
