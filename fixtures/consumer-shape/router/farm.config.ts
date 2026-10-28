import { defineConfig } from "@farmfe/core";
import recooler from "farm-plugin-recooler";

export default defineConfig({
  compilation: {
    input: { main: "src/main.ts" },
    output: { path: "dist", format: "esm", targetEnv: "library", filename: "[resourceName].[ext]" },
    partialBundling: { enforceResources: [{ name: "main", test: [".+"] }] },
    persistentCache: false,
    minify: false,
    sourcemap: false,
    progress: false,
  },
  plugins: [
    ["@farmfe/plugin-react", {
      runtime: "automatic", importSource: "easy-jsx-html-engine", useBuiltins: true,
      throwIfNamespace: false, refresh: false, development: false,
    }],
    recooler({}),
  ],
});
