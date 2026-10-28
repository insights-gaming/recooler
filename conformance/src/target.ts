/** Targets run in this process/realm for globalThis.__t instrumentation.
 * Each scenario must be a self-contained build, with no shared application or
 * dependency module state across scenarios (for example a Vite SSR build with
 * ssr.noExternal: true into a per-scenario directory). A query on only the entry
 * module does not isolate its unbundled dependencies.
 * The TS adapter must build both server and client with Vite for htmx/D4 probes.
 * Remote runtimes (including workerd) cannot implement this trace contract. */
export interface BuiltApp {
  kind: "app";
  /** Emitted browser chunks keyed by served URL, including the entry and lazy
   * handler chunks; never server output. Include them even on handler-free pages. */
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
  /** Explicit unsupported-feature skip; always surfaced in the suite name. */
  skipReason?(scenarioDir: string, scenario: Scenario): Promise<string | undefined>;
  requestSkipReason?(request: ScenarioRequest): string | undefined;
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
  clientIncludes?: string[];
  /** No script element may inline these handler-code markers. */
  inlineScriptExcludes?: string[];
  /** No script src may refer to a client chunk supplied by the target. */
  noClientEntry?: boolean;
}

export interface IntentionalChange {
  decision: `D${number}` | "head-isolation" | "transform";
  reason: string;
  /** Optional replacement expectation; an annotation alone changes no assertion. */
  ts?: Expectation;
}

export interface ScenarioRequest {
  /** Checks that require action dispatch or emitted browser chunks. */
  requires?: "htmx"[];
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
    /** Correct the oracle's unprefixed mount URL without masking TS URL generation. */
    oraclePath?: string;
    /** Mutate an extracted URL; method sends POST as GET (or another method as POST). */
    tamper?: "drop-sig" | "flip-sig" | "method" | "scope";
    attribute: string;
    index?: number;
    headers?: Record<string, string>;
    /** Extract from a previous request's response (for actions returning nested forms). */
    response?: string;
  };
  mount?: { type: "route" | "basePath" | "mount"; prefix: string; also?: string; retry?: boolean };
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
  ts?: { htmxOptions?: { base?: string; secret?: string | false } };
}
