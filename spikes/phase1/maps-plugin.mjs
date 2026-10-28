import MagicString from 'magic-string';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import assert from 'node:assert/strict';

export const mapSource = `export function moved() {
  const action = () => {
    throw new Error('MOVED_FRAME');
  };
  return action();
}
export function untouched() {
  throw new Error('UNTOUCHED_FRAME');
}
`;
export function mapsPlugin(includeContent = true) {
  return {
    name: 'spike-moved-maps', enforce: 'pre',
    resolveId(id) { if (id === 'virtual:mapless') return '\0virtual:mapless'; },
    load(id) { if (id === '\0virtual:mapless') return { code: "export function virtualCrash() { throw new Error('VIRTUAL_FRAME'); }", map: null }; },
    transform(code, id) {
      if (!id.endsWith('/src/map-source.ts')) return;
      const start = code.indexOf('() =>');
      const end = code.indexOf('\n  };') + '\n  }'.length;
      const s = new MagicString(code);
      s.move(start, end, code.length);
      s.prependRight(start, '\nexport const hoisted = ');
      s.appendLeft(end, ';\n');
      s.appendLeft(start, 'hoisted');
      return { code: s.toString(), map: s.generateMap({ source: id, hires: true, includeContent }) };
    }
  };
}
export function position(code, offset) {
  const prefix = code.slice(0, offset).split('\n');
  return { line: prefix.length, column: prefix.at(-1).length };
}
export function verifyMap(code, map, sourceUrl, markers = ['MOVED_FRAME', 'UNTOUCHED_FRAME']) {
  const trace = new TraceMap(map, sourceUrl);
  const records = [];
  for (const marker of markers) {
    const at = code.indexOf(marker);
    if (at < 0) continue;
    for (const shift of [0, 3, marker.length - 1]) {
      const generated = position(code, at + shift);
      const original = originalPositionFor(trace, generated);
      const expected = position(mapSource, mapSource.indexOf(marker) + shift);
      assert(original.source?.endsWith('/src/map-source.ts'), JSON.stringify(original));
      assert.equal(original.line, expected.line);
      // Rolldown's final JS printer maps string literals at token granularity.
      assert.equal(original.column, expected.column - shift - 1); 
      records.push({ marker, generated, original, expected, granularity: "string-token" });
    }
  }
  assert(records.length >= 3, 'no map markers found');
  return { positions: records, hasSourcesContent: !!map.sourcesContent?.some(Boolean), sources: map.sources };
}
