import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import WebSocket from 'ws';
import { recooler } from '../../dist/vite/index.js';
const pkg = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(path.join(pkg, '.cache'), { recursive: true });
const root = await mkdtemp(path.join(pkg, '.cache/client-hmr-'));
const write = async (name, value) => { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), value); };
let server, ws;
try {
  await write('package.json', '{"name":"client-hmr","type":"module"}');
  await mkdir(path.join(root, 'node_modules')); await symlink(pkg, path.join(root, 'node_modules/recooler'), 'dir');
  await write('src/entry.ts', `export { default } from 'virtual:recooler/app';`);
  await write('src/routes/index.tsx', `export default () => <button hx-on:click={() => 1}/>;`);
  await write('index.html', `<script type="module" src="/spa/main.ts"></script>`);
  await write('spa/main.ts', `import './style.css'; export const x = 1; if (import.meta.hot) import.meta.hot.accept();`);
  await write('spa/style.css', 'body{color:red}');
  server = await createServer({ root, configFile: false, logLevel: 'silent', plugins: recooler({ htmx: {} }), server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  for (const url of ['/', '/spa/main.ts', '/spa/style.css']) await (await fetch(origin + url)).text();
  const app = (await server.environments.ssr.runner.import('/src/entry.ts')).default;
  await app.fetch(new Request('http://test/'), { RECOOLER_SECRET: 'test' });
  ws = new WebSocket(origin.replace('http', 'ws') + '/?token=' + server.config.webSocketToken, 'vite-hmr');
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const messages = []; ws.on('message', message => messages.push(JSON.parse(String(message))));
  for (const [file, value] of [['spa/style.css', 'body{color:blue}'], ['spa/main.ts', `import './style.css'; export const x = 2; if (import.meta.hot) import.meta.hot.accept();`]]) {
    messages.length = 0;
    await write(file, value);
    const deadline = Date.now() + 5000;
    while (!messages.some(m => m.type === 'update')) { assert(Date.now() < deadline, JSON.stringify(messages)); await new Promise(r => setTimeout(r, 20)); }
    await new Promise(r => setTimeout(r, 100));
    assert(!messages.some(m => m.type === 'full-reload'), JSON.stringify(messages));
  }
  // Changing the onLoad bit changes the client loading table even if its slice
  // list stays the same, so the generated route entry must be invalidated.
  await fetch(origin + '/@id/virtual:recooler/client');
  const entry = server.environments.client.moduleGraph.getModuleById('\0virtual:recooler/client');
  assert(entry?.transformResult);
  messages.length = 0;
  await write('src/routes/index.tsx', `export const onLoad = () => console.log('new onLoad'); export default () => <button hx-on:click={() => 1}/>;`);
  const deadline = Date.now() + 5000;
  while (!messages.some(m => m.type === 'full-reload')) { assert(Date.now() < deadline, JSON.stringify(messages)); await new Promise(r => setTimeout(r, 20)); }
  assert.equal(entry.transformResult, null);
  assert((await (await fetch(origin + '/@id/virtual:recooler/client')).text()).includes('"onLoad"'));
  console.log(JSON.stringify({ clientHmr: true, cssUpdateOnly: true, tsUpdateOnly: true }));
} finally { ws?.terminate(); await server?.close(); await rm(root, { recursive: true, force: true }); }
