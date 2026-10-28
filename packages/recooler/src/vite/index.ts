import path from 'node:path';
import type { Plugin } from 'vite';
import { generateRoutes } from '../gen/index.js';
import type { GenerateOptions } from '../gen/index.js';
import { locations } from '../gen/locations.js';

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
