// Round 3 attacks as asserting package regressions. Usage: node client-streaming.mjs <1|2> <legacy|modern> [scenario...]
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const PKG = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(path.join(PKG, '.cache'), { recursive: true });
const workspace = await mkdtemp(path.join(PKG, '.cache/streaming-chromium-'));
const { createBuilder } = await import(PKG + '/node_modules/vite/dist/node/index.js');
const { chromium } = await import(pathToFileURL(PKG + '/node_modules/playwright/index.mjs').href);
const { recooler } = await import(PKG + '/dist/vite/index.js');
const major = process.argv[2] ?? '2';
const legacy = process.argv[3] === 'legacy';
const only = process.argv.slice(4);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const htmxSrc = await readFile(path.join(PKG, 'node_modules', major === '1' ? 'htmx-1' : 'htmx.org', 'dist/htmx.js'));
const htmxEsm = major === '2' ? await readFile(path.join(PKG, 'node_modules/htmx.org/dist/htmx.esm.js')) : null;
const inc = `const inc = k => { globalThis[k] = (globalThis[k] ?? 0) + 1; };`;
let gen = 0;

async function build(name, files, { entry, htmx = { legacyClientScript: legacy }, extra = {} } = {}) {
  const root = path.join(workspace, name);
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, 'node_modules'), { recursive: true });
  await mkdir(path.join(root, 'node_modules/@insights-gaming'), { recursive: true }); await symlink(PKG, path.join(root, 'node_modules/@insights-gaming/recooler'), 'dir');
  for (const d of ['hono', 'easy-jsx-html-engine']) await symlink(path.join(PKG, 'node_modules', d), path.join(root, 'node_modules', d), 'dir');
  if (legacy && !files['src/root.tsx'] && name !== 'consumer-modern') files['src/root.tsx'] = `import { dangerouslyPreventEscaping } from 'easy-jsx-html-engine';
export default (Content, clientScript) => props => <html><head><script src="/htmx.js"/></head><body><Content {...props}/><script>{dangerouslyPreventEscaping(clientScript ?? '')}</script></body></html>;`;
  if (!legacy) for (const key of Object.keys(files)) files[key] = files[key].replaceAll('legacyClientScript: true', 'legacyClientScript: false');
  files = { 'package.json': JSON.stringify({ name: 'rc3-' + name, type: 'module' }),
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
  const s = { requests: [], assets: [], block: undefined, release: () => {}, bodies: {} };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/htmx.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(htmxSrc); }
      if (url.pathname === '/htmx.esm.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(htmxEsm); }
      if (url.pathname.startsWith('/assets/')) {
        s.assets.push(req.url);
        if (s.assetDelay && !url.pathname.endsWith('recooler-gate.js')) await sleep(s.assetDelay);
        if (s.block && url.pathname.includes(s.blockMatch ?? '')) await s.block;
        if (s.fail && url.pathname.includes('recooler-slice')) { res.statusCode = 503; return res.end('down'); }
        res.setHeader('Content-Type', 'text/javascript'); return res.end(await readFile(path.join(root, 'dist/client', url.pathname)));
      }
      s.requests.push(req.method + ' ' + url.pathname + url.search);
      if (url.pathname.startsWith('/m/')) {
        let body = ''; for await (const c of req) body += c; s.bodies[url.pathname] = body;
        res.statusCode = req.method === 'GET' && !req.headers['hx-request'] ? 200 : 204; return res.end(res.statusCode === 200 ? '<p id="navigated">navigated</p>' : '');
      }
      const response = await app.fetch(new Request(new URL(req.url, s.origin), { headers: req.headers }), { RECOOLER_SECRET: 'k' });
      res.statusCode = response.status; res.setHeader('Content-Type', 'text/html');
      for await (const chunk of response.body) res.write(chunk);
      res.end();
    } catch (e) { res.statusCode = 500; res.end(String(e.stack)); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  s.origin = `http://127.0.0.1:${server.address().port}`;
  s.close = () => new Promise(r => server.close(r));
  s.count = p => s.requests.filter(r => r.split('?')[0].endsWith(' ' + p)).length;
  s.gate = (match = '') => { s.blockMatch = match; s.block = new Promise(r => { s.release = () => { s.block = undefined; r(); }; }); };
  return s;
}

const browser = await chromium.launch({ headless: true });
async function page(s, pathname, opts = {}) {
  const p = await browser.newPage();
  p.errors = []; p.logs = [];
  p.on('pageerror', e => p.errors.push(e.message));
  p.on('console', m => p.logs.push(m.type() + ': ' + m.text()));
  await p.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => { globalThis.dclAt = performance.now(); });
  });
  const nav = p.goto(s.origin + pathname, { waitUntil: opts.waitUntil ?? 'load' });
  if (opts.waitUntil !== 'commit') await nav; else await nav;
  return p;
}
const results = {};
const want = name => !only.length || only.includes(name);

try {
  // ---------------------------------------------------------------------------
  // 1. Consumer renderer: resolvedScriptMiddleware forEach(htmx.process).
  if (want('consumer-suspense')) {
    const built = await build('consumer', {
      'src/root.tsx': `import { dangerouslyPreventEscaping } from 'easy-jsx-html-engine';
import { renderHeadElements } from '@insights-gaming/recooler/jsx';
export default (Content, clientScript) => async props => {
  const content = await <Content {...props}/>;
  return <html><head><meta charset="utf-8"/><script src="/htmx.js"></script>{renderHeadElements(props.head)}</head>
    <body hx-boost="true">{content}{clientScript ? <script>{dangerouslyPreventEscaping('(()=>{' + clientScript + '})()')}</script> : null}</body></html>;
};`,
      'src/entry.ts': `import { createApp } from '@insights-gaming/recooler/router';
import { jsxPages } from '@insights-gaming/recooler/jsx';
import { htmx } from '@insights-gaming/recooler/htmx';
import { CreateResolvedTemplate } from 'easy-jsx-html-engine';
import { table, clients, clientEntry, clientPreloads, clientModules, namespace } from 'virtual:recooler/htmx';
import { manifest } from './routes.gen';
export default createApp(manifest, { pages: jsxPages({
  ResolvedTemplate: CreateResolvedTemplate({ resolvedScriptMiddleware: script => script + '.forEach(htmx.process)' }),
}), extensions: [htmx({ table, clients, clientEntry, clientPreloads, clientModules, legacyClientScript: true, namespace, secret: () => 'k' })] });`,
      'src/routes/index.tsx': `import { Suspense } from '@insights-gaming/recooler/jsx'; ${inc}
const Slow = async ({ ms, children }) => { await new Promise(r => setTimeout(r, ms)); return children; };
export const onLoad = () => { inc('loads'); globalThis.onLoadDOM = { late: !!document.querySelector('#late'), state: document.readyState }; };
export default props => <>
  <p id="top">top</p>
  <Suspense rid={props.rid} fallback={<p>wait1</p>}><Slow ms={200}>
    <div id="susload" hx-get="/m/susload" hx-trigger="load" hx-swap="none" hx-on--confirm={e => { e.preventDefault(); inc('susConfirms'); }}>x</div>
    <div id="suscfg" hx-get="/m/suscfg" hx-trigger="load" hx-swap="none" hx-on--config-request={e => { e.detail.parameters.cfg = '1'; inc('susCfgs'); }}>y</div>
    <button id="susbtn" hx-on:click={() => inc('susClicks')}>sus</button>
    <button id="suspost" hx-post="/m/suspost" hx-swap="none" hx-on--confirm={e => { e.preventDefault(); inc('susPostConfirms'); }}>post</button>
  </Slow></Suspense>
  <Suspense rid={props.rid} fallback={<p>wait2</p>}><Slow ms={2000}><p id="late">late</p></Slow></Suspense>
</>;`,
    });
    const s = await serve(built); s.assetDelay = 450;
    const p = await browser.newPage(); p.errors = []; p.on('pageerror', e => p.errors.push(e.message));
    await p.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { globalThis.dcl = true; }));
    const nav = p.goto(s.origin + '/'); nav.catch(() => {});
    await p.waitForSelector('#susbtn', { timeout: 5000 });
    await sleep(100);
    const beforeDCL = await p.evaluate(() => ({ dcl: !!globalThis.dcl, rc: typeof globalThis.$rc, htmxProcessed: !!document.querySelector('#susbtn')['htmx-internal-data'] }));
    assert.equal(s.count('/m/susload'), 0, 'confirm is blocked before the async module arrives');
    await p.waitForFunction(() => Object.keys(globalThis.$handlers ?? {}).length > 0);
    assert.equal(await p.evaluate(() => globalThis.loads ?? 0), 0, 'onLoad waits for the complete stream');
    await p.click('#susbtn'); await p.click('#suspost'); await sleep(100);
    const duringStream = await p.evaluate(() => ({ susClicks: globalThis.susClicks ?? 0, susConfirms: globalThis.susConfirms ?? 0, susCfgs: globalThis.susCfgs ?? 0, susPostConfirms: globalThis.susPostConfirms ?? 0 }));
    const reqDuring = [...s.requests];
    await nav; await p.waitForFunction(() => globalThis.loads === 1); await sleep(200);
    await p.click('#susbtn'); await p.click('#suspost'); await sleep(150);
    results['consumer-suspense'] = { beforeDCL, duringStream, requestsDuringStream: reqDuring,
      after: await p.evaluate(() => ({ susClicks: globalThis.susClicks ?? 0, susConfirms: globalThis.susConfirms ?? 0, susCfgs: globalThis.susCfgs ?? 0, susPostConfirms: globalThis.susPostConfirms ?? 0, loads: globalThis.loads, onLoadDOM: globalThis.onLoadDOM })),
      susloadRequests: s.count('/m/susload'), suscfgRequests: s.requests.filter(r => r.includes('/m/suscfg')), suspostRequests: s.count('/m/suspost'), errors: p.errors };
    await p.close(); await s.close();
  }

  // ---------------------------------------------------------------------------
  // 2. htmx placement variants: request gating and body hx-on::load at startup.
  if (want('placement')) {
    const variants = { 'head-sync': ['<script src="/htmx.js"></script>', ''], 'head-defer': ['<script defer src="/htmx.js"></script>', ''],
      'head-async': ['<script async src="/htmx.js"></script>', ''], 'body-end': ['', '<script src="/htmx.js"></script>'],
      'body-start-inline-before-content': ['', ''], ...(major === '2' ? { 'head-module': ['<script type="module">import htmx from "/htmx.esm.js"; window.htmx = htmx;</script>', ''] } : {}) };
    results.placement = {};
    for (const [variant, [head, tail]] of Object.entries(variants)) {
      const start = variant === 'body-start-inline-before-content' ? '<script src="/htmx.js"></script>' : '';
      const built = await build('placement-' + variant, {
        'src/root.tsx': `import { dangerouslyPreventEscaping } from 'easy-jsx-html-engine'; ${inc}
export default (Content, clientScript) => props => <html><head>{dangerouslyPreventEscaping(${JSON.stringify(head)})}</head>
  <body hx-boost="true" hx-on--load={() => inc('bodyLoads')}>{dangerouslyPreventEscaping(${JSON.stringify(start)})}<Content {...props}/>
  {clientScript ? <script>{dangerouslyPreventEscaping('(()=>{' + clientScript + '})()')}</script> : null}{dangerouslyPreventEscaping(${JSON.stringify(tail)})}</body></html>;`,
        'src/routes/index.tsx': `${inc}
export const onLoad = () => { inc('loads'); globalThis.htmxAtOnLoad = typeof htmx; };
export default () => <>
  <div id="pl" hx-get="/m/pl" hx-trigger="load" hx-swap="none" hx-on--confirm={e => { e.preventDefault(); inc('plConfirms'); }}>pl</div>
  <div id="pc" hx-get="/m/pc" hx-trigger="load" hx-swap="none" hx-on--config-request={e => { e.detail.parameters.cfg = '1'; inc('pcCfgs'); }}>pc</div>
  <button id="pb" hx-on:click={() => inc('pbClicks')}>pb</button>
</>;`,
      });
      const s = await serve(built);
      const p = await page(s, '/'); await sleep(400);
      await p.click('#pb'); await sleep(50);
      results.placement[variant] = { ...(await p.evaluate(() => ({ loads: globalThis.loads, plConfirms: globalThis.plConfirms ?? 0, pcCfgs: globalThis.pcCfgs ?? 0, bodyLoads: globalThis.bodyLoads ?? 0, pbClicks: globalThis.pbClicks ?? 0, htmx: typeof htmx }))),
        plRequests: s.count('/m/pl'), pcRequests: s.requests.filter(r => r.includes('/m/pc')), errors: p.errors };
      await p.close(); await s.close();
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Async route onLoad on initial load (0.0.27 called onLoad() without awaiting).
  if (want('async-onload')) {
    const built = await build('asyncload', {
      'src/routes/index.tsx': `${inc}
export const head = { scripts: [{ src: '/htmx.js' }] };
export const onLoad = async () => { inc('started'); if (location.hash === '#never') await new Promise(() => {}); if (location.hash === '#reject') throw new Error('onLoad rejected'); await new Promise(r => setTimeout(r, 1500)); inc('done'); };
export default () => <>
  <button id="ab" hx-on:click={() => inc('abClicks')}>ab</button>
  <a id="al" href="/m/al" hx-boost="false" hx-on:click={e => { e.preventDefault(); inc('alClicks'); }}>al</a>
</>;`,
    }, { htmx: {} });
    const s = await serve(built);
    const p = await page(s, '/'); await sleep(200);
    await p.click('#ab');
    const mid = await p.evaluate(() => ({ started: globalThis.started, done: globalThis.done ?? 0, abClicks: globalThis.abClicks ?? 0 }));
    await p.click('#al', { noWaitAfter: true }); await sleep(300);
    const navigated = p.url();
    results['async-onload'] = { mid, afterGuardedLinkClick: { url: navigated, alRequests: s.count('/m/al') }, errors: p.errors };
    await p.close();
    const never = await page(s, '/#never');
    await never.evaluate(() => globalThis.__recooler_ready);
    await never.click('#ab');
    assert.equal(await never.evaluate(() => globalThis.abClicks), 1, 'a never-resolving onLoad does not disable handlers or readiness');
    await never.close();
    const rejected = await page(s, '/#reject');
    await rejected.click('#ab');
    assert.equal(await rejected.evaluate(() => globalThis.abClicks), 1);
    assert.deepEqual(rejected.errors, ['onLoad rejected'], 'onLoad rejection reaches reportError');
    await rejected.close(); await s.close();
  }

  // ---------------------------------------------------------------------------
  // 4. Swap window after boost: non-boosted preventDefault guards, measured window.
  if (want('swap-window')) {
    const built = await build('swapwin', {
      'src/routes/index.tsx': `${inc}
export const head = { scripts: [{ src: '/htmx.js' }] };
export const onLoad = () => inc('loadsA');
export default () => <><a id="tog" href="/g" hx-boost="true">g</a><button id="aa" hx-on:click={() => inc('aClicks')}>a</button>
  <a id="bl" href="/m/bl" hx-boost="true" hx-swap="none" hx-on:click={e => { e.preventDefault(); inc('blClicks'); }}>boosted link with preventDefault</a></>;`,
      'src/routes/g/index.tsx': `${inc}
export const onLoad = () => inc('loadsG');
export default () => <>
  <a id="gl" href="/m/gl" hx-boost="false" hx-on:click={e => { e.preventDefault(); inc('glClicks'); }}>guarded link</a>
  <form id="gf" method="post" action="/m/gf" hx-boost="false" hx-on:submit={e => { e.preventDefault(); inc('gfSubmits'); }}><button id="gfb">delete</button></form>
  <button id="gb" hx-on:click={() => inc('gClicks')}>g</button>
</>;`,
    }, { htmx: {} });
    const s = await serve(built);
    // (a) htmx and preventDefault on a boosted link once handlers are loaded.
    let p = await page(s, '/'); await sleep(100);
    await p.click('#bl'); await sleep(200);
    results['swap-window'] = { boostedLinkPrevented: { blClicks: await p.evaluate(() => globalThis.blClicks), requests: s.count('/m/bl') } };
    await p.close();
    // (b) delayed slices: guarded native link during the window.
    p = await page(s, '/'); s.gate('recooler-');
    await p.click('#tog'); await p.waitForSelector('#gl'); await sleep(50);
    await p.click('#gl', { noWaitAfter: true }); await sleep(300);
    results['swap-window'].guardedLinkDuringWindow = { url: new URL(p.url()).pathname, glRequests: s.count('/m/gl'), logs: p.logs.filter(l => l.includes('@insights-gaming/recooler')) };
    s.release(); await p.close();
    // (c) delayed slices: guarded native form.
    p = await page(s, '/'); s.gate('recooler-');
    await p.click('#tog'); await p.waitForSelector('#gfb'); await sleep(50);
    await p.click('#gfb', { noWaitAfter: true }); await sleep(300);
    results['swap-window'].guardedFormDuringWindow = { url: new URL(p.url()).pathname, gfRequests: s.count('/m/gf') };
    s.release(); await p.close();
    // (d) unblocked localhost: how long until a destination handler is usable?
    const samples = [];
    for (let i = 0; i < 5; i++) {
      p = await page(s, '/');
      const t = await p.evaluate(async () => {
        const t0 = performance.now(); let swapped;
        document.addEventListener('htmx:afterSwap', () => { swapped = performance.now(); }, { once: true });
        document.querySelector('#tog').click();
        while (!document.querySelector('#gb')) await new Promise(r => setTimeout(r, 0));
        const seen = performance.now();
        document.querySelector('#gb').click(); const immediate = globalThis.gClicks ?? 0;
        while (!globalThis.gClicks) { await new Promise(r => setTimeout(r, 1)); document.querySelector('#gb')?.click(); if (performance.now() - seen > 3000) break; }
        return { swapToUsableMs: Math.round(performance.now() - swapped), immediateClickHandled: immediate };
      });
      samples.push(t); await p.close();
    }
    results['swap-window'].unblockedFirstVisit = samples;
    await s.close();
  }

  // ---------------------------------------------------------------------------
  // 5. Table-row fragment from a root that returns bare Content for htmx requests.
  if (want('rows')) {
    const built = await build('rows', {
      'src/root.tsx': `export default Content => props => props.ctx.req.header('hx-request') === 'true' ? <Content {...props}/>
  : <html><head><script src="/htmx.js"></script></head><body><Content {...props}/>{props.scripts.map(src => <script type="module" src={src}/>)}</body></html>;`,
      'src/routes/index.tsx': `export default () => <><table><tbody id="tb"></tbody></table><button id="more" hx-get="/rows" hx-target="#tb" hx-swap="beforeend">more</button></>;`,
      'src/routes/rows/index.tsx': `export default () => <><tr class="r"><td>1</td></tr><tr class="r"><td>2</td></tr></>;`,
    }, { htmx: {} });
    const s = await serve(built);
    const raw = await (await fetch(s.origin + '/rows', { headers: { 'HX-Request': 'true' } })).text();
    const p = await page(s, '/'); await p.click('#more'); await sleep(300);
    results.rows = { response: raw.slice(0, 200), rowsInserted: await p.locator('#tb tr.r').count(), tbody: await p.evaluate(() => document.querySelector('#tb').innerHTML.slice(0, 200)) };
    await p.close(); await s.close();
  }

  // ---------------------------------------------------------------------------
  // 6. Same-route body reswaps with static scripts in the swapped body.
  if (want('reswap')) {
    const built = await build('reswap', {
      'src/root.tsx': `import { dangerouslyPreventEscaping } from 'easy-jsx-html-engine';
export default (Content, clientScript) => props => <html><head><script src="/htmx.js"></script></head><body hx-boost="true"><Content {...props}/><script>{dangerouslyPreventEscaping(clientScript ?? '')}</script></body></html>;`,
      'src/routes/index.tsx': `${inc}
export const onLoad = () => inc('loadsA');
export default () => <><a id="self" href="/">self</a><a id="tob" href="/b">b</a><button id="ac" hx-on:click={() => inc('aClicks')}>a</button></>;`,
      'src/routes/b/index.tsx': `${inc}
export const onLoad = () => inc('loadsB');
export default () => <><a id="toa" href="/">a</a><button id="bc" hx-on:click={() => inc('bClicks')}>b</button></>;`,
    });
    const s = await serve(built);
    const p = await page(s, '/'); await p.waitForFunction(() => globalThis.loadsA === 1);
    const log = [];
    for (const [link, check] of [['#self', 'ac'], ['#self', 'ac'], ['#tob', 'bc'], ['#toa', 'ac'], ['#tob', 'bc']]) {
      await p.click(link); await sleep(250); await p.click('#' + check); await sleep(30);
      log.push(await p.evaluate(() => [globalThis.loadsA, globalThis.loadsB ?? 0, globalThis.aClicks ?? 0, globalThis.bClicks ?? 0, document.querySelectorAll('[data-recooler-marker]').length].join(',')));
    }
    results.reswap = { log, moduleScriptsInBody: await p.evaluate(() => document.querySelectorAll('body script[type=module]').length), errors: p.errors };
    await p.close(); await s.close();
  }

  // ---------------------------------------------------------------------------
  // 7. Body-level lifecycle handlers (consumer: body/layout hx-on) across boosts.
  if (want('body')) {
    for (const onLoadB of [false, true]) {
      const built = await build('body' + (onLoadB ? '-onload' : ''), {
        'src/root.tsx': `import { dangerouslyPreventEscaping } from 'easy-jsx-html-engine'; ${inc}
export default (Content, clientScript) => props => <html><head><script src="/htmx.js"></script></head><body hx-boost="true"
  hx-on--before-swap={() => inc('beforeSwaps')} hx-on--after-swap={() => inc('afterSwaps')}
  hx-on--after-settle={() => inc('afterSettles')} hx-on--load={() => inc('bodyLoads')}
  hx-on--config-request={e => { e.detail.headers['X-Token'] = 't'; inc('configs'); }}><Content {...props}/><script>{dangerouslyPreventEscaping(clientScript ?? '')}</script></body></html>;`,
        'src/routes/index.tsx': `${inc}
export const onLoad = () => inc('loadsA');
export default () => <><a id="tob" href="/b">b</a><a id="self" href="/">self</a><button id="ac" hx-on:click={() => inc('aClicks')}>a</button></>;`,
        'src/routes/b/index.tsx': `${inc}
${onLoadB ? "export const onLoad = () => inc('loadsB');" : ''}
export default () => <><a id="toa" href="/">a</a><button id="bc" hx-on:click={() => inc('bClicks')}>b</button></>;`,
      });
      const s = await serve(built);
      s.tokenRequests = [];
      const p = await page(s, '/'); await p.waitForFunction(() => globalThis.loadsA === 1); await sleep(100);
      await p.route('**/*', async route => { if (route.request().headers()['hx-request']) s.tokenRequests.push(route.request().url().replace(s.origin, '') + ' token=' + (route.request().headers()['x-token'] ?? '-')); await route.continue(); });
      const snap = () => p.evaluate(() => ['beforeSwaps', 'afterSwaps', 'afterSettles', 'bodyLoads', 'configs'].map(k => k + '=' + (globalThis[k] ?? 0)).join(' '));
      const log = { initial: await snap() };
      for (const [label, link] of [['A->B first', '#tob'], ['B->A revisit', '#toa'], ['A->B revisit', '#tob'], ['B->A', '#toa'], ['A->A self', '#self']]) {
        await p.click(link); await sleep(400); log[label] = await snap();
      }
      results['body' + (onLoadB ? '-onloadB' : '')] = { log, tokenRequests: s.tokenRequests, errors: p.errors };
      await p.close(); await s.close();
    }
  }

  // ---------------------------------------------------------------------------
  // 8. Consumer htmx.process renderer with a modern root (no legacy inline import).
  if (want('consumer-modern')) {
    const built = await build('consumer-modern', {
      'src/entry.ts': `import { createApp } from '@insights-gaming/recooler/router';
import { jsxPages } from '@insights-gaming/recooler/jsx';
import { htmx } from '@insights-gaming/recooler/htmx';
import { CreateResolvedTemplate } from 'easy-jsx-html-engine';
import { table, clients, clientEntry, clientPreloads, clientModules, namespace } from 'virtual:recooler/htmx';
import { manifest } from './routes.gen';
export default createApp(manifest, { pages: jsxPages({
  ResolvedTemplate: CreateResolvedTemplate({ resolvedScriptMiddleware: script => script + '.forEach(htmx.process)' }),
}), extensions: [htmx({ table, clients, clientEntry, clientPreloads, clientModules, namespace, secret: () => 'k' })] });`,
      'src/routes/index.tsx': `import { Suspense } from '@insights-gaming/recooler/jsx'; ${inc}
export const head = { scripts: [{ src: '/htmx.js' }] };
const Slow = async ({ ms, children }) => { await new Promise(r => setTimeout(r, ms)); return children; };
export const onLoad = () => { inc('loads'); globalThis.onLoadDOM = { late: !!document.querySelector('#late'), state: document.readyState }; };
export default props => <>
  <Suspense rid={props.rid} fallback={<p>wait1</p>}><Slow ms={200}>
    <div id="susload" hx-get="/m/susload" hx-trigger="load" hx-swap="none" hx-on--confirm={e => { e.preventDefault(); inc('susConfirms'); }}>x</div>
    <button id="susbtn" hx-on:click={() => inc('susClicks')}>sus</button>
  </Slow></Suspense>
  <Suspense rid={props.rid} fallback={<p>wait2</p>}><Slow ms={1500}><p id="late">late</p></Slow></Suspense>
</>;`,
    }, { htmx: {} });
    const s = await serve(built); s.assetDelay = 450;
    const p = await browser.newPage(); p.errors = []; p.on('pageerror', e => p.errors.push(e.message));
    const nav = p.goto(s.origin + '/'); nav.catch(() => {});
    await p.waitForSelector('#susbtn'); await sleep(100);
    const beforeDCL = await p.evaluate(() => ({ rc: typeof globalThis.$rc, loads: globalThis.loads ?? 0 }));
    assert.equal(s.count('/m/susload'), 0, 'modern root gate precedes route modules');
    await p.waitForFunction(() => Object.keys(globalThis.$handlers ?? {}).length > 0);
    await p.click('#susbtn');
    assert.equal(await p.evaluate(() => globalThis.susClicks), 1);
    assert.equal(await p.evaluate(() => globalThis.loads ?? 0), 0);
    await nav; await p.waitForFunction(() => globalThis.loads === 1); await sleep(200);
    results['consumer-modern'] = { beforeDCL, susConfirms: await p.evaluate(() => globalThis.susConfirms ?? 0), susloadRequests: s.count('/m/susload'), errors: p.errors };
    await p.close(); await s.close();
  }
  // ---------------------------------------------------------------------------
  // 10. Body lifecycle handlers on first visit with 300ms asset latency (0.0.27: all run).
  if (want('body-latency')) {
    const built = await build('bodylat', {
      'src/root.tsx': `import { dangerouslyPreventEscaping } from 'easy-jsx-html-engine'; ${inc}
export default (Content, clientScript) => props => <html><head><script src="/htmx.js"></script></head><body hx-boost="true"
  hx-on--after-swap={() => inc('afterSwaps')} hx-on--after-settle={() => inc('afterSettles')} hx-on--load={() => inc('bodyLoads')}><Content {...props}/><script>{dangerouslyPreventEscaping(clientScript ?? '')}</script></body></html>;`,
      'src/routes/index.tsx': `${inc}
export default () => <><a id="tob" href="/b">b</a><button id="ac" hx-on:click={() => inc('aClicks')}>a</button></>;`,
      'src/routes/b/index.tsx': `${inc}
export default () => <><a id="toa" href="/">a</a><button id="bc" hx-on:click={() => inc('bClicks')}>b</button></>;`,
    });
    const s = await serve(built);
    const p = await page(s, '/'); await sleep(150);
    const snap = () => p.evaluate(() => ['afterSwaps', 'afterSettles', 'bodyLoads'].map(k => k + '=' + (globalThis[k] ?? 0)).join(' '));
    const before = await snap();
    s.gate('recooler-'); setTimeout(() => s.release(), 300);
    await p.click('#tob'); await sleep(700);
    results['body-latency'] = { before, afterFirstVisitAtoB: await snap(), errors: p.errors };
    await p.close(); await s.close();
  }

  // 11. Persistent slice failure: does every handler event start a new import attempt?
  if (want('retry-storm')) {
    const built = await build('storm', {
      'src/routes/index.tsx': `${inc}
export const head = { scripts: [{ src: '/htmx.js' }] };
export default () => <><a id="tob" href="/b" hx-boost="true">b</a></>;`,
      'src/routes/b/index.tsx': `${inc}
export default () => <input id="k" hx-on:keydown={() => inc('keys')}/>;`,
    }, { htmx: {} });
    const s = await serve(built);
    const p = await page(s, '/'); s.fail = true;
    await p.click('#tob'); await p.waitForSelector('#k'); await sleep(1500);
    const url = p.url(); await p.waitForSelector('#k').catch(() => {}); await sleep(500);
    const start = s.assets.filter(a => a.includes('recooler-slice')).length;
    await p.click('#k').catch(() => {}); for (let i = 0; i < 20; i++) await p.keyboard.press('a');
    await sleep(500);
    results['retry-storm'] = { url, sliceRequestsBefore: start, sliceRequestsAfter20Keys: s.assets.filter(a => a.includes('recooler-slice')).length,
      reloads: s.requests.filter(r => r.startsWith('GET /b')).length, errorsLogged: p.logs.filter(l => l.startsWith('error')).length };
    await p.close(); await s.close();
  }

  // ---------------------------------------------------------------------------
  // 9. Documented "config/before-request run late" during a swap window.
  if (want('late-config')) {
    const built = await build('lateconfig', {
      'src/routes/index.tsx': `${inc}
export const head = { scripts: [{ src: '/htmx.js' }] };
export const onLoad = () => inc('loadsA');
export default () => <><a id="tob" href="/b" hx-boost="true">b</a></>;`,
      'src/routes/b/index.tsx': `${inc}
export const onLoad = () => inc('loadsB');
export default () => <>
  <button id="cfg" hx-post="/m/cfg" hx-swap="none" hx-on--config-request={e => { e.detail.parameters.x = '1'; inc('configs'); globalThis.cfgType = e.type; }}>cfg</button>
  <button id="br" hx-post="/m/br" hx-swap="none" hx-on--before-request={e => { inc('befores'); globalThis.brType = e.type; }}>br</button>
</>;`,
    }, { htmx: {} });
    const s = await serve(built);
    const p = await page(s, '/'); s.gate('recooler-');
    await p.click('#tob'); await p.waitForSelector('#cfg'); await sleep(50);
    await p.click('#cfg'); await p.click('#br'); await sleep(100);
    s.release(); await p.waitForFunction(() => globalThis.loadsB === 1); await sleep(300);
    const window = await p.evaluate(() => ({ configs: globalThis.configs ?? 0, befores: globalThis.befores ?? 0 }));
    await p.click('#cfg'); await p.click('#br'); await sleep(150);
    results['late-config'] = { duringWindowThenReady: window, afterReady: await p.evaluate(() => ({ configs: globalThis.configs ?? 0, befores: globalThis.befores ?? 0, cfgType: globalThis.cfgType, brType: globalThis.brType })),
      bodies: s.bodies, cfgRequests: s.count('/m/cfg'), brRequests: s.count('/m/br') };
    await p.close(); await s.close();
  }
} finally { await browser.close(); await rm(workspace, { recursive: true, force: true }); }
// Assert every supplied attack, including production's deliberately uncancelled
// native swap window, and lifecycle callbacks the earlier suite only counted.
for (const [name, result] of Object.entries(results)) {
  if (result.errors) assert.deepEqual(result.errors, [], name);
  if (name === 'consumer-suspense') {
    assert.equal(result.beforeDCL.dcl, false);
    assert.equal(result.beforeDCL.rc, 'undefined');
    assert.equal(result.duringStream.susClicks, 1);
    assert.equal(result.duringStream.susPostConfirms, 1);
    assert.equal(result.after.susClicks, 2);
    assert.equal(result.after.susConfirms, 1);
    assert.equal(result.after.susCfgs, 0);
    assert.equal(result.after.loads, 1);
    assert.equal(result.after.onLoadDOM.late, true);
    assert.notEqual(result.after.onLoadDOM.state, 'loading');
    assert.equal(result.susloadRequests, 0);
    assert.equal(result.suspostRequests, 0);
    assert.equal(result.suscfgRequests.length, 1);
  } else if (name === 'consumer-modern') {
    assert.equal(result.beforeDCL.rc, 'undefined');
    assert.equal(result.beforeDCL.loads, 0);
    assert.equal(result.susConfirms, 1);
    assert.equal(result.susloadRequests, 0);
  } else if (name === 'placement') {
    for (const [variant, value] of Object.entries(result)) {
      assert.equal(value.loads, 1, variant);
      assert.equal(value.pbClicks, 1, variant);
      assert.equal(value.htmx, 'object', variant);
      assert.equal(value.plRequests, 0, variant);
      assert.equal(value.pcRequests.length, 1, variant);
      assert.deepEqual(value.errors, [], variant);
    }
  } else if (name === 'async-onload') {
    assert.deepEqual(result.mid, { started: 1, done: 0, abClicks: 1 });
    assert.equal(result.afterGuardedLinkClick.alRequests, 0);
  } else if (name === 'swap-window') {
    assert.deepEqual(result.boostedLinkPrevented, { blClicks: 1, requests: 1 });
    assert.equal(result.guardedLinkDuringWindow.glRequests, 1);
    assert.equal(result.guardedFormDuringWindow.gfRequests, 1);
    assert(result.unblockedFirstVisit.every(sample => sample.swapToUsableMs < 3000));
  } else if (name === 'rows') {
    assert.equal(result.rowsInserted, 2);
    assert(!result.response.includes('data-recooler-marker'));
    assert(!result.tbody.includes('span'));
  } else if (name === 'reswap') {
    assert.deepEqual(result.log.map(s => s.split(',').slice(0, 4).join(',')), ['2,0,1,0', '3,0,2,0', '3,1,2,1', '4,1,3,1', '4,2,3,2']);
    assert(result.log.every(s => s.endsWith(',1')));
  } else if (name === 'body' || name === 'body-onloadB') {
    let i = 0;
    for (const [step, counters] of Object.entries(result.log)) {
      const counts = Object.fromEntries(counters.split(' ').map(s => s.split('=').map((v, i) => i ? Number(v) : v)));
      assert.equal(counts.beforeSwaps, i, step);
      assert.equal(counts.afterSwaps, i, step);
      assert.equal(counts.afterSettles, i, step);
      assert.equal(counts.configs, i, step);
      assert(counts.bodyLoads > 0, step);
      i++;
    }
    assert.equal(result.tokenRequests.length, 5);
    assert(result.tokenRequests.every(s => s.endsWith('token=t')));
  } else if (name === 'body-latency') {
    assert.match(result.afterFirstVisitAtoB, /afterSwaps=1 afterSettles=1 bodyLoads=[1-9]/);
  } else if (name === 'retry-storm') {
    assert.equal(result.sliceRequestsAfter20Keys, result.sliceRequestsBefore);
    assert(result.reloads <= 2);
  } else if (name === 'late-config') {
    assert.deepEqual(result.duringWindowThenReady, { configs: 0, befores: 0 });
    assert.deepEqual(result.afterReady, { configs: 1, befores: 1, cfgType: 'htmx:config-request', brType: 'htmx:before-request' });
    assert.equal(result.cfgRequests, 2);
    assert.equal(result.brRequests, 2);
  } else assert.fail('Unasserted scenario: ' + name);
}
console.log(JSON.stringify({ clientStreaming: true, major, legacy, ...results }, null, 1));
