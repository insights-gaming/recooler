import type { BuildResult, Scenario, ScenarioRequest, Target } from "../target.js";
import { access, cp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { filesUnder } from "./farm.js";
import { fileURLToPath, pathToFileURL } from "node:url";

const importModule = async (name: string): Promise<Record<string, unknown>> => {
  const entry = import.meta.resolve(name);
  // Vitest can wrap a missing file as a generic "Cannot find package" error.
  // Check the resolved entry itself before evaluating it, so this remains
  // distinguishable from a missing dependency inside an existing build.
  try { await access(fileURLToPath(entry)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw Object.assign(new Error(`Missing public entrypoint ${name}`), { code: "ERR_MODULE_NOT_FOUND", url: entry });
  }
  // JSX's engine is deliberately bundled by Vite: it is not native Node ESM.
  if (name === "@insights-gaming/recooler/jsx") return {};
  return import(/* @vite-ignore */ entry);
};

/** Missing public entrypoints mean "not built". Missing transitive dependencies,
 * evaluation errors and invalid exports mean a broken build and must fail. */
export async function tsUnavailable(load = importModule): Promise<string | undefined> {
  for (const name of ["@insights-gaming/recooler/router", "@insights-gaming/recooler/jsx", "@insights-gaming/recooler/vite"]) {
    let module: Record<string, unknown>;
    try {
      module = await load(name);
    } catch (error) {
      const failure = error as { code?: string; url?: string; message?: string };
      if (failure.code === "ERR_MODULE_NOT_FOUND") {
        let entry: string | undefined;
        try { entry = import.meta.resolve(name); } catch { /* package itself may be absent */ }
        if ((entry && failure.url === entry) || failure.message?.startsWith("Cannot find package '@insights-gaming/recooler'")) {
          return `${name} is not built yet`;
        }
      }
      throw error;
    }
    if (name === "@insights-gaming/recooler/router" && typeof module.createApp !== "function") {
      throw new Error("Broken @insights-gaming/recooler/router build: must export createApp");
    }
  }
  return undefined;
}

const packageDir = fileURLToPath(new URL("../../", import.meta.url));
const implementation = path.join(packageDir, "../dist");
const builder = fileURLToPath(new URL("./ts-build.mjs", import.meta.url));
const execute = promisify(execFile);
let importGeneration = 0;

/** Feature tags apply to requests, so mixed scenarios still exercise routing. */
export function tsRequestSkipReason(request: ScenarioRequest): string | undefined {
  return undefined;
}

const buildMode = "production";
const buildNodeEnv = "production";
let prunedNamespace: string | undefined;

/** Deterministic location for build bytes and diagnostics, also used by cache verification. */
export async function tsCacheDirectory(scenarioDir: string, scenario?: Scenario): Promise<string> {
  const hash = createHash("sha256");
  hash.update(`ts/vite-8.3.5/${process.version}/${process.platform}/${process.arch}/mode=${buildMode}/NODE_ENV=${buildNodeEnv}`);
  for (const file of [builder, fileURLToPath(import.meta.url), path.join(packageDir, "../pnpm-lock.yaml"), path.join(packageDir, "tsconfig.json"), path.join(implementation, "../package.json"), ...await filesUnder(implementation)]) {
    hash.update(path.relative(packageDir, file));
    hash.update(new Uint8Array(await readFile(file)));
    hash.update("\0");
  }
  const namespace = hash.digest("hex");
  const sources = createHash("sha256");
  sources.update(JSON.stringify(scenario?.ts?.htmxOptions ?? {}));
  const src = path.join(scenarioDir, "src");
  for (const file of await filesUnder(src)) {
    sources.update(path.relative(src, file));
    sources.update("\0");
    sources.update(new Uint8Array(await readFile(file)));
    sources.update("\0");
  }
  return path.join(packageDir, ".cache", `ts-${namespace}-${sources.digest("hex")}`);
}

export const tsTarget: Target = {
  name: "ts",
  expectationFamily: "ts",
  unavailable: tsUnavailable,
  requestSkipReason: tsRequestSkipReason,
  async build(scenarioDir: string, scenario: Scenario): Promise<BuildResult> {
    const src = path.join(scenarioDir, "src");
    const cache = await tsCacheDirectory(scenarioDir, scenario);
    const cacheRoot = path.dirname(cache);
    const namespace = path.basename(cache).split('-')[1]!;
    await mkdir(cacheRoot, { recursive: true });
    // Drop incompatible implementation/mode caches, including the old ts-<hash> format.
    if (prunedNamespace !== namespace) {
      for (const entry of await readdir(cacheRoot)) {
        if (entry.startsWith('ts-') && entry !== 'ts-index.json' && !entry.startsWith(`ts-${namespace}-`)) {
          await rm(path.join(cacheRoot, entry), { recursive: true, force: true });
        }
      }
      prunedNamespace = namespace;
    }
    const indexPath = path.join(cacheRoot, 'ts-index.json');
    let index: Record<string, string> = {};
    try { index = JSON.parse(await readFile(indexPath, 'utf8')); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const scenario of Object.keys(index)) {
      try { await access(scenario); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        delete index[scenario];
      }
    }
    const previous = index[scenarioDir];
    index[scenarioDir] = path.basename(cache);
    await writeFile(indexPath, JSON.stringify(index));
    if (previous && previous !== path.basename(cache) && !Object.values(index).includes(previous)) {
      await rm(path.join(cacheRoot, previous), { recursive: true, force: true });
    }
    const retained = new Set(Object.values(index));
    for (const entry of await readdir(cacheRoot)) {
      if (entry.startsWith(`ts-${namespace}-`) && !retained.has(entry)) {
        await rm(path.join(cacheRoot, entry), { recursive: true, force: true });
      }
    }
    const resultPath = path.join(cache, "result.json");
    let cached = true;
    try { await access(resultPath); } catch { cached = false; }
    if (!cached || process.env.CONFORMANCE_REBUILD === "1") {
      await rm(cache, { recursive: true, force: true });
      await mkdir(cache, { recursive: true });
      await cp(src, path.join(cache, "src"), { recursive: true });
      await symlink(path.join(packageDir, "node_modules"), path.join(cache, "node_modules"), "dir");
      await writeFile(path.join(cache, "package.json"), '{"name":"recooler-conformance-app","type":"module"}\n');
      await writeFile(path.join(cache, "htmx-options.json"), JSON.stringify(scenario.ts?.htmxOptions ?? {}));
      let logs: string;
      try {
        const result = await execute(process.execPath, [builder, cache], { cwd: cache, env: { ...process.env, NODE_ENV: buildNodeEnv }, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
        logs = result.stdout + result.stderr;
      } catch (error) {
        const failure = error as Error & { stdout?: string; stderr?: string; signal?: string };
        logs = (failure.stdout ?? "") + (failure.stderr ?? "") + "\n" + failure.message;
        if (failure.signal) throw new Error(`Vite infrastructure failure (${failure.signal}) for ${scenarioDir}:\n${logs}`);
      }
      await writeFile(path.join(cache, "build.log"), logs);
      // A crash or abnormal exit cannot satisfy a diagnostic expectation.
      await access(resultPath);
    }
    const result = JSON.parse(await readFile(resultPath, "utf8")) as { ok: boolean; error?: string };
    if (!result.ok) return { kind: "buildError", error: result.error ?? "" };
    let app: import("hono").Hono;
    try {
      // Bundling isolates module state; the engine also stores state on globalThis.
      delete (globalThis as { SUSPENSE_ROOT?: unknown }).SUSPENSE_ROOT;
      const url = pathToFileURL(path.join(cache, "dist/app.mjs")).href;
      const module = await import(/* @vite-ignore */ `${url}?scenario=${encodeURIComponent(scenarioDir)}&instance=${importGeneration++}`);
      app = module.default;
    } catch (error) { return { kind: "buildError", error: String((error as Error).stack ?? error) }; }
    if (typeof app?.fetch !== "function") throw new Error(`Vite output has no default fetch(): ${cache}`);
    const env = { RECOOLER_SECRET: scenario.ts?.htmxOptions?.secret ?? 'conformance-test-secret' };
    const clientChunks = JSON.parse(await readFile(path.join(cache, "client-chunks.json"), "utf8")) as Record<string, string>;
    return { kind: "app", clientChunks, fetch: request => app.fetch(request, env), hono: app, env };
  },
};
