// Bundled only into private probe Workers. Namespace slots retain source provenance.
import { createApp as originalCreateApp, resolveRoutes } from 'recooler/router';
import { htmx as originalHtmx } from 'recooler/htmx';
import { getActionRegistry } from 'recooler/htmx/runtime';
export * from 'recooler/router';
export * from 'recooler/htmx';

const actionOptions = [];
const wrap = (fn, label) => {
  if (typeof fn !== 'function') return fn;
  return function (...args) {
    globalThis.__recoolerTrace?.push(label);
    return Reflect.apply(fn, this, args);
  };
};
const hoc = (fn, label) => typeof fn !== 'function' ? fn : function (...args) {
  return wrap(Reflect.apply(fn, this, args), label);
};
const label = (file, exported = 'default') => ({ file: `src/${file}`, export: exported });
function namespace(ns, file, kind) {
  if (!ns) return ns;
  const copy = Object.create(null);
  for (const key of Object.keys(ns)) {
    const role = key === 'head' ? 'head' : key === 'default' ? kind : /^on(Get|Post|Put|Patch|Delete|Head|Options|Request)$/.test(key) ? 'handler' : null;
    Object.defineProperty(copy, key, { enumerable: true, get() {
      return role ? (['root', 'layout'].includes(role) ? hoc : wrap)(ns[key], { kind: role, ...label(file, key) }) : ns[key];
    } });
  }
  return copy;
}
export function htmx(options) {
  const registry = getActionRegistry(options.namespace);
  for (const methods of registry.values()) for (const actions of Object.values(methods)) {
    for (const id of Object.keys(actions)) actions[id] = wrap(actions[id], { kind: 'action', id: `src/${id}` });
  }
  actionOptions.push(options);
  return originalHtmx(options);
}
export function createApp(manifest, options = {}) {
  function node(n) {
    return { ...n,
      middleware: n.middleware.map((ns, i) => namespace(ns, n.middlewareFiles[i], 'middleware')),
      layout: namespace(n.layout, n.layoutFile, 'layout'),
      route: n.route && { ...n.route, module: namespace(n.route.module, n.route.file, 'render-page') },
      children: n.children.map(node),
    };
  }
  const traced = { ...manifest, root: namespace(manifest.root, manifest.rootFile, 'root'), tree: node(manifest.tree) };
  const entries = [];
  const pages = options.pages && { handler(route, extras, contributions) {
    const handler = options.pages.handler(route, extras, contributions);
    if (!handler) return handler;
    const sources = [[route.root, route.rootFile], ...route.layouts.map((ns, i) => [ns, route.layoutFiles[i]]), [route.module, route.file]];
    const description = { kind: 'page', root: label(route.rootFile), layouts: route.layoutFiles.map(file => label(file)), module: label(route.file),
      heads: sources.filter(([ns]) => ns?.head != null).map(([, file]) => label(file, 'head')) };
    return wrap(handler, description);
  } };
  const app = originalCreateApp(traced, { ...options, pages });
  const plan = resolveRoutes(traced);
  for (const mw of [...plan.middlewares, ...plan.lateMiddlewares]) entries.push({ path: mw.path, method: 'ALL', handler: { kind: 'middleware', ...label(mw.file) } });
  for (const route of plan.routes) {
    const page = typeof route.module.default === 'function';
    const methods = new Set(Object.entries({ onGet: 'GET', onPost: 'POST', onPut: 'PUT', onPatch: 'PATCH', onDelete: 'DELETE', onOptions: 'OPTIONS', onHead: 'HEAD' })
      .filter(([name]) => typeof route.module[name] === 'function').map(([, method]) => method));
    const actions = [];
    if (page) {
      methods.add('GET');
      for (const config of actionOptions) for (const module of config.table[route.file] || []) {
        for (const [method, table] of Object.entries(getActionRegistry(config.namespace).get(module) || {})) {
          methods.add(method);
          for (const id of Object.keys(table)) actions.push({ method, id: `src/${id}`, runtimeId: id });
        }
      }
    }
    if (typeof route.module.onRequest === 'function') { methods.clear(); methods.add('ALL'); }
    const sources = [[route.root, route.rootFile], ...route.layouts.map((ns, i) => [ns, route.layoutFiles[i]]), [route.module, route.file]];
    for (const method of methods) entries.push({ path: route.path, method, routeId: route.file, actions,
      handler: page ? { kind: 'page', root: label(route.rootFile), layouts: route.layoutFiles.map(file => label(file)), module: label(route.file), heads: sources.filter(([ns]) => ns?.head != null).map(([, file]) => label(file, 'head')) } : { kind: 'handler', ...label(route.file) } });
  }
  globalThis.__recoolerEquivalence = entries;
  return app;
}
