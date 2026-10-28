import { DefaultRootHOC } from "farm-plugin-recooler/helpers";
export default function Root(Content, clientScript) { return DefaultRootHOC((props) => <div><Content {...props} /><button hx-post={() => "root action"}>r</button></div>, clientScript); }
