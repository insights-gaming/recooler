import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { actionUrl, buildErrorFor, expectationFor, loadScenario, observe, performRequest } from "../src/runner.js";
import type { Observation } from "../src/runner.js";
import type { Scenario, ScenarioRequest } from "../src/target.js";
import { tsUnavailable } from "../src/targets/ts.js";

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
  test("renders through the mount, preserves a signed query on a foreign path and supplies CSRF headers", async () => {
    const seen: { request: Request; mount: unknown }[] = [];
    const request: ScenarioRequest = {
      name: "foreign", method: "POST", mount: { type: "route", prefix: "/app" },
      action: { page: "/app/admin", path: "/app/public", attribute: "hx-post", headers: { "x-auth": "yes" } },
      expect: { status: 401 },
    };
    await performRequest(request, async (input, mount) => {
      seen.push({ request: input, mount });
      return { status: 200, body: '<button hx-post="?action=opaque&amp;sig=signed">', headers: new Headers(), trace: [] };
    }, new Map());
    expect(seen.map((s) => s.mount)).toEqual([request.mount, request.mount]);
    expect(seen[0]!.request.headers.get("x-auth")).toBe("yes");
    const sent = seen[1]!.request;
    expect(sent.url).toBe("http://localhost/app/public?action=opaque&sig=signed");
    expect(sent.headers.get("HX-Request")).toBe("true");
    expect(sent.headers.get("Origin")).toBe("http://localhost");
    expect(sent.headers.get("Sec-Fetch-Site")).toBe("same-origin");
  });

  test("supplies security headers to reserved-parameter probes and permits explicit negative requests", async () => {
    const seen: Request[] = [];
    const fetch = async (req: Request): Promise<Observation> => {
      seen.push(req);
      return { status: 404, body: "", headers: new Headers(), trace: [] };
    };
    await performRequest({ name: "unknown", path: "/?action=unknown", expect: { status: 404 } }, fetch, new Map());
    await performRequest({ name: "negative", path: "/?action=unknown", headers: { Origin: "https://evil.test", "Sec-Fetch-Site": "cross-site" }, omitHeaders: ["HX-Request"], expect: { status: 403 } }, fetch, new Map());
    expect(seen[0]!.headers.get("Origin")).toBe("http://localhost");
    expect(seen[0]!.headers.get("HX-Request")).toBe("true");
    expect(seen[1]!.headers.get("Origin")).toBe("https://evil.test");
    expect(seen[1]!.headers.has("HX-Request")).toBe(false);
  });

  test.each(["drop-sig", "flip-sig", "scope", "method"] as const)("tampers with an extracted action: %s", async (tamper) => {
    const seen: Request[] = [];
    await performRequest({
      name: tamper, method: "POST", action: { page: "/users/1", attribute: "hx-post", tamper }, expect: { status: 404 },
    }, async (input) => {
      seen.push(input);
      return { status: 200, body: '<button hx-post="?action=real&amp;sig=abc&amp;scope=%7B%22value%22%3A%22original%22%7D">', headers: new Headers(), trace: [] };
    }, new Map(), "ts");
    const sent = seen[1]!;
    const url = new URL(sent.url);
    expect(url.pathname).toBe("/users/1");
    expect(url.searchParams.get("action")).toBe("real");
    expect(url.searchParams.get("sig")).toBe(tamper === "drop-sig" ? null : tamper === "flip-sig" ? "0bc" : "abc");
    expect(JSON.parse(url.searchParams.get("scope")!)).toEqual({ value: tamper === "scope" ? "tampered" : "original" });
    expect(sent.method).toBe(tamper === "method" ? "GET" : "POST");
    expect(sent.headers.get("HX-Request")).toBe("true");
  });

  test.each(["farm-0.0.27", "ts"])("applies the mounted URL correction only to the oracle: %s", async (target) => {
    const seen: Request[] = [];
    await performRequest({
      name: "mount", method: "POST", action: { page: "/app/page", attribute: "hx-post", oraclePath: "/app/page" }, expect: { status: 200 },
    }, async (input) => {
      seen.push(input);
      return { status: 200, body: '<button hx-post="/page?action=real&amp;sig=abc">', headers: new Headers(), trace: [] };
    }, new Map(), target);
    expect(new URL(seen[1]!.url).pathname).toBe(target === "ts" ? "/page" : "/app/page");
    expect(new URL(seen[1]!.url).searchParams.get("sig")).toBe("abc");
  });

  test.each(["recooler/htmx", "recooler/vite"])("allows a missing public entrypoint to skip: %s", async (missing) => {
    const reason = await tsUnavailable(async (name) => {
      if (name === missing) throw Object.assign(new Error("missing entry"), { code: "ERR_MODULE_NOT_FOUND", url: import.meta.resolve(name) });
      return { createApp() {} };
    });
    expect(reason).toBe(`${missing} is not built yet`);
  });

  test.each([
    new SyntaxError("broken bundle"),
    Object.assign(new Error("missing dependency"), { code: "ERR_MODULE_NOT_FOUND", url: "file:///missing-dependency.js" }),
  ])("fails for a broken TS build: %s", async (failure) => {
    await expect(tsUnavailable(async () => { throw failure; })).rejects.toBe(failure);
  });

  test("fails for a built router with an invalid public export", async () => {
    await expect(tsUnavailable(async () => ({}))).rejects.toThrow("must export createApp");
  });

  test("preserves leading double slashes as a local request path", async () => {
    let sent: Request | undefined;
    await performRequest({ name: "path", path: "//admin", expect: { status: 404 } }, async (req) => {
      sent = req;
      return { status: 404, body: "", headers: new Headers(), trace: [] };
    }, new Map());
    expect(sent!.url).toBe("http://localhost//admin");
  });

  test("selects versioned TS target and independent build diagnostics", () => {
    const target = { name: "ts-0.1.0", expectationFamily: "ts" as const, build: async () => { throw new Error(); } };
    const scenario: Scenario = { name: "error", source: "test", buildError: "Rust wording", buildErrors: { ts: ["route A", "route B"] } };
    expect(buildErrorFor(scenario, target)).toEqual(["route A", "route B"]);
    expect(buildErrorFor(scenario, "farm-0.0.27")).toBe("Rust wording");
    const request: ScenarioRequest = { name: "action", path: "/", expect: { status: 200 }, changes: [{ decision: "D7", reason: "CSRF", ts: { status: 403 } }] };
    expect(expectationFor(request, scenario, target)).toEqual({ status: 403 });
  });

  test("rejects a scenario-wide TS replacement instead of overwriting every request", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "conformance-schema-"));
    try {
      await writeFile(path.join(dir, "scenario.json"), JSON.stringify({ name: "bad", source: "test", requests: [{ name: "one", path: "/", expect: { status: 200 } }], changes: [{ decision: "D7", reason: "bad", ts: { status: 403 } }] }));
      await expect(loadScenario(dir)).rejects.toThrow("individual requests");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("retains failure state for the same Request and resets it for a fresh request", async () => {
    const state = globalThis as typeof globalThis & { __dbUp?: boolean };
    const app = new Hono();
    app.get("/", (c) => {
      if (!state.__dbUp) { state.__dbUp = true; return c.text("down", 500); }
      return c.text("up");
    });
    const fetch = observe({ kind: "app", fetch: app.fetch });
    const input = new Request("http://localhost/");
    expect((await fetch(input)).status).toBe(500);
    expect((await fetch(input)).status).toBe(200);
    expect((await fetch(new Request(input.url))).status).toBe(500);
  });
});
