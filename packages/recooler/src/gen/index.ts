import { watch as fsWatch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseSync } from 'oxc-parser';
import type { Plugin } from 'vite';
import { compareRoutePaths, isGroupSegment, lexical, resolveRoutes, RouteValidationError, routePathWithoutGroups, routeSegment } from '../router/resolve.js';
import type { DirNode, Manifest, ModuleNs } from '../router/types.js';

export interface GenerateOptions {
  /** Paths are relative to cwd (default process.cwd()). */
  cwd?: string;
  srcDir?: string;
  routesDir?: string;
  out?: string;
  importExtension?: '' | '.js' | '.tsx';
  routeTypes?: boolean;
  /** Compare without writing; throw StaleRoutesError if missing or stale. */
  check?: boolean;
}
export interface GenerateResult {
  code: string;
  out: string;
  changed: boolean;
  files: string[];
  warnings: string[];
}
export class StaleRoutesError extends Error {
  constructor(public readonly file: string) { super(`${file} is stale; run recooler-routes generate`); this.name = 'StaleRoutesError'; }
}
const slash = (s: string) => s.split(path.sep).join('/');
const routeFile = /^index\.[jt]sx?$/;
const layoutFile = /^layout\.[jt]sx?$/;
const middlewareFile = /^middleware(?:@[\p{L}\p{N}_-]+)?\.[jt]sx?$/u;
function locations(options: GenerateOptions) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const srcDir = path.resolve(cwd, options.srcDir ?? 'src');
  return { cwd, srcDir, routesDir: path.resolve(cwd, options.routesDir ?? path.join(srcDir, 'routes')), out: path.resolve(cwd, options.out ?? path.join(srcDir, 'routes.gen.ts')) };
}
const marker = () => undefined;
interface SourceModule { file: string; namespace: ModuleNs; }

/** Scan and render without writing; namespace imports keep output independent of export edits. */
export async function renderRoutes(options: GenerateOptions = {}): Promise<Omit<GenerateResult, 'changed'>> {
  const { srcDir, routesDir, out } = locations(options);
  const errors: string[] = [];
  const modules: SourceModule[] = [];
  const namespaceFile = new Map<ModuleNs, string>();
  async function readModule(file: string): Promise<ModuleNs> {
    const source = await readFile(file, 'utf8');
    const parsed = parseSync(file, source);
    for (const error of parsed.errors) errors.push(`${slash(file)}: ${error.message}`);
    const namespace: ModuleNs = Object.create(null);
    for (const exp of parsed.module.staticExports) for (const entry of exp.entries) {
      const name = entry.exportName.kind === 'Default' ? 'default' : entry.exportName.name;
      if (!entry.isType && name !== null) namespace[name] = marker;
    }
    modules.push({ file, namespace });
    namespaceFile.set(namespace, file);
    return namespace;
  }
  const display = (file: string) => slash(path.relative(srcDir, file));
  async function walk(dir: string, segments: string[]): Promise<DirNode> {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => lexical(a.name, b.name));
    const canonical = '/' + segments.map(routeSegment).join('/');
    const segment = segments.at(-1) ?? '';
    const node: DirNode = { segment, path: routePathWithoutGroups(canonical), group: isGroupSegment(segment), middleware: [], middlewareFiles: [], children: [] };
    const routes = entries.filter(e => e.isFile() && routeFile.test(e.name));
    const layouts = entries.filter(e => e.isFile() && layoutFile.test(e.name));
    for (const [kind, files] of [['route', routes], ['layout', layouts]] as const) {
      if (files.length > 1) errors.push(`only one ${kind} file may be used per directory, found:\n  ${files.map(f => slash(path.join(dir, f.name))).join(', ')}`);
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) node.children.push(await walk(file, [...segments, entry.name]));
      else if (entry.isFile()) {
        if (routeFile.test(entry.name)) {
          const module = await readModule(file);
          node.route ??= { file: display(file), module };
        } else if (layoutFile.test(entry.name)) {
          const module = await readModule(file);
          if (!node.layout) { node.layout = module; node.layoutFile = display(file); }
        } else if (middlewareFile.test(entry.name)) {
          node.middleware.push(await readModule(file)); node.middlewareFiles!.push(display(file));
        }
      }
    }
    return node;
  }
  try { if (!(await stat(routesDir)).isDirectory()) throw new Error('not a directory'); }
  catch (error) { throw new RouteValidationError([`invalid routesDir ${JSON.stringify(routesDir)}: ${String(error)}`]); }
  const tree = await walk(routesDir, []);
  let root: ModuleNs | undefined;
  const rootFile = path.join(srcDir, 'root.tsx');
  try { await stat(rootFile); root = await readModule(rootFile); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const manifest: Manifest = { version: 1, root, tree };
  const plan = resolveRoutes(manifest);
  errors.push(...plan.errors);
  if (errors.length) throw new RouteValidationError(errors);
  modules.sort((a, b) => lexical(a.file, b.file));
  const ids = new Map(modules.map((m, i) => [m.namespace, `m${i}`]));
  const imports = modules.map(m => {
    let specifier = slash(path.relative(path.dirname(out), m.file)).replace(/\.[jt]sx?$/, options.importExtension ?? '');
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) specifier = './' + specifier;
    specifier = specifier.replace(/%/g, '%25').replace(/#/g, '%23').replace(/\?/g, '%3F');
    return `import * as ${ids.get(m.namespace)} from ${JSON.stringify(specifier)};`;
  });
  function emitNode(node: DirNode, depth: number): string {
    const indent = '  '.repeat(depth);
    const fields = [`segment: ${JSON.stringify(node.segment)}`, `path: ${JSON.stringify(node.path)}`, `group: ${node.group}`, `middleware: [${node.middleware.map(m => ids.get(m)).join(', ')}]`, `middlewareFiles: ${JSON.stringify(node.middlewareFiles)}`];
    if (node.layout) fields.push(`layout: ${ids.get(node.layout)}`, `layoutFile: ${JSON.stringify(node.layoutFile)}`);
    if (node.route) fields.push(`route: { file: ${JSON.stringify(node.route.file)}, module: ${ids.get(node.route.module)} }`);
    fields.push(node.children.length ? `children: [\n${node.children.map(n => '  '.repeat(depth + 2) + emitNode(n, depth + 2)).join(',\n')}\n${indent}  ]` : 'children: []');
    return `{\n${fields.map(f => `${indent}  ${f}`).join(',\n')}\n${indent}}`;
  }
  let code = `// generated by recooler-routes; do not edit\nimport type { Manifest } from "recooler/router";\n${imports.join('\n')}\n\nexport const manifest = {\n  version: 1,\n${root ? `  root: ${ids.get(root)},\n` : ''}  tree: ${emitNode(tree, 1)},\n} satisfies Manifest;\n`;
  if (options.routeTypes !== false) code += `\nexport type RoutePath = ${[...new Set(plan.routes.map(r => r.path))].sort(compareRoutePaths).map(p => JSON.stringify(p)).join(' | ') || 'never'};\n`;
  return { code, out, files: [...namespaceFile.values()].sort(lexical), warnings: plan.warnings };
}

export async function generateRoutes(options: GenerateOptions = {}): Promise<GenerateResult> {
  const result = await renderRoutes(options);
  let old: string | undefined;
  try { old = await readFile(result.out, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const changed = old !== result.code;
  if (options.check && changed) throw new StaleRoutesError(result.out);
  if (!options.check && changed) { await mkdir(path.dirname(result.out), { recursive: true }); await writeFile(result.out, result.code); }
  return { ...result, changed };
}

export interface WatchOptions extends GenerateOptions {
  onResult?: (result: GenerateResult) => void;
  onError?: (error: unknown) => void;
}
/** Watches content too, so validation and --check remain useful after export edits. */
export async function watchRoutes(options: WatchOptions = {}): Promise<{ close(): void }> {
  const { routesDir, srcDir, out } = locations(options);
  let closed = false;
  let queue = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchers: FSWatcher[] = [];
  const close = () => { closed = true; clearTimeout(timer); watchers.forEach(w => w.close()); };
  const report = (error: unknown) => (options.onError ?? console.error)(error);
  const run = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      queue = queue.then(async () => {
        if (closed) return;
        try { const result = await generateRoutes(options); options.onResult?.(result); }
        catch (error) { report(error); }
      });
    }, 20);
  };
  const attach = (watcher: FSWatcher) => {
    watchers.push(watcher);
    watcher.on('error', error => { close(); report(error); });
  };
  try {
    attach(fsWatch(routesDir, { recursive: true }, (_event, filename) => {
      if (filename && path.resolve(routesDir, String(filename)) === out) return;
      run();
    }));
    attach(fsWatch(srcDir, (_event, filename) => { if (String(filename) === 'root.tsx') run(); }));
    const result = await generateRoutes(options);
    options.onResult?.(result);
  } catch (error) { close(); throw error; }
  return { close };
}

/** Thin Vite integration; runtime apps and generated manifests need no Vite dependency. */
export function routes(options: GenerateOptions = {}): Plugin {
  let cwd = options.cwd;
  let stop: (() => void) | undefined;
  const generate = () => generateRoutes({ ...options, cwd });
  return {
    name: 'recooler:routes',
    configResolved(config) { cwd ??= config.root; },
    async buildStart() { await generate(); },
    async configureServer(server) {
      const roots = locations({ ...options, cwd });
      server.watcher.add([roots.routesDir, path.join(roots.srcDir, 'root.tsx')]);
      let queue = Promise.resolve();
      const update = (file: string) => {
        const relative = path.relative(roots.routesDir, file);
        if (file !== path.join(roots.srcDir, 'root.tsx') && (relative.startsWith('..' + path.sep) || path.isAbsolute(relative))) return;
        queue = queue.then(async () => { try { await generate(); } catch (error) { server.config.logger.error(String(error)); } });
      };
      server.watcher.on('add', update).on('unlink', update).on('addDir', update).on('unlinkDir', update);
      stop = () => { for (const event of ['add', 'unlink', 'addDir', 'unlinkDir']) server.watcher.off(event, update); };
      server.httpServer?.once('close', () => stop?.());
      await generate();
    },
    closeBundle() { stop?.(); },
  };
}
