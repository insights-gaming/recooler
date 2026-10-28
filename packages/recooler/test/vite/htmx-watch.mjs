import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import { recooler } from '../../dist/vite/index.js';

const packageDir = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(path.join(packageDir, '.cache'), { recursive: true });
const root = await mkdtemp(path.join(packageDir, '.cache/htmx-watch-'));
const write = async (name, code) => { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), code); };
let watcher, completed = 0, failure;
try {
  await write('package.json', '{"type":"module"}');
  await mkdir(path.join(root, 'node_modules'));
  await symlink(packageDir, path.join(root, 'node_modules/recooler'), 'dir');
  await write('src/entry.ts', `export { default } from 'virtual:recooler/app';`);
  await write('src/components/Other.tsx', `export const Other = () => <form hx-post={() => 'other'}/>;`);
  await write('src/routes/index.tsx', `import { Other } from '../components/Other'; export default () => <><form hx-post={() => 'page'}/><Other/></>;`);
  watcher = await build({ root, configFile: false, logLevel: 'silent', plugins: recooler(),
    build: { ssr: 'src/entry.ts', minify: false, sourcemap: true, watch: { buildDelay: 25 }, rolldownOptions: { output: { entryFileNames: 'app.mjs' } } } });
  watcher.on('event', event => {
    if (event.code === 'ERROR') failure = event.error;
    if (event.code === 'BUNDLE_END') completed++;
  });
  // Vite can finish the first watch build before build() returns the watcher.
  try { await access(path.join(root, 'dist/app.mjs')); completed = Math.max(completed, 1); } catch {}
  const nextBuild = async previous => {
    const deadline = Date.now() + 15000;
    while (completed <= previous) {
      if (failure) throw failure;
      if (Date.now() > deadline) throw new Error('watch rebuild timed out');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return (await import(pathToFileURL(path.join(root, 'dist/app.mjs')).href + '?generation=' + completed)).default;
  };
  const env = { RECOOLER_SECRET: 'watch-request-key' };
  const page = async app => {
    const response = await app.fetch(new Request('http://test/'), env);
    assert.equal(response.status, 200);
    return response.text();
  };
  const actions = html => [...html.matchAll(/hx-post="([^"]+)"/g)].map(match => match[1].replaceAll('&amp;', '&'));
  const post = (app, url) => app.fetch(new Request(new URL(url, 'http://test'), { method: 'POST',
    headers: { 'HX-Request': 'true', 'Sec-Fetch-Site': 'same-origin' }, body: new URLSearchParams() }), env);
  let app = await nextBuild(0);
  let urls = actions(await page(app));
  assert.equal(urls.length, 2);
  assert.equal(await (await post(app, urls[1])).text(), 'other');
  const initialPage = urls[0];
  const oldOther = urls[1];
  let previous = completed;
  await write('src/components/Other.tsx', `export const Other = () => <p>other removed</p>;`);
  app = await nextBuild(previous);
  urls = actions(await page(app));
  assert.equal(urls.length, 1);
  assert.equal(await (await post(app, urls[0])).text(), 'page', 'unchanged page action survives a cached rebuild');
  assert.equal((await post(app, oldOther)).status, 404);
  assert.equal(await (await post(app, initialPage)).text(), 'page', 'URLs from unchanged defining modules survive rebuilds');
  previous = completed;
  await write('src/routes/index.tsx', `import { Other } from '../components/Other'; export default () => <><form hx-post={() => 'inserted'}/><form hx-post={() => 'page'}/><Other/></>;`);
  app = await nextBuild(previous);
  urls = actions(await page(app));
  assert.equal(urls.length, 2);
  assert.equal((await post(app, initialPage)).status, 404, 'old position zero cannot invoke the newly inserted action');
  assert.equal(await (await post(app, urls[0])).text(), 'inserted');
  assert.equal(await (await post(app, urls[1])).text(), 'page');
  const oldPage = urls[1];
  previous = completed;
  await write('src/routes/index.tsx', `import { Other } from '../components/Other'; export default () => <><p>all actions removed</p><Other/></>;`);
  app = await nextBuild(previous);
  assert.equal(actions(await page(app)).length, 0);
  assert.equal((await post(app, oldPage)).status, 404);
  console.log(JSON.stringify({ watchBuild: true, cachedActions: true, removedActions: true }));
} finally { await watcher?.close(); await rm(root, { recursive: true, force: true }); }
