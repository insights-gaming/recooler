import { expect, it } from 'vitest';
import { transform } from '../../src/htmx/transform/index.js';

// Ten source lines per unit. Both actions, capture aliases, partial imports and
// transitive handler dependencies scale, exercising each former quadratic scan.
function source(lines: number): string {
  return Array.from({ length: lines / 10 }, (_, i) => [
    `import { dep${i}, unused${i} } from './dep${i}';`,
    `const helper${i} = (n) => dep${i}(n);`,
    `export function C${i}({ id, name }) {`,
    `  const local = id * 2;`,
    `  return <div>`,
    `    <form hx-post={(ctx) => <b hx-delete={() => name + local} />} />`,
    `    <button hx-on:click={(e) => helper${i}(local + e.detail)}>x</button>`,
    `  </div>;`,
    `}`, '',
  ].join('\n')).join('\n');
}
const median = (values: number[]) => values.sort((a, b) => a - b)[values.length >>> 1]!;

for (const mode of ['full', 'server', 'client-slice'] as const) it(`scales near-linearly from 1,000 to 8,000 lines: ${mode}`, () => {
  const small = source(1000), large = source(8000);
  expect(small.split('\n')).toHaveLength(1000);
  expect(large.split('\n')).toHaveLength(8000);
  const run = (code: string) => {
    const start = performance.now();
    const result = transform(code, { id: 'perf.tsx', relativePath: 'perf.tsx', mode });
    expect(result.diagnostics).toEqual([]);
    expect(result.actions).toHaveLength(code === small ? 200 : 1600);
    return performance.now() - start;
  };
  run(small); run(large); // warm both sizes before interleaved samples
  const smallTimes: number[] = [], largeTimes: number[] = [];
  for (let i = 0; i < 5; i++) {
    if (i % 2) { largeTimes.push(run(large)); smallTimes.push(run(small)); }
    else { smallTimes.push(run(small)); largeTimes.push(run(large)); }
  }
  const smallMs = median(smallTimes), largeMs = median(largeTimes), ratio = largeMs / smallMs;
  console.log(JSON.stringify({ mode, smallLines: 1000, largeLines: 8000, smallMs, largeMs, ratio }));
  // 8x input, allowance for GC/load and O(n log n) indexing; quadratic is 64x.
  expect(ratio).toBeLessThan(18);
}, 30_000);


function deepSource(n: number): string {
  const helpers = Array.from({ length: n }, (_, i) => `function c${i}() { return ${i ? `c${i - 1}()` : '0'}; }`);
  const handlers = Array.from({ length: n }, () => `<i hx-on:click={() => c${n - 1}()} />`);
  return `${helpers.join('\n')}\nexport default () => <div>${handlers.join('\n')}</div>;`;
}

it('scales with handlers × reachable declarations without an extra chain-depth factor', () => {
  const small = deepSource(250), large = deepSource(2000);
  const run = (code: string) => {
    const start = performance.now();
    const result = transform(code, { id: 'depth.tsx', relativePath: 'depth.tsx', mode: 'client-slice' });
    const elapsed = performance.now() - start;
    expect(result.diagnostics).toEqual([]);
    expect(result.handlers).toHaveLength(code === small ? 250 : 2000);
    expect(result.code).toContain('function c0()');
    expect(result.code).toContain(code === small ? 'function c249()' : 'function c1999()');
    return elapsed;
  };
  run(small); run(large);
  const smallTimes: number[] = [], largeTimes: number[] = [];
  for (let i = 0; i < 5; i++) {
    if (i % 2) { largeTimes.push(run(large)); smallTimes.push(run(small)); }
    else { smallTimes.push(run(small)); largeTimes.push(run(large)); }
  }
  const smallMs = median(smallTimes), largeMs = median(largeTimes), ratio = largeMs / smallMs;
  console.log(JSON.stringify({ mode: 'client-slice', shape: 'depth', smallDepth: 250, largeDepth: 2000, smallMs, largeMs, ratio }));
  // 8x handlers and depth permits 64x graph work, plus load/GC allowance.
  // Copying every path adds a third factor (512x).
  expect(ratio).toBeLessThan(100);
}, 30_000);
