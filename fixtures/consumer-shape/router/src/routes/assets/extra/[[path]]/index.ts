export const onGet = (ctx: any) => ctx.text(`extra:${ctx.req.param("path")}`);
