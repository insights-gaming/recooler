export default function P(props: any) { return <div><p>admin-page user={String(props.ctx.get("user"))}</p><button hx-post={(ctx: any) => "page-action user=" + ctx.get("user")}>a</button></div>; }
export const onPut = (c: any) => c.text("onPut user=" + c.get("user"));
