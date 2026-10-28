// shared middleware, default-exported by two groups; only the staff route needs auth
export default async function shared(c: any, next: any) {
  (globalThis.__t ??= []).push("shared@" + c.req.routePath);
  if (c.req.routePath === "/staff/:id" && c.req.header("x-auth") !== "yes") return c.text("BLOCKED by shared", 401);
  await next();
}
