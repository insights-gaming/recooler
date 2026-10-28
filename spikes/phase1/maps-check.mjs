import assert from 'node:assert/strict';
import { build } from 'vite';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { fixture, config, write } from './fixture.mjs';
import { mapsPlugin, mapSource, verifyMap, position } from './maps-plugin.mjs';
export function traceFrame(stack, map, mapUrl, expectedLine = 3) {
  const frame = stack.split('\n')[1];
  const match = frame.match(/:(\d+):(\d+)\)?$/);
  assert(match, frame);
  const generated = { line: +match[1], column: +match[2] - 1 };
  const original = originalPositionFor(new TraceMap(map, mapUrl), generated);
  assert(original.source?.endsWith('/src/map-source.ts'), JSON.stringify(original));
  assert.equal(original.line, expectedLine);
  return { frame, generated, original };
}
if (process.argv[1]?.endsWith('/maps-check.mjs')) {
  const results = [];
  for (const includeContent of [true, false]) {
    const { root } = fixture('maps-' + includeContent);
    write(root, 'src/map-source.ts', mapSource);
    write(root, 'src/entry.ts', `import { moved, untouched } from './map-source'; import { virtualCrash } from 'virtual:mapless'; globalThis.__maps = { moved, untouched, virtualCrash }; export default globalThis.__maps;`);
    const transformed = mapsPlugin(includeContent).transform(mapSource, root + '/src/map-source.ts');
    const trace = new TraceMap(transformed.map);
    for (const marker of ['MOVED_FRAME', 'UNTOUCHED_FRAME']) {
      const at = transformed.code.indexOf(marker);
      for (let i = 0; i < marker.length; i++) {
        const actual = originalPositionFor(trace, position(transformed.code, at+i));
        const expected = position(mapSource, mapSource.indexOf(marker)+i);
        assert.equal(actual.line, expected.line); assert.equal(actual.column, expected.column);
      }
    }
    for (const consumer of ['server', 'client']) {
      const built = await build(config(root, [mapsPlugin(includeContent)], {
        build: { ...(consumer === 'server' ? { ssr: root + '/src/entry.ts' } : {}), minify: false, sourcemap: true, outDir: 'dist/' + consumer,
          rolldownOptions: { input: root + '/src/entry.ts', output: { entryFileNames: 'entry.mjs' } } }
      }));
      const chunk = built.output.find(o => o.type === 'chunk' && o.isEntry);
      const map = JSON.parse(chunk.map.toString());
      const mapping = verifyMap(chunk.code, map);
      await import(pathToFileURL(root + '/dist/' + consumer + '/entry.mjs'));
      let stack;
      try { globalThis.__maps.moved(); } catch (e) { stack = e.stack; }
      const frame = traceFrame(stack, map, root + '/dist/' + consumer + '/entry.mjs');
      let untouchedStack;
      try { globalThis.__maps.untouched(); } catch (e) { untouchedStack = e.stack; }
      const untouchedFrame = traceFrame(untouchedStack, map, root + '/dist/' + consumer + '/entry.mjs', 8);
      let virtualStack;
      try { globalThis.__maps.virtualCrash(); } catch (e) { virtualStack = e.stack; }
      const vm = virtualStack.split('\n')[1].match(/:(\d+):(\d+)\)?$/);
      const virtualPosition = originalPositionFor(new TraceMap(map), { line: +vm[1], column: +vm[2]-1 });
      assert(!virtualPosition.source?.endsWith('map-source.ts'));
      results.push({ includeContent, consumer, directHiresPositions: 26, mapping, stack, frame, untouchedStack, untouchedFrame, virtualStack, virtualPosition });
    }
  }
  writeFileSync(new URL('results/maps.json', import.meta.url), JSON.stringify(results, null, 2)+'\n');
  console.log('Source maps PASS: moves, edits, exact transform positions, final server/client stack frames, map:null virtual module, sourcesContent variants');
}
