export default function P(props: any) { return <p>admin-posts-new</p>; }
export const onRequest = async (c: any, next: any) => { (globalThis.__t ??= []).push("onRequest admin-posts-new user=" + c.get("user")); await next(); };
