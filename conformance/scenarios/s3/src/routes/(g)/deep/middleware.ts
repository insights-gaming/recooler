export default async function (c: any, next: any) { (globalThis.__t ??= []).push("g-deep-dir"); await next(); }
