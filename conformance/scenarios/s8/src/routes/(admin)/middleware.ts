export default async function admin(c: any, next: any) {
  (globalThis.__t ??= []).push("admin-group");
  if (c.req.header("x-db-down") === "1" && !globalThis.__dbUp) { globalThis.__dbUp = true; throw new Error("session store down"); }
  if (c.req.header("x-ratelimit") === "1" && !globalThis.__rl) { globalThis.__rl = true; return c.text("slow down", 429); }
  if (c.req.header("x-auth") !== "yes") return c.text("BLOCKED by admin-group", 401);
  c.set("user", "alice");
  await next();
}
