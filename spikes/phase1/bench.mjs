import { build } from 'vite';
import { execFileSync } from 'node:child_process';
import { readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { graphPlugin } from './graph-plugin.mjs';
import { base, write } from './fixture.mjs';
const median = xs => [...xs].sort((a,b) => a-b)[Math.floor(xs.length / 2)];
const records = [];
const variants = ['none', 'graph', 'aggregator'];
for (const count of [400, 1000]) {
  const root = join(base, '.generated/bench-' + count);
  execFileSync(process.execPath, [join(base, '../../docs/plans/fixtures/bench/gen-app.mjs'), root, '' + count]);
  write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'easy-jsx-html-engine', verbatimModuleSyntax: true } }));
  write(root, 'src/root.tsx', 'export default () => "root";');
  const paths = readdirSync(join(root, 'src/routes'), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => `src/routes/${e.name}/index.tsx`);
  const routes = Object.fromEntries(paths.map((p,i) => ['/p' + i, [join(root,p), join(root,'src/root.tsx')]]));
  async function run(mode, warmup) {
    const imports = paths.map((p,i) => `import * as p${i} from './${p.slice(4)}';`).join('\n');
    const list = paths.map((_,i) => `p${i}`).join(',');
    write(root, 'src/entry.ts', `${imports}\nimport * as root from './root';
${mode === 'aggregator' ? `
function collect(roots) { const seen = new Set(), actions = {}; const stack = roots.map(ns => ns.__recooler).filter(f => typeof f === 'function');
while(stack.length) { const f=stack.pop(); if(seen.has(f)) continue; seen.add(f); const node=f(); Object.assign(actions,node.actions); for(const dep of node.deps) { const g=dep(); if(typeof g==='function') stack.push(g); } } return actions; }
globalThis.__actions = [${paths.map((_, i) => `collect([p${i}, root])`).join(',')}];`
: `import { getTable } from 'virtual:spike-runtime'; globalThis.__table = getTable;`}
globalThis.__pages = [${list}, root];`);
    const stats = {};
    const start = performance.now();
    const result = await build({ root, configFile: false, logLevel: 'silent', ssr: { noExternal: true },
      plugins: [graphPlugin({ root, routes, mode, stats })],
      build: { ssr: join(root,'src/entry.ts'), sourcemap: true, minify: false, write: false } });
    const ms = performance.now() - start;
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(r => r.output);
    const code = outputs.filter(o => o.type === 'chunk').map(c => c.code).join('\n');
    const record = { count, mode, warmup, ms, graphMs: stats.graphMs, resolveCalls: stats.resolveCalls, bytes: Buffer.byteLength(code), gzipBytes: gzipSync(code).length, load: execFileSync('uptime', { encoding: 'utf8' }).trim() };
    records.push(record);
    console.log(JSON.stringify(record));
  }
  console.log(execFileSync('uptime', { encoding:'utf8' }).trim());
  for (const mode of variants) await run(mode, true);
  for (let n=0; n<5; n++) for (const mode of n % 2 ? [...variants].reverse() : variants) await run(mode, false);
}
const summary = [400,1000].map(count => ({ count, variants: Object.fromEntries(variants.map(mode => {
  const rs=records.filter(r => r.count === count && r.mode === mode && !r.warmup);
  return [mode, Object.fromEntries(['ms','graphMs','resolveCalls','bytes','gzipBytes'].map(key => [key,median(rs.map(r=>r[key]))]))];
})) }));
writeFileSync(new URL('results/bench.json', import.meta.url), JSON.stringify({ date: new Date().toISOString(), node: process.version, records, summary }, null, 2) + '\n');
console.log(JSON.stringify(summary,null,2));
