import path from 'node:path';
import type { Plugin } from 'vite';
import { getTsconfig, parseTsconfig } from 'get-tsconfig';
import { generateRoutes } from '../gen/index.js';
import type { GenerateOptions } from '../gen/index.js';
import { locations } from '../gen/locations.js';
import { serverEnvironment } from './environment.js';

/** Thin Vite integration; gen and runtime declarations do not depend on Vite. */
export function routes(options: GenerateOptions = {}): Plugin {
  let cwd = options.cwd;
  let serve = false;
  let stop: (() => void) | undefined;
  let queue = Promise.resolve();
  const generate = () => generateRoutes({ ...options, cwd });
  const enqueue = (report?: (error: unknown) => void) => {
    const pending = queue.then(generate).then(() => {});
    queue = pending.catch(() => {});
    return report ? pending.catch(report) : pending;
  };
  return {
    name: 'recooler:routes',
    configResolved(config) { cwd ??= config.root; serve = config.command === 'serve'; },
    async buildStart() { if (!serve) await enqueue(); },
    async configureServer(server) {
      const roots = locations({ ...options, cwd });
      const rootFile = path.join(roots.srcDir, 'root.tsx');
      const report = (error: unknown) => server.config.logger.error(String(error));
      server.watcher.add([roots.routesDir, rootFile]);
      const update = (file: string) => {
        if (file === roots.out) return;
        const relative = path.relative(roots.routesDir, file);
        if (file !== rootFile && (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative))) return;
        void enqueue(report);
      };
      const events = ['add', 'unlink', 'addDir', 'unlinkDir', 'change'] as const;
      server.watcher.on('add', update).on('unlink', update).on('addDir', update).on('unlinkDir', update).on('change', update);
      stop = () => { for (const event of events) server.watcher.off(event, update); };
      server.httpServer?.once('close', () => stop?.());
      await enqueue(report);
    },
    async closeBundle() { stop?.(); await queue; },
  };
}

export interface RecoolerOptions {
  /** Generation, watch and --check use the same options as routes(). */
  routes?: GenerateOptions;
  /** Required only when multiple server entries are configured. */
  serverEnvironment?: string;
}

const appId = 'virtual:recooler/app';
const resolvedAppId = '\0' + appId;

/** JSX server integration. Future htmx plugins can contribute extensions and a
 * client environment without replacing routes() or the platform's buildApp. */
export function recooler(options: RecoolerOptions = {}): Plugin[] {
  let manifest: string;
  let server: string;
  const app: Plugin = {
    name: 'recooler:app',
    config(config) {
      // Returning defaults lets Vite merge user/environment overrides normally.
      const jsx = config.oxc === false ? undefined : config.oxc?.jsx;
      const root = path.resolve(config.root ?? process.cwd());
      const tsconfig = config.tsconfig
        ? parseTsconfig(path.resolve(root, config.tsconfig))
        : getTsconfig(root)?.config;
      const importSource = tsconfig?.compilerOptions?.jsxImportSource ?? 'recooler/jsx';
      return {
        oxc: config.oxc === false ? false : { jsx: typeof jsx === 'object'
          ? { runtime: 'automatic', importSource, ...jsx }
          : jsx ?? { runtime: 'automatic', importSource } },
        ssr: { noExternal: ['recooler', 'easy-jsx-html-engine'] },
      };
    },
    configResolved(config) {
      manifest = locations({ ...options.routes, cwd: options.routes?.cwd ?? config.root }).out;
      server = serverEnvironment(config.environments, options.serverEnvironment);
      const jsx = config.oxc === false ? undefined : config.oxc?.jsx;
      if (typeof jsx === 'object' && jsx.importSource === 'easy-jsx-html-engine') {
        config.logger.warn('recooler: use jsx importSource "recooler/jsx" instead of "easy-jsx-html-engine" for request-bound JSX rendering');
      }
    },
    resolveId(id) {
      if (id !== appId) return;
      if (this.environment.name !== server) throw new Error(`recooler: ${appId} belongs to server environment ${JSON.stringify(server)}, not ${JSON.stringify(this.environment.name)}`);
      return resolvedAppId;
    },
    load(id) {
      if (id !== resolvedAppId) return;
      return `import { createApp } from 'recooler/router';\nimport { jsxPages } from 'recooler/jsx';\nimport { manifest } from ${JSON.stringify(manifest)};\nexport default createApp(manifest, { pages: jsxPages() });\n`;
    },
  };
  return [routes(options.routes), app];
}
