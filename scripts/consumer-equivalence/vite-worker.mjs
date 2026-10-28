import { createRequire, syncBuiltinESMExports } from 'node:module';
import crypto from 'node:crypto';
import { readFile, writeFile, mkdir, realpath, access } from 'node:fs/promises';
import { resolve, dirname, join, relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { recooler } from '../../dist/vite/index.js';

const [rootArgument, output, mode, optionsFile] = process.argv.slice(2);
const packageRoot = await realpath(rootArgument);
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const fixture = ['router', 'admin'].some(name => packageRoot === join(repo, 'fixtures/consumer-shape', name));
if (!fixture && !packageRoot.startsWith('/private/tmp/consumer-equivalence/')) throw new Error('Consumer builds must use a temporary equivalence clone');
if (!(await realpath(dirname(output))).startsWith('/private/tmp/')) throw new Error('Output must be private temporary storage');
if (!['baseline', 'probe'].includes(mode)) throw new Error('Unknown mode');
// Stable test-only cache token keeps independent builds byte-comparable.
crypto.randomUUID = () => '00000000-0000-4000-8000-000000000001';
syncBuiltinESMExports();
const spec = JSON.parse(await readFile(optionsFile, 'utf8'));
if (spec.cloudflareEnv) process.env.CLOUDFLARE_ENV = spec.cloudflareEnv;
process.chdir(packageRoot);
const require = createRequire(join(packageRoot, 'package.json'));
const viteRequire = fixture ? createRequire(join(repo, 'package.json')) : require;
const { createBuilder, loadConfigFromFile } = await import(pathToFileURL(viteRequire.resolve('vite')));
const recoolerRoot = fixture ? repo : dirname(require.resolve('recooler/package.json'));
const { default: MagicString } = await import(pathToFileURL(createRequire(join(recoolerRoot, 'package.json')).resolve('magic-string')));
const shimId = '\0virtual:recooler-equivalence';
let instrumented = false;
const instrumentation = {
  name: 'recooler-equivalence', enforce: 'pre', sharedDuringBuild: true,
  resolveId(id) {
    if (id === 'virtual:recooler-equivalence') return shimId;
  },
  transform(code, id) {
    if (id === shimId || this.environment.config.consumer !== 'server') return;
    const matches = [...code.matchAll(/(['"])(recooler\/router|recooler\/htmx)\1/g)];
    if (!matches.length) return;
    const result = new MagicString(code);
    for (const match of matches) result.overwrite(match.index, match.index + match[0].length, "'virtual:recooler-equivalence'");
    return { code: result.toString(), map: result.generateMap({ source: id, includeContent: true, hires: true }) };
  },
  async load(id) {
    if (id !== shimId) return;
    instrumented = true;
    return (await readFile(join(here, 'vite-instrument.mjs'), 'utf8'))
      .replace("/* equivalence-source-root */ 'src'", JSON.stringify(spec.sourceRoot ?? 'src'))
      .replace("'./source-label.mjs'", JSON.stringify(join(here, 'source-label.mjs')))
      .replaceAll("'recooler/router'", JSON.stringify(join(recoolerRoot, 'dist/router/index.js')))
      .replaceAll("'recooler/htmx'", JSON.stringify(join(recoolerRoot, 'dist/htmx/index.js')));
  },
};
const fixturePort = {
  name: 'recooler-equivalence-fixture-port', enforce: 'pre', sharedDuringBuild: true,
  async transform(code, id) {
    if (id === '\0virtual:recooler/app' && packageRoot.endsWith('/admin')) {
      return code.replace('export default createApp', `import pages from ${JSON.stringify(join(packageRoot, 'src/handler.ts'))};\nexport default createApp`).replace('pages: jsxPages()', 'pages');
    }
    if (!id.startsWith(packageRoot + '/') || id.includes('node_modules')) return;
    code = code.replaceAll('recooler::app', 'virtual:recooler/app').replaceAll('farm-plugin-recooler/helpers', 'recooler/jsx')
      .replaceAll('CreateJSXRouteHandlerFactory', 'jsxPages').replace(/(from\s+["'][^"']+\.css)(["'])/g, '$1?inline$2');
    if (/\.[jt]sx$/.test(id)) code = '/** @jsxImportSource recooler/jsx */\n' + code;
    return code;
  },
};
let config;
if (fixture) {
  config = { ssr: { noExternal: true }, plugins: [fixturePort, ...recooler({ routes: { out: join(dirname(output), 'routes.gen.ts') }, htmx: { legacyClientScript: true } })],
    resolve: { alias: Object.fromEntries(['router', 'jsx', 'htmx', 'htmx/runtime', 'jsx/jsx-runtime', 'jsx/jsx-dev-runtime'].map(key => [`recooler/${key}`, join(recoolerRoot, `dist/${key.includes('/') ? key + '.js' : key + '/index.js'}`)])) },
    build: { ssr: 'src/main.ts', minify: false, sourcemap: false, rolldownOptions: { external: [/^cloudflare:/] } } };
  // Exact aliases also cover generated automatic-runtime imports.
  config.resolve.alias = Object.entries(config.resolve.alias).reverse().map(([key, replacement]) => ({ find: new RegExp('^' + key + '$'), replacement }));
} else {
  let configPath = resolve(packageRoot, spec.viteConfig || 'vite.config.ts');
  if (!spec.viteConfig) { try { await access(configPath); } catch { configPath = resolve(packageRoot, 'vite.config.mts'); } }
  const loaded = await loadConfigFromFile({ command: 'build', mode: spec.mode || 'equivalence' }, configPath);
  if (!loaded) throw new Error('Missing Vite config');
  config = loaded.config;
}
config.plugins = [mode === 'probe' && instrumentation, ...config.plugins];
config.root = packageRoot;
config.configFile = false;
config.mode = spec.mode || 'equivalence';
if (!fixture && spec.defines && Object.keys(spec.defines).length) throw new Error('Vite equivalence uses the port mode profile; define overrides are forbidden');
config.logLevel = 'warn';
// Build through the platform's builder, then read its actual environment outDirs.
const builder = await createBuilder(config);
for (const environment of Object.values(builder.environments)) {
  const server = environment.config.consumer === 'server';
  environment.config.build.outDir = server ? output : join(dirname(output), `${mode}-client`);
  environment.config.build.emptyOutDir = true;
  if (server) {
    environment.config.build.rolldownOptions.output = { ...environment.config.build.rolldownOptions.output, entryFileNames: 'main.js' };
  }
}
await builder.buildApp();
if (mode === 'probe' && !instrumented) throw new Error('No instrumented createApp import');
await mkdir(dirname(output), { recursive: true });
await writeFile(join(dirname(output), `${mode}-build.json`), JSON.stringify({ recooler: '0.1.0', vite: JSON.parse(await readFile(viteRequire.resolve('vite/package.json'), 'utf8')).version, testBuildId: '00000000-0000-4000-8000-000000000001', instrumentation: mode === 'probe', resolvedDefines: config.define || {}, mode: config.mode, cloudflareEnv: process.env.CLOUDFLARE_ENV, environments: Object.fromEntries(Object.entries(builder.environments).map(([name, env]) => [name, { consumer: env.config.consumer, outDir: relative(dirname(output), env.config.build.outDir) }])) }, null, 2) + '\n');
