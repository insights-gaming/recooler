import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MagicString from 'magic-string';
import { normalizePath } from 'vite';
import type { DevEnvironment, Plugin } from 'vite';
import type { GenerateResult } from '../gen/index.js';
import { locations } from '../gen/locations.js';
import { emitRegistration, transform } from '../htmx/transform/index.js';
import type { ActionTable } from '../htmx/index.js';
import type { RecoolerOptions } from './index.js';

export const tableId = 'virtual:recooler/htmx';
const internalTable = '\0' + tableId;
const token = '__RECOOLER_ACTION_TABLE_6d32ad94__';
const framework = normalizePath(fileURLToPath(new URL('../../', import.meta.url)));
const sourcePattern = /\.[cm]?[jt]sx?(?:\?|$)/;

/** Strip only Vite transport queries. Meaningful plugin variants remain distinct. */
export function canonicalId(id: string): string {
  const at = id.indexOf('?');
  if (at < 0) return normalizePath(id);
  const parts = id.slice(at + 1).split('&').filter(part => !/^(?:v|t)=/.test(part));
  return normalizePath(id.slice(0, at)) + (parts.length ? '?' + parts.join('&') : '');
}

interface State {
  epoch: number;
  modules: Map<string, { actions: boolean; htmx: boolean }>;
  cached?: { epoch: number; table: ActionTable; enabled: boolean };
  pending?: Promise<{ table: ActionTable; enabled: boolean }>;
  outputs: Map<string, string>;
}

/** Server graph ownership is separate from the app entry, for Phase 5/custom entries. */
export function htmxPlugin(options: RecoolerOptions) {
  let roots: ReturnType<typeof locations>;
  let serving = false;
  let files: string[] = [];
  const kinds = new Map<string, 'route' | 'layout' | 'root'>();
  let namespace: string;
  let generationFailed = false;
  const states = new Map<string, State>();
  const stateFor = (name: string) => {
    let value = states.get(name);
    if (!value) states.set(name, value = { epoch: 0, modules: new Map(), outputs: new Map() });
    return value;
  };
  const selected = (environment: { name: string; config: { consumer: string } }) =>
    environment.config.consumer === 'server' && (options.serverEnvironment === undefined || options.serverEnvironment === environment.name);
  const relative = (id: string) => {
    const canonical = canonicalId(id);
    const at = canonical.indexOf('?');
    return normalizePath(path.relative(roots.srcDir, at < 0 ? canonical : canonical.slice(0, at))) + (at < 0 ? '' : canonical.slice(at));
  };
  const seeds = () => {
    const root = files.find(file => file === normalizePath(path.join(roots.srcDir, 'root.tsx')));
    const layouts = new Map(files.filter(file => /\/layout\.[jt]sx?$/.test(file)).map(file => [path.dirname(file), file]));
    return files.filter(file => /\/index\.[jt]sx?$/.test(file)).map(file => {
      const chain = [file];
      for (let directory = path.dirname(file);; directory = path.dirname(directory)) {
        const layout = layouts.get(directory);
        if (layout) chain.push(layout);
        if (directory === roots.routesDir || path.dirname(directory) === directory) break;
      }
      if (root) chain.push(root);
      return { file, chain };
    });
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
        const table: Record<string, string[]> = Object.create(null);
        await Promise.all(seeds().map(async ({ file, chain }) => {
          const page = await edges(file);
          if (!page?.page) return;
          const seen = new Set<string>();
          const actions = new Set<string>();
          // Share adjacency promises across routes, but never recursive walk
          // promises: cycles would deadlock while awaiting one another.
          const visit = async (url: string): Promise<void> => {
            const node = await edges(url);
            if (!node || seen.has(node.id)) return;
            seen.add(node.id);
            if (state.modules.get(node.id)?.actions) actions.add(relative(node.id));
            await Promise.all(node.deps.map(visit));
          };
          await Promise.all(chain.map(visit));
          table[relative(file)] = [...actions].sort();
        }));
        if (epoch !== state.epoch) continue;
        const enabled = options.htmx !== false && (options.htmx !== undefined || [...state.modules.values()].some(m => m.htmx));
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
      roots = locations({ ...options.routes, cwd: options.routes?.cwd ?? config.root });
      serving = config.command === 'serve';
      namespace = 'recooler:' + createHash('sha256').update(normalizePath(roots.srcDir)).digest('hex').slice(0, 24);
    },
    buildStart() {
      if (serving || !selected(this.environment)) return;
      const state = stateFor(this.environment.name);
      state.modules.clear();
      state.outputs.clear();
      state.epoch++;
    },
    async hotUpdate(context) {
      if (!selected(this.environment) || options.htmx === false) return;
      // Generation errors have their own overlay/invalidation path. Eagerly
      // importing an invalid manifest only repeats the same diagnostic.
      if (generationFailed) return [];
      const state = stateFor(this.environment.name);
      const active = options.htmx !== undefined || [...state.modules.values()].some(module => module.htmx);
      if (!active && !(sourcePattern.test(context.file) && context.type !== 'delete' && (await context.read()).includes('hx-'))) return;
      state.epoch++;
      this.environment.moduleGraph.invalidateAll();
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
      const data = serving ? JSON.stringify(await devTable(this.environment as DevEnvironment)) : token;
      return { code: `const data = JSON.parse(${JSON.stringify(data)});\nexport const table = data.table;\nexport const enabled = data.enabled;\nexport const namespace = ${JSON.stringify(namespace)};\n`, map: null };
    },
    transform: {
      filter: { id: sourcePattern, code: 'hx-' },
      handler(code, id) {
        if (!selected(this.environment) || options.htmx === false || !source(id)) return;
        id = canonicalId(id);
        const moduleKind = kinds.get(id.split('?')[0]!) ?? 'component';
        const result = transform(code, {
          id, relativePath: relative(id), mode: 'server', moduleKind,
          clientBannedImports: options.htmx && options.htmx.clientBannedImports,
          codegen: { registerActions: input => emitRegistration(input).replace(/\);$/, `, ${JSON.stringify(namespace)});`) },
        });
        for (const diagnostic of result.diagnostics) {
          const before = code.slice(0, diagnostic.start);
          const line = before.split('\n').length;
          const column = before.length - before.lastIndexOf('\n') - 1;
          const log = { message: `${relative(id)}:${line}:${column + 1}: ${diagnostic.message}`, id, pos: diagnostic.start,
            loc: { file: id, line, column } };
          if (diagnostic.severity === 'error') this.error(log);
          else this.warn(log);
        }
        const state = stateFor(this.environment.name);
        state.modules.set(id, { actions: result.actions.length > 0, htmx: true });
        if (serving) state.outputs.set(id, result.code);
        state.epoch++;
        return { code: result.code, map: result.map };
      },
    },
    renderChunk(code) {
      if (!selected(this.environment) || !code.includes(token)) return;
      const state = stateFor(this.environment.name);
      // Cache bridge calls AND copied adjacency once per render pass.
      const adjacency = new Map<string, { deps: readonly string[]; page: boolean } | undefined>();
      const edges = (id: string) => {
        if (!adjacency.has(id)) {
          const info = this.getModuleInfo(id);
          adjacency.set(id, !info ? undefined : { deps: [...info.importedIds], page: info.exports.includes('default') });
        }
        return adjacency.get(id);
      };
      const table: Record<string, string[]> = Object.create(null);
      for (const { file, chain } of seeds()) {
        if (!edges(file)?.page) continue;
        const seen = new Set<string>();
        const actions = new Set<string>();
        const visit = (id: string) => {
          if (seen.has(id)) return;
          seen.add(id);
          const node = edges(id);
          if (!node) return;
          if (state.modules.get(canonicalId(id))?.actions) actions.add(relative(id));
          node.deps.forEach(visit);
        };
        chain.forEach(visit);
        table[relative(file)] = [...actions].sort();
      }
      const enabled = options.htmx !== false && (options.htmx !== undefined || [...state.modules.values()].some(m => m.htmx));
      const ms = new MagicString(code);
      const needle = JSON.stringify(token);
      const start = code.indexOf(needle);
      ms.overwrite(start, start + needle.length, JSON.stringify(JSON.stringify({ table, enabled })));
      return { code: ms.toString(), map: ms.generateMap({ hires: true, includeContent: true }) };
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
    generationFailed(failed: boolean) { generationFailed = failed; },
    generated(result: GenerateResult) {
      files = result.files.map(normalizePath);
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
