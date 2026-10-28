export default async function (ctx: any, next: any) {
  ctx.set("trace", [...ctx.get("trace"), "group"]);
  if (ctx.req.header("x-auth") !== "yes") return ctx.text("denied", 401);
  if (!ctx.req.param("id")) return ctx.text("missing id", 404);
  await next();
}
