import { parentPort, workerData } from 'node:worker_threads';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { dispatchWorker } from './runtime.mjs';
register('../../fixtures/consumer-shape/node-loader.mjs', import.meta.url);
const { packageOut, spec, mode } = workerData;
const { default: worker } = await import(pathToFileURL(join(packageOut, mode, 'main.js')));
const entries = globalThis.__recoolerEquivalence;
const env = { ...spec.bindings, SERVICE: { fetch: () => new Response('stub-service', { headers: { 'x-service': 'stub' } }) } };
const ctx = { waitUntil: task => { Promise.resolve(task).catch(() => {}); }, passThroughOnException() {} };
parentPort.on('message', async ({ id, method, input }) => {
  try {
    let value;
    if (method === 'entries') value = entries;
    else if (method === 'dispatch') value = await dispatchWorker(worker, input, env, ctx);
    else if (method === 'batch') {
      value = [];
      for (const request of input) value.push(await dispatchWorker(worker, request, env, ctx));
    } else throw new Error('Unknown fixture operation');
    parentPort.postMessage({ id, value });
  } catch (error) { parentPort.postMessage({ id, error: error.stack || String(error) }); }
});
