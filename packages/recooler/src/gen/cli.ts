#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { generateRoutes, watchRoutes } from './index.js';
import type { GenerateOptions } from './index.js';

export async function main(args = process.argv.slice(2)): Promise<number> {
  const options: GenerateOptions = {};
  let watch = false;
  if (args[0] !== 'generate') {
    console.error('Usage: recooler-routes generate [--watch] [--check] [--routes-dir DIR] [--src-dir DIR] [--out FILE] [--import-extension ""|.js|.tsx] [--no-route-types]');
    return args[0] === '--help' ? 0 : 1;
  }
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--watch') watch = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--no-route-types') options.routeTypes = false;
    else if (['--routes-dir', '--src-dir', '--out', '--import-extension'].includes(arg!)) {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) { console.error(`missing value for ${arg}`); return 1; }
      if (arg === '--import-extension') {
        if (!['', '.js', '.tsx'].includes(value)) { console.error('importExtension must be "", ".js", or ".tsx"'); return 1; }
        options.importExtension = value as '' | '.js' | '.tsx';
      } else if (arg === '--routes-dir') options.routesDir = value;
      else if (arg === '--src-dir') options.srcDir = value;
      else options.out = value;
    } else { console.error(`unknown option ${arg}`); return 1; }
  }
  try {
    if (watch) {
      const watcher = await watchRoutes({ ...options, onError(error) { console.error(String(error)); process.exitCode = 1; }, onResult(result) { process.exitCode = 0; result.warnings.forEach(w => console.warn(w)); } });
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { watcher.close(); });
    } else {
      const result = await generateRoutes(options);
      result.warnings.forEach(w => console.warn(w));
    }
    return 0;
  } catch (error) { console.error(String(error)); return 1; }
}

// Importing main in tests or scripts does not start the CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
