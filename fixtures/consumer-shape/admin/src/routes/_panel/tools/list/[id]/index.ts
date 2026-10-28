export const onGet = (ctx: any) => ctx.text(`tool:${ctx.req.param("id")}`);
