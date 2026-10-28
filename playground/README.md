# TypeScript playground

The public Farm playground ported to `@insights-gaming/recooler` 0.1.0 / Vite 8.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter recooler build
pnpm --filter playground dev
# Or build both server/client and execute the built-app checks:
pnpm --filter playground build
pnpm --filter playground check
pnpm --filter playground typecheck
```

Open the printed dev URL. The head loads the local htmx asset before Recooler's
module entry. The home page has a signed greeting action, a `this`-based counter
handler, and `onLoad`; its database import is excluded from browser chunks. Dev
uses a fixture-only signing key supplied at request time. Set your own runtime
`RECOOLER_SECRET` when serving the built server. Serve `dist/client` as static
assets alongside `dist/server/app.mjs`; server-emitted assets are in
`dist/server/assets`. The Node HTTP adapter in `vite.config.ts` is for this demo.

The checks execute emitted ESM in a native module VM with a Happy DOM document,
exercise the rendered event attribute, call the built signed action, and inspect
all emitted client chunks for database/server runtime markers. Client initialization
uses full-page navigation; keep route-changing links outside inherited hx-boost.
