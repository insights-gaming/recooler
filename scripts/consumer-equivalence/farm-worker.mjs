import { createRequire } from 'node:module';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import ts from 'typescript';
import { snapshotPlugin } from './instrument.mjs';

const [rootArgument, output, mode, optionsFile] = process.argv.slice(2);
const actualRoot = await realpath(rootArgument);
const packageRoot = actualRoot;
const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures/consumer-shape');
const syntheticFixture = ['router', 'admin'].some(name => actualRoot === join(fixtureRoot, name));
if (!syntheticFixture && !actualRoot.startsWith('/private/tmp/consumer-equivalence/')) {
  throw new Error('Consumer builds must run inside a temporary equivalence clone');
}
if (!(await realpath(dirname(output))).startsWith('/private/tmp/')) throw new Error('Build output must be private temporary storage');
if (!['baseline', 'probe'].includes(mode)) throw new Error('Unknown build mode');
process.chdir(actualRoot);
const require = createRequire(join(actualRoot, 'package.json'));
for (const [name, expected] of [['@farmfe/core', '1.7.11'], ['farm-plugin-recooler', '0.0.27']]) {
  const actual = JSON.parse(await readFile(require.resolve(`${name}/package.json`), 'utf8')).version;
  if (actual !== expected) throw new Error(`Expected ${name}@${expected}, found ${actual}`);
}
const { resolveConfig, createCompiler, Logger } = await import(pathToFileURL(join(dirname(require.resolve('@farmfe/core/package.json')), 'dist/index.js')));
const options = optionsFile ? JSON.parse(await readFile(optionsFile, 'utf8')) : {};
// Deployment tools normally supply these macros. Derive inert local values from
// declarations rather than embedding consumer identifiers in this public script.
let declarations = '';
try { declarations = await readFile(resolve(packageRoot, '../../global.d.ts'), 'utf8'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const declared = [];
const declarationAst = ts.createSourceFile('global.d.ts', declarations, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function collect(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && /^__[A-Z0-9_]+__$/.test(node.name.text)) {
    declared.push({ name: node.name.text, type: node.type?.kind });
  }
  ts.forEachChild(node, collect);
}
collect(declarationAst);
const localDefines = Object.fromEntries(declared.filter(({ type }) => [ts.SyntaxKind.BooleanKeyword, ts.SyntaxKind.StringKeyword].includes(type))
  .map(({ name, type }) => [name, type === ts.SyntaxKind.BooleanKeyword ? 'false' : JSON.stringify('')]));
const logger = new Logger();
const plugin = snapshotPlugin(packageRoot);
const config = await resolveConfig({ configPath: resolve('farm.config.ts'), root: packageRoot, clearScreen: false,
  plugins: mode === 'probe' ? [plugin] : [],
}, 'production', logger, false);
config.compilation.define = { ...localDefines, ...config.compilation.define, ...options.defines };
for (const { name } of declared) {
  if (!Object.hasOwn(config.compilation.define, name) || config.compilation.define[name] === undefined) {
    throw new Error(`Declared macro has no build value: ${name}`);
  }
}
config.compilation.persistentCache = false;
config.compilation.output.path = output;
config.compilation.output.filename = '[resourceName].[ext]';
config.compilation.progress = false;
// The frozen plugin cannot safely read Farm's decorator config through its ABI.
if (config.compilation.script) delete config.compilation.script.decorators;
const compiler = await createCompiler(config, logger);
await compiler.compile();
compiler.writeResourcesToDisk();
if (mode === 'probe' && !plugin.instrumented) throw new Error('The generated app was never instrumented');
await writeFile(join(dirname(output), `${mode}-build.json`), JSON.stringify({
  farm: '1.7.11', recooler: '0.0.27', persistentCache: false, decorators: false,
  instrumentation: mode === 'probe', localDefines, explicitDefines: options.defines || {}, resources: Object.keys(compiler.resources()).sort(),
}, null, 2) + '\n');
