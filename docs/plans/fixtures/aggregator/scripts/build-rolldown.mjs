// Builds the fixture with Rolldown and prints what the aggregator collected.
// Usage: node scripts/build-rolldown.mjs <fixture root>
import { readFileSync } from "node:fs";
import { rolldown } from "rolldown";

const root = process.argv[2];
const bundle = await rolldown({ input: `${root}/src/entry.js`, logLevel: "silent" });
await bundle.write({ file: `${root}/build/main.mjs`, format: "esm" });

const m = await import(`${root}/build/main.mjs`);
const code = readFileSync(`${root}/build/main.mjs`, "utf8");
console.log(JSON.stringify({
  order: m.result.order,
  actions: Object.keys(m.result.table),
  missing: m.missing,
  clientOnlyEvaluated: !!globalThis.__CLIENT_ONLY_EVALUATED,
  handlerKept: code.includes("clientOnly()"),
}));
