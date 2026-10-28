/// <reference types="easy-jsx-html-engine/jsx-runtime" preserve="true" />
import { createElement as engineCreateElement, Fragment } from 'easy-jsx-html-engine';
import type { Children, Component } from './types.js';

declare global {
  namespace JSX {
    interface HtmlGlobalAttributes {
      key?: unknown;
      ctx?: unknown;
    }
  }
}

/** A structural brand works across Hono copies without a Hono runtime import. */
function isContext(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const ctx = value as Record<string, any>;
  return typeof ctx.get === 'function' && typeof ctx.set === 'function'
    && typeof ctx.header === 'function' && typeof ctx.newResponse === 'function'
    && typeof ctx.req?.url === 'string' && typeof ctx.req?.method === 'string';
}

function filterAttributes(attrs: Record<string, unknown>): Record<string, unknown> {
  const confirm = Object.keys(attrs).find(key => /^(?:data-)?hx-on(?:::|--|:htmx:|-htmx-)confirm$/.test(key)
    && typeof attrs[key] === 'string' && (attrs[key] as string).startsWith('(self.$rc||'));
  if (confirm) {
    // htmx 1 installs legacy hx-on before synchronous load triggers, then
    // replaces it with the wildcard listener. htmx 2 ignores this alias.
    const early = 'htmx:confirm:eval(this.getAttribute(' + JSON.stringify(confirm) + '))';
    if (!(String(attrs['hx-on'] ?? '').split('\n').includes(early))) {
      attrs = { ...attrs, 'hx-on': (attrs['hx-on'] ? attrs['hx-on'] + '\n' : '') + early };
    }
  }
  return Object.fromEntries(Object.entries(attrs).filter(([attribute, value]) => {
    if (typeof value === 'function' && /^(?:data-)?hx-(?:(?:get|post|put|patch|delete)$|on)/i.test(attribute)) {
      throw new TypeError(`recooler: function-valued ${attribute} cannot be rendered; module was not transformed`);
    }
    return !isContext(value);
  }));
}

/** Classic JSX fallback used by transforms for a key following a spread. */
export function createElement(name: string | Component<any>, attrs: Record<string, any> = {}, ...children: Children[]): JSX.Element {
  return engineCreateElement(name, typeof name === 'string' ? filterAttributes(attrs) : attrs, ...children);
}

/** Components retain Context props. Intrinsics omit Context values under any key. */
export function jsx(name: string | Component<any>, props: Record<string, unknown>, _key?: unknown): JSX.Element {
  // Keep automatic-runtime component props intact (including children). Using the
  // engine's public createElement avoids a runtime import cycle when applications
  // alias the engine's automatic runtimes to these wrappers for precompiled deps.
  if (typeof name !== 'string') return createElement(() => name(props), {});
  const { children, ...attrs } = props ?? {};
  const filtered = filterAttributes(attrs);
  return createElement(name, filtered, ...(!children ? [] : Array.isArray(children) ? children : [children]) as Children[]);
}

export function jsxDEV(name: string | Component<any>, props: Record<string, unknown>, key?: unknown,
  _isStaticChildren?: boolean, _source?: unknown, _self?: unknown): JSX.Element {
  return jsx(name, props, key);
}

export { jsx as jsxs, Fragment };

export type { FormActionFn, EventHandlerFn } from './htmx-types.js';
