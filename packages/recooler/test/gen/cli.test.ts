import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

it('runs the compiled symlinked CLI, tsc resolver and plain Node runtime smoke', () => {
  const cwd = fileURLToPath(new URL('../..', import.meta.url));
  const compile = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { cwd, encoding: 'utf8' });
  expect(compile.status, compile.stdout + compile.stderr).toBe(0);
  const smoke = spawnSync(process.execPath, ['test/gen/node-smoke.mjs'], { cwd, encoding: 'utf8' });
  expect(smoke.status, smoke.stdout + smoke.stderr).toBe(0);
  expect(smoke.stdout).toContain('PASS: symlinked bin and package CLI');
}, 30000);
