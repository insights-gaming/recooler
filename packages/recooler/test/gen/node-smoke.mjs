import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await mkdtemp(path.join(tmpdir(), 'recooler-node-smoke-'));
const cli = path.join(pkgRoot, 'dist/gen/cli.js');
const tsc = path.join(pkgRoot, 'node_modules/typescript/bin/tsc');
async function put(file, content) { const full = path.join(dir, file); await mkdir(path.dirname(full), { recursive: true }); await writeFile(full, content); }
function run(binary, args, expected = 0) {
  const result = spawnSync(binary, args, { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, expected, result.stdout + result.stderr);
}
try {
  await put('package.json', '{"type":"module"}');
  await mkdir(path.join(dir, 'node_modules'));
  await symlink(pkgRoot, path.join(dir, 'node_modules/recooler'));
  await put('src/routes/(staff)/middleware.ts', 'export default async (c: any, next: any) => c.req.header("x-staff") === "yes" ? next() : c.text("blocked", 401);');
  await put('src/routes/(staff)/posts/[id]/index.ts', 'export function onPost(c: any) { return c.text("post:" + c.req.param("id")); }');
  await put('src/routes/.well-known/index.ts', 'export function onGet(c: any) { return c.text("hidden"); }');
  await put('src/entry.ts', 'import { createApp } from "recooler/router"; import { manifest } from "./routes.gen.js"; export default createApp(manifest);');
  await put('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', rootDir: 'src', outDir: 'build', strict: true, skipLibCheck: true }, include: ['src'] }));
  run(process.execPath, [cli, 'generate', '--import-extension', '.js']);
  run(process.execPath, [cli, 'generate', '--import-extension', '.js', '--check']);
  run(process.execPath, [tsc, '-p', 'tsconfig.json']);
  const { default: app } = await import(pathToFileURL(path.join(dir, 'build/entry.js')));
  assert.equal((await app.request('/posts/7', { method: 'POST' })).status, 401);
  assert.equal(await (await app.request('/posts/7', { method: 'POST', headers: { 'x-staff': 'yes' } })).text(), 'post:7');
  assert.equal(await (await app.request('/.well-known')).text(), 'hidden');
  assert.equal((await app.request('/not-found')).status, 404);
  assert.equal((await app.request('/.well-known', { method: 'HEAD' })).status, 200);
  await put('src/routes/new/index.ts', 'export function onGet(c: any) { return c.text("new"); }');
  run(process.execPath, [cli, 'generate', '--import-extension', '.js', '--check'], 1);
  // Static export-star names are intentionally deferred to actual runtime namespaces.
  await put('src/shared.ts', 'export function onGet(c: any) { return c.text("star"); }');
  await put('src/routes/(a)/star/index.ts', 'export * from "../../../shared.js";');
  await put('src/routes/(b)/star/index.ts', 'export * from "../../../shared.js";');
  run(process.execPath, [cli, 'generate', '--import-extension', '.js']);
  run(process.execPath, [tsc, '-p', 'tsconfig.json']);
  const { manifest } = await import(pathToFileURL(path.join(dir, 'build/routes.gen.js')).href + '?version=2');
  const { createApp } = await import(pathToFileURL(path.join(pkgRoot, 'dist/router/index.js')));
  assert.throws(() => createApp(manifest), /match the same requests.*both respond to GET/);
  console.log('PASS: compiled CLI generate/check, TypeScript 7 NodeNext compilation, plain Node GET/HEAD/POST/404, group guard, stale check, runtime export-star conflict');
} finally { await rm(dir, { recursive: true, force: true }); }
