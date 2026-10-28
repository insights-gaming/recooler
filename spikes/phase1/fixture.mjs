import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const base = fileURLToPath(new URL('.', import.meta.url));
export function write(root, path, code) { const file = join(root, path); mkdirSync(resolve(file, '..'), { recursive: true }); writeFileSync(file, code); }
export function fixture(name, verbatim = true) {
  const root = join(base, '.generated', name);
  rmSync(root, { force: true, recursive: true });
  const files = {
    'tsconfig.json': JSON.stringify({ compilerOptions: { verbatimModuleSyntax: verbatim, jsx: 'react-jsx', jsxImportSource: 'easy-jsx-html-engine' } }),
    'node_modules/spike-actions/package.json': JSON.stringify({ name: 'spike-actions', version: '1.0.0', type: 'module', exports: './index.js' }),
    'node_modules/spike-actions/index.js': '/* @action */ export const dep = 42;',
    'outside/component.ts': '/* @action */ export const outside = 3;',
    'src/types.ts': '/* @action */ export interface TypeOnly { a: string };',
    'src/unused.ts': '/* @action */ export const unused = 12;',
    'src/side.ts': '/* @action */ globalThis.__spikeSide = true;',
    'src/cycle-a.ts': "/* @action */ import './cycle-b'; export const a = 1;",
    'src/cycle-b.ts': "/* @action */ import './cycle-a'; export const b = 2;",
    'src/barrel.ts': "export * from './component'; export { a } from './cycle-a'; export { admin } from './admin';",
    'src/component.ts': '/* @action */ export const component = 1;',
    'src/admin.ts': '/* @action */ export const admin = 99;',
    'src/dynamic.ts': '/* @action */ export const dynamic = 20;',
    'src/root.ts': '/* @action */ export const root = true;',
    'src/layout.ts': '/* @action */ export const layout = true;',
    'src/route.ts': `/* @action */
import type { TypeOnly } from './types';
import { unused } from './unused';
import './side';
import { component } from './barrel';
import { outside } from '../outside/component';
import { dep } from 'spike-actions';
export const answer = component + outside + dep;
export const later = () => import('./dynamic');`,
    'src/entry.ts': `import { getTable, getActions } from 'virtual:spike-runtime';
import { answer } from './route'; import './root'; import './layout';
export default { async fetch(request) { return Response.json({ answer, table: await getTable(), actions: await getActions('/public') }); } };`,
  };
  for (const [path, code] of Object.entries(files)) write(root, path, code);
  const routes = { '/public': ['src/route.ts', 'src/root.ts', 'src/layout.ts'].map(p => join(root, p)) };
  return { root, routes };
}
export function config(root, plugins, extra = {}) {
  return { root, configFile: false, logLevel: 'error', plugins,
    ssr: { noExternal: true }, optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [base] } },
    build: { ssr: join(root, 'src/entry.ts'), sourcemap: true, minify: false, outDir: 'dist/server',
      rolldownOptions: { output: { entryFileNames: 'entry.mjs' } } }, ...extra };
}
