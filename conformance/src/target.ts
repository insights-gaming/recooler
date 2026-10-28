/** A target only builds source trees; request/expectation handling stays target independent. */
export interface BuiltApp {
  kind: "app";
  fetch(request: Request): Response | Promise<Response>;
  /** Optional route table used to exercise Hono's route()/basePath() mounts. */
  hono?: import("hono").Hono;
}

export type BuildResult = BuiltApp | { kind: "buildError"; error: string };

export interface Target {
  name: string;
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
  form?: Record<string, string>;
  body?: string;
  /** Render a page and read the URL from the selected attribute. Never guess action IDs. */
  action?: {
    page: string;
    attribute: string;
    index?: number;
    headers?: Record<string, string>;
    /** Extract from a previous request's response (for actions returning nested forms). */
    response?: string;
  };
  mount?: { type: "route" | "basePath" | "mount"; prefix: string };
  /** Dispatch the exact same Request instance repeatedly. */
  repeat?: number;
  expect: Expectation;
  changes?: IntentionalChange[];
}

export interface Scenario {
  name: string;
  source: string;
  requests?: ScenarioRequest[];
  buildError?: string | string[];
  changes?: IntentionalChange[];
  /** Plugin-specific build settings belong in the adapter, not in fixture sources. */
  farm?: Record<string, unknown>;
}
