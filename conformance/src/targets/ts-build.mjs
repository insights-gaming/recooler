// Build outside Vitest's own Vite server; only the self-contained output is
// evaluated in the runner's realm (where middleware traces are observed).
import { build } from 'vite';
import { recooler } from 'recooler/vite';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.argv[2];
try {
  await build({
    root, configFile: false, logLevel: 'warn',
    plugins: recooler(),
    resolve: { alias: { 'farm-plugin-recooler/helpers': 'recooler/jsx' } },
    ssr: { noExternal: true },
    build: {
      ssr: true, outDir: 'dist', minify: false, sourcemap: true,
      rolldownOptions: { input: 'virtual:recooler/app', output: { entryFileNames: 'app.mjs', inlineDynamicImports: true } },
    },
  });
  await writeFile(path.join(root, 'result.json'), JSON.stringify({ ok: true }));
} catch (error) {
  await writeFile(path.join(root, 'result.json'), JSON.stringify({ ok: false, error: String(error?.stack ?? error) }));
  process.exitCode = 1;
}
