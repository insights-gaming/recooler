import { defineConfig } from 'vitest/config';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export default defineConfig({
  test: {
    projects: [
      ...[['hono-4.12', 'hono-412'], ['hono-4.13', 'hono'], ['hono-5', 'hono-5']].map(([name, pkg]) => ({
        resolve: { alias: [{ find: /^hono$/, replacement: require.resolve(pkg!) }] },
        test: { name, include: ['test/router/**/*.test.ts'] },
      })),
      { test: { name: 'gen', include: ['test/gen/**/*.test.ts'] } },
    ],
  },
});
