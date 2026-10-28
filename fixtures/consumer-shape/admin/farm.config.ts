import { defineConfig } from "@farmfe/core";
import recooler from "farm-plugin-recooler";
import { resolve } from "node:path";

export default defineConfig({
  compilation: {
    external: ["^cloudflare:"],
    input: { main: "src/main.ts" },
    output: { path: "dist", format: "esm", targetEnv: "library", filename: "[resourceName].[ext]" },
    partialBundling: { enforceResources: [{ name: "main", test: [".+"] }] },
    persistentCache: false,
    minify: false,
    sourcemap: false,
    progress: false,
  },
  plugins: [{
    name: "fixture-css-string", priority: 110,
    load: { filters: { resolvedPaths: ["\\.css$"] }, async executor({ resolvedPath }: any) {
      const { readFile } = await import("node:fs/promises");
      return { content: `export default ${JSON.stringify(await readFile(resolvedPath, "utf8"))};`, moduleType: "js" };
    } },
  },
    ["@farmfe/plugin-react", {
      runtime: "automatic", importSource: "easy-jsx-html-engine", useBuiltins: true,
      throwIfNamespace: false, refresh: false, development: false,
    }],
    recooler({
      route_handler_factory: resolve("src/handler.ts"),
      client_banned_imports: ["^cloudflare:", "(^|/)hono(/|$)", "(^|/)easy-jsx-html-engine(/|$)", "/lib/server-only"],
    }),
  ],
});
