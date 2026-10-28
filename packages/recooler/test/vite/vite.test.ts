import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'vitest';
import { createLogger, resolveConfig } from 'vite';
import { recooler } from '../../src/vite/index.js';
import { serverEnvironment } from '../../src/vite/environment.js';
import { canonicalId } from '../../src/vite/htmx.js';

const execute = promisify(execFile);
test('canonical IDs remove transport queries and retain meaningful variants', () => {
  expect(canonicalId('/app/src/a.tsx?v=abc&t=123')).toBe('/app/src/a.tsx');
  expect(canonicalId('/app/src/a.tsx?recooler-handlers&t=123&raw&v=abc')).toBe('/app/src/a.tsx?recooler-handlers&raw');
  expect(canonicalId('/app/src/a.tsx?variant=one')).not.toBe(canonicalId('/app/src/a.tsx?variant=two'));
});
beforeAll(async () => {
  await execute(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { cwd: fileURLToPath(new URL('../../', import.meta.url)) });
});
describe('server environment selection', () => {
  const env = (name: string, consumer: 'server' | 'client' = 'server') => ({ name, config: { consumer } });
  test('allows server consumers and enforces an explicit selection', () => {
    expect(serverEnvironment(env('__vitest__'))).toBe('__vitest__');
    expect(serverEnvironment(env('worker'))).toBe('worker');
    expect(serverEnvironment(env('worker'), 'worker')).toBe('worker');
    expect(() => serverEnvironment(env('browser', 'client'))).toThrow('server-only');
    expect(() => serverEnvironment(env('other'), 'worker')).toThrow('restricted to serverEnvironment');
  });
});

test('rejects a missing or client serverEnvironment during configuration', async () => {
  const base = { configFile: false as const, logLevel: 'silent' as const, build: { ssr: true } };
  await expect(resolveConfig({ ...base, plugins: recooler({ serverEnvironment: 'does-not-exist' }) }, 'build')).rejects.toThrow('does not exist');
  await expect(resolveConfig({ ...base, plugins: recooler({ serverEnvironment: 'client' }) }, 'build')).rejects.toThrow('must be a server consumer');
});

test('keeps Vite JSX configuration and legacy esbuild conversion intact', async () => {
  const warnings: string[] = [];
  const logger = createLogger('silent');
  logger.warn = message => { warnings.push(message); };
  const config = { configFile: false as const, plugins: recooler(), customLogger: logger, build: { ssr: true } };
  const defaults = await resolveConfig(config, 'build');
  expect(defaults.environments.ssr!.resolve.noExternal).toEqual(expect.arrayContaining(['recooler', 'easy-jsx-html-engine']));
  const custom = await resolveConfig({ ...config, oxc: { jsx: { importSource: 'custom-jsx' } }, ssr: { noExternal: true }, environments: { server: { consumer: 'server' } } }, 'build');
  expect(custom.oxc).toMatchObject({ jsx: { importSource: 'custom-jsx' } });
  expect(custom.environments.ssr!.resolve.noExternal).toBe(true);
  expect(custom.environments.server!.resolve.noExternal).toEqual(expect.arrayContaining(['recooler', 'easy-jsx-html-engine']));
  expect(warnings.some(w => w.includes('custom-jsx'))).toBe(true);
  const legacy = await resolveConfig({ ...config, esbuild: { jsx: 'automatic', jsxImportSource: 'hono/jsx', jsxInject: 'import { h } from "x"' } }, 'build');
  expect(legacy.oxc).toMatchObject({ jsx: { importSource: 'hono/jsx' }, jsxInject: 'import { h } from "x"' });
  expect(warnings.some(w => w.includes('Both esbuild and oxc'))).toBe(false);
});

for (const runtime of ['plain', 'cloudflare']) {
  test(`real ${runtime} build and dev request${runtime === 'plain' ? ', route watch and SSR source map' : ''}`, async () => {
    const result = await execute(process.execPath, [fileURLToPath(new URL('./integration.mjs', import.meta.url)), runtime], {
      timeout: 120000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, NODE_ENV: 'production', WRANGLER_SEND_METRICS: 'false' },
    });
    expect(result.stdout).toContain('"devRequest":true');
  }, 130000);
}

test('Vitest, custom server dependencies, per-file JSX and dev generation regressions', async () => {
  const result = await execute(process.execPath, [fileURLToPath(new URL('./regressions.mjs', import.meta.url))], {
    timeout: 120000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, NODE_ENV: 'production' },
  });
  expect(result.stdout).toContain('"regressions":true');
}, 130000);

for (const runtime of ['plain', 'cloudflare', 'beta']) {
  test(`htmx static graph, signing, edits/removal and built actions on ${runtime}`, async () => {
    const result = await execute(process.execPath, [fileURLToPath(new URL('./htmx-integration.mjs', import.meta.url)), runtime], {
      timeout: 120000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, NODE_ENV: 'production', WRANGLER_SEND_METRICS: 'false' },
    });
    expect(result.stdout).toContain('"actionRemoval":true');
  }, 130000);
}

test('production unsigned guard covers custom entries and diagnostics retain locations', async () => {
  const result = await execute(process.execPath, [fileURLToPath(new URL('./htmx-options.mjs', import.meta.url))], {
    timeout: 120000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, NODE_ENV: 'production' },
  });
  expect(result.stdout).toContain('"productionGuard":true');
}, 130000);
