export default async function (c: any, next: any) { (globalThis.__t ??= []).push("mw-root"); await next(); }
