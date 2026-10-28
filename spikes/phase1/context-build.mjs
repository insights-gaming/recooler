import { build } from 'vite';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
await build({ root, configFile: false, logLevel: 'error', ssr: { noExternal: true },
  build: { ssr: 'context-check.mjs', outDir: '.generated/context', sourcemap: true, minify: false,
    rolldownOptions: { output: { entryFileNames: 'context-native.mjs' } } } });
