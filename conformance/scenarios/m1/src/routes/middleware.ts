const mw = async (c: any, next: any) => { (globalThis.__t ??= []).push("mw"); await next(); };
export { mw as default };
