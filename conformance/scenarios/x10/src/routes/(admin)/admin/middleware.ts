export default async function dir(c: any, next: any) { (globalThis.__t ??= []).push("admin-dir user=" + c.get("user")); await next(); }
