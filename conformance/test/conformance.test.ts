import { fileURLToPath } from "node:url";
import { describe, test, expect, beforeAll } from "vitest";
import { buildErrorFor, targetKey, discoverScenarios, expectationFor, loadScenario, observe, performRequest } from "../src/runner.js";
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
  if (reason && process.env.CONFORMANCE_ALLOW_SKIP !== "1") throw new Error(`Selected target ${name} is unavailable: ${reason}. Set CONFORMANCE_ALLOW_SKIP=1 to allow skipping.`);
  describe.skipIf(!!reason)(`${name}${reason ? ` (${reason})` : ""}`, () => {
    for (const { dir, data: scenario } of filtered) {
      const applies = !scenario.targets || scenario.targets.includes(name) || scenario.targets.includes(targetKey(target));
      const buildError = buildErrorFor(scenario, target);
      describe.skipIf(!applies)(scenario.name, () => {
        let result: BuildResult;
        let fetch: ReturnType<typeof observe>;
        const responses = new Map<string, { body: string; url: string }>();
        beforeAll(async () => {
          result = await target.build(dir, scenario);
          if (!buildError) {
            expect(result.kind, result.kind === "buildError" ? result.error : "").toBe("app");
            fetch = observe(result as BuiltApp);
          }
        });
        if (buildError) {
          test("rejects the build with the expected diagnostic", () => {
            expect(result.kind).toBe("buildError");
            if (result.kind !== "buildError") return;
            for (const part of [buildError!].flat()) expect(result.error).toContain(part);
          });
        } else {
          for (const request of scenario.requests!) {
            test(request.name, async () => {
              const firstExpected = expectationFor(request, scenario, target);
              const results = await performRequest(request, fetch, responses, target);
              for (const [index, actual] of results.entries()) {
                const expected = index > 0 ? request.repeatExpect?.[index - 1] ?? firstExpected : firstExpected;
                expect(actual.status).toBe(expected.status);
                if (expected.body !== undefined) expect(actual.body).toBe(expected.body);
                for (const part of expected.includes ?? []) expect(actual.body).toContain(part);
                for (const part of expected.excludes ?? []) expect(actual.body).not.toContain(part);
                for (const pattern of expected.matches ?? []) expect(actual.body).toMatch(new RegExp(pattern));
                for (const [pattern, count] of Object.entries(expected.counts ?? {})) expect([...actual.body.matchAll(new RegExp(pattern, "g"))]).toHaveLength(count);
                for (const [header, value] of Object.entries(expected.headers ?? {})) expect(actual.headers.get(header)).toBe(value);
                for (const part of expected.traceExcludes ?? []) expect(actual.trace).not.toContain(part);
                for (const script of actual.body.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
                  for (const part of expected.inlineScriptExcludes ?? []) expect(script[1]).not.toContain(part);
                }
                if (expected.clientExcludes || expected.clientIncludes || expected.noClientEntry) {
                  expect(actual.clientChunks, "Target must expose every emitted client chunk").toBeDefined();
                  const chunks = Object.values(actual.clientChunks!).join("\n");
                  for (const part of expected.clientExcludes ?? []) expect(chunks).not.toContain(part);
                  for (const part of expected.clientIncludes ?? []) expect(chunks).toContain(part);
                  if (expected.noClientEntry) {
                    const urls = Object.keys(actual.clientChunks!);
                    expect(urls.length, "Target must expose the app's client entry even on handler-free pages").toBeGreaterThan(0);
                    for (const script of actual.body.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
                      const src = new URL(script[1]!, "http://localhost").pathname;
                      for (const url of urls) expect(src).not.toBe(new URL(url, "http://localhost").pathname);
                    }
                  }
                }
                if (expected.trace) expect(actual.trace).toEqual(expected.trace);
              }
            });
          }
        }
      });
    }
  });
}
