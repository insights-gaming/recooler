import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { register } from 'node:module';
import { runInNewContext } from 'node:vm';
import { deterministicEnvironment, dispatchWorker } from './runtime.mjs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { captureTraces, generateRequests, traceCounts, comparisonRecord, compareTraces, responseRecord, normalizeHtml, dispatchCase, pinValue, canonicalCatalog } from './traces.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--adapter')) throw new Error('Usage: self-test.mjs [--adapter MODULE.mjs]');
const adapterName = args[1] || 'farm-0.0.27';
const adapter = await import(['farm-0.0.27', 'recooler-0.1'].includes(adapterName) ? `./adapters/${adapterName}.mjs` : pathToFileURL(resolve(adapterName)));
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
      assert.deepEqual(responseRecord(response, app.canonicalActionId), responseRecord(plain, baseline.canonicalActionId), `${name}: instrumentation response parity ${request.path}`);
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
      const rendered = await app.dispatch({path:'/_panel', method:'GET', headers:{'x-auth':'yes'}});
      const actionMatch = rendered.body.match(/<form id="save"[^>]*hx-post="([^"]+)"/);
      assert.ok(actionMatch, 'rendered captured-scope form');
      const actionPath = actionMatch[1].replaceAll('&amp;', '&');
      const capturedScope = JSON.parse(new URL(actionPath, 'http://localhost').searchParams.get('scope'));
      assert.deepEqual(capturedScope, {captured:{prefix:'captured',nested:{value:7}}});
      const saved = await app.dispatch({path:actionPath, method:'POST', headers:{'x-auth':'yes','hx-request':'true',origin:'http://localhost','sec-fetch-site':'same-origin','content-type':'application/x-www-form-urlencoded'}, body:'value=roundtrip'});
      assert.equal(saved.status, 200);
      assert.match(saved.body, /saved:captured:7:roundtrip:roundtrip/);
      const scopedRequest = {path:'/_panel',method:'POST',headers:{'x-auth':'yes','hx-request':'true',origin:'http://localhost','sec-fetch-site':'same-origin','content-type':'application/x-www-form-urlencoded'},body:'value=adapter',action:{routeId:'/_panel',pathname:'/_panel',method:'POST',actionId:app.canonicalActionId?.(new URL(actionPath,'http://localhost').searchParams.get('action')) ?? new URL(actionPath,'http://localhost').searchParams.get('action'),scope:capturedScope}};
      const adapterRoundTrip = await dispatchCase(app,scopedRequest);
      assert.equal(adapterRoundTrip.status,200);
      assert.match(adapterRoundTrip.body,/saved:captured:7:adapter:adapter/);

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
      if (adapter.fixtureOutcomes?.undefinedHandlerStatus) {
        assert.equal(nonResponse.status, adapter.fixtureOutcomes.undefinedHandlerStatus);
        assert.equal(nonResponse.error, undefined);
        assert.ok(traces.some(x => x.request.path === '/non-response' && x.request.method === 'HEAD' && x.status === adapter.fixtureOutcomes.undefinedHandlerStatus));
      } else {
        assert.equal(nonResponse.error, 'NonResponse');
        assert.equal(nonResponse.returnedType, 'object:[object Object]');
        assert.ok(traces.some(x => x.request.path === '/non-response' && x.request.method === 'HEAD' && x.error === 'RangeError' && x.errorMessage));
      }
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
assert.notEqual(normalizeHtml('<form hx-post="/?action=a&amp;sig=b">x</form>'), normalizeHtml('<form hx-post="/?action=c&amp;sig=d">x</form>'));
assert.equal(normalizeHtml('<form hx-post="/?action=legacy&amp;sig=b">x</form>', id => id === 'legacy' ? 'canonical' : id), normalizeHtml('<form hx-post="/?action=canonical&amp;sig=d">x</form>'));
assert.equal(normalizeHtml('<p data-recooler-route-extra="x">kept</p>'), '<p data-recooler-route-extra="x">kept</p>');
assert.equal(normalizeHtml('<meta name="recooler-route" content="x"/><p data-recooler-route="x">kept</p>'), '<p>kept</p>');
const expected = [{ request: { path: '/', method: 'GET' }, status: 200 }], actual = [{ ...expected[0], status: 403 }];
assert.equal(compareTraces(expected, actual).equal, false);
const entry = { case: expected[0].request, fields: ['status'], values: { status: { before: pinValue(200), after: pinValue(403) } }, reason: 'Synthetic intentional difference' };
assert.equal(compareTraces(expected, actual, [entry]).equal, true);
assert.equal(compareTraces(expected, [{...actual[0], status: 404}], [entry]).equal, false);
assert.throws(() => compareTraces(expected, actual, [{...entry, values: undefined}]), /value-pinned/);
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

const { resolveActionUrl, canonicalActionId } = await import('./adapters/recooler-0.1.mjs');
const actionRequest = {action: {routeId: '/form', actionId: 'known', method: 'POST'}};
assert.throws(() => resolveActionUrl([], actionRequest, 'synthetic'), /found 0/);
assert.throws(() => resolveActionUrl(['a', 'b'].map(routeId => ({path:'/form', routeId, actions:[{id:'known',runtimeId:'runtime',method:'POST'}]})), actionRequest, 'synthetic'), /found 2/);
assert.deepEqual(canonicalCatalog({routes:[], middlewarePrefixes:['/*']}, 'admin'), canonicalCatalog({routes:[], middlewarePrefixes:['*']}, 'admin'));

assert.equal(compareTraces(expected,actual,[{...entry,fields:['status','headers'],values:{...entry.values,headers:{before:pinValue(undefined),after:pinValue({location:'/'})}}}]).equal,false,'partially stale allowance');
assert.deepEqual(canonicalCatalog({routes:[{path:'/:rest{.+}',methods:['GET','ALL'],actions:[],page:null}],middlewarePrefixes:[]}),canonicalCatalog({routes:[{path:'/:rest{.+}',methods:['ALL'],actions:[],page:null}],middlewarePrefixes:[]}));
assert.notDeepEqual(canonicalCatalog({routes:[],middlewarePrefixes:['/nested/*']}),canonicalCatalog({routes:[],middlewarePrefixes:['/nested*']}));

const identities = [{actions:[{id:'app/routes/form.tsx:0',runtimeId:'routes/form.tsx:0'}]}];
assert.equal(canonicalActionId(identities, 'routes/form.tsx:0'), 'app/routes/form.tsx:0');
assert.equal(canonicalActionId(identities, 'app/routes/form.tsx:0'), 'app/routes/form.tsx:0');
assert.throws(() => canonicalActionId(identities, 'missing'), /Unknown canonical action/);
assert.throws(() => canonicalActionId([...identities, {actions:[{id:'other',runtimeId:'routes/form.tsx:0'}]}], 'routes/form.tsx:0'), /Ambiguous canonical action/);
const { sourceFile } = await import('./source-label.mjs');
assert.equal(sourceFile('routes/form.tsx', 'app'), 'app/routes/form.tsx');
assert.equal(sourceFile('root.tsx', '.'), 'root.tsx');
assert.equal(sourceFile('../shared/action.ts:0', 'app'), 'shared/action.ts:0');
const { EventEmitter } = await import('node:events');
const { observeBrowserFailures, assertBrowserSuccess } = await import('./browser-smoke.mjs');
const smokePage = new EventEmitter();
const smoke = observeBrowserFailures(smokePage, 'http://localhost', '/assets/');
const respond = (path, status) => smokePage.emit('response', {url:()=>'http://localhost'+path,status:()=>status});
respond('/assets/client.js', 200);
respond('/form?action=known', 204);
assertBrowserSuccess(smoke, '/assets/');
smokePage.emit('console', {type:()=>'error',text:()=>'Refused script: MIME or CSP'});
assert.throws(() => assertBrowserSuccess(smoke), /consoleErrors/);
smoke.consoleErrors.length = 0;
respond('/form?action=known', 403);
assert.throws(() => assertBrowserSuccess(smoke), /failedActions/);
console.log('Source roots, strict canonical IDs and browser failure checks passed');

assert.equal(normalizeHtml('<a href="/?action=__unknown__">probe</a>', id => { throw new Error(id); }), '<a href="/?action=__unknown__">probe</a>');
assert.throws(() => normalizeHtml('<a href="/?action=missing">app</a>', id => canonicalActionId([], id)), /Unknown canonical action/);
