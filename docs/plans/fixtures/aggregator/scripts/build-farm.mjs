import { build } from "@farmfe/core";
await build({ mode: process.argv[3] ?? "production",
  root: process.argv[2],
  compilation: {
    input: { main: "./src/entry.js" },
    output: { path: "build", format: "esm", targetEnv: "library", filename: "[resourceName].[ext]" },
    partialBundling: { enforceResources: [{ name: "main", test: [".+"] }] },
    minify: false, sourcemap: false, persistentCache: false,
  },
});
