import type { Env, Handler, MiddlewareHandler } from 'hono';
import type { HonoOptions } from 'hono/hono-base';

export type ModuleNs = Record<string, unknown>;
export interface Manifest {
  version: 1;
  root?: ModuleNs;
  rootFile?: string;
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
  /** Source ids parallel to layouts; absent for hand-written metadata-free manifests. */
  layoutFiles: (string | undefined)[];
  root?: ModuleNs;
  rootFile?: string;
  middleware: MiddlewareHandler[];
  /** Parallel to middleware; identity is the namespace, never the default function. */
  middlewareModules: ModuleNs[];
  middlewareFiles: string[];
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
    /** Array handlers run only for methods; map keys also declare methods. */
    handlers?: Handler[] | Record<string, Handler[]>;
    page?: Record<string, unknown>;
  } | void;
}
export interface PageContribution {
  extension: string;
  page: Record<string, unknown>;
}
export interface PageAdapter {
  /** Extras retain extension order. See mergePageExtras for the standard merge rule. */
  handler(route: ResolvedRoute, extras: Record<string, unknown>[], contributions: PageContribution[]): Handler | undefined;
}
export interface CreateAppOptions<E extends Env = Env> {
  pages?: PageAdapter;
  extensions?: RouterExtension[];
  hono?: HonoOptions<E>;
  /** Defaults to console.warn. */
  warn?: (message: string) => void;
}
