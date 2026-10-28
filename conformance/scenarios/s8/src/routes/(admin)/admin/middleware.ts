export default async function (c: any, next: any) { (globalThis.__t ??= []).push("admin-dir:user=" + c.get("user")); await next(); }
