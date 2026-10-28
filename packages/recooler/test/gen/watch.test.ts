import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { watchRoutes } from '../../src/gen/index.js';

const io = vi.hoisted(() => ({ beforeRead: undefined as ((file: string) => Promise<void>) | undefined }));
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, readFile: async (...args: Parameters<typeof original.readFile>) => {
    await io.beforeRead?.(String(args[0]));
    return original.readFile(...args);
  } };
});
const temporary: string[] = [];
afterEach(async () => {
  io.beforeRead = undefined;
  await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'recooler-watch-'));
  temporary.push(cwd);
  await mkdir(path.join(cwd, 'src/routes'), { recursive: true });
  await writeFile(path.join(cwd, 'src/routes/index.ts'), 'export const onGet = () => {};');
  return cwd;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it('serializes debounced work behind a blocked initial generation', async () => {
  const cwd = await fixture();
  const started = deferred(), release = deferred();
  let reads = 0;
  io.beforeRead = async file => {
    if (file !== path.join(cwd, 'src/routes/index.ts')) return;
    reads++;
    if (reads === 1) { started.resolve(); await release.promise; }
  };
  const pending = watchRoutes({ cwd });
  await started.promise;
  // Make the native watch deliver a debounced event while initial I/O is blocked.
  await mkdir(path.join(cwd, 'src/routes/new'));
  await writeFile(path.join(cwd, 'src/routes/new/index.ts'), 'export const onPost = () => {};');
  try {
    await new Promise(done => setTimeout(done, 150));
    expect(reads).toBe(1);
  } finally { release.resolve(); }
  const watcher = await pending;
  try {
    await vi.waitFor(async () => {
      expect(reads).toBeGreaterThan(1);
      expect(await readFile(path.join(cwd, 'src/routes.gen.ts'), 'utf8')).toContain('routes/new/index');
    }, { timeout: 3000 });
  } finally { await watcher.close(); }
});

it('close waits for in-flight generation and its result callback', async () => {
  const cwd = await fixture();
  let results = 0;
  const watcher = await watchRoutes({ cwd, onResult: () => { results++; } });
  const started = deferred(), release = deferred();
  io.beforeRead = async file => {
    if (file === path.join(cwd, 'src/routes/index.ts')) { started.resolve(); await release.promise; }
  };
  try {
    await writeFile(path.join(cwd, 'src/routes/index.ts'), 'export const onPost = () => {};');
    await started.promise;
    let closed = false;
    const closing = watcher.close().then(() => { closed = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toBe(false);
    const previous = results;
    release.resolve();
    await closing;
    expect(results).toBe(previous + 1);
    expect(closed).toBe(true);
  } finally { release.resolve(); await watcher.close(); }
});
