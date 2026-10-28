import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signActionUrl } from '../../../packages/recooler/dist/htmx/testing.js';
import { loadRuntime } from '../runtime.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const fixtureSecret = 'synthetic-equivalence-secret';
export async function prepare({ packageRoot, packageOut, optionsFile, command, name }) {
  for (const mode of ['baseline', 'probe']) {
    await command(process.execPath, [join(here, '../vite-worker.mjs'), packageRoot, join(packageOut, mode), mode, optionsFile], packageRoot, `${name}-${mode}.log`);
    console.log(`${name}: ${mode} build succeeded`);
  }
  return JSON.parse(await readFile(join(packageOut, 'baseline-build.json'), 'utf8'));
}
export async function load({ packageRoot, packageOut, spec, mode = 'probe' }) {
  const secret = spec.actionSecret || (spec.fixture ? fixtureSecret : undefined);
  if (!secret) throw new Error('recooler-0.1 requires a private actionSecret');
  const app = await loadRuntime({ packageRoot, packageOut, spec: { ...spec, bindings: { ...spec.bindings, [spec.secretBinding || 'RECOOLER_SECRET']: secret } }, mode });
  try {
    // Baseline Workers deliberately have no instrumentation: persist the probe map
    // once, then use it solely to mint capabilities in either independent runtime.
    const entries = mode === 'probe' ? await app.entries() : JSON.parse(await readFile(join(packageOut, 'route-ids.json'), 'utf8'));
    if (!Array.isArray(entries) || !entries.length) throw new Error('No recooler routes captured');
    if (mode === 'probe') {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(packageOut, 'route-ids.json'), JSON.stringify(entries));
    }
    const routes = new Map();
    for (const entry of entries) {
      if (entry.handler.kind === 'middleware') continue;
      if (!routes.has(entry.path)) routes.set(entry.path, { path: entry.path, methods: [], actions: entry.actions.map(({ method, id }) => ({ method, id })), page: entry.handler.kind === 'page' ? entry.handler : null });
      routes.get(entry.path).methods.push(entry.method);
    }
    return { ...app, ...(mode === 'probe' ? { catalog: { routes: [...routes.values()], middlewarePrefixes: entries.filter(e => e.handler.kind === 'middleware').map(e => e.path) }, diagnostics: { entries } } : {}),
      actionUrl(request) {
        const matches = entries.filter(entry => entry.path === request.action.routeId && entry.routeId);
        const route = matches.find(entry => entry.actions?.some(action => action.id === request.action.actionId && action.method === request.action.method)) || matches[0];
        if (!route) throw new Error(`Unknown action route template: ${request.action.routeId}`);
        const action = route.actions?.find(action => action.id === request.action.actionId && action.method === request.action.method);
        return signActionUrl({ ...request.action, routeId: route.routeId, actionId: action?.runtimeId || request.action.actionId }, secret);
      } };
  } catch (error) { await app.dispose(); throw error; }
}
// 0.1 composes terminal handlers using Hono finalization semantics.
export const fixtureOutcomes = { undefinedHandlerStatus: 500 };
