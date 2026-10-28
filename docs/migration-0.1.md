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

Send `HX-Request: true`, a same-origin `Origin`, and
`Sec-Fetch-Site: same-origin` on manual action requests. Revisit CSRF and signed
URL migration when the htmx implementation lands. The legacy two-argument root
compatibility opt-in, exact script string and route marker through `props.head`
remain design work for that phase; see the inventory's plan gaps.
