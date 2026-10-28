import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import type { BuiltApp, Expectation, Scenario, ScenarioRequest } from "./target.js";

export async function loadScenario(dir: string): Promise<Scenario> {
  const scenario = JSON.parse(await readFile(path.join(dir, "scenario.json"), "utf8")) as Scenario;
  if (!scenario.name || !scenario.source || (!!scenario.requests === !!scenario.buildError)) {
    throw new Error(`${dir}: require name, source, and exactly one of requests or buildError`);
  }
  if (scenario.requests?.length === 0) throw new Error(`${dir}: requests must not be empty`);
  const names = new Set<string>();
  for (const request of scenario.requests ?? []) {
    if (!request.name || names.has(request.name) || (!!request.path === !!request.action) || !Number.isInteger(request.expect?.status)) {
      throw new Error(`${dir}: invalid/duplicate request ${request.name}`);
    }
    names.add(request.name);
    if (request.repeat !== undefined && (!Number.isInteger(request.repeat) || request.repeat < 1)) {
      throw new Error(`${dir}: repeat must be a positive integer`);
    }
  }
  return scenario;
}

/** Explicit paths can live anywhere (for example fixtures/consumer-shape/<scenario>). */
export async function discoverScenarios(root: string, additional: string[] = []): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return [...new Set([
    ...entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name)),
    ...additional.map((dir) => path.resolve(dir)),
  ])].sort();
}

export function expectationFor(request: ScenarioRequest, scenario: Scenario, target: string): Expectation {
  if (target !== "ts") return request.expect;
  const replacements = [...scenario.changes ?? [], ...request.changes ?? []].flatMap((change) => change.ts ? [change.ts] : []);
  if (replacements.length > 1) throw new Error(`Ambiguous TS expectations for ${request.name}`);
  return replacements[0] ?? request.expect;
}

export function actionUrl(html: string, attribute: string, index: number, page: string): string {
  if (!/^(data-)?hx-(get|post|put|patch|delete)$/.test(attribute)) throw new Error(`Invalid action attribute ${attribute}`);
  const urls = [...html.matchAll(new RegExp(`(?:\\s)${attribute}=["']([^"']+)["']`, "g"))];
  const encoded = urls[index]?.[1];
  if (encoded === undefined) throw new Error(`No ${attribute}[${index}] in page ${page}: ${html.slice(0, 500)}`);
  const decoded = encoded.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[0-9a-f]+);/gi, (entity) => {
    const named: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">" };
    return named[entity] ?? String.fromCodePoint(entity.startsWith("&#x") ? parseInt(entity.slice(3), 16) : Number(entity.slice(2, -1)));
  });
  return new URL(decoded, new URL(page, "http://localhost")).href;
}

export interface Observation { status: number; body: string; headers: Headers; trace: string[] }

// Review fixtures originally used this trace channel. The harness exposes it as a response
// header, identically for both targets. Scenarios execute serially; builds run out of process.
const state = globalThis as typeof globalThis & { __t?: string[]; __app?: unknown; __dbUp?: boolean; __rl?: boolean };

export function observe(app: BuiltApp): (request: Request, mount?: ScenarioRequest["mount"]) => Promise<Observation> {
  const dispatch = app.fetch.bind(app);
  state.__app = {
    fetch: dispatch,
    request: (url: string | Request, init?: RequestInit) => dispatch(url instanceof Request ? url : new Request(new URL(url, "http://localhost"), init)),
  };
  const mounts = new Map<string, Hono>();
  return async (request, mount) => {
    state.__t = [];
    state.__dbUp = false;
    state.__rl = false;
    let response: Response;
    if (mount) {
      const key = JSON.stringify(mount);
      let outer = mounts.get(key);
      if (!outer) {
        // route/basePath need the actual route table, not just a fetch proxy. The Farm
        // adapter exposes the app through a non-public symbol for this harness operation.
        const routed = (app as BuiltApp & { hono?: Hono }).hono;
        if (mount.type !== "mount" && !routed) throw new Error("Target must expose hono for route/basePath mount probes");
        outer = new Hono({ strict: true });
        if (mount.type === "mount") outer.mount(mount.prefix, dispatch);
        else if (mount.type === "basePath") outer.basePath(mount.prefix).route("/", routed!);
        else outer.route(mount.prefix, routed!);
        mounts.set(key, outer);
      }
      response = await outer.fetch(request);
    } else response = await dispatch(request);
    const body = await response.text();
    const headers = new Headers(response.headers);
    headers.set("x-conformance-trace", JSON.stringify(state.__t));
    return { status: response.status, body, headers, trace: JSON.parse(headers.get("x-conformance-trace")!) as string[] };
  };
}

export async function performRequest(
  request: ScenarioRequest,
  fetch: ReturnType<typeof observe>,
  responses: Map<string, { body: string; url: string }>,
): Promise<Observation[]> {
  let url = new URL(request.path ?? "/", "http://localhost").href;
  if (request.action) {
    const action = request.action;
    let rendered = action.response ? responses.get(action.response) : undefined;
    if (action.response && !rendered) throw new Error(`No previous response named ${action.response}`);
    if (!rendered) {
      const page = new URL(action.page, "http://localhost").href;
      const response = await fetch(new Request(page, { headers: action.headers }));
      if (response.status !== 200) throw new Error(`Action page ${page} returned ${response.status}`);
      rendered = { body: response.body, url: page };
    }
    url = actionUrl(rendered.body, action.attribute, action.index ?? 0, rendered.url);
  }
  const init: RequestInit = { method: request.method ?? "GET", headers: request.headers };
  if (request.form) init.body = new URLSearchParams(request.form);
  else if (request.body !== undefined) init.body = request.body;
  const input = new Request(url, init);
  const results: Observation[] = [];
  for (let i = 0; i < (request.repeat ?? 1); i++) results.push(await fetch(input, request.mount));
  responses.set(request.name, { body: results.at(-1)!.body, url });
  return results;
}
