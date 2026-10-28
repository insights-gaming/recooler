/** Generated entry; slice maps disclose only surviving client source. */
export const clientId = 'virtual:recooler/client';
export const internalClient = '\0' + clientId;
export const routeClientId = 'virtual:recooler/route/';
export const sliceQuery = 'recooler-handlers';
export const clientFile = 'assets/recooler-client.js';

export interface ClientRoute {
  slices: string[];
  /** Only the owning page's onLoad runs, even if it imports another page. */
  onLoad?: string;
}

export function clientEntry(routes: Record<string, ClientRoute>, resolveSlice: (id: string) => string, version = '', dev = false,
  retryURL: (id: string) => string = resolveSlice): string {
  const ids = [...new Set(Object.values(routes).flatMap(route => route.slices))].sort();
  const opaque = (id: string) => String(ids.indexOf(id));
  const pages = Object.fromEntries(Object.entries(routes).map(([route, page]) => [route, {
    slices: page.slices.map(opaque), ...(page.onLoad ? { onLoad: opaque(page.onLoad) } : {}),
  }]));
  return `
const runtime = globalThis.__recooler_client ??= (() => {
const slices = {
${ids.map(id => `${JSON.stringify(opaque(id))}: () => import(${JSON.stringify(resolveSlice(id) + (id.includes('?') ? '&' : '?') + sliceQuery)})`).join(',\n')}
};
const urls = ${JSON.stringify(Object.fromEntries(ids.map(id => [opaque(id), retryURL(id)])))};
const routes = ${JSON.stringify(pages)};
const version = ${JSON.stringify(version)};
const handlers = globalThis.$handlers ??= Object.create(null);
const modules = new Map(), jobs = new WeakMap(), started = new WeakMap(), completed = new WeakMap();
const report = error => console.error(error);
const markers = () => [...document.querySelectorAll('[data-recooler-marker]')];
const signature = node => node.dataset.recoolerRoute + '@' + node.dataset.recoolerVersion;
function reloadOnce(key, message) {
  try {
    if (!sessionStorage.getItem(key)) {
      sessionStorage.setItem(key, '1');
      location.reload();
      return;
    }
  } catch {}
  console.error(message);
}
function checkVersion(node) {
  const expected = node.dataset.recoolerVersion;
  if (expected && version && expected !== version) {
    reloadOnce('recooler:version:' + expected + ':' + version, 'recooler: page/client version mismatch persists; refresh after the deployment completes');
    return false;
  }
  return true;
}
async function load(id) {
  if (!modules.has(id)) {
    const promise = (async () => {
      try { return await slices[id](); }
      catch {
        // Native import caches failures by URL. Give the retry a fresh identity.
        const url = urls[id];
        return import(/* @vite-ignore */ url + (url.includes('?') ? '&' : '?') + 'rc_retry=' + Date.now());
      }
    })();
    modules.set(id, promise);
    promise.catch(() => { if (modules.get(id) === promise) modules.delete(id); });
  }
  return modules.get(id);
}
function invoke(id, scope, element, event) {
  const fn = handlers[id];
  if (fn) return (scope === null ? fn : fn(scope)).call(element, event);
}
async function initializeNode(node) {
  const key = signature(node);
  if (completed.get(node) === key) return;
  const existing = jobs.get(node);
  if (existing?.key === key) return existing.promise;
  if (!checkVersion(node)) return;
  const page = routes[node.dataset.recoolerRoute];
  const run = async () => {
    // Static route modules register namespaces synchronously before DCL.
    // Only swaps or failed initial module loads take the asynchronous path.
    const missing = (page?.slices ?? []).filter(id => !modules.has(id));
    if (missing.length) await Promise.all(missing.map(load));
    const values = (page?.slices ?? []).map(id => modules.get(id));
    if (values.some(value => value instanceof Promise)) await Promise.all(values);
    if (!node.isConnected || signature(node) !== key || started.get(node) === key) return;
    started.set(node, key);
    const value = page?.onLoad && modules.get(page.onLoad);
    const module = value instanceof Promise ? await value : value;
    if (typeof module?.onLoad === 'function') {
      try { await module.onLoad(); } catch (error) { report(error); }
    }
    if (node.isConnected && signature(node) === key) completed.set(node, key);
  };
  const promise = run().catch(error => {
    reloadOnce('recooler:import:' + (version || 'dev'),
      'recooler: client module failed after retry; ' + error);
    report(error);
  }).finally(() => { if (jobs.get(node)?.promise === promise) jobs.delete(node); });
  jobs.set(node, { key, promise });
  return promise;
}
function init() {
  if (document.readyState === 'loading') {
    return globalThis.__recooler_ready = new Promise(resolve => document.addEventListener('DOMContentLoaded', () => resolve(init()), { once: true }));
  }
  const ready = Promise.all(markers().map(initializeNode));
  // Observe every public readiness promise even when the caller ignores it.
  ready.catch(report);
  return globalThis.__recooler_ready = ready;
}
function register(entries) {
  for (const [id, module] of entries) modules.set(id, module);
  // A legacy import may have started a lazy job while the static graph loaded.
  // Static registration owns startup and must run onLoad before DCL, even then.
  for (const node of markers()) {
    const page = routes[node.dataset.recoolerRoute];
    if (started.get(node) !== signature(node) && page?.slices.every(id => modules.has(id) && !(modules.get(id) instanceof Promise))) jobs.delete(node);
  }
  init();
}
const waiting = new WeakMap();
globalThis.$rc = (id, scope, element, event) => {
  if (markers().some(node => !checkVersion(node))) return;
  if (handlers[id] && markers().every(node => completed.get(node) === signature(node))) {
    return invoke(id, scope, element, event);
  }
  // Only confirm has a safe public continuation. Config/beforeRequest run
  // late; other events are dropped without touching their defaults.
  if (!['htmx:confirm', 'htmx:configRequest', 'htmx:beforeRequest'].includes(event.type)) {
    init();
    ${dev ? `if (event.type !== 'htmx:load') console.warn('recooler: dropped ' + event.type + ' while route handlers load');` : ''}
    return;
  }
  let batch = waiting.get(event);
  if (!batch) {
    const confirm = event.type === 'htmx:confirm' && typeof event.detail?.issueRequest === 'function';
    if (confirm) event.preventDefault();
    batch = { records: [], confirm };
    waiting.set(event, batch);
    queueMicrotask(async () => {
      try {
        await init();
        if (markers().some(node => !checkVersion(node))) return;
        let cancelled = false, issued = false;
        const detail = confirm ? new Proxy(event.detail, { get(target, key) {
          if (key === 'issueRequest') return (...args) => { issued = true; return target.issueRequest(...args); };
          return Reflect.get(target, key);
        } }) : event.detail;
        const late = new Proxy(event, { get(target, key) {
          if (key === 'preventDefault') return () => { cancelled = true; };
          if (key === 'defaultPrevented' && confirm) return cancelled;
          if (key === 'detail') return detail;
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
        for (const [id, scope, target] of batch.records) {
          if (!target.isConnected) continue;
          if (!handlers[id]) { cancelled = true; continue; }
          try { await invoke(id, scope, target, late); } catch (error) { cancelled = true; report(error); }
        }
        if (confirm && !cancelled && !issued && event.detail.elt?.isConnected !== false) event.detail.issueRequest(true);
      } catch (error) { report(error); }
    });
  }
  batch.records.push([id, scope, element]);
};
for (const name of ['htmx:afterSwap', 'htmx:afterSettle', 'htmx:historyRestore']) document.addEventListener(name, init);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else queueMicrotask(init);
${dev ? `globalThis.__recooler_entry_loaded = true;` : ''}
return { init, register };
})();
export const init = runtime.init;
export const register = runtime.register;
export const ready = globalThis.__recooler_ready ?? Promise.resolve();
`;
}
