import { DefaultRootHOC } from "farm-plugin-recooler/helpers";
export default function Root(Content: any, s?: string) { return DefaultRootHOC((props: any) => <div><Content {...props} /><button hx-post={(ctx: any) => "root-action user=" + ctx.get("user")}>r</button></div>, s); }
