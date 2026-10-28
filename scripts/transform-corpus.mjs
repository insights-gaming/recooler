#!/usr/bin/env node
// Build the package first. Reads sources only; redirect JSON outside the repo.
import { readdir, readFile } from "node:fs/promises";
import { resolve, relative, basename } from "node:path";
import { createRequire } from "node:module";
import { transform } from "../dist/htmx/transform/index.js";
const require = createRequire(new URL("../package.json", import.meta.url));
const { parseSync } = require("oxc-parser");
const dirs = process.argv.slice(2);
if (!dirs.length) throw new Error("Usage: node scripts/transform-corpus.mjs <dir> [<dir> ...]");
const modes = ["full", "server", "client-slice"];
const results = [], summary = {};
for (const mode of modes) summary[mode] = { modules: 0, diagnostics: {}, diagnosticModules: {}, actionInClientSlice: 0, parseFailures: 0, totalMs: 0, maxMs: 0 };
for (const dir of dirs) {
  const root = resolve(dir);
  const files = (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter(f => f.isFile() && /\.tsx?$/.test(f.name))
    .map(f => resolve(f.parentPath, f.name)).sort();
  for (const id of files) {
    const source = await readFile(id, "utf8");
    const relativePath = relative(root, id).replaceAll("\\", "/");
    const name = basename(id);
    const moduleKind = /^index\.tsx?$/.test(name) ? "route" : /^layout\.tsx?$/.test(name) ? "layout" : /^root\.tsx?$/.test(name) ? "root" : "component";
    for (const mode of modes) {
      const start = performance.now();
      const result = transform(source, { id, relativePath, mode, moduleKind });
      const elapsedMs = performance.now() - start;
      const parseErrors = parseSync(id, result.code, { astType: "ts" }).errors.map(e => e.message);
      const s = summary[mode];
      s.modules++; s.totalMs += elapsedMs; s.maxMs = Math.max(s.maxMs, elapsedMs);
      for (const kind of new Set(result.diagnostics.map(d => d.code))) s.diagnosticModules[kind] = (s.diagnosticModules[kind] ?? 0) + 1;
      for (const d of result.diagnostics) s.diagnostics[d.code] = (s.diagnostics[d.code] ?? 0) + 1;
      if (result.diagnostics.some(d => d.code === "action-in-client-slice")) s.actionInClientSlice++;
      if (parseErrors.length) s.parseFailures++;
      results.push({ root, file: relativePath, mode, elapsedMs, diagnostics: result.diagnostics, parseErrors });
    }
  }
}
console.log(JSON.stringify({ summary, results }, null, 2));
