export default async function (c: any, next: any) { (globalThis.__t ??= []).push("pub-dir"); await next(); }
