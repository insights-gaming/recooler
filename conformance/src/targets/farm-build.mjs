// A separate process contains native panics/ABI failures and Farm's process-global state.
import { build } from "@farmfe/core";
import recooler from "farm-recooler-oracle";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = process.argv[2];
const options = JSON.parse(await readFile(path.join(root, "options.json"), "utf8"));
try {
  await build({
    root,
    mode: "production",
    compilation: {
      input: { main: "recooler::app" },
      output: { path: "dist", format: "esm", targetEnv: "library", filename: "[resourceName].[ext]" },
      resolve: { alias: { "farm-plugin-recooler/helpers": require.resolve("farm-recooler-oracle/helpers") } },
      partialBundling: { enforceResources: [{ name: "main", test: [".+"] }] },
      minify: false,
      sourcemap: false,
      persistentCache: false,
      progress: false,
      // Do not enable decorators: the published plugin has a host ABI incompatibility.
    },
    plugins: [
      [require.resolve("@farmfe/plugin-react"), {
        runtime: "automatic", importSource: "easy-jsx-html-engine", useBuiltins: true,
        throwIfNamespace: false, refresh: false, development: false,
      }],
      recooler(options),
    ],
  });
  await writeFile(path.join(root, "result.json"), JSON.stringify({ ok: true }));
} catch (error) {
  await writeFile(path.join(root, "result.json"), JSON.stringify({ ok: false, error: String(error?.stack ?? error) }));
  process.exitCode = 1;
}
