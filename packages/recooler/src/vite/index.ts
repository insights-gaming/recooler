import path from 'node:path';
import { normalizePath, searchForWorkspaceRoot } from 'vite';
import type { Plugin, ViteDevServer } from 'vite';
import { crawlFrameworkPkgs } from 'vitefu';
import { generateRoutes } from '../gen/index.js';
import type { GenerateOptions } from '../gen/index.js';
import { locations } from '../gen/locations.js';
import { serverEnvironment } from './environment.js';
import { jsxDefaults } from './jsx.js';

const appId = 'virtual:recooler/app';
const resolvedAppId = '\0' + appId;

/** Thin Vite integration; gen and runtime declarations do not depend on Vite. */
export function routes(options: GenerateOptions = {}): Plugin {
  return routePlugin(options);
}

function routePlugin(options: GenerateOptions, changed?: (error?: Error) => void): Plugin {
  let cwd = options.cwd;
  let serve = false;
  let stop: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue = Promise.resolve();
  let lastError: string | undefined;
  const enqueue = (server?: ViteDevServer) => {
    const pending = queue.then(async () => {
      try {
        await generateRoutes({ ...options, cwd });
        changed?.();
        lastError = undefined;
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        changed?.(error);
        if (!server) throw error;
        if (lastError !== error.message) {
          server.config.logger.error(error.message);
          if (server.ws.clients.size) server.ws.send({ type: 'error', err: { message: error.message, stack: error.stack ?? '', plugin: 'recooler:routes' } });
        }
        lastError = error.message;
      }
    });
    queue = pending.catch(() => {});
    return pending;
  };
  return {
    name: 'recooler:routes',
    configResolved(config) { cwd ??= config.root; serve = config.command === 'serve'; },
    async buildStart() { if (!serve) await enqueue(); },
    async configureServer(server) {
      const roots = locations({ ...options, cwd });
      const rootFile = path.join(roots.srcDir, 'root.tsx');
      server.watcher.add([roots.routesDir, rootFile]);
      const update = (file: string) => {
        if (file === roots.out) return;
        const relative = path.relative(roots.routesDir, file);
        if (file !== rootFile && (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative))) return;
        clearTimeout(timer);
        timer = setTimeout(() => { void enqueue(server); }, 25);
      };
      const connection = (socket: { send: (payload: string) => void }) => {
        if (lastError) socket.send(JSON.stringify({ type: 'error', err: { message: lastError, stack: '', plugin: 'recooler:routes' } }));
      };
      server.ws.on('connection', connection);
      const events = ['add', 'unlink', 'addDir', 'unlinkDir', 'change'] as const;
      for (const event of events) server.watcher.on(event, update);
      stop = () => {
        clearTimeout(timer);
        for (const event of events) server.watcher.off(event, update);
        server.ws.off('connection', connection);
      };
      server.httpServer?.once('close', () => stop?.());
      await enqueue(server);
    },
    async closeBundle() { stop?.(); await queue; },
  };
}

export interface RecoolerOptions {
  /** Generation, watch and --check use the same options as routes(). */
  routes?: GenerateOptions;
  /** Restrict virtual app imports to this configured server environment. */
  serverEnvironment?: string;
}

/** JSX server integration. htmx remains a separate transform/runtime layer. */
export function recooler(options: RecoolerOptions = {}): Plugin[] {
  let manifest: string;
  let generationError: Error | undefined;
  let devServer: ViteDevServer | undefined;
  let noExternal = ['recooler', 'easy-jsx-html-engine'];
  const generated = (error?: Error) => {
    const previous = generationError?.message;
    generationError = error;
    if (previous === error?.message) return;
    for (const environment of Object.values(devServer?.environments ?? {})) {
      const module = environment.moduleGraph.getModuleById(resolvedAppId);
      if (module) {
        environment.moduleGraph.invalidateModule(module);
        // A failed generation is reported by routes() and the error overlay.
        // Invalidating importers makes the next runner import fail too, without
        // an eager reload that logs the same diagnostic a second time.
        if (!error) environment.hot.send({ type: 'full-reload' });
      }
    }
    if (previous && !error) devServer?.ws.send({ type: 'full-reload' });
  };
  const app: Plugin = {
    name: 'recooler:app',
    async config(config, env) {
      const root = path.resolve(config.root ?? process.cwd());
      const crawled = await crawlFrameworkPkgs({
        root, workspaceRoot: searchForWorkspaceRoot(root), isBuild: env.command === 'build',
        isFrameworkPkgByJson(pkg) {
          return ['dependencies', 'peerDependencies'].some(field =>
            ['recooler', 'easy-jsx-html-engine'].some(name => pkg[field]?.[name]));
        },
      });
      noExternal = [...new Set([...noExternal, ...crawled.ssr.noExternal])];
    },
    configEnvironment(_name, config) {
      if ((config.consumer ?? (_name === 'client' ? 'client' : 'server')) !== 'server') return;
      const existing = config.resolve?.noExternal;
      if (existing === true) return;
      const entries = existing ? [existing].flat() : [];
      return { resolve: { noExternal: noExternal.filter(name => !entries.includes(name)) } };
    },
    configResolved(config) {
      manifest = normalizePath(locations({ ...options.routes, cwd: options.routes?.cwd ?? config.root }).out);
      if (options.serverEnvironment !== undefined) {
        const environment = config.environments[options.serverEnvironment];
        if (!environment) throw new Error(`recooler: serverEnvironment ${JSON.stringify(options.serverEnvironment)} does not exist`);
        if (environment.consumer !== 'server') throw new Error(`recooler: serverEnvironment ${JSON.stringify(options.serverEnvironment)} must be a server consumer`);
      }
    },
    configureServer(server) { devServer = server; },
    resolveId(id) {
      if (id !== appId) return;
      serverEnvironment(this.environment, options.serverEnvironment);
      return resolvedAppId;
    },
    load(id) {
      if (id !== resolvedAppId) return;
      serverEnvironment(this.environment, options.serverEnvironment);
      if (generationError) throw generationError;
      return `import { createApp } from 'recooler/router';\nimport { jsxPages } from 'recooler/jsx';\nimport { manifest } from ${JSON.stringify(manifest)};\nexport default createApp(manifest, { pages: jsxPages() });\n`;
    },
  };
  // Wire invalidation before configureServer's initial generation can fail.
  const generator = routePlugin(options.routes ?? {}, generated);
  return [app, generator, jsxDefaults()];
}
