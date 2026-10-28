export default async function (c: any, next: any) { (globalThis.__t ??= []).push("pub"); if (!c.req.header("x-auth")) return c.text("BLOCKED pub", 401); await next(); }
