import type { SourceMap } from "magic-string";
import type { ArrowFunctionExpression, Function as OxcFunction } from "oxc-parser";
import type { Node, Span, Variable } from "./analysis.js";

export type TransformMode = "full" | "server" | "client-slice";
export type ActionMethod = "get" | "post" | "put" | "patch" | "delete";
export interface Diagnostic {
  severity: "error" | "warning";
  code: string;
  message: string;
  start: number;
  end: number;
}
export interface HoistedFunction extends Span {
  id: string;
  exportName: string;
  captures: string[];
}
export interface Action extends HoistedFunction { method: ActionMethod }
export interface Handler extends HoistedFunction {}
export interface ActionUrlEmission {
  id: string;
  /** Object expression with evaluated capture values; never a serialized query string. */
  scope: string;
  /** Explicit element/object ctx, enclosing action ctx, or component props.ctx. */
  context?: string;
  /** Collision-free local identifier for the runtime's actionUrl export. */
  helper: string;
}
export interface RegistrationEmission {
  moduleId: string;
  actions: readonly Action[];
  helper: string;
}
export interface TransformOptions {
  id: string;
  /** Project-relative module path, exactly as used by the 0.0.27 ID generator. */
  relativePath: string;
  mode?: TransformMode;
  /** onLoad is kept only for route modules; layouts/root receive a warning. */
  moduleKind?: "route" | "layout" | "root" | "component";
  /** Regular expressions matched against raw import specifiers, not resolved paths. */
  clientBannedImports?: readonly (RegExp | string)[];
  /** Retain the 0.0.27 first-props-parameter ctx override. Defaults to true.
   * Missing props/ctx falls back to the runtime's ambient context. */
  componentContext?: boolean;
  /** Disable raw transfer for testing or unsupported hosts. Default: capability checked. */
  rawTransfer?: boolean;
  codegen?: {
    actionUrl?: (input: ActionUrlEmission) => string;
    registerActions?: (input: RegistrationEmission) => string;
  };
}
export interface TransformResult {
  code: string;
  map: SourceMap;
  actions: Action[];
  handlers: Handler[];
  diagnostics: Diagnostic[];
}

export type FunctionNode = ArrowFunctionExpression | (OxcFunction & { type: "FunctionExpression" | "FunctionDeclaration" });
export interface Candidate extends HoistedFunction {
  kind: "action" | "handler";
  method?: ActionMethod;
  expression: Node;
  fn: FunctionNode;
  parent?: Candidate;
  component?: FunctionNode;
  explicitContext?: Node;
  variables: Variable[];
  aliases: Map<Variable, string>;
  context?: string;
  addContext?: string;
}
