import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createContextApp } from './context-app.mjs';
import { Hono as Hono4 } from 'hono';
import { Hono as Hono5 } from 'hono5';
import * as storage4 from 'hono/context-storage';
import * as storage5 from 'hono5/context-storage';
import { routePath as path4 } from 'hono/route';
import { routePath as path5 } from 'hono5/route';

export async function checkContext(request) {
  const cases = ['/mount', '/base/nested'];
  const results = await Promise.all(cases.flatMap((prefix, i) => ['a%20b', 'c%2Fd'].map(async (param, j) => {
    const id = `${i}${j}-${param}`;
    const path = `${prefix}/item/${id}/one/two%20three`;
    const response = await request(path);
    assert.equal(response.status, 200);
    assert(response.body);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert(!first.done);
    const release = await request('/release/' + id);
    assert.equal((await release.json()).released, true);
    let body = new TextDecoder().decode(first.value);
    for (;;) { const r = await reader.read(); if (r.done) break; body += new TextDecoder().decode(r.value); }
    const records = [...body.matchAll(/<pre data-record>(.*?)<\/pre>/g)].map(m => JSON.parse(m[1].replaceAll('&quot;', '"')));
    assert.equal(records.length, 2, body);
    const [initial, late] = records;
    assert.equal(late.where, 'after-response');
    assert.equal(initial.matched.routePath, `${prefix}/item/:id/:rest{.+}`);
    assert.equal(late.matched.params.rest, 'one/two three');
    assert.equal(late.id, decodeURIComponent(id));
    const reconstructed = late.matched.routePath.replace(':id', encodeURIComponent(late.matched.params.id))
      .replace(':rest{.+}', late.matched.params.rest.split('/').map(encodeURIComponent).join('/'));
    assert.equal(reconstructed, path);
    assert(body.includes('"where":"toHTML"'));
    return { path, initial, late, reconstructed };

  })));
  return results;
}
if (process.argv[1]?.includes('context-native')) {
  const results = {};
  for (const version of ['hono', 'hono5']) {
    const Hono = version === 'hono' ? Hono4 : Hono5;
    const { contextStorage, getContext } = version === 'hono' ? storage4 : storage5;
    const app = createContextApp(Hono, contextStorage, getContext, version === 'hono' ? path4 : path5);
    results[version] = await checkContext(p => app.request('http://spike.test' + p));
  }
  const runtime = globalThis.Bun ? 'bun' : globalThis.Deno ? 'deno' : 'node';
  console.log(JSON.stringify({ runtime, results }, null, 2));
  writeFileSync(new URL(`../../results/context-${runtime}.json`, import.meta.url), JSON.stringify({ runtime, results }, null, 2) + '\n');
}
