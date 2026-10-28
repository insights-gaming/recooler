import vm from 'node:vm';
import { Window, type AbortSignal } from 'happy-dom';
import { afterEach, expect, test } from 'vitest';
import { clientEntry } from '../../src/vite/client.js';

const windows: Window[] = [];
const marker = (route = 'a', version = '') => `<template data-recooler-marker data-recooler-route="${route}" data-recooler-version="${version}"></template>`;
function setup(onLoads: Record<string, (context: { signal: AbortSignal }) => unknown>, html = marker()) {
  const window = new Window({ settings: { suppressInsecureJavaScriptEnvironmentWarning: true } });
  windows.push(window);
  window.document.body.innerHTML = html;
  Object.defineProperty(window.document, 'readyState', { value: 'complete' });
  const errors: unknown[] = [];
  const entries = Object.entries(onLoads);
  Object.assign(window, { reportError: (error: unknown) => errors.push(error), entries: entries.map(([, onLoad], i) => [String(i), { onLoad }]) });
  const code = clientEntry(Object.fromEntries(entries.map(([route]) => [route, { slices: [route], onLoad: route }])), id => id);
  const context = vm.createContext(window);
  vm.runInContext(code.replace(/^export const /gm, 'const ') + '\nregister(globalThis.entries);', context);
  const init = () => vm.runInContext('globalThis.__recooler_client.init()', context);
  const event = (name: string) => window.document.dispatchEvent(new window.CustomEvent(name));
  return { window, document: window.document, init, event, errors };
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

test('aborts in reverse initialization order and continues if abort throws', async () => {
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
