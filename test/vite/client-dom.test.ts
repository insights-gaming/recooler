import vm from 'node:vm';
import { Window } from 'happy-dom';
import { afterEach, expect, test } from 'vitest';
import { clientEntry } from '../../src/vite/client.js';

const windows: Window[] = [];
const marker = (route = 'a', version = '') => `<template data-recooler-marker data-recooler-route="${route}" data-recooler-version="${version}"></template>`;
function setup(onLoads: Record<string, () => unknown>, html = marker()) {
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

test('cleans all removed markers before new onLoad calls, once despite repeated lifecycle events', async () => {
  const log: string[] = [];
  const { document, init, event } = setup({ a: () => { log.push('a'); return () => log.push('cleanup a'); }, b: () => { log.push('b'); } });
  await init();
  document.body.innerHTML = marker('b');
  event('htmx:afterSwap'); event('htmx:afterSettle'); await init();
  expect(log).toEqual(['a', 'cleanup a', 'b']);
});

test('observes removals without init and ignores full unload events', async () => {
  let cleanups = 0;
  const { window, document, init } = setup({ a: () => () => { cleanups++; } });
  await init();
  for (const name of ['beforeunload', 'pagehide', 'unload']) window.dispatchEvent(new window.Event(name));
  expect(cleanups).toBe(0);
  document.body.innerHTML = '';
  await window.happyDOM.waitUntilComplete();
  expect(cleanups).toBe(1);
  await init(); expect(cleanups).toBe(1);
});

test('reentrant init during onLoad retains the live marker cleanup', async () => {
  let reenter = () => {}, loads = 0, cleanups = 0;
  const { document, init } = setup({ a: () => { loads++; reenter(); return () => { cleanups++; }; } });
  await init(); reenter = init;
  document.body.innerHTML = marker(); await init();
  expect(loads).toBe(2); expect(cleanups).toBe(1);
  document.body.innerHTML = ''; await init();
  expect(cleanups).toBe(2);
});

test('retires a marker when its route or version changes', async () => {
  const log: string[] = [];
  const { document, init } = setup({ a: () => { log.push('a'); return () => log.push('cleanup a'); }, b: () => { log.push('b'); return () => log.push('cleanup b'); } });
  await init();
  const node = document.querySelector('template')!;
  node.dataset.recoolerRoute = 'b'; await init();
  node.dataset.recoolerVersion = 'next'; await init(); await init();
  expect(log).toEqual(['a', 'cleanup a', 'b', 'cleanup b', 'b']);
});

test('readiness does not await onLoad and a late cleanup runs immediately after removal', async () => {
  let resolve!: (cleanup: () => void) => void, cleanups = 0;
  const result = new Promise<() => void>(done => { resolve = done; });
  const { document, init } = setup({ a: () => result });
  await init();
  document.body.innerHTML = ''; await init();
  resolve(() => { cleanups++; });
  await result; await Promise.resolve();
  expect(cleanups).toBe(1);
  await init(); expect(cleanups).toBe(1);
});

test('reports cleanup errors without blocking other cleanups or onLoad', async () => {
  const log: string[] = [], error = new Error('cleanup failed');
  const { document, init, errors } = setup({ a: () => () => { throw error; }, b: () => () => { log.push('cleanup b'); }, c: () => { log.push('c'); } }, marker() + marker('b'));
  await init(); document.body.innerHTML = marker('c'); await init();
  expect(errors).toEqual([error]); expect(log).toEqual(['cleanup b', 'c']);
});

test('history snapshots retain live markers, then restoration initializes each new marker once', async () => {
  const log: string[] = [];
  const { document, init, event } = setup({ a: () => { log.push('a'); return () => log.push('cleanup a'); } });
  await init(); event('htmx:beforeHistorySave'); await Promise.resolve(); await init();
  expect(log).toEqual(['a']);
  document.body.innerHTML = ''; await init();
  document.body.innerHTML = marker(); event('htmx:historyRestore'); event('htmx:afterSettle'); await init();
  expect(log).toEqual(['a', 'cleanup a', 'a']);
});

test('ignores non-function return values and reports onLoad rejection', async () => {
  const error = new Error('onLoad failed');
  const { document, init, errors } = setup({ a: () => 1, b: () => Promise.resolve('ignored'), c: () => Promise.reject(error) }, marker() + marker('b') + marker('c'));
  await init(); await Promise.resolve(); document.body.innerHTML = ''; await init();
  expect(errors).toEqual([error]);
});
