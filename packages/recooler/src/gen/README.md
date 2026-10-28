# recooler/gen

```ts
import { generateRoutes } from 'recooler/gen';
import { routes } from 'recooler/vite';

await generateRoutes({ importExtension: '.js' });
// vite.config.ts
export default { plugins: [routes({ importExtension: '.js' })] };
```

```sh
recooler-routes generate
recooler-routes generate --check
recooler-routes generate --watch
recooler-routes generate --src-dir src --routes-dir src/routes --out src/routes.gen.ts --import-extension .js --no-route-types
```

The defaults are `srcDir: 'src'`, `routesDir: srcDir + '/routes'`, `out: srcDir +
'/routes.gen.ts'`, `importExtension: ''`, and `routeTypes: true`. Relative paths resolve
against `cwd` (process.cwd() for the API/CLI, Vite's resolved root for the plugin).
`importExtension` supports `''` (extensionless), `'.js'`, or `'source'` (keep the actual
`.ts`, `.tsx`, `.js`, or `.jsx` extension). The former `.tsx` option is replaced by `source`.
Use `.js` for NodeNext compilation with JSX transformed to JavaScript; `.jsx` sources keep
`.jsx` so Vite can resolve them. Source mode suits Vite or TypeScript configurations that
allow TypeScript source extensions.
`--check` compares without writing and exits unsuccessfully when the file is missing/stale. CRLF and LF line endings compare equally.
It can be combined with `--watch` after an initially successful check.

`renderRoutes(options)` scans and returns `{ code, out, files, warnings }` without writing.
`generateRoutes(options)` also returns `changed` and writes only when contents differ.
`watchRoutes(options)` returns `{ close(): Promise<void> }` after initial generation and accepts `onResult`
and `onError`. The optional `onReady` callback runs after the native watchers observe
readiness events, before initial generation; await that signal before mutating files while
initial generation is still pending. Awaiting `watchRoutes` itself also guarantees readiness. Await `close()` to finish any in-flight generation. Initial generation and
debounced events are serialized. Routes can live outside a missing srcDir; its existing
ancestors are watched non-recursively until the source directory appears. It watches
content edits for validation as well as structural changes.
The `recooler/vite` `routes()` plugin runs before build and on dev add/unlink/change
(including root.tsx), using Vite's watcher. Build failures throw; serve-mode failures are
logged so the dev server can start and `createApp` can validate loaded namespaces.
Generator failures throw `RouteValidationError`; stale checks throw
`StaleRoutesError`. Generated code imports only `recooler/router` types and user namespaces;
loading the manifest and creating an app never require Vite or the generator.

Routes are `index.[jt]sx?`, layouts are `layout.[jt]sx?`, and middleware are
`middleware[@name].[jt]sx?`, ordered by filename. The optional root is srcDir/root.tsx.
Hidden directories are included; symlink directories are not traversed. Literal `()` is
preserved. `[param]` becomes `:param`; `[n{[0-9]+}]` supports brackets within balanced
pattern braces. `[[rest]]` is `:rest{.+}` and requires at least one segment. Unconvertible
`[`…`]` directory names are build errors, as are directory names containing `\`, `%`,
`#`, or `?`. Use `[0-9]` instead of `\d` in portable digit patterns. Middleware names
support Unicode alphabetic, mark, decimal-digit, connector-punctuation and join-control
characters plus `-`. Unrecognized `middleware*` files produce warnings.

Export inspection uses oxc-parser's `module.staticExports`, without an AST walk or module
evaluation. Direct exports, aliases, and named re-exports are validated; `export *` is
resolved authoritatively when `createApp` loads the real namespaces. Diagnostics aggregate
independent failures and include filenames. The manifest always imports every recognized
file as a namespace; generated code and RoutePath ordering do not depend on export names.
Import identifiers derive from srcDir-relative POSIX paths with collision-resistant hashes,
so inserting a route preserves existing identifiers. Source ids for routes, layouts, root
and middleware use those same relative paths. Changing a valid module body never rewrites the manifest. RoutePath is a union of route
patterns; inferred params and router Register augmentation remain future work.

From the repository root, verify the standalone Node flow with:

```sh
pnpm --filter recooler build
node packages/recooler/test/gen/node-smoke.mjs
```

This exercises the compiled CLI, a TypeScript 7 NodeNext build, actual generated namespaces,
guarded requests, HEAD, 404, stale checks and startup conflicts introduced by `export *`.

Colon parameter directories such as `:id` are supported, but the generator warns
that `:` names are not portable to Windows. Prefer `[id]` for portable checkouts.
