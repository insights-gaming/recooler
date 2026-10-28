export default async function (c: any, next: any) { (globalThis.__t ??= []).push("g-group"); await next(); }
