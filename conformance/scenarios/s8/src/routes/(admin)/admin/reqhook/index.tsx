export const onRequest = async (c: any, next: any) => { (globalThis.__t ??= []).push("onRequest reqhook user=" + c.get("user")); await next(); };
export default function P(props: any) { return <p>reqhook-page user={String(props.ctx.get("user"))}</p>; }
