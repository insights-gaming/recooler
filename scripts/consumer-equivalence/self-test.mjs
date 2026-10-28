import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { register } from 'node:module';
import { runInNewContext } from 'node:vm';
import { deterministicEnvironment, dispatchWorker } from './runtime.mjs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { captureTraces, generateRequests, traceCounts, comparisonRecord, compareTraces, responseRecord, normalizeHtml, dispatchCase } from './traces.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--adapter')) throw new Error('Usage: self-test.mjs [--adapter MODULE.mjs]');
const adapter = await import(args.length ? pathToFileURL(resolve(args[1])) : './adapters/farm-0.0.27.mjs');
register('../../fixtures/consumer-shape/node-loader.mjs', import.meta.url);
const scratch = await mkdtemp('/private/tmp/recooler-equivalence-self-test-');
await writeFile(join(scratch, 'package.json'), '{"type":"module"}\n');
const command = async (program, args, cwd, log) => {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8' });
  await writeFile(join(scratch, log), result.stdout + result.stderr);
  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
  return result.stdout.trim();
};
for (const name of ['router', 'admin']) {
  const packageRoot = join(repo, 'fixtures/consumer-shape', name), packageOut = join(scratch, name);
  await mkdir(packageOut);
  const optionsFile = join(packageOut, 'options.json');
  const spec = { fixture: true };
  await writeFile(optionsFile, JSON.stringify(spec));
  await adapter.prepare({ packageRoot, packageOut, optionsFile, command, name });
  const app = await adapter.load({ packageRoot, packageOut, spec, mode: 'probe' });
  const baseline = await adapter.load({ packageRoot, packageOut, spec, mode: 'baseline' });
  try {
    const { catalog } = app;
    const requests = generateRequests(catalog, { clientVariants: [{ name: 'denied', headers: {} }] })
      .map(request => request.variant === 'denied' ? request : { ...request, headers: { ...request.headers, 'x-auth': 'yes' } });
    const traces = await captureTraces(app, requests, baseline);
    // Same shared wrapper and full response contract for fixture instrumentation parity.
    for (const request of requests) {
      const response = await dispatchCase(app, request), plain = await dispatchCase(baseline, request);
      assert.deepEqual(responseRecord(response), responseRecord(plain), `${name}: instrumentation response parity ${request.path}`);
    }
    if (name === 'admin') {
      assert.equal(new Set(catalog.routes.flatMap(route => route.actions.map(action => action.id))).size, 6);
      const pages = catalog.routes.filter(route => route.page).map(route => route.page);
      assert.equal(pages.length, 5);
      assert.equal(new Set(pages.map(page => page.module.file)).size, 5);
      assert.ok(pages.every(page => page.root.file === 'src/root.tsx' && page.layouts[0].file === 'src/routes/_panel/layout.tsx'));
      assert.ok(pages.some(page => page.heads.length === 2));
      assert.deepEqual(catalog.routes.find(route => route.path === '/_panel/export.csv').actions, []);
      assert.ok(!JSON.stringify(catalog).includes('UnusedAction'));
      for (const kind of ['action', 'root', 'layout', 'head', 'render-page']) {
        assert.ok(traces.some(trace => trace.invoked.some(label => label.kind === kind)), `runtime ${kind} calls`);
        const changed = structuredClone({ traces });
        for (const trace of changed.traces) trace.invoked = trace.invoked.filter(label => label.kind !== kind);
        assert.notDeepEqual(comparisonRecord({ traces }), comparisonRecord(changed), `dropped ${kind}`);
      }
      assert.ok(traces.some(trace => trace.request.variant === 'denied' && trace.status === 401));
      const full = traces.find(trace => trace.request.variant === 'plain' && trace.htmlDigest);
      assert.ok(full.invoked.some(label => label.kind === 'root'));
    } else {
      for (const [path, file] of [['/panel/entry/7', '/[id]/index.ts'], ['/panel/entry/7/detail', '/[id]/detail/index.ts']]) {
        const trace = traces.find(x => x.request.path === path && x.request.method === 'GET');
        assert.ok(trace.invoked.some(label => label.kind === 'handler' && label.file.endsWith(file)), 're-export slot provenance');
      }
      const guard = traces.find(x => x.request.path === '/status' && x.request.method === 'GET');
      assert.equal(guard.status, 404);
      assert.ok(guard.invoked.some(x => x.kind === 'middleware' && x.file.includes('(guarded)')));
      const nonResponse = traces.find(x => x.request.path === '/non-response' && x.request.method === 'GET');
      assert.equal(nonResponse.error, 'NonResponse');
      assert.equal(nonResponse.returnedType, 'object:[object Object]');
      assert.ok(traces.some(x => x.request.path === '/non-response' && x.request.method === 'HEAD' && x.error === 'RangeError' && x.errorMessage));
    }
    assert.ok(traces.some(x => x.request.variant === 'plain'));
    assert.ok(requests.some(x => x.path.includes('%')));
    assert.ok(requests.some(x => x.path.includes('other-value')));
    console.log(`${name}: response parity and dispatch ${JSON.stringify(traceCounts(traces))}`);
  } finally { await app.dispose(); await baseline.dispose(); }
}
// Regression sensitivity of the shared comparison and its narrowly scoped exceptions.
const response = { status: 200, headers: { 'content-type': 'text/html', 'hx-refresh': 'true' }, body: '<html><head><script>root()</script></head><body data-recooler-route="a"><main>layout</main></body></html>' };
for (const body of [response.body.replace('<main>layout</main>', ''), response.body.replace('<script>root()</script>', ''), response.body.replace('<head>', '<head><title>changed</title>')]) {
  assert.notDeepEqual(responseRecord(response), responseRecord({ ...response, body }));
}
assert.notDeepEqual(responseRecord(response), responseRecord({ ...response, headers: { 'content-type': 'text/html' } }));
assert.equal(normalizeHtml('<form hx-post="/?action=a&amp;sig=b">x</form>'), normalizeHtml('<form hx-post="/?action=c&amp;sig=d">x</form>'));
assert.equal(normalizeHtml('<p data-recooler-route-extra="x">kept</p>'), '<p data-recooler-route-extra="x">kept</p>');
assert.equal(normalizeHtml('<meta name="recooler-route" content="x"/><p data-recooler-route="x">kept</p>'), '<p>kept</p>');
const expected = [{ request: { path: '/', method: 'GET' }, status: 200 }], actual = [{ ...expected[0], status: 403 }];
assert.equal(compareTraces(expected, actual).equal, false);
const entry = { case: expected[0].request, fields: ['status'], reason: 'Synthetic intentional difference' };
assert.equal(compareTraces(expected, actual, [entry]).equal, true);
assert.equal(compareTraces(expected, expected, [entry]).equal, false); // stale exception
assert.throws(() => compareTraces(expected, actual, [{ ...entry, reason: '' }]), /reason/);
assert.equal(compareTraces(expected, [{ ...actual[0], headers: { location: '/' } }], [entry]).equal, false);
assert.notDeepEqual(responseRecord({ status: 200, headers: {}, bodyBase64: '/wCA' }), responseRecord({ status: 200, headers: {}, bodyBase64: '/wCB' }));
assert.notDeepEqual(responseRecord({ status: null, headers: {}, error: 'TypeError', errorMessage: 'first' }), responseRecord({ status: null, headers: {}, error: 'TypeError', errorMessage: 'second' }));
const stable = JSON.parse(runInNewContext(`
  const reset = (${deterministicEnvironment.toString()})({ epochMs: 1700000000000, seed: 'synthetic' });
  function sample(key) { reset(key); return [Date.now(), new Date().getTime(), Math.random(), crypto.randomUUID(), [...crypto.getRandomValues(new Uint8Array(4))]]; }
  JSON.stringify([sample('a'), sample('a'), sample('b')]);
`, { crypto: {} }));
assert.deepEqual(stable[0], stable[1]);
assert.notDeepEqual(stable[0], stable[2]);
assert.equal(stable[0][0], 1700000000000);
assert.equal(stable[0][1], 1700000000000);
const streamFailure = await dispatchWorker({ fetch: () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('stream failed')); } }), { headers: { 'hx-refresh': 'true' } }) }, { path: '/' }, {}, {});
assert.equal(streamFailure.status, 200);
assert.equal(streamFailure.headers['hx-refresh'], 'true');
assert.equal(streamFailure.errorMessage, 'stream failed');
const calls = [];
await dispatchCase({ actionUrl: request => { calls.push(request); return '/signed'; }, dispatch: request => { assert.equal(request.path, '/signed'); } }, { path: '/unsigned', action: {} });
assert.equal(calls.length, 1);
console.log('Runtime render calls, response mutations, NonResponse, action URL hook and expected-difference checks passed');
