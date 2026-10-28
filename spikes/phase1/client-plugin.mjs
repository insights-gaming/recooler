import { selectServer } from './server-environment.mjs';
// A tiny server-derived route list stands in for the production slice transform.
export function clientPlugin({ root, stats, includeBanned = false }) {
  let serverRoutes;
  let manifest;
  return {
    name: 'spike-client-environment',
    config() {
      return {
        environments: {
          client: { consumer: 'client', build: { outDir: 'dist/client', manifest: true, sourcemap: true, minify: false, modulePreload: false,
            rolldownOptions: { input: 'virtual:client-entry', output: { entryFileNames: 'assets/entry-[hash].mjs', chunkFileNames: 'assets/[name]-[hash].mjs' } } } }
        },
        builder: { sharedPlugins: true, async buildApp(builder) {
          const server = selectServer(builder.environments);
          // Discovery pass supplies the client graph, then a final server pass consumes
          // the hashed client manifest. Record the third pass explicitly.
          await builder.build(server);
          await builder.build(builder.environments.client);
          stats.buildOrder.push(server.name + ':manifest');
          await builder.build(server);
        } }
      };
    },
    configResolved(config) { stats.buildOrder = []; },
    buildStart() { stats.buildOrder.push(this.environment.name); },
    resolveId(id) { if (['virtual:client-entry', 'virtual:client-manifest'].includes(id)) return '\0' + id; },
    load(id) {
      if (id === '\0virtual:client-manifest') return { code: `export default ${JSON.stringify(manifest ?? {})};`, map: null };
      if (id !== '\0virtual:client-entry') return;
      const routes = serverRoutes ?? { '/public': 'public', '/admin': 'admin' };
      return { code: `export const routes = { ${Object.entries(routes).map(([route, slice]) => `${JSON.stringify(route)}: () => import(${JSON.stringify(root + '/src/client/' + slice + '.ts')})`).join(',')} };
import { moved, untouched } from ${JSON.stringify(root + '/src/map-source.ts')};
import { virtualCrash } from 'virtual:mapless';
globalThis.__spikeClient = { routes, moved, untouched, virtualCrash };
${includeBanned ? `import ${JSON.stringify(root + '/src/server-only.ts')};` : ''}
if (import.meta.hot) import.meta.hot.accept();`, map: null };
    },
    hotUpdate(ctx) {
      if (this.environment.config.consumer !== 'client' || !ctx.file.includes('/src/client/')) return;
      const entry = this.environment.moduleGraph.getModuleById('\0virtual:client-entry');
      if (entry) this.environment.moduleGraph.invalidateModule(entry);
      this.environment.hot.send({ type: 'full-reload', path: '*' });
      stats.clientReloads = (stats.clientReloads ?? 0) + 1;
    },
    generateBundle(_, bundle) {
      if (this.environment.config.consumer === 'server') {
        // In the real plugin this comes from the server reachability result.
        if (!stats.table) throw new Error('server graph must run before client');
        serverRoutes = Object.fromEntries(Object.keys(stats.table).map(route => [route, route === '/admin' ? 'admin' : 'public']));
      } else {
        const entry = Object.values(bundle).find(o => o.type === 'chunk' && o.isEntry);
        manifest = { entry: '/' + entry.fileName };
        stats.manifest = manifest;
      }
    }
  };
}
