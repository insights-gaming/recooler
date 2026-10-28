export default function P(props: any) { return <p>public-hook</p>; }
export const onRequest = async (c: any, next: any) => { (globalThis.__t ??= []).push("onRequest public-hook"); await next(); };
