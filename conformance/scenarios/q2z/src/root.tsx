import { DefaultRootHOC } from "farm-plugin-recooler/helpers";
export default function Root(Content: any, script?: string) { const Inner = DefaultRootHOC(Content, script); return (props: any) => <div><Inner {...props} /><form hx-post={async () => <p>root-action</p>}><button>r</button></form></div>; }
