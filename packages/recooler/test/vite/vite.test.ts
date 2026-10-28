import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'vitest';
import { createLogger, resolveConfig } from 'vite';
import { recooler } from '../../src/vite/index.js';
import { serverEnvironment } from '../../src/vite/environment.js';

const execute = promisify(execFile);
beforeAll(async () => {
  await execute(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { cwd: fileURLToPath(new URL('../../', import.meta.url)) });
});
const configured = (consumer: 'server' | 'client', input?: string) => ({ consumer, build: { rolldownOptions: { input } } });

describe('server environment selection', () => {
  test('selects the configured Worker, independent of names and ordering', () => {
    expect(serverEnvironment({ unused: configured('server'), arbitrary: configured('server', 'worker.ts'), browser: configured('client', 'client.ts') })).toBe('arbitrary');
    expect(serverEnvironment({ another: configured('server') })).toBe('another');
  });
  test('rejects ambiguity and validates explicit selections', () => {
    const environments = { one: configured('server', 'a.ts'), two: configured('server', 'b.ts'), browser: configured('client') };
    expect(() => serverEnvironment(environments)).toThrow('set serverEnvironment');
    expect(serverEnvironment(environments, 'two')).toBe('two');
    expect(() => serverEnvironment(environments, 'browser')).toThrow('not a server environment');
  });
});

test('defaults JSX, respects user/tsconfig import sources and warns for direct engine use', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'recooler-config-'));
  const warnings: string[] = [];
  const logger = createLogger('silent');
  logger.warn = message => { warnings.push(message); };
  const config = { root, configFile: false as const, plugins: recooler(), customLogger: logger };
  try {
    const defaults = await resolveConfig(config, 'build');
    expect(defaults.oxc).toMatchObject({ jsx: { runtime: 'automatic', importSource: 'recooler/jsx' } });
    expect(defaults.ssr.noExternal).toEqual(expect.arrayContaining(['recooler', 'easy-jsx-html-engine']));
    const custom = await resolveConfig({ ...config, oxc: { jsx: { importSource: 'custom-jsx' } }, ssr: { noExternal: true } }, 'build');
    expect(custom.oxc).toMatchObject({ jsx: { importSource: 'custom-jsx' } });
    expect(custom.ssr.noExternal).toBe(true);
    await writeFile(path.join(root, 'base.json'), '{"compilerOptions":{"jsxImportSource":"easy-jsx-html-engine"}}');
    await writeFile(path.join(root, 'tsconfig.json'), '{ // JSONC and extends\n "extends":"./base.json" }');
    const tsconfig = await resolveConfig(config, 'build');
    expect(tsconfig.oxc).toMatchObject({ jsx: { importSource: 'easy-jsx-html-engine' } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('use jsx importSource "recooler/jsx"');
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const runtime of ['plain', 'cloudflare']) {
  test(`real ${runtime} build and dev request${runtime === 'plain' ? ', route watch and SSR source map' : ''}`, async () => {
    const result = await execute(process.execPath, [fileURLToPath(new URL('./integration.mjs', import.meta.url)), runtime], {
      timeout: 120000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    });
    expect(result.stdout).toContain('"devRequest":true');
  }, 130000);
}
