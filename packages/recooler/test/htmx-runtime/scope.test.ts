import { expect, it } from 'vitest';
import { Hono, type Context } from 'hono';
import { createElement as h } from '../../src/jsx/index.js';
import { actionScope, actionUrl, handlerScope, wrapAction, wrapActionWithPayload } from '../../src/htmx/runtime.js';
import { actionSignature, actionPath } from '../../src/htmx/signing.js';
import { app, errors, extract, headers, manifest, register, render, secret, submit, url } from './helpers.js';

it('serializes plain data, null prototypes, shared references and legacy undefined values', () => {
  const shared = { a: 'é' };
  const scope = { s: '<script>', n: 1.5, b: false, nil: null, omitted: undefined,
    a: [undefined, null, shared], first: shared, second: shared, plain: Object.assign(Object.create(null), { x: 1 }) };
  expect(handlerScope(scope)).toBe(JSON.stringify(scope));
});

it.each([
  [() => {}, 'function'], [new Date(), 'Date'], [new Map(), 'Map'], [new Set(), 'Set'],
  [Symbol('x'), 'symbol'], [1n, 'bigint'], [NaN, 'NaN'], [Infinity, 'Infinity'], [-Infinity, '-Infinity'],
  [new (class Custom {})(), 'Custom'],
])('rejects unserializable capture %s', (value, kind) => {
  expect(() => handlerScope({ deep: [{ value }] })).toThrow(`cannot capture \`deep[0].value\` (${kind})`);
});

it('rejects cycles with their property path while allowing repeated non-circular references', () => {
  const cycle: any = { a: {} }; cycle.a.parent = cycle;
  expect(() => handlerScope({ cycle })).toThrow('cannot capture `cycle.a.parent`: circular reference');
});

it('does not capture Hono Context values', async () => {
  const a = new Hono();
  a.get('/', c => { expect(() => handlerScope({ ctx: c })).toThrow('only json compatible'); return c.text('ok'); });
  expect((await a.request('/')).status).toBe(200);
});

it('wrapAction supplies an empty GET payload and reconstructs captured factories', async () => {
  register('wrappers-get', { get: {
    plain: wrapAction((c, payload) => { expect(payload).toEqual({}); return c.text('plain'); }),
    captured: wrapAction(scope => (_c: Context, payload: {}) => { expect(payload).toEqual({}); return scope.value; }, 'captured'),
  } });
  const a = app(manifest({ 'index.tsx': { default: () => '' } }), { 'routes/index.tsx': ['wrappers-get'] });
  expect(await (await submit(a, url('/', 'plain', 'GET'), 'GET')).text()).toBe('plain');
  expect(await (await submit(a, url('/', 'captured', 'GET', { value: 42 }), 'GET')).text()).toBe('42');
});

it('wrapActionWithPayload preserves form fields, files, duplicate values and __formData', async () => {
  register('payload', { post: { a: wrapActionWithPayload(scope => (c: Context, payload: any) => {
    expect(scope).toEqual({ count: 2 });
    expect(payload.name).toBe('last');
    expect(payload.__formData).toBeInstanceOf(FormData);
    expect(payload.__formData.getAll('name')).toEqual(['first', 'last']);
    expect(payload.file.name).toBe('sample.txt');
    return c.text('payload');
  }, 'a') } });
  const a = app(manifest({ 'index.tsx': { default: () => '' } }), { 'routes/index.tsx': ['payload'] });
  const data = new FormData(); data.append('name', 'first'); data.append('name', 'last');
  data.append('__formData', 'cannot overwrite'); data.append('file', new File(['sample'], 'sample.txt'));
  expect(await (await a.request(url('/', 'a', 'POST', { count: 2 }), { method: 'POST', headers, body: data })).text()).toBe('payload');
});

it('returns legacy 400s for missing or malformed scoped payloads after dispatch verification', async () => {
  let factories = 0;
  const wrapped = wrapAction(scope => () => { factories++; return scope; }, 'a');
  const direct = new Hono();
  direct.get('/', c => wrapped(c) as Response);
  expect(await (await direct.request('/')).text()).toBe('missing action scope');
  register('malformed', { get: { a: wrapped } });
  const a = app(manifest({ 'index.tsx': { default: () => '' } }), { 'routes/index.tsx': ['malformed'] });
  for (const json of ['{', 'null', '[]', '42', '"string"']) {
    const sig = actionSignature({ routeId: 'routes/index.tsx', pathname: '/', method: 'GET', actionId: 'a' }, json, secret);
    const response = await submit(a, `/?action=a&scope=${encodeURIComponent(json)}&sig=${sig}`, 'GET');
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('malformed action scope');
  }
  expect((await submit(a, '/?action=a&scope=invalid&sig=invalid', 'GET')).status).toBe(404);
  expect(factories).toBe(0);
});

it('propagates application and serialization errors to Hono error handling', async () => {
  register('errors', { get: { a: () => { throw new Error('application error'); } } });
  const a = errors(app(manifest({ 'index.tsx': { default: () => h('button', { 'hx-get': actionUrl('a', { bad: new Date() }) }) } }), { 'routes/index.tsx': ['errors'] }));
  expect(await (await submit(a, url('/', 'a', 'GET'), 'GET')).text()).toBe('application error');
  expect((await a.request('/')).status).toBe(500);
});

it('keeps actionScope as a D6-signed fragment of the ambient action URL', async () => {
  register('fragment', { get: { a: () => 'action' } });
  const a = app(manifest({ 'index.tsx': { default: () => {
    const complete = actionUrl('a', { n: 1 });
    expect(actionScope('a', { n: 1 })).toBe(complete.slice(complete.indexOf('&scope=')));
    return h('button', { 'hx-get': complete });
  } } }), { 'routes/index.tsx': ['fragment'] });
  expect(await (await submit(a, extract(await render(a), 'hx-get'), 'GET')).text()).toBe('action');
});

it('fails clearly without a binding or when a rendered action is absent from the table', async () => {
  expect(() => actionUrl('missing', {})).toThrow('Context is not available');
  const plain = new Hono();
  plain.get('/', c => { expect(() => actionUrl('missing', {}, c)).toThrow('No htmx route binding'); return c.text('ok'); });
  await plain.request('/');
  const a = errors(app(manifest({ 'index.tsx': { default: () => actionUrl('missing', {}) } }), {}));
  expect(await (await a.request('/')).text()).toContain('not reachable');
});

it('prevents slash/backslash network references without rewriting encoded path segments', () => {
  for (const pathname of ['//evil/x', '/\\evil/x']) {
    const path = actionPath(pathname);
    expect(path.startsWith('//')).toBe(false); expect(path.startsWith('/\\')).toBe(false);
    expect(new URL(path, 'http://localhost').origin).toBe('http://localhost');
  }
  expect(actionPath('/%2F/%40')).toBe('/%2F/%40');
});
