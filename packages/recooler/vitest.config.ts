import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export default defineConfig({
  test: {
    projects: [
      ...[['hono-4.12', 'hono-412'], ['hono-4.13', 'hono'], ['hono-5', 'hono-5']].map(([name, pkg]) => ({
        resolve: { alias: [{ find: /^hono$/, replacement: require.resolve(pkg!) }] },
        test: { name, include: ['test/router/**/*.test.ts'] },
      })),
      { test: { name: 'gen', testTimeout: 30000, include: ['test/gen/**/*.test.ts'] } },
      {
        resolve: { alias: {
          'recooler/jsx/jsx-runtime': fileURLToPath(new URL('./src/jsx/jsx-runtime.ts', import.meta.url)),
          'recooler/jsx/jsx-dev-runtime': fileURLToPath(new URL('./src/jsx/jsx-dev-runtime.ts', import.meta.url)),
        } },
        test: {
          name: 'recooler',
          // Engine 0.1.13 has extensionless ESM imports; let Vite resolve them.
          server: { deps: { inline: ['easy-jsx-html-engine'] } },
          include: ['test/**/*.test.ts'], exclude: ['test/router/**', 'test/gen/**'],
        },
      },
    ],
  },
});
