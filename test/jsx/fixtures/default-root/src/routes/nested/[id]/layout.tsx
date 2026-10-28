import type { Component } from 'easy-jsx-html-engine';
import type { RouteProps } from '../../../../../../../../src/jsx/index.js';
export default function Layout(Page: Component<RouteProps>) {
  return (props: RouteProps) => <section data-layout="inner"><Page {...props} /></section>;
}
