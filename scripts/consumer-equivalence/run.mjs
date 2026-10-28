import { mkdtemp, mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureTraces, generateRequests, traceCounts, comparisonRecord, compareTraces } from './traces.mjs';
const adapters = { 'farm-0.0.27': () => import('./adapters/farm-0.0.27.mjs') };

const args = process.argv.slice(2);
let comparePath, expectedDifferencesPath, adapterPath;
let checkout, target = 'farm-0.0.27', probesPath, reuse;
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--') && (!args[i + 1] || args[i + 1].startsWith('--'))) throw new Error(`Missing value for ${args[i]}`);
  if (args[i] === '--target') target = args[++i];
  else if (args[i] === '--probes') probesPath = args[++i];
  else if (args[i] === '--adapter') adapterPath = args[++i];
  else if (args[i] === '--expect-diff') expectedDifferencesPath = args[++i];
  else if (args[i] === '--compare') comparePath = args[++i];
  else if (args[i] === '--reuse') reuse = args[++i];
  else if (!args[i].startsWith('-') && !checkout) checkout = args[i];
  else throw new Error(`Unknown argument: ${args[i]}`);
}
if (!checkout) throw new Error('Usage: node scripts/consumer-equivalence/run.mjs CHECKOUT [--target farm-0.0.27] [--adapter MODULE.mjs] [--probes PRIVATE.json] [--compare SNAPSHOT.json] [--expect-diff PRIVATE.json] [--reuse RUN_DIR]');
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(target)) throw new Error('Target must be a simple snapshot name');
if (!adapterPath && !Object.hasOwn(adapters, target)) throw new Error(`Unsupported target: ${target}`);
const adapter = adapterPath ? await import(pathToFileURL(resolve(adapterPath))) : await adapters[target]();
checkout = await realpath(checkout);
const root = '/private/tmp/consumer-equivalence';
await mkdir(root, { recursive: true });
const run = reuse ? await realpath(reuse) : await mkdtemp(join(root, 'run-'));
if (!run.startsWith(root + '/')) throw new Error('--reuse must be a run directory under /private/tmp/consumer-equivalence');
const clone = join(run, 'checkout');
if (resolve(clone) === checkout || relative(checkout, clone).split('/')[0] !== '..') throw new Error('The build clone must be outside the input checkout');
const probes = probesPath ? JSON.parse(await readFile(probesPath, 'utf8')) : {};
const comparison = comparePath ? JSON.parse(await readFile(comparePath, 'utf8')) : null;
if (comparison && comparison.schemaVersion !== 3) throw new Error('Comparison requires a schemaVersion 3 snapshot');
const expectedDifferences = expectedDifferencesPath ? JSON.parse(await readFile(expectedDifferencesPath, 'utf8')) : [];
if (!Array.isArray(expectedDifferences)) throw new Error('Expected differences must be an array');
if (expectedDifferencesPath && !comparison) throw new Error('--expect-diff requires --compare');
if (expectedDifferences.some(entry => !['router', 'admin'].includes(entry.package))) throw new Error('Expected difference has an unknown package');
async function command(program, args, cwd, log) {
  const chunks = [];
  const child = spawn(program, args, { cwd, env: { ...process.env, HUSKY: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => chunks.push(chunk));
  child.stderr.on('data', chunk => chunks.push(chunk));
  const result = await new Promise((accept, reject) => {
    child.on('error', reject);
    child.on('close', code => accept(code));
  });
  await writeFile(join(run, log), Buffer.concat(chunks));
  if (result !== 0) throw new Error(`${program} exited ${result}; private log: ${join(run, log)}`);
  return Buffer.concat(chunks).toString().trim();
}
if (!reuse) await command('git', ['clone', '--local', '--no-hardlinks', checkout, clone], root, 'clone.log');
const actualClone = await realpath(clone);
if (!actualClone.startsWith(run + '/') || actualClone === checkout) throw new Error('Refusing a checkout symlink outside the temporary run');
if (!reuse) {
  // Never run lifecycle scripts from the input project. Build commands below are explicit.
  await command('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], clone, 'install.log');
}
const sourceCommit = await command('git', ['rev-parse', 'HEAD'], clone, 'commit.log');
const result = { schemaVersion: 3, target, sourceCommit, runtime: process.version, packages: {} };
console.log(`Private run: ${run}`);
for (const name of ['router', 'admin']) {
  const packageRoot = await realpath(join(clone, 'packages', name));
  if (!packageRoot.startsWith(actualClone + '/')) throw new Error('Package directory escapes the temporary clone');
  const packageOut = join(run, name);
  await mkdir(packageOut, { recursive: true });
  const spec = probes[name] || {};
  const optionsFile = join(packageOut, 'probe-options.json');
  await writeFile(optionsFile, JSON.stringify(spec));
  const build = await adapter.prepare({ packageRoot, packageOut, optionsFile, command, name });
  const app = await adapter.load({ packageRoot, packageOut, spec });
  let baseline;
  try {
    baseline = await adapter.load({ packageRoot, packageOut, spec, mode: 'baseline' });
    const snapshot = { catalog: app.catalog, diagnostics: app.diagnostics, runtime: app.runtime, build };
    // Reuse exactly these cases for another target; generation never depends on its registrations.
    const cases = comparison ? comparison.packages[name].traces.map(trace => trace.request) : spec.traceRequests || generateRequests(app.catalog, spec);
    await writeFile(join(packageOut, 'trace-requests.json'), JSON.stringify(cases, null, 2) + '\n');
    snapshot.traces = await captureTraces(app, cases, baseline);
    snapshot.summary = { paths: app.catalog.routes.length, pages: app.catalog.routes.filter(route => route.page).length,
      actionIds: new Set(app.catalog.routes.flatMap(route => route.actions.map(action => action.id))).size,
      actionRoutePairs: app.catalog.routes.reduce((count, route) => count + route.actions.length, 0), dispatch: traceCounts(snapshot.traces) };
    if (comparison) {
      const expected = comparisonRecord(comparison.packages[name]);
      const actual = comparisonRecord(snapshot);
      snapshot.comparison = compareTraces(expected, actual, expectedDifferences.filter(entry => entry.package === name));
      console.log(`${name}: comparison ${snapshot.comparison.differences.length} differences, ${snapshot.comparison.accepted.length} accepted fields, ${snapshot.comparison.unused.length} stale exceptions`);
      if (!snapshot.comparison.equal) process.exitCode = 1;
    }
    snapshot.responses = [];
    const rendered = new Map();
    for (const [index, request] of (spec.requests || []).entries()) {
      let url = request.path;
      if (request.actionFrom !== undefined) {
        const previous = rendered.get(request.actionFrom);
        if (!previous) throw new Error(`Probe ${index} refers to an unavailable earlier response`);
        const body = previous.body;
        const attr = request.attribute || 'hx-post';
        const matches = [...body.matchAll(new RegExp(`${attr}="([^"]+)"`, 'g'))];
        url = matches[request.actionIndex || 0]?.[1]?.replaceAll('&amp;', '&');
        if (!url) throw new Error(`Probe ${index} did not find an action URL`);
        url = new URL(url, previous.url).href;
      }
      const resolvedUrl = new URL(url, 'http://localhost');
      const response = await app.dispatch({ path: resolvedUrl.href, method: request.method || 'GET', headers: request.headers, body: request.body });
      const body = response.body;
      rendered.set(index, { body, url: resolvedUrl.href });
      snapshot.responses.push({ request, url: resolvedUrl.href, status: response.status, headers: response.headers, body, invoked: response.invoked });
    }
    result.packages[name] = snapshot;
    await writeFile(join(packageOut, 'snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n');
    console.log(`${name}: ${JSON.stringify(snapshot.summary)}, responses: ${snapshot.responses.length}`);
  } finally { await app.dispose(); if (baseline) await baseline.dispose(); }
}
await writeFile(join(run, `${target}.json`), JSON.stringify(result, null, 2) + '\n');
console.log(`Snapshot: ${join(run, `${target}.json`)}`);
