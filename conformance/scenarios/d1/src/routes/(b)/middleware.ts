export default async function (c: any, next: any) { (globalThis.__t ??= []).push("b-mw"); await next(); }
