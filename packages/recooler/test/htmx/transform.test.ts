import { describe, expect, it } from "vitest";
import { parseSync } from "oxc-parser";
import { transform } from "../../src/htmx/transform/index.js";

const options = { id: "src/routes/index.tsx", relativePath: "src/routes/index.tsx", moduleKind: "route" as const };
describe("transform", () => {
  for (const mode of ["full", "server", "client-slice"] as const) it(`hoists captures, nested actions and handlers: ${mode}`, () => {
    const input = `import { browser, unused } from './browser';
      import { db } from './db';
      export default function Page({ count }: Props) {
        return <form ctx={request} hx-post={(ctx) => <button hx-post={() => db(count)} hx-on:click={() => browser(count)} />} />;
      }`;
    const result = transform(input, { ...options, mode });
    expect(result.diagnostics).toEqual([]);
    expect(result.actions.map(a => [a.id, a.captures])).toEqual([
      ["src/routes/index.tsx@0", ["count"]], ["src/routes/index.tsx@1", ["count"]],
    ]);
    expect(result.handlers[0]?.captures).toEqual(["count"]);
    expect(parseSync(options.id, result.code).errors, result.code).toEqual([]);
    if (mode === "server") {
      expect(result.code).not.toContain("export const _handler$");
      expect(result.code).not.toContain("from './browser'");
    } else expect(result.code).toContain("export const _handler$0");
    if (mode === "client-slice") {
      expect(result.code).not.toContain("./db");
      expect(result.code).not.toContain("_action$");
      expect(result.code).not.toContain("recooler/htmx/runtime");
      expect(result.code).toContain('globalThis.$handlers');
    } else {
      expect(result.code).toContain("registerActions");
      expect(result.code).toContain("actionUrl");
    }
  });

  it("returns build errors without partial edits", () => {
    const input = `function C({n}) { const local = () => n; return <i hx-post={() => local()} />; }`;
    const result = transform(input, options);
    expect(result.diagnostics[0]?.message).toContain("local function `local`");
    expect(result.code).toBe(input);
  });
});
