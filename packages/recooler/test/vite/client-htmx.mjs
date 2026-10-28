import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBuilder } from 'vite';
import { JSDOM } from 'jsdom';
import vm from 'node:vm';
import { recooler } from '../../dist/vite/index.js';
const packageDir = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(path.join(packageDir, '.cache'), { recursive: true });
const root = await mkdtemp(path.join(packageDir, '.cache/client-htmx-'));
const write = async (name, code) => { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), code); };
const until = async (fn, label) => {
  const deadline = Date.now() + 10000;
  while (!fn()) { assert(Date.now() < deadline, label); await new Promise(resolve => setTimeout(resolve, 10)); }
};
let server;
const windows = [];
// jsdom supplies real DOM/XPath/XHR and executes htmx's inserted scripts. Its
// vm.Script calls omit Node's dynamic-import hook; supply native ESM loading
// here so the unmodified legacy import(url).then(m => m.init()) really executes.
const originalRun = vm.runInContext;
const contexts = new WeakMap();
async function load(url, context) {
  let cache = contexts.get(context);
  if (!cache) contexts.set(context, cache = new Map());
  if (!cache.has(url)) cache.set(url, (async () => {
    const module = new vm.SourceTextModule(await (await fetch(url)).text(), { context, identifier: url,
      initializeImportMeta(meta) { meta.url = url; },
      importModuleDynamically: async (specifier, parent) => {
        const dependency = await load(new URL(specifier, parent.identifier).href, context);
        if (dependency.status === 'linked') await dependency.evaluate();
        return dependency;
      },
    });
    await module.link((specifier, parent) => load(new URL(specifier, parent.identifier).href, context));
    return module;
  })());
  return cache.get(url);
}
vm.runInContext = (code, context, options) => new vm.Script(code, { ...options,
  importModuleDynamically: async specifier => {
    const module = await load(new URL(specifier, options.filename).href, context);
    if (module.status === 'linked') await module.evaluate();
    return module;
  },
}).runInContext(context);
let release, gate, requests = [];
try {
  await write('package.json', '{"type":"module"}');
  await mkdir(path.join(root, 'node_modules')); await symlink(packageDir, path.join(root, 'node_modules/recooler'), 'dir');
  await write('src/entry.ts', `export { default } from 'virtual:recooler/app';`);
  await write('src/root.tsx', `import { dangerouslyPreventEscaping } from 'easy-jsx-html-engine';
    export default (Content, clientScript) => props => <html><head><script src="/htmx.js"/></head><body hx-boost="true"><Content {...props}/><script>{dangerouslyPreventEscaping(clientScript ?? '')}</script></body></html>;`);
  await write('src/routes/index.tsx', `export const onLoad = () => { globalThis.loads = (globalThis.loads ?? 0) + 1; };
    export default () => <>
      <button id="confirm" hx-post="/destroy" hx-swap="none" hx-on--confirm={function(event) {
        globalThis.confirms = (globalThis.confirms ?? 0) + 1; event.preventDefault();
        if (confirm('destroy?')) event.detail.issueRequest(true);
      }}>destroy</button>
      <button id="continue" hx-post="/continue" hx-swap="none" hx-on--confirm={() => { globalThis.continued = true; }}>continue</button>
      <form id="form" hx-boost="false" action="/submitted" method="post" hx-on:submit={function(event) { globalThis.submits = (globalThis.submits ?? 0) + 1; globalThis.submitter = event.submitter.id; }}><button id="submit">submit</button></form>
      <div hx-on:click={() => { globalThis.parents = (globalThis.parents ?? 0) + 1; }}><a id="link" href="#clicked" hx-boost="false" hx-on:click={() => { globalThis.links = (globalThis.links ?? 0) + 1; }}>link</a></div>
      <a id="boost" href="/b">B</a>
      <button id="throw" hx-on:click={() => { throw new Error('replay boom'); }}>throw</button>
      <button id="after" hx-on:click={function() { this.textContent = 'loaded:' + globalThis.loads; }}>after</button>
    </>;`);
  await write('src/routes/b/index.tsx', `export const onLoad = () => { globalThis.bLoads = (globalThis.bLoads ?? 0) + 1; };
    export default () => <><button id="b" hx-on:click={function() { this.textContent = 'B handler'; }}>B</button><a id="back" href="/">A</a></>;`);
  await write('src/routes/load/index.tsx', `export const onLoad = () => { globalThis.loadReady = true; };
    export default () => <>
      <div hx-get="/load-confirm" hx-trigger="load" hx-swap="none" hx-on--confirm={function(event) { event.preventDefault(); if (confirm('load?')) event.detail.issueRequest(true); }}/>
      <div hx-get="/load-config" hx-trigger="load" hx-swap="none" hx-on--config-request={() => { globalThis.configCalls = (globalThis.configCalls ?? 0) + 1; }}/>
      <div hx-get="/load-before" hx-trigger="load" hx-swap="none" hx-on--before-request={() => { globalThis.beforeCalls = (globalThis.beforeCalls ?? 0) + 1; }}/>
    </>;`);
  const builder = await createBuilder({ root, configFile: false, logLevel: 'silent', plugins: recooler({ htmx: { legacyClientScript: true } }),
    environments: { client: { build: { minify: false } } }, ssr: { noExternal: true }, build: { ssr: 'src/entry.ts', outDir: 'server', minify: false, rolldownOptions: { output: { entryFileNames: 'app.mjs' } } } });
  await builder.buildApp();
  let app = (await import(pathToFileURL(path.join(root, 'server/app.mjs')))).default;
  const htmx = await readFile(fileURLToPath(import.meta.resolve('htmx.org/dist/htmx.js')), 'utf8');
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      if (url.pathname === '/htmx.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(htmx); }
      if (url.pathname.startsWith('/assets/')) {
        if (gate) await gate;
        res.setHeader('Content-Type', 'text/javascript'); return res.end(await readFile(path.join(root, 'dist/client', url.pathname), 'utf8'));
      }
      if (['/destroy', '/continue', '/submitted', '/load-confirm', '/load-config', '/load-before'].includes(url.pathname)) {
        requests.push(url.pathname); res.statusCode = 204; return res.end();
      }
      const response = await app.fetch(new Request(url), { RECOOLER_SECRET: 'htmx-test-key' });
      res.statusCode = response.status; res.setHeader('Content-Type', 'text/html'); res.end(await response.text());
    } catch (error) { res.statusCode = 500; res.end(String(error.stack)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const open = async (block = true, pathname = '/') => {
    requests = [];
    gate = block ? new Promise(resolve => { release = () => { gate = undefined; resolve(); }; }) : undefined;
    const dom = new JSDOM(await (await fetch(origin + pathname)).text(), { url: origin + pathname, runScripts: 'dangerously', resources: 'usable',
      beforeParse(window) {
        // These fixtures use plain identifier ids; jsdom lacks CSS.escape.
        window.CSS = { escape: value => String(value) };
        window.HTMLElement.prototype.scrollIntoView = () => {};
        // jsdom requires the optional XPath result type that browsers default.
        const evaluate = window.XPathExpression.prototype.evaluate;
        window.XPathExpression.prototype.evaluate = function(node, type = 0, result = null) { return evaluate.call(this, node, type, result); };
        window.confirm = () => window.accept === true;
        window.reportError = error => (window.errors ??= []).push(error.message);
      },
    });
    const window = dom.window;
    windows.push(window);
    // jsdom does not execute module script elements. Use the same native ESM
    // loader for that browser primitive; htmx still owns every subsequent swap.
    const moduleScript = window.document.querySelector('script[type="module"][src]');
    if (moduleScript) vm.runInContext('import(' + JSON.stringify(moduleScript.src) + ')', dom.getInternalVMContext(), { filename: origin }).catch(window.reportError);
    window.document.addEventListener('htmx:afterSettle', () => { window.settled = (window.settled ?? 0) + 1; });
    await until(() => window.htmx && window.document.readyState !== 'loading', 'htmx DOMContentLoaded');
    // htmx processes the initial DOM in its ready callback.
    await new Promise(resolve => setTimeout(resolve, 30));
    return window;
  };
  const window = await open();
  window.document.querySelector('#confirm').click();
  window.document.querySelector('#continue').click();
  window.document.querySelector('#throw').click();
  window.document.querySelector('#after').click();
  window.document.querySelector('#link').click();
  const form = window.document.querySelector('#form');
  // Observe native default submission without navigating the test document.
  const submitDefaults = [];
  form.addEventListener('submit', event => { if (!event.defaultPrevented) { submitDefaults.push(event.submitter.id); event.preventDefault(); } });
  form.requestSubmit(window.document.querySelector('#submit'));
  assert.equal(requests.length, 0, 'no destructive request before handlers load');
  assert.equal(window.location.hash, '', 'early anchor default is cancelled');
  assert.deepEqual(submitDefaults, [], 'early submit default is cancelled');
  assert(window.$rq.length >= 6, 'real htmx listeners queued events');
  release();
  await until(() => window.loads && window.document.querySelector('#after').textContent === 'loaded:1' && window.submits === 1, 'queue replay');
  await until(() => requests.includes('/continue'), 'confirm continuation');
  assert.equal(window.confirms, 1); assert(!requests.includes('/destroy'));
  assert.equal(requests.filter(p => p === '/continue').length, 1, 'continuation issues exactly one request');
  assert.deepEqual(window.errors, ['replay boom']);
  assert.equal(window.links, 1); assert.equal(window.parents, 1); assert.equal(window.location.hash, '#clicked');
  assert.equal(window.submitter, 'submit'); assert.deepEqual(submitDefaults, ['submit']);
  window.accept = true;
  window.document.querySelector('#confirm').click();
  await until(() => requests.includes('/destroy'), 'accepted confirm');
  assert.equal(requests.filter(p => p === '/destroy').length, 1);
  const oldBody = window.document.body;
  const settled = window.settled ?? 0;
  window.document.querySelector('#boost').click();
  await until(() => window.bLoads === 1 && window.settled > settled && window.document.querySelector('#b'), 'boosted navigation initializes B');
  assert.equal(window.document.body, oldBody, 'real htmx swaps body content');
  window.document.querySelector('#b').click();
  assert.equal(window.document.querySelector('#b').textContent, 'B handler');
  window.document.querySelector('#back').click();
  await until(() => window.loads === 2 && window.document.querySelector('#after'), 'cached legacy import initializes A again');
  window.document.body.dispatchEvent(new window.CustomEvent('htmx:historyRestore', { bubbles: true }));
  await until(() => window.loads === 3, 'history restore onLoad');
  const loadWindow = await open(true, '/load');
  loadWindow.accept = true;
  assert.equal(requests.length, 0, 'load-triggered confirm/config/before events cannot send before loading');
  assert(loadWindow.$rq.length >= 3);
  release();
  await until(() => requests.length === 3 && loadWindow.loadReady, 'load-triggered continuations');
  for (const endpoint of ['/load-confirm', '/load-config', '/load-before']) assert.equal(requests.filter(p => p === endpoint).length, 1, endpoint);
  assert.equal(loadWindow.configCalls, 1); assert.equal(loadWindow.beforeCalls, 1);
  // Match the real consumer: the confirm listener belongs to the boosted body,
  // while issueRequest belongs to a descendant button's htmx request.
  await write('src/root.tsx', `import { dangerouslyPreventEscaping } from 'easy-jsx-html-engine';
    export default (Content, clientScript) => props => <html><head><script src="/htmx.js"/></head><body hx-boost="true" hx-on--confirm={function(event) {
      event.preventDefault(); globalThis.rootConfirms = (globalThis.rootConfirms ?? 0) + 1;
      if (confirm('body confirm?')) event.detail.issueRequest(true);
    }}><Content {...props}/><script>{dangerouslyPreventEscaping(clientScript ?? '')}</script></body></html>;`);
  const rootBuilder = await createBuilder({ root, configFile: false, logLevel: 'silent', plugins: recooler({ htmx: { legacyClientScript: true } }),
    environments: { client: { build: { minify: false } } }, ssr: { noExternal: true },
    build: { ssr: 'src/entry.ts', outDir: 'server', rolldownOptions: { output: { entryFileNames: 'app.mjs' } } } });
  await rootBuilder.buildApp();
  app = (await import(pathToFileURL(path.join(root, 'server/app.mjs')).href + '?root-confirm')).default;
  const rootWindow = await open();
  rootWindow.accept = true;
  rootWindow.document.querySelector('#continue').click();
  assert.equal(requests.length, 0, 'body confirm blocks the descendant request before loading');
  release();
  await until(() => rootWindow.rootConfirms === 1 && requests.includes('/continue'), 'body confirm replay');
  assert.equal(requests.filter(p => p === '/continue').length, 1, 'body and element listeners share one continuation');
  await rm(path.join(root, 'src/root.tsx'));
  await write('src/routes/index.tsx', `export const head = { scripts: [{ src: '/htmx.js' }] };
    export const onLoad = () => { globalThis.modernA = true; };
    export default () => <a id="modern-boost" href="/b" hx-boost="true">B</a>;`);
  await write('src/routes/b/index.tsx', `export const onLoad = () => { globalThis.modernB = true; };
    export default () => <button id="modern-b" hx-on:click={function() { this.textContent = 'modern B'; }}>B</button>;`);
  const modernBuilder = await createBuilder({ root, configFile: false, logLevel: 'silent', plugins: recooler({ htmx: {} }),
    ssr: { noExternal: true }, build: { ssr: 'src/entry.ts', outDir: 'server', rolldownOptions: { output: { entryFileNames: 'app.mjs' } } } });
  await modernBuilder.buildApp();
  app = (await import(pathToFileURL(path.join(root, 'server/app.mjs')).href + '?modern')).default;
  const modern = await open(false);
  await until(() => modern.modernA, 'modern entry initialization');
  const modernSettle = modern.settled ?? 0;
  modern.document.querySelector('#modern-boost').click();
  await until(() => modern.modernB && modern.settled > modernSettle, 'default root boosted afterSettle initialization');
  assert.equal(modern.document.body.dataset.recoolerRoute, '/', 'htmx leaves the old body attribute unchanged');
  assert.equal(modern.document.querySelector('body meta[name="recooler-route"]').content, '/b');
  modern.document.querySelector('#modern-b').click();
  assert.equal(modern.document.querySelector('#modern-b').textContent, 'modern B');
  console.log(JSON.stringify({ realHtmx: true, boost: true, legacyImport: true, confirm: true, submit: true, link: true, replayErrors: true }));
} catch (error) { console.error('REAL HTMX FAILURE', error); throw error; } finally {
  release?.();
  await new Promise(resolve => setTimeout(resolve, 50));
  for (const window of windows) window.close();
  vm.runInContext = originalRun;
  await new Promise(resolve => server ? server.close(resolve) : resolve());
  await rm(root, { recursive: true, force: true });
}
