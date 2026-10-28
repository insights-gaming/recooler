import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, createBuilder, createLogger, createServer } from 'vite';
import { recooler } from '../../dist/vite/index.js';

const packageDir = fileURLToPath(new URL('../../', import.meta.url));
// Resolved either by package name or through the symlink to the checkout, whatever its directory name.
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const jsxRuntimePattern = `(?:@insights-gaming/recooler/|${escapeRegExp(await realpath(packageDir))}/(?:dist/)?)jsx/jsx-`;
const execute = promisify(execFile);
await mkdir(path.join(packageDir, '.cache'), { recursive: true });
const root = await mkdtemp(path.join(packageDir, '.cache/regressions-'));
const write = async (name, source) => {
  await mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await writeFile(path.join(root, name), source);
};
let server;
const sockets = [];
const waitFor = async (check) => {
  const end = Date.now() + 10000;
  while (true) {
    if (await check()) {
      // Chokidar drops same-file changes within 50ms on inotify. Let the
      // observed update leave that window before making the next edit.
      await new Promise(resolve => setTimeout(resolve, 60));
      return;
    }
    if (Date.now() > end) throw new Error('watch update timed out');
    await new Promise(resolve => setTimeout(resolve, 40));
  }
};
try {
  await mkdir(path.join(root, 'node_modules'));
  await mkdir(path.join(root, 'node_modules/@insights-gaming'), { recursive: true }); await symlink(packageDir, path.join(root, 'node_modules/@insights-gaming/recooler'), 'dir');
  await write('package.json', JSON.stringify({ name: 'recooler-test-app', type: 'module', dependencies: { 'ui-lib': '1.0.0' } }));
  await write('tsconfig.json', '{}');
  await write('src/routes/index.tsx', `import { Badge } from 'ui-lib'; export default () => <h1><Badge/></h1>;`);
  await write('src/entry.ts', `export { default } from 'virtual:recooler/app';`);
  await write('node_modules/ui-lib/package.json', JSON.stringify({ name: 'ui-lib', version: '1.0.0', type: 'module', exports: './index.js', peerDependencies: { '@insights-gaming/recooler': '*' } }));
  await write('node_modules/ui-lib/index.js', `import { jsx } from '@insights-gaming/recooler/jsx/jsx-runtime'; export const Badge = () => jsx('b', { children: 'dependency' });`);
  const base = { root, configFile: false, logLevel: 'silent', plugins: recooler(), mode: 'production' };
  const builder = await createBuilder({ ...base, plugins: recooler({ serverEnvironment: 'server' }), environments: { ssr: { build: { rolldownOptions: { input: 'src/entry.ts' } } }, server: { consumer: 'server', build: { outDir: 'dist/server', rolldownOptions: { input: 'src/entry.ts' } } } } });
  assert(builder.environments.server.config.resolve.noExternal.includes('ui-lib'));
  await assert.rejects(builder.build(builder.environments.ssr), /restricted to serverEnvironment.*server/);
  await builder.build(builder.environments.server);
  const bundle = path.join(root, 'dist/server/entry.js');
  const { default: app } = await import(pathToFileURL(bundle));
  assert.match(await (await app.fetch(new Request('http://test/'))).text(), /<b>dependency<\/b>/);
  assert.doesNotMatch(await readFile(bundle, 'utf8'), /from ["'](?:recooler|easy-jsx-html-engine|ui-lib)/);

  // Actual Vitest startup and virtual import, with and without an explicit override.
  await write('src/excluded.test.tsx', 'export default () => <p>excluded</p>;');
  await write('app.test.tsx', `import { expect, test } from 'vitest'; import app from './src/entry'; import excluded from './src/excluded.test'; test('app', async () => { expect(await (await app.fetch(new Request('http://test/'))).text()).toContain('dependency'); expect((await (<p>outside</p>)).toHTML()).toBe('<p>outside</p>'); expect((await excluded()).toHTML()).toBe('<p>excluded</p>'); });`);
  // Vitest 5's default runner transforms imports in ssr, not __vitest__.
  for (const override of [undefined, 'ssr', '__vitest__']) {
    await write('tsconfig.json', JSON.stringify({ include: ['src'], exclude: ['**/*.test.tsx'], compilerOptions: { jsxImportSource: '@insights-gaming/recooler/jsx' } }));
    await write('vite.config.mjs', `import { recooler } from '@insights-gaming/recooler/vite'; export default { plugins: recooler(${JSON.stringify(override ? { serverEnvironment: override } : {})}), test: { include: ['app.test.tsx'] } };`);
    const run = () => execute(process.execPath, [path.join(packageDir, 'node_modules/vitest/vitest.mjs'), 'run', '--root', root, '--config', path.join(root, 'vite.config.mjs')], { cwd: root, timeout: 30000, env: { ...process.env, NODE_ENV: 'test' } });
    if (override === '__vitest__') await assert.rejects(run(), error => /restricted to serverEnvironment/.test(error.stdout + error.stderr));
    else await run();
  }

  // An explicit selection restricts dev transforms too; default permits both.
  for (const selected of [undefined, 'edge']) {
    server = await createServer({ ...base, plugins: recooler({ serverEnvironment: selected }), environments: { edge: { consumer: 'server' } }, server: { middlewareMode: true, ws: false } });
    const load = () => server.environments.ssr.transformRequest('virtual:recooler/app');
    if (selected) await assert.rejects(load(), /restricted to serverEnvironment.*edge/);
    else assert(await load());
    assert(await server.environments.edge.transformRequest('virtual:recooler/app'));
    await server.close(); server = undefined;
  }

  // Per-file JSX: defaults, references, nested config, classic runtime and pragmas.
  await write('src/default.tsx', 'export default <b/>;');
  await write('src/ref/index.tsx', 'export default <b/>;');
  await write('src/nested/tsconfig.json', '{"compilerOptions":{"jsx":"react-jsx","jsxImportSource":"hono/jsx"}}');
  await write('src/nested/index.tsx', 'export default <b/>;');
  await write('src/classic/tsconfig.json', '{"compilerOptions":{"jsx":"react","jsxFactory":"h"}}');
  await write('src/classic/index.tsx', 'export default <b/>;');
  const defaults = {
    'string': 'const doc = "set /** @jsxImportSource preact */ to change"; export default <b>{doc}</b>;',
    'template': 'const doc = `/** @jsxRuntime classic */`; export default <b>{doc}</b>;',
    'prose': '// the @jsx pragma is not used here\nexport default <b/>;',
    'bare-factory': '/** @jsx h */\nexport default <b/>;',
    'bare-fragment': '/** @jsxFrag Fragment */\nexport default <><b/></>;',
    'late-pragma': 'const x = 1;\n/** @jsxImportSource preact */\nexport default <b>{x}</b>;',
    'automatic': '/** @jsxRuntime classic */\n/** @jsxRuntime automatic */\nexport default <b/>;',
    'hashbang': '#!/usr/bin/env node\nexport default <b/>;',
    'hashbang-crlf': '#!/usr/bin/env node\r\nexport default <b/>;',
  };
  for (const [name, code] of Object.entries(defaults)) await write('src/' + name + '.tsx', code);
  await write('src/native/tsconfig.json', '{"compilerOptions":{"jsx":"react-native"}}');
  await write('src/native/index.tsx', 'export default <b/>;');
  await write('src/directive-pragma.tsx', '"use strict";\n/** @jsxImportSource hono/jsx */\nexport default <b/>;');
  await write('src/line-pragma.tsx', '// @jsxImportSource hono/jsx\nexport default <b/>;');
  await write('src/last-pragma.tsx', '/** @jsxImportSource preact */\n/** @jsxImportSource hono/jsx */\nexport default <b/>;');
  await write('src/classic-pragma.tsx', '/** @jsxRuntime classic @jsx h */\n/** @jsxRuntime invalid */\nexport default <b/>;');
  await write('src/included/tsconfig.json', '{"include":["app"],"compilerOptions":{"jsxImportSource":"@insights-gaming/recooler/jsx"}}');
  await write('src/included/test/outside.tsx', 'export default <b/>;');
  await write('src/excluded/tsconfig.json', '{"exclude":["**/*.test.tsx"],"compilerOptions":{"jsxImportSource":"@insights-gaming/recooler/jsx"}}');
  await write('src/excluded/app.test.tsx', 'export default <b/>;');
  await write('src/pragma.tsx', '/** @jsxImportSource hono/jsx */\nexport default <b/>;');
  await write('tsconfig.json', '{"files":[],"references":[{"path":"./tsconfig.app.json"}]}');
  await write('base.json', '{"compilerOptions":{"jsx":"react-jsx","jsxImportSource":"hono/jsx"}}');
  await write('tsconfig.app.json', '{ // JSONC with extends\n "extends":"./base.json", "include":["src/ref/**/*"] }');
  const warnings = [];
  const logger = createLogger('silent');
  logger.warn = value => warnings.push(value);
  const jsxCases = [
    ['default', '@insights-gaming/recooler/jsx'], ['ref/index', 'hono/jsx'], ['nested/index', 'hono/jsx'], ['pragma', 'hono/jsx'],
    ['directive-pragma', 'hono/jsx'], ['line-pragma', 'hono/jsx'], ['last-pragma', 'hono/jsx'], ['native/index', '@insights-gaming/recooler/jsx'],
    ['included/test/outside', '@insights-gaming/recooler/jsx'], ['excluded/app.test', '@insights-gaming/recooler/jsx'],
    ...Object.keys(defaults).map(name => [name, '@insights-gaming/recooler/jsx']),
  ];
  server = await createServer({ ...base, plugins: recooler(), customLogger: logger, server: { middlewareMode: true, ws: false } });
  for (const [file, runtime] of jsxCases) {
    const transformed = await server.environments.ssr.transformRequest('/src/' + file + '.tsx');
    assert.match(transformed.code, new RegExp(runtime === '@insights-gaming/recooler/jsx' ? jsxRuntimePattern : runtime + '/jsx-'));
  }
  assert.match((await server.environments.ssr.transformRequest('/src/classic/index.tsx')).code, /h\(/);
  assert.match((await server.environments.ssr.transformRequest('/src/classic-pragma.tsx')).code, /h\(/);
  assert(!warnings.some(w => /preact|preserved JSX/.test(w)), warnings.join('\n'));
  assert(warnings.some(w => w.includes('hono/jsx')));
  assert(warnings.some(w => w.includes('classic JSX runtime')));
  await write('src/nested/tsconfig.json', '{"compilerOptions":{"jsxImportSource":"@insights-gaming/recooler/jsx"}}');
  await waitFor(async () => new RegExp(jsxRuntimePattern).test((await server.environments.ssr.transformRequest('/src/nested/index.tsx')).code));
  await write('src/nested/tsconfig.json', '{"compilerOptions":{"jsxImportSource":"hono/jsx"}}');
  await waitFor(async () => /hono\/jsx\/jsx-/.test((await server.environments.ssr.transformRequest('/src/nested/index.tsx')).code));
  await write('src/included/tsconfig.json', '{"include":["test"],"compilerOptions":{"jsxImportSource":"hono/jsx"}}');
  await waitFor(async () => /hono\/jsx\/jsx-/.test((await server.environments.ssr.transformRequest('/src/included/test/outside.tsx')).code));
  await write('src/included/tsconfig.json', '{"include":["app"],"compilerOptions":{"jsxImportSource":"@insights-gaming/recooler/jsx"}}');
  await waitFor(async () => new RegExp(jsxRuntimePattern).test((await server.environments.ssr.transformRequest('/src/included/test/outside.tsx')).code));
  await server.close(); server = undefined;
  for (const [file, runtime] of jsxCases) {
    const result = await build({ ...base, plugins: recooler(), build: { ssr: 'src/' + file + '.tsx', write: false, minify: false, rolldownOptions: { external: id => /jsx-(dev-)?runtime/.test(id) } } });
    assert.match(result.output.find(o => o.type === 'chunk').code, new RegExp(runtime + '/jsx-runtime'));
  }

  // Failed startup and failure/recovery after the app has already loaded.
  const errors = [];
  const overlays = [];
  logger.error = value => errors.push(value);
  await write('src/routes/layout.tsx', 'export default C => C;');
  await write('src/routes/layout.jsx', 'export default C => C;');
  server = await createServer({ ...base, plugins: recooler(), customLogger: logger, server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const wsUrl = `ws://127.0.0.1:${server.httpServer.address().port}/`;
  // Raw connection callbacks require JSON bytes; each late client gets one error.
  for (let index = 0; index < 2; index++) {
    const messages = [];
    const socket = new WebSocket(wsUrl, 'vite-hmr');
    sockets.push(socket);
    socket.addEventListener('message', event => messages.push(JSON.parse(event.data)));
    await waitFor(() => messages.some(message => message.type === 'error'));
    assert.equal(messages.filter(message => message.type === 'error').length, 1);
    if (index === 0) {
      await new Promise(resolve => { socket.addEventListener('close', resolve, { once: true }); socket.close(); });
    }
  }
  const load = () => server.environments.ssr.runner.import('/src/entry.ts');
  await assert.rejects(load, /only one layout file/);
  const sent = server.ws.send.bind(server.ws);
  server.ws.send = payload => { if (payload.type === 'error') overlays.push(payload); return sent(payload); };
  await rm(path.join(root, 'src/routes/layout.jsx'));
  await waitFor(async () => { try { return !!(await load()).default; } catch { return false; } });
  await write('src/routes/layout.jsx', 'export default C => C;');
  await waitFor(() => overlays.length === 1);
  await assert.rejects(load, /only one layout file/);
  await write('src/routes/new/index.tsx', 'export default () => <b>new route</b>;');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(overlays.length, 1);
  await rm(path.join(root, 'src/routes/layout.jsx'));
  await waitFor(async () => { try { return (await (await load()).default.fetch(new Request('http://test/new'))).status === 200; } catch { return false; } });
  assert(!errors.some(e => e.includes('An error happened during full reload')), errors.join('\n'));
  await write('src/routes/new/index.tsx', 'export const = 1');
  await waitFor(() => overlays.length === 2);
  await assert.rejects(load, /routes\/new\/index.tsx: Unexpected token/);
  assert.equal(errors.filter(e => e.startsWith('only one layout file')).length, 2); // startup + later failure
  assert.equal(errors.filter(e => e.startsWith('routes/new/index.tsx:')).length, 1);
  console.log(JSON.stringify({ regressions: true }));
} finally {
  for (const socket of sockets) socket.close();
  await server?.close();
  await rm(root, { recursive: true, force: true });
}
