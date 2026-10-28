import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bannedClientModules, isBannedModule, moduleIdForms } from "../../src/htmx/transform/banned-imports.js";

interface Fixtures {
  forms: [string, string[]][];
  graphs: { name: string; entry: string; pattern: string; edges: [string, string][]; expected: string[] }[];
}
const fixtures: Fixtures = JSON.parse(readFileSync(new URL('./fixtures/banned-imports.json', import.meta.url), 'utf8'));
describe('0.0.27 banned_imports.rs fixtures', () => {
  it('matches_module_ids_without_query_and_by_package_path', () => {
    for (const [id, expected] of fixtures.forms) expect(moduleIdForms(id)).toEqual(expected);
    expect(moduleIdForms('node_modules/node_modules/db/index.js')[1]).toBe('db/index.js');
    expect(moduleIdForms('/src/my_node_modules/db/index.js?client')).toEqual(['/src/my_node_modules/db/index.js']);
    const patterns = [/^faunadb\//, /lib\/db\.ts$/];
    for (const id of [fixtures.forms[3]![0], 'node_modules/faunadb/index.js', 'src/lib/db.ts?recooler-handlers']) {
      expect(isBannedModule(patterns, id)).toBe(true);
    }
    for (const id of ['node_modules/not-faunadb/index.js', 'src/faunadb/index.js']) expect(isBannedModule(patterns, id)).toBe(false);
  });
  for (const fixture of fixtures.graphs) it(fixture.name, () => {
    const graph = new Map<string, string[]>();
    for (const [from, to] of fixture.edges) graph.set(from, [...(graph.get(from) ?? []), to]);
    expect(bannedClientModules(graph, fixture.entry, id => new RegExp(fixture.pattern).test(id))).toEqual(fixture.expected);
  });
});
