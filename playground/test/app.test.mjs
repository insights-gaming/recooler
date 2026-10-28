import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import app from '../dist/server/app.mjs';
import { evaluateClientPage } from '../../test/vite/client-dom.mjs';
const env = { RECOOLER_SECRET: 'playground-built-test-only' };
const request = (url, init) => app.fetch(new Request(new URL(url, 'http://test'), init), env);

test('TS playground renders routes, signed actions, lazy handlers and onLoad', async () => {
  const response = await request('/'); assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>Playground - Recooler<\/title>/);
  assert.match(html, /data-recooler-route="\/"/);
  const url = html.match(/hx-post="([^"]+)"/)[1].replaceAll('&amp;', '&');
  const action = await request(url, { method: 'POST', headers: { 'HX-Request': 'true', 'Sec-Fetch-Site': 'same-origin' }, body: new URLSearchParams({ name: 'Ada' }) });
  assert.equal(await action.text(), '<p id="greeting">hello Ada</p>');
  assert.match(await (await request('/posts/42')).text(), /posts-id 42/);
  assert(!(await (await request('/posts/new')).text()).includes('recooler-client.js'));
  const clientOut = path.resolve('dist/client');
  const window = await evaluateClientPage(clientOut, html);
  assert.equal(window.document.body.dataset.loaded, 'yes');
  const button = window.document.querySelector('#counter');
  vm.runInContext('(function(event){' + button.getAttribute('hx-on:click') + '})', vm.createContext(window)).call(button, new window.Event('click'));
  assert.equal(button.textContent, 'clicked 1');
  await window.happyDOM.close();
  const admin = await evaluateClientPage(clientOut, await (await request('/admin')).text());
  const grouped = admin.document.querySelector('#admin-handler');
  vm.runInContext('(function(event){' + grouped.getAttribute('hx-on:click') + '})', vm.createContext(admin)).call(grouped, new admin.Event('click'));
  assert.equal(grouped.textContent, 'admin clicked');
  await admin.happyDOM.close();
});

test('every emitted client chunk excludes the database and server runtime', async () => {
  const directory = path.resolve('dist/client/assets');
  const chunks = (await readdir(directory)).filter(file => file.endsWith('.js') || file.endsWith('.map'));
  assert(chunks.length >= 2);
  const code = (await Promise.all(chunks.map(file => readFile(path.join(directory, file), 'utf8')))).join('\n');
  assert(code.includes('clicked'));
  for (const marker of ['server-only-db-module', 'registerActions', 'wrapAction', 'node:async_hooks']) assert(!code.includes(marker), marker);
});
