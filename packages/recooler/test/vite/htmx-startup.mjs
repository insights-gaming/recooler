// Cold transforms, import ordering, and stable build identity regressions.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, createServer } from 'vite';
import { recooler } from '../../dist/vite/index.js';
import { actionTransformVersion } from '../../dist/htmx/transform/index.js';

const packageDir = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(path.join(packageDir, '.cache'), { recursive: true });
const directory = await mkdtemp(path.join(packageDir, '.cache/htmx-startup-'));
const root = path.join(directory, 'original');
const relocated = path.join(directory, 'relocated');
const write = async (file, content) => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content);
};
const source = `export const Form = () => <form hx-post={() => 'signed'}/>;`;
const env = { RECOOLER_SECRET: 'startup-regression-only' };
const request = (app, url, init) => app.fetch(new Request(new URL(url, 'http://test'), init), env);
const action = async app => {
  const response = await request(app, '/');
  const html = await response.text();
  assert.equal(response.status, 200, html);
  return html.match(/hx-post="([^"]+)"/)[1].replaceAll('&amp;', '&');
};
const submit = (app, url) => request(app, url, { method: 'POST', headers: { 'HX-Request': 'true', 'Sec-Fetch-Site': 'same-origin' }, body: new URLSearchParams() });
const graph = async app => (await request(app, '/table')).json();
let server;
try {
  await write('package.json', '{"name":"startup-app-a","type":"module"}');
  await mkdir(path.join(root, 'node_modules'));
  await symlink(packageDir, path.join(root, 'node_modules/recooler'), 'dir');
  await write('src/components/Form.tsx', source);
  await write('src/routes/index.tsx', `import { Form } from '../components/Form'; export default Form;`);
  await write('src/routes/table/index.ts', `import { table, namespace } from 'virtual:recooler/htmx'; export const onGet = c => c.json({ table, namespace });`);
  await write('src/entry.ts', `export { default } from 'virtual:recooler/app';`);
  await write('src/custom.ts', `import { manifest } from './routes.gen';
import { createApp } from 'recooler/router';
import { jsxPages } from 'recooler/jsx';
import { htmx } from 'recooler/htmx';
import { table, namespace } from 'virtual:recooler/htmx';
export default createApp(manifest, { pages: jsxPages(), extensions: [htmx({ table, namespace, secret: env => env.RECOOLER_SECRET })] });`);
  for (const mode of ['warmup', 'manifest-first']) {
    server = await createServer({ root, configFile: false, logLevel: 'silent', plugins: recooler(),
      environments: { ssr: { dev: { warmup: mode === 'warmup' ? ['./src/routes/**/*.tsx', './src/components/*.tsx'] : [] } } },
      server: { middlewareMode: true, ws: false } });
    if (mode === 'warmup') {
      // Await the configured warmup requests, ensuring Vite has cached their
      // transforms before any entry/table is evaluated. No timing-based sleep.
      await Promise.all(['/src/routes/index.tsx', '/src/components/Form.tsx'].map(id => server.environments.ssr.warmupRequest(id)));
    }
    const app = (await server.environments.ssr.runner.import(mode === 'warmup' ? '/src/entry.ts' : '/src/custom.ts')).default;
    assert.deepEqual((await graph(app)).table, { 'routes/index.tsx': ['components/Form.tsx'] });
    assert.equal(await (await submit(app, await action(app))).text(), 'signed');
    await server.close(); server = undefined;
  }
  let sequence = 0;
  const compile = async (buildRoot = root, options = {}) => {
    const outDir = 'dist-' + sequence++;
    await build({ root: buildRoot, configFile: false, logLevel: 'silent', plugins: recooler(options),
      build: { ssr: 'src/entry.ts', outDir, minify: false, rolldownOptions: { output: { entryFileNames: 'app.mjs' } } } });
    const file = path.join(buildRoot, outDir, 'app.mjs');
    const code = await readFile(file, 'utf8');
    assert(code.includes(createHash('sha256').update(JSON.stringify([actionTransformVersion, source])).digest('hex')), 'hash binds source and action numbering version');
    return (await import(pathToFileURL(file))).default;
  };
  const appA = await compile();
  const namespaceA = (await graph(appA)).namespace;
  const urlA = await action(appA);
  assert.equal((await submit(appA, urlA)).status, 200);
  await write('package.json', '{"name":"startup-app-b","type":"module"}');
  const appB = await compile();
  assert.notEqual((await graph(appB)).namespace, namespaceA, 'different named apps at the same absolute path');
  assert.equal((await submit(appB, urlA)).status, 404, 'shared component and secret cannot authorize cross-app replay');
  await write('package.json', '{"name":"startup-app-a","type":"module"}');
  await mkdir(relocated);
  await cp(path.join(root, 'src'), path.join(relocated, 'src'), { recursive: true });
  await cp(path.join(root, 'package.json'), path.join(relocated, 'package.json'));
  await mkdir(path.join(relocated, 'node_modules'));
  await symlink(packageDir, path.join(relocated, 'node_modules/recooler'), 'dir');
  const moved = await compile(relocated);
  assert.equal((await graph(moved)).namespace, namespaceA, 'checkout path does not change app identity');
  assert.equal((await submit(moved, urlA)).status, 200);
  const overridden = await compile(root, { htmx: { namespace: 'explicit-app' } });
  const explicit = (await graph(overridden)).namespace;
  assert.notEqual(explicit, namespaceA);
  assert.equal((await submit(overridden, urlA)).status, 404);
  await write('package.json', '{"name":"renamed-package","type":"module"}');
  assert.equal((await graph(await compile(root, { htmx: { namespace: 'explicit-app' } }))).namespace, explicit);
  await write('src/package.json', '{"name":"nearest-package","type":"module"}');
  const nearest = (await graph(await compile())).namespace;
  assert.notEqual(nearest, namespaceA);
  await write('package.json', '{"name":"different-ancestor","type":"module"}');
  assert.equal((await graph(await compile())).namespace, nearest, 'use the nearest package rather than an ancestor');
  await assert.rejects(() => compile(root, { htmx: { namespace: '' } }), /namespace must be nonempty/);
  console.log(JSON.stringify({ warmup: true, manifestFirst: true, stableIdentity: true, samePathReplay: true, transformVersion: true }));
} finally { await server?.close(); await rm(directory, { recursive: true, force: true }); }
