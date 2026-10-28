import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createContextApp } from './context-app.mjs';
import { Hono as Hono4 } from 'hono';
import { Hono as Hono5 } from 'hono5';
import * as storage4 from 'hono/context-storage';
import * as storage5 from 'hono5/context-storage';
import { routePath as path4 } from 'hono/route';
import { routePath as path5 } from 'hono5/route';

import { checkContext } from './context-assert.mjs';

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
