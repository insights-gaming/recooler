export default async (c: any, next: any) => { (globalThis.__t ??= []).push("mw"); await next(); };
