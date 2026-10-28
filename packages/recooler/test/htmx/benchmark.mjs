// pnpm --filter recooler build
// pnpm --filter recooler exec node test/htmx/benchmark.mjs
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { arch, cpus, platform } from 'node:os';
import { parseSync, rawTransferSupported, visitorKeys } from 'oxc-parser';
import { analyze } from '@typescript-eslint/scope-manager';
import { parseAndAnalyze } from '../../dist/htmx/transform/analysis.js';
import { transform } from '../../dist/htmx/transform/index.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/reference.json', import.meta.url), 'utf8'));
const samples = [
  ['playground home', readFileSync(new URL('../../../../playground/src/routes/index.tsx', import.meta.url), 'utf8')],
  ['playground article', readFileSync(new URL('../../../../playground/src/routes/posts/[id]/index.tsx', import.meta.url), 'utf8')],
  ['manage multipliers', fixtures.find(f => f.name === 'slices_handler_helpers_and_drops_server_code').inputs[0]],
];
const parseOptions = { range: true, sourceType: 'module', astType: 'ts', experimentalRawTransfer: rawTransferSupported() };
const scopeOptions = { sourceType: 'module', lib: [], jsxPragma: null, childVisitorKeys: visitorKeys };
function measure(fn) {
  for (let i = 0; i < 2000; i++) fn();
  const runs = [];
  for (let batch = 0; batch < 7; batch++) {
    const start = performance.now();
    for (let i = 0; i < 500; i++) fn();
    runs.push((performance.now() - start) * 1000 / 500);
  }
  return Number(runs.sort((a, b) => a - b)[3].toFixed(1));
}
const results = samples.map(([name, code]) => {
  const parse = () => parseSync('sample.tsx', code, parseOptions).program;
  const ast = parse();
  return {
    name, lines: code.split('\n').length, bytes: Buffer.byteLength(code),
    parseUs: measure(parse),
    analyzeUs: measure(() => analyze(ast, scopeOptions)),
    parseAndAnalyzeUs: measure(() => analyze(parse(), scopeOptions)),
    indexedFrontendUs: measure(() => parseAndAnalyze(code, 'sample.tsx')),
    fullWithMapUs: measure(() => transform(code, { id: 'sample.tsx', relativePath: 'sample.tsx' })),
  };
});
console.log(JSON.stringify({ node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model,
  rawTransfer: rawTransferSupported(), iterations: '2000 warmups; median of 7 x 500 operations; microseconds/module', results }, null, 2));
