export default async (c: any, next: any) => { (globalThis.__t ??= []).push("chain"); if (c.req.header("x-auth") !== "yes") return c.text("BLOCKED", 401); await next(); };
