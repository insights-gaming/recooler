export default async function auth(c: any, next: any) {
  (globalThis.__t ??= []).push("auth@" + c.req.routePath);
  if (c.req.header("x-auth") !== "yes") return c.text("BLOCKED", 401);
  c.set("user", "alice");
  await next();
}
