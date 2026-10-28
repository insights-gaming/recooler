// root plain middleware with an opt-in "retry once on error" re-dispatch of the same Request
const retried = new WeakSet();
export default async function (c: any, next: any) {
  (globalThis.__t ??= []).push("root");
  await next();
  if (c.req.header("x-retry") === "1" && c.res.status >= 400 && !retried.has(c.req.raw)) {
    retried.add(c.req.raw);
    (globalThis.__t ??= []).push("RETRY");
    c.res = undefined;
    c.res = await globalThis.__app.fetch(c.req.raw, c.env);
  }
}
