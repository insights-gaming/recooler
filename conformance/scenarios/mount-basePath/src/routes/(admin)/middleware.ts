export default async function (c: any, next: any) { (globalThis.__t ??= []).push("admin-group"); if (c.req.header("x-auth") !== "yes") return c.text("BLOCKED by admin-group", 401); await next(); }
