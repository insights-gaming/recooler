export const onRequest = async (ctx: any, next: any) => {
  ctx.set("trace", [...ctx.get("trace"), "request"]);
  return next();
};
export const onGet = (ctx: any) => ctx.text(`fallback:${ctx.req.param("rest")}`);
