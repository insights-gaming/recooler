import { defineConfig, isRunnableDevEnvironment, type Plugin } from 'vite';
import { recooler } from '@insights-gaming/recooler/vite';

const nodeDev: Plugin = {
  name: 'playground:http',
  configureServer(vite) {
    return () => vite.middlewares.use(async (req, res, next) => {
      try {
        const environment = vite.environments.ssr!;
        if (!isRunnableDevEnvironment(environment)) throw new Error('The Node playground requires a runnable SSR environment');
        const app = (await environment.runner.import('/src/entry.ts')).default;
        const request = new Request('http://localhost' + req.url, {
          method: req.method, headers: req.headers as HeadersInit,
          ...(!['GET', 'HEAD'].includes(req.method!) ? { body: req as unknown as ReadableStream, duplex: 'half' } : {}),
        });
        const response = await app.fetch(request, { RECOOLER_SECRET: 'playground-dev-only' });
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) { next(error); }
    });
  },
};

export default defineConfig({
  appType: 'custom',
  plugins: [...recooler({ htmx: { clientBannedImports: ['src/lib/db\\.ts', '^node:'] } }), nodeDev],
  ssr: { noExternal: true },
  build: { ssr: 'src/entry.ts', emitAssets: true, outDir: 'dist/server', sourcemap: true, rolldownOptions: { output: { entryFileNames: 'app.mjs' } } },
});
