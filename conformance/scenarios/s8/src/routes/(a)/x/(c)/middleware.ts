export default async function (c: any, next: any) { (globalThis.__t ??= []).push("c-group"); await next(); }
