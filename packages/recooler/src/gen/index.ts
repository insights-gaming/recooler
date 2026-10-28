import { createHash, randomUUID } from 'node:crypto';
import { watch as fsWatch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseSync } from 'oxc-parser';
import { compareRoutePaths, isGroupSegment, lexical, resolveRoutes, RouteValidationError, routePathWithoutGroups, routeSegment } from '../router/resolve.js';
import { locations } from './locations.js';
import type { DirNode, Manifest, ModuleNs } from '../router/types.js';

export interface GenerateOptions {
  /** Paths are relative to cwd (default process.cwd()). */
  cwd?: string;
  srcDir?: string;
  routesDir?: string;
  out?: string;
  importExtension?: '' | '.js' | 'source';
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
const middlewareFile = /^middleware(?:@[\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}-]+)?\.[jt]sx?$/u;
const marker = () => undefined;
interface SourceModule { file: string; namespace: ModuleNs; }

/** Scan and render without writing; namespace imports keep output independent of export edits. */
export async function renderRoutes(options: GenerateOptions = {}): Promise<Omit<GenerateResult, 'changed'>> {
  const { srcDir, routesDir, out } = locations(options);
  const errors: string[] = [];
  const warnings: string[] = [];
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
      if (entry.isDirectory()) {
        if (/[\\%#?]/.test(entry.name)) {
          const suggestion = entry.name.includes('\\d') ? 'use [0-9] instead of \\d in digit patterns' : 'rename the directory to avoid these characters';
          errors.push(`invalid route directory ${display(file)}: names containing \\, %, # or ? are not portable; ${suggestion}`);
        }
        node.children.push(await walk(file, [...segments, entry.name]));
      } else if (entry.isFile()) {
        if (routeFile.test(entry.name)) {
          const module = await readModule(file);
          node.route ??= { file: display(file), module };
        } else if (layoutFile.test(entry.name)) {
          const module = await readModule(file);
          if (!node.layout) { node.layout = module; node.layoutFile = display(file); }
        } else if (middlewareFile.test(entry.name)) {
          node.middleware.push(await readModule(file)); node.middlewareFiles!.push(display(file));
        } else if (entry.name.startsWith('middleware')) {
          warnings.push(`WARNING: ignored unrecognized middleware file ${display(file)}; expected middleware[@name].[jt]sx?`);
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
  const manifest: Manifest = { version: 1, root, rootFile: root ? display(rootFile) : undefined, tree };
  const plan = resolveRoutes(manifest);
  errors.push(...plan.errors);
  if (errors.length) throw new RouteValidationError(errors);
  modules.sort((a, b) => lexical(a.file, b.file));
  // Path-derived ids stay stable across insertions. Extend a hash on the unlikely collision.
  const used = new Set<string>();
  const ids = new Map(modules.map(m => {
    const file = display(m.file);
    const prefix = routeFile.test(path.basename(file)) ? 'r' : layoutFile.test(path.basename(file)) ? 'l' : middlewareFile.test(path.basename(file)) ? 'mw' : 'root';
    const readable = file.replace(/\.[jt]sx?$/, '').replace(/[^a-zA-Z0-9]+/g, '_');
    const hash = createHash('sha256').update(file).digest('hex');
    let length = 12;
    let id = `${prefix}_${readable}_${hash.slice(0, length)}`;
    while (used.has(id)) id = `${prefix}_${readable}_${hash.slice(0, ++length)}`;
    used.add(id);
    return [m.namespace, id] as const;
  }));
  const imports = modules.map(m => {
    let specifier = slash(path.relative(path.dirname(out), m.file));
    if (options.importExtension !== 'source') {
      // Vite resolves .js to .ts/.tsx, but does not resolve .js to .jsx.
      specifier = specifier.replace(/\.[jt]sx?$/, extension => options.importExtension === '.js' && extension === '.jsx' ? '.jsx' : options.importExtension ?? '');
    }
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) specifier = './' + specifier;
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
  let code = `// generated by recooler-routes; do not edit\nimport type { Manifest } from "recooler/router";\n${imports.join('\n')}\n\nexport const manifest = {\n  version: 1,\n${root ? `  root: ${ids.get(root)},\n  rootFile: ${JSON.stringify(manifest.rootFile)},\n` : ''}  tree: ${emitNode(tree, 1)},\n} satisfies Manifest;\n`;
  if (options.routeTypes !== false) code += `\nexport type RoutePath = ${[...new Set(plan.routes.map(r => r.path))].sort(compareRoutePaths).map(p => JSON.stringify(p)).join(' | ') || 'never'};\n`;
  return { code, out, files: [...namespaceFile.values()].sort(lexical), warnings: [...warnings, ...plan.warnings] };
}

export async function generateRoutes(options: GenerateOptions = {}): Promise<GenerateResult> {
  const result = await renderRoutes(options);
  let old: string | undefined;
  try { old = await readFile(result.out, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const changed = old?.replace(/\r\n/g, '\n') !== result.code;
  if (options.check && changed) throw new StaleRoutesError(result.out);
  if (!options.check && changed) { await mkdir(path.dirname(result.out), { recursive: true }); await writeFile(result.out, result.code); }
  return { ...result, changed };
}

export interface WatchOptions extends GenerateOptions {
  /** Called after native watchers observe a readiness event, before initial generation. */
  onReady?: () => void;
  onResult?: (result: GenerateResult) => void;
  onError?: (error: unknown) => void;
}
/** Watches content too, so validation and --check remain useful after export edits. */
export async function watchRoutes(options: WatchOptions = {}): Promise<{ close(): Promise<void> }> {
  const { routesDir, srcDir, out } = locations(options);
  let closed = false;
  let queue = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchers: FSWatcher[] = [];
  const close = async () => {
    closed = true;
    clearTimeout(timer);
    watchers.forEach(w => w.close());
    await sourceQueue.catch(() => {});
    await queue.catch(() => {});
  };
  const report = (error: unknown) => (options.onError ?? console.error)(error);
  const generate = async () => {
    if (closed) return;
    const result = await generateRoutes(options);
    options.onResult?.(result);
  };
  const run = () => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(() => { queue = queue.then(generate).catch(report); }, 20);
  };
  const attach = (watcher: FSWatcher) => {
    watchers.push(watcher);
    watcher.on('error', error => { void close(); report(error); });
  };
  // fs.watch has no ready event. Observe a private sentinel before allowing callers
  // to mutate files; a timer alone can race native enrollment on a busy machine.
  const watchReady = async (dir: string, recursive: boolean, changed: (filename: string | null) => void) => {
    const sentinel = `.recooler-watch-ready-${randomUUID()}`;
    const file = path.join(dir, sentinel);
    let ready!: () => void;
    let isReady = false;
    const observed = new Promise<void>(resolve => { ready = () => { isReady = true; resolve(); }; });
    attach(fsWatch(dir, { recursive }, (_event, filename) => {
      if (String(filename) === sentinel) { ready(); return; }
      changed(filename === null ? null : String(filename));
    }));
    const deadline = Date.now() + 10000;
    try {
      // Enrollment can miss the first write. Retry until an event is observed.
      while (!isReady) {
        if (closed) throw new Error(`watcher closed before readiness for ${dir}`);
        if (Date.now() >= deadline) throw new Error(`watcher readiness timed out for ${dir}`);
        await writeFile(file, '');
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([observed, new Promise<void>(resolve => { timer = setTimeout(resolve, 25); })]); }
        finally { clearTimeout(timer); }
      }
    } finally { await unlink(file).catch(() => {}); }
  };
  const sourceWatchDirs = new Set<string>();
  let sourceQueue = Promise.resolve();
  const watchSource = async () => {
    // Only direct children matter for root.tsx. If srcDir is missing, watch an
    // existing ancestor non-recursively, then descend when its children appear.
    let dir = srcDir;
    while (true) {
      try { await stat(dir); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        dir = path.dirname(dir);
      }
    }
    if (closed || sourceWatchDirs.has(dir)) return;
    sourceWatchDirs.add(dir);
    await watchReady(dir, false, filename => {
      const file = filename === null ? dir : path.resolve(dir, filename);
      if (filename === null || file === path.join(srcDir, 'root.tsx') || file === srcDir || srcDir.startsWith(file + path.sep)) {
        sourceQueue = sourceQueue.then(watchSource).then(run).catch(report);
      }
    });
  };
  try {
    await watchReady(routesDir, true, filename => {
      if (filename && path.resolve(routesDir, filename) === out) return;
      run();
    });
    await watchSource();
    options.onReady?.();
    // Initial generation uses the same queue as debounced events and close().
    queue = queue.then(generate);
    await queue;
  } catch (error) { await close(); throw error; }
  return { close };
}
