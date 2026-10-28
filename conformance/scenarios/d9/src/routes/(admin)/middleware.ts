export default async function (c: any, next: any) { (globalThis.__t ??= []).push("admin"); if (!c.req.header("x-auth")) return c.text("BLOCKED admin", 401); await next(); }
