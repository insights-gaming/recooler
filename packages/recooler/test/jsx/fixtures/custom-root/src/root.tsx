import { dangerouslyPreventEscaping } from 'easy-jsx-html-engine';
import type { Component } from 'easy-jsx-html-engine';
import type { RouteProps } from '../../../../../src/jsx/index.js';
export const head = { title: 'root', metas: [{ charset: 'utf-8' }] };
export default function Root(Page: Component<RouteProps>, clientScript?: string) {
  return (props: RouteProps) => <html lang="en"><head><meta charset="utf-8" /><title>{props.head.title}</title></head><body><div id="app"><Page {...props} /></div>{clientScript && <script>{dangerouslyPreventEscaping(`(()=>{${clientScript}})()`)}</script>}</body></html>;
}
