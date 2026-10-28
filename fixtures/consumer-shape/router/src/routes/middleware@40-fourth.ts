export default async function (ctx: any, next: any) {
  ctx.set("trace", [...(ctx.get("trace") || []), "fourth"]);
  await next();
  ctx.header("x-trace", ctx.get("trace").join(","));
}
