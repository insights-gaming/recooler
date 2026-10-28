import type { RouteContext } from './index.js';
import type { Children } from './types.js';

/** Server callback before the htmx transform replaces it with a signed URL. */
export interface FormActionFn<TPayload = Record<string, any> & { __formData: FormData }, TContext = RouteContext> {
  (ctx: TContext, payload: TPayload): Children | Response | void | PromiseLike<Children | Response | void>;
}
export interface EventHandlerFn<TElement extends Element = any, TEvent extends Event = any> {
  (this: TElement, event: TEvent): any;
}
declare global {
  namespace JSX {
    interface HtmlGlobalAttributes {
      'hx-get'?: FormActionFn<any> | string;
      'hx-post'?: FormActionFn<any> | string;
      'hx-put'?: FormActionFn<any> | string;
      'hx-patch'?: FormActionFn<any> | string;
      'hx-delete'?: FormActionFn<any> | string;
      [event: `hx-on:${string}`]: EventHandlerFn | string;
      [event: `hx-on-${string}`]: EventHandlerFn | string;
    }
  }
}
