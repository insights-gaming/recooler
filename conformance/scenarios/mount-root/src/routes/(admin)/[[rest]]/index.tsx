export default function P(props: any) { return <div><p>admin-rest</p><button hx-post={() => { (globalThis.__t ??= []).push("action admin-rest"); return "action admin-rest"; }}>x</button></div>; }
export const onPost = (c: any) => c.text("onPost admin-rest");
