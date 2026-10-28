import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBuilder } from 'vite';
import { recooler } from '../../dist/vite/index.js';
const packageDir = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(path.join(packageDir, '.cache'), { recursive: true });
const root = await mkdtemp(path.join(packageDir, '.cache/client-options-'));
const write = async (name, code) => { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), code); };
let generation = 0;
const build = async (htmx = {}, extras = {}) => {
  const builder = await createBuilder({ root, configFile: false, logLevel: 'silent', plugins: recooler({ htmx }),
    base: '/static/', resolve: { alias: { harmless: path.join(root, 'src/server-only.ts') } },
    ssr: { noExternal: true }, build: { ssr: 'src/entry.ts', outDir: 'server', minify: false, rolldownOptions: { output: { entryFileNames: 'app.mjs' } } }, ...extras });
  await builder.buildApp();
  const app = (await import(pathToFileURL(path.resolve(root, builder.environments.ssr.config.build.outDir, 'app.mjs')).href + '?instance=' + generation++)).default;
  return { html: await (await app.fetch(new Request('http://test/'))).text(), builder };
};
try {
  await write('package.json', '{"type":"module"}'); await mkdir(path.join(root, 'node_modules')); await symlink(packageDir, path.join(root, 'node_modules/recooler'), 'dir');
  await write('src/entry.ts', `export { default } from 'virtual:recooler/app';`);
  await write('src/server-only.ts', `globalThis.__serverMarker = 1; export const db = () => 'database';`);
  await write('src/routes/index.tsx', `import { db } from '../server-only'; const update = () => db(); export default () => <button hx-on:click={() => update()}/>;`);
  await assert.rejects(build({ clientBannedImports: ['server-only'] }), error => /banned/.test(String(error)) && /update/.test(String(error)) && /db/.test(String(error)));
  // Raw specifier is harmless. The resolved-path check must still reject it,
  // including a transitive side-effect import retained in a helper module.
  await write('src/helper.ts', `import 'harmless'; export const update = () => 'client';`);
  await write('src/routes/index.tsx', `import { update } from '../helper'; export default () => <button hx-on:click={() => update()}/>;`);
  await assert.rejects(build({ clientBannedImports: ['server-only'] }), /banned imports in client chunk.*[\s\S]*server-only\.ts/);
  await write('src/routes/index.tsx', `export default () => <button hx-on:click={function () { this.textContent = 'loaded'; }}/>;`);
  await write('src/root.tsx', `import { dangerouslyPreventEscaping } from 'easy-jsx-html-engine'; export default (Content, clientScript) => props => <html><body><Content {...props}/><script>{dangerouslyPreventEscaping(clientScript ?? '')}</script></body></html>;`);
  const modern = await build(); assert(!modern.html.includes('import('), modern.html);
  const legacy = await build({ legacyClientScript: true });
  assert.match(legacy.html, /<script>import\("\/static\/assets\/recooler-client\.js\?v=[^"]+"\)<\/script>/);
  assert.match(legacy.html, /name="recooler-route" content="\/"/);
  assert(!legacy.html.includes('this.textContent'));
  // The default root continues to render URL scripts even with the shim enabled.
  await rm(path.join(root, 'src/root.tsx'));
  const defaults = await build({ legacyClientScript: true });
  assert.match(defaults.html, /type="module" src="\/static\/assets\/recooler-client.js\?v=/);
  const first = defaults.html.match(/recooler-client.js\?v=([^"]+)/)[1];
  const second = (await build()).html.match(/recooler-client.js\?v=([^"]+)/)[1];
  assert.notEqual(first, second);
  // Bad custom orchestration is an actionable error, not an empty route table.
  await assert.rejects(build({}, { builder: { buildApp: builder => builder.build(builder.environments.client) } }), /build the selected server environment before the client/);
  console.log(JSON.stringify({ clientOptions: true, rawBanned: true, resolvedBanned: true, legacyOptIn: true, cacheBusting: true }));
} finally { await rm(root, { recursive: true, force: true }); }
