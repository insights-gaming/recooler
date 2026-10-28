export const onRequest = async (c: any, next: any) => { (globalThis.__t ??= []).push("hook"); await next(); };
