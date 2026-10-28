import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import MagicString from 'magic-string';
import { normalizePath } from 'vite';
import type { DevEnvironment, Plugin } from 'vite';
import type { GenerateResult } from '../gen/index.js';
import { locations } from '../gen/locations.js';
import { actionTransformVersion, emitRegistration, transform, isBannedModule } from '../htmx/transform/index.js';
import type { ActionTable } from '../htmx/index.js';
import type { TransformResult } from '../htmx/transform/index.js';
import type { RecoolerOptions } from './index.js';
import { routePathWithoutGroups, routeSegment } from '../router/resolve.js';
import { clientGate, gateFile, clientEntry, clientId, internalClient, clientFile, routeClientId, sliceQuery, type ClientRoute } from './client.js';

export const tableId = 'virtual:recooler/htmx';
const internalTable = '\0' + tableId;
const token = '__RECOOLER_ACTION_TABLE_6d32ad94__';
const versionToken = '__RECOOLER_CLIENT_VERSION_6d32ad94__';
const framework = normalizePath(fileURLToPath(new URL('../../', import.meta.url)));
const sourcePattern = /\.[cm]?[jt]sx?(?:\?|$)/;

/** Package identity must survive moving a checkout or rebuilding it in Docker. */
function appIdentity(srcDir: string): readonly string[] {
  let directory = srcDir;
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
      if (typeof pkg.name !== 'string' || !pkg.name.trim()) {
        throw new Error(`recooler: ${path.join(directory, 'package.json')} has no package name; set htmx.namespace or a nonempty package.json name`);
      }
      return [pkg.name, normalizePath(path.relative(directory, srcDir))];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('recooler: no package.json name found; set htmx.namespace or a nonempty package.json name');
    directory = parent;
  }
}

/** Strip only Vite transport queries. Meaningful plugin variants remain distinct. */
export function canonicalId(id: string): string {
  const at = id.indexOf('?');
  if (at < 0) return normalizePath(id);
  const parts = id.slice(at + 1).split('&').filter(part => !/^(?:v|t)=/.test(part));
  return normalizePath(id.slice(0, at)) + (parts.length ? '?' + parts.join('&') : '');
}

interface TableData { table: ActionTable; clients: ActionTable; enabled: boolean; onLoads?: string[]; preloads?: Record<string, string[]>; routeModules?: Record<string, string> }

interface State {
  tableLoaded: boolean;
  epoch: number;
  modules: Map<string, { actions: boolean; htmx: boolean; client?: boolean; onLoad?: boolean }>;
  cached?: TableData & { epoch: number };
  pending?: Promise<TableData>;
  outputs: Map<string, string>;
  transforms: Map<string, { source: string; kind: string; result: TransformResult }>;
}

/** Shared by build and dev: propagate each action identity through reverse static edges. */
function propagateActions(parents: Map<string, Set<string>>, actionModules: Iterable<[string, string]>): Map<string, Set<string>> {
  const reachable = new Map<string, Set<string>>();
  for (const [id, action] of actionModules) {
    const queue = [id];
    const seen = new Set<string>();
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index]!;
      if (seen.has(current)) continue;
      seen.add(current);
      let actions = reachable.get(current);
      if (!actions) reachable.set(current, actions = new Set());
      actions.add(action);
      queue.push(...parents.get(current) ?? []);
    }
  }
  return reachable;
}

/** Server graph ownership is separate from the app entry, for Phase 5/custom entries. */
export function htmxPlugin(options: RecoolerOptions) {
  let roots: ReturnType<typeof locations>;
  let serving = false;
  let devServer: import('vite').ViteDevServer | undefined;
  let entryUrl: string;
  let buildId: string;
  let base: string;
  const rendered = new Map<string, Promise<TableData>>();
  let clientBuild: (() => Promise<unknown>) | undefined;
  let rebuildingClient = Promise.resolve<unknown>(undefined);
  let builtData: TableData | undefined;
  let clientData: string | undefined;
  const sliceContents = new Set<string>();
  let files: string[] = [];
  let routeSeeds: { file: string; chain: string[]; pattern: string }[] = [];
  const dependencyRoots = new Set<string>();
  const kinds = new Map<string, 'route' | 'layout' | 'root'>();
  let projectNamespace: string;
  const namespaceFor = (name: string) => projectNamespace + ':' + name;
  let generationFailed = false;
  const states = new Map<string, State>();
  const stateFor = (name: string) => {
    let value = states.get(name);
    if (!value) states.set(name, value = { tableLoaded: false, epoch: 0, modules: new Map(), outputs: new Map(), transforms: new Map() });
    return value;
  };
  const selected = (environment: { name: string; config: { consumer: string } }) =>
    environment.config.consumer === 'server' && (options.serverEnvironment === undefined || options.serverEnvironment === environment.name);
  const relative = (id: string) => {
    const canonical = canonicalId(id);
    const at = canonical.indexOf('?');
    return normalizePath(path.relative(roots.srcDir, at < 0 ? canonical : canonical.slice(0, at))) + (at < 0 ? '' : canonical.slice(at));
  };
  // Do not walk into our own table (custom entries can import it), or inject a
  // registration into framework internals, which would create runtime cycles.
  const source = (id: string) => path.isAbsolute(id.split('?')[0]!) && sourcePattern.test(id)
    && !id.startsWith(framework + 'src/') && !id.startsWith(framework + 'dist/')
    && !id.includes('/.vite/');

  async function devTable(environment: DevEnvironment): Promise<TableData> {
    const state = stateFor(environment.name);
    if (state.cached?.epoch === state.epoch) return state.cached;
    if (state.pending) return state.pending;
    state.pending = (async () => {
      // Transforms themselves advance the epoch. A cold or edited graph may
      // therefore need a second pass; never publish a mixed-generation table.
      for (;;) {
        const epoch = state.epoch;
        type Node = { id: string; deps: string[]; page: boolean };
        const adjacency = new Map<string, Promise<Node>>();
        const resolutions = new Map<string, Promise<Node | undefined>>();
        const edges = (url: string) => {
          url = canonicalId(url);
          let pending = resolutions.get(url);
          if (!pending) {
            pending = (async () => {
              const resolved = await environment.pluginContainer.resolveId(url);
              if (!resolved || resolved.external || resolved.id === internalTable) return;
              const id = canonicalId(resolved.id);
              let node = adjacency.get(id);
              if (!node) {
                node = (async () => {
                  const result = await environment.transformRequest(id);
                  const lowered = result ?? environment.moduleGraph.getModuleById(id)?.transformResult;
                  // Vite 8.3's module runner lowers named/default exports to
                  // exportName calls. Read only lowered STATIC deps, never the
                  // graph's importedModules (which includes dynamic imports).
                  return { id, deps: lowered?.deps ?? [], page: /__vite_ssr_exportName__\(\s*["']default["']|__vite_ssr_exports__\s*,\s*["']default["']|__vite_ssr_exports__\.default\s*=/.test(lowered?.code ?? '') };
                })();
                adjacency.set(id, node);
              }
              return node;
            })();
            resolutions.set(url, pending);
          }
          return pending;
        };
        // Discover the shared graph once, in parallel. Walking the same runtime
        // closure independently for every route creates O(routes * shared deps)
        // promise traffic even with cached adjacency.
        const nodes = new Map<string, Node>();
        const discover = async (url: string): Promise<void> => {
          const node = await edges(url);
          if (!node || nodes.has(node.id)) return;
          nodes.set(node.id, node);
          await Promise.all(node.deps.map(discover));
        };
        const routes = routeSeeds;
        await Promise.all(routes.flatMap(route => route.chain).map(discover));
        const parents = new Map<string, Set<string>>();
        await Promise.all([...nodes.values()].map(async node => {
          await Promise.all(node.deps.map(async url => {
            const dependency = await edges(url);
            if (!dependency) return;
            let importers = parents.get(dependency.id);
            if (!importers) parents.set(dependency.id, importers = new Set());
            importers.add(node.id);
          }));
        }));
        // Propagate only action identities through reverse static edges. Each
        // (action, importer) pair is visited once; cycles need no recursive
        // promise or special evaluation ordering.
        const reachable = propagateActions(parents, [...nodes.keys()]
          .filter(id => state.modules.get(id)?.actions || state.modules.get(id)?.client).map(id => [id, id]));
        const table: Record<string, string[]> = Object.create(null);
        const clients: Record<string, string[]> = Object.create(null);
        await Promise.all(routes.map(async ({ file, chain }) => {
          if (!(await edges(file))?.page) return;
          const actions = new Set<string>();
          for (const seed of chain) {
            const node = await edges(seed);
            for (const action of node && reachable.get(node.id) || []) actions.add(action);
          }
          table[relative(file)] = [...actions].filter(id => state.modules.get(id)?.actions).map(relative).sort();
          clients[relative(file)] = [...actions].filter(id => state.modules.get(id)?.client).map(relative).sort();
        }));
        if (epoch !== state.epoch) continue;
        const enabled = options.htmx !== false;
        state.cached = { epoch, table, clients, enabled, onLoads: routes.filter(({ file }) => state.modules.get(canonicalId(file))?.onLoad).map(({ file }) => relative(file)).sort() };
        return state.cached;
      }
    })();
    try { return await state.pending; }
    finally { state.pending = undefined; }
  }

  const sliceIds = () => [...new Set(Object.values(builtData?.clients ?? {}).flat())].sort();
  const sliceFile = (id: string) => `assets/recooler-slice-${buildId}-${sliceIds().indexOf(id)}.js`;
  const routeKey = (file: string) => createHash('sha256').update(file).digest('hex').slice(0, 20);
  const routeModules = (data: TableData) => Object.fromEntries(Object.entries(data.clients).filter(([, ids]) => ids.length).map(([route]) => [route,
    serving ? `${base}@id/${routeClientId}${routeKey(route)}` : `${base}assets/recooler-route-${routeKey(route)}.js?v=${buildId}`]));
  const preloads = (data: TableData) => Object.fromEntries(Object.entries(data.clients).map(([route, ids]) => [route,
    ids.map(id => serving ? `${base}@fs${normalizePath(path.resolve(roots.srcDir, id))}?${sliceQuery}` : base + sliceFile(id))]));

  const plugin: Plugin = {
    name: 'recooler:htmx',
    enforce: 'pre',
    config(_config, env) {
      if (_config.base !== undefined && !_config.base.startsWith('/') && !/^https?:\/\//.test(_config.base)) throw new Error('recooler: relative Vite base is unsupported; configure an absolute path prefix');
      // Applies to custom createApp entries too; no runtime evaluation of a
      // Worker bundle in Node is needed to enforce the production guard.
      return {
        ...(options.htmx === false ? {} : { builder: {} }),
        define: { __RECOOLER_PRODUCTION__: JSON.stringify(env.command === 'build') },
        ...(options.htmx === false ? {} : { environments: { client: { consumer: 'client', build: {
          ssr: false, outDir: _config.environments?.client?.build?.outDir ?? 'dist/client',
          sourcemap: _config.environments?.client?.build?.sourcemap ?? false,
          minify: _config.environments?.client?.build?.minify ?? true,
          rolldownOptions: {
            preserveEntrySignatures: 'exports-only',
            input: (() => {
              const input = _config.environments?.client?.build?.rolldownOptions?.input
                ?? (existsSync(path.resolve(_config.root ?? process.cwd(), 'index.html')) ? 'index.html' : {});
              if (Array.isArray(input)) return [clientId]; // Vite concatenates the user's array.
              const entries = typeof input === 'string' ? [input] : undefined;
              const merged = { ...(entries ? Object.fromEntries(entries.map(id => [path.basename(id, path.extname(id)), id])) : typeof input === 'object' && !Array.isArray(input) ? input : {}) };
              let name = 'recooler-client';
              while (Object.hasOwn(merged, name)) name += '_';
              return { ...merged, [name]: clientId };
            })(),
            output: { entryFileNames: chunk => {
              if (chunk.facadeModuleId === internalClient) return clientFile;
              const output = _config.environments?.client?.build?.rolldownOptions?.output;
              const naming = (Array.isArray(output) ? output[0] : output)?.entryFileNames;
              return typeof naming === 'function' ? naming(chunk) : naming ?? 'assets/[name]-[hash].js';
            }, inlineDynamicImports: false },
          },
        } } } }),
      };
    },
    configResolved(config) {
      states.clear();
      builtData = undefined; clientData = undefined;
      buildId = versionToken;
      base = config.base;
      entryUrl = config.command === 'serve' ? `${base}@id/${clientId}` : `${base}${clientFile}?v=${buildId}`;
      roots = locations({ ...options.routes, cwd: options.routes?.cwd ?? config.root });
      serving = config.command === 'serve';
      const identity = options.htmx === false ? 'disabled' : options.htmx?.namespace ?? appIdentity(roots.srcDir);
      if (typeof identity === 'string' && !identity.trim()) throw new Error('recooler: htmx.namespace must be nonempty');
      projectNamespace = 'recooler:' + createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 24)
        + (serving ? ':' + randomUUID() : '');
    },
    configureServer(server) {
      devServer = server;
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== base + gateFile) return next();
        res.setHeader('Content-Type', 'text/javascript');
        res.end(clientGate(true));
      });
    },
    // A post hook leaves platform builders intact. Cloudflare has already built
    // Worker -> client (and moved assets); plain Vite's default builder is a no-op.
    buildApp: { order: 'post', async handler(builder) {
      if (options.htmx === false) return;
      for (const environment of Object.values(builder.environments)) {
        if (selected(environment) && !environment.isBuilt) await builder.build(environment);
      }
      const client = builder.environments.client;
      if (client?.config.build.watch) {
        // One server watcher owns generation order. Independent client watchers
        // can race the server table and retain a stale virtual route entry.
        clientBuild = async () => {
          const watch = client.config.build.watch;
          client.config.build.watch = null;
          try { return await builder.build(client); }
          finally { client.config.build.watch = watch; }
        };
      } else if (client && !client.isBuilt) await builder.build(client);
    } },
    outputOptions(output) {
      if (this.environment.name !== 'client') return;
      const naming = output.chunkFileNames;
      output.chunkFileNames = chunk => {
        const id = chunk.facadeModuleId;
        if (id?.includes(sliceQuery)) return sliceFile(relative(id.replace(new RegExp('([?&])' + sliceQuery + '(?=&|$)'), '')));
        return typeof naming === 'function' ? naming(chunk) : naming ?? 'assets/[name]-[hash].js';
      };
    },
    buildStart() {
      if (selected(this.environment)) {
        rendered.delete(this.environment.name);
        this.addWatchFile(roots.routesDir);
      }
      if (this.environment.name === 'client') {
        sliceContents.clear();
        this.emitFile({ type: 'asset', fileName: gateFile, source: clientGate() });
        for (const id of sliceIds()) this.emitFile({ type: 'chunk',
          id: normalizePath(path.resolve(roots.srcDir, id)) + (id.includes('?') ? '&' : '?') + sliceQuery, fileName: sliceFile(id) });
        for (const [file, ids] of Object.entries(builtData?.clients ?? {})) if (ids.length) {
          const key = routeKey(file);
          this.emitFile({ type: 'chunk', id: routeClientId + key, fileName: `assets/recooler-route-${key}.js` });
        }
      }
    },
    async writeBundle() {
      if (!selected(this.environment) || !clientBuild) return;
      rebuildingClient = rebuildingClient.catch(() => {}).then(() => clientBuild!());
      await rebuildingClient;
    },
    watchChange(file) {
      if (serving) return;
      // Rolldown may retain unchanged modules without calling transform again.
      // Preserve their metadata and clear only changed source identities, even
      // when removing hx- makes the filtered transform stop matching entirely.
      file = canonicalId(file).split('?')[0]!;
      for (const state of states.values()) {
        for (const id of state.modules.keys()) if (id.split('?')[0] === file) state.modules.delete(id);
        state.epoch++;
      }
    },
    async hotUpdate(context) {
      if (!selected(this.environment) || options.htmx === false || !context.modules.length) return;
      // Generation errors have their own overlay/invalidation path. Eagerly
      // importing an invalid manifest only repeats the same diagnostic.
      if (generationFailed) return [];
      const state = stateFor(this.environment.name);
      if (!state.tableLoaded) return;
      state.epoch++;
      // Vite invalidates the changed module normally. Refresh the table and its
      // importers, retaining unchanged transforms while reloading the runner.
      const table = this.environment.moduleGraph.getModuleById(internalTable);
      if (table) this.environment.moduleGraph.invalidateModule(table);
      const signature = (data?: TableData) => JSON.stringify([data?.clients, data?.onLoads]);
      const before = signature(state.cached);
      const after = signature(await devTable(this.environment as DevEnvironment));
      if (before !== after) {
        const client = context.server.environments.client;
        client?.moduleGraph.invalidateAll();
        client?.hot.send({ type: 'full-reload', path: '*' });
      }
      this.environment.hot.send({ type: 'full-reload', path: '*' });
      return [];
    },
    async resolveId(id, importer) {
      if (this.environment.name === 'client' && id !== clientId && !id.includes(sliceQuery)
        && isBannedModule(options.htmx && options.htmx.clientBannedImports || [], id)) {
        const chain = [id];
        const seen = new Set<string>();
        for (let current = importer; current && !seen.has(current); current = this.getModuleInfo(current)?.importers[0]) {
          seen.add(current); chain.unshift(current);
        }
        this.error(`recooler: banned imports in client chunk (raw specifier): ${chain.join(' → ')}`);
      }
      if (id === clientId) return internalClient;
      if (id.startsWith(routeClientId)) return '\0' + id;
      const query = id.indexOf('?');
      if (query >= 0 && id.slice(query + 1).split('&').includes(sliceQuery)) {
        if (this.environment.name !== 'client') this.error('recooler: handler slices require the client environment');
        const original = id.slice(0, query) + (id.slice(query + 1).split('&').filter(p => p !== sliceQuery && !/^(?:v|t)=/.test(p)).length
          ? '?' + id.slice(query + 1).split('&').filter(p => p !== sliceQuery && !/^(?:v|t)=/.test(p)).join('&') : '');
        const resolved = await this.resolve(original, importer, { skipSelf: true });
        if (!resolved || resolved.external) this.error(`recooler: cannot resolve handler slice ${original}`);
        const key = canonicalId(resolved.id);
        const known = [...states.values()].some(state => state.modules.get(key)?.client);
        const inSource = !path.relative(roots.srcDir, key.split('?')[0]!).startsWith('..') && sourcePattern.test(key);
        if (!known && !inSource) this.error(`recooler: unauthorized handler slice ${original}`);
        return resolved.id + (resolved.id.includes('?') ? '&' : '?') + sliceQuery;
      }
      if (id !== tableId) return;
      if (!selected(this.environment)) this.error('recooler: virtual:recooler/htmx requires the selected server environment');
      return internalTable;
    },
    async load(id) {
      if (id.startsWith('\0' + routeClientId)) {
        if (this.environment.name !== 'client') this.error('recooler: route modules require the client environment');
        const environment = serving ? Object.values(devServer?.environments ?? {}).find(selected) : undefined;
        const data = environment ? await devTable(environment) : builtData;
        const file = Object.keys(data?.clients ?? {}).find(file => routeKey(file) === id.slice(routeClientId.length + 1));
        if (!file) this.error('recooler: unknown client route');
        const ids = [...new Set(Object.values(data!.clients).flat())].sort();
        const modules = data!.clients[file]!;
        return { code: `import { register } from ${JSON.stringify(clientId)};\nexport { init } from ${JSON.stringify(clientId)};\n`
          + modules.map((module, i) => `import * as m${i} from ${JSON.stringify(normalizePath(path.resolve(roots.srcDir, module)) + '?' + sliceQuery)};`).join('\n')
          + `\nregister([${modules.map((module, i) => `[${JSON.stringify(String(ids.indexOf(module)))},m${i}]`).join(',')}]);`, map: null };
      }
      if (id === internalClient) {
        if (this.environment.name !== 'client') this.error('recooler: client entry requires the client environment');
        const environment = serving ? Object.values(devServer?.environments ?? {}).find(selected) : undefined;
        const data = environment ? await devTable(environment) : builtData;
        if (!data) this.error('recooler: build the selected server environment before the client environment');
        clientData = JSON.stringify(data.clients);
        const routes: Record<string, ClientRoute> = Object.create(null);
        for (const { file, pattern } of routeSeeds) {
          const modules = data.clients[relative(file)];
          if (!modules?.length) continue;
          const state = stateFor(environment?.name ?? [...states.keys()].find(name => states.get(name)?.cached?.clients === data.clients) ?? '');
          const onLoad = state.modules.get(canonicalId(file))?.onLoad;
          routes[pattern] = { slices: [...modules], ...(onLoad ? { onLoad: relative(file) } : {}) };
        }
        for (const file of files) this.addWatchFile(file);
        return { code: clientEntry(routes, id => normalizePath(path.resolve(roots.srcDir, id)), serving ? '' : buildId, serving, id => serving ? `${base}@fs${normalizePath(path.resolve(roots.srcDir, id))}?${sliceQuery}` : base + sliceFile(id)), map: null };
      }
      if (id.split('?')[1]?.split('&').includes(sliceQuery)) {
        const original = id.replace(new RegExp('([?&])' + sliceQuery + '(?=&|$)'), '').replace('?&', '?');
        // Slice the exact input seen by the server, including earlier plugins.
        // Both hoisting and slicing share one map with redacted sourcesContent.
        if (serving) {
          const environment = Object.values(devServer?.environments ?? {}).find(selected);
          if (environment) await devTable(environment);
        }
        const key = canonicalId(original);
        const serverInput = [...states.values()].map(state => state.transforms.get(key)).find(Boolean);
        const known = [...states.values()].some(state => state.modules.get(key)?.client);
        const inSource = !path.relative(roots.srcDir, key.split('?')[0]!).startsWith('..') && sourcePattern.test(key);
        if (!known && !inSource) this.error(`recooler: unauthorized handler slice ${original}`);
        if (!serverInput) this.error(`recooler: no server transform input for handler slice ${original}`);
        const code = serverInput.source;
        const result = transform(code, { id: original, relativePath: relative(original), mode: 'client-slice',
          moduleKind: kinds.get(original.split('?')[0]!) ?? 'component',
          clientBannedImports: options.htmx && options.htmx.clientBannedImports || undefined });
        for (const diagnostic of result.diagnostics) {
          if (diagnostic.severity === 'error') this.error({ message: diagnostic.message, id: original, pos: diagnostic.start });
        }
        if (serverInput && JSON.stringify(result.handlers.map(h => h.id)) !== JSON.stringify(serverInput.result.handlers.map(h => h.id))) {
          this.error(`recooler: handler ids differ between server and client slice: ${original}`);
        }
        for (const content of result.map.sourcesContent ?? []) if (content) sliceContents.add(content);
        this.addWatchFile(original.split('?')[0]!);
        return { code: result.code, map: result.map.toString() };
      }
      if (id !== internalTable) return;
      if (!selected(this.environment)) this.error('recooler: virtual:recooler/htmx requires the selected server environment');
      stateFor(this.environment.name).tableLoaded = true;
      const namespace = namespaceFor(this.environment.name);
      const current = serving ? await devTable(this.environment as DevEnvironment) : undefined;
      const data = current ? JSON.stringify({ ...current, preloads: preloads(current), routeModules: routeModules(current) }) : token;
      return { code: `const data = JSON.parse(${JSON.stringify(data)});\nexport const table = data.table;\nexport const clients = data.clients;\nexport const clientPreloads = data.preloads ?? {};\nexport const clientModules = data.routeModules ?? {};\nexport const clientEntry = ${JSON.stringify(entryUrl)};\nexport const enabled = data.enabled;\nexport const namespace = ${JSON.stringify(namespace)};\n`, map: null };
    },
    transform: {
      filter: { id: sourcePattern, code: /hx-|onLoad/ },
      handler(code, id) {
        if (!selected(this.environment) || options.htmx === false || !source(id)) return;
        id = canonicalId(id);
        const moduleKind = kinds.get(id.split('?')[0]!) ?? 'component';
        const state = stateFor(this.environment.name);
        const namespace = namespaceFor(this.environment.name);
        const previous = serving ? state.transforms.get(id) : undefined;
        const result = previous?.source === code && previous.kind === moduleKind ? previous.result : transform(code, {
          id, relativePath: relative(id), mode: 'server', moduleKind, queueHandlers: true,
          clientBannedImports: options.htmx && options.htmx.clientBannedImports,
          codegen: { registerActions: input => emitRegistration({ ...input, namespace,
            moduleHash: createHash('sha256').update(JSON.stringify([actionTransformVersion, code])).digest('hex') }) },
        });
        // Full runner reloads refresh module evaluation, but scope analysis is
        // pure. Keep one source version per module across full dev reloads.
        state.transforms.set(id, { source: code, kind: moduleKind, result });
        for (const diagnostic of result.diagnostics) {
          const before = code.slice(0, diagnostic.start);
          const line = before.split('\n').length;
          const column = before.length - before.lastIndexOf('\n') - 1;
          const log = { message: `${relative(id)}:${line}:${column + 1}: ${diagnostic.message}`, id, pos: diagnostic.start,
            loc: { file: id, line, column } };
          if (diagnostic.severity === 'error') this.error(log);
          else this.warn(log);
        }
        state.modules.set(id, { actions: result.actions.length > 0, htmx: true, client: result.handlers.length > 0 || result.hasOnLoad, onLoad: result.hasOnLoad });
        if (serving) state.outputs.set(id, result.code);
        state.epoch++;
        // Give Vite a fresh map object; normalization must not mutate a cached map.
        return { code: result.code, map: result.map.toString() };
      },
    },
    async renderChunk(code) {
      if (!selected(this.environment)) return;
      const state = stateFor(this.environment.name);
      if (!rendered.has(this.environment.name)) rendered.set(this.environment.name, (async () => {
        // Discover each static edge once; share reverse propagation with dev.
        const nodes = new Map<string, { deps: readonly string[]; page: boolean }>();
        const parents = new Map<string, Set<string>>();
        const queue = routeSeeds.flatMap(route => route.chain);
        for (let index = 0; index < queue.length; index++) {
          const id = queue[index]!;
          if (nodes.has(id)) continue;
          const info = this.getModuleInfo(id);
          if (!info) continue;
          nodes.set(id, { deps: info.importedIds, page: info.exports.includes('default') });
          for (const dependency of info.importedIds) {
            let importers = parents.get(dependency);
            if (!importers) parents.set(dependency, importers = new Set());
            importers.add(id);
            queue.push(dependency);
          }
        }
        const reachable = propagateActions(parents, [...nodes.keys()]
          .filter(id => state.modules.get(canonicalId(id))?.actions || state.modules.get(canonicalId(id))?.client).map(id => [id, id]));
        const table: Record<string, string[]> = Object.create(null);
        const clients: Record<string, string[]> = Object.create(null);
        for (const { file, chain } of routeSeeds) {
          if (!nodes.get(file)?.page) continue;
          const actions = new Set(chain.flatMap(id => [...reachable.get(id) ?? []]));
          table[relative(file)] = [...actions].filter(id => state.modules.get(canonicalId(id))?.actions).map(relative).sort();
          clients[relative(file)] = [...actions].filter(id => state.modules.get(canonicalId(id))?.client).map(relative).sort();
        }
        const enabled = options.htmx !== false && (options.htmx !== undefined || [...state.modules.values()].some(m => m.htmx));
        // Derive the version from source/configuration inputs rather than a
        // random UUID. Client-only source inputs are included below too.
        const clientBuild = this.environment.config.environments.client?.build;
        const hash = createHash('sha256').update(JSON.stringify(clients)).update(clientEntry.toString()).update(clientGate.toString())
          .update(JSON.stringify({ base, minify: clientBuild?.minify, target: clientBuild?.target,
            sourcemap: clientBuild?.sourcemap, define: this.environment.config.define,
            banned: options.htmx && options.htmx.clientBannedImports?.map(String) }));
        for (const id of [...this.getModuleIds()].sort((a, b) => relative(a).localeCompare(relative(b)))) {
          const info = this.getModuleInfo(id);
          if (id === internalTable || !info?.code) continue;
          hash.update(relative(id)).update(state.transforms.get(canonicalId(id))?.source ?? info.code);
        }
        // Server pruning can remove imports used only by a browser handler.
        // Include source-tree inputs too, so changing such a helper changes the
        // version even though it never appears in the surviving server graph.
        const inputs: string[] = [];
        const discover = async (directory: string): Promise<void> => {
          const entries = await readdir(directory, { withFileTypes: true });
          await Promise.all(entries.map(async entry => {
            if (['node_modules', '.git', '.cache', 'dist'].includes(entry.name)) return;
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) await discover(file);
            else if (entry.isFile()) inputs.push(file);
          }));
        };
        await discover(roots.srcDir);
        for (const file of inputs.sort()) {
          hash.update(relative(file)).update(new Uint8Array(await readFile(file)));
          this.addWatchFile(file);
        }
        for (const name of ['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock']) {
          const file = path.join(roots.cwd, name);
          if (existsSync(file)) { hash.update(name).update(new Uint8Array(await readFile(file))); this.addWatchFile(file); }
        }
        buildId = hash.digest('hex').slice(0, 20);
        builtData = { table, clients, enabled };
        builtData.preloads = preloads(builtData);
        builtData.routeModules = routeModules(builtData);
        state.cached = { ...builtData, epoch: state.epoch };
        return builtData;
      })());
      const data = await rendered.get(this.environment.name)!;
      if (!code.includes(token) && !code.includes(versionToken)) return;
      const ms = new MagicString(code);
      let safeMap = true;
      for (const match of code.matchAll(new RegExp(token + '|' + versionToken, 'g'))) {
        const lineEnd = code.indexOf('\n', match.index);
        if (!/^[\s\"');]*$/.test(code.slice(match.index + match[0].length, lineEnd < 0 ? undefined : lineEnd))) safeMap = false;
        ms.overwrite(match.index, match.index + match[0].length, match[0] === token
          ? JSON.stringify(JSON.stringify(data)).slice(1, -1) : buildId);
      }
      return { code: ms.toString(), map: safeMap ? null : ms.generateMap({ hires: 'boundary', includeContent: true }) };
    },
    generateBundle(_options, bundle) {
      if (this.environment.name !== 'client') return;
      if (clientData !== JSON.stringify(builtData?.clients)) this.error('recooler: client route → slice table differs from the server build');
      if (!Object.values(bundle).some(chunk => chunk.type === 'chunk' && chunk.fileName === clientFile && chunk.facadeModuleId === internalClient)) {
        this.error(`recooler: ${clientFile} is not the Recooler client entry`);
      }
      // Unsliced dependencies can contain tree-shaken server exports. Their
      // maps retain mappings but never embed original source contents.
      const redactMap = (map: { sourcesContent?: (string | null)[] }) => {
        if (map.sourcesContent) map.sourcesContent = map.sourcesContent.map(content => content && sliceContents.has(content) ? content : null);
      };
      for (const output of Object.values(bundle)) {
        if (output.type === 'chunk') {
          if (output.map) redactMap(output.map);
          // Rolldown has already embedded inline maps by generateBundle. Update
          // that payload too; changing chunk.map alone leaves the public copy.
          output.code = output.code.replace(/(sourceMappingURL=data:application\/json[^,]*;base64,)([A-Za-z0-9+/=]+)/g, (_match, prefix: string, encoded: string) => {
            const map = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
            redactMap(map);
            return prefix + Buffer.from(JSON.stringify(map)).toString('base64');
          });
        }
        if (output.type === 'asset' && output.fileName.endsWith('.map') && typeof output.source === 'string') {
          const map = JSON.parse(output.source); redactMap(map); output.source = JSON.stringify(map);
        }
      }
      const patterns = options.htmx && options.htmx.clientBannedImports || [];
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        const banned = chunk.moduleIds.filter(id => id.includes("__vite-browser-external") || isBannedModule(patterns, id));
        const chains = banned.map(id => {
          const chain = [id];
          const seen = new Set<string>();
          for (let current = this.getModuleInfo(id)?.importers[0]; current && !seen.has(current); current = this.getModuleInfo(current)?.importers[0]) {
            seen.add(current); chain.unshift(current);
          }
          return chain.join(' → ');
        });
        if (banned.length) this.error(`recooler: banned imports in client chunk ${chunk.fileName}:\n${chains.join('\n')}`);
      }
    },
  };

  // A separate hook is intentional: the expensive scope transform has an hx-
  // content filter, while dev MUST clear registrations even in unchanged/plain
  // modules after a server restart. Appending preserves the earlier transform map.
  const registration: Plugin = {
    name: 'recooler:htmx-dev-registration',
    enforce: 'pre',
    transform: {
      filter: { id: sourcePattern },
      handler(code, id) {
        if (!serving || !selected(this.environment) || options.htmx === false || !source(id)) return;
        id = canonicalId(id);
        const state = stateFor(this.environment.name);
        if (!state.tableLoaded) return;
        const file = id.split('?')[0]!;
        const inside = (directory: string) => file.startsWith(directory + '/');
        if (!inside(normalizePath(roots.srcDir)) && ![...dependencyRoots].some(inside) && !state.transforms.has(id)) return;
        const namespace = namespaceFor(this.environment.name);
        if (state.outputs.get(id) === code && state.modules.get(id)?.htmx) return;
        state.modules.set(id, { actions: false, htmx: code.includes('hx-') });
        state.epoch++;
        const ms = new MagicString(code);
        let helper = '__recooler_clear_' + createHash('sha256').update(id).digest('hex');
        while (code.includes(helper)) helper += '_';
        ms.append(`\nimport { registerActions as ${helper} } from 'recooler/htmx/runtime';\n${helper}(${JSON.stringify(relative(id))}, {}, ${JSON.stringify(namespace)});\n`);
        return { code: ms.toString(), map: ms.generateMap({ hires: true, source: id, includeContent: true }) };
      },
    },
  };
  return {
    plugins: [plugin, registration],
    actionDependencies(names: readonly string[], root: string) {
      const require = createRequire(path.join(root, 'package.json'));
      dependencyRoots.clear();
      for (const name of names) {
        // resolve() follows workspace symlinks as well as pnpm's package store.
        let file: string;
        try { file = require.resolve(name); } catch { continue; }
        for (let directory = path.dirname(file); path.dirname(directory) !== directory; directory = path.dirname(directory)) {
          try {
            if (JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8')).name === name) {
              dependencyRoots.add(normalizePath(directory));
              break;
            }
          } catch { /* Keep walking to the package root. */ }
        }
      }
    },
    generationFailed(failed: boolean) { generationFailed = failed; },
    generated(result: GenerateResult) {
      files = result.files.map(normalizePath);
      const absolute = (file: string) => normalizePath(path.resolve(roots.srcDir, file));
      routeSeeds = result.routes.map(({ file, layoutFiles, rootFile }) => ({ file: absolute(file),
        pattern: routePathWithoutGroups('/' + normalizePath(path.relative(roots.routesDir, path.dirname(absolute(file)))).split('/').filter(segment => segment && segment !== '.').map(routeSegment).join('/')),
        chain: [file, ...layoutFiles, rootFile].filter((file): file is string => file !== undefined).map(absolute) }));
      kinds.clear();
      for (const file of files) {
        if (/\/index\.[jt]sx?$/.test(file)) kinds.set(file, 'route');
        else if (/\/layout\.[jt]sx?$/.test(file)) kinds.set(file, 'layout');
        else if (file === normalizePath(path.join(roots.srcDir, 'root.tsx'))) kinds.set(file, 'root');
      }
      for (const state of states.values()) state.epoch++;
    },
  };
}
