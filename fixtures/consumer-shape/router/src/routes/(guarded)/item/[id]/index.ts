export const onGet = (ctx: any) => ctx.text(`entry:${ctx.req.param("id")}`);
