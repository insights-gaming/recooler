# Recooler

Recooler is a server-side-only framework designed around [htmx](https://htmx.org/) and [hono](https://hono.dev/) with async JSX components made to feel like PHP.

The name recooler is an homage to the htmx predecessor [intercooler](https://intercoolerjs.org/).

Since 0.1, recooler is a set of TypeScript modules and a [Vite](https://vite.dev/) 8 plugin. It replaces the Rust [Farm](https://www.farmfe.org/) plugin published as `farm-plugin-recooler` up to 0.0.27. To upgrade from that plugin, see the [migration guide](docs/migration-0.1.md).

## Quick Start

```sh
pnpm add recooler hono easy-jsx-html-engine htmx.org
pnpm add -D vite
```

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { recooler } from 'recooler/vite';

export default defineConfig({
  plugins: recooler(),
  build: { ssr: 'src/entry.ts' },
});
```

```ts
// src/entry.ts
export { default } from 'virtual:recooler/app';
```

```ts
// src/env.d.ts
/// <reference types="recooler/vite/client" />
```

Pages are the default exports of `index.tsx` files under `src/routes`. A function passed to an `hx-*` attribute becomes a signed form action that runs on the server:

```tsx
// src/routes/posts/[id]/index.tsx
import type { RouteProps } from 'recooler/jsx';

export default function Post({ ctx }: RouteProps) {
  return (
    <div>
      <h1>Post {ctx.req.param('id')}</h1>
      <button hx-post={() => <p>liked</p>}>like</button>
    </div>
  );
}
```

htmx itself is loaded like any other script, for example from the head of the optional root module:

```tsx
// src/root.tsx
import htmxURL from 'htmx.org/dist/htmx.min.js?url';
import type { RouteHead } from 'recooler/jsx';

export const head: RouteHead = { title: 'Recooler', scripts: [{ src: htmxURL }] };
```

Action URLs are signed with the `RECOOLER_SECRET` binding of the request environment (or `process.env` on Node), so set it in every environment that serves the app.

With [`@cloudflare/vite-plugin`](https://developers.cloudflare.com/workers/vite-plugin/), keep that plugin's usual configuration next to `recooler()` and point the Worker's `main` at the entry. [`playground/`](playground) is a complete Node example.

## Documentation

| Module | |
| --- | --- |
| [`recooler/vite`](src/vite/README.md) | Vite plugin: route generation, JSX, htmx actions and client event handlers |
| [`recooler/router`](src/router/README.md) | builds a Hono app from the route manifest; runs without Vite |
| [`recooler/gen`](src/gen/README.md) | standalone route manifest generator and `recooler-routes` CLI |
| [`recooler/jsx`](src/jsx/README.md) | JSX pages, layouts, head functions and the root component |
| [`recooler/htmx`](src/htmx/README.md) | signed action dispatch and the runtime interface |

## Development

```sh
pnpm install
pnpm run build              # emits dist/, which the conformance suite and the playground load
pnpm run typecheck
pnpm run test
pnpm run test:conformance   # compares behaviour with farm-plugin-recooler 0.0.27
```

The client regression tests need a Chromium for Playwright (`pnpm exec playwright install chromium`).

## About

The inspiration for this project came from my nostalgia for my childhood days as a PHP main. I wanted to bring back the experience of writing server-side logic in-line with the client-side markup without the mess of interleaving JS and PHP. Recooler is the manifestation of that idea built on top of modern technologies and tooling for JS.

## Disclaimer

This is my side project that I'm using for my other personal projects. While I do use it in a "production" capacity, it is nowhere near "battle-tested". I am not responsible for any damage that may occur from using this project. Use at your own risk.

Pull requests are welcome, but please be nice.
