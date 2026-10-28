import { expect, it } from 'vitest';
import { parseSync } from 'oxc-parser';
import { transform } from '../../src/htmx/transform/index.js';
const options = { id: 'test.tsx', relativePath: 'test.tsx' };
const modes = ['full', 'server', 'client-slice'] as const;

const indirect = `import { db } from './db.server';
function Row(props) { return <form hx-post={async () => { await db.save(props.id); }}>row</form>; }
export default function Page() {
  return <button hx-on:click={function () { morph(this, <Row id={1}/>); }}>x</button>;
}`;

it('treats hoisted actions as server roots inside a handler-only component', () => {
  const result = transform(indirect, { ...options, mode: 'server' });
  expect(result.diagnostics).toEqual([]);
  expect(result.code).toContain("import { db } from './db.server'");
  expect(result.code).toContain('await db.save(');
  expect(result.code).toContain('export const _action$post$0');
  expect(result.code).not.toContain('function Row');
  expect(result.code).not.toContain('actionUrl'); // the Row render site is gone
  expect(parseSync(options.id, result.code).errors).toEqual([]);
});

it('rejects actions reached from a handler dependency with both IDs and the chain', () => {
  const result = transform(indirect, { ...options, mode: 'client-slice' });
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({ code: 'action-in-client-slice', severity: 'error' });
  expect(result.diagnostics[0]!.message).toContain('event handler test.tsx@0 reaches form action test.tsx@0 (_action$post$0) via _handler$0 → Row');
  expect(result.code).toBe(indirect); // errors must be rejected, never emitted as slices
});

it('rejects onLoad dependencies that need a server-signed action URL', () => {
  const source = `const render = () => <i hx-get={() => 123} />; export const onLoad = () => render();`;
  expect(transform(source, { ...options, moduleKind: 'route', mode: 'client-slice' }).diagnostics[0]?.message)
    .toContain('onLoad of test.tsx reaches form action test.tsx@0');
});

it('emits no action bodies or server runtime helpers into valid slices', () => {
  const result = transform(`import { db } from './db.server'; export default function Page() {
    return <i hx-post={() => db.save('secret body')} hx-on:click={() => console.log('client')} />;
  }`, { ...options, mode: 'client-slice' });
  expect(result.diagnostics).toEqual([]);
  for (const token of ['secret body', 'db.server', 'actionUrl', 'wrapAction', 'registerActions', 'recooler/htmx/runtime']) expect(result.code).not.toContain(token);
  expect(parseSync(options.id, result.code).errors).toEqual([]);
});

it('keeps imports without value references, including JSX pragmas and metadata types', () => {
  for (const source of [
    `import { setup } from './side-effects'; export const x = 1;`,
    `/** @jsx h */ import { h } from 'preact'; export default () => <i hx-on:click={() => 1} />;`,
    `import { Model } from './model'; @decorate class C { constructor(value: Model) {} } export default () => <i hx-on:click={() => 1} />;`,
  ]) {
    const result = transform(source, { ...options, mode: 'server' });
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain(source.match(/import .*?;/)![0]);
    expect(parseSync(options.id, result.code).errors).toEqual([]);
  }
});

it('leaves unrelated computed function keys alone and accepts static template keys', () => {
  const source = "export const table = { [k]: () => 1, [Symbol.iterator]: function* () {} }; const C = () => <i {...{ [`hx-get`]: () => 2 }} />;";
  const result = transform(source, options);
  expect(result.diagnostics).toEqual([]);
  expect(result.actions).toHaveLength(1);
  expect(result.code).toContain('[Symbol.iterator]: function* () {}');
  for (const source of [
    `<i {...{ [k]: () => 1 }} />`, `<i attrs={{ [k]: () => 1 }} />`,
    `const props = { 'hx-post': () => 1, [k]: () => 2 };`,
  ]) expect(transform(source, options).diagnostics.map(d => d.code)).toEqual(['computed-handler-key']);
});

it('ignores type queries for captures, reachability and banned-import checks', () => {
  for (const mode of modes) {
    const result = transform(`import { db } from './db.server';
      export default function Page() {
        const cfg = { x: 1 }; const localFn = () => 1;
        return <i hx-post={(x: typeof cfg) => x} hx-on:click={(e: Parameters<typeof db.query>[0]) => {
          const x: typeof localFn = () => 1; return e;
        }} />;
      }`, { ...options, mode, clientBannedImports: ['server'] });
    expect(result.diagnostics).toEqual([]);
    expect(result.actions[0]?.captures).toEqual([]);
    expect(result.handlers[0]?.captures).toEqual([]);
    if (mode === 'client-slice') expect(result.code).not.toContain("from './db.server'");
    else expect(result.code).toContain("import { db } from './db.server'");
    expect(parseSync(options.id, result.code).errors).toEqual([]);
  }
});

it('retains effectful initializers and classes while pruning safe declarations', () => {
  const source = `import { track } from './track';
    const sub = track.subscribe(), literal = 1, fn = () => track.read();
    const Expr = class { method() { return track.read(); } };
    class Plain { method() { return track.read(); } }
    class Static { static { track.run(); } }
    @decorate class Decorated {}
    const WithStaticField = class { static value = track.run(); };
    const { value = track.run() } = 1;
    export default () => <i hx-on:click={() => [sub, literal, fn(), Expr, Plain, Static, Decorated, WithStaticField, value]} />;`;
  const result = transform(source, { ...options, mode: 'server' });
  expect(result.diagnostics).toEqual([]);
  for (const token of ['track.subscribe()', 'static { track.run(); }', '@decorate class Decorated', 'static value = track.run()', 'value = track.run()']) expect(result.code).toContain(token);
  for (const token of ['literal = 1', 'fn = ()', 'const Expr', 'class Plain']) expect(result.code).not.toContain(token);
  expect(parseSync(options.id, result.code).errors).toEqual([]);
});

it('diagnoses lexical this and arguments in arrow actions, respecting function boundaries', () => {
  for (const binding of ['this', 'arguments']) for (const mode of modes) {
    expect(transform(`function C() { return <i hx-post={() => ${binding}} />; }`, { ...options, mode }).diagnostics[0])
      .toMatchObject({ code: 'lexical-action-binding', severity: 'error' });
  }
  expect(transform(`<i hx-post={() => function () { return [this, arguments]; }} />`, options).diagnostics).toEqual([]);
});

it('reports parser label offsets against the original source', () => {
  const source = `const ok = 1;\nconst broken = ;`;
  const result = transform(source, options);
  const expected = parseSync(options.id, source).errors[0]!.labels[0]!;
  expect(result.diagnostics[0]).toMatchObject({ code: 'parse-error', start: expected.start, end: expected.end });
  expect(result.diagnostics[0]!.start).toBeGreaterThan(0);
  expect(result.code).toBe(source);
});

it('uses ESTree order for class extends/body and do-while body/test IDs', () => {
  for (const [source, first, second] of [
    [`class C extends make(<i hx-get={() => 'extends'} />) { field = <i hx-get={() => 'body'} />; }`, 'extends', 'body'],
    [`do { render(<i hx-get={() => 'body'} />); } while (check(<i hx-get={() => 'test'} />));`, 'body', 'test'],
  ]) {
    const result = transform(source!, options);
    expect(result.diagnostics).toEqual([]);
    expect(source!.slice(result.actions[0]!.start, result.actions[0]!.end)).toContain(first);
    expect(source!.slice(result.actions[1]!.start, result.actions[1]!.end)).toContain(second);
  }
});
