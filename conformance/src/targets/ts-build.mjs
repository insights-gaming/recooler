// Build outside Vitest's own Vite server; only the self-contained output is
// evaluated in the runner's realm (where middleware traces are observed).
import { createBuilder } from 'vite';
import { recooler } from '@insights-gaming/recooler/vite';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.argv[2];
try {
  const builder = await createBuilder({
    root, mode: 'production', configFile: false, logLevel: 'warn',
    plugins: recooler({ htmx: JSON.parse(await readFile(path.join(root, 'htmx-options.json'), 'utf8')) }),
    resolve: { alias: { 'farm-plugin-recooler/helpers': '@insights-gaming/recooler/jsx' } },
    ssr: { noExternal: true },
    environments: { client: { build: { outDir: 'client' } } },
    build: {
      ssr: true, outDir: 'dist', minify: false, sourcemap: true,
      rolldownOptions: { input: 'virtual:recooler/app', output: { entryFileNames: 'app.mjs', inlineDynamicImports: true } },
    },
  });
  await builder.buildApp();
  const clientOut = path.resolve(root, builder.environments.client.config.build.outDir);
  const { readdir } = await import('node:fs/promises');
  const chunks = {};
  const walk = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.name.endsWith('.js')) chunks['/' + path.relative(clientOut, file).split(path.sep).join('/')] = await readFile(file, 'utf8');
    }
  };
  await walk(clientOut);
  await writeFile(path.join(root, 'client-chunks.json'), JSON.stringify(chunks));
  await writeFile(path.join(root, 'result.json'), JSON.stringify({ ok: true }));
} catch (error) {
  await writeFile(path.join(root, 'result.json'), JSON.stringify({ ok: false, error: String(error?.stack ?? error) }));
  process.exitCode = 1;
}
