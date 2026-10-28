import assert from 'node:assert/strict';
import { build, createServer } from 'vite';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fixture, config, write } from './fixture.mjs';
import { graphPlugin } from './graph-plugin.mjs';
export function assertGraph(result, verbatim, changed = false) {
  const ids = result.table['/public'];
  for (const id of ['src/route.ts', 'src/root.ts', 'src/layout.ts', 'src/component.ts', 'src/admin.ts', 'src/side.ts', 'src/cycle-a.ts', 'src/cycle-b.ts', 'outside/component.ts', 'node_modules/spike-actions/index.js']) assert(ids.includes(id), 'missing ' + id + ': ' + ids);
  assert(!ids.includes('src/types.ts'));
  assert(!ids.includes('src/dynamic.ts'));
  assert.equal(ids.includes('src/unused.ts'), verbatim);
  assert.equal(ids.includes('src/added.ts'), changed);
  assert.equal(result.actions.includes('src/types.ts@0'), false);
  assert.equal(result.actions.includes('src/dynamic.ts@0'), false);
  for (const id of ids.filter(id => !id.endsWith('barrel.ts'))) assert(result.actions.includes(id + '@0'), id);
}
const results = [];
for (const verbatim of [true, false]) {
  const { root, routes } = fixture('graph-' + verbatim, verbatim);
  const stats = {};
  const make = () => config(root, [graphPlugin({ root, routes, stats })]);
  await build(make());
  const { default: worker } = await import(pathToFileURL(root + '/dist/server/entry.mjs'));
  const built = await (await worker.fetch(new Request('http://spike.test'))).json();
  assertGraph(built, verbatim);
  const server = await createServer(make());
  try {
    await server.listen();
    // Cold graph request, before importing the app, must complete the graph.
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    const table = await (await fetch(origin + '/__spike_graph')).json();
    const env = server.environments.ssr;
    const { default: dev } = await env.runner.import(root + '/src/entry.ts');
    const value = await (await dev.fetch(new Request(origin))).json();
    assert.deepEqual(value.table, table);
    assertGraph(value, verbatim);
    const n = stats.devComputations;
    await fetch(origin + '/__spike_graph');
    assert.equal(stats.devComputations, n);
    write(root, 'src/added.ts', '/* @action */ export const added = 1;');
    const { readFileSync } = await import('node:fs');
    write(root, 'src/route.ts', readFileSync(root + '/src/route.ts', 'utf8') + "\nimport './added';\n");
    await new Promise(r => setTimeout(r, 300));
    const updated = await env.runner.import(root + '/src/entry.ts');
    const changed = await (await updated.default.fetch(new Request(origin))).json();
    assertGraph(changed, verbatim, true);
    results.push({ verbatim, built, dev: value, changed, computations: stats.devComputations });
  } finally { await server.close(); }
}
writeFileSync(new URL('results/graph.json', import.meta.url), JSON.stringify(results, null, 2) + '\n');
console.log('Graph build/dev PASS: static/re-export/side-effect/barrel/cycle/outside/node_modules/type-only/dynamic/verbatim/cache/invalidation');
