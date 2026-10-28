import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, createServer, createBuilder, preview } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { recooler } from '../../dist/vite/index.js';

const packageDir = fileURLToPath(new URL('../../', import.meta.url));
const cacheDir = path.join(packageDir, '.cache');
await mkdir(cacheDir, { recursive: true });
const root = await mkdtemp(path.join(cacheDir, 'htmx-'));
const kind = process.argv[2] ?? 'plain';
const cf = kind !== 'plain';
const selected = kind === 'beta' ? 'ssr' : cf ? 'htmx_worker' : 'ssr';
const secret = 'REQUEST_ONLY_SECRET_7e82_never_in_bundle';
const previousSecret = process.env.RECOOLER_SECRET;
process.env.RECOOLER_SECRET = secret;
const write = async (name, source) => {
  await mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await writeFile(path.join(root, name), source);
};
const component = `export const Button = ({ value = 'shared' }) => <form hx-post={(_, payload) => <p>{value}:{payload.name}</p>}/>;\n`;
const pageSource = `import { Button } from '../components/barrel';
import { Outside } from '../../outside/extra';
import { Dependency } from 'fixture-actions';
import { cycle } from '../components/cycle-a';
import type { T } from '../components/type-only';
import { type Mixed } from '../components/mixed';
export const onGet = async (c, next) => { if (c.req.query('dynamic')) await import('../components/dynamic'); return next(); };
export default () => <><Button value="page"/><Outside/><Dependency/><p>{cycle}</p>
  <form id="crash" hx-post={() => {
    throw new Error('HOISTED_ACTION_MAP_FRAME');
  }}/>
  <button hx-on:click={() => console.log('CLIENT_BODY_MUST_BE_ABSENT')}/>
</>;\n`;
let server, builtPreview, auxiliary;
try {
  await mkdir(path.join(root, 'node_modules'));
  await symlink(packageDir, path.join(root, 'node_modules/recooler'), 'dir');
  await write('package.json', JSON.stringify({ type: 'module', dependencies: { 'fixture-actions': '1.0.0' } }));
  await write('node_modules/fixture-actions/package.json', JSON.stringify({ name: 'fixture-actions', type: 'module', exports: './index.tsx', peerDependencies: { recooler: '*' } }));
  await write('node_modules/fixture-actions/index.tsx', `export const Dependency = () => <form hx-post={() => 'dependency'}/>;`);
  await write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', verbatimModuleSyntax: true } }));
  await write('src/routes/index.tsx', pageSource);
  await write('src/components/Button.tsx', component);
  await write('src/components/Admin.tsx', `export const Admin = () => <form hx-post={() => 'admin'}/>;`);
  await write('src/components/barrel.ts', `export { Button } from './Button'; export { Admin } from './Admin';`);
  await write('src/components/cycle-a.ts', `import './cycle-b'; export const cycle = 'cycle';`);
  await write('src/components/cycle-b.tsx', `import './cycle-a'; export const Cycle = () => <form hx-post={() => 'cycle'}/>;`);
  await write('src/components/type-only.tsx', `export type T = string; export const Erased = () => <form hx-post={() => 'erased'}/>;`);
  await write('src/components/mixed.tsx', `export type Mixed = string; export const MixedAction = () => <form hx-post={() => 'mixed'}/>;`);
  await write('src/components/dynamic.tsx', `export const Dynamic = () => <form hx-post={() => 'dynamic'}/>;`);
  await write('outside/extra.tsx', `export const Outside = () => <form hx-post={() => 'outside'}/>;`);
  await write('src/routes/layout.tsx', `export default Content => props => <><form hx-post={() => 'layout'}/><Content {...props}/></>;`);
  await write('src/root.tsx', `import { DefaultRootHOC } from 'recooler/jsx'; export default Content => DefaultRootHOC(props => <><form hx-post={() => 'root'}/><Content {...props}/></>);`);
  await write('src/routes/handler/index.ts', `import { Button } from '../../components/Button'; export const onGet = c => c.text(typeof Button);`);
  await write('src/routes/:id/index.ts', `export const onGet = c => c.text('colon route ' + c.req.param('id'));`);
  await write('src/routes/table/index.ts', `import { table, namespace } from 'virtual:recooler/htmx'; export const onGet = c => c.json({ table, namespace });`);
  await write('src/entry.ts', `import app from 'virtual:recooler/app'; app.onError(error => Response.json({ stack: error.stack }, { status: 500 })); export default app;`);
  await write('.dev.vars', `RECOOLER_SECRET=${secret}\n`);
  if (kind === 'beta') await write('cloudflare.config.ts', `export default { worker: { name: 'htmx-worker', entrypoint: './src/entry.ts', compatibilityDate: '2026-10-20', compatibilityFlags: ['nodejs_compat'], env: { RECOOLER_SECRET: { type: 'secret' } } } };`);
  else if (cf) {
    auxiliary = await mkdtemp(path.join(cacheDir, 'htmx-aux-'));
    await mkdir(path.join(auxiliary, 'src'));
    await writeFile(path.join(auxiliary, 'package.json'), '{"type":"module"}');
    await writeFile(path.join(auxiliary, 'src/index.ts'), `export default { fetch: () => new Response('auxiliary worker') };`);
    await writeFile(path.join(auxiliary, 'wrangler.json'), JSON.stringify({ name: 'aux_worker', main: 'src/index.ts', compatibility_date: '2026-10-20' }));
    await write('src/routes/aux/index.ts', `export const onGet = c => c.env.AUX.fetch('http://aux/');`);
    await write('wrangler.json', JSON.stringify({ name: 'htmx_worker', main: 'src/entry.ts', compatibility_date: '2026-10-20', compatibility_flags: ['nodejs_als'], services: [{ binding: 'AUX', service: 'aux_worker' }] }));
  }
  const beta = kind === 'beta' ? (await import(new URL('../../../../spikes/phase1/node_modules/cloudflare-vite-beta/dist/index.mjs', import.meta.url))).cloudflare : undefined;
  const make = () => ({
    root, configFile: false, logLevel: 'warn', mode: 'production',
    plugins: [
      ...(cf ? [beta ? beta({ persistState: false, inspectorPort: false, types: { generate: false } }) : cloudflare({ configPath: path.join(root, 'wrangler.json'), auxiliaryWorkers: [{ configPath: path.join(auxiliary, 'wrangler.json') }], persistState: false, inspectorPort: false })] : []),
      ...recooler(kind === 'cloudflare' ? {} : { serverEnvironment: selected }),
    ],
    // Deliberately try to externalize/prebundle our action dependency. recooler
    // must keep it in the selected server's source pipeline.
    environments: { [selected]: { consumer: 'server', resolve: { external: ['fixture-actions'] }, optimizeDeps: { include: ['fixture-actions'] } } },
    build: cf ? { minify: false, sourcemap: true } : { ssr: 'src/entry.ts', outDir: 'dist/server', minify: false, sourcemap: true, rolldownOptions: { output: { entryFileNames: 'app.mjs' } } },
    server: { host: '127.0.0.1', port: 0 },
  });
  const inspectGraph = async request => {
    assert.equal(await (await request('/colon')).text(), 'colon route colon');
    const { table, namespace } = await (await request('/table')).json();
    const ids = table['routes/index.tsx'];
    assert(ids, JSON.stringify(table));
    assert.match(namespace, /^recooler:/);
    for (const expected of ['routes/index.tsx', 'routes/layout.tsx', 'root.tsx', 'components/Button.tsx', 'components/Admin.tsx', 'components/cycle-b.tsx', 'components/mixed.tsx', '../outside/extra.tsx']) assert(ids.includes(expected), expected + ': ' + JSON.stringify(ids));
    assert(ids.some(id => id.endsWith('fixture-actions/index.tsx')), JSON.stringify(ids));
    for (const absent of ['type-only.tsx', 'dynamic.tsx', 'barrel.ts', 'cycle-a.ts']) assert(!ids.some(id => id.endsWith(absent)), JSON.stringify(ids));
    assert.deepEqual(Object.keys(table), ['routes/index.tsx']);
    return { table, namespace };
  };
  const actions = html => [...html.matchAll(/hx-post="([^"]+)"/g)].map(m => m[1].replaceAll('&amp;', '&'));
  const submit = (request, url, headers = {}) => request(url, { method: 'POST', headers: { 'HX-Request': 'true', 'Sec-Fetch-Site': 'same-origin', ...headers }, body: new URLSearchParams({ name: 'Ada' }) });
  // Build and import/preview the actual server output, including hoisted maps.
  let bundle;
  if (cf) {
    const builder = await createBuilder(make());
    await builder.buildApp();
    bundle = path.resolve(root, builder.environments[selected].config.build.outDir, 'index.js');
    builtPreview = await preview({ ...make(), preview: { host: '127.0.0.1', port: 0 } });
  } else {
    await build(make());
    bundle = path.join(root, 'dist/server/app.mjs');
  }
  assert(!(await readFile(bundle, 'utf8')).includes(secret), 'request secret must never be inlined');
  assert(!(await readFile(bundle, 'utf8')).includes('CLIENT_BODY_MUST_BE_ABSENT'));
  const builtApp = cf ? undefined : (await import(pathToFileURL(bundle))).default;
  const builtOrigin = cf ? `http://127.0.0.1:${builtPreview.httpServer.address().port}` : 'http://test';
  const requestBuilt = (url, init) => cf ? fetch(new URL(url, builtOrigin), init) : builtApp.fetch(new Request(new URL(url, builtOrigin), init), { RECOOLER_SECRET: secret });
  const builtGraph = await inspectGraph(requestBuilt);
  if (!cf) {
    assert.equal((await builtApp.fetch(new Request('http://test/'))).status, 200, 'Node process.env fallback');
    delete process.env.RECOOLER_SECRET;
    const missing = await builtApp.fetch(new Request('http://test/'), {});
    assert.equal(missing.status, 500, 'missing request secret');
    assert.match((await missing.json()).stack, /recooler:.*RECOOLER_SECRET.*\.dev.vars.*process.env/);
    process.env.RECOOLER_SECRET = secret;
  }
  const html = await (await requestBuilt('/?dynamic=1')).text();
  const urls = actions(html);
  assert.equal(urls.length, 6, html);
  await inspectGraph(requestBuilt);
  const bodies = [];
  for (const url of urls.slice(0, -1)) bodies.push(await (await submit(requestBuilt, url)).text());
  assert.deepEqual(bodies, ['root', 'layout', '<p>page:Ada</p>', 'outside', 'dependency']);
  assert.equal((await submit(requestBuilt, urls[2], { 'Sec-Fetch-Site': 'cross-site', Origin: 'http://evil.test' })).status, 403);
  assert.equal((await submit(requestBuilt, urls[2].replace(/sig=./, 'sig=x'))).status, 404);
  assert.equal((await submit(requestBuilt, urls[2].replace('/?', '/handler?'))).status, 404);
  const crash = await submit(requestBuilt, urls.at(-1));
  assert.equal(crash.status, 500);
  if (!cf) {
    const { stack } = await crash.json();
    const frame = stack.split('\n').find(line => line.includes('app.mjs:'));
    assert(frame, stack);
    const [, line, column] = frame.match(/:(\d+):(\d+)\)?$/);
    const map = new TraceMap(JSON.parse(await readFile(bundle + '.map', 'utf8')));
    const original = originalPositionFor(map, { line: Number(line), column: Number(column) - 1 });
    assert.match(original.source, /src\/routes\/index\.tsx$/);
    assert.equal(original.line, 10);
    assert.equal(original.column, pageSource.split('\n')[9].indexOf('new Error'));
    assert.equal(map.sourcesContent[map.sources.indexOf(original.source)], pageSource);
  }
  await builtPreview?.close(); builtPreview = undefined;
  await rm(path.join(root, 'src/routes.gen.ts'));
  const dev = make();
  if (!cf) dev.plugins.push({ name: 'test:http', configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      try {
        const app = (await vite.environments.ssr.runner.import('/src/entry.ts')).default;
        const response = await app.fetch(new Request('http://test' + req.url, { method: req.method, headers: req.headers, ...(req.method === 'POST' ? { body: req, duplex: 'half' } : {}) }), { RECOOLER_SECRET: secret });
        res.statusCode = response.status;
        res.end(await response.text());
      } catch (error) { next(error); }
    });
  } });
  server = await createServer(dev);
  assert.equal(server.config.server.fs.strict, true);
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const request = (url, init) => fetch(new URL(url, origin), init);
  if (kind === 'cloudflare') {
    assert.equal(await (await request('/aux')).text(), 'auxiliary worker');
    const auxSource = await server.environments.aux_worker.transformRequest(path.join(auxiliary, 'src/index.ts'));
    assert(!auxSource.code.includes('recooler/htmx/runtime'), 'idle auxiliary environments must not receive registrations');
  }
  const [devGraph] = await Promise.all([inspectGraph(request), inspectGraph(request)]);
  assert.deepEqual(devGraph.table, builtGraph.table);
  assert.notEqual(devGraph.namespace, builtGraph.namespace, 'dev server nonce isolates build registrations');
  const initial = await (await request('/')).text();
  assert.equal(await (await submit(request, actions(initial)[2])).text(), '<p>page:Ada</p>');
  const editStart = performance.now();
  await write('src/components/Button.tsx', component.replace('{value}:{payload.name}', 'edited:{payload.name}'));
  let edited;
  const deadline = Date.now() + 15000;
  do {
    const page = await (await request('/')).text();
    edited = await (await submit(request, actions(page)[2])).text();
    if (edited.includes('edited:Ada')) break;
    if (Date.now() > deadline) throw new Error('edited action did not reach the server: ' + edited);
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (true);
  const editResponseMs = performance.now() - editStart;
  const oldUrl = actions(await (await request('/')).text())[2];
  await write('src/components/Button.tsx', `export const Button = () => <p>removed</p>;`);
  const removalDeadline = Date.now() + 15000;
  do {
    const page = await (await request('/')).text();
    if (page.includes('<p>removed</p>')) break;
    if (Date.now() > removalDeadline) throw new Error('removed action did not leave the page');
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (true);
  assert.equal((await submit(request, oldUrl)).status, 404);
  const graph = await (await request('/table')).json();
  assert(!graph.table['routes/index.tsx'].includes('components/Button.tsx'));
  await server.close(); server = undefined;
  if (!cf) {
    // Simulate an action removed while the server was stopped. Its persistent
    // registration must be cleared when the now-plain module transforms again.
    const registry = globalThis[Symbol.for('recooler.htmx.actions.v2')].get(graph.namespace);
    registry.set('components/Button.tsx', { POST: { 'components/Button.tsx@0': () => 'stale' } });
    server = await createServer({ ...make(), server: { middlewareMode: true, ws: false } });
    const restarted = (await server.environments.ssr.runner.import('/src/entry.ts')).default;
    assert.equal((await restarted.fetch(new Request('http://test/'), { RECOOLER_SECRET: secret })).status, 200);
    const restartedGraph = await (await restarted.fetch(new Request('http://test/table'), { RECOOLER_SECRET: secret })).json();
    assert.notEqual(restartedGraph.namespace, graph.namespace);
    const currentRegistry = globalThis[Symbol.for('recooler.htmx.actions.v2')].get(restartedGraph.namespace);
    assert.deepEqual(Object.keys(currentRegistry.get('components/Button.tsx')), []);
  }
  console.log(JSON.stringify({ kind, build: true, devRequest: true, actionRemoval: true, editResponseMs, sourceMap: cf ? undefined : 'src/routes/index.tsx:10' }));
} finally {
  await server?.close();
  await builtPreview?.close();
  if (previousSecret === undefined) delete process.env.RECOOLER_SECRET;
  else process.env.RECOOLER_SECRET = previousSecret;
  await rm(root, { recursive: true, force: true });
  if (auxiliary) await rm(auxiliary, { recursive: true, force: true });
}
