export const onRequest = async (c: any, next: any) => { (globalThis.__t ??= []).push("onRequest"); await next(); };
export const onGet = async (c: any, next: any) => { (globalThis.__t ??= []).push("onGet"); await next(); };
export const onPost = (c: any) => { (globalThis.__t ??= []).push("onPost"); return c.text("post"); };
export const onOptions = (c: any) => { (globalThis.__t ??= []).push("onOptions"); return c.text("options"); };
export default function Page(props: any) { (globalThis.__t ??= []).push("page"); return <button hx-post={() => { (globalThis.__t ??= []).push("action"); return <p>action</p>; }}>go</button>; }
