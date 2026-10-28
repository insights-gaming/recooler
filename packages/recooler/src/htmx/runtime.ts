/** Compile-time contract for the htmx runtime worker. No runtime is implemented here.
 * Scope objects use the original binding names as keys, even when codegen renames locals.
 */
export interface HtmxTransformRuntime {
  actionUrl(id: string, scope: Record<string, unknown>, context?: unknown): string;
  registerActions(moduleId: string, actions: Record<string, Record<string, unknown>>): void;
  wrapAction(actionOrFactory: unknown, scopedId?: string): unknown;
  wrapActionWithPayload(actionOrFactory: unknown, scopedId?: string): unknown;
  actionScope(id: string, scope: Record<string, unknown>): string;
  handlerScope(scope: Record<string, unknown>): string;
}

// Declaration-only exports intentionally provide types, not a placeholder implementation
// that silently accepts requests. The runtime worker must supply these before execution.
export declare const actionUrl: HtmxTransformRuntime["actionUrl"];
export declare const registerActions: HtmxTransformRuntime["registerActions"];
export declare const wrapAction: HtmxTransformRuntime["wrapAction"];
export declare const wrapActionWithPayload: HtmxTransformRuntime["wrapActionWithPayload"];
export declare const actionScope: HtmxTransformRuntime["actionScope"];
export declare const handlerScope: HtmxTransformRuntime["handlerScope"];
