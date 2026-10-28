# recooler/vite

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { recooler } from 'recooler/vite';

export default defineConfig({
  plugins: recooler({ routes: { /* srcDir, routesDir, out, check, ... */ } }),
  build: { ssr: 'src/entry.ts' },
});
```

```ts
// src/entry.ts — owned by the application
import app from 'virtual:recooler/app';
export default app;
```

For TypeScript entries, add `/// <reference types="recooler/vite/client" />` to
your `env.d.ts`.

The virtual module exports **only default**, equivalent to
`createApp(manifest, { pages: jsxPages() })`. For custom adapters or extensions,
use your own `createApp` entry and the generated manifest. The plugin array
keeps route generation separate from app wiring; future htmx integration can
add plugins and extensions without replacing the platform's app builder.
The plugin does not yet wire the htmx transform into action dispatch or a client entry.

For a virtual-only SSR build, use `build: { ssr: true, rolldownOptions: {
input: 'virtual:recooler/app' } }`. Vite treats a string `build.ssr` as a real
filesystem path. Ordinary Vite dev users load their entry through Vite's SSR
module runner and serve its `fetch` response using their chosen HTTP adapter.
The Cloudflare plugin serves the Worker entry automatically.

`recooler()` includes `routes()` for build-time generation and dev watching.
`routes: { check: true }` compares committed output instead of writing it.
The standalone `routes(options)` export remains usable for API-only apps.

JSX defaults to the automatic `recooler/jsx` runtime per file. The plugin adds
pragmas only when the file's own tsconfig and pragmas do not select a source or
classic/preserved JSX. Solution-style tsconfig references, nested configs,
JSONC/extends and explicit `oxc.jsx` settings are respected. When `oxc` is unset,
Vite converts legacy `esbuild` options, including `jsxInject`, as usual. Any
other effective runtime warns because it bypasses request-bound Context filtering.

Every server-consumer environment gets `resolve.noExternal` entries for
`recooler` and `easy-jsx-html-engine`: the engine's extensionless internal imports
cannot run as native Node ESM. A [vitefu dependency crawl](https://github.com/svitejs/vitefu)
also bundles packages declaring either package in `dependencies` or
`peerDependencies`, keeping the JSX runtime in the same bundle. Declare consumed
packages in the app's package.json. Undeclared dependencies and packages that
hide their runtime dependency cannot be discovered; add those packages to the
server environment's `resolve.noExternal` manually. Bundling does not rewrite
precompiled imports of a different JSX runtime; recompile or alias those imports
as described in the [JSX README](../jsx/README.md).

With `@cloudflare/vite-plugin`, keep that plugin's normal configuration and
builder. By default every server consumer may import the virtual app, including
Vitest's test environments. Set `serverEnvironment` to restrict imports to one
configured server environment; other environments receive an error. A missing
name or a client consumer is a configuration error. Idle SSR and auxiliary
Worker environments do not force selection. Browser imports are rejected.
Vitest 5's default runner uses `ssr` for app imports. In Cloudflare v1, an
environment's name is its Worker name with hyphens replaced by underscores:
`main-worker` becomes `main_worker`. This does
not change `builder.buildApp` or require `sharedPlugins`.

Dev generation errors are logged once per distinct diagnostic and sent to Vite's
error overlay (including clients connecting after a startup error). Importing the
virtual app throws that diagnostic until generation succeeds; failed or recovered
generation invalidates the app so requests cannot silently use a stale route table.

The virtual app uses the same augmentable `RouteEnv` as page components:

```ts
import 'recooler/jsx';
declare module 'recooler/jsx' {
  interface RouteEnv { Bindings: { API_KEY: string } }
}
```
