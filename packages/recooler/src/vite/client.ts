/** Generated-only entry; original-source slices return the transform's own map. */
export const clientId = 'virtual:recooler/client';
export const internalClient = '\0' + clientId;
export const sliceQuery = 'recooler-handlers';
export const clientFile = 'assets/recooler-client.js';

export interface ClientRoute {
  slices: string[];
  /** Only the owning page's onLoad runs, even if it imports another page. */
  onLoad?: string;
}

export function clientEntry(routes: Record<string, ClientRoute>, resolveSlice: (id: string) => string): string {
  const ids = [...new Set(Object.values(routes).flatMap(route => route.slices))].sort();
  return `
const slices = {
${ids.map(id => `${JSON.stringify(id)}: () => import(${JSON.stringify(resolveSlice(id) + (id.includes('?') ? '&' : '?') + sliceQuery)})`).join(',\n')}
};
const routes = ${JSON.stringify(routes)};
const handlers = globalThis.$handlers ??= Object.create(null);
// Do not dispatch a partially loaded route: queue until every slice registers.
globalThis.__recooler_dispatch = (id, scope, element, event) => {
  (globalThis.__recooler_queue ??= []).push([id, scope, element, event]);
};
export const ready = globalThis.__recooler_ready = (async () => {
  // The legacy inline import can execute before a streamed document finishes.
  if (document.readyState === 'loading') await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  const route = document.body?.dataset.recoolerRoute ?? document.querySelector('meta[name="recooler-route"]')?.content;
  const page = Object.hasOwn(routes, route) ? routes[route] : undefined;
  const modules = new Map(await Promise.all((page?.slices ?? []).map(async id => [id, await slices[id]()])));
  globalThis.__recooler_dispatch = (id, scope, element, event) => {
    const fn = handlers[id];
    if (!fn) throw new Error('recooler: handler is not loaded for this route: ' + id);
    return (scope === null ? fn : fn(scope)).call(element, event);
  };
  const queued = globalThis.__recooler_queue ?? [];
  globalThis.__recooler_queue = [];
  for (const args of queued) globalThis.__recooler_dispatch(...args);
  const onLoad = page?.onLoad && modules.get(page.onLoad)?.onLoad;
  if (typeof onLoad === 'function') await onLoad();
})();
`;
}
