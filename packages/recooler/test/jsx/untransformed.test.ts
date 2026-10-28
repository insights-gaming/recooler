import { expect, it } from 'vitest';
import { createElement, jsx, jsxDEV } from '../../src/jsx/jsx-runtime.js';

it.each(['hx-get', 'hx-post', 'hx-put', 'hx-patch', 'hx-delete', 'data-hx-post', 'hx-on:click', 'hx-on--before-request', 'data-hx-on:click'])('rejects untransformed functions in %s before HTML can expose source', async attribute => {
  const props = { [attribute]: () => 'PRIVATE_SERVER_SOURCE' };
  for (const render of [createElement, jsx, jsxDEV]) {
    expect(() => render('form', props)).toThrow(`function-valued ${attribute}`);
    expect(() => render('form', props)).toThrow('module was not transformed');
  }
  expect(() => jsx(() => createElement('p', {}, 'component'), props)).not.toThrow();
  expect((await jsx('form', { [attribute]: '/signed-or-client-string' })).toHTML()).toContain('/signed-or-client-string');
});
