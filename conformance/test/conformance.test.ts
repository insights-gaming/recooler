import { fileURLToPath } from "node:url";
import { describe, test, expect, beforeAll } from "vitest";
import { discoverScenarios, expectationFor, loadScenario, observe, performRequest } from "../src/runner.js";
import { farmTarget } from "../src/targets/farm.js";
import { tsTarget } from "../src/targets/ts.js";
import type { BuiltApp, BuildResult, Target } from "../src/target.js";

const available = new Map<string, Target>([farmTarget, tsTarget].map((target) => [target.name, target]));
const selected = (process.env.CONFORMANCE_TARGETS ?? process.env.CONFORMANCE_TARGET ?? "farm-0.0.27").split(",");
const filters = process.env.CONFORMANCE_SCENARIOS?.split(",").filter(Boolean) ?? [];
const extra = process.env.CONFORMANCE_DIRS?.split(":").filter(Boolean) ?? [];
const dirs = await discoverScenarios(fileURLToPath(new URL("../scenarios", import.meta.url)), extra);
const selectedDirs = dirs.filter((dir) => !filters.length || filters.some((part) => dir.split("/").at(-1)!.includes(part)));
const filtered = await Promise.all(selectedDirs.map(async (dir) => ({ dir, data: await loadScenario(dir) })));
if (!filtered.length) throw new Error("No scenarios matched CONFORMANCE_SCENARIOS");

for (const name of selected) {
  const target = available.get(name);
  if (!target) throw new Error(`Unknown conformance target ${name}`);
  const reason = await target.unavailable?.();
  describe.skipIf(!!reason)(`${name}${reason ? ` (${reason})` : ""}`, () => {
    for (const { dir, data: scenario } of filtered) {
      describe(scenario.name, () => {
        let result: BuildResult;
        let fetch: ReturnType<typeof observe>;
        const responses = new Map<string, { body: string; url: string }>();
        beforeAll(async () => {
          result = await target.build(dir, scenario);
          if (!scenario.buildError) {
            expect(result.kind, result.kind === "buildError" ? result.error : "").toBe("app");
            fetch = observe(result as BuiltApp);
          }
        });
        if (scenario.buildError) {
          test("rejects the build with the expected diagnostic", () => {
            expect(result.kind).toBe("buildError");
            if (result.kind !== "buildError") return;
            for (const part of [scenario.buildError].flat()) expect(result.error).toContain(part);
          });
        } else {
          for (const request of scenario.requests!) {
            test(request.name, async () => {
              const expected = expectationFor(request, scenario, name);
              for (const actual of await performRequest(request, fetch, responses)) {
                expect(actual.status).toBe(expected.status);
                if (expected.body !== undefined) expect(actual.body).toBe(expected.body);
                for (const part of expected.includes ?? []) expect(actual.body).toContain(part);
                for (const part of expected.excludes ?? []) expect(actual.body).not.toContain(part);
                for (const pattern of expected.matches ?? []) expect(actual.body).toMatch(new RegExp(pattern));
                for (const [pattern, count] of Object.entries(expected.counts ?? {})) expect([...actual.body.matchAll(new RegExp(pattern, "g"))]).toHaveLength(count);
                for (const [header, value] of Object.entries(expected.headers ?? {})) expect(actual.headers.get(header)).toBe(value);
                if (expected.trace) expect(actual.trace).toEqual(expected.trace);
              }
            });
          }
        }
      });
    }
  });
}
