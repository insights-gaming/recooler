# recooler/router

```ts
import { createApp } from 'recooler/router';
import { manifest } from './routes.gen.js';

export default createApp(manifest);
```

`createApp` constructs one flat Hono app. It works in plain Node and requires only Hono at
runtime. Route modules can export `onGet`, `onPost`, `onPut`, `onPatch`, `onDelete`,
`onOptions`, and `onRequest`. HEAD uses GET; OPTIONS requires its own handler or onRequest.
A default export is a page only when a `pages` adapter supplies its handler. Handlers and
middleware use normal Hono return values and `await next()` semantics. Fall-through ends in
Hono's not-found handler. Configure Hono options through `hono` and customize the returned
app's `onError`/`notFound` using the API of your Hono version.

`resolveRoutes(manifest)` is pure: it returns `routes`, `middlewares`, `lateMiddlewares`,
`errors`, and `warnings` without constructing Hono. `createApp` rejects errors with
`RouteValidationError` before registration and reports near-miss export warnings via
`options.warn` (defaults to `console.warn`). Namespace exports are authoritative, including
re-exports. An own route `default` export must be a function, even without a page adapter.
Custom parameter patterns must be nonempty and compile as regular expressions; `[[rest]]`
names cannot contain `{`. These errors identify the source file before any requests run.
Manifest version is 1; `layoutFile` and parallel `middlewareFiles` are optional
source ids relative to srcDir in POSIX form; they never determine middleware identity or scope.
`Manifest.rootFile` is optional. Resolved routes expose `layoutFiles` (parallel to layouts,
undefined where metadata was omitted), `rootFile`, and scoped `middlewareFiles` (also
parallel, with undefined for omitted metadata). Middleware arrays are in filename order. Generated
`segment` values retain filesystem names; `path` values have converted params and no groups.

Ordering follows 0.0.27 except that custom regex params always precede plain params.
The segment order is static, custom pattern, plain param, catch-all; `{.+}` and `{.*}` count
as catch-alls. Same-shaped routes put pages first, followed by path and group directory. Pages count as terminal GET handlers in
validation even without an installed page adapter. Extensions' handlers do not count as
terminal conflicts because their fall-through is intentional.

Plain directory middleware registers before routes, shallowest first. Group middleware and
middleware inside groups start each route chain and run once per Context and namespace
identity. Two namespaces re-exporting the same default function still run separately.
Plain directories inside groups also register a trailing prefix use for unmatched requests.
`[id]` and `:id` share the normalized middleware/layout path, as in the reference.

## Extensions and pages

A `RouterExtension` has a name and optional `route(resolvedRoute)` hook, called once at
startup with a frozen copy of the route and its array containers. Namespace identity is
preserved. It can return additional `methods`, `handlers` and `page` extras. Methods are
uppercased; array handlers run only for the declared methods. A handler map such as
`handlers: { POST: [actionHandler] }` also declares its method keys. `ALL` covers every
method, and GET includes HEAD. Handlers follow scoped middleware and precede onRequest
and method dispatch. Extensions with array handlers must declare a nonempty `methods` list, otherwise
startup throws `RouteValidationError`. HEAD declarations register as GET for Hono routing;
their handlers run only for HEAD requests, alongside any GET handlers.
Whether selected handlers should precede scoped middleware remains an open question tied
to htmx D5 (guard-rendered forms).
Action handlers should return their response for a matching action and call `next()` when
the request should reach another handler. Supply all methods that should run the extension,
including methods for which the route has no native handler.

A `PageAdapter` has `handler(route, extras, contributions)`, returning a Hono handler or
undefined. The adapter is called only for routes with an own default export, and its return value is
validated. The route includes namespaces for the page, layouts in **root-to-leaf order** (including
head-only layouts), and optional root. Extras are passed as an array in extension order;
entries without page extras are omitted. The additive third argument contains matching
`{ extension, page }` pairs so adapters can resolve collisions by extension name.
No data is silently merged before the adapter.

The standard merge rule is exported as `mergePageExtras(extras)`: arrays concatenate in
extension order; every other value replaces the previous value for the same key. Objects
are replaced whole, with no deep merge. Array/scalar transitions replace the prior value.
It creates a new record and new array containers without mutating inputs. For example,
`[{ scripts: ['a'], title: 'first' }, { scripts: ['b'], title: 'last' }]` becomes
`{ scripts: ['a', 'b'], title: 'last' }`. Adapters should use this rule for shared page extras
such as scripts; they may interpret extension-specific fields from the ordered entries.

Hono 4.12+ and 5.0.0-rc.1 are exercised by the test projects. Hono 5 uses `hono/mount`
middleware in place of `app.mount()`, and uses Context-based error handlers. Recooler does
not add compatibility methods to the Hono instance.

Use `createApp<MyEnv>(manifest)` to type Hono context variables (for example
`MyEnv = { Variables: { user: User } }`). `app.use()` called after `createApp()` does not
run for matched terminal routes: Hono executes registrations in order. Install request
middleware through the manifest or a parent app before routing the generated app.

Extensions may supply `middleware: Handler[]` to run after scoped guards on every
existing registration, independently of `methods`. This does not add registrations
for unsupported methods. A `reserved(context)` predicate reserves a request from
that route's `onRequest`, method handlers and page: when extension handlers call
`next()`, dispatch continues through later matching registrations and their guards.
This supports action dispatchers that must fall through on an invalid capability.
