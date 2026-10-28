import vm from 'node:vm';
import { Window, type AbortSignal } from 'happy-dom';
import { afterEach, expect, test } from 'vitest';
import { clientEntry } from '../../src/vite/client.js';

const windows: Window[] = [];
const marker = (route = 'a', version = '') => `<template data-recooler-marker data-recooler-route="${route}" data-recooler-version="${version}"></template>`;
function setup(onLoads: Record<string, (context: { signal: AbortSignal }) => unknown>, html = marker(), pending: string[] = []) {
  const window = new Window({ settings: { suppressInsecureJavaScriptEnvironmentWarning: true } });
  windows.push(window);
  window.document.body.innerHTML = html;
  Object.defineProperty(window.document, 'readyState', { value: 'complete' });
  const errors: unknown[] = [];
  const entries = Object.keys(onLoads).sort().map(route => [route, onLoads[route]!] as const);
  Object.assign(window, { reportError: (error: unknown) => errors.push(error), entries: entries.map(([, onLoad], i) => [String(i), { onLoad }]) });
  const code = clientEntry(Object.fromEntries(entries.map(([route]) => [route, { slices: [route], onLoad: route }])), id => id);
  const context = vm.createContext(window);
  Object.assign(window, { pending: pending.map(route => String(entries.findIndex(([name]) => name === route))), releases: {} });
  vm.runInContext(code.replace(/^export const /gm, 'const ') + `
register(globalThis.entries.map(([id, module]) => [id, globalThis.pending.includes(id)
    ? new Promise(resolve => { globalThis.releases[id] = () => resolve(module); }) : module]));`, context);
  const init = () => vm.runInContext('globalThis.__recooler_client.init()', context);
  const event = (name: string) => window.document.dispatchEvent(new window.CustomEvent(name));
  const finish = (route: string) => vm.runInContext(`globalThis.releases[${JSON.stringify(String(entries.findIndex(([name]) => name === route)))}]()`, context);
  return { window, document: window.document, init, event, errors, finish };
}
afterEach(async () => { await Promise.all(windows.splice(0).map(window => window.happyDOM.close())); });

test('aborts removed markers before new onLoad calls, once despite repeated events', async () => {
  const log: string[] = [];
  const { document, init, event } = setup({ a: ({ signal }) => { log.push('a'); signal.addEventListener('abort', () => log.push('abort a')); }, b: () => { log.push('b'); } });
  await init();
  document.body.innerHTML = marker('b');
  event('htmx:afterSwap'); event('htmx:afterSettle'); await init();
  expect(log).toEqual(['a', 'abort a', 'b']);
});

test('init aborts synchronously with no markers left, before the observer runs', async () => {
  let aborted = false;
  const { document, init } = setup({ a: ({ signal }) => signal.addEventListener('abort', () => { aborted = true; }) });
  await init();
  document.body.innerHTML = '';
  const ready = init();
  expect(aborted).toBe(true);
  await ready;
});

test('observes removals without init and ignores full unload events', async () => {
  let aborts = 0;
  const { window, document, init } = setup({ a: ({ signal }) => signal.addEventListener('abort', () => { aborts++; }) });
  await init();
  for (const name of ['beforeunload', 'pagehide', 'unload']) window.dispatchEvent(new window.Event(name));
  expect(aborts).toBe(0);
  document.body.innerHTML = '';
  await window.happyDOM.waitUntilComplete();
  expect(aborts).toBe(1);
  await init(); expect(aborts).toBe(1);
});

test('reentrant init during onLoad retains the live marker signal', async () => {
  let reenter = () => {}, loads = 0, aborts = 0;
  const { document, init } = setup({ a: ({ signal }) => { loads++; reenter(); signal.addEventListener('abort', () => { aborts++; }); } });
  await init(); reenter = init;
  document.body.innerHTML = marker(); await init();
  expect(loads).toBe(2); expect(aborts).toBe(1);
  document.body.innerHTML = ''; await init();
  expect(aborts).toBe(2);
});

test('retires a marker when its route or version changes', async () => {
  const log: string[] = [];
  const { document, init } = setup({ a: ({ signal }) => { log.push('a'); signal.addEventListener('abort', () => log.push('abort a')); }, b: ({ signal }) => { log.push('b'); signal.addEventListener('abort', () => log.push('abort b')); } });
  await init();
  const node = document.querySelector('template')!;
  node.dataset.recoolerRoute = 'b'; await init();
  node.dataset.recoolerVersion = 'next'; await init(); await init();
  expect(log).toEqual(['a', 'abort a', 'b', 'abort b', 'b']);
});

for (const attribute of ['recoolerRoute', 'recoolerVersion']) test('retires a stale instance changed earlier in the same pass: ' + attribute, async () => {
  const log: string[] = [];
  let change = () => {};
  const { document, init } = setup({
    a: () => { change(); },
    b: ({ signal }) => { log.push('b'); signal.addEventListener('abort', () => log.push('abort b')); },
    c: () => { log.push('c'); },
  }, marker('b'));
  await init();
  const node = document.querySelector('template')!;
  change = () => { node.dataset[attribute] = attribute === 'recoolerRoute' ? 'c' : 'next'; };
  document.body.insertAdjacentHTML('afterbegin', marker());
  await init();
  expect(log).toEqual(['b', 'abort b', attribute === 'recoolerRoute' ? 'c' : 'b']);
});

test('async onLoad resolves live and its listeners are removed on retirement', async () => {
  let finish!: () => void, aborts = 0, calls = 0;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const { window, document, init } = setup({ a: async ({ signal }) => {
    signal.addEventListener('abort', () => { aborts++; });
    window.addEventListener('drop', () => { calls++; }, { signal });
    await pending;
    window.addEventListener('drop', () => { calls++; }, { signal });
  } }, '');
  document.body.innerHTML = marker(); await init();
  window.dispatchEvent(new window.Event('drop')); expect(calls).toBe(1);
  finish(); await pending; await Promise.resolve();
  window.dispatchEvent(new window.Event('drop')); expect(calls).toBe(3);
  document.body.innerHTML = ''; await init();
  window.dispatchEvent(new window.Event('drop'));
  expect(calls).toBe(3); expect(aborts).toBe(1);
  await init(); expect(aborts).toBe(1);
});

test('aborts in reverse initialization order and continues if AbortController.abort is patched to throw', async () => {
  const log: string[] = [], error = new Error('abort failed');
  const { window, document, init, errors } = setup({
    a: ({ signal }) => { signal.addEventListener('abort', () => log.push('abort a')); },
    b: ({ signal }) => { signal.addEventListener('abort', () => log.push('abort b')); },
    c: () => { log.push('c'); },
  }, '');
  const abort = window.AbortController.prototype.abort;
  window.AbortController.prototype.abort = function (...args) { abort.apply(this, args); throw error; };
  document.body.innerHTML = marker() + '<div>' + marker('b') + '</div>'; await init();
  document.body.innerHTML = marker('c'); await init();
  expect(errors).toEqual([error, error]); expect(log).toEqual(['abort b', 'abort a', 'c']);
});

test('history snapshots retain live markers and restoration prunes before initialization', async () => {
  const log: string[] = [];
  const { document, init, event } = setup({ a: ({ signal }) => { log.push('a'); signal.addEventListener('abort', () => log.push('abort a')); } });
  await init(); event('htmx:beforeHistorySave'); await Promise.resolve(); await init();
  expect(log).toEqual(['a']);
  document.body.innerHTML = '';
  document.body.innerHTML = marker(); event('htmx:historyRestore'); event('htmx:afterSettle'); await init();
  expect(log).toEqual(['a', 'abort a', 'a']);
});

test('reattaching the same marker in a later task gets a fresh signal', async () => {
  const signals: AbortSignal[] = [];
  let aborts = 0;
  const { window, document, init } = setup({ a: ({ signal }) => { signals.push(signal); signal.addEventListener('abort', () => { aborts++; }); } });
  await init();
  const node = document.querySelector('template')!;
  node.remove(); await window.happyDOM.waitUntilComplete();
  expect(aborts).toBe(1); expect(signals[0]!.aborted).toBe(true);
  expect(signals[0]!.reason.name).toBe('AbortError');
  document.body.append(node); await init();
  expect(signals).toHaveLength(2); expect(signals[1]).not.toBe(signals[0]); expect(signals[1]!.aborted).toBe(false);
  expect(aborts).toBe(1);
});

test('ignores return values including listener functions and reports onLoad failures', async () => {
  const error = new Error('onLoad failed'), syncError = new Error('sync onLoad failed');
  let returns = 0;
  const listener = () => { returns++; };
  const { document, init, errors } = setup({ a: () => listener, b: () => Promise.resolve(listener), c: () => Promise.reject(error), d: () => { throw syncError; } }, marker() + marker('b') + marker('c') + marker('d'));
  await init(); await Promise.resolve(); document.body.innerHTML = ''; await init();
  expect(returns).toBe(0); expect(errors).toContain(error); expect(errors).toContain(syncError);
});

for (const change of ['remove', 'route']) test('prunes markers retired by an earlier onLoad before later calls: ' + change, async () => {
  const log: string[] = [];
  let retire = () => {};
  const { document, init } = setup({
    f: ({ signal }) => { log.push('f load'); signal.addEventListener('abort', () => log.push('f abort')); },
    n1: () => { log.push('n1 load'); retire(); },
    n2: () => { log.push('n2 load'); },
  }, marker('f'));
  await init();
  const node = document.querySelector('template')!;
  retire = () => { if (change === 'remove') node.remove(); else node.dataset.recoolerRoute = 'n2'; };
  for (const route of ['n1', 'n2']) {
    const next = document.createElement('template');
    next.dataset.recoolerMarker = ''; next.dataset.recoolerRoute = route; next.dataset.recoolerVersion = '';
    document.body.insertBefore(next, node);
  }
  await init();
  expect(log.slice(0, 4)).toEqual(['f load', 'n1 load', 'f abort', 'n2 load']);
});

test('retires by start order when the first marker waits for its slice', async () => {
  const log: string[] = [];
  const { document, init, finish } = setup({
    a: ({ signal }) => { log.push('a load'); signal.addEventListener('abort', () => log.push('a abort')); },
    b: ({ signal }) => { log.push('b load'); signal.addEventListener('abort', () => log.push('b abort')); },
  }, marker() + marker('b'), ['a']);
  expect(log).toEqual(['b load']);
  finish('a'); await init();
  expect(log).toEqual(['b load', 'a load']);
  document.body.innerHTML = ''; await init();
  expect(log).toEqual(['b load', 'a load', 'a abort', 'b abort']);
});

test('does not start a retired pending instance reattached without init', async () => {
  const signals: AbortSignal[] = [];
  const { window, document, init, finish } = setup({ a: ({ signal }) => { signals.push(signal); } }, marker(), ['a']);
  const ready = init();
  await Promise.resolve(); await Promise.resolve();
  const node = document.querySelector('template')!;
  node.remove(); await window.happyDOM.waitUntilComplete();
  document.body.append(node); await window.happyDOM.waitUntilComplete();
  finish('a'); await ready;
  expect(signals).toEqual([]);
  await init();
  expect(signals).toHaveLength(1); expect(signals[0]!.aborted).toBe(false);
});

test('suppresses expected abort failures and still reports unrelated failures after retirement', async () => {
  const unrelated = new Error('unrelated');
  const { window, document, init, errors } = setup({
    a: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
    b: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new window.DOMException('fetch canceled', 'AbortError')))),
    c: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(unrelated))),
    d: () => Promise.reject(new window.DOMException('not canceled', 'AbortError')),
  }, '');
  document.body.innerHTML = marker() + marker('b') + marker('c') + marker('d'); await init();
  document.body.innerHTML = ''; await init(); await Promise.resolve();
  expect(errors).toHaveLength(2); expect(errors).toContain(unrelated);
  expect((errors[0] as Error).message).toBe('not canceled');
});
