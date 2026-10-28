import type { Target } from "../target.js";

const importModule = (name: string): Promise<Record<string, unknown>> => import(/* @vite-ignore */ name);

/** Missing public entrypoints mean "not built". Missing transitive dependencies,
 * evaluation errors and invalid exports mean a broken build and must fail. */
export async function tsUnavailable(load = importModule): Promise<string | undefined> {
  for (const name of ["recooler/router", "recooler/jsx", "recooler/htmx", "recooler/vite"]) {
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

export const tsTarget: Target = {
  name: "ts",
  expectationFamily: "ts",
  unavailable: tsUnavailable,
  async build() {
    throw new Error("The TS conformance adapter must be implemented now that recooler/router exists");
  },
};
