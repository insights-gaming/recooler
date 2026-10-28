/** Targets build and run in this process/realm for globalThis.__t instrumentation.
 * Remote runtimes (including workerd) cannot implement this trace contract. */
export interface BuiltApp {
  kind: "app";
  /** Emitted browser chunks only, including lazy handler chunks; never server output. */
  clientChunks?: Record<string, string>;
  fetch(request: Request): Response | Promise<Response>;
  /** Optional route table used to exercise Hono's route()/basePath() mounts. */
  hono?: import("hono").Hono;
}

export type BuildResult = BuiltApp | { kind: "buildError"; error: string };

export interface Target {
  name: string;
  /** Select TS expectations independently of the display/version name. */
  expectationFamily?: "ts";
  /** Return a skip reason when the implementation is not installed/built yet. */
  unavailable?(): Promise<string | undefined>;
  build(scenarioDir: string, scenario: Scenario): Promise<BuildResult>;
}

export interface Expectation {
  status: number;
  body?: string;
  includes?: string[];
  excludes?: string[];
  matches?: string[];
  counts?: Record<string, number>;
  headers?: Record<string, string | null>;
  trace?: string[];
  traceExcludes?: string[];
  /** Inspect all emitted browser chunks (requires BuiltApp.clientChunks). */
  clientExcludes?: string[];
}

export interface IntentionalChange {
  decision: `D${number}` | "head-isolation" | "transform";
  reason: string;
  /** Optional replacement expectation; an annotation alone changes no assertion. */
  ts?: Expectation;
}

export interface ScenarioRequest {
  name: string;
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  /** Explicitly omit automatic action security headers for negative probes. */
  omitHeaders?: string[];
  form?: Record<string, string>;
  body?: string;
  /** Render a page and read the URL from the selected attribute. Never guess action IDs. */
  action?: {
    page: string;
    /** Keep the rendered query, but send it to another path (foreign-action probes). */
    path?: string;
    attribute: string;
    index?: number;
    headers?: Record<string, string>;
    /** Extract from a previous request's response (for actions returning nested forms). */
    response?: string;
  };
  mount?: { type: "route" | "basePath" | "mount"; prefix: string; outerPrefix?: string; retry?: boolean };
  /** Dispatch the exact same Request instance repeatedly. */
  repeat?: number;
  /** Expected results after the first dispatch, when retry outcomes differ. */
  repeatExpect?: Expectation[];
  expect: Expectation;
  changes?: IntentionalChange[];
}

export interface Scenario {
  name: string;
  source: string;
  requests?: ScenarioRequest[];
  buildError?: string | string[];
  changes?: Omit<IntentionalChange, "ts">[];
  /** Target names or expectation families that should execute this scenario. */
  targets?: string[];
  /** Per-target complete diagnostic override; startup validation also returns buildError. */
  buildErrors?: Record<string, string | string[]>;
  /** Plugin-specific build settings belong in the adapter, not in fixture sources. */
  farm?: Record<string, unknown>;
}
