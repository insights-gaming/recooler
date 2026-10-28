// Full-plugin Phase 4b gates. Run after the package build, outside concurrent tests.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rename, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadavg } from 'node:os';
import { gzipSync } from 'node:zlib';
import { build, createServer } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { recooler } from '../../dist/vite/index.js';

const packageDir = fileURLToPath(new URL('../../', import.meta.url));
const generator = fileURLToPath(new URL('../../../../docs/plans/fixtures/bench/gen-app.mjs', import.meta.url));
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const cf = process.argv.includes('--cloudflare');
const samples = [], summaries = [], devSamples = [];
const cacheDir = path.join(packageDir, '.cache');
await mkdir(cacheDir, { recursive: true });
const root = await mkdtemp(path.join(cacheDir, 'htmx-bench-'));
const write = async (name, code) => { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), code); };
const modes = ['baseline', 'htmx'];
// Gates are deliberately ratios, allowing noisy shared machines. The edit gate
// also rejects the spike's multi-second serial-walk failure mode.
const limits = { buildRatio: 6, linearity100to400: 5.5, editRatio: 6, editFloorMs: 100, editMaxMs: 5000 };
try {
  await mkdir(path.join(root, 'node_modules'));
  await symlink(packageDir, path.join(root, 'node_modules/recooler'), 'dir');
  await write('package.json', '{"type":"module"}');
  await write('tsconfig.json', '{"compilerOptions":{"target":"ES2022","module":"ESNext"}}');
  await write('wrangler.json', JSON.stringify({ name: 'bench_worker', main: 'src/entry.ts', compatibility_date: '2026-10-20', compatibility_flags: ['nodejs_als'] }));
  await write('.dev.vars', 'RECOOLER_SECRET=benchmark-request-key');
  for (const grouped of [false, true]) for (const count of [100, 400, 1000]) {
    if (cf && (grouped || count === 100)) continue;
    execFileSync(process.execPath, [generator, root, String(count)]);
    if (grouped) {
      for (let index = 0; index < count; index++) {
        const dir = `src/routes/(g${index % 4})/section${index % 4}/p${index}`;
        await mkdir(path.dirname(path.join(root, dir)), { recursive: true });
        await rename(path.join(root, `src/routes/p${index}`), path.join(root, dir));
        const file = dir + '/index.tsx';
        await write(file, (await readFile(path.join(root, file), 'utf8')).replaceAll('"../../', '"../../../../'));
      }
      for (let index = 0; index < 4; index++) {
        await write(`src/routes/(g${index})/middleware.ts`, `export default async (c, next) => { c.set('group', ${index}); await next(); };`);
        await write(`src/routes/(g${index})/section${index}/middleware.ts`, `export default async (c, next) => { c.set('directory', ${index}); await next(); };`);
      }
    }
    await write('src/entry.ts', `export { default } from 'virtual:recooler/app';`);
    await write('src/routes/probe/index.tsx', `import { marker } from '../../lib/edit'; export default () => <><p>{marker}</p><form hx-post={() => 'probe'}/></>;`);
    await write('src/lib/edit.ts', `export const marker = 'before-edit';`);
    const config = mode => ({
      root, configFile: false, logLevel: 'silent', mode: 'production',
      plugins: [...(cf ? [cloudflare({ configPath: path.join(root, 'wrangler.json'), persistState: false, inspectorPort: false })] : []), ...recooler({ htmx: mode === 'baseline' ? false : {}, ...(cf ? { serverEnvironment: 'bench_worker' } : {}) })],
      resolve: { alias: { 'farm-plugin-recooler/helpers': 'recooler/jsx' } },
      build: { ssr: 'src/entry.ts', write: false, sourcemap: true, minify: false },
      server: { host: '127.0.0.1', port: 0 },
    });
    if (!cf) {
      const run = async (mode, warmup) => {
        const start = performance.now();
        const result = await build(config(mode));
        const ms = performance.now() - start;
        const chunks = (Array.isArray(result) ? result : [result]).flatMap(item => item.output).filter(item => item.type === 'chunk');
        const code = chunks.map(chunk => chunk.code).join('\n');
        assert(code.includes('page ' + (count - 1)), 'all route modules must survive');
        assert(!code.includes('__RECOOLER_ACTION_TABLE_'), 'table placeholder must be replaced');
        const sample = { count, grouped, mode, warmup, ms, bytes: Buffer.byteLength(code), gzipBytes: gzipSync(code).length, load: loadavg() };
        samples.push(sample);
        console.log(JSON.stringify(sample));
      };
      for (const mode of modes) await run(mode, true);
      for (let round = 0; round < 3; round++) for (const mode of round % 2 ? [...modes].reverse() : modes) await run(mode, false);
      const summary = { count, grouped, variants: Object.fromEntries(modes.map(mode => {
        const measured = samples.filter(sample => sample.count === count && sample.grouped === grouped && sample.mode === mode && !sample.warmup);
        return [mode, Object.fromEntries(['ms', 'bytes', 'gzipBytes'].map(key => [key, median(measured.map(sample => sample[key]))]))];
      })) };
      summary.ratio = summary.variants.htmx.ms / summary.variants.baseline.ms;
      summaries.push(summary);
      assert(summary.ratio < limits.buildRatio, JSON.stringify(summary));
    }
    for (const mode of modes) {
      let server;
      await write('src/lib/edit.ts', `export const marker = 'before-edit';`);
      try {
        const devConfig = config(mode);
        if (!cf) devConfig.plugins.push({ name: 'bench:http', configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            try {
              const app = (await vite.environments.ssr.runner.import('/src/entry.ts')).default;
              const response = await app.fetch(new Request('http://test' + req.url), { RECOOLER_SECRET: 'benchmark-request-key' });
              res.statusCode = response.status; res.end(await response.text());
            } catch (error) { next(error); }
          });
        } });
        server = await createServer(devConfig);
        await server.listen();
        const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
        assert((await (await fetch(origin + '/probe')).text()).includes('before-edit'));
        // Median of three real watcher edits and responses on the same warm server.
        const times = [];
        for (let edit = 0; edit < 3; edit++) {
          const marker = 'edit-' + edit;
          const start = performance.now();
          await write('src/lib/edit.ts', `export const marker = '${marker}';`);
          for (;;) {
            const response = await fetch(origin + '/probe');
            const html = await response.text();
            if (html.includes(marker)) break;
            if (performance.now() - start > 15000) throw new Error('edit never reached response: ' + html.slice(0, 100));
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          times.push(performance.now() - start);
        }
        const sample = { count, grouped, mode, runtime: cf ? 'workerd' : 'node', times, ms: median(times), load: loadavg() };
        devSamples.push(sample); console.log(JSON.stringify(sample));
      } finally { await server?.close(); }
    }
    const current = devSamples.filter(sample => sample.count === count && sample.grouped === grouped);
    const baseline = current.find(sample => sample.mode === 'baseline').ms;
    const full = current.find(sample => sample.mode === 'htmx').ms;
    assert(full < limits.editMaxMs && full / Math.max(baseline, limits.editFloorMs) < limits.editRatio, JSON.stringify(current));
  }
  for (const grouped of [false, true]) {
    const small = summaries.find(summary => summary.count === 100 && summary.grouped === grouped);
    const large = summaries.find(summary => summary.count === 400 && summary.grouped === grouped);
    if (small && large) assert(large.variants.htmx.ms / small.variants.htmx.ms < limits.linearity100to400, '100-to-400 build linearity');
  }
  const report = { date: new Date().toISOString(), node: process.version, limits, samples, summaries, devSamples, passed: true };
  const output = process.env.RECOOLER_BENCH_OUTPUT ?? path.join(cacheDir, cf ? 'htmx-bench-cloudflare.json' : 'htmx-bench.json');
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output, summaries, devSamples, passed: true }));
} finally { await rm(root, { recursive: true, force: true }); }
