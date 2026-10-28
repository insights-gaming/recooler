import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export default defineConfig({
  test: {
    projects: [
      ...[['hono-4.12', 'hono-412'], ['hono-4.13', 'hono'], ['hono-5', 'hono-5']].map(([name, pkg]) => ({
        resolve: { alias: [
          { find: /^hono$/, replacement: require.resolve(pkg!) },
          ...['context-storage', 'csrf', 'html'].map(subpath => ({ find: `hono/${subpath}`, replacement: require.resolve(`${pkg}/${subpath}`) })),
          { find: 'recooler/jsx/jsx-runtime', replacement: fileURLToPath(new URL('./src/jsx/jsx-runtime.ts', import.meta.url)) },
          { find: 'recooler/jsx/jsx-dev-runtime', replacement: fileURLToPath(new URL('./src/jsx/jsx-dev-runtime.ts', import.meta.url)) },
        ] },
        test: {
          name, include: ['test/router/**/*.test.ts', 'test/jsx/**/*.test.ts', 'test/htmx-runtime/**/*.test.ts'],
          // Engine 0.1.13 has extensionless ESM imports; let Vite resolve them.
          server: { deps: { inline: ['easy-jsx-html-engine'] } },
        },
      })),
      { test: { name: 'gen', testTimeout: 30000, include: ['test/gen/**/*.test.ts'] } },
      { test: { name: 'recooler', include: ['test/**/*.test.ts'], exclude: ['test/router/**', 'test/gen/**', 'test/jsx/**', 'test/htmx-runtime/**'] } },
    ],
  },
});
