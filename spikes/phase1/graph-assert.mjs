import assert from 'node:assert/strict';
export function assertGraph(result, verbatim, changed = false) {
  const ids = result.table['/public'];
  for (const id of ['src/route.ts', 'src/root.ts', 'src/layout.ts', 'src/component.ts', 'src/mixed.ts', 'src/admin.ts', 'src/side.ts', 'src/cycle-a.ts', 'src/cycle-b.ts', 'outside/component.ts', 'node_modules/spike-actions/index.js']) assert(ids.includes(id), 'missing ' + id + ': ' + ids);
  assert(!ids.includes('src/types.ts'));
  assert(!ids.includes('src/dynamic.ts'));
  assert.equal(ids.includes('src/unused.ts'), verbatim);
  assert.equal(ids.includes('src/type-named.ts'), verbatim);
  assert.equal(ids.includes('src/added.ts'), changed);
  assert.equal(result.actions.includes('src/types.ts@0'), false);
  assert.equal(result.actions.includes('src/dynamic.ts@0'), false);
  for (const id of ids.filter(id => !id.endsWith('barrel.ts'))) assert(result.actions.includes(id + '@0'), id);
}
