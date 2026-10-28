export default async function (c: any, next: any) { (globalThis.__t ??= []).push("admin-sub-dir"); await next(); }
