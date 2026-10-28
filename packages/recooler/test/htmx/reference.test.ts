import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSync } from "oxc-parser";
import { transformWithOxc } from "vite";
import { transform } from "../../src/htmx/transform/index.js";
import type { TransformMode } from "../../src/htmx/transform/index.js";

interface Fixture { name: string; inputs: string[] }
const fixtures: Fixture[] = JSON.parse(readFileSync(new URL('./fixtures/reference.json', import.meta.url), 'utf8'));
const relativePath = "src/routes/article/[id]/index.tsx";
const patterns: Record<string, string[]> = {
  reports_banned_imports_with_reference_chain: ["/fql$"],
  reports_banned_imports_reached_from_on_load: ["/fql$"],
  reports_banned_dynamic_imports_and_requires: ["/fql$", "^faunadb$", "server-only"],
  ignores_dynamic_imports_without_a_static_specifier_or_outside_the_slice: ["faunadb", "fql"],
};
const expectedCaptures: Record<string, string[][]> = {
  captures_without_rewriting_the_action: [["count"]],
  captures_survive_hygiene: [["count"]],
  captures_references_in_every_position: [["a", "b", "c", "d", "e", "f", "g", "h"]],
  does_not_capture_module_scope_globals_or_inner_bindings: [["list"]],
  captures_loop_and_switch_bindings: [["item"], ["y"]],
  captured_variables_are_mutable: [["count"]],
  transforms_nested_actions_using_outer_action_context: [["a"], ["a"]],
  nested_actions_do_not_use_outer_explicit_context: [[], []],
  skips_typescript_this_param_for_context: [["id"], ["id"]],
};

describe("0.0.27 transform.rs fixtures (D3/D5 and ctx-rendering adaptations)", () => {
  expect(fixtures).toHaveLength(39);
  for (const fixture of fixtures) for (const [i, source] of fixture.inputs.entries()) {
    const modes: TransformMode[] = /^(slices_|reports_banned_|ignores_dynamic_)/.test(fixture.name)
      ? ['client-slice'] : ['full', 'server'];
    for (const mode of modes) it(`${fixture.name}/${i}/${mode}`, async () => {
      const result = transform(source, { id: relativePath, relativePath, mode, moduleKind: 'route', clientBannedImports: patterns[fixture.name] });
      const errors = result.diagnostics.filter(d => d.severity === 'error');
      if (fixture.name === 'rejects_local_functions_and_classes') {
        expect(errors).toHaveLength(2);
        expect(errors.map(d => d.message).join('\n')).toContain('local function `fmt`');
        expect(errors.map(d => d.message).join('\n')).toContain('local class `Thing`');
      } else if (fixture.name === 'rejects_this_and_arguments_in_arrow_event_handlers' && i === 0) {
        expect(errors).toHaveLength(8);
        expect(errors[0]?.message).toBe(`${relativePath}: event handler ${relativePath}@0 is an arrow function that uses \`this\`, which arrow functions don't bind; use a \`function\` expression to get the element as \`this\`, or \`event.currentTarget\``);
      } else if (patterns[fixture.name]) {
        expect(errors.length).toBeGreaterThan(0);
        expect(errors.every(e => e.code === 'banned-client-import')).toBe(true);
        if (fixture.name === 'reports_banned_imports_with_reference_chain') expect(errors[0]?.message).toBe(
          `event handler ${relativePath}@1 imports banned module "../lib/fql" via _handler$1 → updateTable → query → faunaClient`);
        if (fixture.name === 'reports_banned_dynamic_imports_and_requires' && i === 0) expect(errors.map(e => e.message)).toEqual([
          `event handler ${relativePath}@0 imports banned module "faunadb" via _handler$0`,
          `event handler ${relativePath}@1 imports banned module "../lib/fql" via _handler$1 → load`,
          `event handler ${relativePath}@2 imports banned module "faunadb" via _handler$2 → legacy`,
        ]);
      } else expect(errors, result.code).toEqual([]);
      if (expectedCaptures[fixture.name]) expect(result.actions.map(a => a.captures)).toEqual(expectedCaptures[fixture.name]);
      if (!errors.length) {
        expect(parseSync(relativePath, result.code).errors, result.code).toEqual([]);
        if (mode === 'server') expect(result.code).not.toContain('export const _handler$');
        if (mode === 'client-slice') {
          expect(result.code).not.toContain('export default');
          expect(result.code).not.toContain('_action$');
          expect(result.code).not.toContain('handlerScope');
        }
      }
      const output = errors.length ? errors.map(d => d.message).join('\n') + '\n'
        : (await transformWithOxc(result.code, relativePath, { jsx: 'preserve' })).code;
      await expect(output).toMatchFileSnapshot(fileURLToPath(new URL(`./fixtures/output/${fixture.name}-${i}-${mode}.txt`, import.meta.url)));
    });
  }
});

it('preserves the reference negative banned-import and non-route onLoad cases', () => {
  for (const [name, patterns] of [
    ['reports_banned_imports_with_reference_chain', ['^faunadb$']],
    ['reports_banned_dynamic_imports_and_requires', ['server-only']],
  ] as const) {
    const source = fixtures.find(f => f.name === name)!.inputs[0]!;
    expect(transform(source, { id: relativePath, relativePath, mode: 'client-slice', moduleKind: 'route', clientBannedImports: patterns }).diagnostics).toEqual([]);
  }
  const source = fixtures.find(f => f.name === 'slices_on_load_without_event_handlers')!.inputs[0]!;
  expect(transform(source, { id: relativePath, relativePath, mode: 'client-slice', moduleKind: 'component' }).code.trim()).toBe('');
});
