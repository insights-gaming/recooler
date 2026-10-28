import { expect, it } from 'vitest';
import { createElement as h } from '../../src/jsx/index.js';
import { html } from 'hono/html';
import { actionApp, submit } from './helpers.js';
import type { Action } from '../../src/htmx/runtime.js';

it.each<[string, Action, string]>([
  ['escaped string', () => 'a <b> & c', 'a &lt;b&gt; &amp; c'],
  ['number', () => 42, '42'],
  ['array', () => ['a', h('b', {}, 'b'), 3, [null, 'd']], 'a<b>b</b>3d'],
  ['JSX', () => h('i', {}, 'jsx'), '<i>jsx</i>'],
  ['sync toHTML', () => ({ toHTML: () => '<i>sync</i>' }), '<i>sync</i>'],
  ['async toHTML', () => ({ toHTML: async () => '<i>async</i>' }), '<i>async</i>'],
  ['Promise', async () => 'async', 'async'],
  ['nested promises', () => [Promise.resolve(h('i', {}, Promise.resolve('p'))), '!'], '<i>p</i>!'],
  ['false', () => false, ''], ['empty string', () => '', ''],
  ['Hono HTML', () => html`<b>${'<safe>'}</b>`, '<b>&lt;safe&gt;</b>'],
])('renders %s as children', async (_name, action, expected) => {
  const response = await submit(actionApp(action));
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/^text\/html/);
  expect(await response.text()).toBe(expected);
});
it.each([() => {}, () => null, async () => undefined])('returns 204 for nullish results', async action => {
  const response = await submit(actionApp(action));
  expect(response.status).toBe(204);
  expect(await response.text()).toBe('');
});
it('passes returned and thrown Responses through, including render-time Responses', async () => {
  const response = await submit(actionApp(c => c.text('plain', 201)));
  expect(response.status).toBe(201); expect(await response.text()).toBe('plain');
  const Redirect = async () => { throw new Response(null, { status: 302, headers: { location: '/elsewhere' } }); };
  for (const action of [() => h(Redirect, {}), () => ['before', h('div', {}, h(Redirect, {}))], () => { throw new Response(null, { status: 302, headers: { location: '/elsewhere' } }); }]) {
    const result = await submit(actionApp(action));
    expect(result.status).toBe(302); expect(result.headers.get('location')).toBe('/elsewhere');
  }
});
