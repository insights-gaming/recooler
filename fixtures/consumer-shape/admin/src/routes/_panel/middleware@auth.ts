export default async function (ctx: any, next: any) {
  if (ctx.req.header("x-auth") !== "yes") return ctx.text("denied", 401);
  ctx.set("trace", ["auth"]);
  await next();
  ctx.header("x-trace", ctx.get("trace").join(","));
}
