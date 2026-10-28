import { build } from '@farmfe/core';
import recooler from 'farm-plugin-recooler';
import { cp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const fixtures = process.argv[2];
if (!fixtures) throw new Error('Usage: node capture-farm.mjs /absolute/path/to/fixtures');
for (const [name, paths] of [['default-root', ['/', '/nested/42?x=1', '/replace']], ['custom-root', ['/']]]) {
  const root = resolve(import.meta.dirname, name);
  await cp(resolve(fixtures, name), root, { recursive: true });
  process.chdir(root);
  await build({ root, compilation: {
    input: { main: 'recooler::app' }, output: { path: 'build', format: 'esm', targetEnv: 'library', filename: '[resourceName].[ext]' },
    partialBundling: { enforceResources: [{name: 'main',test: ['.+']}] },
    minify: false, sourcemap: false, persistentCache: false, progress: false,
  }, plugins: [['@farmfe/plugin-react', {runtime:'automatic', importSource:'easy-jsx-html-engine',useBuiltins:true,throwIfNamespace:false,refresh:false,development:false}], recooler({})] });
  const app = (await import(`${root}/build/main.js`)).default;
  for (const [i,path] of paths.entries()) {
    const response = await app.request(`http://localhost${path}`);
    if (response.status !== 200) throw new Error(`Bad status: ${response.status}`);
    const html = await response.text();
    await writeFile(resolve(fixtures, name, `expected-${i}.html`), html);
    console.log(name, path, html);
  }
}
