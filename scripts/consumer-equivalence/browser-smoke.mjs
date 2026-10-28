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
// Attach before navigation so parser, CSP and MIME failures cannot be missed.
export function observeBrowserFailures(page, origin, assetPrefix) {
  const result = { errors: [], consoleErrors: [], missing: [], failedActions: [], assets: [] };
  page.on('pageerror', error => result.errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') result.consoleErrors.push(message.text());
  });
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin !== new URL(origin).origin) return;
    const status = response.status();
    if (status === 404) result.missing.push(response.url());
    if (url.searchParams.has('action') && (status < 200 || status >= 300)) {
      result.failedActions.push({ url: response.url(), status });
    }
    if (assetPrefix && url.pathname.startsWith(assetPrefix)) result.assets.push({ url: response.url(), status });
  });
  return result;
}
export function assertBrowserSuccess(result, assetPrefix) {
  for (const key of ['errors', 'consoleErrors', 'missing', 'failedActions']) assert.deepEqual(result[key], [], key);
  if (assetPrefix) assert(result.assets.length && result.assets.every(asset => asset.status >= 200 && asset.status < 300));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [origin, profileFile, output] = process.argv.slice(2);
  if (!origin || !profileFile || !output || !resolve(output).startsWith('/private/tmp/')) throw new Error('Usage: browser-smoke.mjs ORIGIN PRIVATE_PROFILE.json /private/tmp/RESULT.json');
  const profile = JSON.parse(await readFile(profileFile,'utf8'));
  const { chromium } = createRequire(new URL('../../packages/recooler/package.json', import.meta.url))('playwright');
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    const result = observeBrowserFailures(page, origin, profile.assetPrefix);
    for (const resource of profile.resources || []) {
      const body = await readFile(resource.file);
      await page.route(resource.url, route => route.fulfill({body,contentType:resource.contentType,headers:{'access-control-allow-origin':'*'}}));
    }
    const completed = await runBrowserSteps(page,origin,profile.steps);
    await writeFile(output,JSON.stringify({completed,...result},null,2)+'\n');
    assertBrowserSuccess(result, profile.assetPrefix);
    console.log(JSON.stringify({completed:completed.length,...Object.fromEntries(Object.entries(result).map(([key, value]) => [key, value.length]))}));
  } finally { await browser.close(); }
}
