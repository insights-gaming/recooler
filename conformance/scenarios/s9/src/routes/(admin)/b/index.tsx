export default function P(props: any) { return <div><p>b</p><button hx-post={(ctx: any) => { (globalThis.__t ??= []).push("action b"); return "b-action user=" + ctx.get("user"); }}>b</button></div>; }
export const onPost = (c: any) => c.text("b onPost user=" + c.get("user"));
