import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBuilder } from 'vite';
import { recooler } from '../../dist/vite/index.js';
const packageDir = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(path.join(packageDir, '.cache'), { recursive: true });
const root = await mkdtemp(path.join(packageDir, '.cache/client-watch-'));
const write = async (name, code) => { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), code); };
const watchers = [];
let completed = 0, serverCompleted = 0, error;
const nextBuild = async previous => {
  const deadline = Date.now() + 15000;
  while (completed <= previous || serverCompleted < completed) {
    if (error) throw error;
    assert(Date.now() < deadline, 'ordered client watch rebuild');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const directory = path.join(root, 'dist/client/assets');
  const seen = new Set();
  const read = async name => {
    if (seen.has(name)) return '';
    seen.add(name);
    const code = await readFile(path.join(directory, name), 'utf8');
    return code + (await Promise.all([...code.matchAll(/from\s*["']\.\/([^"']+\.js)["']/g)].map(match => read(match[1])))).join('\n');
  };
  return read('recooler-client.js');
};
try {
  await write('package.json', '{"name":"recooler-test-app","type":"module"}');
  await mkdir(path.join(root, 'node_modules')); await symlink(packageDir, path.join(root, 'node_modules/recooler'), 'dir');
  await write('src/entry.ts', `export { default } from 'virtual:recooler/app';`);
  await write('src/routes/index.tsx', `export default () => <button hx-on:click={() => 1}/>;`);
  await write('src/routes/b/index.tsx', `export default () => <p>B</p>;`);
  const builder = await createBuilder({ root, configFile: false, logLevel: 'silent', plugins: [
    { name: 'capture-watchers', buildApp: { order: 'pre', handler(builder) {
      const build = builder.build;
      builder.build = async environment => {
        const result = await build(environment);
        if (result?.on) { watchers.push(result); result.on('event', e => {
          if (e.code === 'ERROR') error = e.error;
          if (e.code === 'END') serverCompleted++;
        }); }
        return result;
      };
    } } }, ...recooler({ htmx: {} }),
    { name: 'client-completed', writeBundle() { if (this.environment.name === 'client') completed++; } },
  ], ssr: { noExternal: true }, build: { ssr: 'src/entry.ts', outDir: 'server', watch: { buildDelay: 30 },
    rolldownOptions: { output: { entryFileNames: 'app.mjs' } } } });
  await builder.buildApp();
  // Client writeBundle can finish before the server watcher enrolls its files.
  // Await the complete watch cycle before making the next edit.
  const first = await nextBuild(0);
  assert(!first.includes('"/b"'));
  const previous = completed;
  await write('src/routes/b/index.tsx', `export const onLoad = () => { document.body.dataset.b = 'new'; }; export default () => <button hx-on:click={() => 2}/>;`);
  const second = await nextBuild(previous);
  assert(second.includes('"/b"'), second);
  assert.notEqual(first, second);
  const count = completed;
  await write('src/routes/b/index.tsx', `export default () => <p>client removed</p>;`);
  const third = await nextBuild(count);
  assert(!third.includes('"/b"'));
  const beforeNewRoute = completed;
  await write('src/routes/c/index.tsx', `export default () => <button hx-on:click={() => 3}/>;`);
  const fourth = await nextBuild(beforeNewRoute);
  assert(fourth.includes('"/c"'));
  const beforeDelete = completed;
  await rm(path.join(root, 'src/routes/c'), { recursive: true });
  const fifth = await nextBuild(beforeDelete);
  assert(!fifth.includes('"/c"'));
  assert.equal(watchers.length, 1, 'one server watcher owns the client rebuild order');
  console.log(JSON.stringify({ clientWatch: true, addedHandlers: true, removedHandlers: true }));
} finally { for (const watcher of watchers) await watcher.close(); await rm(root, { recursive: true, force: true }); }
