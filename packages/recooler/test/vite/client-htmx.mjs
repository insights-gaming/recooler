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
  await mkdir(path.join(root, 'node_modules')); await symlink(pkg, path.join(root, 'node_modules/recooler'), 'dir');
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
    <button id="gate" hx-post="/m/gate" hx-swap="none" hx-on--confirm={event => { event.preventDefault(); inc('gateConfirms'); if (globalThis.accept) event.detail.issueRequest(true); }}>gate</button>
    <button id="config" hx-post="/m/config" hx-swap="none" hx-on--config-request={() => inc('configs')}>config</button>
    <button id="request" hx-post="/m/request" hx-swap="none" hx-on--before-request={() => inc('befores')}>before</button>
    </>;`);
  await write('src/routes/edit/index.tsx', `${inc} export const onLoad = () => inc('editLoads');
    export default () => <button id="save" hx-on:click={() => inc('saves')}>save</button>;`);
  await write('src/routes/stream/index.tsx', `import { Suspense } from 'recooler/jsx'; ${inc}
    export const head = { scripts: [{ src: '/htmx.js' }] };
    export const onLoad = () => { inc('streamLoads'); (globalThis.order ??= []).push('onLoad'); };
    const Child = async () => { await new Promise(r => setTimeout(r, 200)); return <button id="streamed" hx-on:click={() => inc('streamClicks')}>streamed</button>; };
    export default props => <Suspense rid={props.rid} fallback={<p id="fallback">waiting</p>}><Child/></Suspense>;`);
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
    assert.deepEqual(await page.evaluate(() => globalThis.order.slice(0, 2)), ['onLoad', 'DCL']);
    const dcl = await page.evaluate(() => globalThis.atDCL); assert(dcl.handlers > 0); assert.equal(dcl.loads, 1);
    assert((await page.evaluate(() => globalThis.processed)).every(x => x.handlers > 0 && x.loads === 1));
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
    await page.click('#open'); await page.waitForFunction(() => globalThis.editLoads === 1); await page.click('#save');
    assert.equal(await page.evaluate(() => globalThis.saves), 1);
    await page.evaluate(() => globalThis.__recooler_client.init()); assert.equal(await page.evaluate(() => globalThis.editLoads), 1);
    assert.equal(await page.locator('[data-recooler-marker]').count(), 2);
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
    // Native modules hold DCL while initial handler assets are unavailable.
    block = new Promise(r => { release = () => { block = undefined; r(); }; });
    const early = await browser.newPage(); let dclFired = false; early.on('domcontentloaded', () => { dclFired = true; });
    const navigation = early.goto(origin); await sleep(150); assert.equal(dclFired, false); release(); await navigation;
    assert.equal(await early.evaluate(() => globalThis.loadsA), 1); await early.close();
    // Streamed Suspense: browser executes engine scripts before deferred handler modules and DCL.
    const stream = await open('/stream');
    await stream.waitForSelector('#streamed'); assert.deepEqual(await stream.evaluate(() => globalThis.order.slice(0, 2)), ['onLoad', 'DCL']);
    await stream.click('#streamed'); assert.equal(await stream.evaluate(() => globalThis.streamClicks), 1);
    assert.equal((await stream.evaluate(() => globalThis.atDCL)).loads, 1);
    assert((await stream.evaluate(() => globalThis.atDCL)).handlers > 0);
    const processing = await stream.evaluate(() => globalThis.streamProcessing);
    assert(processing.length > 0); assert(processing.every(x => x.handlers > 0 && x.loads === 1));
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
      requestCounts: 'one per action; no loop', history: 'a b c back b', fragment: true, retry: true }));
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
