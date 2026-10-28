import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateRoutes, renderRoutes, StaleRoutesError, watchRoutes } from '../../src/gen/index.js';
import { routes } from '../../src/vite/index.js';
import { main } from '../../src/gen/cli.js';
const temporary: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture(files: Record<string, string> = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'recooler-gen-'));
  temporary.push(cwd);
  await mkdir(path.join(cwd, 'src/routes'), { recursive: true });
  for (const [file, source] of Object.entries(files)) await put(cwd, file, source);
  return cwd;
}
async function put(cwd: string, file: string, source: string) {
  const full = path.join(cwd, file); await mkdir(path.dirname(full), { recursive: true }); await writeFile(full, source);
}
const page = 'export default () => <p/>;';
const handler = 'export const onPost = () => {};';
const middleware = 'export default async (c, next) => { await next(); };';

it('snapshots groups, params, rest params, layouts, root and sorted middleware', async () => {
  const cwd = await fixture({
    'src/root.tsx': 'export default Root;', 'src/routes/index.tsx': page,
    'src/routes/(v2.0)/layout.tsx': 'export const head = {};',
    'src/routes/(v2.0)/middleware.ts': middleware,
    'src/routes/(v2.0)/posts/[post-id]/index.tsx': page,
    'src/routes/(v2.0)/posts/middleware@20-db.ts': middleware,
    'src/routes/(v2.0)/posts/middleware@10-auth.ts': middleware,
    'src/routes/docs/[[rest]]/index.ts': 'export function onGet() {}',
    'src/routes/.well-known/security.txt/index.js': 'export { handler as onGet };',
    'src/routes/[n{a+}]/index.ts': 'export const onDelete = () => {};',
  });
  const result = await generateRoutes({ cwd, importExtension: '.js' });
  expect(result.changed).toBe(true);
  expect(result.code).toMatchSnapshot();
  expect(await readFile(result.out, 'utf8')).toBe(result.code);
  const firstStat = await stat(result.out);
  expect((await generateRoutes({ cwd, importExtension: '.js' })).changed).toBe(false);
  expect((await stat(result.out)).mtimeMs).toBe(firstStat.mtimeMs);
});

it('does not change output when exports, handlers or page bodies change', async () => {
  const cwd = await fixture({ 'src/routes/index.tsx': page, 'src/routes/layout.tsx': '' });
  const first = await generateRoutes({ cwd });
  await put(cwd, 'src/routes/index.tsx', 'const get = () => {}; export {get as onGet}; export const onOptions = () => {};');
  await put(cwd, 'src/routes/layout.tsx', 'export default () => {}; export const head = {};');
  const second = await generateRoutes({ cwd });
  expect(second.changed).toBe(false); expect(second.code).toBe(first.code);
});

it.each(['', '.js', 'source'] as const)('supports importExtension %j', async extension => {
  const cwd = await fixture({ 'src/routes/index.jsx': page });
  const result = await renderRoutes({ cwd, importExtension: extension });
  expect(result.code).toContain(`from "./routes/index${extension === '' ? '' : '.jsx'}";`);
});

it('supports custom paths outside src and optional route types', async () => {
  const cwd = await fixture({ 'api/(g)/[id]/index.ts': handler, 'source/root.tsx': 'export default Root;' });
  const result = await generateRoutes({ cwd, srcDir: 'source', routesDir: 'api', out: 'generated/routes.ts', routeTypes: false, importExtension: '.js' });
  expect(result.out).toBe(path.join(cwd, 'generated/routes.ts'));
  expect(result.code).toContain('from "../api/(g)/[id]/index.js"');
  expect(result.code).toContain('file: "../api/(g)/[id]/index.ts"');
  expect(result.code).toContain('from "../source/root.js"');
  expect(result.code).not.toContain('RoutePath');
});

it('handles an empty routes tree and no root', async () => {
  const result = await renderRoutes({ cwd: await fixture() });
  expect(result.files).toEqual([]); expect(result.code).toContain('RoutePath = never'); expect(result.code).not.toContain('root:');
});

it('deduplicates RoutePath entries for groups', async () => {
  const result = await renderRoutes({ cwd: await fixture({ 'src/routes/(a)/index.tsx': page, 'src/routes/(b)/index.ts': handler }) });
  expect(result.code).toContain('export type RoutePath = "/";');
});

it.each([
  [{ 'src/routes/index.ts': handler, 'src/routes/index.jsx': page }, 'only one route file may be used per directory'],
  [{ 'src/routes/layout.tsx': '', 'src/routes/layout.js': '' }, 'only one layout file may be used per directory'],
  [{ 'src/routes/[id]/index.ts': '', 'src/routes/:id/index.ts': '' }, 'only one route may be used per path'],
  [{ 'src/routes/[id]/layout.ts': '', 'src/routes/:id/layout.ts': '' }, 'only one layout may be used per path'],
  [{ 'src/routes/[id]/index.tsx': page, 'src/routes/[slug]/index.tsx': page }, 'match the same requests'],
  [{ 'src/routes/(a)/index.tsx': page, 'src/routes/(b)/index.ts': 'export const onGet = () => {};' }, 'both respond to GET'],
  [{ 'src/routes/(a)/index.tsx': page, 'src/routes/(b)/index.ts': 'export const onRequest = () => {};' }, 'both respond to GET'],
  [{ 'src/routes/middleware.ts': 'export const mw = () => {};' }, 'has no default export'],
  [{ 'src/routes/middleware.ts': 'export type {Middleware as default} from "./mw";' }, 'has no default export'],
  [{ 'src/routes/index.tsx': 'export default (' }, 'routes/index.tsx'],
] as [Record<string, string>, string][])('reports every build error with source files: %s', async (files, message) => {
  const cwd = await fixture(files);
  let error: unknown;
  try { await generateRoutes({ cwd }); } catch (caught) { error = caught; }
  expect(String(error)).toContain(message);
  expect(String(error)).not.toContain(cwd);
  for (const file of Object.keys(files)) expect(String(error)).toContain(file.replace(/^src\//, ''));
  await expect(stat(path.join(cwd, 'src/routes.gen.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('collects independent errors rather than stopping at the first directory', async () => {
  const cwd = await fixture({
    'src/routes/a/index.ts': '', 'src/routes/a/index.js': '', 'src/routes/b/layout.ts': '', 'src/routes/b/layout.jsx': '',
    'src/routes/c/middleware.ts': '', 'src/routes/d/middleware.ts': '',
  });
  await expect(generateRoutes({ cwd })).rejects.toThrow(/route file[\s\S]*layout file[\s\S]*c\/middleware[\s\S]*d\/middleware/);
});

it('finds aliases, named re-exports and default exports from staticExports only', async () => {
  const cwd = await fixture({
    'src/routes/(a)/index.ts': 'const get = () => {}; export { get as onGet }; export type {Thing as onPost} from "./types";',
    'src/routes/(b)/index.ts': 'export { real as onPost } from "./real";',
    'src/routes/middleware.ts': 'export { mw as default } from "./real";',
  });
  await expect(generateRoutes({ cwd })).resolves.toMatchObject({ changed: true });
  await put(cwd, 'src/routes/(b)/index.ts', 'export { real as onGet } from "./real";');
  await expect(generateRoutes({ cwd })).rejects.toThrow('both respond to GET');
});

it('warns on near misses and excludes type exports', async () => {
  const cwd = await fixture({ 'src/routes/index.ts': 'export const onget = () => {}; export type onPost = string;' });
  expect((await renderRoutes({ cwd })).warnings).toEqual(['WARNING: found export onget but expected onGet in routes/index.ts']);
});

it('validates the routes directory option', async () => {
  const cwd = await fixture();
  await expect(generateRoutes({ cwd, routesDir: 'missing' })).rejects.toThrow('invalid routesDir');
});

it('--check detects missing, added, removed and renamed files without writing', async () => {
  const cwd = await fixture({ 'src/routes/index.ts': '' });
  await expect(generateRoutes({ cwd, check: true })).rejects.toBeInstanceOf(StaleRoutesError);
  await expect(stat(path.join(cwd, 'src/routes.gen.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
  const first = await generateRoutes({ cwd });
  await expect(generateRoutes({ cwd, check: true })).resolves.toMatchObject({ changed: false });
  await put(cwd, 'src/routes/new/index.ts', handler);
  await expect(generateRoutes({ cwd, check: true })).rejects.toThrow('is stale');
  expect(await readFile(first.out, 'utf8')).toBe(first.code);
  await generateRoutes({ cwd });
  await rm(path.join(cwd, 'src/routes/new'), { recursive: true });
  await expect(generateRoutes({ cwd, check: true })).rejects.toThrow('is stale');
  await generateRoutes({ cwd });
  await rm(path.join(cwd, 'src/routes/index.ts'));
  await put(cwd, 'src/routes/index.js', '');
  await expect(generateRoutes({ cwd, check: true })).rejects.toThrow('is stale');
});

it('runs the CLI, including --check and option errors', async () => {
  const cwd = await fixture({ 'src/routes/index.ts': handler });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const args = ['generate', '--src-dir', path.join(cwd, 'src'), '--routes-dir', path.join(cwd, 'src/routes'), '--out', path.join(cwd, 'output.ts'), '--import-extension', '.js', '--no-route-types'];
  expect(await main([...args, '--check'])).toBe(1);
  expect(error).toHaveBeenCalledWith(expect.stringContaining('is stale'));
  expect(await main(args)).toBe(0);
  expect(await main([...args, '--check'])).toBe(0);
  expect(await readFile(path.join(cwd, 'output.ts'), 'utf8')).not.toContain('RoutePath');
  expect(await main(['generate', '--out'])).toBe(1);
  expect(await main(['generate', '--import-extension', '.bad'])).toBe(1);
  expect(await main(['generate', '--typo'])).toBe(1);
  expect(await main(['wrong'])).toBe(1);
});

it('watches additions, removals and root changes using fs.watch', async () => {
  const cwd = await fixture({ 'src/routes/index.ts': '' });
  const results: string[] = [], errors: unknown[] = [];
  const watcher = await watchRoutes({ cwd, onResult: result => results.push(result.code), onError: error => errors.push(error) });
  try {
    await put(cwd, 'src/routes/hello/index.ts', handler);
    await vi.waitFor(() => expect(results.at(-1)).toContain('routes/hello/index'), { timeout: 3000 });
    await put(cwd, 'src/root.tsx', 'export default Root;');
    await vi.waitFor(() => expect(results.at(-1)).toContain('root:'), { timeout: 3000 });
    await rm(path.join(cwd, 'src/routes/hello'), { recursive: true });
    await vi.waitFor(() => expect(results.at(-1)).not.toContain('routes/hello/index'), { timeout: 3000 });
    expect(errors).toEqual([]);
  } finally { await watcher.close(); }
});

it('regenerates in watch mode without callbacks', async () => {
  const cwd = await fixture();
  const watcher = await watchRoutes({ cwd });
  try {
    await put(cwd, 'src/routes/index.ts', handler);
    await vi.waitFor(async () => expect(await readFile(path.join(cwd, 'src/routes.gen.ts'), 'utf8')).toContain('routes/index'), { timeout: 3000 });
  } finally { await watcher.close(); }
});

it('provides a thin Vite plugin that regenerates before build and on add/unlink', async () => {
  const cwd = await fixture();
  const plugin = routes({ cwd });
  // A minimal Vite server: callbacks are the same hooks used by real Vite.
  const events = new Map<string, (file: string) => void>();
  const off = vi.fn();
  const server = { ws: { clients: new Set(), on: vi.fn(), off: vi.fn(), send: vi.fn() }, watcher: { add: vi.fn(), on(event: string, callback: (file: string) => void) { events.set(event, callback); return this; }, off }, config: { logger: { error: vi.fn() } }, httpServer: { once: vi.fn() } };
  const buildStart = plugin.buildStart as () => Promise<void>;
  const configureServer = (typeof plugin.configureServer === 'function' ? plugin.configureServer : plugin.configureServer!.handler) as (server: unknown) => Promise<void>;
  await buildStart();
  await configureServer(server);
  await put(cwd, 'src/routes/added/index.ts', handler);
  events.get('add')!(path.join(cwd, 'src/routes/added/index.ts'));
  await vi.waitFor(async () => expect(await readFile(path.join(cwd, 'src/routes.gen.ts'), 'utf8')).toContain('routes/added/index'));
  await rm(path.join(cwd, 'src/routes/added'), { recursive: true });
  events.get('unlink')!(path.join(cwd, 'src/routes/added/index.ts'));
  await vi.waitFor(async () => expect(await readFile(path.join(cwd, 'src/routes.gen.ts'), 'utf8')).not.toContain('routes/added/index'));
  await (plugin.closeBundle as () => Promise<void>)();
  expect(off).toHaveBeenCalledTimes(5);
});

it('keeps RoutePath output stable when same-shaped routes swap page exports', async () => {
  const cwd = await fixture({ 'src/routes/(a)/[id]/index.tsx': page, 'src/routes/(b)/[slug]/index.tsx': handler });
  const first = await generateRoutes({ cwd });
  await put(cwd, 'src/routes/(a)/[id]/index.tsx', handler);
  await put(cwd, 'src/routes/(b)/[slug]/index.tsx', page);
  expect((await generateRoutes({ cwd })).code).toBe(first.code);
});

it('emits relative ESM imports for hidden siblings', async () => {
  const cwd = await fixture({ 'src/routes/.well-known/index.ts': handler });
  const result = await renderRoutes({ cwd, out: 'src/routes/routes.gen.ts', importExtension: '.js' });
  expect(result.code).toContain('from "./.well-known/index.js"');
});

it.each(['a#b', 'a?b', '100%', '[n{\\d+}]', '[]', '[a]]', '[n{a]', '[n{a}x]'])('rejects non-portable or unconvertible directory %s', async name => {
  const cwd = await fixture({ [`src/routes/${name}/index.ts`]: handler });
  await expect(generateRoutes({ cwd })).rejects.toThrow(/invalid (route directory|bracket parameter directory)/);
  await expect(stat(path.join(cwd, 'src/routes.gen.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('generates the missing manifest before a real Vite SSR build resolves the entry', async () => {
  const { build } = await import('vite');
  const { fileURLToPath } = await import('node:url');
  const cwd = await fixture({
    'src/routes/index.ts': 'export function onGet(c: any) { return c.text("api"); }',
    'src/entry.ts': 'import { createApp } from "recooler/router"; import { manifest } from "./routes.gen.js"; export default createApp(manifest);',
  });
  const result = await build({
    root: cwd, configFile: false, logLevel: 'silent', plugins: [routes({ importExtension: '.js' })],
    resolve: { alias: { 'recooler/router': fileURLToPath(new URL('../../src/router/index.ts', import.meta.url)) } },
    build: { ssr: 'src/entry.ts', write: false },
  });
  expect(await readFile(path.join(cwd, 'src/routes.gen.ts'), 'utf8')).toContain('routes/index.js');
  expect(result).toHaveProperty('output');
});


it('accepts CRLF manifests without a rewrite or stale failure', async () => {
  const cwd = await fixture({ 'src/routes/index.ts': handler });
  const first = await generateRoutes({ cwd });
  const crlf = first.code.replace(/\n/g, '\r\n');
  await writeFile(first.out, crlf);
  expect((await generateRoutes({ cwd, check: true })).changed).toBe(false);
  expect((await generateRoutes({ cwd })).changed).toBe(false);
  expect(await readFile(first.out, 'utf8')).toBe(crlf);
});

it('recognizes Unicode middleware names and warns about skipped middleware files', async () => {
  const cwd = await fixture({
    'src/routes/middleware@café.ts': middleware,
    'src/routes/middleware@नमस्ते.ts': middleware,
    'src/routes/middleware@a\u200cb.ts': middleware,
    'src/routes/middleware@bad!.ts': middleware,
    'src/routes/middleware-typo.ts': middleware,
  });
  const result = await renderRoutes({ cwd });
  expect(result.files.map(file => path.basename(file)).sort()).toEqual(['middleware@a\u200cb.ts', 'middleware@café.ts', 'middleware@नमस्ते.ts'].sort());
  expect(result.warnings).toHaveLength(2);
  expect(result.warnings.join('\n')).toContain('middleware@bad!.ts');
  expect(result.warnings.join('\n')).toContain('middleware-typo.ts');
});

it('keeps existing import identifiers stable across insertion and sanitized-name collisions', async () => {
  const cwd = await fixture({ 'src/routes/a-b/index.ts': handler, 'src/routes/z/index.ts': handler });
  const first = await renderRoutes({ cwd });
  await put(cwd, 'src/routes/a_b/index.ts', handler);
  await put(cwd, 'src/routes/0/index.ts', handler);
  const second = await renderRoutes({ cwd });
  const imports = (code: string) => code.split('\n').filter(line => line.startsWith('import *'));
  for (const line of imports(first.code)) expect(imports(second.code)).toContain(line);
  const ids = imports(second.code).map(line => line.split(' ')[3]);
  expect(new Set(ids).size).toBe(ids.length);
});

it.each(['', '.js', 'source'] as const)('resolves generated %j imports with the real Vite 8 bundler', async importExtension => {
  const { build } = await import('vite');
  const cwd = await fixture(Object.fromEntries(['ts', 'tsx', 'js', 'jsx'].map(extension =>
    [`src/routes/${extension}/index.${extension}`, 'export const onGet = () => new Response("ok");'])));
  await put(cwd, 'src/routes/[n{[0-9]+}]/index.ts', 'export const onGet = () => new Response("numeric");');
  const result = await build({
    root: cwd, configFile: false, logLevel: 'silent', plugins: [routes({ importExtension })],
    build: { ssr: 'src/routes.gen.ts', write: false },
  });
  expect(result).toHaveProperty('output');
});

it('watches routes outside a missing srcDir and notices a later root', async () => {
  const cwd = await fixture({ 'api/index.ts': handler });
  await rm(path.join(cwd, 'src'), { recursive: true });
  const results: string[] = [];
  const watcher = await watchRoutes({ cwd, routesDir: 'api', out: 'generated/routes.ts', onResult: result => results.push(result.code) });
  try {
    await put(cwd, 'src/root.tsx', 'export const head = {};');
    await vi.waitFor(() => expect(results.at(-1)).toContain('rootFile: "root.tsx"'), { timeout: 3000 });
    await put(cwd, 'api/added/index.ts', handler);
    await vi.waitFor(() => expect(results.at(-1)).toContain('api/added/index'), { timeout: 3000 });
  } finally { await watcher.close(); }
});

it('revalidates content edits and recovers without rewriting valid namespaces', async () => {
  const cwd = await fixture({ 'src/routes/middleware.ts': middleware });
  const errors: unknown[] = [], results: boolean[] = [];
  const watcher = await watchRoutes({ cwd, onError: error => errors.push(error), onResult: result => results.push(result.changed) });
  try {
    await put(cwd, 'src/routes/middleware.ts', 'export const guard = () => {};');
    await vi.waitFor(() => expect(String(errors.at(-1))).toContain('has no default export'), { timeout: 3000 });
    await put(cwd, 'src/routes/middleware.ts', middleware);
    await vi.waitFor(() => expect(results).toContain(false), { timeout: 3000 });
  } finally { await watcher.close(); }
});

it('starts a real Vite 8 dev server with invalid routes, revalidates edits, and detaches listeners', async () => {
  const { createServer, createLogger } = await import('vite');
  const { fileURLToPath } = await import('node:url');
  const cwd = await fixture({
    'src/routes/index.ts': 'export const onGet = (c: any) => c.text("get");',
    'src/routes/middleware.ts': middleware,
    'src/entry.ts': 'import { createApp } from "recooler/router"; import { manifest } from "./routes.gen.js"; export default createApp(manifest);',
  });
  // Keep a generated manifest so actual namespaces can report startup errors at runtime.
  await generateRoutes({ cwd, importExtension: '.js' });
  await put(cwd, 'src/routes/middleware.ts', 'export const guard = () => {};');
  const logger = createLogger('silent');
  const errors = vi.spyOn(logger, 'error');
  const server = await createServer({
    root: cwd, configFile: false, customLogger: logger, plugins: [routes({ importExtension: '.js' })],
    resolve: { alias: { 'recooler/router': fileURLToPath(new URL('../../src/router/index.ts', import.meta.url)) } },
    server: { port: 0, host: '127.0.0.1', watch: { usePolling: true, interval: 100 } },
  });
  try {
    await server.listen();
    expect(server.httpServer?.listening).toBe(true);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('has no default export'));
    await expect(server.ssrLoadModule('/src/entry.ts')).rejects.toThrow('has no default export');
    errors.mockClear();
    const changes: string[] = [];
    const recordChange = (file: string) => changes.push(file);
    server.watcher.on('change', recordChange);
    await put(cwd, 'src/routes/middleware.ts', middleware);
    // Poll at 100 ms to exceed Chokidar's 50 ms change-event throttle.
    // SSR can read the repaired file before the polling watcher observes it.
    // Wait for that observation before restoring the original invalid contents.
    await vi.waitFor(() => expect(changes.some(file => file.endsWith('/src/routes/middleware.ts'))).toBe(true), { timeout: 10000 });
    server.watcher.off('change', recordChange);
    // The watch callback debounces generation; let it observe the repaired tree
    // before restoring the same diagnostic (which is deduped while invalid).
    await new Promise(resolve => setTimeout(resolve, 150));
    const loaded = await vi.waitFor(async () => server.ssrLoadModule('/src/entry.ts'), { timeout: 10000 });
    expect((await loaded.default.request('/')).status).toBe(200);
    await put(cwd, 'src/routes/middleware.ts', 'export const guard = () => {};');
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(expect.stringContaining('has no default export')), { timeout: 10000 });
  } finally { await server.close(); }
  expect(server.watcher.listeners('change')).toHaveLength(0);
}, 30000);


it.each(['[id{[0-9+}]', '[a{}]', '[[r{x}]]'])('validates %s in generate and --check without writing', async segment => {
  const cwd = await fixture({ [`src/routes/${segment}/index.ts`]: handler });
  for (const check of [false, true]) {
    await expect(generateRoutes({ cwd, check })).rejects.toThrow(`routes/${segment}/index.ts`);
  }
  await expect(stat(path.join(cwd, 'src/routes.gen.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['100%', 'a#b', 'a?b'])('suggests renaming a non-portable literal directory %s', async segment => {
  const cwd = await fixture({ [`src/routes/${segment}/index.ts`]: handler });
  await expect(generateRoutes({ cwd })).rejects.toThrow('rename the directory');
  await expect(generateRoutes({ cwd })).rejects.not.toThrow('digit patterns');
});
