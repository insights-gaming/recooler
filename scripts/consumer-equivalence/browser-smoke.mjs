// Generic Chromium smoke runner. Profiles and artifacts belong in private tmp.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function runBrowserSteps(page, origin, steps) {
  const completed = [];
  for (const step of steps) {
    switch (step.action) {
      case 'goto': await page.goto(new URL(step.path, origin).href, {waitUntil:'networkidle'}); break;
      case 'click':
        if (typeof step.acceptDialog === 'boolean') page.once('dialog', dialog => step.acceptDialog ? dialog.accept() : dialog.dismiss());
        await page.locator(step.selector).click(); break;
      case 'wait': await page.waitForFunction(step.expression); break;
      case 'assert': assert.deepEqual(await page.evaluate(step.expression), step.value, step.name); break;
      case 'back': await page.goBack(); break;
      default: throw new Error(`Unsupported smoke action: ${step.action}`);
    }
    completed.push(step.name || step.action);
  }
  return completed;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [origin, profileFile, output] = process.argv.slice(2);
  if (!origin || !profileFile || !output || !resolve(output).startsWith('/private/tmp/')) throw new Error('Usage: browser-smoke.mjs ORIGIN PRIVATE_PROFILE.json /private/tmp/RESULT.json');
  const profile = JSON.parse(await readFile(profileFile,'utf8'));
  const { chromium } = createRequire(new URL('../../packages/recooler/package.json', import.meta.url))('playwright');
  const browser = await chromium.launch({headless:true});
  const errors=[], missing=[], assets=[];
  try {
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      if (new URL(response.url()).origin !== new URL(origin).origin) return;
      if (response.status() === 404) missing.push(response.url());
      if (profile.assetPrefix && new URL(response.url()).pathname.startsWith(profile.assetPrefix)) assets.push({url:response.url(),status:response.status()});
    });
    for (const resource of profile.resources || []) {
      const body = await readFile(resource.file);
      await page.route(resource.url, route => route.fulfill({body,contentType:resource.contentType,headers:{'access-control-allow-origin':'*'}}));
    }
    const completed = await runBrowserSteps(page,origin,profile.steps);
    await writeFile(output,JSON.stringify({completed,errors,missing,assets},null,2)+'\n');
    assert.deepEqual(errors,[]); assert.deepEqual(missing,[]);
    if (profile.assetPrefix) assert(assets.length && assets.every(asset => asset.status === 200));
    console.log(JSON.stringify({completed:completed.length,assets:assets.length,errors:errors.length,missing:missing.length}));
  } finally { await browser.close(); }
}
