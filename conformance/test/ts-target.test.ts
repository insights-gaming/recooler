import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { tsCacheDirectory, tsSkipReason, tsTarget, tsUnavailable } from '../src/targets/ts.js';
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
    const second = await tsTarget.build(path.join(root, 'two'), scenario) as BuiltApp;
    expect(await (await second.fetch(new Request('http://test/'))).text()).toBe('1');
    expect((await stat(result)).mtimeMs).toBe(builtAt);
    // Bundled module state resets even on repeated builds of the same source.
    process.env.CONFORMANCE_REBUILD = '1';
    const rebuilt = await tsTarget.build(path.join(root, 'one'), scenario) as BuiltApp;
    expect(await (await rebuilt.fetch(new Request('http://test/'))).text()).toBe('1');
    expect((await stat(result)).mtimeMs).toBeGreaterThan(builtAt);
    const output = await readFile(path.join(cache, 'dist/app.mjs'), 'utf8');
    expect(output.match(/^(?:import|export) .+\bfrom ["'](?:hono|recooler|easy-jsx-html-engine|\.)/gm)).toBeNull();
    expect((await readdir(path.join(cache, "dist"))).sort()).toEqual(["app.mjs", "app.mjs.map"]);
  } finally {
    if (previous === undefined) delete process.env.CONFORMANCE_REBUILD;
    else process.env.CONFORMANCE_REBUILD = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('feature skips are explicit and do not exclude ordinary pages or middleware', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'recooler-ts-feature-'));
  try {
    await fixture(dir, 'export default () => <p>page</p>;');
    expect(await tsSkipReason(dir, scenario)).toBeUndefined();
    expect(await tsSkipReason(dir, { ...scenario, requests: [{ name: 'action', path: '/?action=unknown', expect: { status: 404 } }] })).toContain('not implemented');
    for (const attribute of ['hx-post', 'data-hx-get', 'hx-on:click', 'data-hx-on-click']) {
      await fixture(dir, `export default () => <form ${attribute}={() => null}/>;`);
      expect(await tsSkipReason(dir, scenario)).toContain('not implemented');
    }
    await fixture(dir, `export default () => <form {...{"hx-post": () => null}}/>;`);
    expect(await tsSkipReason(dir, scenario)).toContain('not implemented');
    await fixture(dir, 'export const onLoad = () => {};');
    expect(await tsSkipReason(dir, scenario)).toContain('not implemented');
    expect(await tsSkipReason(dir, { ...scenario, requests: [{ name: 'client', path: '/', expect: { status: 200, clientIncludes: [randomUUID()] } }] })).toContain('client chunks');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
