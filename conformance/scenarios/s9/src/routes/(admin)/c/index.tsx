export const onRequest = async (c: any, next: any) => { (globalThis.__t ??= []).push("c onRequest user=" + c.get("user")); await next(); };
export default function P(props: any) { return <p>c</p>; }
