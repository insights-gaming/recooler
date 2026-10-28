import type { Handler, MiddlewareHandler } from 'hono';
import type { HonoOptions } from 'hono/hono-base';

export type ModuleNs = Record<string, unknown>;
export interface Manifest {
  version: 1;
  root?: ModuleNs;
  tree: DirNode;
}
export interface DirNode {
  segment: string;
  path: string;
  group: boolean;
  layout?: ModuleNs;
  /** Optional source metadata used in diagnostics. */
  layoutFile?: string;
  middleware: ModuleNs[];
  middlewareFiles?: string[];
  route?: { file: string; module: ModuleNs };
  children: DirNode[];
}
export interface ResolvedMiddleware {
  path: string;
  file: string;
  module: ModuleNs;
  handler: MiddlewareHandler;
}
export interface ResolvedRoute {
  path: string;
  file: string;
  module: ModuleNs;
  /** Layouts in outermost-to-innermost order, including head-only layouts. */
  layouts: ModuleNs[];
  root?: ModuleNs;
  middleware: MiddlewareHandler[];
  /** Parallel to middleware; identity is the namespace, never the default function. */
  middlewareModules: ModuleNs[];
  directory: string;
}
export interface RoutePlan {
  routes: ResolvedRoute[];
  middlewares: ResolvedMiddleware[];
  lateMiddlewares: ResolvedMiddleware[];
  errors: string[];
  warnings: string[];
}
export interface RouterExtension {
  name: string;
  route?(route: ResolvedRoute): {
    methods?: string[];
    handlers?: Handler[];
    page?: Record<string, unknown>;
  } | void;
}
export interface PageAdapter {
  /** Extras retain extension order. See mergePageExtras for the standard merge rule. */
  handler(route: ResolvedRoute, extras: Record<string, unknown>[]): Handler | undefined;
}
export interface CreateAppOptions {
  pages?: PageAdapter;
  extensions?: RouterExtension[];
  hono?: HonoOptions<import('hono').Env>;
  /** Defaults to console.warn. */
  warn?: (message: string) => void;
}
