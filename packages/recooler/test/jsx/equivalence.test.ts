import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createElement as h } from 'easy-jsx-html-engine';
import { createApp, type Manifest, type DirNode, type ModuleNs } from '../../src/router/index.js';
import { jsxPages } from '../../src/jsx/index.js';
import * as index from './fixtures/default-root/src/routes/index.js';
import * as outer from './fixtures/default-root/src/routes/layout.js';
import * as headOnly from './fixtures/default-root/src/routes/nested/layout.js';
import * as inner from './fixtures/default-root/src/routes/nested/[id]/layout.js';
import * as nested from './fixtures/default-root/src/routes/nested/[id]/index.js';
import * as replace from './fixtures/default-root/src/routes/replace/index.js';
import * as root from './fixtures/custom-root/src/root.js';
import * as customIndex from './fixtures/custom-root/src/routes/index.js';
import * as constHead from './fixtures/exports/const.js';
import * as functionHead from './fixtures/exports/function.js';
import * as aliasHead from './fixtures/exports/alias.js';
import * as reexportHead from './fixtures/exports/reexport.js';
import * as starHead from './fixtures/exports/star.js';

function dir(segment: string, path: string, module?: ModuleNs, layout?: ModuleNs, children: DirNode[] = []): DirNode {
  return { segment, path, group: false, middleware: [], children, layout,
    route: module && { file: `routes/${segment}/index.tsx`, module } };
}
const manifest: Manifest = { version: 1, tree: dir('', '/', index, outer, [
  dir('nested', '/nested', undefined, headOnly, [dir('[id]', '/nested/:id', nested, inner)]),
  dir('replace', '/replace', replace),
]) };

for (const [i, path] of ['/', '/nested/42?x=1', '/replace'].entries()) {
  it(`matches published Farm 0.0.27 bytes for ${path}, apart from route metadata`, async () => {
    const expected = await readFile(new URL(`./fixtures/default-root/expected-${i}.html`, import.meta.url), 'utf8');
    const res = await createApp(manifest, { pages: jsxPages() }).request(path);
    expect(res.status).toBe(200);
    const actual = await res.text();
    const routePattern = i === 1 ? '/nested/:id' : path;
    expect(actual).toBe(expected.replace('<body>', `<body data-recooler-route="${routePattern}"><meta name="recooler-route" content="${routePattern}"/>`));
  });
}

it('matches a custom root, removing only the legacy inline client script and adding route metadata', async () => {
  const expected = await readFile(new URL('./fixtures/custom-root/expected-0.html', import.meta.url), 'utf8');
  expect(expected).toContain('<script>(()=>{document.title="loaded";})()</script>');
  const app = createApp({ version: 1, root, tree: dir('', '/', customIndex) }, { pages: jsxPages() });
  const actual = await (await app.request('/')).text();
  expect(actual).toBe(expected.replace('<script>(()=>{document.title="loaded";})()</script>', '')
    .replace('<div id="app">', '<div id="app"><meta name="recooler-route" content="/"/>'));
});

for (const [name, module, expected] of [
  ['const', constHead, 'const'], ['function', functionHead, 'root/function'],
  ['alias', aliasHead, 'alias'], ['reexport', reexportHead, 'const'], ['star', starHead, 'root/function'],
] as const) {
  it(`reads the head namespace for ${name} exports`, async () => {
    const app = createApp({ version: 1, root: { head: { title: 'root' } }, tree: dir('', '/', { ...module, default: () => h('p', {}, 'page') }) }, { pages: jsxPages() });
    expect(await (await app.request('/')).text()).toContain(`<title>${expected}</title>`);
  });
}
