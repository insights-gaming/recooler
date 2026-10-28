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

The virtual module exports **only default**, equivalent to
`createApp(manifest, { pages: jsxPages() })`. For custom adapters or extensions,
use your own `createApp` entry and the generated manifest. The plugin array
keeps route generation separate from app wiring; future htmx integration can
add plugins and extensions without replacing the platform's app builder.
There is no htmx transform, action dispatch or client entry yet.

For a virtual-only SSR build, use `build: { ssr: true, rolldownOptions: {
input: 'virtual:recooler/app' } }`. Vite treats a string `build.ssr` as a real
filesystem path. Ordinary Vite dev users load their entry through Vite's SSR
module runner and serve its `fetch` response using their chosen HTTP adapter.
The Cloudflare plugin serves the Worker entry automatically.

`recooler()` includes `routes()` for build-time generation and dev watching.
`routes: { check: true }` compares committed output instead of writing it.
The standalone `routes(options)` export remains usable for API-only apps.

JSX defaults to OXC's automatic runtime with `importSource: 'recooler/jsx'`.
An explicit `oxc.jsx` setting takes precedence; a project's tsconfig
`jsxImportSource` (including JSONC/extends) is also respected. Using
`easy-jsx-html-engine` directly warns because it bypasses the Context-filtering
runtime wrapper. Per-file JSX pragmas remain under the compiler's control.
`recooler` and `easy-jsx-html-engine` are added to `ssr.noExternal`: the engine's
extensionless internal imports cannot run as native Node ESM.

With `@cloudflare/vite-plugin`, keep that plugin's normal configuration and
builder. The configured server entry identifies the Worker environment; an
unused server environment is ignored. Names are never assumed. If multiple
server entries exist, specify `serverEnvironment` explicitly. Importing the
virtual app from another environment is an error. This does not change
`builder.buildApp` or require `sharedPlugins`.
