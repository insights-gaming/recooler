import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summariseEntries } from '../instrument.mjs';
import { loadRuntime } from '../runtime.mjs';
const here = dirname(fileURLToPath(import.meta.url));
export async function prepare({ packageRoot, packageOut, optionsFile, command, name }) {
  for (const mode of ['baseline', 'probe']) {
    await command(process.execPath, [join(here, '../farm-worker.mjs'), packageRoot, join(packageOut, mode), mode, optionsFile], packageRoot, `${name}-${mode}.log`);
    console.log(`${name}: ${mode} build succeeded`);
  }
  return JSON.parse(await readFile(join(packageOut, 'baseline-build.json'), 'utf8'));
}
export function catalogFromEntries(entries) {
  const diagnostics = summariseEntries(entries);
  const routes = new Map();
  for (const entry of entries) {
    if (entry.handler.kind === 'middleware') continue;
    if (!routes.has(entry.path)) routes.set(entry.path, { path: entry.path, methods: [], actions: [], page: null });
    const route = routes.get(entry.path);
    if (!route.methods.includes(entry.method)) route.methods.push(entry.method);
    for (const id of entry.handler.actionIds || []) route.actions.push({ method: entry.method, id });
    if (entry.handler.kind === 'page') route.page = entry.handler;
  }
  return { catalog: { routes: [...routes.values()], middlewarePrefixes: entries.filter(x => x.handler.kind === 'middleware').map(x => x.path) }, diagnostics };
}
export function actionUrl(request) {
  const url = new URL(request.path, 'http://localhost');
  url.searchParams.set('action', request.action.actionId);
  if (request.action.scope !== undefined) url.searchParams.set('scope', JSON.stringify(request.action.scope));
  return url.pathname + url.search;
}
export async function load({ packageRoot, packageOut, spec, mode = 'probe' }) {
  const app = await loadRuntime({ packageRoot, packageOut, spec, mode });
  try {
    return { ...app, ...(mode === 'probe' ? catalogFromEntries(await app.entries()) : {}), actionUrl };
  } catch (error) { await app.dispose(); throw error; }
}
