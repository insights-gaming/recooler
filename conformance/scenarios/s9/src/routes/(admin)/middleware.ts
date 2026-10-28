export default async function (c: any, next: any) { (globalThis.__t ??= []).push("admin"); if (c.req.header("x-auth") !== "yes") return c.text("BLOCKED", 401); c.set("user", "alice"); await next(); }
