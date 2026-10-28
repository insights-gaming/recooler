// Round 4 Chromium regressions. Usage: node client-confirm.mjs <1|2> [scenario...]
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const PKG = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(path.join(PKG, '.cache'), { recursive: true });
const workspace = await mkdtemp(path.join(PKG, '.cache/confirm-chromium-'));
const { createBuilder } = await import(PKG + '/node_modules/vite/dist/node/index.js');
const { chromium } = await import(pathToFileURL(PKG + '/node_modules/playwright/index.mjs').href);
const { recooler } = await import(PKG + '/dist/vite/index.js');
const major = process.argv[2] ?? '2';
const only = process.argv.slice(3);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const htmxSrc = await readFile(path.join(PKG, 'node_modules', major === '1' ? 'htmx-1' : 'htmx.org', 'dist/htmx.js'));
const inc = `const inc = k => { globalThis[k] = (globalThis[k] ?? 0) + 1; };`;
let gen = 0;
const servers = new Set();
const failures = [];
const check = (label, cond, detail) => { if (!cond) failures.push(label + ' ' + JSON.stringify(detail)); return !!cond; };

async function build(name, files, { entry, htmx = {}, extra = {} } = {}) {
  const root = path.join(workspace, name);
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, 'node_modules'), { recursive: true });
  await symlink(PKG, path.join(root, 'node_modules/recooler'), 'dir');
  for (const d of ['hono', 'easy-jsx-html-engine']) await symlink(path.join(PKG, 'node_modules', d), path.join(root, 'node_modules', d), 'dir');
  files = { 'package.json': JSON.stringify({ name: 'rc4-' + name, type: 'module' }),
    'src/entry.ts': entry ?? `export { default } from 'virtual:recooler/app';`, ...files };
  for (const [n, c] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, n)), { recursive: true }); await writeFile(path.join(root, n), c); }
  const builder = await createBuilder({ root, configFile: false, logLevel: 'silent', plugins: recooler({ htmx }),
    environments: { client: { build: { minify: false } } }, ssr: { noExternal: true },
    build: { ssr: 'src/entry.ts', outDir: 'server', rolldownOptions: { output: { entryFileNames: 'app.mjs' } } }, ...extra });
  await builder.buildApp();
  const app = (await import(pathToFileURL(path.join(root, 'server/app.mjs')).href + '?g=' + gen++)).default;
  return { root, app };
}

async function serve({ root, app }) {
  const s = { requests: [], assets: [], blocks: [], bodies: {} };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/htmx.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(htmxSrc); }
      if (url.pathname.startsWith('/assets/')) {
        s.assets.push(req.url);
        for (;;) { const b = s.blocks.find(b => b.match(url.pathname)); if (!b) break; await b.promise; }
        res.setHeader('Content-Type', 'text/javascript'); return res.end(await readFile(path.join(root, 'dist/client', url.pathname)));
      }
      s.requests.push(req.method + ' ' + url.pathname + url.search);
      if (url.pathname.startsWith('/m/frag')) { await sleep(50); res.setHeader('Content-Type', 'text/html'); return res.end('frag'); }
      if (url.pathname.startsWith('/m/')) {
        let body = ''; for await (const c of req) body += c; s.bodies[url.pathname] = body;
        res.statusCode = 204; return res.end();
      }
      const response = await app.fetch(new Request(new URL(req.url, s.origin), { headers: req.headers }), { RECOOLER_SECRET: 'k' });
      res.statusCode = response.status; res.setHeader('Content-Type', 'text/html');
      for await (const chunk of response.body) res.write(chunk);
      res.end();
    } catch (e) { res.statusCode = 500; res.end(String(e.stack)); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  s.origin = `http://127.0.0.1:${server.address().port}`;
  servers.add(s);
  s.close = () => { servers.delete(s); for (const b of s.blocks) b.release(); return new Promise(r => server.close(r)); };
  s.count = p => s.requests.filter(r => r.split('?')[0].endsWith(' ' + p)).length;
  s.block = match => { const b = { match }; b.promise = new Promise(r => { b.release = () => { s.blocks = s.blocks.filter(x => x !== b); r(); }; }); s.blocks.push(b); return b; };
  s.gateFetches = () => s.assets.filter(a => a.includes('recooler-gate')).length;
  return s;
}

const browser = await chromium.launch({ headless: true });
async function page(s, pathname, { wait = true, init } = {}) {
  const p = await browser.newPage();
  p.errors = []; p.logs = []; p.dialogs = [];
  p.on('pageerror', e => p.errors.push(e.message));
  p.on('console', m => p.logs.push(m.type() + ': ' + m.text()));
  p.dialogHandler = d => d.dismiss();
  p.on('dialog', d => { p.dialogs.push(d.message()); p.dialogHandler(d); });
  await p.addInitScript(() => { document.addEventListener('DOMContentLoaded', () => { globalThis.dclAt = performance.now(); }); });
  if (init) await p.addInitScript(init);
  p.nav = p.goto(s.origin + pathname);
  if (wait) await p.nav;
  return p;
}
const results = {};
const want = name => !only.length || only.includes(name);
const legacyConsumerEntry = `import { createApp } from 'recooler/router';
import { jsxPages } from 'recooler/jsx';
import { htmx } from 'recooler/htmx';
import { CreateResolvedTemplate } from 'easy-jsx-html-engine';
import { table, clients, clientEntry, clientPreloads, clientModules, namespace } from 'virtual:recooler/htmx';
import { manifest } from './routes.gen';
export default createApp(manifest, { pages: jsxPages({
  ResolvedTemplate: CreateResolvedTemplate({ resolvedScriptMiddleware: script => script + '.forEach(htmx.process)' }),
}), extensions: [htmx({ table, clients, clientEntry, clientPreloads, clientModules, legacyClientScript: true, namespace, secret: () => 'k' })] });`;
const legacyRoot = `import { dangerouslyPreventEscaping } from 'easy-jsx-html-engine';
export default (Content, clientScript) => async props => {
  const content = await <Content {...props}/>;
  return <html><head><meta charset="utf-8"/><script src="/htmx.js"></script></head>
    <body hx-boost="true">{content}{clientScript ? <script>{dangerouslyPreventEscaping('(()=>{' + clientScript + '})()')}</script> : null}</body></html>;
};`;

try {
  // ---------------------------------------------------------------------------
  // A. hx-confirm (htmx's own dialog) on a client-bearing page vs a handler-free page.
  if (want('hx-confirm')) {
    const built = await build('hxconfirm', {
      'src/root.tsx': legacyRoot,
      'src/routes/index.tsx': `${inc}
export const onLoad = () => inc('loads');
export default () => <><button id="h" hx-on:click={() => inc('c')}>h</button>
  <button id="deny" hx-post="/m/deny" hx-confirm="Never?" hx-on--confirm={e => { e.preventDefault(); inc('denies'); }}>deny</button>
  <button id="del" hx-post="/m/del" hx-swap="none" hx-on--confirm={() => inc('allows')} hx-confirm="Delete everything?">del</button>
  <form id="f" hx-post="/m/form" hx-swap="none" hx-on--confirm={() => inc('allows')} hx-confirm="Submit form?"><button id="fb">go</button></form>
  <a id="bl" href="/m/boosted" hx-on--confirm={() => inc('allows')} hx-confirm="Leave?">boosted link</a></>;`,
      'src/routes/plain/index.tsx': `export default () => <><button id="del" hx-post="/m/del" hx-swap="none" hx-confirm="Delete everything?">del</button>
  <form id="f" hx-post="/m/form" hx-swap="none" hx-confirm="Submit form?"><button id="fb">go</button></form>
  <a id="bl" href="/m/boosted" hx-confirm="Leave?">boosted link</a></>;`,
    }, { htmx: { legacyClientScript: true } });
    const s = await serve(built);
    results['hx-confirm'] = {};
    for (const route of ['/plain', '/']) {
      const p = await page(s, route); await sleep(200);
      const gate = await p.evaluate(() => !!document.querySelector('script[src*="recooler-gate"]'));
      s.requests = [];
      await p.click('#del'); await sleep(200);
      await p.click('#fb'); await sleep(200);
      await p.click('#bl', { noWaitAfter: true }); await sleep(300);
      const dismissed = { dialogs: [...p.dialogs], del: s.count('/m/del'), form: s.count('/m/form'), boosted: s.count('/m/boosted'), url: new URL(p.url()).pathname };
      p.dialogs.length = 0; p.dialogHandler = d => d.accept(); s.requests = [];
      await p.click('#del'); await sleep(200);
      await p.click('#fb'); await sleep(200);
      await p.click('#bl', { noWaitAfter: true }); await sleep(200);
      const accepted = { dialogs: [...p.dialogs], del: s.count('/m/del'), form: s.count('/m/form'), boosted: s.count('/m/boosted') };
      results['hx-confirm'][route] = { gate, dismissed, accepted, errors: p.errors };
      check(`hx-confirm ${route}: dialog shown + no request when dismissed`, dismissed.dialogs.length === 3 && dismissed.del === 0 && dismissed.form === 0 && dismissed.boosted === 0, dismissed);
      check(`hx-confirm ${route}: accepted dialog issues once`, accepted.dialogs.length === 3 && accepted.del === 1 && accepted.form === 1 && accepted.boosted === 1, accepted);
      if (route === '/') {
        p.dialogs.length = 0;
        await p.click('#deny'); await sleep(100);
        assert.equal(s.count('/m/deny'), 0);
        assert.deepEqual(p.dialogs, []);
        assert.equal(await p.evaluate(() => globalThis.denies), 1);
        assert.equal(await p.evaluate(() => globalThis.allows), 6);
      }
      assert.deepEqual(p.errors, []);
      await p.close();
    }
    await s.close();
  }

  // ---------------------------------------------------------------------------
  // B. htmx.ajax promise resolves after the swap (htmx contract).
  if (want('ajax-promise')) {
    const built = await build('ajax', {
      'src/root.tsx': legacyRoot,
      'src/routes/index.tsx': `${inc}
export default () => <><button id="h" hx-on:click={() => inc('c')}>h</button><div id="t">old</div></>;`,
      'src/routes/plain/index.tsx': `export default () => <div id="t">old</div>;`,
    }, { htmx: { legacyClientScript: true } });
    const s = await serve(built);
    results['ajax-promise'] = {};
    for (const route of ['/plain', '/']) {
      const p = await page(s, route); await sleep(200);
      const atThen = await p.evaluate(() => htmx.ajax('GET', '/m/frag', { target: '#t', swap: 'innerHTML' }).then(() => document.querySelector('#t').textContent));
      await sleep(200);
      const later = await p.evaluate(() => document.querySelector('#t').textContent);
      assert.deepEqual(p.errors, []);
      results['ajax-promise'][route] = { atThen, later };
      check(`ajax-promise ${route}: then() sees swapped content`, atThen === 'frag', { atThen, later });
      await p.close();
    }
    await s.close();
  }

  // ---------------------------------------------------------------------------
  // C. Pending confirm replay: confirm clicked after the gate but before modules.
  if (want('pending-replay')) {
    const built = await build('pending', {
      'src/root.tsx': legacyRoot, 'src/entry.ts': legacyConsumerEntry,
      'src/routes/index.tsx': `import { Suspense } from 'recooler/jsx'; ${inc}
const Slow = async ({ ms, children }) => { await new Promise(r => setTimeout(r, ms)); return children; };
export const onLoad = () => inc('loads');
export default props => <>
  <Suspense rid={props.rid} fallback={<p>wait1</p>}><Slow ms={150}>
    <button id="go" hx-post="/m/go" hx-swap="none" hx-on--confirm={e => { inc('goConfirms'); }}>go (handler allows)</button>
    <button id="yes" hx-post="/m/yes" hx-swap="none" hx-confirm="Allow deferred?" hx-on--confirm={() => inc('yesConfirms')}>yes</button>
    <button id="ask" hx-post="/m/ask" hx-swap="none" hx-confirm="Deferred?" hx-on--confirm={() => inc('askConfirms')}>ask</button>
    <button id="stop" hx-post="/m/stop" hx-swap="none" hx-on--confirm={e => { e.preventDefault(); inc('stopConfirms'); }}>stop</button>
  </Slow></Suspense>
  <Suspense rid={props.rid} fallback={<p>wait2</p>}><Slow ms={1500}><p id="late">late</p></Slow></Suspense>
</>;`,
    }, { htmx: { legacyClientScript: true } });
    const s = await serve(built);
    results['pending-replay'] = {};
    const variants = {
      'entry-wrapper-slow': p => p.endsWith('/recooler-client.js'),
      'route-slow': p => p.includes('recooler-route-'),
      'both-modules-slow': p => p.includes('recooler-route-') || p.endsWith('/recooler-client.js'),
      'all-but-gate-slow': p => !p.includes('recooler-gate'),
      'route-graph-first': [p => !p.includes('recooler-gate'), p => p.endsWith('/recooler-client.js')],
      'entry-first': [p => !p.includes('recooler-gate'), p => p.includes('recooler-route-')],
    };
    for (const [variant, match] of Object.entries(variants)) {
      s.requests = []; s.assets = [];
      const b = s.block(typeof match === 'function' ? match : match[0]);
      const p = await page(s, '/', { wait: false });
      await p.waitForSelector('#go', { timeout: 5000 }); await sleep(50);
      const second = typeof match === 'function' ? undefined : s.block(match[1]);
      const before = await p.evaluate(() => ({ dcl: !!globalThis.dclAt, rc: typeof globalThis.$rc, gate: !!globalThis.__recooler_gate, entry: !!globalThis.__recooler_client }));
      p.dialogHandler = d => d.message() === 'Allow deferred?' ? d.accept() : d.dismiss();
      await p.click('#go'); await p.click('#stop'); await p.click('#ask'); await p.click('#yes'); await sleep(100);
      const reqBeforeRelease = s.requests.filter(r => r.includes('/m/'));
      b.release();
      if (second) { await sleep(300); results['pending-replay'][variant + ':midway'] = await p.evaluate(() => ({ entry: !!globalThis.__recooler_client, handlers: Object.keys(globalThis.$handlers ?? {}).length, goConfirms: globalThis.goConfirms ?? 0 })); results['pending-replay'][variant + ':midwayRequests'] = s.requests.filter(r => r.includes('/m/')); second.release(); }
      await p.nav; await p.waitForFunction(() => globalThis.loads === 1, null, { timeout: 5000 }).catch(() => {}); await sleep(400);
      const after = await p.evaluate(() => ({ goConfirms: globalThis.goConfirms ?? 0, stopConfirms: globalThis.stopConfirms ?? 0, loads: globalThis.loads ?? 0 }));
      results['pending-replay'][variant] = { before, reqBeforeRelease, after, go: s.count('/m/go'), stop: s.count('/m/stop'), errors: p.errors };
      check(`pending-replay ${variant}: allowed confirm issues exactly once`, s.count('/m/go') === 1 && after.goConfirms === 1, results['pending-replay'][variant]);
      check(`pending-replay ${variant}: prevented confirm never issues`, s.count('/m/stop') === 0, results['pending-replay'][variant]);
      assert.equal(s.count('/m/ask'), 0, variant + ': dismissed deferred prompt');
      assert.deepEqual([...p.dialogs].sort(), ['Allow deferred?', 'Deferred?'], variant);
      assert.equal(s.count('/m/yes'), 1, variant + ': accepted deferred prompt');
      assert.equal(await p.evaluate(() => globalThis.yesConfirms), 1);
      p.dialogs.length = 0; p.dialogHandler = d => d.accept();
      await p.click('#ask'); await sleep(100);
      assert.equal(s.count('/m/ask'), 1, variant + ': accepted ready prompt');
      assert.deepEqual(p.dialogs, ['Deferred?']);
      assert.equal(await p.evaluate(() => globalThis.askConfirms), 2);
      assert.deepEqual(p.errors, [], variant);
      await p.close();
    }
    await s.close();
  }

  // ---------------------------------------------------------------------------
  // D. Gate cost: presence by route, fetches per load/boost, parser blocking.
  if (want('gate-cost')) {
    const built = await build('gatecost', {
      'src/root.tsx': legacyRoot,
      'src/routes/index.tsx': `${inc}
export const onLoad = () => inc('loadsA');
export default () => <><a id="tob" href="/b">b</a><a id="toplain" href="/plain">plain</a><button id="ac" hx-on:click={() => inc('aClicks')}>a</button><p id="after">after</p><input id="early-check" type="checkbox" hx-on:click={e => e.preventDefault()}/></>;`,
      'src/routes/b/index.tsx': `${inc}
export const onLoad = () => inc('loadsB');
export default () => <><a id="toa" href="/">a</a><button id="bc" hx-on:click={() => inc('bClicks')}>b</button></>;`,
      'src/routes/plain/index.tsx': `export default () => <><a id="toa" href="/">a</a><p>plain</p></>;`,
    }, { htmx: { legacyClientScript: true } });
    const s = await serve(built);
    const htmlA = await (await fetch(s.origin + '/')).text();
    const htmlPlain = await (await fetch(s.origin + '/plain')).text();
    const r = results['gate-cost'] = {
      gateTagA: htmlA.match(/<script src="[^"]*recooler-gate[^"]*"><\/script>/)?.[0],
      gateOnPlain: htmlPlain.includes('recooler-gate'), markerOnPlain: htmlPlain.includes('data-recooler-marker'),
      modulesOnPlain: (htmlPlain.match(/type="module"/g) ?? []).length,
    };
    check('gate-cost: no gate on handler-free route', !r.gateOnPlain && !r.markerOnPlain, r);
    s.assets = [];
    const p = await page(s, '/'); await p.waitForFunction(() => globalThis.loadsA === 1); await sleep(100);
    r.gateFetchesInitial = s.gateFetches();
    const counts = [];
    for (const link of ['#tob', '#toa', '#tob', '#toa']) { await p.click(link); await sleep(300); counts.push(s.gateFetches()); }
    r.gateFetchesAfterEachBoost = counts;
    r.gateScriptsInBody = await p.evaluate(() => document.querySelectorAll('script[src*="recooler-gate"]').length);
    await p.close();
    // Parser blocking: hold only the gate for 600 ms.
    const b = s.block(() => true);
    const p2 = await page(s, '/', { wait: false });
    await sleep(300);
    r.whileGateHeld = await p2.evaluate(() => ({ afterParsed: !!document.querySelector('#after'), readyState: document.readyState }));
    assert.equal(r.whileGateHeld.afterParsed, true);
    assert.equal(await p2.evaluate(() => typeof self.$rc), 'undefined');
    await p2.click('#early-check');
    assert.equal(await p2.isChecked('#early-check'), true, 'unavailable native guards leave browser defaults intact');
    assert.equal(r.gateTagA, undefined);
    assert.equal(r.gateFetchesInitial, 0);
    assert.deepEqual(r.gateFetchesAfterEachBoost, [0, 0, 0, 0]);
    assert.equal(r.gateScriptsInBody, 0);
    assert.equal(r.modulesOnPlain, 0);
    b.release(); await p2.nav;
    await p2.close();
    await s.close();
  }

  // ---------------------------------------------------------------------------
  // E. Double scripts: evaluation, registration, onLoad across load/boost/history.
  if (want('double')) {
    const built = await build('double', {
      'src/root.tsx': legacyRoot,
      'src/lib/count.ts': `globalThis.libEvals = (globalThis.libEvals ?? 0) + 1; export const bump = (k: string) => { (globalThis as any)[k] = ((globalThis as any)[k] ?? 0) + 1; };`,
      'src/routes/index.tsx': `import { bump } from '../lib/count';
export const onLoad = () => { bump('loadsA'); globalThis.loadsAWhen = (globalThis.loadsAWhen ?? []).concat(document.readyState + ':' + !!document.querySelector('#lastA')); };
export default () => <><a id="tob" href="/b">b</a><button id="ac" hx-on:click={() => bump('aClicks')}>a</button><p id="lastA">last</p></>;`,
      'src/routes/b/index.tsx': `import { bump } from '../../lib/count';
export const onLoad = () => bump('loadsB');
export default () => <><a id="toa" href="/">a</a><button id="bc" hx-on:click={() => bump('bClicks')}>b</button></>;`,
    }, { htmx: { legacyClientScript: true } });
    const s = await serve(built);
    const countWrites = () => {
      const writes = globalThis.handlerWrites = {};
      globalThis.$handlers = new Proxy(Object.create(null), { set(t, k, v) { writes[k] = (writes[k] ?? 0) + 1; t[k] = v; return true; } });
    };
    const r = results.double = {};
    const snap = p => p.evaluate(() => ({ libEvals: globalThis.libEvals, loadsA: globalThis.loadsA ?? 0, loadsB: globalThis.loadsB ?? 0, aClicks: globalThis.aClicks ?? 0, bClicks: globalThis.bClicks ?? 0,
      writes: Object.values(globalThis.handlerWrites).join(','), when: (globalThis.loadsAWhen ?? []).join(' '),
      routeFetches: performance.getEntriesByType('resource').filter(e => e.name.includes('recooler-route')).length,
      markers: document.querySelectorAll('[data-recooler-marker]').length }));
    // Route module held 700 ms: deferred copy must hold DCL; async copy cannot complete after DCL.
    s.assets = [];
    const b = s.block(x => x.includes('recooler-route-'));
    const t0 = Date.now();
    const p = await page(s, '/', { wait: false, init: countWrites });
    setTimeout(() => b.release(), 700);
    await p.nav; await p.waitForFunction(() => globalThis.loadsA === 1); await sleep(150);
    r.initial = { ...(await snap(p)), dclAfterReleaseMs: (await p.evaluate(() => Math.round(performance.timeOrigin + globalThis.dclAt))) - t0 };
    await p.click('#ac'); r.afterClick = (await snap(p)).aClicks;
    const steps = [['boost A->B', () => p.click('#tob')], ['boost B->A', () => p.click('#toa')], ['back (restore B)', () => p.goBack()], ['back (restore A)', () => p.goBack()], ['forward (restore B)', () => p.goForward()], ['reload', () => p.reload()]];
    r.steps = {};
    for (const [label, act] of steps) { await act(); await sleep(400); r.steps[label] = await snap(p); }
    await p.click('#bc'); r.finalBClick = (await snap(p)).bClicks;
    r.errors = p.errors;
    assert.equal(r.initial.libEvals, 1);
    assert.equal(r.initial.loadsA, 1);
    assert.equal(r.initial.loadsB, 0);
    assert.equal(r.initial.writes, '1');
    assert.equal(r.initial.routeFetches, 1);
    assert.equal(r.initial.markers, 1);
    assert.match(r.initial.when, /^(interactive|complete):true$/);
    assert(r.initial.dclAfterReleaseMs >= 650);
    assert.equal(r.afterClick, 1);
    const expected = [[1,1], [2,1], [2,2], [3,2], [3,3], [0,1]];
    Object.values(r.steps).forEach((value, i) => {
      assert.deepEqual([value.loadsA, value.loadsB], expected[i]);
      assert.equal(value.libEvals, 1);
      assert.equal(value.markers, 1);
      assert.equal(value.writes, i === 5 ? '1' : '1,1');
      assert.equal(value.routeFetches, i === 5 ? 1 : 2);
    });
    assert.equal(r.finalBClick, 1);
    assert.deepEqual(r.errors, []);
    await p.close(); await s.close();
  }

  // ---------------------------------------------------------------------------
  // F. Marker: client-bearing -> handler-free boost and back; client-bearing table rows.
  if (want('marker')) {
    const built = await build('marker', {
      'src/root.tsx': `import { dangerouslyPreventEscaping } from 'easy-jsx-html-engine';
export default (Content, clientScript) => props => props.ctx.req.header('hx-request') === 'true' && !props.ctx.req.header('hx-boosted') ? <Content {...props}/>
  : <html><head><script src="/htmx.js"></script></head><body hx-boost="true"><Content {...props}/>{clientScript ? <script>{dangerouslyPreventEscaping(clientScript)}</script> : null}</body></html>;`,
      'src/routes/index.tsx': `${inc}
export const onLoad = () => inc('loadsA');
export default () => <><a id="toh" href="/h">h</a><button id="ac" hx-on:click={() => inc('aClicks')}>a</button>
  <table><tbody id="tb"></tbody></table><button id="more" hx-get="/rows" hx-target="#tb" hx-swap="beforeend" hx-boost="false">rows</button>
  <table><tbody id="tb2"></tbody></table><button id="more2" hx-get="/plainrows" hx-target="#tb2" hx-swap="beforeend">plain rows</button></>;`,
      'src/routes/h/index.tsx': `export default () => <><a id="toa" href="/">a</a><p id="hp">handler-free</p></>;`,
      'src/routes/rows/index.tsx': `${inc}
export const onLoad = () => inc('loadsRows');
export default () => <><tr class="r"><td><button class="rb" hx-on:click={() => inc('rowClicks')}>1</button></td></tr><tr class="r"><td>2</td></tr></>;`,
      'src/routes/plainrows/index.tsx': `export default () => <><tr class="pr"><td>1</td></tr><tr class="pr"><td>2</td></tr></>;`,
    }, { htmx: { legacyClientScript: true } });
    const s = await serve(built);
    const r = results.marker = {};
    r.rowsResponse = (await (await fetch(s.origin + '/rows', { headers: { 'HX-Request': 'true' } })).text()).slice(0, 260);
    const p = await page(s, '/'); await p.waitForFunction(() => globalThis.loadsA === 1); await sleep(100);
    await p.click('#more'); await sleep(400);
    await p.click('#more2'); await sleep(300);
    r.rows = await p.evaluate(() => ({ clientRows: document.querySelectorAll('#tb tr.r').length, plainRows: document.querySelectorAll('#tb2 tr.pr').length,
      rowButtons: document.querySelectorAll('#tb .rb').length, strayRowButtons: document.querySelectorAll('.rb:not(#tb .rb)').length, loadsRows: globalThis.loadsRows ?? 0,
      tbHTML: document.querySelector('#tb').innerHTML.slice(0, 200) }));
    if (r.rows.rowButtons + r.rows.strayRowButtons) { await p.click('.rb'); await sleep(50); r.rows.rowClicks = await p.evaluate(() => globalThis.rowClicks ?? 0); }
    check('marker: client-bearing tr rows inserted intact', r.rows.clientRows === 2 && r.rows.rowButtons === 1, r.rows);
    check('marker: handler-free tr rows inserted intact', r.rows.plainRows === 2, r.rows);
    const snap = () => p.evaluate(() => ({ loadsA: globalThis.loadsA, markers: [...document.querySelectorAll('[data-recooler-marker]')].map(n => n.dataset.recoolerRoute).join(','), gate: document.querySelectorAll('script[src*="recooler-gate"]').length, mods: document.querySelectorAll('script[type=module]').length, url: location.pathname }));
    r.steps = {};
    await p.click('#toh'); await sleep(400); r.steps['A->H'] = await snap();
    await p.click('#toa'); await sleep(400); r.steps['H->A'] = await snap();
    await p.click('#ac'); r.steps.aClicks = await p.evaluate(() => globalThis.aClicks);
    await p.goBack(); await sleep(400); r.steps['back to H'] = await snap();
    await p.goBack(); await sleep(400); r.steps['back to A'] = await snap();
    r.errors = p.errors;
    assert(r.rowsResponse.startsWith('<tr'));
    assert.equal(r.rows.loadsRows, 1);
    assert.equal(r.rows.rowClicks, 1);
    assert.equal(r.rows.strayRowButtons, 0);
    assert.deepEqual(Object.entries(r.steps).filter(([k]) => k !== 'aClicks').map(([,v]) => [v.loadsA,v.markers,v.gate]), [[1,'',0], [2,'/',0], [2,'',0], [3,'/',0]]);
    assert.equal(r.steps.aClicks, 1);
    assert.deepEqual(r.errors, []);
    await p.close(); await s.close();
  }
  // ---------------------------------------------------------------------------
  // G. Handler-free first page (no gate/entry) boosted into a confirm-guarded page.
  if (want('cold-boost')) {
    const built = await build('coldboost', {
      'src/routes/raw/index.tsx': `export default () => <div id="raw" hx-get="/m/raw" hx-trigger="load" hx-swap="none" hx-on--confirm="event.preventDefault()">raw string guard</div>;`,
      'src/root.tsx': legacyRoot,
      'src/routes/index.tsx': `export default () => <><a id="tog" href="/g">g</a><a id="toraw" href="/raw">raw</a><p>handler-free</p></>;`,
      'src/routes/g/index.tsx': `${inc}
export const onLoad = () => inc('loadsG');
export default () => <>
  <div id="ld" hx-get="/m/ld" hx-trigger="load" hx-swap="none" hx-on--confirm={e => { e.preventDefault(); inc('ldConfirms'); }}>load-guard</div>
  <button id="gp" hx-post="/m/gp" hx-swap="none" hx-on--confirm={e => { e.preventDefault(); inc('gpConfirms'); }}>guarded post</button>
</>;`,
    }, { htmx: { legacyClientScript: true } });
    const s = await serve(built);
    const r = results['cold-boost'] = {};
    for (const delay of [0, 300]) {
      s.requests = [];
      const p = await page(s, '/'); await sleep(100);
      const b = delay ? s.block(x => x.includes('recooler-') && !x.includes('recooler-gate')) : undefined;
      await p.click('#tog'); await p.waitForSelector('#gp'); await sleep(20);
      await p.click('#gp'); await sleep(delay + 50);
      b?.release(); await sleep(500);
      r['moduleDelay' + delay] = { ld: s.count('/m/ld'), gp: s.count('/m/gp'), state: await p.evaluate(() => ({ loadsG: globalThis.loadsG ?? 0, ldConfirms: globalThis.ldConfirms ?? 0, gpConfirms: globalThis.gpConfirms ?? 0 })), errors: p.errors.slice(0, 3) };
      check(`cold-boost delay ${delay}: guarded load request blocked`, s.count('/m/ld') === 0, r['moduleDelay' + delay]);
      check(`cold-boost delay ${delay}: guarded post blocked`, s.count('/m/gp') === 0, r['moduleDelay' + delay]);
      assert.deepEqual(r['moduleDelay' + delay].state, { loadsG: 1, ldConfirms: 1, gpConfirms: 1 });
      assert.deepEqual(p.errors, []);
      await p.close();
    }
    // Raw wildcard strings retain htmx 1's own synchronous-load ordering bug.
    s.requests = [];
    const raw = await page(s, '/'); await raw.click('#toraw');
    await raw.waitForSelector('#raw'); await sleep(200);
    assert.equal(s.count('/m/raw'), major === '1' ? 1 : 0);
    assert.deepEqual(raw.errors, []);
    await raw.close();
    await s.close();
  }
} finally { await browser.close(); await Promise.all([...servers].map(s => s.close())); await rm(workspace, { recursive: true, force: true }); }
assert.deepEqual(failures, []);
console.log(JSON.stringify({ clientConfirm: true, major, ...results }, null, 1));
