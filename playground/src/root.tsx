import htmxURL from "htmx.org/dist/htmx.min.js?url";
import type { Component } from "easy-jsx-html-engine";
import { DefaultRootHOC } from "@insights-gaming/recooler/jsx";

// declares its own charset, so DefaultRootHOC must not add a second one
export const head: RouteHead = { title: "Recooler", scripts: [{ src: htmxURL }], metas: [{ charset: "utf-8" }] };

export default function Root(Content: Component<RouteProps>, clientScript?: string) {
  return DefaultRootHOC(
    (props: RouteProps) => (
      <div id="app">
        <Content {...props} />
      </div>
    ),
    clientScript,
  );
}
