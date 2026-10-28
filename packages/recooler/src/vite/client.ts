/** Generated entry; slice maps disclose only surviving client source. */
export const clientId = 'virtual:recooler/client';
export const internalClient = '\0' + clientId;
export const sliceQuery = 'recooler-handlers';
export const clientFile = 'assets/recooler-client.js';

export interface ClientRoute {
  slices: string[];
  /** Only the owning page's onLoad runs, even if it imports another page. */
  onLoad?: string;
}

export function clientEntry(routes: Record<string, ClientRoute>, resolveSlice: (id: string) => string, version = '', dev = false): string {
  const ids = [...new Set(Object.values(routes).flatMap(route => route.slices))].sort();
  // Neither the entry's lookup keys nor its route table disclose source paths.
  const opaque = (id: string) => String(ids.indexOf(id));
  const pages = Object.fromEntries(Object.entries(routes).map(([route, page]) => [route, {
    slices: page.slices.map(opaque), ...(page.onLoad ? { onLoad: opaque(page.onLoad) } : {}),
  }]));
  return `
const slices = {
${ids.map(id => `${JSON.stringify(opaque(id))}: () => import(${JSON.stringify(resolveSlice(id) + (id.includes('?') ? '&' : '?') + sliceQuery)})`).join(',\n')}
};
const routes = ${JSON.stringify(pages)};
const version = ${JSON.stringify(version)};
const handlers = globalThis.$handlers ??= Object.create(null);
const modules = new Map();
const report = error => typeof globalThis.reportError === 'function' ? globalThis.reportError(error) : console.error(error);
let active, activeRoute, activeVersion, pending, loading = true, resuming;
const marker = () => document.querySelector('body meta[name="recooler-route"]') ?? document.querySelector('meta[name="recooler-route"]') ?? document.body;
const routeOf = node => node?.content ?? node?.dataset.recoolerRoute;
const changed = () => {
  const node = marker();
  return node !== active || routeOf(node) !== activeRoute || node?.dataset.recoolerVersion !== activeVersion;
};
function checkVersion(node) {
  const expected = node?.dataset.recoolerVersion;
  if (expected && version && expected !== version) {
    location.reload();
    throw new Error('recooler: page/client version mismatch; reloading');
  }
}
const queue = (...args) => {
  args[3].preventDefault();
  (globalThis.$rq ??= []).push(args);
};
globalThis.$rc = (id, scope, element, event) => {
  if (resuming?.elements.has(element) && resuming.type === event.type) return;
  if (loading || changed()) { queue(id, scope, element, event); return; }
  checkVersion(active);
  const fn = handlers[id];
  if (!fn) throw new Error('recooler: handler is not loaded for this route: ' + id);
  return (scope === null ? fn : fn(scope)).call(element, event);
};
async function replay(records) {
  const [, , element, event] = records[0];
  if (!element.isConnected) return;
  let cancelled = false, issued = false;
  // Queueing cancelled the original event. Present the handler with its own
  // cancellation state, retaining target, detail, this and native event methods.
  const detail = event.detail && typeof event.detail === 'object' ? new Proxy(event.detail, {
    get(target, key) {
      if (key === 'issueRequest' && typeof target[key] === 'function') return (...args) => { issued = true; return target[key](...args); };
      return Reflect.get(target, key);
    }
  }) : event.detail;
  const replayed = new Proxy(event, { get(target, key) {
    if (key === 'defaultPrevented') return cancelled;
    if (key === 'preventDefault') return () => { cancelled = true; target.preventDefault(); };
    if (key === 'detail') return detail;
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  for (const [id, scope, target] of records) {
    if (!target.isConnected) continue;
    try { await globalThis.$rc(id, scope, target, replayed); }
    catch (error) { cancelled = true; report(error); }
  }
  if (!event.cancelable || cancelled || issued || !element.isConnected) return;
  const source = event.type === 'submit' ? event.target?.closest?.('form')
    : event.type === 'click' ? event.target?.closest?.('a,button,input[type="submit"],input[type="button"]')
    : detail?.elt ?? element;
  resuming = { elements: new Set(records.map(args => args[2])), type: event.type };
  try {
    if (event.type === 'htmx:confirm' && typeof detail?.issueRequest === 'function') detail.issueRequest();
    else if (event.type === 'submit' && typeof source?.requestSubmit === 'function') source.requestSubmit(event.submitter ?? undefined);
    else if (event.type === 'click' && source) source.click();
    else if (event.type.startsWith('htmx:')) {
      const config = detail?.requestConfig ?? detail;
      if (config?.verb && config?.path && globalThis.htmx?.ajax) {
        globalThis.htmx.ajax(config.verb, config.path, { source, target: config.target,
          headers: config.headers, values: config.parameters, event: config.triggeringEvent });
      } else console.warn('recooler: queued ' + event.type + ' was cancelled; htmx exposes no request continuation');
    }
  } finally { resuming = undefined; }
}
async function initialize() {
  if (document.readyState === 'loading') await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  const node = marker();
  if (!changed()) return pending;
  checkVersion(node);
  active = node;
  const route = activeRoute = routeOf(node);
  const pageVersion = activeVersion = node?.dataset.recoolerVersion;
  const current = () => marker() === node && routeOf(node) === route && node?.dataset.recoolerVersion === pageVersion;
  loading = true;
  const page = Object.hasOwn(routes, route) ? routes[route] : undefined;
  pending = (async () => {
    await Promise.all((page?.slices ?? []).map(async id => {
      if (!modules.has(id)) modules.set(id, slices[id]());
      await modules.get(id);
    }));
    // A later swap can finish before an earlier dynamic import.
    if (!current()) return;
    const onLoad = page?.onLoad && (await modules.get(page.onLoad))?.onLoad;
    if (typeof onLoad === 'function') { try { await onLoad(); } catch (error) { report(error); } }
    if (!current()) return;
    loading = false;
    const queued = globalThis.$rq ?? [];
    globalThis.$rq = [];
    const events = new Map();
    for (const args of queued) {
      if (!events.has(args[3])) events.set(args[3], []);
      events.get(args[3]).push(args);
    }
    for (const records of events.values()) { try { await replay(records); } catch (error) { report(error); } }
  })();
  return pending;
}
export function init() { return globalThis.__recooler_ready = initialize(); }
document.addEventListener('htmx:afterSettle', () => {
  if (changed()) init().catch(report);
});
document.addEventListener('htmx:historyRestore', () => { init().catch(report); });
${dev ? `globalThis.__recooler_entry_loaded = true;` : ''}
export const ready = init();
`;
}
