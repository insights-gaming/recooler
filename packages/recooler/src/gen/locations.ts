import path from 'node:path';
import type { GenerateOptions } from './index.js';

export function locations(options: GenerateOptions) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const srcDir = path.resolve(cwd, options.srcDir ?? 'src');
  return { cwd, srcDir, routesDir: path.resolve(cwd, options.routesDir ?? path.join(srcDir, 'routes')), out: path.resolve(cwd, options.out ?? path.join(srcDir, 'routes.gen.ts')) };
}
