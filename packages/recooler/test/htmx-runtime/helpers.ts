import { expect } from 'vitest';
import { Hono, type Context } from 'hono';
import { createApp, type Manifest, type ModuleNs } from '../../src/router/index.js';
import { jsxPages } from '../../src/jsx/index.js';
import { htmx, type ActionTable, type HtmxOptions } from '../../src/htmx/index.js';
import { registerActions, type Action, type ActionMethods } from '../../src/htmx/runtime.js';
import { signActionUrl } from '../../src/htmx/testing.js';
import { manifest } from '../router/helpers.js';
export { manifest };
export const secret = 'test-only runtime key';
export const headers = { 'HX-Request': 'true', Origin: 'http://localhost', 'Sec-Fetch-Site': 'same-origin' };
export const Page = () => 'page';
export function app(input: Manifest, table: ActionTable | (() => ActionTable), options: Partial<HtmxOptions> = {}) {
  return createApp(input, { pages: jsxPages(), extensions: [htmx({ table, secret, ...options })] });
}
export function actionApp(action: Action, method = 'POST', module: ModuleNs = {}) {
  registerActions('test-result', { [method]: { 'test-result@0': action } });
  return app(manifest({ 'index.tsx': { default: Page, ...module } }), { 'routes/index.tsx': ['test-result'] });
}
export function url(pathname = '/', actionId = 'test-result@0', method = 'POST', scope: Record<string, unknown> = {}, routeId = 'routes/index.tsx') {
  return signActionUrl({ pathname, routeId, method, actionId, scope }, secret);
}
export function submit(a: Hono, path = url(), method = 'POST', extra: Record<string, string> = {}) {
  return a.request(path, { method, headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded', ...extra }, ...(method === 'GET' || method === 'HEAD' ? {} : { body: '' }) });
}
export function extract(html: string, attribute = 'hx-post', index = 0): string {
  const values = [...html.matchAll(new RegExp(`${attribute}="([^"]*)"`, 'g'))];
  expect(values[index], html).toBeDefined();
  return values[index]![1]!.replaceAll('&amp;', '&').replaceAll('&#39;', "'").replaceAll('&quot;', '"');
}
export async function render(a: Hono, path = '/', extra: Record<string, string> = {}) {
  const response = await a.request(path, { headers: extra });
  expect(response.status).toBe(200);
  return response.text();
}
export function register(moduleId: string, methods: ActionMethods) { registerActions(moduleId, methods); }
export function errors(a: Hono) {
  a.onError((first, second) => {
    const error = typeof second === 'function' ? (first as unknown as Context).error! : first;
    return new Response(error.message, { status: 500 });
  });
  return a;
}
