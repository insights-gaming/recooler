import { describe, expect, test } from "vitest";
import { actionUrl, expectationFor, performRequest } from "../src/runner.js";
import type { Observation } from "../src/runner.js";
import type { Scenario, ScenarioRequest } from "../src/target.js";

describe("portable request contract", () => {
  test("follows signed absolute URLs, relative URLs and escaped query parameters", () => {
    const html = '<button hx-post="?token=a&amp;signature=b&#x26;scope=c"></button><form hx-post="https://other.test/mounted/action?sig=xyz"></form>';
    expect(actionUrl(html, "hx-post", 0, "/mounted/page")).toBe("http://localhost/mounted/page?token=a&signature=b&scope=c");
    expect(actionUrl(html, "hx-post", 1, "/mounted/page")).toBe("https://other.test/mounted/action?sig=xyz");
    expect(() => actionUrl(html, "hx-get", 0, "/")).toThrow("No hx-get");
  });

  test("does not confuse data-hx-post with hx-post or similarly named attributes", () => {
    expect(actionUrl('<button data-hx-post="/data" hx-post="/plain" not-hx-post="/wrong">', "data-hx-post", 0, "/")).toBe("http://localhost/data");
    expect(actionUrl('<button data-hx-post="/data" hx-post="/plain">', "hx-post", 0, "/")).toBe("http://localhost/plain");
  });

  test("re-dispatches the identical Request and extracts nested actions from prior responses", async () => {
    const seen: Request[] = [];
    const responses = new Map([["outer", { body: '<button hx-post="?signed=opaque&amp;token=2">', url: "http://localhost/fragment" }]]);
    const request: ScenarioRequest = {
      name: "nested", method: "POST", repeat: 2,
      action: { page: "/ignored", attribute: "hx-post", response: "outer" },
      expect: { status: 204 },
    };
    const result: Observation = { status: 204, body: "", headers: new Headers(), trace: [] };
    await performRequest(request, async (req) => { seen.push(req); return result; }, responses);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]!.url).toBe("http://localhost/fragment?signed=opaque&token=2");
  });

  test("annotations preserve oracle expectations and apply explicit TS replacements", () => {
    const scenario: Scenario = { name: "csrf", source: "plan D7", requests: [] };
    const request: ScenarioRequest = {
      name: "without header", path: "/", expect: { status: 200, body: "ok" },
      changes: [{ decision: "D7", reason: "Require HX-Request", ts: { status: 403 } }],
    };
    expect(expectationFor(request, scenario, "farm-0.0.27")).toEqual({ status: 200, body: "ok" });
    expect(expectationFor(request, scenario, "ts")).toEqual({ status: 403 });
  });
});
