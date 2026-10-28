import path from 'node:path';
import { createFilesMatcher, findTsconfig, parseTsconfig } from 'get-tsconfig';
import type { FileMatcher, TsConfigResult, TsConfigJsonResolved } from 'get-tsconfig';
import MagicString from 'magic-string';
import { parseSync } from 'oxc-parser';
import type { Plugin, ResolvedConfig } from 'vite';

/** Share filesystem reads, parsed projects and compiled globs across file transforms. */
function configCache() {
  const reads = new Map();
  const nearest = new Map<string, string | undefined>();
  const projects = new Map<string, { result: TsConfigResult; match: FileMatcher; references: string[] }>();
  const project = (name: string, result?: TsConfigResult) => {
    let cached = projects.get(name);
    if (!cached) {
      result ??= { path: name, config: parseTsconfig(name, reads) };
      cached = {
        result, match: createFilesMatcher(result),
        references: (result.config.references ?? []).map(ref => {
          const target = path.resolve(path.dirname(name), ref.path);
          return target.endsWith('.json') ? target : path.join(target, 'tsconfig.json');
        }),
      };
      projects.set(name, cached);
    }
    return cached;
  };
  return {
    clear() { reads.clear(); nearest.clear(); projects.clear(); },
    fileConfig(file: string, explicit?: string): TsConfigJsonResolved | undefined {
      const directory = path.dirname(file);
      if (!explicit && !nearest.has(directory)) nearest.set(directory, findTsconfig(directory, 'tsconfig.json', reads));
      const name = explicit ?? nearest.get(directory);
      const visited = new Set<string>();
      const match = (result: TsConfigResult): TsConfigJsonResolved | undefined => {
        if (visited.has(result.path)) return;
        visited.add(result.path);
        const cached = project(result.path, result);
        for (const name of cached.references) {
          const found = match(project(name).result);
          if (found) return found;
        }
        // The nearest config, like a reference, must actually include this file.
        return cached.match(file) ?? undefined;
      };
      return name ? match(project(name).result) : undefined;
    },
  };
}

/** OXC reads leading comments (also after directives), with the last valid value winning. */
function pragmas(code: string, file: string) {
  let source: string | undefined;
  let runtime: string | undefined;
  if (code.includes('@jsx')) {
    const parsed = parseSync(file, code);
    const firstStatement = parsed.program.body.find(statement =>
      statement.type !== 'ExpressionStatement' || !statement.directive)?.start ?? code.length;
    for (const comment of parsed.comments) {
      if (comment.end > firstStatement) break;
      for (const match of comment.value.matchAll(/@jsx(ImportSource|Runtime)\s+(\S+)/g)) {
        if (match[1] === 'ImportSource') source = match[2];
        else if (match[2] === 'classic' || match[2] === 'automatic') runtime = match[2];
      }
    }
  }
  return { source, runtime };
}

export function jsxDefaults(): Plugin {
  let config: ResolvedConfig;
  const cache = configCache();
  let stop: (() => void) | undefined;
  const warned = new Set<string>();
  const warn = (source: string) => {
    if (source === '@insights-gaming/recooler/jsx' || warned.has(source)) return;
    warned.add(source);
    config.logger.warn(`recooler: use jsx importSource "@insights-gaming/recooler/jsx" instead of ${JSON.stringify(source)} for request-bound JSX rendering`);
  };
  return {
    // Phase 4b's htmx client-slice transform must run before this pre plugin.
    // Keep this name stable so it can explicitly order against the JSX defaults.
    name: 'recooler:jsx-defaults',
    enforce: 'pre',
    configResolved(resolved) {
      config = resolved;
      cache.clear();
      const jsx = config.oxc && config.oxc.jsx;
      if (typeof jsx === 'object' && jsx.importSource) warn(jsx.importSource);
    },
    configureServer(server) {
      // Includes referenced configs and arbitrarily named extends files, plus
      // additions/removals which can change the nearest config for a directory.
      const invalidate = (file: string) => { if (file.endsWith('.json')) cache.clear(); };
      for (const event of ['add', 'change', 'unlink'] as const) server.watcher.on(event, invalidate);
      stop = () => {
        for (const event of ['add', 'change', 'unlink'] as const) server.watcher.off(event, invalidate);
      };
      server.httpServer?.once('close', () => stop?.());
    },
    watchChange(file) { if (file.endsWith('.json')) cache.clear(); },
    closeBundle() { stop?.(); cache.clear(); },
    transform(code, id) {
      const file = id.split('?')[0]!;
      if (!/\.[jt]sx$/.test(file) || !path.isAbsolute(file) || config.oxc === false) return;
      const jsx = config.oxc.jsx;
      const compiler = cache.fileConfig(file, config.tsconfig ? path.resolve(config.root, config.tsconfig) : undefined)?.compilerOptions;
      const pragma = pragmas(code, file);
      const classic = (pragma.runtime ?? (typeof jsx === 'object' ? jsx.runtime : undefined) ?? (compiler?.jsx === 'react' ? 'classic' : 'automatic')) === 'classic';
      const source = pragma.source ?? (typeof jsx === 'object' ? jsx.importSource : undefined) ?? compiler?.jsxImportSource;
      if (source || classic || jsx === 'preserve' || compiler?.jsx === 'preserve') {
        warn(source ?? (classic ? 'classic JSX runtime' : 'preserved JSX'));
        return;
      }
      const result = new MagicString(code);
      const hashbangEnd = code.startsWith('#!') ? code.indexOf('\n') : -1;
      const offset = code.startsWith('#!') ? (hashbangEnd < 0 ? code.length : hashbangEnd + 1) : 0;
      result.appendLeft(offset, (offset === code.length && offset > 0 ? '\n' : '') + '/** @jsxRuntime automatic @jsxImportSource @insights-gaming/recooler/jsx */\n');
      return { code: result.toString(), map: result.generateMap({ hires: 'boundary', source: id, includeContent: true }) };
    },
  };
}
