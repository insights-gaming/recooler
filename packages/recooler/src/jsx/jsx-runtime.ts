/// <reference types="easy-jsx-html-engine/jsx-runtime" preserve="true" />
import { Context } from 'hono';
import { createElement, Fragment } from 'easy-jsx-html-engine';
import type { Children, Component } from './types.js';

declare global {
  namespace JSX {
    interface HtmlGlobalAttributes {
      ctx?: Context;
    }
  }
}

/** Components retain Context props. Intrinsics omit Context values under any key. */
export function jsx(name: string | Component<any>, props: Record<string, unknown>, _key?: unknown): JSX.Element {
  // Keep automatic-runtime component props intact (including children). Using the
  // engine's public createElement avoids a runtime import cycle when applications
  // alias the engine's automatic runtimes to these wrappers for precompiled deps.
  if (typeof name !== 'string') return createElement(() => name(props), {});
  const { children, ...attrs } = props ?? {};
  const filtered = Object.fromEntries(Object.entries(attrs).filter(([, value]) => !(value instanceof Context)));
  return createElement(name, filtered, ...(!children ? [] : Array.isArray(children) ? children : [children]) as Children[]);
}

export function jsxDEV(name: string | Component<any>, props: Record<string, unknown>, key?: unknown,
  _isStaticChildren?: boolean, _source?: unknown, _self?: unknown): JSX.Element {
  return jsx(name, props, key);
}

export { jsx as jsxs, Fragment };
