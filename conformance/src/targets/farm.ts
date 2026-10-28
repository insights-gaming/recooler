import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, mkdir, cp, symlink, writeFile, access, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import type { BuildResult, Scenario, Target } from "../target.js";

const execute = promisify(execFile);
let importGeneration = 0;
const packageDir = fileURLToPath(new URL("../../", import.meta.url));
const builder = fileURLToPath(new URL("./farm-build.mjs", import.meta.url));
// This is already a bundled ESM app; no application-source transforms are needed.
const nativeImport = (url: string): Promise<{ default: { fetch: (req: Request) => Response | Promise<Response> } }> => import(/* @vite-ignore */ url);

export async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map(async (entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  }));
  return files.flat();
}

export const farmTarget: Target = {
  name: "farm-0.0.27",
  async build(scenarioDir: string, scenario: Scenario): Promise<BuildResult> {
    const hash = createHash("sha256");
    hash.update(`farm-0.0.27/core-1.7.11/${process.version}/${process.platform}/${process.arch}`);
    hash.update(new Uint8Array(await readFile(builder)));
    hash.update(new Uint8Array(await readFile(new URL(import.meta.url))));
    hash.update(new Uint8Array(await readFile(path.join(packageDir, "../pnpm-lock.yaml"))));
    const options = scenario.farm ?? {};
    hash.update(JSON.stringify(options));
    const src = path.join(scenarioDir, "src");
    for (const file of await filesUnder(src)) {
      hash.update(path.relative(src, file));
      hash.update("\0");
      hash.update(new Uint8Array(await readFile(file)));
      hash.update("\0");
    }
    // Keep builds under the installed workspace: Farm's native resolver does not
    // consistently follow node_modules links when the build root is outside it.
    const cache = path.join(packageDir, ".cache", hash.digest("hex"));
    const resultPath = path.join(cache, "result.json");
    let cached = true;
    try { await access(resultPath); } catch { cached = false; }
    if (!cached || process.env.CONFORMANCE_REBUILD === "1") {
      await rm(cache, { recursive: true, force: true });
      await mkdir(cache, { recursive: true });
      await cp(src, path.join(cache, "src"), { recursive: true });
      await symlink(path.join(packageDir, "node_modules"), path.join(cache, "node_modules"), "dir");
      await writeFile(path.join(cache, "package.json"), '{"type":"module"}\n');
      await writeFile(path.join(cache, "options.json"), JSON.stringify(options));
      let logs: string;
      try {
        const result = await execute(process.execPath, [builder, cache], { cwd: cache, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
        logs = result.stdout + result.stderr;
      } catch (error) {
        const failure = error as Error & { stdout?: string; stderr?: string; signal?: string };
        logs = (failure.stdout ?? "") + (failure.stderr ?? "") + "\n" + failure.message;
        // A native crash/timeout is an infrastructure failure, never an expected build error.
        if (failure.signal) throw new Error(`Farm infrastructure failure (${failure.signal}) for ${scenarioDir}:\n${logs}`);
      }
      await writeFile(path.join(cache, "build.log"), logs);
      // No result means the compiler exited outside its normal error path.
      await access(resultPath);
    }
    const result = JSON.parse(await readFile(resultPath, "utf8")) as { ok: boolean; error?: string };
    if (!result.ok) {
      return { kind: "buildError", error: (result.error ?? "") + "\n" + await readFile(path.join(cache, "build.log"), "utf8") };
    }
    delete (globalThis as { SUSPENSE_ROOT?: unknown }).SUSPENSE_ROOT;
    const { default: app } = await nativeImport(pathToFileURL(path.join(cache, "dist/main.js")).href + "?scenario=" + encodeURIComponent(scenarioDir) + "&instance=" + importGeneration++);
    if (typeof app?.fetch !== "function") throw new Error(`Farm output has no default fetch(): ${cache}`);
    return { kind: "app", fetch: app.fetch.bind(app), hono: app as unknown as import("hono").Hono };
  },
};
