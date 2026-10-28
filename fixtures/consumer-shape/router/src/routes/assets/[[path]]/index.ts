export const onGet = (ctx: any) => ctx.text(`asset:${ctx.req.param("path")}`);
