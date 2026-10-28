import { createRequire } from 'node:module';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

// This exact wrapper runs in both Node fixture checks and both workerd builds.
// Keep it self-contained: loadRuntime serialises the function into the Worker.
export async function dispatchWorker(worker, input, env, ctx) {
  const invoked = [], errors = [], originalConsole = {};
  for (const key of ['error', 'log', 'warn', 'info', 'debug']) {
    originalConsole[key] = console[key];
    console[key] = (...args) => errors.push(args.map(value => String(value)).join(' '));
  }
  let status = null, headers = {};
  globalThis.__recoolerTrace = invoked;
  try {
    const response = await worker.fetch(new Request(new URL(input.path, 'http://localhost'), {
      method: input.method || 'GET', headers: input.headers, body: input.body,
    }), env, ctx);
    if (!(response instanceof Response)) {
      return { invoked, status, headers: {}, body: '', error: 'NonResponse',
        returnedType: response === null ? 'null' : `${typeof response}:${Object.prototype.toString.call(response)}`,
        returnedConstructor: response?.constructor?.name ?? null, errors };
    }
    status = response.status;
    headers = Object.fromEntries(response.headers);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { invoked, status, headers,
      body: new TextDecoder().decode(bytes), bodyBase64: btoa(binary), errors };
  } catch (error) {
    return { invoked, status, headers, body: '', error: error?.name || 'ThrownValue',
      errorMessage: error?.message || String(error), errors };
  } finally { globalThis.__recoolerTrace = undefined; Object.assign(console, originalConsole); }
}

// Optional, explicit test environment. No body or error-message normalization.
export function deterministicEnvironment(options) {
  if (!options) return () => {};
  if (!Number.isFinite(options.epochMs) || typeof options.seed !== 'string') throw new Error('determinism requires epochMs and seed');
  const NativeDate = Date;
  globalThis.Date = new Proxy(NativeDate, {
    apply() { return new NativeDate(options.epochMs).toString(); },
    construct(target, args) { return Reflect.construct(target, args.length ? args : [options.epochMs]); },
    get(target, key) { return key === 'now' ? () => options.epochMs : Reflect.get(target, key); },
  });
  let state;
  const reset = key => {
    state = 2166136261;
    for (const char of options.seed + key) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0;
    if (!state) state = 1;
  };
  const next = () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return state >>> 0;
  };
  reset('module-initialization');
  Math.random = () => next() / 4294967296;
  crypto.getRandomValues = array => {
    if (!ArrayBuffer.isView(array) || array instanceof DataView || array instanceof Float32Array || array instanceof Float64Array) throw new TypeError('Expected an integer TypedArray');
    if (array.byteLength > 65536) throw new DOMException('Quota exceeded', 'QuotaExceededError');
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    for (let i = 0; i < bytes.length; i++) bytes[i] = next() & 255;
    return array;
  };
  crypto.randomUUID = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  };
  return reset;
}

export async function loadRuntime({ packageRoot, packageOut, spec, mode }) {
  if (spec.fixture) {
    const { default: worker } = await import(pathToFileURL(join(packageOut, mode, 'main.js')));
    const entries = globalThis.__recoolerEquivalence;
    const env = { SERVICE: { fetch: () => new Response('stub-service', { headers: { 'x-service': 'stub' } }) } };
    const ctx = { waitUntil: task => { Promise.resolve(task).catch(() => {}); }, passThroughOnException() {} };
    return { runtime: { fixture: true }, entries: async () => entries,
      dispatch: input => dispatchWorker(worker, input, env, ctx),
      async dispatchBatch(inputs) {
        const responses = [];
        for (const input of inputs) responses.push(await dispatchWorker(worker, input, env, ctx));
        return responses;
      }, dispose: async () => {} };
  }
  const require = createRequire(join(packageRoot, 'package.json'));
  const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
  const { Miniflare, Log, LogLevel } = await import(pathToFileURL(wranglerRequire.resolve('miniflare')));
  const config = JSON.parse(await readFile(join(packageRoot, spec.wranglerConfig || 'wrangler.generated.json'), 'utf8'));
  if (!config.compatibility_date) throw new Error('Wrangler compatibility_date is required');
  const virtualRoot = join('/__recooler_equivalence__', basename(packageRoot));
  const wrapper = join(packageOut, `${mode}-worker.mjs`);
  await writeFile(wrapper, `import { reset } from './environment.mjs';
import worker from './${mode}/main.js';
export * from './${mode}/main.js';
const dispatchWorker = ${dispatchWorker.toString()};
export default { async fetch(req, env, ctx) {
  if (new URL(req.url).pathname === '/__recooler_catalog__') return Response.json(globalThis.__recoolerEquivalence);
  const input = await req.json();
  if (!Array.isArray(input)) { reset(input.caseKey || JSON.stringify(input)); return Response.json(await dispatchWorker(worker, input, env, ctx)); }
  const responses = [];
  for (const request of input) { reset(request.caseKey || JSON.stringify(request)); responses.push(await dispatchWorker(worker, request, env, ctx)); }
  return Response.json(responses);
} };\n`);
  const modules = [
    { type: 'ESModule', path: join(virtualRoot, `${mode}-worker.mjs`), contents: await readFile(wrapper, 'utf8') },
    { type: 'ESModule', path: join(virtualRoot, 'environment.mjs'), contents: `const init = ${deterministicEnvironment.toString()}; export const reset = init(${JSON.stringify(spec.determinism || null)});` },
  ];
  async function collect(directory, parts = []) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await collect(join(directory, entry.name), [...parts, entry.name]);
      else if (/\.(?:m?js)$/.test(entry.name)) modules.push({ type: 'ESModule', path: join(virtualRoot, mode, ...parts, entry.name), contents: await readFile(join(directory, entry.name), 'utf8') });
    }
  }
  await collect(join(packageOut, mode));
  const compatibility = { compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags || [] };
  const stubWorkers = [];
  const serviceBindings = Object.fromEntries((spec.serviceBindings || []).map((binding, index) => {
    const methods = spec.rpcServiceMethods?.[binding];
    if (!methods) return [binding, () => new Response('stub-service')];
    if (!Array.isArray(methods) || methods.some(method => !/^[A-Za-z_][A-Za-z_0-9]*$/.test(method) || ['constructor', 'fetch'].includes(method))) throw new Error('Invalid RPC stub method');
    const name = `equivalence-stub-${index}`;
    stubWorkers.push({ name, modulesRoot: virtualRoot, ...compatibility, modules: [{ type: 'ESModule', path: join(virtualRoot, `${name}.mjs`),
      contents: `import { WorkerEntrypoint } from 'cloudflare:workers';
export default class extends WorkerEntrypoint {
  fetch() { return new Response('stub-service'); }
  ${methods.map(method => `[${JSON.stringify(method)}]() { throw new Error('RPC disabled by equivalence harness'); }`).join('\n')}
}` }] });
    return [binding, { name }];
  }));
  if (Object.keys(spec.rpcServiceMethods || {}).some(binding => !Object.hasOwn(serviceBindings, binding))) throw new Error('RPC methods require a configured service binding');
  const mf = new Miniflare({ log: new Log(LogLevel.NONE), workers: [{
    name: 'equivalence-app', modules, modulesRoot: virtualRoot, ...compatibility,
    outboundService: () => new Response('network disabled by equivalence harness', { status: 503 }),
    bindings: spec.bindings || {}, kvNamespaces: spec.kvNamespaces || [], serviceBindings,
  }, ...stubWorkers] });
  try {
    for (const [binding, values] of Object.entries(spec.kvInitialData || {})) {
      if (!(spec.kvNamespaces || []).includes(binding)) throw new Error('KV initial data requires a configured namespace');
      const kv = await mf.getKVNamespace(binding);
      for (const [key, value] of Object.entries(values)) {
        if (typeof value !== 'string') throw new Error('KV initial values must be strings');
        await kv.put(key, value);
      }
    }
  } catch (error) { await mf.dispose(); throw error; }
  return { runtime: { ...compatibility, deterministic: spec.determinism || null, rpcStubs: spec.rpcServiceMethods || {} },
    async entries() {
      const response = await mf.dispatchFetch('http://localhost/__recooler_catalog__');
      if (response.status !== 200) throw new Error(`Catalog endpoint returned ${response.status}`);
      return response.json();
    },
    async dispatch(request) {
      const response = await mf.dispatchFetch('http://localhost/__recooler_dispatch__', { method: 'POST', body: JSON.stringify(request) });
      if (response.status !== 200) throw new Error(`Dispatch endpoint returned ${response.status}`);
      return response.json();
    },
    async dispatchBatch(requests) {
      const response = await mf.dispatchFetch('http://localhost/__recooler_dispatch__', { method: 'POST', body: JSON.stringify(requests) });
      if (response.status !== 200) throw new Error(`Dispatch endpoint returned ${response.status}`);
      return response.json();
    }, dispose: () => mf.dispose() };
}
