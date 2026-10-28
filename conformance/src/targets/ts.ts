import type { BuildResult, Scenario, Target } from "../target.js";
import { access, cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
  if (name === "recooler/jsx") return {};
  return import(/* @vite-ignore */ entry);
};

/** Missing public entrypoints mean "not built". Missing transitive dependencies,
 * evaluation errors and invalid exports mean a broken build and must fail. */
export async function tsUnavailable(load = importModule): Promise<string | undefined> {
  for (const name of ["recooler/router", "recooler/jsx", "recooler/vite"]) {
    let module: Record<string, unknown>;
    try {
      module = await load(name);
    } catch (error) {
      const failure = error as { code?: string; url?: string; message?: string };
      if (failure.code === "ERR_MODULE_NOT_FOUND") {
        let entry: string | undefined;
        try { entry = import.meta.resolve(name); } catch { /* package itself may be absent */ }
        if ((entry && failure.url === entry) || failure.message?.startsWith("Cannot find package 'recooler'")) {
          return `${name} is not built yet`;
        }
      }
      throw error;
    }
    if (name === "recooler/router" && typeof module.createApp !== "function") {
      throw new Error("Broken recooler/router build: must export createApp");
    }
  }
  return undefined;
}

const packageDir = fileURLToPath(new URL("../../", import.meta.url));
const implementation = path.join(packageDir, "../packages/recooler/dist");
const builder = fileURLToPath(new URL("./ts-build.mjs", import.meta.url));
const execute = promisify(execFile);
let importGeneration = 0;

/** Feature detection keeps mixed routing/action fixtures honest until htmx is
 * available. Do not turn an unimplemented feature into a successful response. */
export async function tsSkipReason(dir: string, scenario: Scenario): Promise<string | undefined> {
  const expectations = (scenario.requests ?? []).flatMap(request => [request.expect, ...(request.repeatExpect ?? []), ...(request.changes ?? []).flatMap(c => c.ts ? [c.ts] : [])]);
  if (scenario.ts?.htmxOptions || scenario.requests?.some(r => r.action || /[?&]action=/.test(r.path ?? ""))) {
    return "htmx actions, signing and CSRF are not implemented yet";
  }
  if (expectations.some(e => e.clientIncludes || e.clientExcludes || e.noClientEntry || e.inlineScriptExcludes)) {
    return "htmx client chunks are not implemented yet";
  }
  for (const file of await filesUnder(path.join(dir, "src"))) {
    const source = await readFile(file, "utf8");
    if (/\b(?:data-)?hx-(?:get|post|put|patch|delete|on(?:[:-][\w-]+)?)(?=[\s"\x27=\]:])|\b(?:onLoad|wrapAction|actionScope|handlerScope)\b/.test(source)) {
      return "htmx form actions and event handlers are not implemented yet";
    }
  }
}

/** Deterministic location for build bytes and diagnostics, also used by cache verification. */
export async function tsCacheDirectory(scenarioDir: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(`ts/vite-8.3.5/${process.version}/${process.platform}/${process.arch}`);
  for (const file of [builder, fileURLToPath(import.meta.url), path.join(packageDir, "../pnpm-lock.yaml"), path.join(packageDir, "tsconfig.json"), ...await filesUnder(implementation)]) {
    hash.update(path.relative(packageDir, file));
    hash.update(new Uint8Array(await readFile(file)));
    hash.update("\0");
  }
  const src = path.join(scenarioDir, "src");
  for (const file of await filesUnder(src)) {
    hash.update(path.relative(src, file));
    hash.update("\0");
    hash.update(new Uint8Array(await readFile(file)));
    hash.update("\0");
  }
  return path.join(packageDir, ".cache", "ts-" + hash.digest("hex"));
}

export const tsTarget: Target = {
  name: "ts",
  expectationFamily: "ts",
  unavailable: tsUnavailable,
  skipReason: tsSkipReason,
  async build(scenarioDir: string): Promise<BuildResult> {
    const src = path.join(scenarioDir, "src");
    const cache = await tsCacheDirectory(scenarioDir);
    const resultPath = path.join(cache, "result.json");
    let cached = true;
    try { await access(resultPath); } catch { cached = false; }
    if (!cached || process.env.CONFORMANCE_REBUILD === "1") {
      await rm(cache, { recursive: true, force: true });
      await mkdir(cache, { recursive: true });
      await cp(src, path.join(cache, "src"), { recursive: true });
      await symlink(path.join(packageDir, "node_modules"), path.join(cache, "node_modules"), "dir");
      await writeFile(path.join(cache, "package.json"), '{"type":"module"}\n');
      let logs: string;
      try {
        const result = await execute(process.execPath, [builder, cache], { cwd: cache, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
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
      // inlineDynamicImports + noExternal:true isolates all dependency state,
      // including when identical sources reuse cached bytes or are rebuilt.
      const url = pathToFileURL(path.join(cache, "dist/app.mjs")).href;
      const module = await import(/* @vite-ignore */ `${url}?scenario=${encodeURIComponent(scenarioDir)}&instance=${importGeneration++}`);
      app = module.default;
    } catch (error) { return { kind: "buildError", error: String((error as Error).stack ?? error) }; }
    if (typeof app?.fetch !== "function") throw new Error(`Vite output has no default fetch(): ${cache}`);
    return { kind: "app", fetch: app.fetch.bind(app), hono: app };
  },
};
