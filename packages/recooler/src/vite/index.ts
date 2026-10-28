import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { normalizePath, searchForWorkspaceRoot } from 'vite';
import type { Plugin, ViteDevServer } from 'vite';
import { crawlFrameworkPkgs } from 'vitefu';
import { generateRoutes } from '../gen/index.js';
import type { GenerateResult } from '../gen/index.js';
import type { GenerateOptions } from '../gen/index.js';
import { locations } from '../gen/locations.js';
import { serverEnvironment } from './environment.js';
import { htmxPlugin, tableId } from './htmx.js';
import { jsxDefaults } from './jsx.js';

const appId = 'virtual:recooler/app';
const resolvedAppId = '\0' + appId;

/** Thin Vite integration; gen and runtime declarations do not depend on Vite. */
export function routes(options: GenerateOptions = {}): Plugin {
  return routePlugin(options);
}

function routePlugin(options: GenerateOptions, changed?: (error?: Error, result?: GenerateResult) => void): Plugin {
  let cwd = options.cwd;
  let serve = false;
  let stop: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue = Promise.resolve();
  let lastError: string | undefined;
  const colonFiles = new Set<string>();
  const enqueue = (server?: ViteDevServer) => {
    const pending = queue.then(async () => {
      try {
        const result = await generateRoutes({ ...options, cwd });
        colonFiles.clear();
        for (const file of result.files) if (file.slice(path.parse(file).root.length).includes(':')) colonFiles.add(normalizePath(file));
        changed?.(undefined, result);
        lastError = undefined;
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        colonFiles.clear();
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
    async load(id) {
      // Vite's default filesystem loader rejects ':' even in explicitly allowed
      // paths on workerd's transport. Read only exact manifest inputs, leaving
      // strict fs and every other file/query under Vite's normal policy.
      if (!colonFiles.has(id)) return;
      this.addWatchFile(id);
      return { code: await readFile(id, 'utf8'), map: null };
    },
    // Cloudflare can eagerly import the Worker during configureServer. Generate
    // the manifest and graph roots before platform hooks can load virtual apps.
    configureServer: { order: 'pre', async handler(server) {
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
    } },
    async closeBundle() { stop?.(); await queue; },
  };
}

export interface RecoolerOptions {
  /** Generation, watch and --check use the same options as routes(). */
  routes?: GenerateOptions;
  /** Restrict virtual app imports to this configured server environment. */
  serverEnvironment?: string;
  /** Enabled automatically by hx- source attributes. Client delivery is Phase 5. */
  htmx?: false | {
    /** Request env binding, then process.env on Node. Never a build-time secret. */
    secretBinding?: string;
    /** Stable app identity override; environment and dev nonce are still appended. */
    namespace?: string;
    base?: string;
    trustedOrigins?: readonly string[];
    clientBannedImports?: readonly (RegExp | string)[];
    /** Additional action packages without a declared recooler peer/dependency. */
    actionDependencies?: readonly string[];
  };
}

/** Server route, JSX and htmx integration. Does not replace platform builders. */
export function recooler(options: RecoolerOptions = {}): Plugin[] {
  const htmx = htmxPlugin(options);
  let manifest: string;
  let generationError: Error | undefined;
  let devServer: ViteDevServer | undefined;
  let noExternal = ['recooler', 'easy-jsx-html-engine'];
  const generated = (error?: Error, result?: GenerateResult) => {
    htmx.generationFailed(error !== undefined);
    if (result) htmx.generated(result);
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
      noExternal = [...new Set([...noExternal, ...crawled.ssr.noExternal, ...(options.htmx && options.htmx.actionDependencies || [])])];
      htmx.actionDependencies(noExternal, root);
    },
    configEnvironment(_name, config) {
      if ((config.consumer ?? (_name === 'client' ? 'client' : 'server')) !== 'server') return;
      const htmxSelected = options.htmx !== false && (options.serverEnvironment === undefined || options.serverEnvironment === _name);
      if (htmxSelected) {
        config.optimizeDeps ??= {};
        config.optimizeDeps.exclude = [...new Set([...(config.optimizeDeps.exclude ?? []), ...noExternal])];
        config.optimizeDeps.include = config.optimizeDeps.include?.filter(name => !noExternal.some(dep => name === dep || name.startsWith(dep + '/')));
        if (Array.isArray(config.resolve?.external)) config.resolve.external = config.resolve.external.filter(name => !noExternal.some(dep => name === dep || name.startsWith(dep + '/')));
      }
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
      const settings = options.htmx || {};
      const binding = JSON.stringify(settings.secretBinding ?? 'RECOOLER_SECRET');
      const imports = options.htmx === false ? '' : `import { htmx } from 'recooler/htmx';\nimport { table, namespace, enabled } from ${JSON.stringify(tableId)};\n`;
      const extensions = options.htmx === false ? '' : `, extensions: enabled ? [htmx({ table, namespace, secret: env => { const value = env?.[${binding}] ?? (typeof process !== 'undefined' ? process.env?.[${binding}] : undefined); if (typeof value !== 'string' || !value) throw new Error(${JSON.stringify('recooler: htmx actions require a nonempty ' + (settings.secretBinding ?? 'RECOOLER_SECRET') + ' binding; set it in .dev.vars for local Workers, a deployed Worker secret, or process.env on Node')}); return value; }, base: ${JSON.stringify(settings.base)}, trustedOrigins: ${JSON.stringify(settings.trustedOrigins)} })] : []`;
      // Loading the table first pretransforms route closures in parallel. The
      // module runner otherwise lowers/evaluates manifest imports serially.
      // All registrations still evaluate before createApp consumes the table.
      return { code: `${imports}import { createApp } from 'recooler/router';\nimport { jsxPages } from 'recooler/jsx';\nimport { manifest } from ${JSON.stringify(manifest)};\nexport default createApp(manifest, { pages: jsxPages()${extensions} });\n`, map: null };
    },
  };
  // Wire invalidation before configureServer's initial generation can fail.
  const generator = routePlugin(options.routes ?? {}, generated);
  return [app, generator, ...htmx.plugins, jsxDefaults()];
}
