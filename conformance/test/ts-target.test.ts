import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
import { tsCacheDirectory, tsRequestSkipReason, tsTarget, tsUnavailable } from '../src/targets/ts.js';
import type { BuiltApp, Scenario } from '../src/target.js';

const scenario: Scenario = { name: 'adapter contract', source: 'test', requests: [{ name: 'one', path: '/', expect: { status: 200 } }] };
const fixture = async (dir: string, source: string) => {
  await mkdir(path.join(dir, 'src/routes'), { recursive: true });
  await writeFile(path.join(dir, 'src/routes/index.tsx'), source);
};

test.skipIf(!!await tsUnavailable())('TS builds reuse content-addressed bytes, isolate dependencies and survive forced rebuilds', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'recooler-ts-target-'));
  const previous = process.env.CONFORMANCE_REBUILD;
  delete process.env.CONFORMANCE_REBUILD;
  try {
    for (const name of ['one', 'two']) {
      await fixture(path.join(root, name), `import { increment } from '../counter'; export const onGet = c => c.text(String(increment())); // ${root}\n`);
      await writeFile(path.join(root, name, 'src/counter.ts'), 'let count = 0; export const increment = () => ++count;');
    }
    const cache = await tsCacheDirectory(path.join(root, "one"));
    const first = await tsTarget.build(path.join(root, 'one'), scenario) as BuiltApp;
    expect(first.kind).toBe('app');
    expect(await (await first.fetch(new Request('http://test/'))).text()).toBe('1');
    expect(await (await first.fetch(new Request('http://test/'))).text()).toBe('2');
    expect(await tsCacheDirectory(path.join(root, "two"))).toBe(cache);
    const result = path.join(cache, "result.json");
    const builtAt = (await stat(result)).mtimeMs;
    const engine = globalThis as typeof globalThis & { SUSPENSE_ROOT?: { counter: number; requests: Map<unknown, unknown> } };
    engine.SUSPENSE_ROOT = { counter: 9876, requests: new Map([['stale', {}]]) };
    const second = await tsTarget.build(path.join(root, 'two'), scenario) as BuiltApp;
    expect(await (await second.fetch(new Request('http://test/'))).text()).toBe('1');
    expect((await stat(result)).mtimeMs).toBe(builtAt);
    expect(engine.SUSPENSE_ROOT?.counter).toBe(1);
    expect(engine.SUSPENSE_ROOT?.requests.size).toBe(0);
    // Bundled module state resets even on repeated builds of the same source.
    process.env.CONFORMANCE_REBUILD = '1';
    const rebuilt = await tsTarget.build(path.join(root, 'one'), scenario) as BuiltApp;
    expect(await (await rebuilt.fetch(new Request('http://test/'))).text()).toBe('1');
    expect((await stat(result)).mtimeMs).toBeGreaterThan(builtAt);
    const output = await readFile(path.join(cache, 'dist/app.mjs'), 'utf8');
    expect(output.match(/^(?:import|export) .+\bfrom ["'](?:hono|recooler|easy-jsx-html-engine|\.)/gm)).toBeNull();
    expect((await readdir(path.join(cache, "dist"))).sort()).toEqual(["app.mjs", "app.mjs.map"]);
    expect(output).not.toContain('jsxDEV(');
    expect(output).not.toMatch(/fileName:\s*["']\//);
    // Moving both references to changed sources evicts their shared old bytes.
    delete process.env.CONFORMANCE_REBUILD;
    for (const name of ['one', 'two']) {
      await fixture(path.join(root, name), `export default () => <p>production JSX</p>;`);
      const changed = await tsTarget.build(path.join(root, name), scenario) as BuiltApp;
      expect(changed.kind).toBe('app');
      expect(await (await changed.fetch(new Request('http://test/'))).text()).toContain('production JSX');
      if (name === 'one') expect((await stat(result)).mtimeMs).toBeGreaterThan(builtAt);
    }
    await expect(stat(cache)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    if (previous === undefined) delete process.env.CONFORMANCE_REBUILD;
    else process.env.CONFORMANCE_REBUILD = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('request feature tags preserve ordinary routing checks in action scenarios', () => {
  expect(tsRequestSkipReason(scenario.requests![0]!)).toBeUndefined();
  expect(tsRequestSkipReason({ ...scenario.requests![0]!, requires: ['htmx'] })).toBeUndefined();
  expect(tsRequestSkipReason({ ...scenario.requests![0]!, requires: ['client'] })).toBeUndefined();
});
