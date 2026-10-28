import type { Target } from "../target.js";

export const tsTarget: Target = {
  name: "ts",
  expectationFamily: "ts",
  async unavailable() {
    try {
      const moduleName = "recooler/router";
      const router: Record<string, unknown> = await import(/* @vite-ignore */ moduleName);
      if (typeof router.createApp !== "function") return "recooler/router does not export createApp yet";
    } catch { return "recooler/router is not built yet"; }
    return undefined;
  },
  async build() {
    throw new Error("The TS conformance adapter must be implemented now that recooler/router exists");
  },
};
