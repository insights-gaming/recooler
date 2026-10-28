import { selectServer } from './server-environment.mjs';
import MagicString from 'magic-string';
import { relative } from 'node:path';

export const RUNTIME = 'virtual:spike-runtime';
const INTERNAL = '\0' + RUNTIME;
const TABLE = '\0virtual:spike-table';
const TOKEN = '__SPIKE_ROUTE_TABLE_18a5__';
export function graphPlugin({ root, routes, mode = 'graph', stats = {}, banned = /\/server-only\./ }) {
  let serving = false;
  let devOrigin;
  let devServer;
  let cached;
  let epoch = 0;
  const everActions = new Set();
  const canonical = id => relative(root, id.replace(/[?&](?:v|t)=[^&]*/g, '')).replaceAll('\\', '/');
  stats.resolveCalls = 0;
  stats.graphMs = 0;
  stats.chunks = {};
  const walkBuild = (ctx, seeds) => {
    const seen = new Set();
    const visit = id => {
      if (seen.has(id) || id === INTERNAL || ctx.getModuleInfo(id)?.isExternal) return;
      seen.add(id);
      for (const dep of ctx.getModuleInfo(id)?.importedIds ?? []) visit(dep);
    };
    seeds.forEach(visit);
    return [...seen].map(canonical).sort();
  };
  async function devTable(environment) {
    if (cached?.epoch === epoch) return cached.table;
    const generation = epoch;
    const table = {};
    for (const [route, seeds] of Object.entries(routes)) {
      const seen = new Set();
      async function visit(url) {
        // Transform on demand: on a cold request the graph is not complete yet.
        const resolved = await environment.pluginContainer.resolveId(url);
        if (!resolved || resolved.external || resolved.id === INTERNAL || seen.has(resolved.id)) return;
        seen.add(resolved.id);
        const result = await environment.transformRequest(resolved.id);
        const node = environment.moduleGraph.getModuleById(resolved.id);
        // importedModules also contains dynamic imports. deps is the STATIC set.
        for (const dep of result?.deps ?? node?.transformResult?.deps ?? []) await visit(dep);
      }
      for (const id of seeds) await visit(id);
      table[route] = [...seen].map(canonical).sort();
    }
    cached = { epoch: generation, table };
    stats.devComputations = (stats.devComputations ?? 0) + 1;
    return table;
  }
  return {
    name: 'spike-graph-' + mode,
    enforce: 'pre',
    configEnvironment() { return { optimizeDeps: { exclude: ['spike-actions'] } }; },
    configResolved(config) { serving = config.command === 'serve'; },
    configureServer(server) {
      devServer = server;
      server.httpServer.once('listening', () => {
        devOrigin = `http://127.0.0.1:${server.httpServer.address().port}`;
      });
      server.middlewares.use('/__spike_graph', async (_req, res, next) => {
        try {
          const env = selectServer(server.environments);
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(await devTable(env)));
        } catch (error) { next(error); }
      });
    },
    hotUpdate(ctx) {
      epoch++; cached = undefined;
      const table = this.environment.moduleGraph.getModuleById(TABLE);
      if (table) {
        this.environment.moduleGraph.invalidateModule(table);
        return [...ctx.modules, table];
      }
    },
    resolveId(id) { if (id === RUNTIME) return INTERNAL; if (id === 'virtual:spike-table') return TABLE; },
    async load(id) {
      if (id === TABLE) return { code: `export default ${JSON.stringify(await devTable(selectServer(devServer.environments)))};`, map: null };
      if (id !== INTERNAL) return;
      return { code: `const registry = ${serving ? `globalThis[Symbol.for(${JSON.stringify('spike.registry:' + root)})] ??= new Map()` : 'new Map()'};
export function registerActions(id, actions) { registry.set(id, actions); }
export function unregisterActions(id) { registry.delete(id); }
const table = JSON.parse(${JSON.stringify(serving ? '{}' : TOKEN)});
export async function getTable() { return ${serving ? `import('virtual:spike-table').then(m => m.default)` : 'table'}; }
export async function getActions(route) { const t = await getTable(); return (t[route] ?? []).flatMap(id => Object.keys(registry.get(id) ?? {})).sort(); }
`, map: null };
    },
    transform: {
      order: mode === 'aggregator' ? 'post' : 'pre',
      async handler(code, id) {
        if (!id.startsWith(root) || id.includes('/dist/') || id === INTERNAL) return;
        if (this.environment.config.consumer !== 'server' || mode === 'none') return;
        if (mode === 'graph') {
          const hasActions = /@action|hx-(?:post|get|on)/.test(code);
          const key = canonical(id);
          if (!hasActions && !everActions.has(key)) return;
          everActions.add(key);
          const s = new MagicString(code);
          s.append(`\nimport { registerActions, unregisterActions } from '${RUNTIME}';\nregisterActions(${JSON.stringify(canonical(id))}, ${hasActions ? `{ ${JSON.stringify(canonical(id) + '@0')}: () => 'fake' }` : '{}'});\n${serving ? `if (import.meta.hot) import.meta.hot.dispose(() => unregisterActions(${JSON.stringify(canonical(id))}));` : ''}\n`);
          return { code: s.toString(), map: s.generateMap({ hires: true, source: id, includeContent: true }) };
        }
        if (id.endsWith('/src/entry.ts')) return;
        // Fallback shape from docs/plans/fixtures/aggregator. Parse AFTER TS lowering.
        const ast = this.parse(code);
        const deps = [];
        for (const n of ast.body) {
          if (!['ImportDeclaration', 'ExportAllDeclaration', 'ExportNamedDeclaration'].includes(n.type) || !n.source) continue;
          if (n.source.value === RUNTIME) continue;
          stats.resolveCalls++;
          const dep = await this.resolve(n.source.value, id);
          if (dep && !dep.external && dep.id.startsWith(root)) deps.push(dep.id);
        }
        const s = new MagicString(code);
        const imports = deps.map((dep, i) => `import * as __dep${i} from ${JSON.stringify(dep)};`).join('\n');
        const actions = /@action|hx-(?:post|get|on)/.test(code) ? `{ ${JSON.stringify(canonical(id) + '@0')}: () => 'fake' }` : '{}';
        s.append(`\n${imports}\nexport function __recooler() { return { actions: ${actions}, deps: [${deps.map((_, i) => `() => __dep${i}.__recooler`).join(',')}] }; }\n`);
        return { code: s.toString(), map: s.generateMap({ hires: true, source: id, includeContent: true }) };
      }
    },
    renderChunk(code) {
      if (!code.includes(TOKEN) || this.environment.config.consumer !== 'server') return;
      const start = performance.now();
      stats.table = mode === 'none' ? {} : Object.fromEntries(Object.entries(routes).map(([route, seeds]) => [route, walkBuild(this, seeds)]));
      stats.graphMs += performance.now() - start;
      const s = new MagicString(code);
      const at = code.indexOf(JSON.stringify(TOKEN));
      s.overwrite(at, at + JSON.stringify(TOKEN).length, JSON.stringify(JSON.stringify(stats.table)));
      return { code: s.toString(), map: s.generateMap({ hires: true, includeContent: true }) };
    },
    generateBundle(_, bundle) {
      if (this.environment.config.consumer !== 'client') return;
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        const ids = [...chunk.moduleIds];
        stats.chunks[chunk.fileName] = { ids: ids.map(canonical), imports: chunk.imports, dynamicImports: chunk.dynamicImports, entry: chunk.isEntry };
        const prohibited = ids.find(id => banned.test(id));
        if (prohibited) this.error('Banned client module: ' + prohibited);
      }
    }
  };
}
