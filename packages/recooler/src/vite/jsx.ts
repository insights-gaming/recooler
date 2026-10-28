import path from 'node:path';
import { createFilesMatcher, getTsconfig, parseTsconfig } from 'get-tsconfig';
import type { TsConfigResult, TsConfigJsonResolved } from 'get-tsconfig';
import MagicString from 'magic-string';
import type { Plugin, ResolvedConfig } from 'vite';

/** Match referenced solution projects before falling back to the nearest config. */
function fileConfig(file: string, explicit?: string): TsConfigJsonResolved | undefined {
  const nearest = explicit ? { path: explicit, config: parseTsconfig(explicit) } : getTsconfig(file);
  const visited = new Set<string>();
  const referenced = (result: TsConfigResult): TsConfigJsonResolved | undefined => {
    if (visited.has(result.path)) return;
    visited.add(result.path);
    for (const ref of result.config.references ?? []) {
      let name = path.resolve(path.dirname(result.path), ref.path);
      if (!name.endsWith('.json')) name = path.join(name, 'tsconfig.json');
      const child = { path: name, config: parseTsconfig(name) };
      const match = referenced(child) ?? createFilesMatcher(child)(file);
      if (match) return match;
    }
  };
  return nearest ? referenced(nearest) ?? nearest.config : undefined;
}

export function jsxDefaults(): Plugin {
  let config: ResolvedConfig;
  const warned = new Set<string>();
  const warn = (source: string) => {
    if (source === 'recooler/jsx' || warned.has(source)) return;
    warned.add(source);
    config.logger.warn(`recooler: use jsx importSource "recooler/jsx" instead of ${JSON.stringify(source)} for request-bound JSX rendering`);
  };
  return {
    name: 'recooler:jsx-defaults',
    enforce: 'pre',
    configResolved(resolved) {
      config = resolved;
      const jsx = config.oxc && config.oxc.jsx;
      if (typeof jsx === 'object' && jsx.importSource) warn(jsx.importSource);
    },
    transform(code, id) {
      const file = id.split('?')[0]!;
      if (!/\.[jt]sx$/.test(file) || !path.isAbsolute(file) || config.oxc === false) return;
      const jsx = config.oxc.jsx;
      const compiler = fileConfig(file, config.tsconfig ? path.resolve(config.root, config.tsconfig) : undefined)?.compilerOptions;
      const pragmaSource = code.match(/@jsxImportSource\s+(\S+)/)?.[1];
      const pragmaClassic = /@jsxRuntime\s+classic\b|@jsx(?:Frag)?\s+/.test(code);
      const classic = pragmaClassic || (typeof jsx === 'object' && jsx.runtime === 'classic') || compiler?.jsx === 'react';
      const source = pragmaSource ?? (typeof jsx === 'object' ? jsx.importSource : undefined) ?? compiler?.jsxImportSource;
      if (source || classic || jsx === 'preserve' || compiler?.jsx === 'preserve' || compiler?.jsx === 'react-native') {
        warn(source ?? (classic ? 'classic JSX runtime' : 'preserved JSX'));
        return;
      }
      const result = new MagicString(code);
      result.prepend('/** @jsxRuntime automatic @jsxImportSource recooler/jsx */\n');
      return { code: result.toString(), map: result.generateMap({ hires: true, source: id, includeContent: true }) };
    },
  };
}
