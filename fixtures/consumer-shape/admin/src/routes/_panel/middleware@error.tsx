import { HTTPException } from "hono/http-exception";
export default async function (ctx: any, next: any) {
  ctx.set("trace", [...ctx.get("trace"), "error"]);
  await next();
  if (ctx.req.header("hx-request") === "true" && ctx.req.query("action")) {
    if (ctx.error) throw new HTTPException(200, { res: ctx.text(`handled:${ctx.error.message}`) });
    if (ctx.finalized && ctx.res.status === 204) {
      const headers = new Headers(ctx.res.headers);
      headers.set("hx-refresh", "true");
      headers.set("hx-push-url", "false");
      throw new HTTPException(204, { res: new Response(null, { status: 204, headers }) });
    }
  }
}
