import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBuilder } from 'vite';
import { chromium } from 'playwright';
import { recooler } from '../../dist/vite/index.js';
const major = process.argv[2] ?? '2';
const pkg = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(path.join(pkg, '.cache'), { recursive: true });
const root = await mkdtemp(path.join(pkg, '.cache/client-chromium-'));
const write = async (name, code) => { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), code); };
const inc = `const inc = k => { globalThis[k] = (globalThis[k] ?? 0) + 1; };`;
let browser, server, app, generation = 0;
let requests = [], assets = [], block, release = () => {}, fail = false, failures = 0, badVersion = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const htmx = await readFile(path.join(pkg, 'node_modules', major === '1' ? 'htmx-1' : 'htmx.org', 'dist/htmx.js'));
const build = async legacy => {
  if (legacy) await write('src/root.tsx', `import { dangerouslyPreventEscaping } from 'easy-jsx-html-engine';
    export default (Content, clientScript) => props => <html><head><script src="/htmx.js"/></head><body hx-boost="true"
      hx-on--confirm={event => { inc('rootConfirms'); }}
      hx-on--after-settle={() => inc('bodySettles')} hx-on--after-request={() => inc('bodyRequests')}
      hx-on--after-swap={() => inc('bodySwaps')} hx-on--load={() => inc('bodyLoads')}>
      <Content {...props}/><script>{dangerouslyPreventEscaping(clientScript ?? '')}</script></body></html>;
    ${inc}`);
  else await rm(path.join(root, 'src/root.tsx'), { force: true });
  const builder = await createBuilder({ root, configFile: false, logLevel: 'silent', plugins: recooler({ htmx: { legacyClientScript: legacy } }),
    environments: { client: { build: { minify: false } } }, ssr: { noExternal: true },
    build: { ssr: 'src/entry.ts', outDir: 'server', rolldownOptions: { output: { entryFileNames: 'app.mjs' } } } });
  await builder.buildApp();
  app = (await import(pathToFileURL(path.join(root, 'server/app.mjs')).href + '?g=' + generation++)).default;
};
try {
  await write('package.json', '{"name":"chromium-regressions","type":"module"}');
  await mkdir(path.join(root, 'node_modules')); await mkdir(path.join(root, 'node_modules/@insights-gaming'), { recursive: true }); await symlink(pkg, path.join(root, 'node_modules/@insights-gaming/recooler'), 'dir');
  await write('src/entry.ts', `export { default } from 'virtual:recooler/app';`);
  await write('src/routes/index.tsx', `${inc}
    export const head = { scripts: [{ src: '/htmx.js' }] };
    export const onLoad = () => { inc('loadsA'); (globalThis.order ??= []).push('onLoad'); };
    export default () => <>
      <a id="tob" href="/b" hx-boost="true">B</a><a id="toc" href="/c" hx-boost="true">C</a>
      <button id="hxpost" hx-post="/m/post" hx-swap="none" hx-on:click={() => inc('postClicks')}>post</button>
      <form action="/m/form" method="post" hx-boost="true" hx-swap="none" hx-on:submit={() => inc('formSubmits')}><button id="submit">go</button></form>
      <form action="/m/prevent" method="post" hx-boost="true" hx-swap="none" hx-on:submit={e => { inc('preventSubmits'); e.preventDefault(); }}><button id="prevent">prevent</button></form>
      <a id="link" href="/m/link" hx-boost="true" hx-swap="none" hx-on:click={() => inc('links')}>link</a>
      <button id="after" hx-post="/m/after" hx-swap="none" hx-on--after-request={() => inc('afterCalls')}>after</button>
      <button id="before" hx-post="/m/before" hx-on--before-swap={() => inc('beforeCalls')}>before</button>
      <input id="check" type="checkbox" hx-on:click={() => inc('checks')}/>
      <input id="key" hx-on:keydown={() => inc('keys')} hx-on:paste={() => inc('pastes')} hx-on:drop={() => inc('drops')}/>
      <button id="open" hx-get="/edit" hx-target="#modal">open</button><div id="modal"/>
      <button id="location" hx-get="/relocate">location</button>
      <button id="push" hx-get="/c" hx-push-url="true" hx-target="body">push</button>
    </>;`);
  for (const route of ['b', 'c']) await write(`src/routes/${route}/index.tsx`, `${inc}
    export const onLoad = () => { inc('loads${route.toUpperCase()}'); (globalThis.routeLog ??= []).push('${route}:' + document.querySelector('#label')?.textContent); };
    export default () => <><p id="label">${route}</p><a id="toc" href="/c" hx-boost="true">C</a><a id="toa" href="/" hx-boost="true">A</a>
    <input id="late-check" type="checkbox" hx-on:click={e => e.preventDefault()}/>
    <input id="late-key" hx-on:keydown={e => e.preventDefault()} hx-on:paste={e => e.preventDefault()} hx-on:drop={e => e.preventDefault()}/>
    <button id="late-post" hx-post="/m/late-post" hx-swap="none" hx-on:click={() => inc('latePosts')}>post</button>
    <form hx-boost="true" action="/m/late-form" method="post" hx-swap="none" hx-on:submit={e => e.preventDefault()}><button id="late-submit">submit</button></form>
    <a id="late-link" hx-boost="true" href="/m/late-link" hx-swap="none" hx-on:click={e => e.preventDefault()}>link</a>
    <button id="late-after" hx-post="/m/late-after" hx-swap="none" hx-on--after-request={() => inc('lateAfters')}>after</button>
    <button id="late-before" hx-post="/m/late-before" hx-swap="none" hx-on--before-swap={() => inc('lateBefores')}>before</button>
    <button id="handler" hx-on:click={() => inc('destinationClicks')}>handler</button>
    <button id="gate" hx-post="/m/gate" hx-swap="none" hx-on--confirm={event => { event.preventDefault(); inc('gateConfirms'); if (globalThis.accept) event.detail.issueRequest(); }}>gate</button>
    <button id="config" hx-post="/m/config" hx-swap="none" hx-on--config-request={() => inc('configs')}>config</button>
    <button id="request" hx-post="/m/request" hx-swap="none" hx-on--before-request={() => inc('befores')}>before</button>
    </>;`);
  await write('src/routes/edit/index.tsx', `${inc} export const onLoad = () => inc('editLoads');
    export default () => <button id="save" hx-on:click={() => inc('saves')}>save</button>;`);
  await write('src/routes/stream/index.tsx', `import { Suspense } from '@insights-gaming/recooler/jsx'; ${inc}
    export const head = { scripts: [{ src: '/htmx.js' }] };
    export const onLoad = () => { inc('streamLoads'); (globalThis.order ??= []).push('onLoad'); };
    const Child = async () => { await new Promise(r => setTimeout(r, 200)); return <button id="streamed" hx-on:click={() => inc('streamClicks')}>streamed</button>; };
    export default props => <Suspense rid={props.rid} fallback={<p id="fallback">waiting</p>}><Child/></Suspense>;`);
  for (const route of ['a', 'b']) await write(`src/routes/cleanup-${route}/index.tsx`, `${inc}
    export const head = { scripts: [{ src: '/htmx.js' }] };
    export const onLoad = ({ signal }) => {
      document.querySelectorAll('.widget').forEach(node => node.remove());
      const widget = document.createElement('div'); widget.className = 'widget'; document.body.append(widget);
      signal.addEventListener('abort', () => widget.remove(), { once: true });
      inc('cleanupLoads${route.toUpperCase()}'); (globalThis.cleanupLog ??= []).push('${route} load');
      const drop = () => inc('cleanupDrops${route.toUpperCase()}'); window.addEventListener('cleanup-drop', drop, { signal });
      signal.addEventListener('abort', () => {
        globalThis.cleanupLog.push('${route} abort');
      });
    };
    export default () => <><a id="cleanup-tob" href="/cleanup-b" hx-boost="true">B</a>
      <button id="cleanup-open" hx-get="/cleanup-fragment" hx-target="#cleanup-modal">open</button>
      <button id="cleanup-push" hx-get="/cleanup-fragment" hx-push-url="true" hx-target="#cleanup-modal">push</button>
      <button id="cleanup-replace" hx-get="/cleanup-clear" hx-replace-url="/cleanup-replaced" hx-target="#cleanup-modal">replace</button>
      <button id="cleanup-async" hx-get="/cleanup-async" hx-target="#cleanup-modal">async</button>
      <button id="cleanup-clear" hx-get="/cleanup-clear" hx-target="#cleanup-modal">clear</button><div id="cleanup-modal"/></>;`);
  await write('src/routes/cleanup-fragment/index.tsx', `${inc}
    export const onLoad = ({ signal }) => { inc('cleanupFragmentLoads'); globalThis.cleanupLog.push('fragment load');
      signal.addEventListener('abort', () => { inc('cleanupFragments'); globalThis.cleanupLog.push('fragment abort');
        if (globalThis.throwCleanup) { globalThis.throwCleanup = false; throw new Error('abort failed'); }
      });
      signal.addEventListener('abort', () => inc('fragmentAbortFollowers')); };
    export default () => <p id="cleanup-fragment">fragment</p>;`);
  await write('src/routes/cleanup-async/index.tsx', `${inc}
    export const onLoad = async ({ signal }) => {
      inc('cleanupAsyncLoads');
      window.addEventListener('async-drop', () => inc('asyncDrops'), { signal });
      signal.addEventListener('abort', () => { inc('cleanupAsyncs'); globalThis.cleanupLog.push('async abort'); });
      await new Promise(resolve => { globalThis.finishCleanup = resolve; });
      inc('asyncResolved');
      if (signal.aborted) return;
      window.addEventListener('async-drop', () => inc('asyncLateDrops'), { signal });
    };
    export default () => <p id="cleanup-pending">pending</p>;`);
  await write('src/routes/cleanup-fetch/index.tsx', `
    export const head = { scripts: [{ src: '/htmx.js' }] };
    export const onLoad = async ({ signal }) => {
      globalThis.fetchStarted = true;
      try { await fetch('/cleanup-pending-fetch', { signal }); }
      catch (error) {
        globalThis.fetchAbort = { sameReason: error === signal.reason, domException: error instanceof DOMException, name: error.name };
        throw error;
      }
    };
    export default () => <a id="fetch-away" href="/b" hx-boost="true">away</a>;`);
  await write('src/routes/cleanup-throw/index.tsx', `
    export const head = { scripts: [{ src: '/htmx.js' }] };
    export const onLoad = async ({ signal }) => {
      await new Promise(resolve => { globalThis.finishThrow = resolve; });
      signal.throwIfAborted();
      globalThis.lateResource = true;
    };
    export default () => <a id="throw-away" href="/b" hx-boost="true">away</a>;`);
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/htmx.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(htmx); }
      if (url.pathname.startsWith('/assets/')) {
        assets.push(req.url);
        if (block) await block;
        if (url.pathname.includes('recooler-slice') && (fail || failures-- > 0)) { res.statusCode = 503; return res.end('temporary failure'); }
        res.setHeader('Content-Type', 'text/javascript'); return res.end(await readFile(path.join(root, 'dist/client', url.pathname)));
      }
      requests.push(req.method + ' ' + url.pathname);
      if (url.pathname === '/relocate') { res.setHeader('HX-Location', '/c'); return res.end(); }
      if (url.pathname === '/cleanup-pending-fetch') { res.on('close', () => res.end()); return; }
      if (url.pathname === '/cleanup-clear') return res.end('<p id="cleanup-empty">empty</p>');
      if (url.pathname.startsWith('/m/')) { res.statusCode = url.pathname === '/m/before' ? 200 : 204; return res.end(url.pathname === '/m/before' ? '<p>done</p>' : ''); }
      const response = await app.fetch(new Request(new URL(req.url, origin), { headers: req.headers }), { RECOOLER_SECRET: 'browser-test' });
      res.statusCode = response.status; res.setHeader('Content-Type', 'text/html');
      // Forward the actual Response stream, preserving Suspense chunk boundaries.
      if (badVersion) return res.end((await response.text()).replaceAll(/data-recooler-version="[^"]+"/g, 'data-recooler-version="stale-html"'));
      for await (const chunk of response.body) res.write(chunk);
      res.end();
    } catch (error) { res.statusCode = 500; res.end(String(error.stack)); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const open = async (pathname = '/') => {
    const page = await browser.newPage();
    page.errors = []; page.warnings = [];
    page.on('pageerror', e => page.errors.push(e.message));
    page.on('console', m => { if (m.type() === 'warning') page.warnings.push(m.text()); });
    await page.addInitScript(() => {
      globalThis.unhandled = [];
      addEventListener('unhandledrejection', e => globalThis.unhandled.push(String(e.reason)));
      document.addEventListener('DOMContentLoaded', () => {
        (globalThis.order ??= []).push('DCL');
        globalThis.atDCL = { handlers: Object.keys(globalThis.$handlers ?? {}).length, loads: globalThis.loadsA ?? globalThis.streamLoads };
      });
      document.addEventListener('htmx:beforeProcessNode', e => {
        if (location.pathname === '/stream' && e.detail.elt.tagName === 'BODY') (globalThis.streamProcessing ??= []).push({
          handlers: Object.keys(globalThis.$handlers ?? {}).length, loads: globalThis.streamLoads,
        });
        if (e.detail.elt.id === 'hxpost' || e.detail.elt.id === 'streamed') (globalThis.processed ??= []).push({ id: e.detail.elt.id, handlers: Object.keys(globalThis.$handlers ?? {}).length, loads: globalThis.loadsA ?? globalThis.streamLoads });
      });
    });
    await page.goto(origin + pathname);
    await page.evaluate(() => globalThis.__recooler_ready);
    return page;
  };
  const count = path => requests.filter(r => r.endsWith(' ' + path)).length;
  for (const legacy of [true, false]) {
    await build(legacy);
    assets = []; requests = [];
    const page = await open();
    assert.deepEqual(await page.evaluate(() => [...globalThis.order].sort()), ['DCL', 'onLoad']);
    const dcl = await page.evaluate(() => globalThis.atDCL); assert(dcl.handlers > 0); assert.equal(await page.evaluate(() => globalThis.loadsA), 1);
    assert((await page.evaluate(() => globalThis.processed)).every(x => x.handlers > 0));
    assert(!assets.some(x => x.includes('rc_retry=')));
    assert.equal(await page.evaluate(() => globalThis.$rq), undefined);
    // replay.mjs: one request per htmx owner, plus native checkbox/key/paste/drop defaults.
    for (const [id, endpoint] of [['hxpost', '/m/post'], ['submit', '/m/form'], ['link', '/m/link'], ['after', '/m/after'], ['before', '/m/before']]) {
      await page.click('#' + id); await page.waitForFunction(() => globalThis.__recooler_ready); await sleep(80); assert.equal(count(endpoint), 1, endpoint);
    }
    // htmx's own boosted submit listener runs before hx-on and ignores defaultPrevented.
    // The client must not add a second request when the handler prevents the submit.
    await page.click('#prevent'); await sleep(80); assert.equal(count('/m/prevent'), 1);
    await page.click('#check'); assert.equal(await page.isChecked('#check'), true);
    await page.locator('#key').press('x'); assert.equal(await page.inputValue('#key'), 'x');
    assert.deepEqual(await page.evaluate(() => ['paste', 'drop'].map(type => document.querySelector('#key').dispatchEvent(new Event(type, { bubbles: true, cancelable: true })))), [true, true]);
    // init.mjs: fragment adds a second marker and runs only its own onLoad once.
    block = new Promise(r => { release = () => { block = undefined; r(); }; });
    await page.click('#open'); await page.waitForSelector('#save'); await sleep(80);
    await page.click('#hxpost'); await sleep(80);
    assert.equal(await page.evaluate(() => globalThis.postClicks), 2, 'ready page handlers do not wait for an unrelated fragment');
    assert.equal(count('/m/post'), 2);
    release(); await page.waitForFunction(() => globalThis.editLoads === 1); await page.click('#save');
    assert.equal(await page.evaluate(() => globalThis.saves), 1);
    await page.evaluate(() => globalThis.__recooler_client.init()); assert.equal(await page.evaluate(() => globalThis.editLoads), 1);
    assert.equal(await page.locator('[data-recooler-marker]').count(), 2);
    const confirmsBeforeBoost = await page.evaluate(() => globalThis.rootConfirms ?? 0);
    // Settle-loop: body lifecycle listeners and a delayed destination cause one GET, no replay.
    block = new Promise(r => { release = () => { block = undefined; r(); }; });
    await page.click('#tob'); await page.waitForSelector('#handler'); await sleep(80);
    await page.evaluate(() => { document.querySelector('#config').click(); document.querySelector('#request').click(); });
    await page.click('#late-check'); assert.equal(await page.isChecked('#late-check'), true);
    await page.locator('#late-key').press('x'); assert.equal(await page.inputValue('#late-key'), 'x');
    assert.deepEqual(await page.evaluate(() => ['paste', 'drop'].map(type => document.querySelector('#late-key').dispatchEvent(new Event(type, { bubbles: true, cancelable: true })))), [true, true]);
    for (const id of ['late-post', 'late-submit', 'late-link', 'late-after', 'late-before']) await page.click('#' + id);
    await sleep(100); assert.equal(count('/b'), 1);
    release(); await page.waitForFunction(() => globalThis.loadsB === 1); await sleep(300);
    assert.equal(count('/b'), 1); assert.equal(await page.evaluate(() => globalThis.loadsB), 1);
    assert.equal(count('/m/config'), 1, JSON.stringify({ requests, errors: page.errors, state: await page.evaluate(() => ({ configs: globalThis.configs, rootConfirms: globalThis.rootConfirms, befores: globalThis.befores, html: document.body.innerHTML })) })); assert.equal(count('/m/request'), 1);
    assert.equal(await page.evaluate(() => globalThis.configs ?? 0), 0);
    assert.equal(await page.evaluate(() => globalThis.befores ?? 0), 0);
    if (legacy) {
      assert.equal(await page.evaluate(() => globalThis.bodySwaps), 3);
      assert.equal(await page.evaluate(() => globalThis.bodySettles), 3);
      assert.equal(await page.evaluate(() => globalThis.rootConfirms), confirmsBeforeBoost + 8, 'boost and all seven destination request confirms use the loaded root handler');
    }
    for (const endpoint of ['late-post', 'late-form', 'late-link', 'late-after', 'late-before']) assert.equal(count('/m/' + endpoint), 1);
    await page.click('#handler'); assert.equal(await page.evaluate(() => globalThis.destinationClicks), 1);
    // hist / hist-modern: A -> B -> C -> Back must initialize B on B's DOM.
    await page.click('#toc'); await page.waitForFunction(() => globalThis.loadsC === 1); await sleep(60);
    await page.goBack(); await page.waitForFunction(() => globalThis.loadsB === 2);
    assert.equal(await page.locator('#label').textContent(), 'b');
    assert.deepEqual(await page.evaluate(() => globalThis.routeLog), ['b:b', 'c:c', 'b:b']);
    assert.equal(count('/b'), 1, 'history cache does not refetch B');
    assert.deepEqual(page.errors, []); assert.deepEqual(await page.evaluate(() => globalThis.unhandled), []);
    assert.deepEqual(page.warnings, []);
    await page.close();
    // Teardown: boosts and cached Back retire old listeners before destination onLoad.
    const cleanup = await open('/cleanup-a');
    assert.equal(await cleanup.locator('.widget').count(), 1);
    await cleanup.click('#cleanup-tob'); await cleanup.waitForFunction(() => globalThis.cleanupLoadsB === 1);
    assert.deepEqual(await cleanup.evaluate(() => globalThis.cleanupLog), ['a load', 'a abort', 'b load']);
    await cleanup.goBack(); await cleanup.waitForFunction(() => globalThis.cleanupLoadsA === 2); await sleep(80);
    assert.deepEqual(await cleanup.evaluate(() => globalThis.cleanupLog), ['a load', 'a abort', 'b load', 'b abort', 'a load']);
    assert.equal(await cleanup.locator('.widget').count(), 1, 'Back removes restored widget copies');
    await cleanup.evaluate(() => window.dispatchEvent(new Event('cleanup-drop')));
    assert.deepEqual(await cleanup.evaluate(() => [globalThis.cleanupDropsA, globalThis.cleanupDropsB ?? 0]), [1, 0]);
    await cleanup.click('#cleanup-open'); await cleanup.waitForFunction(() => globalThis.cleanupFragmentLoads === 1);
    await cleanup.click('#cleanup-clear'); await cleanup.waitForFunction(() => globalThis.cleanupFragments === 1);
    assert.equal(await cleanup.evaluate(() => globalThis.cleanupLoadsA), 2, 'fragment removal retains the surrounding page');
    // Partial push-url keeps the page live until Back restores the full snapshot.
    await cleanup.click('#cleanup-push'); await cleanup.waitForFunction(() => globalThis.cleanupFragmentLoads === 2);
    assert.equal(new URL(cleanup.url()).pathname, '/cleanup-fragment');
    assert.equal(await cleanup.evaluate(() => globalThis.cleanupLoadsA), 2);
    assert.equal(await cleanup.locator('.widget').count(), 1, 'partial push retains the live widget');
    await cleanup.click('#cleanup-replace');
    await cleanup.waitForFunction(() => location.pathname === '/cleanup-replaced');
    assert.equal(await cleanup.evaluate(() => globalThis.cleanupLoadsA), 2);
    assert.equal(await cleanup.locator('.widget').count(), 1, 'partial replace retains the live widget');
    await cleanup.evaluate(() => window.dispatchEvent(new Event('cleanup-drop')));
    assert.equal(await cleanup.evaluate(() => globalThis.cleanupDropsA), 2);
    await cleanup.goBack(); await cleanup.waitForFunction(() => globalThis.cleanupLoadsA === 3);
    assert.deepEqual(await cleanup.evaluate(() => globalThis.cleanupLog.slice(-3)), ['fragment abort', 'a abort', 'a load']);
    assert.equal(count('/cleanup-a'), 1, 'partial push Back uses the history snapshot');
    assert.equal(await cleanup.locator('.widget').count(), 1, 'partial history restoration is idempotent');
    // Async listeners are removed whether the promise settles live or after removal.
    for (const finishLive of [true, false]) {
      const previous = await cleanup.evaluate(() => globalThis.cleanupAsyncs ?? 0);
      await cleanup.click('#cleanup-async'); await cleanup.waitForFunction(n => globalThis.cleanupAsyncLoads === n + 1, previous);
      await cleanup.evaluate(() => globalThis.__recooler_ready);
      if (finishLive) { await cleanup.evaluate(() => globalThis.finishCleanup()); await cleanup.waitForFunction(() => globalThis.asyncResolved === 1); }
      await cleanup.evaluate(() => window.dispatchEvent(new Event('async-drop')));
      assert.deepEqual(await cleanup.evaluate(() => [globalThis.asyncDrops, globalThis.asyncLateDrops]), finishLive ? [1, 1] : [2, 1]);
      await cleanup.click('#cleanup-clear'); await cleanup.waitForFunction(n => globalThis.cleanupAsyncs === n + 1, previous);
      if (!finishLive) { await cleanup.evaluate(() => globalThis.finishCleanup()); await cleanup.waitForFunction(() => globalThis.asyncResolved === 2); }
      await cleanup.evaluate(() => window.dispatchEvent(new Event('async-drop')));
      assert.deepEqual(await cleanup.evaluate(() => [globalThis.asyncDrops, globalThis.asyncLateDrops]), finishLive ? [1, 1] : [2, 1]);
    }
    await cleanup.click('#cleanup-open'); await cleanup.waitForFunction(() => globalThis.cleanupFragmentLoads === 3);
    await cleanup.evaluate(() => { globalThis.throwCleanup = true; });
    // B's module is already registered: retirement must happen synchronously in init.
    await cleanup.click('#cleanup-tob'); await cleanup.waitForFunction(() => globalThis.cleanupLoadsB === 2); await sleep(80);
    assert.deepEqual(await cleanup.evaluate(() => globalThis.cleanupLog.slice(-3)), ['fragment abort', 'a abort', 'b load']);
    assert.equal(await cleanup.evaluate(() => globalThis.cleanupFragments), 3);
    assert.equal(await cleanup.evaluate(() => globalThis.fragmentAbortFollowers), 3);
    assert.equal(await cleanup.evaluate(() => globalThis.cleanupAsyncs), 2);
    assert.deepEqual(cleanup.errors, ['abort failed']);
    assert.deepEqual(await cleanup.evaluate(() => globalThis.unhandled), []);
    await cleanup.close();
    // Routine navigation aborts fetch and throwIfAborted without pageerror.
    const fetching = await open('/cleanup-fetch');
    await fetching.waitForFunction(() => globalThis.fetchStarted);
    await fetching.click('#fetch-away'); await fetching.waitForFunction(() => globalThis.loadsB === 1);
    await fetching.waitForFunction(() => globalThis.fetchAbort);
    assert.deepEqual(await fetching.evaluate(() => globalThis.fetchAbort), { sameReason: true, domException: true, name: 'AbortError' });
    assert.deepEqual(fetching.errors, []); assert.deepEqual(await fetching.evaluate(() => globalThis.unhandled), []);
    await fetching.close();
    const throwing = await open('/cleanup-throw');
    await throwing.click('#throw-away'); await throwing.waitForFunction(() => globalThis.loadsB === 1);
    await throwing.evaluate(() => globalThis.finishThrow()); await sleep(50);
    assert.equal(await throwing.evaluate(() => globalThis.lateResource), undefined);
    assert.deepEqual(throwing.errors, []); assert.deepEqual(await throwing.evaluate(() => globalThis.unhandled), []);
    await throwing.close();
    // Native modules hold DCL while initial handler assets are unavailable.
    block = new Promise(r => { release = () => { block = undefined; r(); }; });
    const early = await browser.newPage(); let dclFired = false; early.on('domcontentloaded', () => { dclFired = true; });
    const navigation = early.goto(origin); await sleep(150); assert.equal(dclFired, false); release(); await navigation;
    assert.equal(await early.evaluate(() => globalThis.loadsA), 1); await early.close();
    // Streamed Suspense: browser executes engine scripts before deferred handler modules and DCL.
    const stream = await open('/stream');
    await stream.waitForSelector('#streamed'); assert.deepEqual(await stream.evaluate(() => globalThis.order.slice(0, 2)), ['DCL', 'onLoad']);
    await stream.click('#streamed'); assert.equal(await stream.evaluate(() => globalThis.streamClicks), 1);
    assert.equal(await stream.evaluate(() => globalThis.streamLoads), 1);
    assert((await stream.evaluate(() => globalThis.atDCL)).handlers > 0);
    const processing = await stream.evaluate(() => globalThis.streamProcessing);
    assert(processing.length > 0); assert(processing.every(x => x.handlers > 0));
    assert.deepEqual(stream.errors, []);
    await stream.close();
    // HX-Location and push-url run destination onLoad once despite inserted module scripts.
    for (const trigger of ['location', 'push']) {
      const p = await open(); await p.click('#' + trigger); await p.waitForFunction(() => globalThis.loadsC === 1); await sleep(80);
      assert.equal(await p.evaluate(() => globalThis.loadsC), 1); await p.close();
    }
    // Confirm swap window: no request before the module; public issueRequest resumes exactly once.
    const p = await open(); await p.evaluate(() => { globalThis.accept = true; });
    block = new Promise(r => { release = () => { block = undefined; r(); }; });
    const beforeGate = count('/m/gate'); await p.click('#tob'); await p.waitForSelector('#gate'); await sleep(80); await p.click('#gate'); await sleep(80);
    assert.equal(count('/m/gate'), beforeGate); release(); await p.waitForFunction(() => globalThis.gateConfirms === 1); await sleep(100);
    assert.equal(count('/m/gate'), beforeGate + 1); assert.deepEqual(p.errors, []); await p.close();
    // failure.mjs: reject an import, retry with a new URL, recover without a reload.
    const recovered = await open(); failures = 1; await recovered.click('#tob'); await recovered.waitForFunction(() => globalThis.loadsB === 1);
    await recovered.click('#handler'); assert.equal(await recovered.evaluate(() => globalThis.destinationClicks), 1);
    assert.deepEqual(await recovered.evaluate(() => globalThis.unhandled), []); await recovered.close();
    console.log(JSON.stringify({ chromium: true, major, legacy, hxLocation: true, pushUrl: true, initialBeforeDCL: true, streamedBeforeDCL: true,
      requestCounts: 'one per action; no loop', history: 'a b c back b', fragment: true, teardown: true, retry: true }));
  }
  // Persistent import failures reload once across the same page version, then stop.
  const broken = await open(); fail = true; const requestStart = count('/b');
  await broken.click('#tob'); await sleep(1200); assert(count('/b') <= requestStart + 2);
  assert.equal(await broken.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith('recooler:import:')).length), 1);
  assert.deepEqual(await broken.evaluate(() => globalThis.unhandled), []); fail = false; await broken.close();
  // Persistent HTML/entry mismatch reloads at most once for a version pair.
  badVersion = true; const mismatchStart = count('/'); const skew = await browser.newPage();
  await skew.goto(origin).catch(error => { if (!String(error).includes('interrupted')) throw error; }); await sleep(1000);
  assert.equal(count('/') - mismatchStart, 2); assert.equal(await skew.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith('recooler:version:')).length), 1);
  await skew.close(); badVersion = false;
} finally { release(); await browser?.close(); await new Promise(r => server ? server.close(r) : r()); await rm(root, { recursive: true, force: true }); }
