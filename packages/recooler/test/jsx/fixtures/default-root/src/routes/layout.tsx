import type { Component } from 'easy-jsx-html-engine';
import type { RouteProps } from '../../../../../../src/jsx/index.js';
export const head = { title: 'layout', metas: [{ name: 'outer', content: 'yes' }] };
export default function Layout(Page: Component<RouteProps>) {
  return (props: RouteProps) => <main data-layout="outer"><Page {...props} /></main>;
}
