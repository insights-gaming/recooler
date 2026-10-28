import { describe, expect, it } from 'vitest';
import { parseSync } from 'oxc-parser';
import { transform } from '../../src/htmx/transform/index.js';
const options = { id: 'test.tsx', relativePath: 'test.tsx' };

describe('0.0.27 gaps', () => {
  it('transforms computed string keys and diagnoses dynamic function keys', () => {
    const result = transform(`function Page({n}) { return { ['hx-post']: () => n, ['data-hx-on:click']: () => n }; }`, options);
    expect(result.diagnostics).toEqual([]);
    expect(result.actions[0]?.captures).toEqual(['n']);
    expect(result.handlers[0]?.captures).toEqual(['n']);
    expect(parseSync('test.tsx', result.code).errors).toEqual([]);
    const error = transform(`const props = { [attribute]: () => 1 };`, options);
    expect(error.diagnostics.map(e => e.code)).toEqual(['computed-handler-key']);
  });
  it('rejects actions nested in event handlers in JSX and object forms', () => {
    for (const source of [
      `<i hx-on:click={() => <b hx-post={() => 1} />} />`,
      `const p = { 'hx-on:click': () => ({ ['data-hx-get']: () => 1 }) };`,
    ]) for (const mode of ['full', 'server', 'client-slice'] as const) {
      expect(transform(source, { ...options, mode }).diagnostics.map(e => e.code)).toEqual(['action-in-handler']);
    }
  });
  it('allows import.meta in module handlers and slices', () => {
    for (const mode of ['full', 'client-slice'] as const) {
      const result = transform(`<i hx-on:click={() => import.meta.url} />`, { ...options, mode });
      expect(result.diagnostics).toEqual([]);
      expect(result.code).toContain('import.meta.url');
      expect(parseSync('test.tsx', result.code).errors).toEqual([]);
    }
  });
  it('distinguishes global require from shadowed parameters, locals and imports', () => {
    const source = `import require from './safe';
      function helper(require) { return require('banned'); }
      const local = () => { const require = x => x; return require('banned'); };
      export default function Page() { return <i hx-on:click={() => [require('banned'), helper(x=>x), local()]} />; }`;
    expect(transform(source, { ...options, mode: 'client-slice', clientBannedImports: ['^banned$'] }).diagnostics).toEqual([]);
    const global = transform(`<i hx-on:click={() => require('banned')} />`, { ...options, clientBannedImports: ['^banned$'] });
    expect(global.diagnostics[0]?.message).toContain('imports banned module "banned" via _handler$0');
  });
  it('keeps ctx and spreads for the JSX runtime to filter at render time', () => {
    const source = `<><Wrapper ctx={c} hx-post={() => 1} /><button ctx={c} {...props} {...{ ...props, title: 'x' }} /></>`;
    const result = transform(source, options);
    expect(result.code).toContain('ctx={c}');
    expect(result.code).toContain('{...props}');
    expect(result.code).not.toContain('omitCtx');
  });
});

it('assigns independent action/handler counters, including base36 rollover', () => {
  const source = `<div>${Array.from({length: 40}, (_, n) => `<i hx-post={() => ${n}} hx-on:click={() => ${n}} />`).join('')}</div>`;
  const results = ['full', 'server', 'client-slice'].map(mode => transform(source, { ...options, mode: mode as 'full' }));
  for (const result of results) {
    expect(result.actions[36]?.id).toBe('test.tsx@10');
    expect(result.handlers[36]?.id).toBe('test.tsx@10');
    expect(result.actions[39]?.exportName).toBe('_action$post$39');
    expect(result.handlers[39]?.exportName).toBe('_handler$39');
    expect(parseSync('test.tsx', result.code).errors, result.code).toEqual([]);
  }
});

it('isolates both open codegen decisions and aliases runtime helpers', () => {
  const result = transform(`const actionUrl = 1; const __recooler_actionUrl = 2; function Page() { return <i hx-post={() => 1} />; }`, {
    ...options, codegen: {
      actionUrl: ({ id, scope, helper }) => `${helper}(${JSON.stringify(id)}, ${scope}, CUSTOM_CONTEXT)`,
      registerActions: ({ moduleId, helper }) => `${helper}(${JSON.stringify(moduleId)}, CUSTOM_REGISTRY);`,
    },
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.code).toContain('actionUrl as __recooler_actionUrl$1');
  expect(result.code).toContain('CUSTOM_CONTEXT');
  expect(result.code).toContain('CUSTOM_REGISTRY');
});
