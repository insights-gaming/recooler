// Run after the package build; use --cloudflare for the workerd edit matrix.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, createServer } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { recooler } from '../../dist/vite/index.js';
import { htmxPlugin } from '../../dist/vite/htmx.js';

const packageDir = fileURLToPath(new URL('../../', import.meta.url));
const cf = process.argv.includes('--cloudflare');
await mkdir(path.join(packageDir, '.cache'), { recursive: true });
const root = await mkdtemp(path.join(packageDir, '.cache/htmx-regressions-'));
const write = async (file, content) => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content);
};
const env = { RECOOLER_SECRET: 'regression-test-only' };
const urls = html => [...html.matchAll(/hx-(post|put)="([^"]+)"/g)].map(([, method, url]) => ({ method: method.toUpperCase(), url: url.replaceAll('&amp;', '&') }));
const submit = (request, { method, url }) => request(url, { method, headers: { 'HX-Request': 'true', 'Sec-Fetch-Site': 'same-origin' }, body: new URLSearchParams() });
const plain = marker => `export default () => <p>${marker}</p>;`;
const imported = (marker, other = false) => `import { Late } from '../components/Late'; ${other ? "import { Other } from '../components/Other';" : ''} export default () => <><p>${marker}</p><Late/>${other ? '<Other/>' : ''}</>;`;
let server, second;
try {
  await write('package.json', '{"type":"module"}');
  await mkdir(path.join(root, 'node_modules'));
  await symlink(packageDir, path.join(root, 'node_modules/recooler'), 'dir');
  await write('src/entry.ts', `import app from 'virtual:recooler/app'; app.onError(e => new Response(e.stack, { status: 500 })); export default app;`);
  await write('src/routes/index.tsx', plain('initial'));
  await write('src/components/Late.tsx', `export const Late = () => <form hx-post={() => 'late'}/>;`);
  await write('src/components/Other.tsx', `export const Other = () => <form hx-put={() => 'other'}/>;`);
  await write('src/routes/[id]/layout.tsx', `export default Content => props => <><form hx-post={() => 'alias-layout'}/><Content {...props}/></>;`);
  await write('src/routes/[id]/index.tsx', plain('alias page'));
  await write('src/routes/:id/edit/index.tsx', plain('alias child'));
  await write('src/routes/table/index.ts', `import { table, namespace, enabled } from 'virtual:recooler/htmx'; export const onGet = c => c.json({ table, namespace, enabled });`);
  await write('.dev.vars', 'RECOOLER_SECRET=regression-test-only');
  await write('wrangler.json', JSON.stringify({ name: 'regression_worker', main: 'src/entry.ts', compatibility_date: '2026-10-20', compatibility_flags: ['nodejs_als'] }));
  // Both map paths: a dedicated placeholder line preserves all later locations;
  // combined/minified code must compose a boundary map for shifted columns.
  const graph = htmxPlugin({});
  const plugin = graph.plugins[0];
  plugin.configResolved({ root, command: 'build' });
  const context = { environment: { name: 'ssr', config: { consumer: 'server' } }, getModuleInfo: () => undefined, error: message => { throw new Error(message); } };
  const prefix = 'const data = JSON.parse("__RECOOLER_ACTION_TABLE_6d32ad94__");';
  assert.equal(plugin.renderChunk.call(context, prefix + '\nthrow new Error("later")').map, null);
  const combined = prefix + 'throw new Error("later")';
  const replaced = plugin.renderChunk.call(context, combined);
  assert(replaced.map);
  const column = replaced.code.indexOf('throw');
  assert.equal(originalPositionFor(new TraceMap(replaced.map), { line: 1, column }).column, combined.indexOf('throw'));

  // Compare build and dev action tables, including canonical alias layouts.
  await build({ root, configFile: false, logLevel: 'silent', plugins: recooler(), build: { ssr: 'src/entry.ts', minify: false, rolldownOptions: { output: { entryFileNames: 'app.mjs' } } } });
  const built = (await import(pathToFileURL(path.join(root, 'dist/app.mjs')))).default;
  const builtRequest = (url, init) => built.fetch(new Request(new URL(url, 'http://test'), init), env);
  const builtGraph = await (await builtRequest('/table')).json();
  assert.deepEqual(builtGraph.table['routes/:id/edit/index.tsx'], ['routes/[id]/layout.tsx']);
  for (const page of ['/x', '/x/edit']) {
    const response = await builtRequest(page); assert.equal(response.status, 200);
    assert.equal(await (await submit(builtRequest, urls(await response.text())[0])).text(), 'alias-layout');
  }
  const config = (who = 'one') => ({ root, configFile: false, logLevel: 'silent',
    plugins: [...(cf ? [cloudflare({ configPath: path.join(root, 'wrangler.json'), persistState: false, inspectorPort: false })] : []), ...recooler()],
    define: { __WHO__: JSON.stringify(who) },
    server: { host: '127.0.0.1', port: 0, ...(!cf ? { middlewareMode: true, ws: false } : {}) } });
  server = await createServer(config());
  assert.equal(server.config.server.fs.strict, true);
  if (cf) await server.listen();
  const origin = cf ? `http://127.0.0.1:${server.httpServer.address().port}` : 'http://test';
  const request = async (url, init) => cf ? fetch(new URL(url, origin), init)
    : (await server.environments.ssr.runner.import('/src/entry.ts')).default.fetch(new Request(new URL(url, origin), init), env);
  const initialGraph = await (await request('/table')).json();
  assert.deepEqual(initialGraph.table, builtGraph.table);
  assert.equal(initialGraph.enabled, true, 'dev always installs the extension');
  for (const page of ['/x', '/x/edit']) {
    const response = await request(page); assert.equal(response.status, 200);
    assert.equal(await (await submit(request, urls(await response.text())[0])).text(), 'alias-layout');
  }
  const waitPage = async (marker, expected) => {
    const deadline = Date.now() + 20000;
    let last;
    do {
      try {
        const response = await request('/'); const html = await response.text(); last = `${response.status}: ${html}`;
        const actions = urls(html);
        if (response.status === 200 && html.includes(marker) && actions.length === expected.length) {
          const bodies = await Promise.all(actions.map(async action => {
            const result = await submit(request, action);
            return `${result.status}:${await result.text()}`;
          }));
          if (JSON.stringify(bodies) === JSON.stringify(expected.map(body => '200:' + body))) return actions;
          last += JSON.stringify(bodies);
        }
      } catch (error) { last = String(error); }
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    assert.fail('edit did not reach response: ' + last);
  };
  await waitPage('initial', []);
  await write('src/routes/index.tsx', imported('first import without hx text'));
  const original = (await waitPage('first import', ['late']))[0];
  await write('src/components/Late.tsx', `export const Late = () => <p>removed</p>;`);
  await waitPage('removed', []);
  assert.equal((await submit(request, original)).status, 404);
  await write('src/components/Late.tsx', `export const Late = () => <form hx-post={() => 'returned'}/>;`);
  const beforeShift = (await waitPage('first import', ['returned']))[0];
  await write('src/components/Late.tsx', `export const Late = () => <><form hx-post={() => 'inserted'}/><form hx-post={() => 'returned'}/></>;`);
  await waitPage('first import', ['inserted', 'returned']);
  assert.equal((await submit(request, beforeShift)).status, 404, 'a positional ID must not authorize a different action');
  await write('src/routes/index.tsx', imported('added edge', true));
  const withOther = await waitPage('added edge', ['inserted', 'returned', 'other']);
  await write('src/routes/index.tsx', imported('dropped edge'));
  await waitPage('dropped edge', ['inserted', 'returned']);
  assert.equal((await submit(request, withOther[2])).status, 404);
  await write('src/routes/index.tsx', plain('last action removed'));
  await waitPage('last action removed', []);
  await rm(path.join(root, 'src/components/Late.tsx'));
  await write('src/routes/index.tsx', plain('file deleted'));
  await waitPage('file deleted', []);
  assert.deepEqual((await (await request('/table')).json()).table['routes/index.tsx'], []);

  if (!cf) {
    await write('src/routes/index.tsx', `export default () => <><p>{__WHO__}</p><form hx-post={() => __WHO__}/></>;`);
    const firstUrl = (await waitPage('one', ['one']))[0];
    second = await createServer(config('two'));
    const secondApp = (await second.environments.ssr.runner.import('/src/entry.ts')).default;
    const secondRequest = (url, init) => secondApp.fetch(new Request(new URL(url, origin), init), env);
    const secondUrl = urls(await (await secondRequest('/')).text())[0];
    assert.equal(await (await submit(request, firstUrl)).text(), 'one');
    assert.equal(await (await submit(secondRequest, secondUrl)).text(), 'two');
    assert.equal((await submit(secondRequest, firstUrl)).status, 404);
    await second.close(); second = undefined;
    const firstNamespace = (await (await request('/table')).json()).namespace;
    const otherEnvironment = await createServer({ ...config('environment'), environments: { other: { consumer: 'server' } } });
    second = otherEnvironment;
    const other = (await otherEnvironment.environments.other.runner.import('/src/entry.ts')).default;
    const otherGraph = await (await other.fetch(new Request('http://test/table'), env)).json();
    const sameServerSsr = (await otherEnvironment.environments.ssr.runner.import('/src/entry.ts')).default;
    const sameServerGraph = await (await sameServerSsr.fetch(new Request('http://test/table'), env)).json();
    assert.notEqual(otherGraph.namespace, sameServerGraph.namespace, 'server environments on one dev server must be isolated');
    assert.notEqual(otherGraph.namespace, firstNamespace);
    assert(otherGraph.namespace.endsWith(':other'));
  }
  console.log(JSON.stringify({ runtime: cf ? 'workerd' : 'node', aliasLayouts: true, tableParity: true, maps: true, editMatrix: true, shiftedId: true, isolation: !cf }));
} finally { await second?.close(); await server?.close(); await rm(root, { recursive: true, force: true }); }
