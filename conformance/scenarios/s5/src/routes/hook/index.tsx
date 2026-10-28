export default function P(props: any) { return <p>hook</p>; }
export const onRequest = async (c: any, next: any) => { (globalThis.__t ??= []).push("onRequest hook"); await next(); };
