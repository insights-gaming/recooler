import { register } from 'node:module';
register('./node-loader.mjs', import.meta.url);
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const apps = process.argv[2] ? [process.argv[2]] : ['router', 'admin'];
for (const name of apps) {
  if (!['router', 'admin'].includes(name)) throw new Error(`Unknown fixture ${name}`);
  const spec = JSON.parse(await readFile(join(root, name, 'requests.json'), 'utf8'));
  const { default: worker } = await import(pathToFileURL(join(root, name, 'dist/main.js')));
  const responses = new Map();
  const pending = [];
  const bindings = { SERVICE: { fetch: () => new Response('stub-service', { headers: { 'x-service': 'stub' } }) } };
  const observations = [];
  for (const entry of spec.requests) {
    let path = entry.path;
    if (entry.actionFrom) {
      const { request, element, attribute = 'hx-post' } = entry.actionFrom;
      const html = responses.get(request).body;
      const tag = [...html.matchAll(/<[^>]+>/g)].map(match => match[0]).find(tag => tag.includes(`id="${element}"`));
      assert.ok(tag, `${entry.name}: action element ${element} exists`);
      path = tag.match(new RegExp(`${attribute}="([^"]+)"`))?.[1]?.replaceAll('&amp;', '&');
      assert.ok(path, `${entry.name}: ${attribute} is an action URL`);
      path = new URL(path, new URL(responses.get(request).url)).href;
    }
    const url = new URL(path, 'http://fixture');
    const response = await worker.fetch(new Request(url, {
      method: entry.method || 'GET', headers: entry.headers, body: entry.body,
    }), bindings, { waitUntil: task => pending.push(task), passThroughOnException() {} });
    if (entry.expect.nonResponse) {
      assert.ok(!(response instanceof Response), `${entry.name}: non-Response return`);
      assert.equal(Object.prototype.toString.call(response), entry.expect.returnedType);
      console.log(`${name}: ${entry.name}: non-Response return`);
      continue;
    }
    const body = await response.text();
    const actual = { name: entry.name, url: url.href, status: response.status, headers: Object.fromEntries(response.headers), body };
    responses.set(entry.name, actual);
    observations.push(actual);
    assert.equal(response.status, entry.expect.status, `${entry.name}: status`);
    for (const [key, value] of Object.entries(entry.expect.headers || {})) assert.equal(response.headers.get(key), value, `${entry.name}: ${key}`);
    for (const value of entry.expect.bodyIncludes || []) assert.ok(body.includes(value), `${entry.name}: includes ${JSON.stringify(value)}`);
    for (const value of entry.expect.bodyExcludes || []) assert.ok(!body.includes(value), `${entry.name}: excludes ${JSON.stringify(value)}`);
    if (entry.expect.body !== undefined) assert.equal(body, entry.expect.body, `${entry.name}: body`);
    console.log(`${name}: ${entry.name}: ${response.status}`);
  }
  await Promise.all(pending);
  if (process.env.RECOOLER_OBSERVATIONS) await writeFile(join(process.env.RECOOLER_OBSERVATIONS, `${name}.json`), JSON.stringify(observations, null, 2) + '\n');
  console.log(`${name}: ${spec.requests.length} oracle requests passed`);
}
