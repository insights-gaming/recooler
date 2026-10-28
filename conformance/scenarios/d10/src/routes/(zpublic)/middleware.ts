export default async function (c: any, next: any) { (globalThis.__t ??= []).push("public"); await next(); }
