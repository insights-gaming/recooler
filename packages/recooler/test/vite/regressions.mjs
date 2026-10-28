import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, createBuilder, createLogger, createServer } from 'vite';
import { recooler } from '../../dist/vite/index.js';

const packageDir = fileURLToPath(new URL('../../', import.meta.url));
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
    if (await check()) return;
    if (Date.now() > end) throw new Error('watch update timed out');
    await new Promise(resolve => setTimeout(resolve, 40));
  }
};
try {
  await mkdir(path.join(root, 'node_modules'));
  await symlink(packageDir, path.join(root, 'node_modules/recooler'), 'dir');
  await write('package.json', JSON.stringify({ type: 'module', dependencies: { 'ui-lib': '1.0.0' } }));
  await write('tsconfig.json', '{}');
  await write('src/routes/index.tsx', `import { Badge } from 'ui-lib'; export default () => <h1><Badge/></h1>;`);
  await write('src/entry.ts', `export { default } from 'virtual:recooler/app';`);
  await write('node_modules/ui-lib/package.json', JSON.stringify({ name: 'ui-lib', version: '1.0.0', type: 'module', exports: './index.js', peerDependencies: { recooler: '*' } }));
  await write('node_modules/ui-lib/index.js', `import { jsx } from 'recooler/jsx/jsx-runtime'; export const Badge = () => jsx('b', { children: 'dependency' });`);
  const base = { root, configFile: false, logLevel: 'silent', plugins: recooler(), mode: 'production' };
  const builder = await createBuilder({ ...base, environments: { server: { consumer: 'server', build: { outDir: 'dist/server', rolldownOptions: { input: 'src/entry.ts' } } } } });
  assert(builder.environments.server.config.resolve.noExternal.includes('ui-lib'));
  await builder.build(builder.environments.server);
  const bundle = path.join(root, 'dist/server/entry.js');
  const { default: app } = await import(pathToFileURL(bundle));
  assert.match(await (await app.fetch(new Request('http://test/'))).text(), /<b>dependency<\/b>/);
  assert.doesNotMatch(await readFile(bundle, 'utf8'), /from ["'](?:recooler|easy-jsx-html-engine|ui-lib)/);

  // Actual Vitest startup and virtual import, with and without an explicit override.
  await write('app.test.ts', `import { expect, test } from 'vitest'; import app from './src/entry'; test('app', async () => { expect(await (await app.fetch(new Request('http://test/'))).text()).toContain('dependency'); });`);
  for (const override of [undefined, '__vitest__']) {
    await write('vite.config.mjs', `import { recooler } from 'recooler/vite'; export default { plugins: recooler(${JSON.stringify(override ? { serverEnvironment: override } : {})}), test: { include: ['app.test.ts'] } };`);
    await execute(process.execPath, [path.join(packageDir, 'node_modules/vitest/vitest.mjs'), 'run', '--root', root, '--config', path.join(root, 'vite.config.mjs')], { cwd: root, timeout: 30000, env: { ...process.env, NODE_ENV: 'test' } });
  }

  // Per-file JSX: defaults, references, nested config, classic runtime and pragmas.
  await write('src/default.tsx', 'export default <b/>;');
  await write('src/ref/index.tsx', 'export default <b/>;');
  await write('src/nested/tsconfig.json', '{"compilerOptions":{"jsx":"react-jsx","jsxImportSource":"hono/jsx"}}');
  await write('src/nested/index.tsx', 'export default <b/>;');
  await write('src/classic/tsconfig.json', '{"compilerOptions":{"jsx":"react","jsxFactory":"h"}}');
  await write('src/classic/index.tsx', 'export default <b/>;');
  await write('src/pragma.tsx', '/** @jsxImportSource hono/jsx */\nexport default <b/>;');
  await write('tsconfig.json', '{"files":[],"references":[{"path":"./tsconfig.app.json"}]}');
  await write('base.json', '{"compilerOptions":{"jsx":"react-jsx","jsxImportSource":"hono/jsx"}}');
  await write('tsconfig.app.json', '{ // JSONC with extends\n "extends":"./base.json", "include":["src/ref/**/*"] }');
  const warnings = [];
  const logger = createLogger('silent');
  logger.warn = value => warnings.push(value);
  server = await createServer({ ...base, plugins: recooler(), customLogger: logger, server: { middlewareMode: true, ws: false } });
  for (const [file, runtime] of [['default', 'recooler/jsx'], ['ref/index', 'hono/jsx'], ['nested/index', 'hono/jsx'], ['pragma', 'hono/jsx']]) {
    const transformed = await server.environments.ssr.transformRequest('/src/' + file + '.tsx');
    assert.match(transformed.code, new RegExp(runtime.replace('recooler/jsx', 'recooler/(?:dist/)?jsx') + '/jsx-'));
  }
  assert.match((await server.environments.ssr.transformRequest('/src/classic/index.tsx')).code, /h\(/);
  assert(warnings.some(w => w.includes('hono/jsx')));
  assert(warnings.some(w => w.includes('classic JSX runtime')));
  await server.close(); server = undefined;
  for (const [file, runtime] of [['default', 'recooler/jsx'], ['ref/index', 'hono/jsx'], ['nested/index', 'hono/jsx'], ['pragma', 'hono/jsx']]) {
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
