# Published 0.0.27 HTML oracle

These expected HTML files were captured with the **published**
`farm-plugin-recooler@0.0.27`, `@farmfe/core@1.7.11`,
`@farmfe/plugin-react@1.2.6`, `easy-jsx-html-engine@0.1.13`, and
`hono@4.13.14`, on Node 22.22.2 / macOS arm64. The full oracle dependency graph
is recorded in `farm-pnpm-lock.yaml`. No local Rust binary or modified helper
was used. `persistentCache` is false and decorators are not enabled.

Reproduce from the repository root (Farm resolves/scans relative to cwd):

```sh
fixtures="$PWD/test/jsx/fixtures"
oracle="$(mktemp -d "${TMPDIR:-/tmp}/recooler-jsx-oracle.XXXXXX")"
cp "$fixtures/farm-package.json" "$oracle/package.json"
cp "$fixtures/farm-pnpm-lock.yaml" "$oracle/pnpm-lock.yaml"
cp "$fixtures/capture-farm.mjs" "$oracle/capture-farm.mjs"
# Approvals remain explicit; core-js needs no postinstall for this fixture.
printf 'allowBuilds:\n  core-js: false\n' > "$oracle/pnpm-workspace.yaml"
pnpm --dir "$oracle" install --frozen-lockfile
node "$oracle/capture-farm.mjs" "$fixtures"
```

`capture-farm.mjs` builds both fixture applications with Farm and requests:

- default-root `/`: escaping and all head element kinds, object replacement
- default-root `/nested/42?x=1`: outer/inner layouts, head-only alias export,
  head function extension, context and URL props
- default-root `/replace`: head replacement and a non-default charset
- custom-root `/`: root head extension and a legacy onLoad client script

Type imports point at the adapter solely to typecheck fixtures in this workspace;
Farm erases them. The custom root keeps the verbatim 0.0.27 implementation and its optional string
argument. Its legacy inline branch runs only in the Farm capture.

`equivalence.test.ts` imports these exact page/layout namespaces into a handwritten
router manifest. It compares complete strings after exactly these intended changes:

1. The default root adds `data-recooler-route` to body, valued with the manifest
   pattern (route groups stripped). A custom body gets a
   `meta[name=recooler-route]` at the start of its Content slot; a root wrapping
   `DefaultRootHOC` uses only its body marker.
2. Deep head isolation protects against mutations by later head functions through
   `prev`. 0.0.27 leaked these mutations across requests and routes.
3. A head from `export * from` is applied; 0.0.27 ignored it.
4. The `?script` endpoint is gone.
5. The legacy inline onLoad script is gone; the htmx extension's future URL entry
   owns loading and invoking onLoad.
6. A Response thrown inside ErrorBoundary returns its status (for example 303),
   instead of 200 with `<pre>[object Response]</pre>`. See
   [the migration guide](../../../docs/migration-0.1.md).
7. `RouteProps` gains `params`, `route`, `scripts`, and `clientScript`. They are visible if a
   page spreads all its props onto an HTML element.

There is no whitespace normalization or broad script/attribute stripping.
`exports/` separately covers real namespace imports for the head export forms.
`runtime-wrapper.tsx` compiles actual props spreads with `@insights-gaming/recooler/jsx` as its
import source; it receives no htmx transform.
