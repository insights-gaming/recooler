import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer, preview } from 'vite';
import { evaluateClientPage } from './client-dom.mjs';
import vm from 'node:vm';
import WebSocket from 'ws';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';

const execute = promisify(execFile);
const packageDir = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(path.join(packageDir, '.cache'), { recursive: true });
const root = await mkdtemp(path.join(packageDir, '.cache/client-'));
const kind = process.argv[2] ?? 'plain';
const cf = kind !== 'plain';
const selected = kind === 'beta' ? 'ssr' : cf ? 'client_worker' : 'ssr';
const pluginPath = path.join(packageDir, 'dist/vite/index.js');
const write = async (name, code) => { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), code); };
const pageSource = `import { Shared } from '../components/Shared';
import { SERVER_ONLY_MARKER } from '../server-only';
import icon from '../icon.svg';
export const onLoad = () => { document.body.dataset.loaded = 'public'; };
export default () => <><p>{SERVER_ONLY_MARKER}</p><img src={icon}/><Shared/><Counter value={7}/></>;
const Counter = ({ value }) => <button id="counter" hx-on:click={function (this: HTMLButtonElement, event) {
  this.textContent = 'PUBLIC_HANDLER:' + value + ':' + event.type;
}}/>;
`;
const sharedSource = `import { shared } from '../shared';
export const Shared = () => <button id="shared" hx-on:click={function () { this.textContent = shared(); }}/>;
`;
let server, builtPreview, socket;
try {
  await write('package.json', '{"name":"recooler-test-app","type":"module"}');
  await mkdir(path.join(root, 'node_modules'));
  await mkdir(path.join(root, 'node_modules/@insights-gaming'), { recursive: true }); await symlink(packageDir, path.join(root, 'node_modules/@insights-gaming/recooler'), 'dir');
  await write('src/entry.ts', `export { default } from 'virtual:recooler/app';`);
  await write('src/routes/index.tsx', pageSource);
  await write('src/components/Shared.tsx', sharedSource);
  await write('src/shared.ts', `globalThis.__sharedEvaluations = (globalThis.__sharedEvaluations ?? 0) + 1; export const shared = () => 'SHARED_HANDLER';`);
  await write('src/server-only.ts', `export const SERVER_ONLY_MARKER = 'SERVER_ONLY_7a9e'; console.log('SERVER_SIDE_EFFECT_7a9e');`);
  await write('src/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><path d="M0 0h1v1"/></svg>');
  await write('src/routes/admin/index.tsx', `import { Shared } from '../../components/Shared'; import { admin } from '../../admin-only'; export default () => <><Shared/><button hx-on:click={() => admin()}/></>;`);
  await write('src/admin-only.ts', `globalThis.__adminEvaluations = 1; export const admin = () => console.log('ADMIN_HANDLER');`);
  await write('src/routes/plain/index.tsx', `export default () => <p>plain</p>;`);
  await write('src/routes/load/index.tsx', `const init = () => { document.body.dataset.loaded = 'load-only'; }; export { init as onLoad }; export default () => <p>load only</p>;`);
  await write('src/routes/table/index.ts', `import { clients } from 'virtual:recooler/htmx'; export const onGet = c => c.json(clients);`);
  await write('.dev.vars', 'RECOOLER_SECRET=client-test-key\n');
  if (kind === 'beta') await write('cloudflare.config.ts', `export default { worker: { name: 'client-worker', entrypoint: './src/entry.ts', compatibilityDate: '2026-10-20', compatibilityFlags: ['nodejs_compat'] } };`);
  else if (cf) await write('wrangler.json', JSON.stringify({ name: 'client_worker', main: 'src/entry.ts', compatibility_date: '2026-10-20', compatibility_flags: ['nodejs_als'] }));
  const platform = kind === 'beta' ? fileURLToPath(new URL('../../spikes/phase1/node_modules/cloudflare-vite-beta/dist/index.mjs', import.meta.url)) : import.meta.resolve('@cloudflare/vite-plugin');
  await write('vite.config.mjs', `import { recooler } from ${JSON.stringify(pluginPath)};
import { writeFile } from 'node:fs/promises';
${cf ? `import { cloudflare } from ${JSON.stringify(platform)};` : ''}
export default {
  root: ${JSON.stringify(root)}, logLevel: 'warn',
  plugins: [${cf ? `cloudflare({ persistState: false, inspectorPort: false, ${kind === 'beta' ? 'types: { generate: false }' : `configPath: ${JSON.stringify(path.join(root, 'wrangler.json'))}`} }),` : ''}
    ...recooler({ serverEnvironment: ${JSON.stringify(selected)}, htmx: { clientBannedImports: ['server-only'] } }),
    { name: 'test:inventory', async generateBundle(_, bundle) {
      await writeFile(${JSON.stringify(root)} + '/inventory-' + this.environment.name + '.json', JSON.stringify({
        outDir: this.environment.config.build.outDir,
        chunks: Object.values(bundle).filter(c => c.type === 'chunk').map(c => ({ fileName: c.fileName, isEntry: c.isEntry, moduleIds: c.moduleIds, imports: c.imports, dynamicImports: c.dynamicImports }))
      }));
    } },
    ${cf ? '' : `{ name: 'test:http', configureServer(vite) { vite.middlewares.use(async (req,res,next) => {
      if (req.url.startsWith('/@') || req.url.startsWith('/src/') || req.url.includes('recooler-handlers') || req.url.includes('/node_modules/')) return next();
      try { const app = (await vite.environments.ssr.runner.import('/src/entry.ts')).default;
        const response = await app.fetch(new Request('http://test' + req.url)); res.statusCode = response.status; res.setHeader('Content-Type','text/html'); res.end(await response.text());
      } catch(error) { next(error); }
    }); } },`}
  ],
  environments: { ${selected}: { consumer: 'server' }, client: { build: { outDir: 'custom-client', sourcemap: true, minify: false } } },
  build: { minify: false, sourcemap: true, assetsInlineLimit: 0, ${cf ? '' : `ssr: 'src/entry.ts', emitAssets: true, outDir: 'custom-server', rolldownOptions: { output: { entryFileNames: 'app.mjs' } },`} },
  server: { host: '127.0.0.1', port: 0 },
};`);
  const configFile = path.join(root, 'vite.config.mjs');
  // One real CLI invocation must build both environments and retain CF's asset step.
  const cli = fileURLToPath(new URL('../../node_modules/vite/bin/vite.js', import.meta.url));
  await execute(process.execPath, [cli, 'build', '--config', configFile], { cwd: root, env: { ...process.env, NODE_ENV: 'production' }, timeout: 60000, maxBuffer: 8e6 });
  const client = JSON.parse(await readFile(path.join(root, 'inventory-client.json'), 'utf8'));
  const serverInventory = JSON.parse(await readFile(path.join(root, `inventory-${selected}.json`), 'utf8'));
  const clientOut = path.resolve(root, client.outDir);
  const serverOut = path.resolve(root, serverInventory.outDir);
  const entry = client.chunks.find(c => c.isEntry);
  assert.equal(entry.fileName, 'assets/recooler-client.js');
  const allClient = (await Promise.all(client.chunks.map(c => Promise.all([readFile(path.join(clientOut, c.fileName), 'utf8'), readFile(path.join(clientOut, c.fileName + '.map'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })]).then(parts => parts.join('\n'))))).join('\n');
  for (const absent of ['SERVER_ONLY_7a9e', 'SERVER_SIDE_EFFECT_7a9e', 'registerActions', 'wrapAction', 'node:async_hooks']) assert(!allClient.includes(absent), absent);
  assert(allClient.includes('PUBLIC_HANDLER')); assert(allClient.includes('ADMIN_HANDLER'));
  const publicChunk = client.chunks.find(c => c.moduleIds.some(id => id.includes('/routes/index.tsx?')));
  const closure = new Set();
  const visit = file => { if (closure.has(file)) return; closure.add(file); client.chunks.find(c => c.fileName === file)?.imports.forEach(visit); };
  visit(entry.fileName); visit(publicChunk.fileName);
  assert(!client.chunks.filter(c => closure.has(c.fileName)).some(c => c.moduleIds.some(id => id.endsWith('/admin-only.ts'))));
  assert.equal(client.chunks.filter(c => c.moduleIds.some(id => id.endsWith('/shared.ts'))).length, 1);
  // The bundled slice's moved handler maps through Vite back to the original TSX.
  const code = await readFile(path.join(clientOut, publicChunk.fileName), 'utf8');
  const at = code.indexOf('PUBLIC_HANDLER'); const before = code.slice(0, at);
  const mapped = originalPositionFor(new TraceMap(JSON.parse(await readFile(path.join(clientOut, publicChunk.fileName + '.map'), 'utf8'))), { line: before.split('\n').length, column: before.length - before.lastIndexOf('\n') - 1 });
  assert.match(mapped.source, /src\/routes\/index.tsx$/); assert.equal(mapped.line, 7);
  assert.equal(mapped.column, pageSource.split('\n')[6].indexOf("'PUBLIC_HANDLER"));
  let builtApp;
  if (cf) builtPreview = await preview({ root, configFile, preview: { host: '127.0.0.1', port: 0 } });
  else builtApp = (await import(pathToFileURL(path.join(serverOut, serverInventory.chunks.find(c => c.isEntry).fileName)))).default;
  const origin = cf ? `http://127.0.0.1:${builtPreview.httpServer.address().port}` : 'http://test';
  const request = url => cf ? fetch(new URL(url, origin)) : builtApp.fetch(new Request(new URL(url, origin)));
  const html = await (await request('/')).text();
  assert.match(html, /src="[^" ]*assets\/recooler-client\.js\?v=[^" ]+"/);
  assert(!(await (await request('/plain')).text()).includes('recooler-client.js'));
  const table = await (await request('/table')).json();
  assert.deepEqual(table['routes/index.tsx'], ['components/Shared.tsx', 'routes/index.tsx']);
  assert.deepEqual(table['routes/plain/index.tsx'], []);
  const asset = html.match(/<img src="([^"]+)"/)[1];
  if (cf) { const response = await request(asset); assert.equal(response.status, 200); assert.match(await response.text(), /<svg/); }
  else assert.match(await readFile(path.join(serverOut, asset), 'utf8'), /<svg/);
  // Native ESM evaluation with a Happy DOM document; no source rewriting or
  // mocked imports. Vite preload helpers and import.meta run as emitted.
  const window = await evaluateClientPage(clientOut, html);
  const counter = window.document.querySelector('#counter');
  assert.equal(counter.textContent, '');
  assert.equal(window.document.body.dataset.loaded, 'public');
  assert.equal(window.__sharedEvaluations, 1); assert.equal(window.__adminEvaluations, undefined);
  vm.runInContext('(function(event){' + counter.getAttribute('hx-on:click') + '})', vm.createContext(window)).call(counter, new window.Event('click'));
  assert.equal(counter.textContent, 'PUBLIC_HANDLER:7:click');
  const loadWindow = await evaluateClientPage(clientOut, await (await request('/load')).text());
  assert.equal(loadWindow.document.body.dataset.loaded, 'load-only');
  await window.happyDOM.close(); await loadWindow.happyDOM.close();
  await builtPreview?.close(); builtPreview = undefined;
  // Actual server and HMR WebSocket, including virtual entry invalidation.
  server = await createServer({ root, configFile }); await server.listen();
  const devOrigin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const devHtml = await (await fetch(devOrigin + '/')).text();
  assert(!devHtml.includes('recooler-gate'));
  // Exercise the generated inline fallback with no client entry installed.
  const fallbackCode = devHtml.match(/hx-on:click="([^"]+)"/)[1].replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');
  const warnings = [];
  const fallbackWindow = { console: { warn: text => warnings.push(text) } };
  fallbackWindow.self = fallbackWindow;
  let prevented = false;
  fallbackWindow.event = { type: 'click', preventDefault() { prevented = true; } };
  vm.runInNewContext(fallbackCode, fallbackWindow);
  assert.equal(prevented, false);
  assert.deepEqual(warnings, ['recooler: dropped click while route handlers load']);
  const devEntry = devHtml.match(/<script[^>]*src="([^"]*virtual:recooler\/client[^"]*)"/)[1];
  const initial = await (await fetch(new URL(devEntry, devOrigin))).text();
  assert(initial.includes('recooler-handlers'));
  const node = server.environments.client.moduleGraph.getModuleById('\0virtual:recooler/client');
  assert(node?.transformResult);
  const token = server.config.webSocketToken;
  socket = new WebSocket(devOrigin.replace('http', 'ws') + '/?token=' + token, 'vite-hmr');
  const frames = [];
  socket.on('message', message => frames.push(JSON.parse(String(message))));
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const deadline = Date.now() + 15000;
  await write('src/components/Shared.tsx', sharedSource.replace('shared()', "shared() + ':edited'"));
  await write('src/routes/plain/index.tsx', `export default () => <button hx-on:click={() => 'new'}/>;`);
  while (!frames.some(frame => frame.type === 'full-reload') || node.transformResult) {
    assert(Date.now() < deadline, 'client entry invalidation / full-reload timed out: ' + JSON.stringify(frames));
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const slice = await (await fetch(devOrigin + '/src/components/Shared.tsx?recooler-handlers')).text();
  assert(slice.includes(':edited'));
  const transformed = await server.environments.client.transformRequest('/src/components/Shared.tsx?recooler-handlers');
  const marker = transformed.code.indexOf(':edited');
  const prefix = transformed.code.slice(0, marker);
  const original = originalPositionFor(new TraceMap(transformed.map, new URL('/src/components/Shared.tsx?recooler-handlers', devOrigin).href), { line: prefix.split('\n').length, column: prefix.length - prefix.lastIndexOf('\n') - 1 });
  assert.match(original.source, /src\/components\/Shared.tsx$/);
  assert.equal(original.line, 2);
  assert(transformed.map.sourcesContent.some(content => content.includes(":edited") && content.length === sharedSource.replace('shared()', "shared() + ':edited'").length));
  assert((await (await fetch(new URL(devEntry, devOrigin))).text()).includes('recooler-handlers'));
  console.log(JSON.stringify({ kind, cli: true, dom: true, staticModules: true, onLoad: true, sourceMap: true, noServerCode: true, hmr: true, clientOut, serverOut, chunks: client.chunks.length }));
} finally {
  socket?.terminate(); await server?.close(); await builtPreview?.close();
  await rm(root, { recursive: true, force: true });
}
