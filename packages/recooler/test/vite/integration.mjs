import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, createServer, createBuilder } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { recooler } from '../../dist/vite/index.js';
import { serverEnvironment } from '../../dist/vite/environment.js';

const execute = promisify(execFile);
const packageDir = fileURLToPath(new URL('../../', import.meta.url));
const cacheDir = path.join(packageDir, '.cache');
await mkdir(cacheDir, { recursive: true });
const root = await mkdtemp(path.join(cacheDir, 'vite-'));
const cf = process.argv[2] === 'cloudflare';
const write = async (name, source) => {
  await mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await writeFile(path.join(root, name), source);
};
const routeSource = `export default () => <h1>recooler integration</h1>;\nexport async function onGet(c, next) {\n  if (c.req.query('crash')) throw new Error('ROUTE_MAP_FRAME');\n  await next();\n}\n`;
let server;
try {
  await mkdir(path.join(root, 'node_modules'));
  await symlink(packageDir, path.join(root, 'node_modules/recooler'), 'dir');
  await write('package.json', '{"type":"module"}');
  await write('tsconfig.json', '{"compilerOptions":{"target":"ES2022","module":"ESNext"}}');
  await write('src/routes/index.tsx', routeSource);
  await write('src/entry.ts', `import app from 'virtual:recooler/app';\napp.onError(error => Response.json({ stack: error.stack }, { status: 500 }));\nexport default app;\n`);
  const base = {
    root, configFile: false, logLevel: 'warn',
    plugins: recooler(),
    build: { ssr: 'src/entry.ts', outDir: 'dist/server', minify: false, sourcemap: true, rolldownOptions: { output: { entryFileNames: 'app.mjs' } } },
  };
  if (cf) {
    await write('wrangler.json', JSON.stringify({ name: 'recooler_custom_worker', main: 'src/entry.ts', compatibility_date: '2026-10-20', compatibility_flags: ['nodejs_als'] }));
    // Keep the platform's builder and use a non-default Worker environment name.
    base.plugins = [cloudflare({ configPath: path.join(root, 'wrangler.json'), persistState: false, inspectorPort: false }), ...recooler()];
    base.build = { minify: false, sourcemap: true };
    const builder = await createBuilder(base);
    const selected = serverEnvironment(Object.fromEntries(Object.entries(builder.environments).map(([name, env]) => [name, env.config])));
    assert.equal(selected, 'recooler_custom_worker');
    assert.notEqual(selected, Object.values(builder.environments).find(e => e.config.consumer === 'server').name);
    await builder.buildApp();
    assert.match(await readFile(path.join(root, builder.environments[selected].config.build.outDir, 'index.js'), 'utf8'), /recooler integration/);
  } else {
    // An actual vite build CLI invocation, using the installed public subpath.
    await write('vite.config.mjs', `import { recooler } from 'recooler/vite';\nexport default { plugins: recooler(), build: ${JSON.stringify(base.build)} };\n`);
    await execute(process.execPath, [path.join(packageDir, 'node_modules/vite/bin/vite.js'), 'build', root, '--config', path.join(root, 'vite.config.mjs')], { cwd: root });
    const bundle = path.join(root, 'dist/server/app.mjs');
    const { default: app } = await import(pathToFileURL(bundle));
    assert.equal((await app.fetch(new Request('http://test/'))).status, 200);
    assert.match(await (await app.fetch(new Request('http://test/'))).text(), /<h1>recooler integration<\/h1>/);
    const response = await app.fetch(new Request('http://test/?crash=1'));
    const { stack } = await response.json();
    const frame = stack.split('\n').find(line => line.includes('app.mjs:'));
    assert(frame, stack);
    const [, line, column] = frame.match(/:(\d+):(\d+)\)?$/);
    const map = new TraceMap(JSON.parse(await readFile(bundle + '.map', 'utf8')));
    const original = originalPositionFor(map, { line: Number(line), column: Number(column) - 1 });
    assert.match(original.source, /src\/routes\/index\.tsx$/);
    assert.equal(original.line, 3);
    assert.equal(map.sourcesContent[map.sources.indexOf(original.source)], routeSource);
    // The virtual entry exposes only default, even after a real SSR build.
    await build({ ...base, build: { ...base.build, ssr: true, outDir: 'dist/virtual', rolldownOptions: { input: 'virtual:recooler/app', output: { entryFileNames: 'app.mjs' } } } });
    assert.deepEqual(Object.keys(await import(pathToFileURL(path.join(root, 'dist/virtual/app.mjs')))), ['default']);
  }
  const middleware = {
    name: 'integration:http',
    configureServer(vite) {
      if (cf) return;
      vite.middlewares.use(async (req, res, next) => {
        try {
          const module = await vite.ssrLoadModule('/src/entry.ts');
          const response = await module.default.fetch(new Request('http://test' + req.url));
          res.statusCode = response.status;
          res.end(await response.text());
        } catch (error) { next(error); }
      });
    },
  };
  server = await createServer({ ...base, plugins: [...base.plugins, middleware], server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  assert.match(await (await fetch(origin)).text(), /<h1>recooler integration<\/h1>/);
  if (!cf) {
    await write('src/routes/added/index.tsx', 'export default () => <p>watched route</p>;');
    const deadline = Date.now() + 15000;
    while (true) {
      const response = await fetch(origin + '/added');
      if (response.status === 200 && (await response.text()).includes('watched route')) break;
      if (Date.now() > deadline) throw new Error('new route did not reach the dev app');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }
  console.log(JSON.stringify({ runtime: cf ? 'workerd' : 'node', build: true, devRequest: true, sourcemap: cf ? undefined : 'src/routes/index.tsx:3' }));
} finally {
  await server?.close();
  await rm(root, { recursive: true, force: true });
}
