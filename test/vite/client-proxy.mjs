// Two real Workers: only the front is reachable; each owns a separate asset set.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createBuilder } from 'vite';
import { JSDOM } from 'jsdom';
import { recooler } from '../../dist/vite/index.js';
const { Miniflare, convertV4MiniflareOptions } = createRequire(import.meta.resolve('@cloudflare/vite-plugin'))('miniflare');
const beta = process.argv[2] === 'beta';
const platform = beta ? new URL('../../spikes/phase1/node_modules/cloudflare-vite-beta/dist/index.mjs', import.meta.url).href : import.meta.resolve('@cloudflare/vite-plugin');
const { cloudflare } = await import(platform);
const packageDir = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(path.join(packageDir, '.cache'), { recursive: true });
const root = await mkdtemp(path.join(packageDir, '.cache/client-proxy-'));
const write = async (name, code) => { const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, code); };
const until = async (fn, label) => { const end = Date.now() + 10000; while (!fn()) { assert(Date.now() < end, label); await new Promise(r => setTimeout(r, 10)); } };
let mf, window;
const originalRun = vm.runInContext;
try {
  await write('package.json', JSON.stringify({ name: 'proxy-admin', type: 'module' }));
  await mkdir(path.join(root, 'node_modules')); await mkdir(path.join(root, 'node_modules/@insights-gaming'), { recursive: true }); await symlink(packageDir, path.join(root, 'node_modules/@insights-gaming/recooler'), 'dir');
  if (beta) await write('cloudflare.config.ts', `export default { worker: { name: 'admin_worker', entrypoint: './src/entry.ts', compatibilityDate: '2026-10-20', compatibilityFlags: ['nodejs_als'] } };`);
  else await write('wrangler.json', JSON.stringify({ name: 'admin_worker', main: 'src/entry.ts', compatibility_date: '2026-10-20', compatibility_flags: ['nodejs_als'] }));
  await write('src/entry.ts', `export { default } from 'virtual:recooler/app';`);
  await write('public/assets/htmx.js', await readFile(fileURLToPath(import.meta.resolve('htmx.org/dist/htmx.js')), 'utf8'));
  await write('front-assets/assets/recooler-client.js', `globalThis.WRONG_FRONT_ENTRY = true;`);
  await write('src/routes/index.tsx', `export const head = { scripts: [{ src: '/_admin/assets/htmx.js' }] };
    export const onLoad = () => { document.body.dataset.adminLoaded = 'yes'; };
    export default () => <><button id="admin" hx-on:click={function() { this.textContent = 'admin handler'; }}/><a id="next" href="/_admin/next" hx-boost="true">next</a></>;`);
  await write('src/routes/next/index.tsx', `export const onLoad = () => { document.body.dataset.nextLoaded = 'yes'; };
    export default () => <button id="next-handler" hx-on:click={function() { this.textContent = 'next admin handler'; }}/>;`);
  for (const legacy of [false, true]) {
    if (legacy) await write('src/root.tsx', `import { dangerouslyPreventEscaping } from 'easy-jsx-html-engine';
      export default (Content, clientScript) => props => <html><head><script src="/_admin/assets/htmx.js"/>{props.preloads.map(href => <link rel="modulepreload" href={href}/>)}</head><body><Content {...props}/><script>{dangerouslyPreventEscaping(clientScript ?? '')}</script></body></html>;`);
    const builder = await createBuilder({ root, configFile: false, logLevel: 'silent', base: '/_admin/',
      plugins: [cloudflare({ ...(beta ? { viteEnvironment: { name: 'admin_worker' }, types: { generate: false } } : { configPath: path.join(root, 'wrangler.json') }), persistState: false, inspectorPort: false }), ...recooler({ serverEnvironment: 'admin_worker', htmx: { legacyClientScript: legacy, base: '/_admin' } })],
      environments: { client: { build: { minify: false } } } });
    await builder.buildApp();
    const serverOut = builder.environments.admin_worker.config.build.outDir;
    const clientOut = builder.environments.client.config.build.outDir;
    const workerFiles = (await readdir(path.resolve(root, serverOut), { recursive: true })).filter(file => file.endsWith('.js')).sort((a, b) => (a === 'index.js' ? -1 : b === 'index.js' ? 1 : a.localeCompare(b)));
    mf = new Miniflare(convertV4MiniflareOptions({ host: '127.0.0.1', port: 0, workers: [
      { name: 'front', modules: true, script: `export default { async fetch(request, env) {
          const url = new URL(request.url);
          if (url.pathname.startsWith('/_admin/')) { url.pathname = url.pathname.slice('/_admin'.length); return env.ADMIN.fetch(new Request(url, request)); }
          return env.FRONT_ASSETS.fetch(request);
        } };`, serviceBindings: { ADMIN: 'admin_worker' },
        assets: { directory: path.join(root, 'front-assets'), binding: 'FRONT_ASSETS', run_worker_first: true, routerConfig: { has_user_worker: true } }, compatibilityDate: '2026-10-20' },
      { name: 'admin_worker', modulesRoot: path.resolve(root, serverOut),
        modules: workerFiles.map(file => ({ type: 'ESModule', path: path.resolve(root, serverOut, file) })),
        compatibilityDate: '2026-10-20', compatibilityFlags: ['nodejs_als'],
        assets: { directory: path.resolve(root, clientOut), routerConfig: { has_user_worker: true } }, bindings: { RECOOLER_SECRET: 'proxy-test-only' } },
    ] }));
    const origin = (await mf.ready).origin;
    assert.match(await (await fetch(origin + '/assets/recooler-client.js')).text(), /WRONG_FRONT_ENTRY/);
    const html = await (await fetch(origin + '/_admin/')).text();
    assert.match(html, legacy ? /import\("\/_admin\/assets\/recooler-client.js\?v=/ : /src="\/_admin\/assets\/recooler-client.js\?v=/);
    assert(!html.includes('recooler-gate'), 'no blocking gate through the admin proxy');
    const preloads = [...html.matchAll(/rel="modulepreload" href="([^"]+)"/g)].map(m => m[1]);
    assert(preloads.length);
    for (const url of preloads) { assert(url.startsWith('/_admin/assets/')); const response = await fetch(origin + url); assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /javascript/); }
    const fetched = [];
    const modules = new Map();
    let context;
    const load = async url => {
      if (modules.has(url)) return modules.get(url);
      const response = await fetch(url); assert.equal(response.status, 200, url);
      assert(new URL(url).pathname.startsWith('/_admin/'), 'all entry/slice imports stay behind proxy');
      fetched.push(url);
      const module = new vm.SourceTextModule(await response.text(), { context, identifier: url,
        initializeImportMeta(meta) { meta.url = url; }, importModuleDynamically: async (specifier, parent) => {
          const child = await load(new URL(specifier, parent.identifier).href); if (child.status === 'linked') await child.evaluate(); return child;
        } });
      modules.set(url, module);
      await module.link((specifier, parent) => load(new URL(specifier, parent.identifier).href));
      return module;
    };
    // Supply only jsdom's missing native-module primitive, as in client-htmx.
    vm.runInContext = (code, ctx, options) => new vm.Script(code, { ...options, importModuleDynamically: async specifier => {
      context ??= ctx;
      const module = await load(new URL(specifier, options.filename).href); if (module.status === 'linked') await module.evaluate(); return module;
    } }).runInContext(ctx);
    const dom = new JSDOM(html, { url: origin + '/_admin/', runScripts: 'dangerously', resources: 'usable', beforeParse(w) {
      w.CSS = { escape: value => String(value) }; w.HTMLElement.prototype.scrollIntoView = () => {};
      const evaluate = w.XPathExpression.prototype.evaluate;
      w.XPathExpression.prototype.evaluate = function(node, type = 0, result = null) { return evaluate.call(this, node, type, result); };
      w.reportError = error => (w.errors ??= []).push(error.message);
    } });
    window = dom.window; context = dom.getInternalVMContext();
    if (!legacy) {
      const entry = window.document.querySelector('script[type="module"][src]').src;
      const module = await load(entry); await module.evaluate();
    }
    await until(() => window.document.body.dataset.adminLoaded === 'yes' && window.htmx, 'admin entry/onLoad through service binding');
    await new Promise(r => setTimeout(r, 30));
    window.document.querySelector('#admin').click(); assert.equal(window.document.querySelector('#admin').textContent, 'admin handler');
    let settled = false;
    window.document.addEventListener('htmx:afterSettle', () => { settled = true; }, { once: true });
    window.document.querySelector('#next').click();
    await until(() => settled && window.document.body.dataset.nextLoaded === 'yes', 'lazy destination slice through service binding');
    window.document.querySelector('#next-handler').click(); assert.equal(window.document.querySelector('#next-handler').textContent, 'next admin handler');
    assert.equal(window.WRONG_FRONT_ENTRY, undefined); assert.equal(window.errors, undefined);
    assert(fetched.filter(url => url.includes('recooler-slice-')).length >= 2, 'both routes use their own lazy slices');
    window.close(); window = undefined; vm.runInContext = originalRun;
    await mf.dispose(); mf = undefined;
  }
  console.log(JSON.stringify({ clientProxy: true, beta, serviceBinding: true, viteBase: true, preloads: true, legacy: true }));
} finally { vm.runInContext = originalRun; window?.close(); await mf?.dispose(); await rm(root, { recursive: true, force: true }); }
