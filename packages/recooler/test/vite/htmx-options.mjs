import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, createLogger } from 'vite';
import { recooler } from '../../dist/vite/index.js';

const packageDir = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(path.join(packageDir, '.cache'), { recursive: true });
const root = await mkdtemp(path.join(packageDir, '.cache/htmx-options-'));
const write = async (name, code) => { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), code); };
let instance = 0;
const compile = async (extra = {}, options = {}) => {
  const outDir = 'dist/' + instance++;
  await build({ root, configFile: false, logLevel: 'silent', plugins: recooler(options),
    build: { ssr: 'src/entry.ts', outDir, minify: false, sourcemap: true, rolldownOptions: { output: { entryFileNames: 'app.mjs' } } }, ...extra });
  return { load: () => import(pathToFileURL(path.join(root, outDir, 'app.mjs'))), code: await readFile(path.join(root, outDir, 'app.mjs'), 'utf8') };
};
try {
  await write('package.json', '{"type":"module"}');
  await write('src/routes/index.tsx', `export default () => <form hx-post={() => 'signed'}/>;`);
  await mkdir(path.join(root, 'node_modules'));
  await symlink(packageDir, path.join(root, 'node_modules/recooler'), 'dir');
  for (const mode of ['production', 'development']) {
    await write('src/entry.ts', `import { htmx } from 'recooler/htmx'; export default htmx({ table: {}, secret: { unsafeUnsigned: true } });`);
    const output = await compile({ mode });
    await assert.rejects(output.load, /unsafeUnsigned is forbidden in production/);
  }
  await write('src/entry.ts', `import { htmx, unsafeUnsignedMarker } from 'recooler/htmx'; const extension = htmx({ table: {}, secret: { unsafeUnsigned: true }, allowUnsignedInProduction: true }); export default extension[unsafeUnsignedMarker];`);
  assert.equal((await (await compile()).load()).default, true);
  // htmx:false also keeps the production guard for custom runtime entries.
  await write('src/entry.ts', `import { htmx } from 'recooler/htmx'; export default htmx({ table: {}, secret: { unsafeUnsigned: true } });`);
  await assert.rejects((await compile({}, { htmx: false })).load, /forbidden in production/);
  await write('src/entry.ts', `export { default } from 'virtual:recooler/app';`);
  await write('src/routes/index.tsx', `export default () => { const local = () => 1; return <form hx-post={() => local()}/>; };`);
  await assert.rejects(() => compile(), error => {
    assert.match(String(error), /local/);
    assert.match(String(error), /index\.tsx/);
    assert.match(String(error), /1:|1 \u2502|1\s*\|/);
    return true;
  });
  await write('src/routes/index.tsx', `export default () => <form hx-post={() => 'signed'}/>;`);
  await write('src/root.tsx', `export const onLoad = () => {}; export default Content => props => <><form hx-post={() => 'root'}/><Content {...props}/></>;`);
  const warnings = [];
  const customLogger = createLogger('silent');
  customLogger.warn = message => warnings.push(message);
  await compile({ customLogger });
  assert(warnings.some(message => message.includes('onLoad') && message.includes('root.tsx') && /1:|1 \u2502|1\s*\|/.test(message)), warnings.join('\n'));
  console.log(JSON.stringify({ productionGuard: true, explicitOverride: true, diagnosticsLocated: true }));
} finally { await rm(root, { recursive: true, force: true }); }
