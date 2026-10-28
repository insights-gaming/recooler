# recooler/gen

```ts
import { generateRoutes, routes } from 'recooler/gen';

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
`importExtension` supports `''`, `'.js'`, or `'.tsx'`; use `.js` for NodeNext compilation.
`--check` compares without writing and exits unsuccessfully when the file is missing/stale.
It can be combined with `--watch` after an initially successful check.

`renderRoutes(options)` scans and returns `{ code, out, files, warnings }` without writing.
`generateRoutes(options)` also returns `changed` and writes only when contents differ.
`watchRoutes(options)` returns `{ close() }` after initial generation and accepts `onResult`
and `onError`. It watches content edits for validation as well as structural changes.
The Vite `routes()` plugin runs before build and on dev add/unlink (including root.tsx),
using Vite's watcher. Generator failures throw `RouteValidationError`; stale checks throw
`StaleRoutesError`. Generated code imports only `recooler/router` types and user namespaces;
loading the manifest and creating an app never require Vite or the generator.

Routes are `index.[jt]sx?`, layouts are `layout.[jt]sx?`, and middleware are
`middleware[@name].[jt]sx?`, ordered by filename. The optional root is srcDir/root.tsx.
Hidden directories are included; symlink directories are not traversed. Group and parameter
conversion follow 0.0.27 exactly, including literal `()` and malformed bracket names.
`[[rest]]` is `:rest{.+}` and requires at least one segment. The reference's conversion regex
does not convert bracket parameters containing `]` internally (for example `[n{[0-9]+}]`).

Export inspection uses oxc-parser's `module.staticExports`, without an AST walk or module
evaluation. Direct exports, aliases, and named re-exports are validated; `export *` is
resolved authoritatively when `createApp` loads the real namespaces. Diagnostics aggregate
independent failures and include filenames. The manifest always imports every recognized
file as a namespace; generated code and RoutePath ordering do not depend on export names.
Changing a valid module body never rewrites the manifest. RoutePath is a union of route
patterns; inferred params and router Register augmentation remain future work.

From the repository root, verify the standalone Node flow with:

```sh
pnpm --filter recooler build
node packages/recooler/test/gen/node-smoke.mjs
```

This exercises the compiled CLI, a TypeScript 7 NodeNext build, actual generated namespaces,
guarded requests, HEAD, 404, stale checks and startup conflicts introduced by `export *`.
