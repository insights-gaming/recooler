import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import MagicString from 'magic-string';
import { normalizePath } from 'vite';
import type { DevEnvironment, Plugin } from 'vite';
import type { GenerateResult } from '../gen/index.js';
import { locations } from '../gen/locations.js';
import { actionTransformVersion, emitRegistration, transform } from '../htmx/transform/index.js';
import type { ActionTable } from '../htmx/index.js';
import type { TransformResult } from '../htmx/transform/index.js';
import type { RecoolerOptions } from './index.js';

export const tableId = 'virtual:recooler/htmx';
const internalTable = '\0' + tableId;
const token = '__RECOOLER_ACTION_TABLE_6d32ad94__';
const framework = normalizePath(fileURLToPath(new URL('../../', import.meta.url)));
const sourcePattern = /\.[cm]?[jt]sx?(?:\?|$)/;

/** Package identity must survive moving a checkout or rebuilding it in Docker. */
function appIdentity(srcDir: string): readonly string[] {
  let directory = srcDir;
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
      return [typeof pkg.name === 'string' ? pkg.name : '', normalizePath(path.relative(directory, srcDir))];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return ['', normalizePath(path.relative(directory, srcDir))];
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

interface State {
  tableLoaded: boolean;
  epoch: number;
  modules: Map<string, { actions: boolean; htmx: boolean }>;
  cached?: { epoch: number; table: ActionTable; enabled: boolean };
  pending?: Promise<{ table: ActionTable; enabled: boolean }>;
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
  let routeSeeds: { file: string; chain: string[] }[] = [];
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

  async function devTable(environment: DevEnvironment): Promise<{ table: ActionTable; enabled: boolean }> {
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
          .filter(id => state.modules.get(id)?.actions).map(id => [id, relative(id)]));
        const table: Record<string, string[]> = Object.create(null);
        await Promise.all(routes.map(async ({ file, chain }) => {
          if (!(await edges(file))?.page) return;
          const actions = new Set<string>();
          for (const seed of chain) {
            const node = await edges(seed);
            for (const action of node && reachable.get(node.id) || []) actions.add(action);
          }
          table[relative(file)] = [...actions].sort();
        }));
        if (epoch !== state.epoch) continue;
        const enabled = options.htmx !== false;
        state.cached = { epoch, table, enabled };
        return state.cached;
      }
    })();
    try { return await state.pending; }
    finally { state.pending = undefined; }
  }

  const plugin: Plugin = {
    name: 'recooler:htmx',
    enforce: 'pre',
    config(_config, env) {
      // Applies to custom createApp entries too; no runtime evaluation of a
      // Worker bundle in Node is needed to enforce the production guard.
      return { define: { __RECOOLER_PRODUCTION__: JSON.stringify(env.command === 'build') } };
    },
    configResolved(config) {
      states.clear();
      roots = locations({ ...options.routes, cwd: options.routes?.cwd ?? config.root });
      serving = config.command === 'serve';
      const identity = options.htmx && options.htmx.namespace !== undefined ? options.htmx.namespace : appIdentity(roots.srcDir);
      if (identity === '') throw new Error('recooler: htmx.namespace must be nonempty');
      projectNamespace = 'recooler:' + createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 24)
        + (serving ? ':' + randomUUID() : '');
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
      if (!selected(this.environment) || options.htmx === false) return;
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
      this.environment.hot.send({ type: 'full-reload', path: '*' });
      return [];
    },
    resolveId(id) {
      if (id !== tableId) return;
      if (!selected(this.environment)) this.error('recooler: virtual:recooler/htmx requires the selected server environment');
      return internalTable;
    },
    async load(id) {
      if (id !== internalTable) return;
      if (!selected(this.environment)) this.error('recooler: virtual:recooler/htmx requires the selected server environment');
      stateFor(this.environment.name).tableLoaded = true;
      const namespace = namespaceFor(this.environment.name);
      const data = serving ? JSON.stringify(await devTable(this.environment as DevEnvironment)) : token;
      return { code: `const data = JSON.parse(${JSON.stringify(data)});\nexport const table = data.table;\nexport const enabled = data.enabled;\nexport const namespace = ${JSON.stringify(namespace)};\n`, map: null };
    },
    transform: {
      filter: { id: sourcePattern, code: 'hx-' },
      handler(code, id) {
        if (!selected(this.environment) || options.htmx === false || !source(id)) return;
        id = canonicalId(id);
        const moduleKind = kinds.get(id.split('?')[0]!) ?? 'component';
        const state = stateFor(this.environment.name);
        const namespace = namespaceFor(this.environment.name);
        const previous = serving ? state.transforms.get(id) : undefined;
        const result = previous?.source === code && previous.kind === moduleKind ? previous.result : transform(code, {
          id, relativePath: relative(id), mode: 'server', moduleKind,
          clientBannedImports: options.htmx && options.htmx.clientBannedImports,
          codegen: { registerActions: input => emitRegistration({ ...input, namespace,
            moduleHash: createHash('sha256').update(JSON.stringify([actionTransformVersion, code])).digest('hex') }) },
        });
        // Full runner reloads refresh module evaluation, but scope analysis is
        // pure. Keep one source version per module across full dev reloads.
        if (serving) state.transforms.set(id, { source: code, kind: moduleKind, result });
        for (const diagnostic of result.diagnostics) {
          const before = code.slice(0, diagnostic.start);
          const line = before.split('\n').length;
          const column = before.length - before.lastIndexOf('\n') - 1;
          const log = { message: `${relative(id)}:${line}:${column + 1}: ${diagnostic.message}`, id, pos: diagnostic.start,
            loc: { file: id, line, column } };
          if (diagnostic.severity === 'error') this.error(log);
          else this.warn(log);
        }
        state.modules.set(id, { actions: result.actions.length > 0, htmx: true });
        if (serving) state.outputs.set(id, result.code);
        state.epoch++;
        // Give Vite a fresh map object; normalization must not mutate a cached map.
        return { code: result.code, map: result.map.toString() };
      },
    },
    renderChunk(code) {
      if (!selected(this.environment) || !code.includes(token)) return;
      const state = stateFor(this.environment.name);
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
        .filter(id => state.modules.get(canonicalId(id))?.actions).map(id => [id, relative(id)]));
      const table: Record<string, string[]> = Object.create(null);
      for (const { file, chain } of routeSeeds) {
        if (!nodes.get(file)?.page) continue;
        const actions = new Set(chain.flatMap(id => [...reachable.get(id) ?? []]));
        table[relative(file)] = [...actions].sort();
      }
      const enabled = options.htmx !== false && (options.htmx !== undefined || [...state.modules.values()].some(m => m.htmx));
      const ms = new MagicString(code);
      const needle = JSON.stringify(token);
      const start = code.indexOf(needle);
      if (start < 0) this.error('recooler: action table placeholder must remain a string literal');
      ms.overwrite(start, start + needle.length, JSON.stringify(JSON.stringify({ table, enabled })));
      // With no later code on this line, expanding the literal cannot move
      // any mapped code. Minified/combined lines need a composed boundary map.
      const lineEnd = code.indexOf('\n', start);
      const suffix = code.slice(start + needle.length, lineEnd < 0 ? undefined : lineEnd);
      return { code: ms.toString(), map: /^[\s);]*$/.test(suffix) ? null
        : ms.generateMap({ hires: 'boundary', includeContent: true }) };
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
        if (state.outputs.get(id) === code && state.modules.get(id)?.actions) return;
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
      const files = result.files.map(normalizePath);
      const absolute = (file: string) => normalizePath(path.resolve(roots.srcDir, file));
      routeSeeds = result.routes.map(({ file, layoutFiles, rootFile }) => ({ file: absolute(file),
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
