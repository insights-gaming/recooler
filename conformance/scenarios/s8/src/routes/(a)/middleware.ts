export default async function (c: any, next: any) { (globalThis.__t ??= []).push("a-group"); await next(); }
