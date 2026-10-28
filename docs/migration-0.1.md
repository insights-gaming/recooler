# Migrating to recooler 0.1

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
