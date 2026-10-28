import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { mkdirSync, watch as fsWatch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { watchRoutes } from '../../src/gen/index.js';

const io = vi.hoisted(() => ({
  beforeRead: undefined as ((file: string) => Promise<void>) | undefined,
  beforeWatch: undefined as ((dir: string) => void) | undefined,
}));
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, readFile: async (...args: Parameters<typeof original.readFile>) => {
    await io.beforeRead?.(String(args[0]));
    return original.readFile(...args);
  } };
});
vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, watch: vi.fn((...args: Parameters<typeof original.watch>) => {
    io.beforeWatch?.(String(args[0]));
    return original.watch(...args);
  }) };
});
const temporary: string[] = [];
afterEach(async () => {
  io.beforeRead = undefined;
  io.beforeWatch = undefined;
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
  const ready = deferred();
  const pending = watchRoutes({ cwd, onReady: ready.resolve });
  await ready.promise;
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
    }, { timeout: 10000 });
  } finally { await watcher.close(); }
}, 30000);

it('close waits for in-flight generation and its result callback', async () => {
  const cwd = await fixture();
  let results = 0;
  const ready = deferred();
  const watcher = await watchRoutes({ cwd, onReady: ready.resolve, onResult: () => { results++; } });
  await ready.promise;
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
}, 30000);


it('uses only non-recursive ancestor watches for a missing nested srcDir', async () => {
  const cwd = await fixture();
  const results: string[] = [];
  vi.mocked(fsWatch).mockClear();
  const ready = deferred();
  const watcher = await watchRoutes({ cwd, srcDir: 'missing/source', routesDir: 'src/routes', out: 'generated/routes.ts',
    onReady: ready.resolve, onResult: result => results.push(result.code) });
  await ready.promise;
  try {
    expect(vi.mocked(fsWatch).mock.calls.map(call => [call[0], call[1]])).toContainEqual([cwd, { recursive: false }]);
    expect(vi.mocked(fsWatch).mock.calls.filter(call => (call[1] as { recursive?: boolean }).recursive).map(call => call[0]))
      .toEqual([path.join(cwd, 'src/routes')]);
    // Create the child between the ancestor stat and watch enrollment. Linux
    // does not replay that creation to the newly attached ancestor watcher.
    io.beforeWatch = dir => {
      if (dir !== path.join(cwd, 'missing')) return;
      io.beforeWatch = undefined;
      mkdirSync(path.join(cwd, 'missing/source'));
      writeFileSync(path.join(cwd, 'missing/source/root.tsx'), 'export const head = {};');
    };
    await mkdir(path.join(cwd, 'missing'));
    await vi.waitFor(() => expect(results.at(-1)).toContain('rootFile: "root.tsx"'), { timeout: 10000 });
    // The newly created source watcher must also notice subsequent root edits.
    await rm(path.join(cwd, 'missing/source/root.tsx'));
    await vi.waitFor(() => expect(results.at(-1)).not.toContain('rootFile:'), { timeout: 10000 });
    // Replacing either parent must reattach watches to the new inodes.
    for (const dir of ['missing', 'missing/source']) {
      await rm(path.join(cwd, dir), { recursive: true });
      await mkdir(path.join(cwd, 'missing/source'), { recursive: true });
      await writeFile(path.join(cwd, 'missing/source/root.tsx'), 'export const head = {};');
      await vi.waitFor(() => expect(results.at(-1)).toContain('rootFile: "root.tsx"'), { timeout: 10000 });
      await rm(path.join(cwd, 'missing/source/root.tsx'));
      await vi.waitFor(() => expect(results.at(-1)).not.toContain('rootFile:'), { timeout: 10000 });
    }
  } finally { await watcher.close(); }
}, 30000);

for (const replacement of ['remove', 'rename']) {
  it(`reattaches an existing srcDir after ${replacement}`, async () => {
    const cwd = await fixture();
    const source = path.join(cwd, 'source');
    await mkdir(source);
    const results: string[] = [];
    const watcher = await watchRoutes({ cwd, srcDir: 'source', routesDir: 'src/routes', out: 'generated/routes.ts',
      onResult: result => results.push(result.code) });
    try {
      if (replacement === 'remove') await rm(source, { recursive: true });
      else await rename(source, path.join(cwd, 'old-source'));
      await mkdir(source);
      await writeFile(path.join(source, 'root.tsx'), 'export const head = {};');
      await vi.waitFor(() => expect(results.at(-1)).toContain('rootFile: "root.tsx"'), { timeout: 10000 });
      await rm(path.join(source, 'root.tsx'));
      await vi.waitFor(() => expect(results.at(-1)).not.toContain('rootFile:'), { timeout: 10000 });
    } finally { await watcher.close(); }
  }, 30000);
}

it('serializes source enrollment behind initial readiness', async () => {
  const cwd = await fixture();
  const source = path.join(cwd, 'src');
  const original = await vi.importActual<typeof import('node:fs')>('node:fs');
  const implementation = vi.mocked(fsWatch).getMockImplementation()!;
  const started = deferred(), release = deferred();
  let sourceWatches = 0;
  const watch = (dir: string, options: { recursive?: boolean }, listener: (event: string, filename: string | null) => void) => {
    if (String(dir) !== source) return original.watch(dir, options, listener);
    sourceWatches++;
    return original.watch(dir, options, (event, filename) => {
      if (String(filename).startsWith('.recooler-watch-ready-')) {
        // Deliver a source event while holding the native readiness event.
        listener('rename', 'root.tsx');
        started.resolve();
        void release.promise.then(() => listener(event, filename));
      } else listener(event, filename);
    });
  };
  vi.mocked(fsWatch).mockImplementation(watch as typeof fsWatch);
  const pending = watchRoutes({ cwd });
  let watcher: Awaited<typeof pending> | undefined;
  try {
    await started.promise;
    await new Promise(done => setTimeout(done, 150));
    expect(sourceWatches).toBe(1);
  } finally {
    release.resolve();
    try { watcher = await pending; }
    finally { await watcher?.close(); vi.mocked(fsWatch).mockImplementation(implementation); }
  }
}, 30000);
