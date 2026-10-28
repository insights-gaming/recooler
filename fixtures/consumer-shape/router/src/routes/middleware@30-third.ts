export default async function (ctx: any, next: any) {
  ctx.set("trace", [...(ctx.get("trace") || []), "third"]);
  await next();
  ctx.header("x-trace", ctx.get("trace").join(","));
}
