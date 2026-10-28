import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBuilder, createServer } from 'vite';
import { recooler } from '../../dist/vite/index.js';
import { evaluateClientPage } from './client-dom.mjs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { actionTransformVersion } from '../../dist/htmx/transform/index.js';
const packageDir = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(path.join(packageDir, '.cache'), { recursive: true });
const root = await mkdtemp(path.join(packageDir, '.cache/client-security-'));
const write = async (name, code) => { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), code); };
const outside = await mkdtemp('/private/tmp/recooler-client-outside-');
let generation = 0, server;
const build = async (client = {}, plugins = [], htmx = {}) => {
  const builder = await createBuilder({ root, configFile: false, logLevel: 'silent', plugins: [...plugins, ...recooler({ htmx })],
    environments: { client: { build: client } }, ssr: { noExternal: true },
    build: { ssr: 'src/entry.ts', outDir: 'server', minify: false, sourcemap: true, rolldownOptions: { output: { entryFileNames: 'app.mjs' } } } });
  await builder.buildApp();
  const app = (await import(pathToFileURL(path.join(root, 'server/app.mjs')).href + '?g=' + generation++)).default;
  return { builder, app, html: await (await app.fetch(new Request('http://test/'), { RECOOLER_SECRET: 'map-key' })).text() };
};
try {
  await write('package.json', '{"name":"recooler-test-app","type":"module"}');
  await mkdir(path.join(root, 'node_modules')); await mkdir(path.join(root, 'node_modules/@insights-gaming'), { recursive: true }); await symlink(packageDir, path.join(root, 'node_modules/@insights-gaming/recooler'), 'dir');
  await write('src/entry.ts', `export { default } from 'virtual:recooler/app';`);
  await write('src/helper.tsx', `export const unusedServer = () => 'TREE_SHAKEN_SQL_SECRET'; export const Browser = () => 'browser';`);
  await write('src/routes/index.tsx', `import { Browser } from '../helper';
/** DROPPED_JSDOC_SECRET */
const serverOnly = () => 'SERVER_ONLY_COMMENT_BODY';
/*! ROUTE_COMMENT_SECRET */
export default () => <form hx-post={() => 'ROUTE_ACTION_BODY_SECRET'}><button id="button" hx-on:click={function() { this.textContent = Browser(); }}/></form>;`);
  await write('src/routes/table/index.ts', `import { clients, namespace } from 'virtual:recooler/htmx'; export const onGet = c => c.json({ clients, namespace });`);
  await write('app.js', `globalThis.USER_ENTRY = true;`);
  await write('index.html', `<html><body><script type="module" src="/app.js"></script></body></html>`);
  const first = await build({ sourcemap: true, minify: false, rolldownOptions: { input: { 'recooler-client': 'app.js', index: 'index.html' }, output: { entryFileNames: 'assets/user-[name].js' } } });
  assert.equal(first.builder.environments.client.config.build.sourcemap, true);
  assert.equal(first.builder.environments.client.config.build.minify, false);
  const directory = path.join(root, 'dist/client/assets');
  const emitted = await readdir(directory);
  assert(emitted.includes('recooler-client.js')); assert(emitted.includes('user-recooler-client.js'));
  assert((await readFile(path.join(root, 'dist/client/index.html'), 'utf8')).includes('user-recooler-client.js'));
  const sources = (await Promise.all(emitted.filter(f => /\.(?:js|map)$/.test(f)).map(f => readFile(path.join(directory, f), 'utf8')))).join('\n');
  for (const marker of ['ROUTE_ACTION_BODY_SECRET', 'ROUTE_COMMENT_SECRET', 'DROPPED_JSDOC_SECRET', 'TREE_SHAKEN_SQL_SECRET']) assert(!sources.includes(marker), marker);
  const identities = await (await first.app.fetch(new Request('http://test/table'))).json();
  assert(!sources.includes(identities.namespace), 'server namespace never enters client JS/maps');
  const moduleHash = createHash('sha256').update(JSON.stringify([actionTransformVersion, await readFile(path.join(root, 'src/routes/index.tsx'), 'utf8')])).digest('hex');
  assert(!sources.includes(moduleHash), 'defining server module hash never enters client JS/maps');
  const entry = await readFile(path.join(directory, 'recooler-client.js'), 'utf8');
  assert(!entry.includes('routes/index.tsx')); assert(!entry.includes('helper.tsx'));
  for (const [, href] of first.html.matchAll(/rel="modulepreload" href="([^"]+)"/g)) await readFile(path.join(root, 'dist/client', href));
  assert(first.html.includes('modulepreload'));
  // Top-level server maps/minify do not become the client's defaults. The
  // default HTML entry remains in the bundle when no client input is supplied.
  await build({ sourcemap: 'inline', minify: false });
  for (const file of (await readdir(directory)).filter(f => f.endsWith('.js'))) {
    const code = await readFile(path.join(directory, file), 'utf8');
    const inline = code.match(/sourceMappingURL=data:application\/json[^,]*;base64,([^\s]+)/);
    if (!inline) continue;
    const map = Buffer.from(inline[1], 'base64').toString();
    for (const secret of ['ROUTE_ACTION_BODY_SECRET', 'ROUTE_COMMENT_SECRET', 'DROPPED_JSDOC_SECRET', 'TREE_SHAKEN_SQL_SECRET']) assert(!map.includes(secret), 'inline ' + secret);
  }
  const second = await build();
  assert.equal(second.builder.environments.client.config.build.sourcemap, false);
  assert.notEqual(second.builder.environments.client.config.build.minify, false);
  assert((await readdir(directory)).every(f => !f.endsWith('.map')));
  assert((await readFile(path.join(root, 'dist/client/index.html'), 'utf8')).includes('assets/index-'));
  const beforeHelper = second.html.match(/recooler-client.js\?v=([^"]+)/)[1];
  await write('src/helper.tsx', `export const Browser = () => 'changed-browser-helper';`);
  const changedHelper = await build();
  assert.notEqual(changedHelper.html.match(/recooler-client.js\?v=([^"]+)/)[1], beforeHelper, 'client-only helper changes the version even when pruned from the server graph');
  // An earlier pre-transform must affect server ids AND sliced handler bodies.
  await write('src/routes/index.tsx', `export default () => <button id="button" hx-on:click={function() { this.textContent = 'intended'; }}/>;`);
  const macro = { name: 'macro', enforce: 'pre', transform(code, id) {
    if (id.endsWith('/routes/index.tsx')) return code.replace('export default', 'const Banner = () => <i hx-on:click={() => 0}/>; export default');
  } };
  const third = await build({}, [macro]);
  const window = await evaluateClientPage(path.join(root, 'dist/client'), third.html);
  const button = window.document.querySelector('#button');
  vm.runInContext('(function(event){' + button.getAttribute('hx-on:click') + '})', vm.createContext(window)).call(button, new window.Event('click'));
  assert.equal(button.textContent, 'intended'); await window.happyDOM.close();
  // A current client entry must refuse a page from an earlier generation.
  const stale = await evaluateClientPage(path.join(root, 'dist/client'), second.html);
  assert.equal(stale.document.body.dataset.loaded, undefined);
  assert(stale.sessionStorage.length > 0, 'version mismatch records a reload guard');
  await stale.happyDOM.close();
  // Alias layout and root slices must use the same resolved chains as D5.
  await write('src/root.tsx', `import { DefaultRootHOC } from '@insights-gaming/recooler/jsx';
    export default Content => DefaultRootHOC(props => <><button id="root-handler" hx-on:click={function() { this.textContent = 'root handler'; }}/><Content {...props}/></>);`);
  await write('src/routes/[id]/layout.tsx', `export default Content => props => <><button id="alias-handler" hx-on:click={function() { this.textContent = 'alias handler'; }}/><Content {...props}/></>;`);
  await write('src/routes/:id/edit/index.tsx', `export const onLoad = () => { globalThis.aliasLoaded = true; }; export default () => <p>alias child</p>;`);
  const aliased = await build();
  const clientTable = await (await aliased.app.fetch(new Request('http://test/table'))).json();
  assert.deepEqual(clientTable.clients['routes/:id/edit/index.tsx'], ['root.tsx', 'routes/:id/edit/index.tsx', 'routes/[id]/layout.tsx']);
  const aliasHtml = await (await aliased.app.fetch(new Request('http://test/x/edit'))).text();
  const aliasWindow = await evaluateClientPage(path.join(root, 'dist/client'), aliasHtml);
  assert.equal(aliasWindow.aliasLoaded, true);
  for (const id of ['root-handler', 'alias-handler']) {
    const element = aliasWindow.document.getElementById(id);
    vm.runInContext('(function(event){' + element.getAttribute('hx-on:click') + '})', vm.createContext(aliasWindow)).call(element, new aliasWindow.Event('click'));
    assert.equal(element.textContent, id === 'root-handler' ? 'root handler' : 'alias handler');
  }
  await aliasWindow.happyDOM.close();
  await write('src/helper.tsx', `import { randomUUID } from 'node:crypto'; export const Browser = () => randomUUID();`);
  await write('src/routes/index.tsx', `import { Browser } from '../helper'; export default () => <button hx-on:click={() => Browser()}/>;`);
  await assert.rejects(build({}, [], { clientBannedImports: ['^node:'] }), /helper\.tsx.*node:crypto/);
  await assert.rejects(build(), /__vite-browser-external/);
  // Syntactically valid outside .tsx files must not bypass Vite's allow list.
  await writeFile(path.join(outside, 'secret.tsx'), `export default () => <button hx-on:click={() => 'OUTSIDE_SECRET'}/>;`);
  server = await createServer({ root, configFile: false, logLevel: 'silent', plugins: recooler({ htmx: {} }),
    server: { host: '127.0.0.1', port: 0, fs: { allow: [path.join(root, 'src'), packageDir] } } });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  for (const suffix of ['', '?recooler-handlers']) {
    const response = await fetch(origin + '/@fs' + path.join(outside, 'secret.tsx') + suffix);
    assert(response.status >= 400); assert(!(await response.text()).includes("'OUTSIDE_SECRET'"));
  }
  console.log(JSON.stringify({ clientSecurity: true, maps: true, userEntries: true, preloads: true, drift: true, versionGuard: true, fsAllow: true }));
} finally { await server?.close(); await rm(outside, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }
