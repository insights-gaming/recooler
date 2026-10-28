import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { parseSync } from 'oxc-parser';
import { transform } from '../../src/htmx/transform/index.js';

const root = fileURLToPath(new URL('../../playground/src', import.meta.url));
for (const file of readdirSync(root, { recursive: true }).filter((file): file is string => typeof file === 'string' && /\.[jt]sx$/.test(file))) {
  it(`transforms the playground corpus in every mode: ${file}`, () => {
    const id = resolve(root, file);
    const code = readFileSync(id, 'utf8');
    const results = ['full', 'server', 'client-slice'].map(mode => transform(code, {
      id, relativePath: `src/${file}`, mode: mode as 'full' | 'server' | 'client-slice',
      moduleKind: file.endsWith('index.tsx') ? 'route' : file.endsWith('layout.tsx') ? 'layout' : 'root',
    }));
    for (const result of results) {
      expect(result.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
      expect(parseSync(id, result.code).errors, result.code).toEqual([]);
      expect(result.actions.map(a => a.id)).toEqual(results[0]!.actions.map(a => a.id));
      expect(result.handlers.map(a => a.id)).toEqual(results[0]!.handlers.map(a => a.id));
    }
  });
}
