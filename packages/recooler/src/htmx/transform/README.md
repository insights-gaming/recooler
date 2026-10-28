# Bundler-independent htmx transform

```ts
import { transform } from "recooler/htmx/transform";

const result = transform(source, {
  id: "/project/src/routes/index.tsx",
  relativePath: "src/routes/index.tsx",
  mode: "server",
  moduleKind: "route",
  clientBannedImports: [/^node:/, /server-only/],
});

for (const diagnostic of result.diagnostics) {
  // Report start/end offsets against the ORIGINAL source. Errors must fail the build.
  if (diagnostic.severity === "error") throw new Error(diagnostic.message);
}
return { code: result.code, map: result.map };
```

The function is synchronous and pure: no filesystem access, resolver, module graph,
mutable module IDs, or bundler hooks. Input and output are JS/TS/JSX/TSX; run it
before TypeScript/JSX lowering. Use the real source filename for `id`, including in
handler variants. The parser strips an optional query for language detection; the
map retains the supplied `id` as its source and embeds the original content.

`actions` and `handlers` describe **all** discovered functions, regardless of mode.
Each entry has `id`, `exportName`, sorted original capture names, and original
`start`/`end` offsets; actions also have a lowercase HTTP `method`. IDs are
`${relativePath}@${index.toString(36)}`, with separate preorder action and handler
counters. Export names retain decimal counters (`_action$post$36`, `_handler$36`).
Callers supply the same project-relative path in every variant. No route pathname
is needed, and the transform does not normalize or URL-encode this identity.

Errors return the unchanged source and its identity map, plus diagnostics and
available metadata. Callers must reject error diagnostics. Parse errors are also
diagnostics. Warnings do not prevent transformation. Generated export names are
reserved at module scope; injected helpers, captures and props are collision-free.

## Modes

- `full` (default): retain source code, export actions and handlers, and register
  the module's actions. Useful for tests and inspection.
- `server`: retain action exports and rendered handler strings, remove handler
  bodies, and prune their imports. Private declarations reachable exclusively
  from handlers are removed transitively, including their initializers. Exports,
  shared server uses and standalone side effects keep their dependencies alive.
  Explicit side-effect imports are retained.
- `client-slice`: keep handler exports and their breadth-first dependency closure;
  trim partial imports/declarators and type-only imports; remove server code,
  unrelated exports and standalone side effects. Each slice assigns its own
  functions to `globalThis.$handlers`, creating the table if necessary.

Set `moduleKind: "route"` to keep `onLoad` and its dependency closure, including
declarations, local aliases, re-exports and namespace re-exports. `layout` and
`root` report a warning for runtime `onLoad` exports; `component` (the default)
silently drops them from slices. The bundler adapter identifies module kinds.

`clientBannedImports` matches raw specifiers in the retained handler/`onLoad`
closure, including static-string `import()` and **global** `require()` calls.
Nonliteral specifiers and `require.resolve` cannot be checked here. Every affected
root gets a diagnostic with a shortest reference chain. Configuring this option
also runs the check in full/server mode. Patterns supplied as strings are regular
expressions, not glob patterns; `/g` and `/y` flags do not make matching stateful.

The separately exported `moduleIdForms`, `isBannedModule` and `bannedClientModules`
provide the resolved client-graph check for the bundler adapter. Match resolved
paths there, ignoring queries and also checking the path after the last
`node_modules` segment. `bannedClientModules` accepts an adjacency map in import
order and reports shortest module chains, including disconnected banned modules.
The adapter still has to supply the actual bundle graph and reject the results.

## Context, factories, and runtime boundary

The D3 default is emitted in `codegen.ts`:

```ts
actionUrl(id, { capturedName: capturedValue }, optionalContext)
```

The runtime owns ambient request context, absolute URLs, mounts, route parameter
encoding (including catch-all segments), scope serialization/signing and expiry.
`actionScope` is a lower-level runtime contract; the transform passes scope objects
to `actionUrl` instead of concatenating its query fragments itself.

An element/object's explicit `ctx` overrides the URL context. That override applies
only to that element; a nested action uses its enclosing action's first runtime
parameter, adding one when needed and skipping a TypeScript `this` parameter.
Destructured action contexts fall back to ambient context unless explicitly passed.

For 0.0.27 compatibility, `componentContext` defaults to `true`: an outer component's
first props parameter supplies `props.ctx` when present. Destructured/rest props
are rewritten, preserving defaults and annotations; missing props/ctx falls back
to ambient context. Set it to `false` to remove this heuristic and its parameter
rewriting. Explicit `ctx` and enclosing action contexts still work in that mode.
Unlike the old transform, missing component context is not a compile error.

`ctx` attributes, object props and JSX spreads remain for the JSX runtime to filter
Hono Context values when rendering intrinsic elements. There is no `omitCtx` call.

Captured values use scope factories. Their object keys retain the source binding
names; factory locals and references receive unique names so hoisting cannot
introduce shadowing. Local functions/classes cannot be serialized and produce
build errors. `wrapAction` is used for GET; other methods use
`wrapActionWithPayload`. Captured actions pass their ID as the second wrapper
argument, preserving the existing runtime factory contract. Handlers use
`handlerScope` to embed their captured values into the attribute's invocation.

The D5 default emits one side effect per action-bearing module:

```ts
registerActions(moduleId, { post: { "src/routes/index.tsx@0": _action$post$0 } });
```

Both defaults are small exported functions in `codegen.ts` and can be overridden
with `options.codegen.actionUrl` / `registerActions`. Their inputs include a
collision-free local runtime helper name. All generated runtime imports come from
`recooler/htmx/runtime`. That subpath currently contains **declarations only** for
the runtime worker to implement; executing transformed output requires the real
runtime (or the stub used by execution tests).

The bundler worker still owns SSR/client environment integration, action module
reachability, dev invalidation, chunk loading and scheduling `onLoad`. Dynamic
imports are checked in client closures but are not an action-registration graph.

## Source maps and verification

Parsing uses oxc raw transfer only when `rawTransferSupported()` returns true;
`rawTransfer: false` forces the ordinary transfer for tests. Scope analysis uses
`@typescript-eslint/scope-manager` on the ranged oxc AST. Keep the type assertion at
that boundary: their AST types differ even though the runtime shapes agree.

Hoisted functions and rewritten props patterns are moved with magic-string.
Wrappers use `prependRight`/`appendLeft`; replacements are inserted at original
sites with `appendLeft`. Inner functions move before containing ones. Removals
exclude moved subranges instead of overwriting their split ranges. The returned
map is always `generateMap({ hires: true, includeContent: true })`.

Run from the repository root:

```sh
pnpm --filter recooler test
pnpm --filter recooler exec tsc --noEmit
pnpm --filter recooler build
pnpm --filter recooler exec node test/htmx/benchmark.mjs
```

Tests cover exact original line/column mappings through nested hoists and capture
renames in all modes, normalized reference outputs, imports and reference chains,
actual output execution with a stub runtime, and the playground TSX corpus.
The benchmark separately measures parsing, scope analysis, their combined cost,
the indexed frontend, and the full transform with a source map.
