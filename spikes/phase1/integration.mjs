import { selectServer } from './server-environment.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, createBuilder, createServer, preview } from 'vite';
import { execFileSync } from 'node:child_process';
import { traceFrame } from './maps-check.mjs';
import { cloudflare } from '@cloudflare/vite-plugin';
import { cloudflare as beta } from 'cloudflare-vite-beta';
import { WebSocket } from 'ws';
import { fixture, config, write, base } from './fixture.mjs';
import { graphPlugin } from './graph-plugin.mjs';
import { assertGraph } from './graph-assert.mjs';
import { mapsPlugin, mapSource, verifyMap, position } from './maps-plugin.mjs';
import { clientPlugin } from './client-plugin.mjs';
import { checkContext } from './context-assert.mjs';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn) { for (let n = 0; n < 100; n++) { const result = await fn(); if (result) return result; await sleep(50); } throw new Error('timed out'); }
function addSources(root, cf) {
  write(root, 'src/map-source.ts', mapSource);
  write(root, 'src/client/shared.ts', "globalThis.__shared = (globalThis.__shared ?? 0) + 1; export const shared = 'SHARED_SLICE';");
  write(root, 'src/client/public.ts', "import { shared } from './shared'; export const publicHandler = () => shared + ':PUBLIC_ONLY';");
  write(root, 'src/client/admin.ts', "import { shared } from './shared'; import { adminOnly } from './admin-only'; export const adminHandler = () => shared + adminOnly;");
  write(root, 'src/client/admin-only.ts', "globalThis.__adminEvaluated = true; export const adminOnly = 'ADMIN_ONLY';");
  write(root, 'src/server-only.ts', "globalThis.__secret = 'BANNED_MODULE';");
  write(root, 'src/entry.ts', `import { getTable, getActions } from 'virtual:spike-runtime';
import { answer } from './route'; import './root'; import './layout';
import { moved, untouched } from './map-source';
import manifest from 'virtual:client-manifest';
import { Hono as Hono4 } from 'hono'; import { Hono as Hono5 } from 'hono5';
import * as s4 from 'hono/context-storage'; import * as s5 from 'hono5/context-storage';
import { routePath as p4 } from 'hono/route'; import { routePath as p5 } from 'hono5/route';
import { createContextApp } from ${JSON.stringify(join(base, 'context-app.mjs'))};
const app4 = createContextApp(Hono4, s4.contextStorage, s4.getContext, p4, ${cf});
const app5 = createContextApp(Hono5, s5.contextStorage, s5.getContext, p5, ${cf});
export default { async fetch(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/hono')) { const is5 = url.pathname.startsWith('/hono5'); url.pathname = url.pathname.slice(is5 ? 6 : 5); return (is5 ? app5 : app4).fetch(new Request(url, request), env, ctx); }
  if (url.pathname === '/crash') { try { moved(); } catch(e) { return Response.json({ stack: e.stack }); } }
  if (url.pathname === '/untouched') { try { untouched(); } catch(e) { return Response.json({ stack: e.stack }); } }
  return Response.json({ answer, table: await getTable(), actions: await getActions('/public'), manifest });
} };`);
}
function assertChunks(stats) {
  const entries = Object.entries(stats.chunks);
  const shared = entries.filter(([, c]) => c.ids.includes('src/client/shared.ts'));
  assert.equal(shared.length, 1);
  const publicChunk = entries.find(([, c]) => c.ids.includes('src/client/public.ts'));
  const adminChunk = entries.find(([, c]) => c.ids.includes('src/client/admin.ts'));
  assert(publicChunk && adminChunk);
  assert.notEqual(publicChunk[0], adminChunk[0]);
  const closure = new Set();
  function visit(name) { if (closure.has(name)) return; closure.add(name); stats.chunks[name]?.imports.forEach(visit); }
  visit(publicChunk[0]);
  const entry = entries.find(([, c]) => c.entry);
  visit(entry[0]);
  for (const name of closure) assert(!stats.chunks[name].ids.includes('src/client/admin-only.ts'));
  assert(stats.chunks[adminChunk[0]].ids.includes('src/client/admin-only.ts'));
  return { sharedChunk: shared[0][0], publicChunk: publicChunk[0], adminChunk: adminChunk[0], publicStaticClosure: [...closure] };
}
async function inspectMaps(root, stats, serverName) {
  const result = {};
  for (const [name, dir] of [['server', join(root, 'dist', serverName)], ['client', join(root, 'dist/client')]]) {
    const { readdirSync } = await import('node:fs');
    const find = path => readdirSync(path, { withFileTypes: true }).flatMap(e => e.isDirectory() ? find(join(path, e.name)) : [join(path, e.name)]);
    const records = [];
    for (const file of find(dir).filter(f => /\.(m?js)$/.test(f))) {
      const code = readFileSync(file, 'utf8');
      if (!code.includes('MOVED_FRAME')) continue;
      const map = JSON.parse(readFileSync(file + '.map', 'utf8'));
      records.push({ file: file.slice(root.length + 1), ...verifyMap(code, map) });
    }
    assert(records.length, name + ' missing maps');
    result[name] = records;
  }
  return result;
}
const results = [];
const selected = process.argv[2];
const benchCount = Number(process.argv[3] ?? 0);
for (const kind of (selected ? [selected] : ['plain', 'stable-als', 'stable-compat', 'beta'])) {
  const label = kind + (benchCount ? '-bench' + benchCount : '');
  const { root, routes } = fixture('integration-' + label);
  routes['/admin'] = [...routes['/public']];
  addSources(root, kind !== 'plain');
  if (benchCount) {
    const benchRoot = join(root, 'bench');
    execFileSync(process.execPath, [join(base, '../../docs/plans/fixtures/bench/gen-app.mjs'), benchRoot, '' + benchCount]);
    write(benchRoot, 'src/root.tsx', 'export default () => "root";');
    let imports = '';
    for (let i = 0; i < benchCount; i++) {
      const id = join(benchRoot, `src/routes/p${i}/index.tsx`);
      routes['/p' + i] = [id, join(benchRoot,'src/root.tsx')];
      imports += `import * as bench${i} from ${JSON.stringify(id)}; globalThis.__bench${i} = bench${i};\n`;
    }
    write(root, 'src/entry.ts', imports + readFileSync(join(root,'src/entry.ts'),'utf8'));
  }

  const stats = {};
  const flag = kind.endsWith('als') ? 'nodejs_als' : 'nodejs_compat';
  const cf = kind !== 'plain';
  if (cf && kind !== 'beta') write(root, 'wrangler.json', JSON.stringify({ name: 'spike_worker', main: 'src/entry.ts', compatibility_date: '2026-10-20', compatibility_flags: [flag], assets: { directory: './dist/client' } }));
  if (kind === 'beta') write(root, 'cloudflare.config.ts', `export default { name: 'spike-worker', main: './src/entry.ts', compatibilityDate: '2026-10-20', compatibilityFlags: ['nodejs_compat'] };`);
  const make = (includeBanned = false) => config(root, [
    ...(cf ? kind === 'beta' ? [beta({ persistState: false, inspectorPort: false, types: { generate: false } })] : [cloudflare({ configPath: join(root, 'wrangler.json'), persistState: false, inspectorPort: false })] : []),
    graphPlugin({ root, routes, stats }), mapsPlugin(), clientPlugin({ root, stats, includeBanned })
  ], { build: { sourcemap: true, minify: false }, ...(cf ? {} : { environments: { ssr: { consumer: 'server', build: { ssr: join(root, 'src/entry.ts'), outDir: 'dist/ssr', sourcemap: true, minify: false, rolldownOptions: { output: { entryFileNames: 'entry.mjs' } } } } } }) });
  console.log('BUILD', kind);
  // CLI build uses createBuilder().buildApp(); programmatic build() alone is one env.
  const builder = await createBuilder(make());
  await builder.buildApp();
  const serverName = selectServer(builder.environments).name;
  const chunks = assertChunks(stats);
  const maps = await inspectMaps(root, stats, serverName);
  assert(existsSync(join(root, 'dist/client/.vite/manifest.json')));
  const clientManifest = JSON.parse(readFileSync(join(root, 'dist/client/.vite/manifest.json'), 'utf8'));
  assert(Object.values(clientManifest).some(e => '/' + e.file === stats.manifest.entry && e.isEntry));
  // Test the path-level ban in a real failed client bundle.
  let banned = false;
  try { const invalid = await createBuilder(make(true)); await invalid.buildApp(); }
  catch (e) { banned = String(e).includes('Banned client module:'); if (!banned) throw e; }
  assert(banned);
  // Restore valid dist for native map/manifest inspection.
  const restored = await createBuilder(make()); await restored.buildApp();
  const buildOrder = [...stats.buildOrder];
  const builtChecks = {};
  let builtPreview;
  try {
    let builtRequest;
    if (cf) {
      builtPreview = await preview({ ...make(), preview: { host: '127.0.0.1', port: 0 } });
      const origin = `http://127.0.0.1:${builtPreview.httpServer.address().port}`;
      builtRequest = path => fetch(origin + path);
    } else {
      const worker = (await import(pathToFileURL(join(root,'dist/ssr/entry.mjs')))).default;
      builtRequest = path => worker.fetch(new Request('http://spike.test' + path));
    }
    builtChecks.value = await (await builtRequest('/')).json();
    assertGraph(builtChecks.value, true);
    assert.deepEqual(builtChecks.value.manifest, stats.manifest);
    builtChecks.crash = await (await builtRequest('/crash')).json();
    const bundleFile = join(root, maps.server[0].file);
    const map = JSON.parse(readFileSync(bundleFile + '.map','utf8'));
    builtChecks.frame = traceFrame(builtChecks.crash.stack, map, bundleFile);
    builtChecks.context = {};
    for (const version of ['hono', 'hono5']) builtChecks.context[version] = await checkContext(p => builtRequest('/' + version + p));
  } finally { await builtPreview?.close(); }
  // Observe actual lazy module evaluation without a DOM: import each emitted slice.
  delete globalThis.__adminEvaluated; delete globalThis.__shared;
  await import(pathToFileURL(join(root,'dist/client',chunks.publicChunk)));
  assert.equal(globalThis.__adminEvaluated, undefined);
  assert.equal(globalThis.__shared, 1);
  await import(pathToFileURL(join(root,'dist/client',chunks.adminChunk)));
  assert.equal(globalThis.__adminEvaluated, true);
  assert.equal(globalThis.__shared, 1);
  chunks.runtimeEvaluation = { publicDidNotEvaluateAdmin: true, sharedEvaluations: 1 };
  console.log('DEV', kind, serverName);
  const server = await createServer(make());
  const wsEvents = [];
  let socket;
  let observed;
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    const env = selectServer(server.environments);
    let native;
    const request = async path => cf ? fetch(origin + path) : (native ??= (await env.runner.import(root + '/src/entry.ts')).default).fetch(new Request(origin + path));
    // Cold walk before application evaluation.
    const cold = await fetch(origin + '/__spike_graph');
    assert.equal(cold.status, 200);
    await cold.json();
    const first = await (await request('/')).json();
    assertGraph(first, true);
    const context = {};
    for (const version of ['hono', 'hono5']) context[version] = await checkContext(p => request('/' + version + p));
    const crash = await (await request('/crash')).json();
    assert(crash.stack.includes('/src/map-source.ts:3:11'), crash.stack);
    const transformed = await env.transformRequest(root + '/src/map-source.ts');
    const devMap = verifyMap(transformed.code, transformed.map, root + '/src/map-source.ts');
    const clientTransformed = await server.environments.client.transformRequest(root + '/src/map-source.ts');
    const devClientMap = verifyMap(clientTransformed.code, clientTransformed.map, root + '/src/map-source.ts');
    // Node-side env hot transport observes emitted websocket frames without browser automation.
    const token = server.config.webSocketToken;
    socket = new WebSocket(origin.replace('http:', 'ws:') + '/?token=' + token, 'vite-hmr');
    socket.on('message', data => wsEvents.push(JSON.parse(data.toString())));
    await waitFor(() => wsEvents.some(e => e.type === 'connected'));
    await fetch(origin + '/@id/__x00__virtual:client-entry');
    await fetch(origin + '/src/client/public.ts');
    write(root, 'src/added.ts', '/* @action */ export const added = 1;');
    write(root, 'src/route.ts', readFileSync(root + '/src/route.ts', 'utf8') + "\nimport './added';\n");
    await waitFor(async () => {
      const table = await (await fetch(origin + '/__spike_graph')).json();
      return table['/public'].includes('src/added.ts');
    });
    if (!cf) native = (await env.runner.import(root + '/src/entry.ts')).default;
    const changed = await waitFor(async () => { const x = await (await request('/')).json(); return x.actions.includes('src/added.ts@0') && x; });
    assertGraph(changed, true, true);
    // Removing the final action marker must unregister stale actions on HMR.
    write(root, 'src/added.ts', 'export const added = 1;');
    await waitFor(async () => {
      if (!cf) native = (await env.runner.import(root + '/src/entry.ts')).default;
      const value = await (await request('/')).json();
      return !value.actions.includes('src/added.ts@0') && value;
    });
    write(root, 'src/client/public.ts', readFileSync(root + '/src/client/public.ts', 'utf8') + '\n// changed handler\n');
    await waitFor(() => stats.clientReloads > 0 && wsEvents.some(e => e.type === 'full-reload'));
    observed = { first, changed, context, crash, devMap, devClientMap, wsEvents, clientReloads: stats.clientReloads, devComputations: stats.devComputations };
  } finally { socket?.close(); await server.close(); }
  results.push({ kind, benchCount, flag, serverName, buildOrder, builtChecks, chunks, maps, clientManifest, banned, stats, observed });
  writeFileSync(new URL(`results/integration-${label}.json`, import.meta.url), JSON.stringify(results.at(-1), null, 2) + '\n');
  console.log('PASS', kind);
}
